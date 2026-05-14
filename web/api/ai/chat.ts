// =====================================================================
// /api/ai/chat — Vercel serverless function — AI Co-pilot streaming chat
//
// AI Co-pilot v2 Phase 2a: switched the wire protocol from the v1 custom
// SSE event names (text / tool_call / tool_result / usage / done / error)
// to the AI SDK's native UIMessage stream protocol. CopilotPanel.jsx is
// rewritten in the same PR around `useChat` from @ai-sdk/react and
// consumes the new stream natively. Server reads UIMessage[] from the
// request body and converts them to ModelMessages for streamText.
//
// (Phase 1a — merged earlier — moved from raw @anthropic-ai/sdk to
// streamText + tool primitives but kept the legacy wire protocol via
// a manual fullStream translation. That translation is gone now.)
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
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
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
- Match the brand's voice in any copy you draft. If the voice block is sparse, infer from the Voice anchors and Top performers blocks (the opening lines and concepts of the brand's best-performing recent posts).
- Be concise. The admin reads fast and prefers signal over preamble.
- **Defaults-first, not questions-first.** When the admin asks you to plan a post or draft content, pick a sensible default and CREATE the draft. Don't ask "what date?", "which platform?", "what concept?" — decide and ship. Drafts are cheap and reversible: they land in the calendar as "✨ AI draft" with status='drafting', and the admin edits or deletes them in one click. Only ask a clarifying question if the request is genuinely ambiguous (e.g. "plan something for the launch" with no launch named anywhere in the brand context). When in doubt, draft something and let the admin redirect.
- **Default ladder for missing info.** When the admin doesn't specify details, use these defaults in order:
  1. **Date:** look at the Upcoming calendar block. Pick the next obvious gap in the brand's posting rhythm (Cadence block shows last-posted-per-platform). If a major Upcoming moment is within 14 days and on-brand, anchor the date to that moment instead. If no signal at all, pick 2 days from today.
  2. **Time:** 09:00 in the brand's timezone (see the ## Today block).
  3. **Platforms:** if the brand's strategy mentions primary platforms, use those. Otherwise infer from past approved posts and Top performers. If still ambiguous, default to Instagram (most brands' primary).
  4. **Concept:** derive from upcoming moments + brand pillars + cadence gaps + the admin's hints. Lean on the brand's pillars — rotating across them avoids monotone calendars.
- **Be proactive.** When the conversation opens (no prior assistant messages in this turn's history) or the admin asks an open-ended question like "what should I post?", lead with what's most relevant right now: upcoming holidays/festivals on the brand's market, cadence gaps, what top-performing recent posts can be built on, anything in the brand notes that's time-bound. Then offer 2-3 concrete next moves. Don't just dump information — propose action.
- **Use the calendar context.** Before creating a draft, glance at the Upcoming calendar block. Don't propose a date that's already busy on every targeted platform. Don't suggest content concepts that duplicate something already drafted within 7 days. If the calendar is empty, that's the most important signal — propose filling it, not analysing it.
- When the admin tells you to remember something about the brand — phrases like "remember that…", "from now on…", "make a note that…", "the founder hates the word X", "we always tag Y on milestone posts", "no holiday content before Oct 15" — call the write_brand_note tool. Pin facts that are ALWAYS-true; leave non-pinned for time-bound or context-specific facts. The note becomes part of the brand context on every future call — for chat AND for inline copy generation.
- After calling a tool, briefly tell the admin what you did and link them to the result if applicable. Don't just go silent.

## Platform craft (universal — applies to every brand)

When drafting copy via create_post_plan_draft, match these platform conventions. They're defaults — the brand voice in the brand-context block OVERRIDES any of this if there's genuine tension. Use these as a baseline when the brand voice doesn't speak directly to a question.

### Instagram
- Open with a hook in the FIRST line (it's the only part visible above the "more" fold). Not "Today we're excited to share…". Lead with the thing that earns the scroll-stop.
- Conversational, sensory language. Show, don't tell. Specific > generic.
- Line breaks every 1-2 sentences for mobile scannability.
- ~150-300 words is the sweet spot. Shorter is fine; longer needs to earn its length.
- End with a CTA or a question that genuinely invites comments (skip generic "what do you think?").
- Hashtags only if directly relevant; never spammy. Place on the last line, not mid-sentence.
- Emojis sparingly — only if the brand voice permits.

### LinkedIn
- Authority + warmth. Open with a personal angle, a surprising stat, or a contrarian observation — never "I'm excited to share…", "Big news!", or any LinkedIn-clichéd opener.
- Paragraph breaks every 1-2 sentences. LinkedIn collapses long paragraphs on mobile.
- ~150-300 words. End with a forward-looking insight or a question that invites professional discussion (substantive, not "thoughts?").
- No emojis unless the brand voice is explicitly playful. No hashtags inline; if any are needed, put them on the final line.

### X (Twitter)
- One punchy thought. Hard cap ~280 characters.
- Rewrite for compression — if it doesn't fit, cut adjectives, kill throat-clearing, drop the second sentence.
- No hashtags unless directly relevant. No emoji unless the brand voice permits.
- If the idea genuinely needs more space, it's a thread — but only propose a thread if the admin explicitly asks.

### Cross-platform (when the admin asks for the same concept across multiple platforms)
- Match the campaign ANGLE across platforms; adapt the FORMAT to each.
- Don't copy-paste the same caption — Instagram's hook structure breaks LinkedIn's tone, and X needs ruthless trimming.
- If one platform genuinely doesn't fit the angle, say so and propose a different angle for that platform rather than forcing a bad fit.

## Available tools

- read_brand_context — already compiled into the system message; you don't need to call this unless the admin explicitly says "refresh my brand context"
- create_post_plan_draft — create a real post_plans row pre-filled with concept and per-platform copy. status='drafting', ai_generated=true. The admin will edit and submit for review.
- write_brand_note — persist a fact about the brand to the brand_kit_notes table. Used when the admin tells you to remember something. The note flows into the brand context on every future AI call (chat + inline copy). Pin always-true facts; leave others non-pinned.

## What you don't do

- Don't publish anything. You can only create drafts.
- Don't touch other brands. You're scoped to the active brand only.
- Don't claim to schedule posts — you create drafts on a date; the agency owns the workflow.`;

// The request body carries the UIMessage[] from useChat plus our custom
// accountId field (configured via DefaultChatTransport's body option on
// the client). UIMessage's `parts` array is what streams from the AI SDK
// and what convertToModelMessages consumes.
type RequestBody = {
  accountId?: string;
  messages?: UIMessage[];
};

// Zod schemas — replace the hand-written Anthropic.Tool[] from v1.
// Schema validation now happens at the SDK boundary; bad inputs from the
// model surface as standard Zod errors instead of runtime undefineds.
const createPostPlanDraftInput = z.object({
  scheduled_at: z
    .string()
    .describe(
      "ISO 8601 datetime for when to schedule this post (e.g. '2026-05-15T09:00:00+05:30'). Default to 09:00 in the brand's local timezone (see the ## Today block) on the next sensible date — pick the closest cadence gap from the Upcoming calendar block, or anchor to an Upcoming moment within 14 days if the concept fits. Don't ask the admin for a date; pick one and ship the draft. The admin will edit if needed.",
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
    // Chat opts INTO the calendar block — it's the route that needs to
    // reason about upcoming plans, cadence gaps, top performers, and
    // voice anchors. The inline-copy and image routes leave it off so
    // they don't pay for context they can't act on.
    brandContext = await loadAndCompileBrandContext(serviceClient, body.accountId, {
      includeCalendar: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to compile brand context: ${msg}` });
  }
  if (!brandContext) {
    return res.status(404).json({
      error: "No brand kit found for this account. Run Brand Intelligence first to populate it.",
    });
  }

  // Disable Vercel's response buffering so deltas reach the browser as
  // they're generated. pipeUIMessageStreamToResponse handles Content-Type
  // + Cache-Control + the AI SDK's data-stream protocol headers itself.
  res.setHeader("X-Accel-Buffering", "no");

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
    // Two cache breakpoints on the system prompt:
    //   1. Fixed instruction prefix (rarely changes — system-prompt edits only)
    //   2. Per-brand context blob (changes when brand kit / notes / calendar
    //      / engagement snapshots mutate, and at midnight brand-local when
    //      the ## Today block rolls over to a new date)
    // Cache TTL is 5 minutes, so back-to-back turns within a conversation
    // hit cache. The brand-context blob is refreshed every request, so any
    // draft the model creates mid-conversation shows up in the calendar
    // section on the NEXT turn — preventing duplicate proposals.
    // Both rides via the `system` parameter (as an array of
    // SystemModelMessage) instead of being mixed into `messages`. The
    // AI SDK emits a security warning when role:'system' entries appear
    // in `messages` because — in principle — that's a prompt-injection
    // vector (user content could leak into a system block). Our content
    // is 100% server-controlled so the warning is informational, but
    // using `system: [...]` is the cleaner API path AND keeps both
    // cache breakpoints intact (SystemModelMessage supports providerOptions
    // and the AI SDK collapses the array into a single Anthropic system
    // param with multiple text blocks, each with its own cache_control).
    // Verified by the PoC route — see AI_COPILOT_V2_MIGRATION.md PoC results.
    //
    // UIMessage[] from the client is converted to ModelMessage[] via
    // convertToModelMessages — handles text + tool-call + tool-result
    // parts uniformly.
    const result = streamText({
      model: anthropic(MODEL_ID),
      maxOutputTokens: MAX_TOKENS_PER_TURN,
      stopWhen: stepCountIs(MAX_STEPS),
      tools,
      system: [
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
      ],
      messages: await convertToModelMessages(body.messages),
    });

    // Pipe the AI SDK's native UIMessage stream protocol directly to the
    // Vercel ServerResponse. The client's useChat hook consumes this
    // protocol natively — no manual SSE translation on either side.
    //
    // messageMetadata attaches per-message usage to the UIMessage so the
    // client can render a "X in (Y cached) · Z out" token meter from
    // message.metadata. Fires on the model's `finish` event (final step).
    // The AI SDK normalizes cache counts at usage.inputTokenDetails —
    // see feedback_ai_sdk_v6_cache_tokens.md for the field-path source.
    result.pipeUIMessageStreamToResponse(res, {
      messageMetadata: ({ part }) => {
        if (part.type !== "finish") return undefined;
        const u = part.totalUsage as
          | {
              inputTokens?: number;
              outputTokens?: number;
              inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
            }
          | undefined;
        return {
          usage: {
            input_tokens: u?.inputTokenDetails?.noCacheTokens ?? u?.inputTokens ?? 0,
            output_tokens: u?.outputTokens ?? 0,
            cache_creation_input_tokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
            cache_read_input_tokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
          },
        };
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg;
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      return res.status(500).json({ error: msg });
    }
    // Stream already started — best we can do is end the response.
    res.end();
  }
}
