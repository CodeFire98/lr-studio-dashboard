// =====================================================================
// /api/usage-digest — Vercel serverless function (cron orchestrator)
//
// Fires from Vercel Cron at 02:00 UTC daily (= 07:30 IST). Aggregates
// yesterday's `service_usage_log` rows into a per-service / per-brand
// summary, computes Δ vs the prior 7-day average, surfaces quota
// alerts + errors, then dispatches a single email (multi-recipient,
// BCC-equivalent fanout inside send-email) to every member of the
// agency-type account.
//
// "Yesterday in IST" math:
//   - Cron fires at 02:00 UTC on day D (= 07:30 IST).
//   - Yesterday in IST = the IST day that ended at 00:00 IST today.
//   - Window in UTC = [D-1 18:30 UTC, D 18:30 UTC).
//   - Baseline window = 7 IST-days BEFORE yesterday, for the
//     "Δ vs 7-day avg" comparison on per-service rows.
//
// Why not "rolling last 24h"? Because the email shows a labelled IST
// date and users expect "Tue May 19's spend" to mean the full IST
// day, not "the 24h ending when the cron happened to fire". Aligning
// to IST midnight makes the math reproducible by hand.
//
// Auth model:
//   - Authorization: Bearer <CRON_SECRET>. Vercel injects this header
//     automatically when CRON_SECRET is set in project env vars.
//   - The route uses the Supabase service-role key for all reads —
//     bypasses RLS because the cron isn't acting as any user.
//
// Env vars:
//   CRON_SECRET                  — required, opaque string.
//   SUPABASE_URL                 — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — sb_secret_... from Supabase
//   APP_URL                      — base URL for deep links, default
//                                  "https://agency.linkrunner.io"
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AI_QUOTA_PER_BRAND_PER_DAY } from "./_shared/usage.js";

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APP_URL = process.env.APP_URL ?? "https://agency.linkrunner.io";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// =====================================================================
// Window math
// =====================================================================

function yesterdayIstWindow(now: Date): {
  startUtc: string;
  endUtc: string;
  baselineStartUtc: string;
  baselineEndUtc: string;
  istDateLabel: string;
  istWeekdayLabel: string;
} {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const istY = istNow.getUTCFullYear();
  const istM = istNow.getUTCMonth();
  const istD = istNow.getUTCDate();
  // Today's IST midnight in UTC ms. Yesterday's window is the 24h ending here.
  const todayIstMidnightUtcMs = Date.UTC(istY, istM, istD) - IST_OFFSET_MS;
  const yesterdayStartUtcMs = todayIstMidnightUtcMs - DAY_MS;
  const baselineEndUtcMs = yesterdayStartUtcMs;
  const baselineStartUtcMs = baselineEndUtcMs - 7 * DAY_MS;

  // Friendly label: "Tue May 19, 2026"
  const yesterdayIst = new Date(Date.UTC(istY, istM, istD - 1));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][yesterdayIst.getUTCDay()];
  const weekdayLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    yesterdayIst.getUTCDay()
  ];
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][yesterdayIst.getUTCMonth()];
  const day = yesterdayIst.getUTCDate();
  const year = yesterdayIst.getUTCFullYear();
  return {
    startUtc: new Date(yesterdayStartUtcMs).toISOString(),
    endUtc: new Date(todayIstMidnightUtcMs).toISOString(),
    baselineStartUtc: new Date(baselineStartUtcMs).toISOString(),
    baselineEndUtc: new Date(baselineEndUtcMs).toISOString(),
    istDateLabel: `${weekday} ${month} ${day}, ${year}`,
    istWeekdayLabel: weekdayLong,
  };
}

// =====================================================================
// Types — match the payload shape the send-email template expects
// =====================================================================

type ServiceName = "anthropic" | "firecrawl" | "apify";

interface ServiceTotal {
  service: ServiceName;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  baselineDailyAvgCostUsd: number | null; // null when insufficient history
}

interface BrandTotal {
  accountId: string;
  brandName: string | null;
  calls: number;
  costUsd: number;
  // True when the brand has zero spend in the baseline window — i.e.
  // first appearance today. Surfaces as "first day" annotation.
  firstDay: boolean;
}

interface QuotaAlert {
  accountId: string;
  brandName: string | null;
  used: number;
  cap: number;
  percent: number;
}

interface ErrorGroup {
  service: ServiceName;
  route: string;
  count: number;
  exampleError: string | null;
}

// =====================================================================
// Aggregation
// =====================================================================

type UsageRow = {
  service: ServiceName;
  route: string;
  account_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  status: "ok" | "failed" | "blocked";
  error: string | null;
};

function aggregateTotals(rows: UsageRow[]): {
  totalCalls: number;
  totalCostUsd: number;
  perService: Map<ServiceName, ServiceTotal>;
  perAccount: Map<string, BrandTotal>;
  activeAccountIds: Set<string>;
} {
  const perService = new Map<ServiceName, ServiceTotal>();
  const perAccount = new Map<string, BrandTotal>();
  const activeAccountIds = new Set<string>();
  let totalCalls = 0;
  let totalCostUsd = 0;

  for (const r of rows) {
    const cost = Number(r.cost_usd ?? 0);
    totalCalls += 1;
    totalCostUsd += cost;

    let s = perService.get(r.service);
    if (!s) {
      s = {
        service: r.service,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        baselineDailyAvgCostUsd: null,
      };
      perService.set(r.service, s);
    }
    s.calls += 1;
    s.tokensIn += r.tokens_in ?? 0;
    s.tokensOut += r.tokens_out ?? 0;
    s.costUsd += cost;

    if (r.account_id) {
      activeAccountIds.add(r.account_id);
      let a = perAccount.get(r.account_id);
      if (!a) {
        a = {
          accountId: r.account_id,
          brandName: null,
          calls: 0,
          costUsd: 0,
          firstDay: false,
        };
        perAccount.set(r.account_id, a);
      }
      a.calls += 1;
      a.costUsd += cost;
    }
  }

  return { totalCalls, totalCostUsd, perService, perAccount, activeAccountIds };
}

function aggregateBaselineCostsPerService(rows: UsageRow[]): Map<ServiceName, number> {
  const m = new Map<ServiceName, number>();
  for (const r of rows) {
    m.set(r.service, (m.get(r.service) ?? 0) + Number(r.cost_usd ?? 0));
  }
  return m;
}

function aggregateBaselineCostPerAccount(rows: UsageRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.account_id) continue;
    m.set(r.account_id, (m.get(r.account_id) ?? 0) + Number(r.cost_usd ?? 0));
  }
  return m;
}

// Quota usage now comes from the dedicated `ai_usage` table (migration
// 0051, owned by web/api/ai/auth-lib.ts). That's the table the live
// route counts against — the email must show the same number a user
// experiences in-app. We query it separately in the handler since the
// shape differs from `service_usage_log`.
type AiUsageRow = {
  account_id: string;
  caller_is_agency: boolean;
};

function aggregateQuotaUsage(aiRows: AiUsageRow[]): Map<string, number> {
  // The live cap is per-brand (sum of brand-caller rows only). Agency
  // rows in `ai_usage` are recorded for telemetry but don't count
  // toward the quota, so we exclude them here too.
  const m = new Map<string, number>();
  for (const r of aiRows) {
    if (r.caller_is_agency) continue;
    if (!r.account_id) continue;
    m.set(r.account_id, (m.get(r.account_id) ?? 0) + 1);
  }
  return m;
}

function aggregateErrors(rows: UsageRow[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const r of rows) {
    if (r.status === "ok") continue;
    const key = `${r.service}|${r.route}`;
    let g = groups.get(key);
    if (!g) {
      g = { service: r.service, route: r.route, count: 0, exampleError: null };
      groups.set(key, g);
    }
    g.count += 1;
    if (!g.exampleError && r.error) g.exampleError = r.error;
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

// =====================================================================
// Handler
// =====================================================================

interface DigestPayload {
  istDateLabel: string;
  istWeekdayLabel: string;
  windowStartUtc: string;
  windowEndUtc: string;
  totals: {
    cost: number;
    calls: number;
    activeBrands: number;
    totalBrands: number;
    vsBaselineDailyAvgPct: number | null;
  };
  services: ServiceTotal[];
  topBrands: BrandTotal[];
  alerts: QuotaAlert[];
  errors: ErrorGroup[];
  recipients: string[];
  appUrl: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const authHeader = (req.headers.authorization ?? "").trim();
  if (!CRON_SECRET) {
    res.status(500).json({ error: "CRON_SECRET not configured" });
    return;
  }
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    res.status(500).json({ error: "SUPABASE env not fully configured" });
    return;
  }

  const client: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();
  const win = yesterdayIstWindow(now);

  // --- Yesterday's rows ----------------------------------------------
  const { data: rowsRaw, error: rowsErr } = await client
    .from("service_usage_log")
    .select("service, route, account_id, tokens_in, tokens_out, cost_usd, status, error")
    .gte("created_at", win.startUtc)
    .lt("created_at", win.endUtc);
  if (rowsErr) {
    res.status(500).json({ error: `service_usage_log query failed: ${rowsErr.message}` });
    return;
  }
  const rows = (rowsRaw ?? []) as UsageRow[];

  // --- Baseline 7-day rows -------------------------------------------
  const { data: baselineRaw, error: baselineErr } = await client
    .from("service_usage_log")
    .select("service, route, account_id, tokens_in, tokens_out, cost_usd, status, error")
    .gte("created_at", win.baselineStartUtc)
    .lt("created_at", win.baselineEndUtc);
  if (baselineErr) {
    res.status(500).json({ error: `baseline query failed: ${baselineErr.message}` });
    return;
  }
  const baselineRows = (baselineRaw ?? []) as UsageRow[];

  // --- AI quota usage (yesterday's IST-day window from `ai_usage`) ----
  // Their `ai_usage` table is the source of truth for the live quota
  // enforced by web/api/ai/auth-lib.ts. We read the same window so the
  // alerts section in the email matches what users actually hit.
  const { data: aiRowsRaw, error: aiErr } = await client
    .from("ai_usage")
    .select("account_id, caller_is_agency")
    .gte("created_at", win.startUtc)
    .lt("created_at", win.endUtc);
  if (aiErr) {
    res.status(500).json({ error: `ai_usage query failed: ${aiErr.message}` });
    return;
  }
  const aiRows = (aiRowsRaw ?? []) as AiUsageRow[];

  // --- Aggregate ------------------------------------------------------
  const today = aggregateTotals(rows);
  const baselineByService = aggregateBaselineCostsPerService(baselineRows);
  const baselineByAccount = aggregateBaselineCostPerAccount(baselineRows);
  const quotaByAccount = aggregateQuotaUsage(aiRows);
  const errors = aggregateErrors(rows);

  // Brand-name lookup for active + alerting accounts.
  const brandIdsToName = new Set<string>([
    ...today.activeAccountIds,
    ...Array.from(quotaByAccount.keys()),
  ]);
  const nameByAccount = new Map<string, string | null>();
  if (brandIdsToName.size > 0) {
    const { data: nameRows } = await client
      .from("accounts")
      .select("id, name")
      .in("id", Array.from(brandIdsToName));
    for (const row of (nameRows ?? []) as Array<{ id: string; name: string | null }>) {
      nameByAccount.set(row.id, row.name ?? null);
    }
  }

  // Total brand count for the "active 8 of 12" snapshot tile.
  const { count: totalBrandCount } = await client
    .from("accounts")
    .select("id", { count: "exact", head: true })
    .eq("type", "brand");

  // Decorate service totals with baseline-daily-avg.
  for (const s of today.perService.values()) {
    const baselineCost = baselineByService.get(s.service) ?? 0;
    s.baselineDailyAvgCostUsd =
      baselineRows.length === 0 ? null : baselineCost / 7;
  }

  // Top 5 brands by cost (decorated with names + first-day flag).
  const topBrands: BrandTotal[] = Array.from(today.perAccount.values())
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5)
    .map((b) => ({
      ...b,
      brandName: nameByAccount.get(b.accountId) ?? null,
      firstDay: (baselineByAccount.get(b.accountId) ?? 0) === 0,
    }));

  // Quota alerts — any brand at ≥80% of the cap.
  const alerts: QuotaAlert[] = [];
  for (const [accountId, used] of quotaByAccount.entries()) {
    const percent = (used / AI_QUOTA_PER_BRAND_PER_DAY) * 100;
    if (percent >= 80) {
      alerts.push({
        accountId,
        brandName: nameByAccount.get(accountId) ?? null,
        used,
        cap: AI_QUOTA_PER_BRAND_PER_DAY,
        percent: Math.round(percent),
      });
    }
  }
  alerts.sort((a, b) => b.percent - a.percent);

  // Day-over-7d spend delta for the snapshot tile.
  const baselineTotalCost = baselineRows.reduce(
    (sum, r) => sum + Number(r.cost_usd ?? 0),
    0,
  );
  const baselineDailyAvg = baselineRows.length === 0 ? null : baselineTotalCost / 7;
  const vsBaselineDailyAvgPct =
    baselineDailyAvg === null || baselineDailyAvg === 0
      ? null
      : Math.round(((today.totalCostUsd - baselineDailyAvg) / baselineDailyAvg) * 100);

  // --- Recipients: every member of the agency account -----------------
  // Same auth.admin.listUsers pattern as /api/daily-digest (the RPC
  // refuses service-role callers — auth.uid() is null).
  const { data: agencyRow } = await client
    .from("accounts")
    .select("id, name")
    .eq("type", "agency")
    .maybeSingle();
  const recipients: string[] = [];
  if (agencyRow?.id) {
    const { data: members } = await client
      .from("account_members")
      .select("user_id")
      .eq("account_id", agencyRow.id);
    const userIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
    if (userIds.length > 0) {
      const emailByUserId = new Map<string, string>();
      const PER_PAGE = 200;
      for (let page = 1; page <= 10; page++) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage: PER_PAGE });
        if (error) break;
        for (const u of data?.users ?? []) {
          if (u.id && u.email) emailByUserId.set(u.id, u.email);
        }
        if ((data?.users ?? []).length < PER_PAGE) break;
      }
      for (const uid of userIds) {
        const email = (emailByUserId.get(uid) ?? "").trim().toLowerCase();
        if (email && email.includes("@") && !recipients.includes(email)) {
          recipients.push(email);
        }
      }
    }
  }

  const payload: DigestPayload = {
    istDateLabel: win.istDateLabel,
    istWeekdayLabel: win.istWeekdayLabel,
    windowStartUtc: win.startUtc,
    windowEndUtc: win.endUtc,
    totals: {
      cost: today.totalCostUsd,
      calls: today.totalCalls,
      activeBrands: today.activeAccountIds.size,
      totalBrands: totalBrandCount ?? 0,
      vsBaselineDailyAvgPct,
    },
    services: Array.from(today.perService.values()).sort((a, b) => b.costUsd - a.costUsd),
    topBrands,
    alerts,
    errors,
    recipients,
    appUrl: APP_URL,
  };

  // --- Dispatch -------------------------------------------------------
  if (recipients.length === 0) {
    res.status(200).json({
      ok: true,
      skipped: "no_agency_recipients",
      payload: { ...payload, recipients: [] },
    });
    return;
  }

  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/send-email`;
  const sendRes = await fetch(fnUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template: "service-usage-daily",
      ...payload,
    }),
  });
  const sendBody = await sendRes.text();
  let parsed: { ok?: boolean; sent?: number; error?: string; detail?: string } | null = null;
  try {
    parsed = sendBody ? JSON.parse(sendBody) : null;
  } catch {
    /* leave raw */
  }
  if (!sendRes.ok) {
    res.status(502).json({
      ok: false,
      error: parsed?.error ?? sendBody.slice(0, 240),
      detail: parsed?.detail ?? null,
      payload,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    sent: parsed?.sent ?? recipients.length,
    payload,
  });
}
