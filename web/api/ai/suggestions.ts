// =====================================================================
// /api/ai/suggestions — Vercel serverless function — Co-pilot welcome chips
//
// Generates 4 short, brand-aware prompt-starter strings the agency admin
// can click to drop into the Co-pilot chat textarea. Surfaces only on
// CopilotPanel's empty welcome screen.
//
// Why a separate route: the Co-pilot chat / inline copy / image routes
// are all session-oriented (admin → AI back-and-forth). This route is a
// single one-shot generation that fires on panel open + on the Refresh
// chip button. Different shape, different cost profile (one short
// call per panel-open vs. a streaming conversation).
//
// Why streamObject + Haiku: the first version of this route used
// generateObject + Sonnet, which clocked at 3-5s per refresh — slow
// enough that the spinner felt stuck. Two wins stack here:
//   1. Haiku 4.5 over Sonnet 4.6 → ~2× generation speedup. The task
//      is "suggest 4 short prompts" — no reasoning required, no long
//      output, Haiku handles it well.
//   2. streamObject pipes JSON deltas to the client as the model
//      generates them. The chips appear PROGRESSIVELY (one fills in
//      every few hundred ms) instead of all-at-once after the full
//      generation. Perceived latency drops dramatically even if the
//      total time is unchanged. Same pattern as the image-ideas
//      panel (/api/ai/image mode=ideas).
//
// Why high temperature (0.9): variety BETWEEN calls is the entire
// point. Same brand context should yield different angles each refresh
// — we want the model to surface different campaign hooks / different
// content types / different angles each time the admin hits refresh.
//
// Cost: brand-context blob (~4-5K tokens) is sent cached via the
// existing prompt-cache breakpoints (same blob as /api/ai/chat,
// /api/ai/copy, /api/ai/image — one cache pool, 5-min TTL). Per-call
// output is ~150 tokens. Cached call cost: ~$0.001-0.003. First call
// (cache miss): ~$0.005-0.010. Refresh-heavy admin (10 refreshes in
// a session) ≈ $0.01-0.03 total — negligible.
//
// Auth model (unchanged from other AI routes): JWT → is_agency →
// AI_COPILOT_BRAND_IDS allowlist.
//
// Env vars (unchanged): ANTHROPIC_API_KEY, AI_COPILOT_BRAND_IDS,
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
// supabase-js client is now created inside auth-lib; no direct usage here.
import { streamObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { loadAndCompileBrandContext } from "../../src/lib/brandContext.js";
import { authorizeAiCall, checkAndRecordAiUsage, quotaExceededResponse } from "./auth-lib.js";
import { logServiceUsage, estimateAnthropicCostUsd } from "../_shared/usage.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

// Haiku 4.5: ~2× faster than Sonnet for this task; 4 short prompt-
// starters don't need a reasoning-class model. ~$0.001 cached per call
// (cheaper than Sonnet too).
const MODEL_ID = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 220; // tight — 4 short strings + JSON syntax
const TEMPERATURE = 0.9; // high for variety between refreshes

// Schema enforces exactly 4 strings, each 8-150 chars. The min length
// keeps the model from returning empty / one-word entries; the max
// keeps chips from overflowing the welcome-screen UI.
const SUGGESTIONS_SCHEMA = z.object({
  suggestions: z
    .array(
      z
        .string()
        .min(8)
        .max(150)
        .describe(
          "A short prompt the admin would say to the Co-pilot, in first person. 8-15 words ideal. Specific to THIS brand. No quotes around it.",
        ),
    )
    .length(4)
    .describe(
      "Exactly 4 distinct prompt-starters spanning DIFFERENT angles — e.g. one for drafting a specific post, one for planning a week, one for a campaign concept, one for creative direction / brainstorm. Don't propose 4 'draft a post' prompts.",
    ),
});

const SYSTEM_PROMPT = `You are surfacing 4 short prompt-starters for an agency admin to click in a Co-pilot welcome screen. Each prompt is something the admin would type to the AI to kick off a session — in first person, action-oriented.

Constraints:
- 8-15 words each. Tappable on mobile.
- Specific to the brand below. Reference the brand voice, audience, products, or recent campaigns where useful — but don't be verbose about it.
- Vary the ANGLES across the 4 prompts. Spread across: drafting a specific post (with date / platform), planning multiple posts for a week or campaign, brainstorming a creative direction or concept, and one open-ended question or angle exploration.
- Concrete > generic. "Draft a Father's Day post about our cotton onesies for next Sunday" beats "Draft a post".
- Action verbs at the start: Draft / Plan / Brainstorm / Suggest / Write / Come up with — not "Can you" or "Help me".
- No quotes around the prompts. Output the prompt text as-is.

DIFFERENT angles each call: the admin will hit Refresh to get new suggestions, so don't recycle the same 4 prompts every time. Pick fresh hooks each generation.`;

type RequestBody = {
  accountId?: string;
  // Optional — accumulated list of suggestions the admin has already
  // seen across previous refreshes in this session. We pass it back to
  // the model with explicit instructions to avoid repeating them, which
  // is the only reliable way to defeat mode-collapse: temperature 0.9 +
  // identical (within-day) prompts otherwise produce near-identical
  // output from the same model.
  previousSuggestions?: string[];
};

// Cap on how many previous suggestions we feed back to the model. Larger
// gives stronger anti-repetition signal but bloats the prompt; 16 covers
// ~4 refreshes worth (4 suggestions × 4 refreshes) which is more than
// most sessions ever do.
const MAX_PREVIOUS_SUGGESTIONS = 16;

// Tiny per-call nonce so even the SAME accountId on the SAME date gets a
// different user message every call. Belt-and-suspenders against the
// case where previousSuggestions is empty (first-ever call in a session).
function makeNonce(): string {
  // 6-char alphanumeric. Crypto.randomUUID is overkill; the goal is just
  // to keep the user message byte-different across calls.
  return Math.random().toString(36).slice(2, 8);
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

  const quota = await checkAndRecordAiUsage({ caller, accountId: body.accountId, kind: "suggestions" });
  if (!quota.allowed) {
    const r = quotaExceededResponse(quota);
    return res.status(r.status).json(r.body);
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

  // Disable Vercel response buffering so JSON deltas reach the browser
  // as they're generated. pipeTextStreamToResponse sets the Content-Type
  // to text/plain; charset=utf-8 itself.
  res.setHeader("X-Accel-Buffering", "no");

  try {
    // System messages array — same cache breakpoints as /api/ai/chat etc.
    // Brand-context blob is byte-stable per brand so this call piggybacks
    // on the existing cache pool. The user-message-side carries a small
    // amount of per-call entropy (timestamp) so the model isn't repeating
    // itself across refreshes within the same cache window.
    //
    // streamObject + pipeTextStreamToResponse: the client (CopilotPanel
    // via experimental_useObject) parses partial JSON as it streams,
    // showing chips one-by-one as each idea's title resolves. Same UX
    // pattern as the image-ideas panel.
    const startedAt = Date.now();
    const result = streamObject({
      model: anthropic(MODEL_ID),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      schema: SUGGESTIONS_SCHEMA,
      system: [
        {
          role: "system" as const,
          content: SYSTEM_PROMPT,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
        },
        {
          role: "system" as const,
          content: `\n\n---\n\n${brandContext}`,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
        },
      ],
      messages: [
        {
          role: "user",
          content: (() => {
            // Per-call entropy: nonce makes the user message byte-unique
            // even when previousSuggestions is empty, so the model can't
            // just regurgitate cached "ideal" suggestions from a prior
            // identical prompt. (The brand context is the cache
            // breakpoint; the user message is never cached.)
            const nonce = makeNonce();
            const date = new Date().toISOString().slice(0, 10);

            // Anti-repetition block. If the admin has already seen prior
            // suggestions in this session, name them and forbid the model
            // from echoing or paraphrasing them. This is the only reliable
            // way to get genuinely different output from the model on
            // refresh — temp 0.9 alone is not enough.
            const prior = Array.isArray(body.previousSuggestions)
              ? body.previousSuggestions
                  .map((s) => (typeof s === "string" ? s.trim() : ""))
                  .filter((s) => s.length > 0 && s.length <= 200)
                  .slice(-MAX_PREVIOUS_SUGGESTIONS)
              : [];

            const priorBlock = prior.length > 0
              ? `\n\nALREADY-SHOWN suggestions the admin has seen in this session (DO NOT repeat or paraphrase any of these — pick genuinely different angles, hooks, and content types):\n${prior.map((s) => `- ${s}`).join("\n")}`
              : "";

            return `Surface 4 fresh prompt-starter suggestions for the Co-pilot welcome screen.

The admin clicks Refresh to get DIFFERENT angles from previous generations. Explore varied hooks — different post types, different platforms, different campaign frames, different audiences, different seasonal hooks.

Today is ${date}. Refresh signal: ${nonce}.${priorBlock}`;
          })(),
        },
      ],
      onFinish: ({ usage }) => {
        const cr = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        const cw = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
        const nc = usage?.inputTokenDetails?.noCacheTokens ?? usage?.inputTokens ?? 0;
        const out = usage?.outputTokens ?? 0;
        // eslint-disable-next-line no-console
        console.log(
          `[suggestions] usage account=${body.accountId} input=${nc} cache_read=${cr} cache_write=${cw} output=${out}`,
        );
        // Telemetry → service_usage_log for the daily digest. Fire-and-
        // forget; helper never throws. `inputTokens` (the AI SDK's
        // normalized fresh-input figure) is what we pass — the cost
        // estimator handles cache token math separately.
        void logServiceUsage({
          service: "anthropic",
          route: "/api/ai/suggestions",
          accountId: body.accountId,
          userId: caller.userId,
          tokensIn: usage?.inputTokens ?? 0,
          tokensOut: out,
          costUsd: estimateAnthropicCostUsd({
            model: MODEL_ID,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: out,
            cacheReadTokens: cr,
            cacheWriteTokens: cw,
          }),
          latencyMs: Date.now() - startedAt,
          status: "ok",
          meta: {
            model: MODEL_ID,
            cache_read_tokens: cr,
            cache_write_tokens: cw,
          },
        });
      },
    });

    result.pipeTextStreamToResponse(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      return res.status(500).json({ error: msg });
    }
    res.end();
  }
}
