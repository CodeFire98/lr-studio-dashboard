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
  generateObject,
  InvalidToolInputError,
  NoSuchToolError,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { loadAndCompileBrandContext } from "../../src/lib/brandContext.js";
import {
  compileSkillMenu,
  loadSkill,
  loadSkillReference,
  SKILL_SLUGS,
} from "../../src/lib/skillRegistry.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

const WHITELIST = (process.env.AI_COPILOT_BRAND_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MODEL_ID = "claude-sonnet-4-6";
const REPAIR_MODEL_ID = "claude-haiku-4-5-20251001";
const MAX_STEPS = 8;
const MAX_TOKENS_PER_TURN = 1500;

// =====================================================================
// Tool-call robustness: silent JSON repair + history sanitizer
// =====================================================================
//
// Claude occasionally emits malformed JSON for large tool calls — most
// commonly a stray trailing brace on multi-platform `copy_variants`
// objects that run to ~1.5K chars. Two failure modes when this happens:
//
//   1. The current turn shows a red "tool failed" tile until the model
//      retries (which it does, but the user sees the failure).
//   2. The broken `tool_use` block gets persisted in the UIMessage
//      history. On the NEXT turn, convertToModelMessages forwards it to
//      Anthropic, which strict-rejects with
//      "messages.N.content.M.tool_use.input: Input should be an object"
//      and the WHOLE conversation becomes unusable until the user starts
//      a new chat.
//
// Two layers of defense:
//
//   A. `experimental_repairToolCall` — fires when a tool call has
//      invalid input. We try a cheap JSON cleanup first (strip trailing
//      garbage, trailing commas, smart quotes). If that fails, a Haiku
//      `generateObject` call asks the model to re-emit the input against
//      the tool's schema. Either way, the repair completes BEFORE the
//      tool's execute() runs and BEFORE anything reaches the client —
//      so the user sees a successful tool result without ever knowing
//      the model botched the first attempt.
//
//   B. `sanitizeBrokenToolCalls` — for conversations that are already
//      poisoned (broken `tool_use` blocks persisted in a prior turn,
//      before this fix shipped), we walk the incoming message history
//      and neutralize any tool part whose state is an error or whose
//      input isn't a plain object. Replace with a synthetic completed
//      tool call (input: {}, output: { ok: false, error: ... }) so the
//      Anthropic API sees a valid message and the conversation unblocks
//      itself on the next message.

const TOOL_PREFIX = "tool-";

// Strip common JSON garbage and try to parse. Catches the trailing-extra-
// brace case (our observed real-world failure) and a few other cheap fixes.
// Returns the parsed value or null when nothing salvageable.
function tryRepairJson(raw: string): unknown | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try as-is first (handles "valid JSON that just failed Zod" — the
  // repair path will still hand it back to the schema validator).
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Trailing commas before close brace / bracket.
  const noTrailingComma = trimmed.replace(/,(\s*[}\]])/g, "$1");
  if (noTrailingComma !== trimmed) {
    try {
      return JSON.parse(noTrailingComma);
    } catch {
      // fall through
    }
  }

  // "Unexpected non-whitespace character after JSON at position N" —
  // truncate to position N and re-parse. This is the exact pattern of
  // the trailing-extra-brace failure we observed in production.
  try {
    JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const match = /position\s+(\d+)/.exec(msg);
    if (match) {
      const pos = Number(match[1]);
      if (Number.isFinite(pos) && pos > 0 && pos <= trimmed.length) {
        try {
          return JSON.parse(trimmed.slice(0, pos));
        } catch {
          // fall through
        }
      }
    }
  }

  return null;
}

// Walk through the incoming UIMessage[] and neutralize any broken tool
// parts. Replaces malformed inputs with `{}` and force-completes the
// state so Anthropic accepts the conversation history. Past failures
// stop blocking future turns.
function sanitizeBrokenToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((msg) => {
    if (!msg || !Array.isArray(msg.parts)) return msg;
    let touched = false;
    const parts = msg.parts.map((part) => {
      const partType = part?.type;
      if (typeof partType !== "string" || !partType.startsWith(TOOL_PREFIX)) {
        return part;
      }
      const anyPart = part as Record<string, unknown> & {
        state?: string;
        input?: unknown;
        output?: unknown;
      };
      const inputIsObject =
        anyPart.input !== null &&
        typeof anyPart.input === "object" &&
        !Array.isArray(anyPart.input);
      const stateIsError =
        anyPart.state === "output-error" ||
        anyPart.state === "input-error" ||
        anyPart.state === "input-streaming";
      if (inputIsObject && anyPart.state === "output-available") return part;
      if (!inputIsObject || stateIsError) {
        touched = true;
        return {
          ...anyPart,
          state: "output-available",
          input: inputIsObject ? anyPart.input : {},
          output: { ok: false, error: "previous tool call recovered" },
          errorText: undefined,
        };
      }
      return part;
    });
    return touched ? { ...msg, parts: parts as typeof msg.parts } : msg;
  });
}

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
- **Don't announce internal failures.** If a tool call fails and you retry successfully on the next step, present the final result as if it worked the first time. Don't say "let me try that again", "apologies for the error", or any variant. The admin doesn't need to see plumbing slips.

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
- load_skill — fetch one of the marketing playbooks listed below. Use when its description matches the work. Loaded body rides in context for the rest of the conversation.
- load_skill_reference — fetch a deep-dive reference doc from an already-loaded skill (e.g. post templates, copy frameworks, idea catalogues). Call when the SKILL response lists the reference and it looks directly useful.

__SKILL_MENU__

## What you don't do

- Don't publish anything. You can only create drafts.
- Don't touch other brands. You're scoped to the active brand only.
- Don't claim to schedule posts — you create drafts on a date; the agency owns the workflow.`.replace("__SKILL_MENU__", compileSkillMenu());

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

// Zod enum from the registry's slug list — keeps the schema in sync with
// the registry without hand-listing slugs in two places.
const skillSlugSchema = z.enum(SKILL_SLUGS as [string, ...string[]]);

const loadSkillInput = z.object({
  slug: skillSlugSchema.describe(
    "Slug of the marketing playbook to load. Must match one of the slugs from the 'Available marketing playbooks' menu in the system prompt. Loaded body stays in context for the rest of this conversation — don't re-load the same skill.",
  ),
});

const loadSkillReferenceInput = z.object({
  slug: skillSlugSchema.describe(
    "Slug of the parent marketing playbook. Must be a skill you've already loaded — the response from load_skill lists its available_references.",
  ),
  reference_name: z
    .string()
    .min(1)
    .describe(
      "Name of the reference doc to load — must be one of the strings from the parent skill's `available_references` array. Examples: 'post-templates' (from social-content), 'copy-frameworks' (from copywriting), 'ideas-by-category' (from marketing-ideas).",
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
    load_skill: tool({
      description:
        "Fetch a marketing playbook (e.g. social-content, copywriting, launch-strategy). Returns the full markdown body of the playbook plus a list of deeper reference docs available for that skill. The body stays in context for the rest of this conversation, so you don't need to re-load. Use when the admin's request is well-served by the skill — read the playbook first, THEN apply its frameworks/templates/checklists when drafting or planning. Don't load speculatively.",
      inputSchema: loadSkillInput,
      execute: async (input): Promise<ToolExecResult> => {
        // Pure file read — no DB, no auth. Already gated by the surrounding
        // route's agency + brand-allowlist checks.
        return loadSkill(input.slug);
      },
    }),
    load_skill_reference: tool({
      description:
        "Fetch a deep-dive reference doc from an already-loaded marketing playbook. Examples: 'post-templates' (social-content) for ready-to-adapt post structures, 'copy-frameworks' (copywriting) for AIDA/PAS/etc., 'ideas-by-category' (marketing-ideas) for the 140-idea catalogue. The parent skill's load_skill response lists which references are available. Use sparingly — references are deeper material than the SKILL itself.",
      inputSchema: loadSkillReferenceInput,
      execute: async (input): Promise<ToolExecResult> => {
        return loadSkillReference(input.slug, input.reference_name);
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
      // Silent repair for malformed tool inputs. The model occasionally
      // emits invalid JSON for big tool calls (e.g. trailing extra
      // braces on multi-platform copy_variants). We try a cheap cleanup
      // first, then fall back to a Haiku re-emit. Returning a repaired
      // ToolCall makes the SDK transparently re-run execute() with the
      // fixed input; the user never sees the failure.
      experimental_repairToolCall: async ({ toolCall, tools: toolSet, inputSchema, error }) => {
        // Schema-validation failures we can't repair — return null and
        // let the SDK surface the error normally (model will retry).
        if (NoSuchToolError.isInstance(error)) return null;
        if (!InvalidToolInputError.isInstance(error)) return null;

        const rawInput = typeof toolCall.input === "string" ? toolCall.input : "";

        // Tier 1: cheap JSON cleanup.
        const cleaned = tryRepairJson(rawInput);
        if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
          const toolDef = (toolSet as Record<string, { inputSchema?: z.ZodTypeAny }>)[toolCall.toolName];
          if (toolDef?.inputSchema) {
            const parsed = toolDef.inputSchema.safeParse(cleaned);
            if (parsed.success) {
              return { ...toolCall, input: JSON.stringify(parsed.data) };
            }
          } else {
            return { ...toolCall, input: JSON.stringify(cleaned) };
          }
        }

        // Tier 2: ask Haiku to re-emit valid input against the schema.
        // Cheap and almost always succeeds because the malformation is a
        // generation slip, not a semantic confusion.
        try {
          const schemaJson = await inputSchema({ toolName: toolCall.toolName });
          const { object } = await generateObject({
            model: anthropic(REPAIR_MODEL_ID),
            schema: schemaJson as Parameters<typeof generateObject>[0]["schema"],
            prompt: [
              `A previous tool call to "${toolCall.toolName}" had invalid input.`,
              `<original_input>`,
              rawInput.slice(0, 4000),
              `</original_input>`,
              `<error>${error.message}</error>`,
              `Re-emit the same intent as a valid JSON object matching the schema. Preserve the user's intent and the copy/content verbatim where possible — fix only the malformed structure.`,
            ].join("\n\n"),
            maxOutputTokens: 4000,
          });
          return { ...toolCall, input: JSON.stringify(object) };
        } catch (repairErr) {
          // Repair attempt itself failed (network, schema, etc.) — surface
          // the original error so the SDK falls back to model retry.
          console.error("[chat] repairToolCall failed", repairErr);
          return null;
        }
      },
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
      // sanitizeBrokenToolCalls unblocks conversations that were poisoned
      // by a malformed tool_use block from a turn before this fix shipped.
      messages: await convertToModelMessages(sanitizeBrokenToolCalls(body.messages)),
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
