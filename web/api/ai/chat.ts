// =====================================================================
// /api/ai/chat — Vercel serverless function — AI Co-pilot streaming chat
//
// First user-facing slice of the agency-side AI Co-pilot (PR 2). Streams
// Claude responses over Server-Sent Events to the sidebar Co-pilot panel,
// handles tool-use (read_brand_context, create_post_plan_draft), and
// gates the entire surface behind a brand-id whitelist env var so we can
// validate end-to-end with one brand before rolling out.
//
// Auth model (mirrors find-competitors.ts):
//   - Caller's JWT verified against Supabase auth via the anon-key client.
//   - Caller must be agency staff (profiles.is_agency = true). Brand
//     users can't reach this route by design — the feature is agency-only
//     for now. (Brand Co-pilot is a later phase.)
//   - The target accountId must be in the AI_COPILOT_BRAND_IDS whitelist.
//     This is the rollout gate; expand the list as we widen the test set.
//   - Writes (create_post_plan_draft) use the service-role client to
//     bypass any membership-check ambiguity. The agency-staff + whitelist
//     gates above are the real boundary.
//
// Env vars (set on the lr-studio-dashboard-3kkp Vercel project):
//   ANTHROPIC_API_KEY         — required, sk-ant-...
//   AI_COPILOT_BRAND_IDS      — comma-separated UUIDs of brands allowed
//                               to use the Co-pilot. Empty = nobody can.
//   SUPABASE_URL              — https://vmfwnfflhvskadkfnvds.supabase.co
//   SUPABASE_ANON_KEY         — for JWT verification
//   SUPABASE_SERVICE_ROLE_KEY — for tool-call writes
//
// Cost notes (see project memory for the full breakdown):
//   - Brand-context blob is sent as a prompt-cached system message via
//     cache_control. Cache TTL is 5 minutes; back-to-back chat turns
//     for the same brand re-hit the cache and pay ~10% input-token rate.
//   - Default model: claude-sonnet-4-6. Hard-coded for now; switch via
//     env var only if we need to A/B.
//   - Aggressive max_tokens caps per turn keep stray verbose runs from
//     burning tokens we can't undo.
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
const MAX_TURNS = 8;           // Cap on agentic tool-use loop iterations.
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

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_post_plan_draft",
    description:
      "Create a new post plan as an AI draft in this brand's calendar. The plan lands at status='drafting' with ai_generated=true. The admin reviews and edits in the existing post-plan detail view, then submits for review through the standard workflow. Use this whenever the admin asks you to plan a post or draft content — don't just describe the post, create it.",
    input_schema: {
      type: "object",
      properties: {
        scheduled_at: {
          type: "string",
          description:
            "ISO 8601 datetime for when to schedule this post (e.g. '2026-05-15T09:00:00+05:30'). Default to 09:00 in the brand's local time on the requested date. If the admin doesn't specify a date, ask before guessing.",
        },
        platforms: {
          type: "array",
          description: "Platforms this post targets. Subset of ['instagram', 'linkedin', 'x'].",
          items: { type: "string", enum: ["instagram", "linkedin", "x"] },
        },
        concept: {
          type: "string",
          description:
            "Short (1-2 sentence) concept for the post — what it's about, what angle. The admin sees this as the post's headline.",
        },
        copy_variants: {
          type: "object",
          description:
            "Per-platform draft copy keyed by platform slug. Each value is a string containing the actual caption / tweet / post body. Match the brand voice. Cap Instagram at ~2,200 chars, X at ~280 chars, LinkedIn at ~3,000 chars.",
          properties: {
            instagram: { type: "string" },
            linkedin: { type: "string" },
            x: { type: "string" },
          },
        },
      },
      required: ["scheduled_at", "platforms", "concept", "copy_variants"],
    },
  },
  {
    name: "write_brand_note",
    description:
      "Persist a fact about this brand to the brand_kit_notes table — the AI Co-pilot's long-term memory layer for this brand. Use this when the admin tells you to remember something: 'remember that…', 'from now on…', 'make a note that…', 'the founder hates the word X', 'no holiday content before Oct 15'. The note becomes part of the brand context on every future AI call (chat + inline copy generation). Set is_pinned=true for ALWAYS-true facts that should ride along on every call regardless of recency; leave is_pinned=false for time-bound or campaign-specific facts that decay out of the window over time. After calling, confirm to the admin in one short sentence what you wrote down.",
    input_schema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "The note text — what to remember. Write it in declarative, action-oriented form (e.g. 'Always tag @sarahbamboo on milestone posts' not 'I should remember to tag @sarahbamboo'). Keep it to 1-3 sentences. Phrase it so a future AI reading it can act on it without further context.",
        },
        is_pinned: {
          type: "boolean",
          description:
            "true for always-true facts ('founder's wife runs the brand', 'never use the word authentic'). false for time-bound or context-specific facts ('Q4 launch is the new onesie line', 'we're freezing holiday content till Oct 15'). When in doubt, leave false — pinned notes use up cache budget on every call.",
        },
      },
      required: ["body"],
    },
  },
];

type ChatMessage = {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlockParam[];
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

async function runToolCall(
  serviceClient: SupabaseClient,
  accountId: string,
  userId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (toolName === "create_post_plan_draft") {
    const scheduledAt = typeof toolInput.scheduled_at === "string" ? toolInput.scheduled_at : "";
    const platforms = Array.isArray(toolInput.platforms)
      ? (toolInput.platforms as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const concept = typeof toolInput.concept === "string" ? toolInput.concept : "";
    const copyVariants =
      toolInput.copy_variants && typeof toolInput.copy_variants === "object"
        ? (toolInput.copy_variants as Record<string, unknown>)
        : {};

    if (!scheduledAt) return { ok: false, error: "scheduled_at is required" };
    if (!platforms.length) return { ok: false, error: "platforms must be non-empty" };

    const insertRow = {
      account_id: accountId,
      scheduled_at: scheduledAt,
      platforms,
      concept,
      copy_variants: copyVariants,
      status: "drafting",
      created_by: userId,
      ai_generated: true,
      ai_draft_payload: toolInput,
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
  }

  if (toolName === "write_brand_note") {
    const body = typeof toolInput.body === "string" ? toolInput.body.trim() : "";
    const isPinned = toolInput.is_pinned === true;
    if (!body) return { ok: false, error: "body is required" };
    // Cap body length defensively — notes are meant to be short facts, not
    // essays. If the model tries to write a 4000-char screed it likely
    // misunderstood the tool's purpose.
    if (body.length > 1000) {
      return { ok: false, error: "body must be <= 1000 chars; notes are short facts" };
    }

    const { data, error } = await serviceClient
      .from("brand_kit_notes")
      .insert({
        account_id: accountId,
        body,
        is_pinned: isPinned,
        created_by: userId,
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
  }

  return { ok: false, error: `Unknown tool: ${toolName}` };
}

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

  // Verify caller's JWT and confirm they're agency staff.
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

  // Whitelist gate — accountId must be in AI_COPILOT_BRAND_IDS.
  if (!WHITELIST.includes(body.accountId)) {
    return res.status(403).json({
      error: "This brand isn't on the Co-pilot allowlist yet. Add its UUID to AI_COPILOT_BRAND_IDS in Vercel env vars.",
    });
  }

  // Compile the brand-context blob via service-role (full read access).
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

  // Set up SSE response.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);
  // Initial flush so the client knows we're streaming.
  res.write(": stream open\n\n");

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Build the cached system message. Two cache breakpoints — one on the
  // fixed instruction prefix (rarely changes), one on the brand-context
  // suffix (changes per brand mutation, stable per call).
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `\n\n---\n\n${brandContext}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  // Normalize messages — clients send string content; Anthropic accepts that.
  const messages: Anthropic.MessageParam[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content as never,
  }));

  try {
    let turn = 0;
    while (turn < MAX_TURNS) {
      turn += 1;

      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_TURN,
        system: systemBlocks,
        tools: TOOLS,
        messages,
      });

      // Forward text deltas as `text` SSE events for the panel to render.
      stream.on("text", (delta) => {
        writeSseEvent(res, "text", { delta });
      });

      const finalMessage = await stream.finalMessage();

      // Surface usage so the panel can show a small token counter / cache stats.
      writeSseEvent(res, "usage", {
        input_tokens: finalMessage.usage.input_tokens,
        output_tokens: finalMessage.usage.output_tokens,
        cache_creation_input_tokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: finalMessage.usage.cache_read_input_tokens ?? 0,
      });

      // Collect any tool_use blocks so we can run them and feed back results.
      const toolUses = finalMessage.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      // Always append the assistant's full message to history before
      // continuing — the SDK insists on this for tool-use turns.
      messages.push({ role: "assistant", content: finalMessage.content });

      if (finalMessage.stop_reason === "end_turn" || toolUses.length === 0) {
        writeSseEvent(res, "done", { stop_reason: finalMessage.stop_reason });
        break;
      }

      if (finalMessage.stop_reason !== "tool_use") {
        // max_tokens, etc — bail cleanly so the panel can show a partial result.
        writeSseEvent(res, "done", { stop_reason: finalMessage.stop_reason });
        break;
      }

      // Run each tool call (sequentially — they're small and the order
      // matters for the user-visible card stream), emit tool_call + tool_result
      // events as we go, and build the tool_result blocks for the next turn.
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        writeSseEvent(res, "tool_call", {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });

        const result = await runToolCall(
          serviceClient,
          body.accountId,
          user.id,
          toolUse.name,
          (toolUse.input ?? {}) as Record<string, unknown>,
        );

        writeSseEvent(res, "tool_result", {
          id: toolUse.id,
          name: toolUse.name,
          ok: result.ok,
          result: result.ok ? result.result : undefined,
          error: result.ok ? undefined : result.error,
        });

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.ok ? JSON.stringify(result.result) : `error: ${result.error}`,
          is_error: !result.ok,
        });
      }

      messages.push({ role: "user", content: toolResultBlocks });
    }

    if (turn >= MAX_TURNS) {
      writeSseEvent(res, "done", { stop_reason: "max_turns_reached" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSseEvent(res, "error", { error: msg });
  } finally {
    res.end();
  }
}
