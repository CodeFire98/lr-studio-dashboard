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
// Auth model:
//   - Caller's JWT is verified by the platform (verify_jwt = true).
//   - We use a JWT-scoped client to read protected data through RLS so
//     the caller can only trigger emails for things they have access to.
//   - team-invite: caller must be a member of the inviting account.
//   - agency-update: caller must be agency staff (is_agency_user()).
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

type SendEmailRequest = TeamInviteRequest | AgencyUpdateRequest;

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
