// =====================================================================
// signup-for-invite
//
// Creates an auth user with `email_confirm: true` for an invited
// teammate, skipping Supabase's standard "click the link in your inbox"
// confirmation flow.
//
// The invitation row itself is proof of email ownership — the original
// invite was sent to that address, so requiring a second confirmation
// email is redundant and just adds friction to onboarding.
//
// Auth model:
//   - verify_jwt = false (configured in supabase/config.toml). The caller
//     is the invitee — they don't have a session yet, that's the whole
//     point of this function.
//   - The invitation token is the credential. We require it, look up the
//     row server-side, and only proceed if the invite is unaccepted and
//     unexpired. The email is sourced from the invitation row, never from
//     the request body — so a typo or substitution in the client can't
//     create a user under a different address.
//   - The actual account_members row + accepted_at stamp is left to the
//     existing client-side flow (App.jsx → accept_invitation(token) after
//     signin) so this function stays narrowly scoped to "create the user".
//
// Env vars (auto-injected):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// CORS helpers inlined (rather than importing ../_shared/cors.ts) so the
// function can be deployed via the Management API single-file endpoint
// without needing the eszip multi-file upload path the CLI uses.
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

  let body: { token?: string; password?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const token = body.token?.trim();
  const password = body.password;
  const displayName = body.displayName?.trim();

  if (!token) return jsonResponse({ error: "token is required" }, 400);
  if (!password || password.length < 6) {
    return jsonResponse({ error: "password must be at least 6 characters" }, 400);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Look up the invitation. Service role bypasses RLS, so we can read it
  // even though the caller is unauthenticated.
  const { data: invitation, error: invErr } = await serviceClient
    .from("invitations")
    .select("id, account_id, email, role, token, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle();
  if (invErr) return jsonResponse({ error: invErr.message }, 400);
  if (!invitation) return jsonResponse({ error: "Invitation not found" }, 404);
  if (invitation.accepted_at) {
    return jsonResponse({ error: "Invitation already accepted" }, 410);
  }
  if (new Date(invitation.expires_at as string) <= new Date()) {
    return jsonResponse({ error: "Invitation expired" }, 410);
  }

  const email = (invitation.email as string).trim().toLowerCase();

  // Create the auth user with email already confirmed. This is the whole
  // point of the function — Supabase's normal `signUp` would queue a
  // confirmation email, which we don't want.
  const { data: created, error: createErr } = await serviceClient.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: displayName ? { display_name: displayName } : undefined,
    });

  if (createErr) {
    const msg = (createErr.message || "").toLowerCase();
    if (
      msg.includes("already") ||
      msg.includes("registered") ||
      msg.includes("duplicate")
    ) {
      // Look up the existing user's identity providers so the client can
      // route them correctly. A Google-OAuth-only user has no password
      // identity — telling them to "sign in below" is misleading because
      // signInWithPassword will always fail with "Invalid credentials".
      // We surface the providers so the modal can prompt them to use
      // Continue with Google (or Forgot? to add a password).
      let providers: string[] = [];
      try {
        // listUsers paginates; with our small user set this is fine. If
        // the project ever grows, switch to a SECURITY DEFINER RPC that
        // joins auth.users + auth.identities by email server-side.
        const { data: list } = await serviceClient.auth.admin.listUsers({
          page: 1,
          perPage: 1000,
        });
        const existing = (list?.users || []).find(
          (u) => (u.email || "").toLowerCase() === email,
        );
        providers = ((existing?.identities || []) as Array<{ provider?: string }>)
          .map((i) => i.provider)
          .filter((p): p is string => typeof p === "string");
      } catch { /* leave providers empty — modal falls back to generic copy */ }

      return jsonResponse({
        error: "An account with this email already exists. Sign in to accept the invite.",
        code: "user_exists",
        providers,
      }, 409);
    }
    return jsonResponse({ error: createErr.message || "createUser failed" }, 500);
  }

  return jsonResponse({
    ok: true,
    userId: created.user?.id,
    email,
  });
});
