// =====================================================================
// /api/ai/_cache-poc — TEMPORARY proof-of-concept route
//
// Purpose: verify that the Vercel AI SDK's @ai-sdk/anthropic provider
// translates `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`
// into the same Anthropic API `cache_control` block the raw SDK uses today.
// If cache lands on the second call, the AI Co-pilot v2 migration is safe
// to proceed. If not, costs would 4-10x on every chat turn and we need to
// dig into provider options before retiring the raw SDK.
//
// What it does:
//   1. Build a >1024-token system prompt (Sonnet 4.6's minimum cacheable
//      prompt length). We pad with a stable lorem-style block so the prompt
//      content is deterministic across calls.
//   2. Make TWO sequential generateText calls within 5 seconds, identical
//      cached system blocks via providerOptions.anthropic.cacheControl.
//   3. Return JSON with both calls' usage tokens including cache
//      creation / read counts from provider metadata.
//
// Expected result:
//   Call 1: cacheCreationInputTokens > 0, cacheReadInputTokens == 0
//   Call 2: cacheCreationInputTokens == 0, cacheReadInputTokens > 0 (≥ Call 1 cache_creation)
//
// Auth: same JWT → is_agency check as the real Co-pilot routes. No brand-id
// allowlist needed since we don't touch any brand data.
//
// LIFECYCLE: DELETE this file after Phase 0 ships and the migration is
// confirmed working in prod. See AI_COPILOT_V2_MIGRATION.md.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

const MODEL_ID = "claude-sonnet-4-6";

// Stable padding to push the system prompt over Sonnet's 1024-token cache
// threshold. Content is deterministic so both calls produce identical
// hashes — required for cache hit on call 2.
const PADDING = Array.from({ length: 40 }, (_, i) =>
  `Brand archetype principle ${i + 1}: every line of copy is a chance to ` +
  `tell the reader what this brand stands for. Keep the voice consistent ` +
  `across platforms. Match the audience's energy without mimicking trends ` +
  `that don't fit. Reference the brand's actual products by name when it ` +
  `serves the post. Never invent founder history or origin facts. When in ` +
  `doubt about a claim, ask the agency admin to confirm before drafting.`,
).join("\n");

const CACHED_SYSTEM_PROMPT =
  `You are a social-media copywriting assistant for an agency that runs ` +
  `marketing for one brand at a time. The block below is the brand's ` +
  `style guide — reference it for tone, audience, products, and constraints.\n\n` +
  `---\n\n` +
  `${PADDING}\n\n` +
  `---\n\n` +
  `When asked to draft copy, match the brand voice exactly. When asked a ` +
  `direct question, answer in one short sentence.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
    return res.status(500).json({ error: "Supabase env not fully configured" });
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

  const { data: profile, error: profileErr } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) return res.status(500).json({ error: `profile lookup: ${profileErr.message}` });
  if (!profile?.is_agency) return res.status(403).json({ error: "Agency-only PoC" });

  type CallResult = {
    text: string;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cacheCreationInputTokens: number | undefined;
    cacheReadInputTokens: number | undefined;
    raw: unknown;
  };

  async function runCall(): Promise<CallResult> {
    const result = await generateText({
      model: anthropic(MODEL_ID),
      maxOutputTokens: 50,
      messages: [
        {
          role: "system",
          content: CACHED_SYSTEM_PROMPT,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
        { role: "user", content: "Reply with the single word: OK." },
      ],
    });

    const anthropicMeta = result.providerMetadata?.anthropic as
      | { cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
      | undefined;

    return {
      text: result.text,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      cacheCreationInputTokens: anthropicMeta?.cacheCreationInputTokens,
      cacheReadInputTokens: anthropicMeta?.cacheReadInputTokens,
      raw: { usage: result.usage, providerMetadata: result.providerMetadata },
    };
  }

  try {
    const call1 = await runCall();
    // Short sleep to ensure call 1's cache write fully propagates before
    // call 2 attempts a read. Anthropic typically makes cache writes
    // available immediately, but a beat of margin keeps the PoC stable.
    await new Promise((r) => setTimeout(r, 1500));
    const call2 = await runCall();

    const cacheHit = (call2.cacheReadInputTokens ?? 0) > 0;
    const verdict = cacheHit ? "PASS" : "FAIL";

    return res.status(200).json({
      verdict,
      cacheHit,
      model: MODEL_ID,
      summary: cacheHit
        ? "Cache landed on call 2. Migration is safe to proceed to Phase 0."
        : "Cache did NOT land on call 2. Investigate providerOptions before migrating.",
      call1,
      call2,
      checklistRef: "AI_COPILOT_V2_MIGRATION.md → PoC results section",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ verdict: "ERROR", error: msg });
  }
}
