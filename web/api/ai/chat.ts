// =====================================================================
// /api/ai/chat — Vercel serverless function — AI Co-pilot streaming chat
//
// AI Co-pilot v2 Phase 1a: migrated from the raw @anthropic-ai/sdk + a
// hand-rolled MAX_TURNS while-loop to the Vercel AI SDK's streamText +
// tool primitives. The agentic loop, message threading, and Anthropic
// prompt caching are now SDK-managed. Wire protocol on the response
// stays IDENTICAL — same custom SSE event names (text / tool_call /
// tool_result / usage / done / error) — so the existing CopilotPanel.jsx
// keeps working untouched until Phase 2a swaps it to useChat.
//
// Auth model (unchanged from v1):
//   - Caller's JWT verified against Supabase auth via the anon-key client
//   - Caller must be agency staff (profiles.is_agency = true)
//   - The target accountId must be in the AI_COPILOT_BRAND_IDS whitelist
//   - Writes (tool execute) use the service-role client to bypass
//     membership-check ambiguity. Agency + whitelist gates are the real
//     authz boundary.
//
// Env vars (unchanged):
//   ANTHROPIC_API_KEY         — required, sk-ant-... (read by @ai-sdk/anthropic)
//   AI_COPILOT_BRAND_IDS      — comma-separated whitelisted brand UUIDs
//   SUPABASE_URL              — https://...supabase.co
//   SUPABASE_ANON_KEY         — for JWT verification
//   SUPABASE_SERVICE_ROLE_KEY — for tool-call writes
//
// Cost notes:
//   - Brand-context blob is sent as a prompt-cached system message via
//     providerOptions.anthropic.cacheControl. Cache TTL is 5 minutes;
//     back-to-back chat turns for the same brand re-hit cache and pay
//     ~10% input-token rate. Verified end-to-end by the PoC route.
//   - Default model: claude-sonnet-4-6
//   - Per-step output cap: 1500 tokens
//   - Tool loop cap: 8 steps (stopWhen: stepCountIs(8))
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { streamText, stepCountIs, tool } from "ai";
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
const MAX_STEPS = 8;
const MAX_TOKENS_PER_TURN = 1500;

const SYSTEM_PROMPT = `You are the AI Co-pilot for Linkrunner Media — a social-media creative agency. You help the agency admin plan content, draft post copy, and brainstorm campaigns for one brand at a time.

## How to behave

- The brand-context block below is the single source of truth for who this brand is. Reference it. Don't fabricate facts about the brand.
- Match the brand's voice in any copy you draft. If the voice block is sparse, ask before guessing.
- Be concise. The admin reads fast and prefers signal over preamble.
- When the admin asks you to plan posts or draft content, use the create_post_plan_draft tool to actually create the plan rather than just describing it. The plan lands in their calendar as a "✨ AI draft" — they edit and submit through the normal workflow.
- When the admin tells you to remember something about the brand — phrases like "remember that…", "from now on…", "make a note that…", "the founder hates the word X", "we always tag Y on milestone posts", "no holiday content before Oct 15" — call the write_brand_note tool. Pin facts that are ALWAYS-true ("we always tag @sarahbamboo on milestone posts"); leave non-pinned for time-bound or context-specific facts ("Q4 launch is the new bamboo onesie line"). The note becomes part of the brand context on every future call — for chat AND for inline copy generation.
- After calling a tool, briefly tell the admin what you did and link them to the result if applicable. Don't just go silent.
- If you don't have enough information (e.g. no date, no platform), ask a clarifying question instead of guessing.

## Available tools

- read_brand_context — already compiled into the system message; you don't need to call this unless the admin explicitly says "refresh my brand context"
- create_post_plan_draft — create a real post_plans row pre-filled with concept and per-platform copy. status='drafting', ai_generated=true. The admin will edit and submit for review.
- write_brand_note — persist a fact about the brand to the brand_kit_notes table. Used when the admin tells you to remember something. The note flows into the brand context on every future AI call (chat + inline copy). Pin always-true facts; leave others non-pinned.

## What you don't do

- Don't publish anything. You can only create drafts.
- Don't touch other brands. You're scoped to the active brand only.
- Don't claim to schedule posts — you create drafts on a date; the agency owns the workflow.`;

type ChatMessage = {
  role: "user" | "assistant";
  content: string | unknown[];
};

type RequestBody = {
  accountId?: string;
  messages?: ChatMessage[];
};

function writeSseEvent(res: VercelResponse, type: string, data: unknown) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  // Flush ASAP so the client sees streaming progress.
  // @ts-expect-error — Node response may have flush, types don't expose it.
  res.flush?.();
}

// Zod schemas — replace the hand-written Anthropic.Tool[] from v1.
// Schema validation now happens at the SDK boundary; bad inputs from the
// model surface as standard Zod errors instead of runtime undefineds.
const createPostPlanDraftInput = z.object({
  scheduled_at: z
    .string()
    .describe(
      "ISO 8601 datetime for when to schedule this post (e.g. '2026-05-15T09:00:00+05:30'). Default to 09:00 in the brand's local time on the requested date. If the admin doesn't specify a date, ask before guessing.",
    ),
  platforms: z
    .array(z.enum(["instagram", "linkedin", "x"]))
    .min(1)
    .describe("Platforms this post targets. Subset of ['instagram', 'linkedin', 'x']."),
  concept: z
    .string()
    .describe(
      "Short (1-2 sentence) concept for the post — what it's about, what angle. The admin sees this as the post's headline.",
    ),
  copy_variants: z
    .object({
      instagram: z.string().optional(),
      linkedin: z.string().optional(),
      x: z.string().optional(),
    })
    .describe(
      "Per-platform draft copy keyed by platform slug. Each value is a string containing the actual caption / tweet / post body. Match the brand voice. Cap Instagram at ~2,200 chars, X at ~280 chars, LinkedIn at ~3,000 chars.",
    ),
});

const writeBrandNoteInput = z.object({
  body: z
    .string()
    .max(1000)
    .describe(
      "The note text — what to remember. Write it in declarative, action-oriented form (e.g. 'Always tag @sarahbamboo on milestone posts' not 'I should remember to tag @sarahbamboo'). Keep it to 1-3 sentences. Phrase it so a future AI reading it can act on it without further context.",
    ),
  is_pinned: z
    .boolean()
    .optional()
    .describe(
      "true for always-true facts ('founder's wife runs the brand', 'never use the word authentic'). false for time-bound or context-specific facts ('Q4 launch is the new onesie line', 'we're freezing holiday content till Oct 15'). When in doubt, leave false — pinned notes use up cache budget on every call.",
    ),
});

type ToolExecResult = { ok: true; result: unknown } | { ok: false; error: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — match the other API routes.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY not configured. Add it under Vercel Project Settings → Environment Variables.",
    });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
    return res.status(500).json({
      error: "Supabase env not fully configured. Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY.",
    });
  }

  let body: RequestBody;
  if (typeof req.body === "string") {
    try {
      body = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  } else {
    body = (req.body ?? {}) as RequestBody;
  }
  if (!body?.accountId) return res.status(400).json({ error: "accountId is required" });
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
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
  if (!profile?.is_agency) {
    return res.status(403).json({ error: "Co-pilot is agency-only for now" });
  }

  if (!WHITELIST.includes(body.accountId)) {
    return res.status(403).json({
      error: "This brand isn't on the Co-pilot allowlist yet. Add its UUID to AI_COPILOT_BRAND_IDS in Vercel env vars.",
    });
  }

  let brandContext = "";
  try {
    brandContext = await loadAndCompileBrandContext(serviceClient, body.accountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to compile brand context: ${msg}` });
  }
  if (!brandContext) {
    return res.status(404).json({
      error: "No brand kit found for this account. Run Brand Intelligence first to populate it.",
    });
  }

  // SSE response setup.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);
  res.write(": stream open\n\n");

  // Tool implementations live INSIDE the handler so they can close over
  // accountId + user.id + serviceClient without globally-mutable plumbing.
  // The AI SDK runs execute() automatically inside the agentic loop and
  // appends the returned value as a tool-result message for the model.
  const tools = {
    create_post_plan_draft: tool({
      description:
        "Create a new post plan as an AI draft in this brand's calendar. The plan lands at status='drafting' with ai_generated=true. The admin reviews and edits in the existing post-plan detail view, then submits for review through the standard workflow. Use this whenever the admin asks you to plan a post or draft content — don't just describe the post, create it.",
      inputSchema: createPostPlanDraftInput,
      execute: async (input): Promise<ToolExecResult> => {
        const insertRow = {
          account_id: body.accountId,
          scheduled_at: input.scheduled_at,
          platforms: input.platforms,
          concept: input.concept,
          copy_variants: input.copy_variants,
          status: "drafting",
          created_by: user.id,
          ai_generated: true,
          ai_draft_payload: input,
        };

        const { data, error } = await serviceClient
          .from("post_plans")
          .insert(insertRow)
          .select("id, scheduled_at, platforms, concept, status")
          .single();

        if (error) return { ok: false, error: `insert failed: ${error.message}` };
        return {
          ok: true,
          result: {
            id: data.id,
            scheduled_at: data.scheduled_at,
            platforms: data.platforms,
            concept: data.concept,
            status: data.status,
          },
        };
      },
    }),
    write_brand_note: tool({
      description:
        "Persist a fact about this brand to the brand_kit_notes table — the AI Co-pilot's long-term memory layer for this brand. Use this when the admin tells you to remember something: 'remember that…', 'from now on…', 'make a note that…', 'the founder hates the word X', 'no holiday content before Oct 15'. The note becomes part of the brand context on every future AI call (chat + inline copy generation). Set is_pinned=true for ALWAYS-true facts that should ride along on every call regardless of recency; leave is_pinned=false for time-bound or campaign-specific facts that decay out of the window over time. After calling, confirm to the admin in one short sentence what you wrote down.",
      inputSchema: writeBrandNoteInput,
      execute: async (input): Promise<ToolExecResult> => {
        const noteBody = input.body.trim();
        if (!noteBody) return { ok: false, error: "body is required" };

        const { data, error } = await serviceClient
          .from("brand_kit_notes")
          .insert({
            account_id: body.accountId,
            body: noteBody,
            is_pinned: input.is_pinned === true,
            created_by: user.id,
          })
          .select("id, body, is_pinned, created_at")
          .single();

        if (error) return { ok: false, error: `insert failed: ${error.message}` };
        return {
          ok: true,
          result: {
            id: data.id,
            body: data.body,
            is_pinned: data.is_pinned,
            created_at: data.created_at,
          },
        };
      },
    }),
  };

  try {
    // Two cache breakpoints on the system prompt, same as v1:
    //   1. Fixed instruction prefix (rarely changes)
    //   2. Per-brand context blob (stable per call, changes on brand mutations)
    // The AI SDK collapses consecutive system messages into a single Anthropic
    // system param with multiple text blocks, each with its own cache_control.
    // Verified by the PoC route — see AI_COPILOT_V2_MIGRATION.md PoC results.
    const result = streamText({
      model: anthropic(MODEL_ID),
      maxOutputTokens: MAX_TOKENS_PER_TURN,
      stopWhen: stepCountIs(MAX_STEPS),
      tools,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        {
          role: "system",
          content: `\n\n---\n\n${brandContext}`,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        ...body.messages.map((m) => ({
          role: m.role,
          content: m.content as string,
        })),
      ],
    });

    // Drain the full event stream and translate to the existing custom SSE
    // wire format. CopilotPanel.jsx's parseSse generator reads these exact
    // event names; switching to AI SDK's data-stream protocol happens in
    // Phase 2a alongside the useChat client rewrite.
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        writeSseEvent(res, "text", { delta: part.text });
      } else if (part.type === "tool-call") {
        writeSseEvent(res, "tool_call", {
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
      } else if (part.type === "tool-result") {
        // The AI SDK wraps the tool's execute() return value as `output`.
        // Our v1 protocol splits ok/result/error so the client renders
        // the right card variant.
        const output = part.output as ToolExecResult | undefined;
        const ok = output && typeof output === "object" && "ok" in output ? output.ok : true;
        writeSseEvent(res, "tool_result", {
          id: part.toolCallId,
          name: part.toolName,
          ok,
          result: ok && output && "result" in output ? output.result : ok ? output : undefined,
          error: !ok && output && "error" in output ? output.error : undefined,
        });
      } else if (part.type === "finish-step") {
        // Per-step usage event — same shape (snake_case) as v1's
        // post-finalMessage emit so the client's usage meter is unchanged.
        // AI SDK exposes cache tokens at usage.inputTokenDetails.{cacheRead,cacheWrite}Tokens.
        // See AI_COPILOT_V2_MIGRATION.md PoC results for the field-path source.
        const u = part.usage as
          | {
              inputTokens?: number;
              outputTokens?: number;
              inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
            }
          | undefined;
        writeSseEvent(res, "usage", {
          input_tokens: u?.inputTokenDetails?.noCacheTokens ?? u?.inputTokens ?? 0,
          output_tokens: u?.outputTokens ?? 0,
          cache_creation_input_tokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
          cache_read_input_tokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
        });
      } else if (part.type === "finish") {
        writeSseEvent(res, "done", { stop_reason: part.finishReason });
      } else if (part.type === "error") {
        const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
        writeSseEvent(res, "error", { error: errMsg });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSseEvent(res, "error", { error: msg });
  } finally {
    res.end();
  }
}
