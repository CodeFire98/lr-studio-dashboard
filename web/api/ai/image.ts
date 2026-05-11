// =====================================================================
// /api/ai/image — Vercel serverless function — image-ideation pipeline
//
// Two-step image-prompt generation for the Deliverables surface in
// PostPlanDetailView:
//
//   mode = 'ideas'  → returns 3-5 short image-direction concepts as
//                     structured JSON. Each idea: {title, description,
//                     style_keywords}. Streams the JSON output and the
//                     client parses on completion.
//
//   mode = 'prompt' → takes a chosen idea + the admin's additional
//                     details + brand context, returns a detailed
//                     image-generation prompt the admin can paste
//                     into Midjourney / DALL-E / Imagen / their tool of
//                     choice. Streams text deltas.
//
// Same auth pipeline as /api/ai/chat (JWT → is_agency → AI_COPILOT_BRAND_IDS
// allowlist). Same prompt-cached brand-context blob — cache reads across
// chat / copy / image surfaces within the 5-minute TTL.
//
// Why not one endpoint with one shape: ideas is structured-output, prompt
// is freeform text. Same response protocol (SSE streaming) keeps the
// client simple; the client just parses JSON on stream-complete for
// ideas mode vs renders deltas for prompt mode.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { loadAndCompileBrandContext } from "../../src/lib/brandContext.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

const WHITELIST = (process.env.AI_COPILOT_BRAND_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_IDEAS = 1200;
const MAX_TOKENS_PROMPT = 1000;

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
};

// System prompts — tuned per mode so the model output shape is predictable
// (parseable JSON for ideas; a single freeform prompt for prompt-mode).
const SYSTEM_IDEAS = `You are an art director helping an agency plan visual creative for a single brand. Given the post's concept and platform, propose 3-5 SHORT image direction concepts the agency can choose between.

Each direction is a different ANGLE — different framing, mood, subject choice, or compositional idea. Don't propose 5 variations of the same shot. Spread the directions across the realistic possibilities (e.g. studio product shot, in-context lifestyle shot, abstract / conceptual, hands-only / detail crop, behind-the-scenes / process).

Output ONLY a JSON object matching this exact shape — no preamble, no markdown fences, no explanation:

{
  "ideas": [
    {
      "title": "short label, 2-5 words",
      "description": "1-2 sentence concept — what's in frame, mood, key compositional choice",
      "style_keywords": ["3-6 stylistic adjectives or references — e.g. 'editorial', 'overcast natural light', 'shallow depth of field'"]
    }
  ]
}

Brand voice constraints from the brand context MUST inform every direction — palette, photography style, do/don'ts, voice tags. If the brand voice prohibits something (e.g. "no stock photo feel"), every direction respects that. If the admin's brief is too thin to generate 5 distinct angles, return fewer (3-4 is fine) rather than padding with repeats.`;

const SYSTEM_PROMPT_DETAILED = `You are an art director writing a detailed image-generation prompt for a single brand's social post. The admin has chosen a direction concept; your job is to expand it into a precise, ready-to-paste prompt for Midjourney / DALL-E / Imagen / similar tools.

Output ONLY the prompt text — no preamble, no markdown, no explanation, no "Here's the prompt:". Just the prompt, ready to paste.

Structure the prompt so it covers (in this rough order):
- Subject + key action / pose
- Setting / environment
- Composition + framing (close-up / wide / overhead / etc.)
- Lighting + mood
- Style / aesthetic / references (cite specific photographic / visual references if relevant, e.g. "Wes Anderson symmetry", "Annie Leibovitz editorial portrait")
- Brand palette + colour direction (use the brand's actual colour hexes/names from the brand context)
- Texture, depth-of-field, lens choice if relevant
- Anything to AVOID (only if the brand voice or admin instruction calls it out)

Match the brand's photography style + palette from the brand context. The prompt should be specific enough that two different image-gen tools would produce visually compatible results from it. Aim for 100-250 words — long enough to be specific, short enough to paste comfortably.

Don't include image-tool-specific syntax (e.g. Midjourney's "--ar 1:1" flags). The admin adds those for their tool of choice.`;

type RequestBody = {
  accountId?: string;
  plan_id?: string;
  platform?: string;
  mode?: "ideas" | "prompt";
  // ideas mode:
  brief?: string;
  // prompt mode:
  idea_title?: string;
  idea_description?: string;
  idea_style_keywords?: string[];
  details?: string;
};

function writeSseEvent(res: VercelResponse, type: string, data: unknown) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  // @ts-expect-error — Node response has flush, types don't expose it.
  res.flush?.();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
    return res.status(500).json({ error: "Supabase env not fully configured." });
  }

  let body: RequestBody;
  if (typeof req.body === "string") {
    try { body = JSON.parse(req.body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  } else {
    body = (req.body ?? {}) as RequestBody;
  }
  if (!body?.accountId) return res.status(400).json({ error: "accountId is required" });
  if (!body?.plan_id) return res.status(400).json({ error: "plan_id is required" });
  if (!body?.platform || !PLATFORM_LABEL[body.platform]) {
    return res.status(400).json({ error: "platform must be one of: instagram, linkedin, x" });
  }
  const mode: "ideas" | "prompt" = body.mode === "prompt" ? "prompt" : "ideas";

  if (mode === "prompt") {
    if (!body.idea_title?.trim() && !body.idea_description?.trim()) {
      return res.status(400).json({ error: "idea_title or idea_description is required for prompt mode" });
    }
  }

  const authHeader =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["Authorization"] as string | undefined) ??
    "";
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const userClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_agency) {
    return res.status(403).json({ error: "Co-pilot is agency-only for now" });
  }

  if (!WHITELIST.includes(body.accountId)) {
    return res.status(403).json({ error: "This brand isn't on the Co-pilot allowlist yet." });
  }

  const { data: plan, error: planErr } = await serviceClient
    .from("post_plans")
    .select("id, account_id, scheduled_at, concept, platforms, copy_variants")
    .eq("id", body.plan_id)
    .maybeSingle();
  if (planErr) return res.status(500).json({ error: `plan lookup: ${planErr.message}` });
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  if (plan.account_id !== body.accountId) {
    return res.status(403).json({ error: "Plan does not belong to the specified brand" });
  }

  let brandContext = "";
  try {
    brandContext = await loadAndCompileBrandContext(serviceClient, body.accountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to compile brand context: ${msg}` });
  }
  if (!brandContext) {
    return res.status(404).json({ error: "No brand kit found for this account." });
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);
  res.write(": stream open\n\n");

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const systemInstructions = mode === "ideas" ? SYSTEM_IDEAS : SYSTEM_PROMPT_DETAILED;
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: systemInstructions,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `\n\n---\n\n${brandContext}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  const platformLabel = PLATFORM_LABEL[body.platform];
  const scheduledLabel = plan.scheduled_at
    ? new Date(plan.scheduled_at).toISOString().slice(0, 10)
    : "unscheduled";
  const conceptLine = plan.concept?.trim() || "(no concept provided yet — infer from the brand voice)";

  // Pull the platform-specific copy if it exists — useful context for the
  // model to anchor the image direction to the actual caption tone.
  const copyVariants = plan.copy_variants && typeof plan.copy_variants === "object"
    ? (plan.copy_variants as Record<string, string>)
    : {};
  const platformCopy = typeof copyVariants[body.platform] === "string" ? copyVariants[body.platform] : "";

  let userMessage: string;
  if (mode === "ideas") {
    const briefLine = body.brief?.trim()
      ? `\n\nAdmin's brief for the image (extra context beyond the concept):\n${body.brief.trim()}`
      : "";
    userMessage = `Propose 3-5 image direction concepts for this ${platformLabel} post.

Post concept: ${conceptLine}
Scheduled: ${scheduledLabel}${platformCopy ? `

Caption (for tonal context):
"""
${platformCopy.slice(0, 800)}
"""` : ""}${briefLine}

Output the JSON object only — no preamble, no markdown fences, no commentary.`;
  } else {
    const ideaTitle = body.idea_title?.trim() || "";
    const ideaDescription = body.idea_description?.trim() || "";
    const keywords = Array.isArray(body.idea_style_keywords) ? body.idea_style_keywords.filter((k) => typeof k === "string" && k.trim()) : [];
    const detailsLine = body.details?.trim()
      ? `\n\nAdmin's additional details for THIS prompt:\n${body.details.trim()}`
      : "";
    userMessage = `Write a detailed image-generation prompt for this ${platformLabel} post, building on the chosen direction below.

Post concept: ${conceptLine}
Scheduled: ${scheduledLabel}${platformCopy ? `

Caption (for tonal context):
"""
${platformCopy.slice(0, 800)}
"""` : ""}

CHOSEN DIRECTION:
Title: ${ideaTitle}
Description: ${ideaDescription}${keywords.length ? `\nStyle keywords: ${keywords.join(", ")}` : ""}${detailsLine}

Output the detailed image prompt text only — no preamble, no markdown, no quotes. Ready to paste into the admin's image-gen tool.`;
  }

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: mode === "ideas" ? MAX_TOKENS_IDEAS : MAX_TOKENS_PROMPT,
      system: systemBlocks,
      messages: [{ role: "user", content: userMessage }],
    });

    stream.on("text", (delta) => {
      writeSseEvent(res, "text", { delta });
    });

    const finalMessage = await stream.finalMessage();

    writeSseEvent(res, "usage", {
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      cache_creation_input_tokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: finalMessage.usage.cache_read_input_tokens ?? 0,
    });

    writeSseEvent(res, "done", { stop_reason: finalMessage.stop_reason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSseEvent(res, "error", { error: msg });
  } finally {
    res.end();
  }
}
