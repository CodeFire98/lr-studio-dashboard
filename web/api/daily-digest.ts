// =====================================================================
// /api/daily-digest — Vercel serverless function (cron orchestrator)
//
// Fires from Vercel Cron at 12:30 UTC daily (= 18:00 IST). For every
// brand with `daily_reminder_enabled=true`, queries tomorrow's posts
// (in IST), filters to needs_review + approved (excludes drafting +
// already-posted), bulk-loads thumbnails, resolves recipients via the
// account_members_with_email RPC, and POSTs each brand's payload to
// the send-email edge function (which renders + dispatches via Resend).
//
// "Tomorrow in IST" math:
//   - Cron fires at 12:30 UTC (= 18:00 IST) on day D.
//   - Tomorrow in IST = midnight on day D+1 IST.
//   - Convert that IST midnight back to UTC for the SQL filter:
//       lower bound = day D 18:30 UTC
//       upper bound = day D+1 18:30 UTC
//
// Auth model:
//   - Authorization: Bearer <CRON_SECRET>. Vercel injects this header
//     automatically when CRON_SECRET is set in project env vars.
//     Manual invocations (curl/postman) require passing the same header.
//   - The route uses the Supabase service-role key for all reads — RLS
//     is bypassed because the cron isn't acting as any user. Authz is
//     the bearer-token check above.
//
// Env vars (set in Vercel Project Settings → Environment Variables):
//   CRON_SECRET                  — required, opaque string. Vercel sets
//                                  this automatically when you add it.
//   SUPABASE_URL                 — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — sb_secret_... from Supabase API settings
//   APP_URL                      — base URL for deep links, default
//                                  "https://agency.linkrunner.io"
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APP_URL = process.env.APP_URL ?? "https://agency.linkrunner.io";

// IST is UTC+05:30, no DST. Hardcoded for v1 — every customer is in
// India today. When that changes, replace this with an
// `accounts.timezone` column lookup per brand.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const POST_PLAN_BUCKET = "post-plan-attachments";

// =====================================================================
// Helpers
// =====================================================================

function shortId(uuid: string): string {
  return uuid.length >= 8 ? uuid.slice(0, 8) : uuid;
}

// Compute the [start, end) UTC window for "tomorrow in IST" relative to
// `now`. Tomorrow's start = next IST midnight; tomorrow's end = the
// midnight after that. Returns ISO strings for easy SQL use.
function tomorrowIstWindow(now: Date): { startUtc: string; endUtc: string; istDateLabel: string } {
  // Today's date in IST — shift now by IST offset, then read its date
  // parts as UTC (the offset means IST midnight aligns with a fixed
  // UTC offset).
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const istY = istNow.getUTCFullYear();
  const istM = istNow.getUTCMonth();
  const istD = istNow.getUTCDate();
  // IST midnight tomorrow = (Y, M, D+1) at 00:00 IST = (Y, M, D+1) at -5:30 UTC
  const tomorrowIstMidnightUtcMs = Date.UTC(istY, istM, istD + 1) - IST_OFFSET_MS;
  const dayAfterIstMidnightUtcMs = tomorrowIstMidnightUtcMs + 24 * 60 * 60 * 1000;

  // Friendly label: "Saturday, May 9". Use the IST view of "tomorrow".
  const tomorrowIst = new Date(Date.UTC(istY, istM, istD + 1));
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][tomorrowIst.getUTCDay()];
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][tomorrowIst.getUTCMonth()];
  const day = tomorrowIst.getUTCDate();
  const istDateLabel = `${weekday}, ${month} ${day}`;

  return {
    startUtc: new Date(tomorrowIstMidnightUtcMs).toISOString(),
    endUtc: new Date(dayAfterIstMidnightUtcMs).toISOString(),
    istDateLabel,
  };
}

// Format a UTC scheduled_at as an IST clock string ("9:00 AM" / "6:30 PM").
function formatTimeIst(utcIso: string): string {
  const d = new Date(new Date(utcIso).getTime() + IST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(m).padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}

type Plan = {
  id: string;
  account_id: string;
  scheduled_at: string;
  status: string;
  concept: string | null;
  platforms: string[] | null;
};

type DigestPlanCard = {
  id: string;
  shortId: string;
  concept: string;
  scheduledAtIst: string;
  platforms: string[];
  thumbnailUrl: string | null;
};

type BrandResult = {
  accountId: string;
  brandName: string;
  sent: number;
  failed: number;
  recipients: number;
  needsReview: number;
  approved: number;
  skipReason: string | null;
  skipDetails?: string | null;
};

// =====================================================================
// Per-brand digest pipeline
// =====================================================================

async function digestForBrand(
  client: ReturnType<typeof createClient>,
  brand: { id: string; name: string; slug: string | null },
  windowStartUtc: string,
  windowEndUtc: string,
  istDateLabel: string,
  emailByUserId: Map<string, string>,
): Promise<BrandResult> {
  // 1. Plans scheduled in tomorrow's window (IST), status filter
  const { data: plans, error: plansErr } = await client
    .from("post_plans")
    .select("id, account_id, scheduled_at, status, concept, platforms")
    .eq("account_id", brand.id)
    .gte("scheduled_at", windowStartUtc)
    .lt("scheduled_at", windowEndUtc)
    .in("status", ["needs_review", "approved"]);
  if (plansErr) {
    return mkSkip(brand, "query_failed", `${plansErr.message}`);
  }
  const planRows = (plans ?? []) as Plan[];
  if (planRows.length === 0) {
    return mkSkip(brand, "no_qualifying_plans", null);
  }

  // 2. Exclude plans that already have ≥1 publication row — they're
  // posted, not "tomorrow's heads-up". Single bulk query.
  const planIds = planRows.map((p) => p.id);
  const { data: pubs, error: pubsErr } = await client
    .from("post_plan_publications")
    .select("post_plan_id")
    .in("post_plan_id", planIds);
  if (pubsErr) {
    return mkSkip(brand, "query_failed", `${pubsErr.message}`);
  }
  const postedSet = new Set((pubs ?? []).map((r: { post_plan_id: string }) => r.post_plan_id));
  const unposted = planRows.filter((p) => !postedSet.has(p.id));
  if (unposted.length === 0) {
    return mkSkip(brand, "all_already_posted", null);
  }

  // 3. Bulk-fetch the most recent final attachment per plan for the
  // thumbnail. We sort newest-first inside the result and then pick
  // one per plan client-side — Postgres has DISTINCT ON, but the
  // supabase-js builder doesn't expose it cleanly, so we just over-fetch.
  const { data: finals, error: finalsErr } = await client
    .from("post_plan_attachments")
    .select("post_plan_id, storage_path, mime_type, created_at")
    .eq("kind", "final")
    .in("post_plan_id", unposted.map((p) => p.id))
    .order("created_at", { ascending: false });
  if (finalsErr) {
    // Non-fatal — we just lose the thumbnails on this brand.
    console.warn("[daily-digest] finals query failed", finalsErr.message);
  }
  const thumbByPlan = new Map<string, string>();
  for (const f of (finals ?? []) as Array<{ post_plan_id: string; storage_path: string; mime_type: string | null }>) {
    if (thumbByPlan.has(f.post_plan_id)) continue; // already took the newest
    if (!(f.mime_type ?? "").startsWith("image/")) continue;
    const { data: pub } = client.storage.from(POST_PLAN_BUCKET).getPublicUrl(f.storage_path);
    if (pub?.publicUrl) thumbByPlan.set(f.post_plan_id, pub.publicUrl);
  }

  // 4. Recipients — direct query rather than the
  // `account_members_with_email` RPC. The RPC has an `auth.uid() is null →
  // raise` guard at the top, designed for user-scoped UI calls; the cron
  // runs with service-role + no user JWT, so the RPC would always bail
  // with "must be signed in".
  //
  // PostgREST doesn't expose `auth` schema by default, so we can't
  // cross-schema join from `public.account_members` straight to
  // `auth.users.email`. Instead: pull user_ids from the membership table
  // (RLS-bypassed by service-role), then look up emails from the
  // pre-loaded user-id → email map (built once per cron run via
  // `auth.admin.listUsers()`, see top-level handler).
  const { data: members, error: memErr } = await client
    .from("account_members")
    .select("user_id")
    .eq("account_id", brand.id);
  if (memErr) {
    return mkSkip(brand, "query_failed", `recipients: ${memErr.message}`);
  }
  const recipients: string[] = Array.from(
    new Set(
      ((members as Array<{ user_id: string }> | null) ?? [])
        .map((m) => (emailByUserId.get(m.user_id) ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0 && e.includes("@")),
    ),
  );
  if (recipients.length === 0) {
    return mkSkip(brand, "no_members_with_email", null);
  }

  // 5. Bucket plans, sort each by scheduled_at ascending (so the email
  // reads top-to-bottom morning-to-evening within each section).
  const sortByTime = (a: Plan, b: Plan) => (a.scheduled_at || "").localeCompare(b.scheduled_at || "");
  const toCard = (p: Plan): DigestPlanCard => ({
    id: p.id,
    shortId: shortId(p.id),
    concept: (p.concept ?? "").trim() || "Untitled post",
    scheduledAtIst: formatTimeIst(p.scheduled_at),
    platforms: Array.isArray(p.platforms) ? p.platforms : [],
    thumbnailUrl: thumbByPlan.get(p.id) ?? null,
  });
  const needsReview = unposted.filter((p) => p.status === "needs_review").sort(sortByTime).map(toCard);
  const approved    = unposted.filter((p) => p.status === "approved").sort(sortByTime).map(toCard);

  // 6. POST to the send-email edge function with service-role auth.
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/send-email`;
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template: "daily-digest",
      accountId: brand.id,
      brandName: brand.name,
      brandSlug: brand.slug ?? "",
      tomorrowDateLabel: istDateLabel,
      recipients,
      needsReview,
      approved,
    }),
  });
  const responseText = await res.text();
  let parsed: { ok?: boolean; sent?: number; total?: number; failed?: unknown[]; error?: string; detail?: string } | null = null;
  try { parsed = responseText ? JSON.parse(responseText) : null; } catch { /* leave raw */ }
  if (!res.ok) {
    // Combine error + detail when the edge function returned both — the
    // detail field is what tells us *why* the auth failed (key format
    // mismatch vs role mismatch) without a log dive.
    const err = parsed?.error ?? responseText.slice(0, 200);
    const det = parsed?.detail ? ` — ${parsed.detail}` : "";
    return {
      accountId: brand.id,
      brandName: brand.name,
      sent: 0,
      failed: recipients.length,
      recipients: recipients.length,
      needsReview: needsReview.length,
      approved: approved.length,
      skipReason: `send_failed: ${err}${det}`,
    };
  }
  return {
    accountId: brand.id,
    brandName: brand.name,
    sent: parsed?.sent ?? 0,
    failed: Array.isArray(parsed?.failed) ? parsed.failed.length : 0,
    recipients: recipients.length,
    needsReview: needsReview.length,
    approved: approved.length,
    skipReason: null,
  };
}

function mkSkip(brand: { id: string; name: string }, reason: string, details: string | null): BrandResult {
  return {
    accountId: brand.id,
    brandName: brand.name,
    sent: 0,
    failed: 0,
    recipients: 0,
    needsReview: 0,
    approved: 0,
    skipReason: reason,
    // Surface the underlying error so the cron response is debuggable
    // without digging through Vercel runtime logs. Trimmed to keep the
    // JSON tidy but long enough to include the Postgres error message.
    skipDetails: details ? details.slice(0, 240) : null,
  };
}

// =====================================================================
// Vercel handler
// =====================================================================

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Auth — Vercel auto-sets this header for cron invocations when
  // CRON_SECRET is set. Manual triggers must pass the same header.
  const authHeader = (req.headers.authorization ?? "").trim();
  const expected = `Bearer ${CRON_SECRET}`;
  if (!CRON_SECRET) {
    res.status(500).json({ error: "CRON_SECRET not configured on this deployment" });
    return;
  }
  if (authHeader !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    res.status(500).json({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" });
    return;
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Compute tomorrow-IST window once for this run.
  const now = new Date();
  const { startUtc, endUtc, istDateLabel } = tomorrowIstWindow(now);

  // Pull every brand with the toggle on. Type-filter to brand accounts
  // (not the agency workspace) so the digest never tries to email
  // agency staff in this template — there's a separate agency-side
  // notification flow planned (see REFERENCE.md §14).
  const { data: brands, error: brandsErr } = await client
    .from("accounts")
    .select("id, name, slug, type, daily_reminder_enabled")
    .eq("daily_reminder_enabled", true)
    .eq("type", "brand");
  if (brandsErr) {
    res.status(500).json({ error: `accounts query failed: ${brandsErr.message}` });
    return;
  }
  const brandList = (brands ?? []) as Array<{ id: string; name: string; slug: string | null; type: string }>;

  // Build a Map<user_id, email> once for this run by paginating through
  // auth.admin.listUsers(). PostgREST doesn't expose the `auth` schema,
  // so we can't cross-schema-join from `account_members` → `auth.users`;
  // the admin API is the supported alternative. At our scale (~tens of
  // users) one or two pages cover the entire universe; we cap at 10
  // pages defensively.
  const emailByUserId = new Map<string, string>();
  try {
    const PER_PAGE = 200;
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (error) {
        console.warn("[daily-digest] auth.admin.listUsers failed", error.message);
        break;
      }
      const users = data?.users ?? [];
      for (const u of users) {
        if (u.id && u.email) emailByUserId.set(u.id, u.email);
      }
      if (users.length < PER_PAGE) break;
    }
  } catch (e) {
    console.warn("[daily-digest] failed to load auth users", (e as Error)?.message ?? e);
  }

  const results: BrandResult[] = [];
  for (const brand of brandList) {
    try {
      const r = await digestForBrand(client, brand, startUtc, endUtc, istDateLabel, emailByUserId);
      results.push(r);
    } catch (e) {
      // Don't let one brand's failure abort the rest. Log + continue.
      const msg = (e as Error)?.message ?? String(e);
      console.error("[daily-digest] brand failed", brand.id, msg);
      results.push(mkSkip(brand, "exception", msg));
    }
  }

  const totalSent = results.reduce((acc, r) => acc + r.sent, 0);
  const totalFailed = results.reduce((acc, r) => acc + r.failed, 0);
  res.status(200).json({
    mode: "live",
    runAtUtc: now.toISOString(),
    windowUtc: { start: startUtc, end: endUtc },
    tomorrowIst: istDateLabel,
    brandsConsidered: brandList.length,
    totalSent,
    totalFailed,
    results,
  });
}
