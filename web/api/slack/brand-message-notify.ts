// =====================================================================
// /api/slack/brand-message-notify — Vercel serverless function
//
// Receives a fire-and-forget POST from the Postgres trigger
// `notify_slack_on_brand_message` (see migration 0061) whenever a brand
// user inserts a row into `conversation_messages`. Re-fetches the
// message with full context (brand name, author display name, tagged
// plan, attachments count) and POSTs a Block Kit payload to the
// Slack Incoming Webhook for #lrmedia-inbox.
//
// Contract from the trigger:
//   POST /api/slack/brand-message-notify
//   Authorization: Bearer ${SLACK_NOTIFY_SHARED_SECRET}
//   Content-Type:  application/json
//   Body:          { "message_id": "<uuid>" }
//
// We deliberately re-fetch instead of trusting the payload because the
// trigger fires inside the same transaction as the INSERT and the user's
// row may not yet be visible to a SELECT from outside Postgres. pg_net
// is async though, so by the time we read here the commit has landed
// (verified empirically with the 0054 digest crons — same plumbing).
//
// Auth model:
//   - Authorization: Bearer <SLACK_NOTIFY_SHARED_SECRET>. The DB trigger
//     reads this from Vault and attaches it to every fire. A request
//     without (or with a wrong) bearer is rejected before any work.
//   - Service-role Supabase client for the read + log write. The route
//     intentionally bypasses RLS — the bearer check is the authz.
//
// Env vars (Vercel project settings → Environment Variables):
//   SLACK_BRAND_MSG_WEBHOOK_URL  — Slack Incoming Webhook for #lrmedia-inbox
//   SLACK_NOTIFY_SHARED_SECRET   — matches the Vault entry of the same name
//   SUPABASE_URL                 — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — sb_secret_...
//   APP_URL                      — base URL for deep links, default
//                                  "https://agency.linkrunner.io"
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SLACK_WEBHOOK_URL = process.env.SLACK_BRAND_MSG_WEBHOOK_URL ?? "";
const SHARED_SECRET = process.env.SLACK_NOTIFY_SHARED_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APP_URL = process.env.APP_URL ?? "https://agency.linkrunner.io";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
// Slack section blocks cap at 3000 chars. We truncate well before that
// so the payload reads clean and we have room for the blockquote prefix.
const BODY_TRUNCATE_AT = 600;

// =====================================================================
// Helpers
// =====================================================================

function formatIst(iso: string): string {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ist.getUTCDay()];
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][ist.getUTCMonth()];
  const day = ist.getUTCDate();
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${weekday} ${month} ${day}, ${hh}:${mm} IST`;
}

// Slack mrkdwn doesn't escape `<`, `>`, `&` automatically. Strip them
// from the body to avoid accidental link syntax / entity injection.
function sanitizeForSlackMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max).trimEnd() + "…", truncated: true };
}

function asBlockquote(s: string): string {
  // Slack mrkdwn blockquotes start each line with `> `. Multi-line bodies
  // need every line prefixed for the quote to extend.
  return s
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// =====================================================================
// Slack payload
// =====================================================================

type MessageContext = {
  message_id: string;
  body: string;
  created_at: string;
  tagged_post_plan_id: string | null;
  author_name: string;
  brand_name: string;
  brand_slug: string;
  plan_title: string | null;
  plan_id: string | null;
};

function buildSlackPayload(ctx: MessageContext): object {
  const { text: bodyTruncated, truncated } = truncate(ctx.body, BODY_TRUNCATE_AT);
  const safeBody = sanitizeForSlackMrkdwn(bodyTruncated);
  const blockquote = asBlockquote(safeBody);

  const conversationUrl = `${APP_URL}/c/${encodeURIComponent(ctx.brand_slug)}/conversations#msg-${ctx.message_id}`;
  const planUrl = ctx.plan_id
    ? `${APP_URL}/c/${encodeURIComponent(ctx.brand_slug)}/calendar/${ctx.plan_id}`
    : null;

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `New message from ${ctx.brand_name}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${ctx.author_name}* · ${formatIst(ctx.created_at)}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: blockquote + (truncated ? "\n_(message truncated — open conversation for full text)_" : ""),
      },
    },
  ];

  if (ctx.plan_title) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `On plan: *${sanitizeForSlackMrkdwn(ctx.plan_title)}*`,
        },
      ],
    });
  }

  const actionElements: object[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Open conversation", emoji: false },
      url: conversationUrl,
      style: "primary",
    },
  ];
  if (planUrl) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Open plan", emoji: false },
      url: planUrl,
    });
  }
  blocks.push({ type: "actions", elements: actionElements });

  return {
    // `text` is the fallback shown in notification previews + screen
    // readers. Keep it short and informative.
    text: `New message from ${ctx.brand_name}: ${truncate(ctx.body, 140).text}`,
    blocks,
  };
}

// =====================================================================
// Handler
// =====================================================================

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // ---- Auth ----------------------------------------------------------
  const authHeader = (req.headers.authorization ?? "").trim();
  const expected = `Bearer ${SHARED_SECRET}`;
  if (!SHARED_SECRET) {
    res.status(500).json({ error: "SLACK_NOTIFY_SHARED_SECRET not configured" });
    return;
  }
  if (authHeader !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ---- Inputs --------------------------------------------------------
  const body = (req.body ?? {}) as { message_id?: string };
  const messageId = typeof body.message_id === "string" ? body.message_id.trim() : "";
  if (!messageId) {
    res.status(400).json({ error: "Missing message_id" });
    return;
  }

  if (!SLACK_WEBHOOK_URL) {
    res.status(500).json({ error: "SLACK_BRAND_MSG_WEBHOOK_URL not configured" });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    res.status(500).json({ error: "Supabase credentials not configured" });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- Fetch enriched context ----------------------------------------
  // Two round-trips because conversations + brand_kits both FK to
  // accounts — there's no direct FK between them so PostgREST can't
  // resolve a chained embed in one go. At single-message scale the
  // extra hop is invisible.
  //
  // Query 1: message + author + tagged plan + conversation.account_id
  const { data: row, error: fetchErr } = await supabase
    .from("conversation_messages")
    .select(
      `
        id,
        body,
        kind,
        deleted_at,
        created_at,
        tagged_post_plan_id,
        author:profiles!conversation_messages_author_id_fkey ( display_name, is_agency ),
        conversation:conversations!conversation_messages_conversation_id_fkey ( account_id ),
        plan:post_plans!conversation_messages_tagged_post_plan_id_fkey ( id, title )
      `,
    )
    .eq("id", messageId)
    .maybeSingle();

  if (fetchErr) {
    await markFailure(supabase, messageId, 0, `fetch_failed: ${fetchErr.message}`);
    res.status(500).json({ error: "Fetch failed", detail: fetchErr.message });
    return;
  }
  if (!row) {
    // Message vanished between trigger fire + this read (hard-deleted?).
    // Treat as success — nothing to relay.
    await markFailure(supabase, messageId, 0, "message_not_found");
    res.status(200).json({ ok: true, skipped: "not_found" });
    return;
  }

  // ---- Defense-in-depth filter ---------------------------------------
  // The DB trigger already enforces these; re-check in case someone
  // ever calls this route manually with a stale message_id.
  const author = (row as any).author as { display_name?: string; is_agency?: boolean } | null;
  if (row.kind !== "user" || row.deleted_at !== null || !row.body || row.body.trim().length === 0) {
    await markFailure(supabase, messageId, 0, "skipped_not_user_message");
    res.status(200).json({ ok: true, skipped: "filter" });
    return;
  }
  if (!author || author.is_agency === true) {
    await markFailure(supabase, messageId, 0, "skipped_agency_author");
    res.status(200).json({ ok: true, skipped: "agency_author" });
    return;
  }

  const conv = (row as any).conversation as { account_id: string } | null;
  if (!conv?.account_id) {
    await markFailure(supabase, messageId, 0, "conversation_missing");
    res.status(200).json({ ok: true, skipped: "conversation_missing" });
    return;
  }

  // Query 2: brand_kit by account_id
  const { data: brandKit, error: brandErr } = await supabase
    .from("brand_kits")
    .select("name, slug")
    .eq("account_id", conv.account_id)
    .maybeSingle();
  if (brandErr) {
    await markFailure(supabase, messageId, 0, `brand_kit_fetch_failed: ${brandErr.message}`);
    res.status(500).json({ error: "Brand fetch failed", detail: brandErr.message });
    return;
  }
  if (!brandKit?.name || !brandKit?.slug) {
    await markFailure(supabase, messageId, 0, "brand_kit_missing");
    res.status(200).json({ ok: true, skipped: "brand_kit_missing" });
    return;
  }

  const planRow = (row as any).plan as { id: string; title: string | null } | null;

  const ctx: MessageContext = {
    message_id: row.id,
    body: row.body,
    created_at: row.created_at,
    tagged_post_plan_id: row.tagged_post_plan_id,
    author_name: author.display_name || "Someone",
    brand_name: brandKit.name,
    brand_slug: brandKit.slug,
    plan_title: planRow?.title ?? null,
    plan_id: planRow?.id ?? null,
  };

  // ---- POST to Slack -------------------------------------------------
  const payload = buildSlackPayload(ctx);

  let slackStatus = 0;
  let slackError: string | null = null;
  try {
    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    slackStatus = slackRes.status;
    if (!slackRes.ok) {
      const responseText = await slackRes.text();
      slackError = responseText.slice(0, 500);
    }
  } catch (e) {
    slackError = (e as Error).message?.slice(0, 500) ?? "fetch_threw";
  }

  // ---- Update log row with outcome -----------------------------------
  const delivered = slackError === null;
  await supabase
    .from("slack_notify_log")
    .update({
      delivered_at: delivered ? new Date().toISOString() : null,
      slack_status: slackStatus,
      slack_error: slackError,
    })
    .eq("message_id", messageId);

  if (!delivered) {
    res.status(502).json({ ok: false, slack_status: slackStatus, slack_error: slackError });
    return;
  }
  res.status(200).json({ ok: true });
}

// =====================================================================
// Log helpers
// =====================================================================

async function markFailure(
  supabase: ReturnType<typeof createClient>,
  messageId: string,
  status: number,
  error: string,
): Promise<void> {
  // Best-effort; never throw from inside the handler's hot path.
  try {
    await supabase
      .from("slack_notify_log")
      .update({
        slack_status: status,
        slack_error: error.slice(0, 500),
      })
      .eq("message_id", messageId);
  } catch {
    // Swallow — logging failure should never block the response.
  }
}
