// =====================================================================
// /api/ai/image — Vercel serverless function — image-ideation pipeline
//
// LinkAI v2 Phase 2c: wire protocol switched to the AI SDK's
// text-stream protocol for BOTH modes — `streamObject(...).pipeTextStreamToResponse(res)`
// for ideas (JSON deltas) and `streamText(...).pipeTextStreamToResponse(res)`
// for prompt (text deltas). The custom SSE event names
// (text / usage / done / error) are retired for this route.
// AIImagePromptPanel.jsx in the same PR consumes the new protocols via
// `useObject` (ideas) and `useCompletion` (prompt).
//
// Request body shape change (prompt mode only):
//   `details` → `prompt`
// Because `useCompletion` always sends the admin's freeform direction
// as `prompt` (the first arg to `complete()`). The ideas-mode body
// (which `useObject.submit(...)` posts verbatim) is unchanged.
//
// Two modes:
//
//   mode = 'ideas'  → uses streamObject with a Zod schema for
//                     { ideas: [{title, description, style_keywords[]}] }.
//                     The Zod schema constrains Claude to produce
//                     schema-conforming JSON AND the SDK validates the
//                     final result server-side. Client-side `useObject`
//                     accumulates the partial JSON deltas into a typed
//                     DeepPartial<RESULT> via parsePartialJson.
//
//   mode = 'prompt' → uses streamText for freeform image-gen prompt.
//                     Same pattern as /api/ai/copy.
//
// Same auth pipeline as the other AI routes (JWT → is_agency →
// AI_COPILOT_BRAND_IDS allowlist). Same prompt-cached brand-context
// blob — cache reads across chat / copy / image surfaces within the
// 5-minute TTL.
//
// Observability: per-call cache hit / input / output counts log
// server-side via `streamObject({ onFinish })` and
// `streamText({ onFinish })` — greppable as `[image] usage …` in
// Vercel Function Logs. Same monitoring pattern as /api/ai/copy.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
// supabase-js client is now created inside auth-lib; no direct usage here.
import { streamText, streamObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { loadAndCompileBrandContext } from "../../src/lib/brandContext.js";
import { authorizeAiCall, checkAndRecordAiUsage, quotaExceededResponse } from "./auth-lib.js";
import { logServiceUsage, estimateAnthropicCostUsd } from "../_shared/usage.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

const MODEL_ID = "claude-sonnet-4-6";
const MAX_TOKENS_IDEAS = 1200;
const MAX_TOKENS_PROMPT = 1000;

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
};

// Zod schema for the structured-output ideas mode. The shape MUST match
// the client's `useObject({ schema })` exactly — the client deserialises
// into DeepPartial<infer<typeof IDEAS_SCHEMA>> as JSON streams in.
// streamObject also constrains Claude to produce schema-conforming
// output AND validates the final result server-side.
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
  // ideas mode (sent via useObject.submit() — body is the raw input object):
  brief?: string;
  // prompt mode (sent via useCompletion — `prompt` is the admin's free-form
  // details/direction; the chosen idea rides as the structured body fields):
  prompt?: string;
  idea_title?: string;
  idea_description?: string;
  idea_style_keywords?: string[];
};

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

  const auth = await authorizeAiCall({
    authHeader,
    accountId: body.accountId,
  });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { caller } = auth;
  const serviceClient = caller.serviceClient;

  const quota = await checkAndRecordAiUsage({ caller, accountId: body.accountId, kind: "image" });
  if (!quota.allowed) {
    const r = quotaExceededResponse(quota);
    return res.status(r.status).json(r.body);
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

  // Disable Vercel response buffering so deltas reach the browser as they're
  // generated. pipeTextStreamToResponse sets Content-Type itself (text/plain).
  res.setHeader("X-Accel-Buffering", "no");

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
  // sibling captions.
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
    // useCompletion sends the admin's "additional details" textarea as
    // `prompt`. Treat empty string as "no extra details".
    const detailsLine = body.prompt?.trim()
      ? `\n\nAdmin's additional details for THIS prompt:\n${body.prompt.trim()}`
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
  // cache_control via providerOptions.anthropic.cacheControl. The two
  // blocks ride via the `system` parameter (Array<SystemModelMessage>)
  // instead of being mixed into `messages` — silences the AI SDK's
  // prompt-injection warning AND keeps both cache breakpoints intact.
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

  // Shared onFinish observability logger for both modes. Drops the
  // per-call usage into Vercel Function Logs as `[image] usage …` so we
  // can grep cache hit rate the same way as `[copy] usage …`. Per-mode
  // because streamObject and streamText pass slightly different event
  // shapes (streamObject's `onFinish` has `usage` directly; streamText's
  // has `totalUsage`).
  //
  // Also fires `logServiceUsage` so cost lands in the daily digest's
  // service_usage_log. Latency is measured from `startedAt`, captured
  // right before the streamText/streamObject call below.
  let startedAt = Date.now();
  const logUsage = (
    label: "ideas" | "prompt",
    u:
      | {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
        }
      | undefined,
    finishReason?: string,
  ) => {
    const cr = u?.inputTokenDetails?.cacheReadTokens ?? 0;
    const cw = u?.inputTokenDetails?.cacheWriteTokens ?? 0;
    const nc = u?.inputTokenDetails?.noCacheTokens ?? u?.inputTokens ?? 0;
    const out = u?.outputTokens ?? 0;
    // eslint-disable-next-line no-console
    console.log(
      `[image] usage account=${body.accountId} plan=${body.plan_id} platform=${body.platform} mode=${label} ` +
        `input=${nc} cache_read=${cr} cache_write=${cw} output=${out} finish=${finishReason ?? "n/a"}`,
    );
    void logServiceUsage({
      service: "anthropic",
      route: "/api/ai/image",
      accountId: body.accountId,
      userId: caller.userId,
      tokensIn: u?.inputTokens ?? 0,
      tokensOut: out,
      costUsd: estimateAnthropicCostUsd({
        model: MODEL_ID,
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: out,
        cacheReadTokens: cr,
        cacheWriteTokens: cw,
      }),
      latencyMs: Date.now() - startedAt,
      status: "ok",
      meta: {
        model: MODEL_ID,
        plan_id: body.plan_id,
        platform: body.platform,
        mode: label,
        finish_reason: finishReason ?? null,
        cache_read_tokens: cr,
        cache_write_tokens: cw,
      },
    });
  };

  try {
    startedAt = Date.now();
    if (mode === "ideas") {
      // streamObject constrains Claude to produce schema-conforming JSON
      // and emits JSON-delta chunks. pipeTextStreamToResponse forwards
      // them as text/plain chunks; `useObject` on the client parses
      // them progressively into DeepPartial<{ ideas: [...] }>.
      const result = streamObject({
        model: anthropic(MODEL_ID),
        maxOutputTokens: MAX_TOKENS_IDEAS,
        schema: IDEAS_SCHEMA,
        system: systemMessages,
        messages: [{ role: "user", content: userMessage }],
        onFinish: ({ usage }) => logUsage("ideas", usage),
      });

      result.pipeTextStreamToResponse(res);
    } else {
      // Freeform image-gen prompt — streamText, same pattern as copy.ts.
      const result = streamText({
        model: anthropic(MODEL_ID),
        maxOutputTokens: MAX_TOKENS_PROMPT,
        system: systemMessages,
        messages: [{ role: "user", content: userMessage }],
        onFinish: ({ totalUsage, finishReason }) => logUsage("prompt", totalUsage, finishReason),
      });

      result.pipeTextStreamToResponse(res);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      return res.status(500).json({ error: msg });
    }
    res.end();
  }
}
