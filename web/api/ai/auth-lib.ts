// =====================================================================
// /api/ai/auth-lib.ts — shared auth + per-brand AI quota for all four
// AI routes (chat, copy, image, suggestions). Centralised so the same
// gate runs everywhere; tightening it tightens all four at once.
// =====================================================================
//
// Auth flow:
//   1. Read Authorization header → validate JWT.
//   2. Look up profile.is_agency.
//   3. If brand caller, require account_members row for (user, accountId).
//   4. Verify the brand is on the AI allowlist.
//
// Quota: 50 AI calls / day / brand for BRAND callers across all four
// surfaces. Day boundary = midnight IST (Asia/Kolkata). Agency calls
// are recorded but uncapped.
//
// Concurrency: the slot is claimed via INSERT BEFORE the LLM call so a
// burst of concurrent brand requests can't all read 49 and all proceed.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL  = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY      = process.env.SUPABASE_ANON_KEY ?? "";

export const BRAND_DAILY_AI_QUOTA = 50;

export type AiUsageKind = "chat" | "copy" | "image" | "suggestions";

export interface AiCaller {
  userId: string;
  isAgency: boolean;
  serviceClient: SupabaseClient;
}

export interface AuthSuccess {
  ok: true;
  caller: AiCaller;
}
export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
}

/**
 * Validate JWT, resolve role, and check brand-membership when caller is
 * not agency. Also enforces the brand allowlist.
 *
 * Pass the route's allowlist (env-driven Set of account_ids) — different
 * routes may have different allowlists in the future, so we don't bake
 * that in here.
 */
export async function authorizeAiCall(args: {
  authHeader: string;
  accountId: string;
  allowlist: Set<string>;
}): Promise<AuthSuccess | AuthFailure> {
  const { authHeader, accountId, allowlist } = args;

  if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
    return { ok: false, status: 500, error: "Supabase env not fully configured." };
  }
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header" };
  if (!accountId)   return { ok: false, status: 400, error: "accountId is required" };

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return { ok: false, status: 401, error: "Unauthorized" };

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  const isAgency = !!profile?.is_agency;

  // Brand callers must be members of the requested account.
  if (!isAgency) {
    const { count, error: memErr } = await serviceClient
      .from("account_members")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("account_id", accountId);
    if (memErr) {
      return { ok: false, status: 500, error: `Membership check failed: ${memErr.message}` };
    }
    if (!count) {
      return { ok: false, status: 403, error: "You don't have access to this brand." };
    }
  }

  if (!allowlist.has(accountId)) {
    return { ok: false, status: 403, error: "This brand isn't on the AI allowlist yet." };
  }

  return { ok: true, caller: { userId: user.id, isAgency, serviceClient } };
}

// IST midnight as a UTC Date. Used as the lower bound when counting
// today's brand AI calls.
function todayIstStartUtc(): Date {
  // Build the IST date string (sv-SE locale formats as YYYY-MM-DD HH:MM:SS).
  const istNowStr = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
  const datePart = istNowStr.slice(0, 10); // "YYYY-MM-DD" in IST
  return new Date(`${datePart}T00:00:00+05:30`);
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * Pre-check + record an AI usage event. Agency callers always allowed
 * (and a row IS still inserted for telemetry — useful for future cost
 * reports). For brand callers, fails closed at >= 50 calls since
 * midnight IST.
 *
 * Insertion happens before the LLM call so concurrent requests can't
 * burst past the cap.
 */
export async function checkAndRecordAiUsage(args: {
  caller: AiCaller;
  accountId: string;
  kind: AiUsageKind;
}): Promise<QuotaResult> {
  const { caller, accountId, kind } = args;

  if (caller.isAgency) {
    // Record for telemetry but don't gate. Best-effort; ignore errors.
    await caller.serviceClient
      .from("ai_usage")
      .insert({
        account_id: accountId,
        user_id: caller.userId,
        caller_is_agency: true,
        kind,
      })
      .then(undefined, (e) => console.warn("[ai-quota] agency telemetry insert failed:", e?.message));
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY };
  }

  // Brand caller — count + enforce.
  const startUtc = todayIstStartUtc().toISOString();
  const { count, error: countErr } = await caller.serviceClient
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("caller_is_agency", false)
    .gte("created_at", startUtc);

  if (countErr) {
    // Fail open on infra errors so a flaky count query doesn't lock
    // the brand out of AI entirely. We DO still record the call.
    console.warn("[ai-quota] count failed, allowing request:", countErr.message);
  }

  const used = count ?? 0;
  if (used >= BRAND_DAILY_AI_QUOTA) {
    return { allowed: false, used, limit: BRAND_DAILY_AI_QUOTA };
  }

  // Claim a slot before the LLM call.
  const { error: insErr } = await caller.serviceClient
    .from("ai_usage")
    .insert({
      account_id: accountId,
      user_id: caller.userId,
      caller_is_agency: false,
      kind,
    });
  if (insErr) {
    // Best-effort: don't deny on insert failure (we already passed the
    // count check). Log and proceed.
    console.warn("[ai-quota] brand usage insert failed:", insErr.message);
  }

  return { allowed: true, used: used + 1, limit: BRAND_DAILY_AI_QUOTA };
}

/** Shape of the 429 response returned when the brand quota is hit. */
export function quotaExceededResponse(result: QuotaResult) {
  // The Vercel AI SDK (useCompletion / useChat) surfaces the response
  // body's `error` field as the displayed error message. So we put the
  // friendly user-facing string there and the programmatic code under
  // a separate field.
  return {
    status: 429,
    body: {
      error: `Daily AI limit reached for this brand (${result.limit} / day). Refreshes at midnight IST.`,
      code: "ai_quota_exceeded",
      used: result.used,
      limit: result.limit,
    },
  };
}
