// =====================================================================
// /api/ai/copy — Vercel serverless function — AI inline copy generation
//
// PR 4 of the AI Co-pilot phase. Generates per-platform post copy for an
// existing post_plans row and streams the text back over Server-Sent
// Events. The client renders the streamed text in an inline preview next
// to the textarea — the user clicks "Use this" to accept or "Discard" to
// dismiss. The server never writes to copy_variants; the existing
// client-side persist() path owns DB writes.
//
// Why a separate endpoint from /api/ai/chat (and not just another tool):
//   - This is a single-shot text generation, not an agentic loop. No
//     tool-use overhead, lower latency, simpler client code (just consume
//     a stream of text deltas, no tool-call cards).
//   - The system prompt is mode-specific ("you are writing JUST the
//     {platform} caption for this post, output the caption only — no
//     preamble, no explanation"). Different shape from the conversational
//     Co-pilot which is allowed to chat / call tools / propose things.
//
// Modes (PR 4 ships `draft` only; `improve` / `variants` follow in later PRs):
//   - draft: generate fresh copy from concept + brand voice. Used when
//     the textarea is empty OR the user explicitly wants a fresh take.
//
// Auth model (mirrors /api/ai/chat): JWT verified → is_agency check →
// AI_COPILOT_BRAND_IDS allowlist gate on the target accountId.
//
// Env vars: ANTHROPIC_API_KEY, AI_COPILOT_BRAND_IDS, SUPABASE_URL,
// SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (all already set on
// lr-studio-dashboard-3kkp Vercel project from PR 2).
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
const MAX_TOKENS = 700; // Captions are short; cap aggressively.

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
};

const PLATFORM_GUIDANCE: Record<string, string> = {
  instagram:
    "Instagram caption. Conversational, sensory language. Lead with a hook. Use line breaks for scannability. Emojis sparingly — only if the brand voice permits. ~150-300 words is the sweet spot. End with a call to action or a thoughtful question that invites comments. Hashtags only if relevant; never spammy.",
  linkedin:
    "LinkedIn post. Authority + warmth. Lead with a personal hook or surprising stat — never a generic intro. Use paragraph breaks every 1-2 sentences for mobile readability. ~150-300 words. End with a forward-looking insight or a question that invites discussion. No emojis unless the brand voice is explicitly playful. No hashtags inline; if any are needed, put them on the last line.",
  x:
    "X (Twitter) post. Punchy, single thought. Hard limit ~280 characters. No hashtags unless directly relevant. No emoji unless brand voice permits.",
};

const SYSTEM_INSTRUCTIONS = `You are writing a single social-media caption for a specific brand on a specific platform. Match the brand voice exactly — match the words, the rhythm, and the relationship to the audience.

Output the caption text ONLY. No preamble like "Here's a draft:". No explanation. No quotes around the caption. No headers. Just the caption text, ready to paste.

If the concept is too thin to write good copy from, write the best plausible caption you can rather than asking for clarification — the user is reviewing in a preview and will edit before accepting.`;

type RequestBody = {
  accountId?: string;
  plan_id?: string;
  platform?: string;
  mode?: "draft";
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
  const mode = body.mode || "draft";
  if (mode !== "draft") {
    return res.status(400).json({ error: `Unsupported mode: ${mode}. PR 4 ships 'draft' only.` });
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
    return res.status(403).json({
      error: "This brand isn't on the Co-pilot allowlist yet.",
    });
  }

  // Load the target plan via service-role so we can read concept +
  // scheduled_at + platforms regardless of RLS shape. We've already
  // confirmed the caller is agency-staff above.
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

  // SSE setup — same headers as /api/ai/chat.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);
  res.write(": stream open\n\n");

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: SYSTEM_INSTRUCTIONS,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `\n\n---\n\n${brandContext}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  const platformLabel = PLATFORM_LABEL[body.platform];
  const platformGuide = PLATFORM_GUIDANCE[body.platform];
  const scheduledLabel = plan.scheduled_at
    ? new Date(plan.scheduled_at).toISOString().slice(0, 10)
    : "unscheduled";
  const conceptLine = plan.concept?.trim() || "(no concept provided yet — infer from the brand voice)";

  const userMessage = `Write the ${platformLabel} caption for this post.

Post concept: ${conceptLine}
Scheduled: ${scheduledLabel}

Platform guidance:
${platformGuide}

Output the caption text only — no preamble, no quotes.`;

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
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
