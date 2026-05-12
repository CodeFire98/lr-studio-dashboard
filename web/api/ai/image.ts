// =====================================================================
// /api/ai/image — Vercel serverless function — image-ideation pipeline
//
// AI Co-pilot v2 Phase 1c: migrated from raw @anthropic-ai/sdk to the
// Vercel AI SDK. Two-step image-prompt flow:
//
//   mode = 'ideas'  → uses streamObject with a Zod schema for
//                     { ideas: [{title, description, style_keywords[]}] }.
//                     Replaces the v1 lenient-JSON-parse-on-done hack —
//                     Zod validates the output server-side and the SDK
//                     constrains the model to produce schema-conforming
//                     JSON.
//
//   mode = 'prompt' → uses streamText for freeform image-gen prompt.
//                     Same pattern as /api/ai/copy.
//
// Wire protocol UNCHANGED from v1 — both modes still emit text deltas
// over SSE (event name "text") so the existing AIImagePromptPanel.jsx
// keeps working untouched until Phase 2c. The client's lenient JSON
// parser on stream-complete remains as defense-in-depth, but Zod
// schema validation now makes it rarely needed.
//
// Same auth pipeline as the other AI routes (JWT → is_agency →
// AI_COPILOT_BRAND_IDS allowlist). Same prompt-cached brand-context
// blob — cache reads across chat / copy / image surfaces within the
// 5-minute TTL.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { streamText, streamObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { loadAndCompileBrandContext } from "../../src/lib/brandContext.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

const WHITELIST = (process.env.AI_COPILOT_BRAND_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MODEL_ID = "claude-sonnet-4-6";
const MAX_TOKENS_IDEAS = 1200;
const MAX_TOKENS_PROMPT = 1000;

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
};

// Zod schema for the structured-output ideas mode. The shape mirrors v1's
// hand-written JSON contract exactly so the existing client (which
// accumulates text deltas into a JSON string and then parses) sees
// identical output. streamObject also constrains Claude to produce
// schema-conforming output AND validates the final result server-side —
// the v1 lenient-fence-strip-then-parse hack is no longer needed here.
const IDEAS_SCHEMA = z.object({
  ideas: z
    .array(
      z.object({
        title: z.string().describe("Short label, 2-5 words."),
        description: z
          .string()
          .describe("1-2 sentence concept — what's in frame, mood, key compositional choice."),
        style_keywords: z
          .array(z.string())
          .describe(
            "3-6 stylistic adjectives or references — e.g. 'editorial', 'overcast natural light', 'shallow depth of field'.",
          ),
      }),
    )
    .min(3)
    .max(5)
    .describe(
      "3 to 5 distinct image-direction concepts. Each must be a DIFFERENT angle — different framing, mood, subject choice, or compositional idea. Don't pad with repeats; if the brief is too thin for 5, return 3-4 instead.",
    ),
});

const SYSTEM_IDEAS = `You are an art director helping an agency plan visual creative for a single brand. Given the post's concept and platform, propose 3-5 SHORT image direction concepts the agency can choose between.

Each direction is a different ANGLE — different framing, mood, subject choice, or compositional idea. Don't propose 5 variations of the same shot. Spread the directions across the realistic possibilities (e.g. studio product shot, in-context lifestyle shot, abstract / conceptual, hands-only / detail crop, behind-the-scenes / process).

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

type UsageShape = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
};

function emitUsageEvent(res: VercelResponse, u: UsageShape | undefined) {
  writeSseEvent(res, "usage", {
    input_tokens: u?.inputTokenDetails?.noCacheTokens ?? u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_creation_input_tokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
    cache_read_input_tokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
  });
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

  // Two cache breakpoints (mode-specific instructions + brand context),
  // same as chat.ts and copy.ts. Cache is shared across all three routes
  // because brandContext is byte-stable per brand within the 5-min TTL.
  const systemInstructions = mode === "ideas" ? SYSTEM_IDEAS : SYSTEM_PROMPT_DETAILED;

  const platformLabel = PLATFORM_LABEL[body.platform];
  const scheduledLabel = plan.scheduled_at
    ? new Date(plan.scheduled_at).toISOString().slice(0, 10)
    : "unscheduled";
  const conceptLine = plan.concept?.trim() || "(no concept provided yet — infer from the brand voice)";

  // Cross-platform copy context: pull ALL platforms' existing copy on
  // this plan (not just the active platform) so the image direction is
  // informed by the whole campaign tone. The active platform is labelled
  // explicitly so the model anchors the visual to that platform's
  // aspect ratio / format while staying thematically coherent with the
  // sibling captions. Caps each platform at 600 chars (was 800 for a
  // single platform; tightened to keep total input predictable now that
  // we can include up to 3 platforms).
  const copyVariants = plan.copy_variants && typeof plan.copy_variants === "object"
    ? (plan.copy_variants as Record<string, string>)
    : {};
  const allPlatformCopy = Object.entries(copyVariants)
    .filter(([k, v]) => typeof v === "string" && v.trim() && PLATFORM_LABEL[k])
    .map(([k, v]) => {
      const isActive = k === body.platform;
      const marker = isActive ? " ← THIS PLATFORM" : "";
      return `${PLATFORM_LABEL[k]}${marker}:\n"""\n${(v as string).slice(0, 600)}\n"""`;
    })
    .join("\n\n");
  const copyContextSection = allPlatformCopy
    ? `\n\nCAPTIONS ON THIS POST PLAN (for tonal + campaign context across platforms — match the angle/mood; visualise something cohesive with the captions, not contradictory):\n${allPlatformCopy}`
    : "";

  let userMessage: string;
  if (mode === "ideas") {
    const briefLine = body.brief?.trim()
      ? `\n\nAdmin's brief for the image (extra context beyond the concept):\n${body.brief.trim()}`
      : "";
    userMessage = `Propose 3-5 image direction concepts for this ${platformLabel} post.

Post concept: ${conceptLine}
Scheduled: ${scheduledLabel}${copyContextSection}${briefLine}`;
  } else {
    const ideaTitle = body.idea_title?.trim() || "";
    const ideaDescription = body.idea_description?.trim() || "";
    const keywords = Array.isArray(body.idea_style_keywords) ? body.idea_style_keywords.filter((k) => typeof k === "string" && k.trim()) : [];
    const detailsLine = body.details?.trim()
      ? `\n\nAdmin's additional details for THIS prompt:\n${body.details.trim()}`
      : "";
    userMessage = `Write a detailed image-generation prompt for this ${platformLabel} post, building on the chosen direction below.

Post concept: ${conceptLine}
Scheduled: ${scheduledLabel}${copyContextSection}

CHOSEN DIRECTION:
Title: ${ideaTitle}
Description: ${ideaDescription}${keywords.length ? `\nStyle keywords: ${keywords.join(", ")}` : ""}${detailsLine}

Output the detailed image prompt text only — no preamble, no markdown, no quotes. Ready to paste into the admin's image-gen tool.`;
  }

  // System messages array shared by both modes. Each block gets its own
  // cache_control via providerOptions.anthropic.cacheControl. Both rides
  // via the `system` parameter (Array<SystemModelMessage>) instead of
  // being mixed into `messages` — the AI SDK emits a security warning
  // when role:'system' entries appear in `messages` because — in
  // principle — that's a prompt-injection vector. Our content is 100%
  // server-controlled so the warning is informational, but using
  // `system: [...]` is the cleaner API path AND keeps both cache
  // breakpoints intact (SystemModelMessage supports providerOptions and
  // the AI SDK collapses the array into a single Anthropic system
  // param with multiple text blocks, each with its own cache_control).
  const systemMessages = [
    {
      role: "system" as const,
      content: systemInstructions,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
    },
    {
      role: "system" as const,
      content: `\n\n---\n\n${brandContext}`,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
    },
  ];

  try {
    if (mode === "ideas") {
      // streamObject constrains Claude to produce schema-conforming JSON.
      // The textStream emits raw JSON-token deltas as the object is built;
      // the existing AIImagePromptPanel.jsx accumulates these into a
      // string and lenient-parses on done — identical to v1 behaviour.
      const result = streamObject({
        model: anthropic(MODEL_ID),
        maxOutputTokens: MAX_TOKENS_IDEAS,
        schema: IDEAS_SCHEMA,
        system: systemMessages,
        messages: [{ role: "user", content: userMessage }],
      });

      for await (const chunk of result.textStream) {
        writeSseEvent(res, "text", { delta: chunk });
      }

      // streamObject exposes usage as a Promise that resolves when the
      // stream completes. Mirror the legacy snake_case wire shape.
      const usage = (await result.usage) as UsageShape;
      emitUsageEvent(res, usage);

      const finishReason = await result.finishReason;
      writeSseEvent(res, "done", { stop_reason: finishReason });
    } else {
      // Freeform image-gen prompt — streamText, same pattern as copy.ts.
      const result = streamText({
        model: anthropic(MODEL_ID),
        maxOutputTokens: MAX_TOKENS_PROMPT,
        system: systemMessages,
        messages: [{ role: "user", content: userMessage }],
      });

      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          writeSseEvent(res, "text", { delta: part.text });
        } else if (part.type === "finish-step") {
          emitUsageEvent(res, part.usage as UsageShape | undefined);
        } else if (part.type === "finish") {
          writeSseEvent(res, "done", { stop_reason: part.finishReason });
        } else if (part.type === "error") {
          const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
          writeSseEvent(res, "error", { error: errMsg });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSseEvent(res, "error", { error: msg });
  } finally {
    res.end();
  }
}
