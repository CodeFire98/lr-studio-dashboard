// =====================================================================
// send-email
//
// Transactional email via Resend. Templates dispatched by `template`.
// Currently supports:
//
//   team-invite — notify a new teammate that they've been invited to a
//   workspace, with the invite link they need to redeem.
//
//   agency-update — agency staff sends a free-form summary message to all
//   members of a brand workspace. Used for "here's a batch of calendar
//   updates" kind of messages so the agency can avoid spamming brands
//   with one email per change.
//
//   daily-digest — automated 6pm-IST email to brand members listing
//   tomorrow's scheduled posts split into "needs your approval" and
//   "ready to ship" buckets. Triggered by the Vercel Cron route at
//   /api/daily-digest, which prepares the payload (queries, joins,
//   thumbnails) and calls this function with a service-role token —
//   so the user-JWT auth path is bypassed for this template only.
//
// Auth model:
//   - Caller's JWT is verified by the platform (verify_jwt = true).
//   - We use a JWT-scoped client to read protected data through RLS so
//     the caller can only trigger emails for things they have access to.
//   - team-invite: caller must be a member of the inviting account.
//   - agency-update: caller must be agency staff (is_agency_user()).
//   - daily-digest: caller must present the service-role bearer token.
//     (The cron route, running on Vercel, holds it. No user JWT.)
//   - The Resend API call itself happens server-side only.
//
// Env vars (set with `supabase secrets set ...`):
//   RESEND_API_KEY           — required, re_... key from resend.com
//   EMAIL_FROM               — sender address, e.g. "agency@linkrunner.io"
//   EMAIL_FROM_NAME          — sender display name, default "L+R Agency"
//   APP_URL                  — base URL for invite links, default
//                              "https://agency.linkrunner.io"
//   SUPABASE_URL             — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected
//   SUPABASE_ANON_KEY        — auto-injected
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "";
const EMAIL_FROM_NAME = Deno.env.get("EMAIL_FROM_NAME") ?? "L+R Agency";
const APP_URL = Deno.env.get("APP_URL") ?? "https://agency.linkrunner.io";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

type TeamInviteRequest = {
  template: "team-invite";
  invitationId: string;
};

type AgencyUpdateRequest = {
  template: "agency-update";
  accountId: string;
  message: string;
  subject?: string;
};

// Daily-digest payload: every field is pre-prepared by the cron route.
// The edge function does NO database lookups for this template — it just
// renders + sends. This keeps the function single-purpose and testable
// (the cron route can be exercised end-to-end with a dry_run flag, the
// renderer can be unit-tested with a static payload).
type DailyDigestPlan = {
  id: string;
  shortId: string;        // first-8 hex chars of the UUID for short URL
  concept: string;
  scheduledAtIst: string; // pre-formatted "9:00 AM" / "6:30 PM" string
  platforms: string[];    // ['instagram', 'linkedin', 'x']
  thumbnailUrl: string | null; // public URL of the first final asset, or null
};

type DailyDigestRequest = {
  template: "daily-digest";
  accountId: string;
  brandName: string;
  brandSlug: string;
  tomorrowDateLabel: string;  // "Saturday, May 9" formatted in IST
  recipients: string[];        // already deduped + lowercased + email-validated
  needsReview: DailyDigestPlan[];
  approved: DailyDigestPlan[];
};

type SendEmailRequest = TeamInviteRequest | AgencyUpdateRequest | DailyDigestRequest;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Decode a JWT's payload (the middle base64url segment) without verifying
// the signature. We use this for the daily-digest service-role check —
// the platform's verify_jwt=true has already validated the signature
// before our function code runs, so we can trust the payload contents.
//
// We avoid a literal-string compare against SUPABASE_SERVICE_ROLE_KEY
// because the same Supabase project may surface the service role under
// two different key formats (legacy JWT `eyJ...` auto-injected into
// edge functions vs. the new `sb_secret_...` style stored on Vercel).
// A role-claim check works regardless of which format the caller used.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    if (pad) b64 += "=".repeat(pad);
    const json = atob(b64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Send N emails in one API call via Resend's /emails/batch endpoint.
// Avoids the 2-req/sec rate limit on the single-send endpoint that was
// silently failing fan-outs of 3+ recipients on the agency-update flow.
// All recipients share subject/html/text/replyTo; only `to` differs.
async function callResendBatch(args: {
  recipients: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}): Promise<{ ids: string[]; failures: Array<{ to: string; error: string }> }> {
  if (args.recipients.length === 0) return { ids: [], failures: [] };
  const fromHeader = EMAIL_FROM_NAME
    ? `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`
    : EMAIL_FROM;
  const items = args.recipients.map((to) => {
    const payload: Record<string, unknown> = {
      from: fromHeader,
      to: [to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    };
    if (args.replyTo) payload.reply_to = args.replyTo;
    return payload;
  });

  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(items),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave raw */ }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message || text || res.statusText;
    // Whole batch failed — every recipient is a failure.
    return {
      ids: [],
      failures: args.recipients.map((to) => ({ to, error: `Resend ${res.status}: ${msg}` })),
    };
  }
  // Resend returns { data: [{ id }, ...] } on success — entry index matches
  // input order. If an item-level error sneaks in we treat it as a
  // per-recipient failure.
  const arr = (data as { data?: Array<{ id?: string; error?: string }> } | null)?.data ?? [];
  const ids: string[] = [];
  const failures: Array<{ to: string; error: string }> = [];
  args.recipients.forEach((to, i) => {
    const entry = arr[i];
    if (entry?.id) ids.push(entry.id);
    else failures.push({ to, error: entry?.error || "Resend returned no id for this recipient" });
  });
  return { ids, failures };
}

async function callResend(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}): Promise<{ id: string }> {
  const fromHeader = EMAIL_FROM_NAME
    ? `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`
    : EMAIL_FROM;
  const payload: Record<string, unknown> = {
    from: fromHeader,
    to: [args.to],
    subject: args.subject,
    html: args.html,
    text: args.text,
  };
  if (args.replyTo) payload.reply_to = args.replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave as raw text */ }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message || text || res.statusText;
    throw new Error(`Resend ${res.status}: ${msg}`);
  }
  return (data as { id: string });
}

function renderTeamInvite(args: {
  accountName: string;
  inviterName: string;
  role: string;
  inviteUrl: string;
}): { subject: string; html: string; text: string } {
  const { accountName, inviterName, role, inviteUrl } = args;
  const roleLabel = role === "owner" ? "a workspace owner" : "a team member";
  const subject = `${inviterName} invited you to ${accountName} on L+R Agency`;
  const text =
    `${inviterName} invited you to join ${accountName} on L+R Agency as ${roleLabel}.\n\n` +
    `Accept your invite: ${inviteUrl}\n\n` +
    `This link expires in 7 days. If you weren't expecting this email you can ignore it.`;
  const safeAccount = escapeHtml(accountName);
  const safeInviter = escapeHtml(inviterName);
  const safeRole = escapeHtml(roleLabel);
  const safeUrl = escapeHtml(inviteUrl);
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f5f2;padding:40px 16px">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;padding:40px 36px;box-shadow:0 1px 2px rgba(0,0,0,0.04)">
            <tr><td>
              <p style="margin:0 0 24px;font-size:13px;letter-spacing:0.10em;text-transform:uppercase;color:#7a7370">L+R Agency</p>
              <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:600;color:#1a1a1a">You're invited to ${safeAccount}</h1>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#454040">${safeInviter} invited you to join <strong>${safeAccount}</strong> as ${safeRole}. Click below to accept and create your account.</p>
              <p style="margin:0 0 32px">
                <a href="${safeUrl}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:500">Accept invite</a>
              </p>
              <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#7a7370">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#7a7370;word-break:break-all">${safeUrl}</a></p>
              <hr style="border:none;border-top:1px solid #ece8e4;margin:32px 0">
              <p style="margin:0;font-size:13px;line-height:1.5;color:#9a9290">This invite expires in 7 days. If you weren't expecting this, you can safely ignore the email.</p>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject, html, text };
}

function renderAgencyUpdate(args: {
  accountName: string;
  senderName: string;
  message: string;
  calendarUrl: string;
  customSubject?: string;
}): { subject: string; html: string; text: string } {
  const { accountName, senderName, message, calendarUrl, customSubject } = args;
  const subject = (customSubject?.trim()) || `Update on ${accountName} from L+R Agency`;
  const text =
    `Hi ${accountName} team,\n\n` +
    `${message}\n\n` +
    `— ${senderName}, L+R Agency\n\n` +
    `Open the Social Calendar: ${calendarUrl}`;

  // Preserve newlines in the user-typed message by converting them to <br>
  // after escaping. Multiple consecutive newlines become paragraph breaks.
  const safeAccount = escapeHtml(accountName);
  const safeSender = escapeHtml(senderName);
  const safeUrl = escapeHtml(calendarUrl);
  const safeMessage = escapeHtml(message)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#1a1a1a;white-space:pre-line">${para}</p>`)
    .join("");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f5f2;padding:40px 16px">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;padding:40px 36px;box-shadow:0 1px 2px rgba(0,0,0,0.04)">
            <tr><td>
              <p style="margin:0 0 24px;font-size:13px;letter-spacing:0.10em;text-transform:uppercase;color:#7a7370">L+R Agency · update for ${safeAccount}</p>
              <h1 style="margin:0 0 24px;font-size:22px;line-height:1.3;font-weight:600;color:#1a1a1a">A note from your agency</h1>
              ${safeMessage}
              <p style="margin:24px 0 32px">
                <a href="${safeUrl}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:500">Open Social Calendar</a>
              </p>
              <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:#454040">— ${safeSender}</p>
              <p style="margin:0;font-size:13px;line-height:1.5;color:#9a9290">L+R Agency</p>
              <hr style="border:none;border-top:1px solid #ece8e4;margin:28px 0">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#9a9290">You're receiving this because you're a member of the ${safeAccount} workspace on L+R Agency. Reply directly to this email to reach ${safeSender}.</p>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject, html, text };
}

async function handleTeamInvite(
  body: TeamInviteRequest,
  userClient: ReturnType<typeof createClient>,
  user: { id: string; email?: string },
): Promise<Response> {
  if (!body.invitationId) {
    return jsonResponse({ error: "invitationId is required" }, 400);
  }

  // RLS-scoped read: the caller can only see invitations for accounts they
  // belong to (per the existing invitations RLS), so this doubles as authz.
  const { data: invitation, error: invErr } = await userClient
    .from("invitations")
    .select("id, account_id, email, role, token, expires_at, accepted_at")
    .eq("id", body.invitationId)
    .maybeSingle();
  if (invErr) return jsonResponse({ error: invErr.message }, 400);
  if (!invitation) return jsonResponse({ error: "Invitation not found or not accessible" }, 404);
  if (invitation.accepted_at) return jsonResponse({ error: "Invitation already accepted" }, 410);

  const { data: account, error: accErr } = await userClient
    .from("accounts")
    .select("id, name")
    .eq("id", invitation.account_id)
    .maybeSingle();
  if (accErr) return jsonResponse({ error: accErr.message }, 400);
  if (!account) return jsonResponse({ error: "Account not accessible to caller" }, 403);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: profile } = await serviceClient
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  const inviterName =
    (profile?.display_name as string | undefined)?.trim() ||
    user.email?.split("@")[0] ||
    "Someone";

  const inviteUrl = `${APP_URL.replace(/\/+$/, "")}/?invite=${invitation.token}`;
  const rendered = renderTeamInvite({
    accountName: account.name as string,
    inviterName,
    role: invitation.role as string,
    inviteUrl,
  });

  try {
    const result = await callResend({
      to: invitation.email as string,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: user.email ?? undefined,
    });
    return jsonResponse({ ok: true, id: result.id });
  } catch (ex) {
    return jsonResponse({ error: (ex as Error).message }, 502);
  }
}

async function handleAgencyUpdate(
  body: AgencyUpdateRequest,
  userClient: ReturnType<typeof createClient>,
  user: { id: string; email?: string },
): Promise<Response> {
  if (!body.accountId) return jsonResponse({ error: "accountId is required" }, 400);
  const message = (body.message ?? "").trim();
  if (!message) return jsonResponse({ error: "message is required" }, 400);
  if (message.length > 8000) return jsonResponse({ error: "message too long (max 8000 chars)" }, 400);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Authz: caller must be agency staff. Read profile via service role so we
  // don't depend on the public profiles SELECT policy.
  const { data: callerProfile, error: profileErr } = await serviceClient
    .from("profiles")
    .select("display_name, is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) return jsonResponse({ error: profileErr.message }, 500);
  if (!callerProfile?.is_agency) {
    return jsonResponse({ error: "agency-update requires agency staff access" }, 403);
  }

  // Account name + slug for subject + calendar link.
  const { data: account, error: accErr } = await serviceClient
    .from("accounts")
    .select("id, name, slug, type")
    .eq("id", body.accountId)
    .maybeSingle();
  if (accErr) return jsonResponse({ error: accErr.message }, 400);
  if (!account) return jsonResponse({ error: "Account not found" }, 404);

  // Recipients via the existing account_members_with_email RPC, called with
  // the JWT-scoped client. The RPC's authz lets agency staff read members
  // for any account, so this works.
  const { data: members, error: memErr } = await userClient.rpc(
    "account_members_with_email",
    { p_account_id: body.accountId },
  );
  if (memErr) return jsonResponse({ error: memErr.message }, 400);
  const recipients: string[] = Array.from(
    new Set(
      (members as Array<{ email: string | null }> | null)
        ?.map((m) => (m.email ?? "").trim().toLowerCase())
        .filter((e) => e && e.includes("@")) ?? [],
    ),
  );
  if (recipients.length === 0) {
    return jsonResponse({ error: "No member emails found for this account" }, 404);
  }

  const senderName =
    (callerProfile.display_name as string | undefined)?.trim() ||
    user.email?.split("@")[0] ||
    "L+R Agency";

  const slug = (account.slug as string | undefined)?.trim();
  const calendarUrl = slug
    ? `${APP_URL.replace(/\/+$/, "")}/c/${slug}/calendar`
    : `${APP_URL.replace(/\/+$/, "")}/calendar`;

  const rendered = renderAgencyUpdate({
    accountName: account.name as string,
    senderName,
    message,
    calendarUrl,
    customSubject: body.subject,
  });

  // Fan out via Resend's batch endpoint — one API call, N recipients,
  // each in their own envelope (members don't see each other's addresses).
  // The previous sequential-send approach hit Resend's 2-req/sec rate limit
  // when a brand had 3+ members and silently dropped sends.
  const { ids: sentIds, failures } = await callResendBatch({
    recipients,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: user.email ?? undefined,
  });

  // Surface counts so the modal can show "sent X of Y" — makes a partial
  // failure obvious instead of looking like everything worked.
  const totalRecipients = recipients.length;

  if (sentIds.length === 0) {
    return jsonResponse({ ok: false, sent: 0, total: totalRecipients, failed: failures }, 502);
  }
  return jsonResponse({
    ok: true,
    sent: sentIds.length,
    total: totalRecipients,
    ids: sentIds,
    failed: failures,
  });
}

// =====================================================================
// daily-digest template
// =====================================================================
//
// Visual approach:
//   - Two stacked sections — "Needs your approval" (mustard yellow accent
//     to match the dashboard's needs_review pill) and "Ready to ship"
//     (green accent for approved). The sections render in that order
//     because action-required goes first.
//   - Each row: 80×80 thumbnail on the left (final asset if uploaded;
//     gradient fallback otherwise), concept + time + platform chips on
//     the right. The whole row is a clickable card linking to the plan
//     detail at /c/<slug>/calendar/<shortId>.
//   - Status pill colours hardcoded to match postPlanShared.jsx
//     (needs_review: #A16207 mustard, approved: --good ~= #16a34a). We
//     don't import them; the email is a separate render path.
//   - Mobile-responsive via max-width:600px + table-based layout. Email
//     clients hate flexbox; tables it is.

const STATUS_COLOURS = {
  needs_review: { tint: "#A16207", bg: "#FEF3C7", label: "Needs review" },
  approved:     { tint: "#15803D", bg: "#DCFCE7", label: "Approved" },
} as const;

const PLATFORM_COLOURS: Record<string, { bg: string; label: string }> = {
  instagram: { bg: "linear-gradient(135deg,#F58529,#DD2A7B,#515BD4)", label: "IG" },
  linkedin:  { bg: "#0A66C2", label: "in" },
  x:         { bg: "#000000", label: "X" },
};

function platformChipsHtml(platforms: string[]): string {
  return platforms
    .map((p) => {
      const cfg = PLATFORM_COLOURS[p];
      if (!cfg) return "";
      // Inline-block 16x16 chip — gradients work in most modern email
      // clients including Gmail web, Apple Mail, iOS Mail. Outlook desktop
      // falls back to the first colour in the gradient (acceptable).
      return `<span style="display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:4px;background:${cfg.bg};color:#ffffff;font-size:9px;font-weight:700;letter-spacing:-0.01em;vertical-align:middle;margin-right:4px">${cfg.label}</span>`;
    })
    .join("");
}

function statusPillHtml(kind: "needs_review" | "approved"): string {
  const c = STATUS_COLOURS[kind];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:${c.bg};color:${c.tint};font-size:11px;font-weight:500;line-height:1.4">${c.label}</span>`;
}

// Fallback thumbnail composition when a plan has no final asset.
// Renders a small platform-icon stack on a neutral background — readable
// at 80×80 and works without external image hosting.
function fallbackThumbHtml(platforms: string[]): string {
  // Keep the first platform's brand colour as the bg; if multiple, we'll
  // just stack the chips in the centre. Gmail's CSS sandbox is tight, so
  // we lean on inline styles + table layout rather than positioning.
  const primary = PLATFORM_COLOURS[platforms[0] || "instagram"];
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="80" height="80" style="width:80px;height:80px;background:#f5efe8;border-radius:8px">
      <tr>
        <td align="center" valign="middle" style="vertical-align:middle">
          <span style="display:inline-block;padding:8px 12px;border-radius:6px;background:${primary?.bg ?? "#f5efe8"};color:#ffffff;font-size:14px;font-weight:700;letter-spacing:-0.01em">${primary?.label ?? "·"}</span>
        </td>
      </tr>
    </table>
  `;
}

function thumbnailHtml(plan: DailyDigestPlan): string {
  if (plan.thumbnailUrl) {
    // 80×80 cropped thumbnail. `object-fit:cover` is well-supported in
    // modern email clients; the wrapping table ensures Outlook (which
    // ignores object-fit) at least centres + clips the image cleanly.
    const safeUrl = escapeHtml(plan.thumbnailUrl);
    return `<img src="${safeUrl}" alt="" width="80" height="80" style="display:block;width:80px;height:80px;object-fit:cover;border-radius:8px;border:0;outline:none;text-decoration:none" />`;
  }
  return fallbackThumbHtml(plan.platforms);
}

function planRowHtml(plan: DailyDigestPlan, planUrl: string, kind: "needs_review" | "approved"): string {
  const safeConcept = escapeHtml(plan.concept || "Untitled post");
  const safeTime = escapeHtml(plan.scheduledAtIst);
  const safeUrl = escapeHtml(planUrl);
  const chips = platformChipsHtml(plan.platforms);
  const pill = statusPillHtml(kind);
  const thumb = thumbnailHtml(plan);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;border:1px solid #ece8e4;border-radius:10px;background:#ffffff">
      <tr>
        <td style="padding:12px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="top" width="80" style="width:80px;padding-right:14px">
                <a href="${safeUrl}" style="text-decoration:none;display:block">${thumb}</a>
              </td>
              <td valign="top">
                <a href="${safeUrl}" style="text-decoration:none;color:#1a1a1a">
                  <div style="font-size:15px;font-weight:600;line-height:1.35;color:#1a1a1a;margin-bottom:6px">${safeConcept}</div>
                </a>
                <div style="font-size:12px;color:#7a7370;margin-bottom:8px;line-height:1.5">
                  <span style="font-weight:500;color:#454040">${safeTime} IST</span>
                  ${plan.platforms.length ? `<span style="margin:0 6px;color:#cfc8c2">·</span>${chips}` : ""}
                </div>
                ${pill}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function renderDailyDigest(args: {
  brandName: string;
  brandSlug: string;
  tomorrowDateLabel: string;
  needsReview: DailyDigestPlan[];
  approved: DailyDigestPlan[];
  appUrl: string;
}): { subject: string; html: string; text: string } {
  const { brandName, brandSlug, tomorrowDateLabel, needsReview, approved, appUrl } = args;
  const totalPlans = needsReview.length + approved.length;
  const reviewCount = needsReview.length;

  // Subject-line variants per the spec.
  const subject = (() => {
    if (totalPlans === 1 && reviewCount === 1) {
      return "Tomorrow's post needs your approval";
    }
    if (totalPlans === 1 && approved.length === 1) {
      const plat = approved[0].platforms[0];
      const platLabel = plat === "instagram" ? "Instagram" : plat === "linkedin" ? "LinkedIn" : plat === "x" ? "X" : "social";
      return `Tomorrow you're posting on ${platLabel}`;
    }
    if (reviewCount > 0) {
      return `Tomorrow's posts · ${reviewCount} need${reviewCount === 1 ? "s" : ""} your approval`;
    }
    return `Tomorrow's ${totalPlans} posts · all approved`;
  })();

  const calendarUrl = `${appUrl.replace(/\/+$/, "")}/c/${brandSlug}/calendar`;
  const settingsUrl = `${appUrl.replace(/\/+$/, "")}/c/${brandSlug}/settings`;
  const planUrl = (p: DailyDigestPlan) =>
    `${appUrl.replace(/\/+$/, "")}/c/${brandSlug}/calendar/${p.shortId}`;

  // Plain-text fallback — every email client has one as a fallback for
  // image-blocking and accessibility. Keep it scannable.
  const textLines: string[] = [];
  textLines.push(`Tomorrow's posts for ${brandName} · ${tomorrowDateLabel}`);
  textLines.push("");
  if (reviewCount > 0) {
    textLines.push(`NEEDS YOUR APPROVAL (${reviewCount}):`);
    for (const p of needsReview) {
      textLines.push(`  • ${p.concept || "Untitled post"} — ${p.scheduledAtIst} IST · ${p.platforms.join(", ")}`);
      textLines.push(`    ${planUrl(p)}`);
    }
    textLines.push("");
  }
  if (approved.length > 0) {
    textLines.push(`READY TO SHIP (${approved.length}):`);
    for (const p of approved) {
      textLines.push(`  • ${p.concept || "Untitled post"} — ${p.scheduledAtIst} IST · ${p.platforms.join(", ")}`);
      textLines.push(`    ${planUrl(p)}`);
    }
    textLines.push("");
  }
  textLines.push(`View full calendar: ${calendarUrl}`);
  textLines.push(`Manage email preferences: ${settingsUrl}`);
  const text = textLines.join("\n");

  const safeBrand = escapeHtml(brandName);
  const safeDate = escapeHtml(tomorrowDateLabel);
  const safeCalendarUrl = escapeHtml(calendarUrl);
  const safeSettingsUrl = escapeHtml(settingsUrl);

  // Section blocks — only render the section if it has rows.
  const reviewSection = reviewCount > 0
    ? `
      <h2 style="margin:0 0 12px;font-size:13px;font-weight:600;color:${STATUS_COLOURS.needs_review.tint};text-transform:uppercase;letter-spacing:0.06em">
        Needs your approval · ${reviewCount}
      </h2>
      <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#7a7370">
        Open each plan to read the copy and click Approve when you're happy with it.
      </p>
      ${needsReview.map((p) => planRowHtml(p, planUrl(p), "needs_review")).join("")}
    `
    : "";

  const approvedSection = approved.length > 0
    ? `
      <h2 style="margin:${reviewCount > 0 ? "32px" : "0"} 0 12px;font-size:13px;font-weight:600;color:${STATUS_COLOURS.approved.tint};text-transform:uppercase;letter-spacing:0.06em">
        Ready to ship · ${approved.length}
      </h2>
      <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#7a7370">
        These are good to go — sharing the heads-up so you know what's hitting your feed.
      </p>
      ${approved.map((p) => planRowHtml(p, planUrl(p), "approved")).join("")}
    `
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f5f2;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#f7f5f2">
            <tr>
              <td>
                <p style="margin:0 0 12px;font-size:13px;letter-spacing:0.10em;text-transform:uppercase;color:#7a7370">
                  L+R Agency · ${safeBrand}
                </p>
                <h1 style="margin:0 0 6px;font-size:26px;line-height:1.25;font-weight:600;color:#1a1a1a">
                  Tomorrow's posts
                </h1>
                <p style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#454040">
                  ${safeDate} · ${totalPlans} post${totalPlans === 1 ? "" : "s"} going live${reviewCount > 0 ? `, <strong>${reviewCount}</strong> still need${reviewCount === 1 ? "s" : ""} your approval` : ""}.
                </p>

                ${reviewSection}
                ${approvedSection}

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0">
                  <tr>
                    <td>
                      <a href="${safeCalendarUrl}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:500">View full calendar</a>
                    </td>
                  </tr>
                </table>

                <hr style="border:none;border-top:1px solid #ece8e4;margin:32px 0 16px">
                <p style="margin:0;font-size:12px;line-height:1.55;color:#9a9290">
                  You're getting this because you're a member of ${safeBrand} on L+R Agency. We send a quick rundown each evening at 6pm IST when posts are scheduled for the next day.
                  <a href="${safeSettingsUrl}" style="color:#7a7370;text-decoration:underline">Manage email preferences</a>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

async function handleDailyDigest(body: DailyDigestRequest): Promise<Response> {
  if (!body.accountId)   return jsonResponse({ error: "accountId is required" }, 400);
  if (!body.brandName)   return jsonResponse({ error: "brandName is required" }, 400);
  if (!body.brandSlug)   return jsonResponse({ error: "brandSlug is required" }, 400);
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return jsonResponse({ error: "recipients[] required" }, 400);
  }
  const totalPlans =
    (Array.isArray(body.needsReview) ? body.needsReview.length : 0) +
    (Array.isArray(body.approved) ? body.approved.length : 0);
  if (totalPlans === 0) {
    // The cron route should already gate this, but second line of defence:
    // never send an empty digest. The promise to the user is "you'll only
    // get this if there's something to know about tomorrow".
    return jsonResponse({ error: "No plans to digest — refusing to send an empty email" }, 400);
  }

  const rendered = renderDailyDigest({
    brandName: body.brandName,
    brandSlug: body.brandSlug,
    tomorrowDateLabel: body.tomorrowDateLabel,
    needsReview: body.needsReview ?? [],
    approved: body.approved ?? [],
    appUrl: APP_URL,
  });

  const { ids, failures } = await callResendBatch({
    recipients: body.recipients,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  const totalRecipients = body.recipients.length;
  if (ids.length === 0) {
    return jsonResponse({ ok: false, sent: 0, total: totalRecipients, failed: failures }, 502);
  }
  return jsonResponse({
    ok: true,
    sent: ids.length,
    total: totalRecipients,
    ids,
    failed: failures,
    subject: rendered.subject,
  });
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  if (!RESEND_API_KEY) {
    return jsonResponse(
      { error: "RESEND_API_KEY not configured. Run: supabase secrets set RESEND_API_KEY=..." },
      500,
    );
  }
  if (!EMAIL_FROM) {
    return jsonResponse(
      { error: "EMAIL_FROM not configured. Run: supabase secrets set EMAIL_FROM=..." },
      500,
    );
  }

  let body: SendEmailRequest;
  try {
    body = (await req.json()) as SendEmailRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  // daily-digest is the only template that runs without a user JWT —
  // it's invoked by the Vercel Cron route, which holds the service-role
  // key. Decode the bearer and check `role: "service_role"` rather than
  // doing a literal string compare against SUPABASE_SERVICE_ROLE_KEY:
  // the same Supabase project may surface the service role under
  // multiple key formats (legacy `eyJ...` auto-injected here vs. the
  // newer `sb_secret_...` stored on Vercel) and a string compare would
  // break across formats. The platform's verify_jwt=true has already
  // validated the signature; we just need to introspect the role claim.
  if (body?.template === "daily-digest") {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const payload = decodeJwtPayload(token);
    if (payload?.role !== "service_role") {
      // Self-diagnosing error so we can tell the difference between the
      // two failure modes from the cron's response JSON without log
      // diving:
      //   * bearer wasn't a JWT at all → likely Vercel has the new
      //     `sb_secret_...` format which doesn't decode here. Caller
      //     needs to switch Vercel's env to the legacy `eyJ...`
      //     service-role JWT.
      //   * bearer decoded but role wasn't service_role → caller used
      //     a user / anon JWT.
      const detail = payload
        ? `got role=${String(payload.role ?? "missing")}`
        : "bearer is not a decodable JWT — likely the new sb_secret_ format. Use the legacy eyJ... service-role JWT for SUPABASE_SERVICE_ROLE_KEY on the cron caller.";
      return jsonResponse(
        { error: "daily-digest requires service-role auth", detail },
        403,
      );
    }
    return handleDailyDigest(body);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (body?.template === "team-invite") {
    return handleTeamInvite(body, userClient, user);
  }
  if (body?.template === "agency-update") {
    return handleAgencyUpdate(body, userClient, user);
  }
  return jsonResponse(
    { error: `Unsupported template: ${(body as { template?: string } | null)?.template ?? "(missing)"}` },
    400,
  );
});
