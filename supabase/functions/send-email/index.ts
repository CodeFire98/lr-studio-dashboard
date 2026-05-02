// =====================================================================
// send-email
//
// Transactional email via Resend. Templates dispatched by `template`.
// Currently supports:
//
//   team-invite — notify a new teammate that they've been invited to a
//   workspace, with the invite link they need to redeem.
//
// Auth model:
//   - Caller's JWT is verified by the platform (verify_jwt = true).
//   - We use a JWT-scoped client to read the invitation through RLS, so
//     the caller can only trigger an email for an invite they have access
//     to (i.e. one they created or one in their account).
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

type SendEmailRequest = TeamInviteRequest;

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

  if (body?.template !== "team-invite") {
    return jsonResponse({ error: `Unsupported template: ${body?.template}` }, 400);
  }
  if (!body.invitationId) {
    return jsonResponse({ error: "invitationId is required" }, 400);
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

  // RLS-scoped read: the caller can only see invitations for accounts they
  // belong to (per the existing invitations RLS), so this check doubles as
  // authorization.
  const { data: invitation, error: invErr } = await userClient
    .from("invitations")
    .select("id, account_id, email, role, token, expires_at, accepted_at")
    .eq("id", body.invitationId)
    .maybeSingle();
  if (invErr) return jsonResponse({ error: invErr.message }, 400);
  if (!invitation) {
    return jsonResponse({ error: "Invitation not found or not accessible" }, 404);
  }
  if (invitation.accepted_at) {
    return jsonResponse({ error: "Invitation already accepted" }, 410);
  }

  // Account name for the email body. RLS lets members SELECT their accounts.
  const { data: account, error: accErr } = await userClient
    .from("accounts")
    .select("id, name")
    .eq("id", invitation.account_id)
    .maybeSingle();
  if (accErr) return jsonResponse({ error: accErr.message }, 400);
  if (!account) {
    return jsonResponse({ error: "Account not accessible to caller" }, 403);
  }

  // Inviter name comes from the caller's profile. Service-role read so we
  // don't have to depend on a profiles SELECT policy that might be tighter
  // than we expect.
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
});
