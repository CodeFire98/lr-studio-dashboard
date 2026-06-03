// =====================================================================
// service_usage_log helper
// =====================================================================
// One-stop logger + cost calculator + quota check for every external-
// service call we make. Backed by `public.service_usage_log` (see
// migration 0051). Designed to be:
//
//   - Fire-and-forget. The logger never throws — if Supabase is down,
//     the hot path continues; we lose the row, that's it. We are NOT
//     building a billing system here.
//   - Cheap. Single INSERT per call, no joins, no SELECT-before-INSERT.
//   - Easy to read. Each cost-calc helper takes named args, the
//     caller doesn't have to know the rate card. Rate cards live as
//     constants at the bottom — update annually.
//
// Wire into a Vercel API route:
//
//   import { logServiceUsage, estimateAnthropicCostUsd } from "../_shared/usage.js";
//   ...
//   await logServiceUsage({
//     service: "anthropic",
//     route: "/api/ai/chat",
//     accountId, userId,
//     tokensIn: result.usage.inputTokens,
//     tokensOut: result.usage.outputTokens,
//     costUsd: estimateAnthropicCostUsd({...}),
//     latencyMs: Date.now() - startedAt,
//     status: "ok",
//     meta: { model: "claude-sonnet-4-6", cache_read_tokens: ..., cache_write_tokens: ... },
//   });
//
// Or for a quota check on the AI chat hot path:
//
//   const quota = await checkBrandAiQuota({ accountId, isAgency: profile.is_agency });
//   if (!quota.allowed) return res.status(429).json({ used: quota.used, remaining: 0, resetsAt: quota.resetsAt });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------- service-role client (singleton per cold start) -----------
// We re-use one client across invocations of the same lambda container
// so we're not constantly reopening connections.
let _serviceClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient | null {
  if (_serviceClient) return _serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}

// ---------- logServiceUsage ------------------------------------------

export type ServiceName = "anthropic" | "firecrawl" | "apify";
export type ServiceStatus = "ok" | "failed" | "blocked";

export interface LogServiceUsageArgs {
  service: ServiceName;
  route: string;
  accountId?: string | null;
  userId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  status: ServiceStatus;
  error?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append a single row to `service_usage_log`. Never throws — on any
 * failure (no env, network blip, Supabase down) we swallow and return.
 *
 * `await` this if you want to ensure ordering for tests, but in the
 * hot path you can call it without awaiting and your route will not
 * be blocked.
 */
export async function logServiceUsage(args: LogServiceUsageArgs): Promise<void> {
  try {
    const client = getServiceClient();
    if (!client) return; // env missing — log nothing, hot path continues
    const error = args.error ? args.error.slice(0, 500) : null;
    await client.from("service_usage_log").insert({
      service: args.service,
      route: args.route,
      account_id: args.accountId ?? null,
      user_id: args.userId ?? null,
      tokens_in: args.tokensIn ?? null,
      tokens_out: args.tokensOut ?? null,
      cost_usd: args.costUsd ?? null,
      latency_ms: args.latencyMs ?? null,
      status: args.status,
      error,
      meta: args.meta ?? {},
    });
  } catch {
    // intentionally swallowed
  }
}

// ---------- Quota check ----------------------------------------------
//
// NOTE: The active per-brand AI quota lives in `web/api/ai/auth-lib.ts`
// (`checkAndRecordAiUsage`), which counts rows in the dedicated
// `ai_usage` table (migration 0051). Day boundary = midnight IST,
// 50 calls / day / brand summed across chat + copy + image +
// suggestions. Agency callers are uncapped (rows still recorded for
// telemetry).
//
// This file (`service_usage_log`, migration 0053) is the wider
// telemetry surface — it carries cost / tokens / latency / status for
// cost reporting and the daily digest. It does NOT enforce the quota.
//
// The usage digest reads `ai_usage` directly for the quota-alerts
// section so the email shows the same numbers the live route enforces.

// ---------- rate cards (update annually) -----------------------------
//
// Reflect best-known pricing as of 2026-05. Historical rows stay
// accurate to the rate we believed at write time — these are point-in-
// time estimates, not source of truth for billing.

// Claude Sonnet 4.6 — Anthropic published pricing per million tokens.
// Cache write is 1.25× input; cache read is 0.1× input.
interface AnthropicRate {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
}

const ANTHROPIC_RATES: Record<string, AnthropicRate> = {
  "claude-sonnet-4-6": {
    inputPerM: 3.0,
    outputPerM: 15.0,
    cacheWritePerM: 3.75,
    cacheReadPerM: 0.3,
  },
  "claude-opus-4-6": {
    inputPerM: 15.0,
    outputPerM: 75.0,
    cacheWritePerM: 18.75,
    cacheReadPerM: 1.5,
  },
  "claude-haiku-4-5": {
    inputPerM: 1.0,
    outputPerM: 5.0,
    cacheWritePerM: 1.25,
    cacheReadPerM: 0.1,
  },
};

export interface EstimateAnthropicCostArgs {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Compute USD cost for an Anthropic call. If the model name isn't in
 * the rate card we fall back to Sonnet 4.6 rates — slightly pessimistic
 * for Haiku but conservative for any new model. Caller is responsible
 * for passing the cache token breakdown when available (it's at
 * `result.usage.inputTokenDetails.cacheReadTokens` in AI SDK v6).
 */
export function estimateAnthropicCostUsd(args: EstimateAnthropicCostArgs): number {
  const rates = ANTHROPIC_RATES[args.model] ?? ANTHROPIC_RATES["claude-sonnet-4-6"];
  const cacheWrite = args.cacheWriteTokens ?? 0;
  const cacheRead = args.cacheReadTokens ?? 0;
  // Fresh input excludes cache reads + writes — those are billed at
  // their own rate. Anthropic returns the fresh-input figure as
  // `inputTokens` already in AI SDK v6, but callers using the raw
  // SDK may need to subtract themselves.
  const freshInput = Math.max(0, args.inputTokens - cacheWrite - cacheRead);
  return (
    (freshInput / 1_000_000) * rates.inputPerM +
    (args.outputTokens / 1_000_000) * rates.outputPerM +
    (cacheWrite / 1_000_000) * rates.cacheWritePerM +
    (cacheRead / 1_000_000) * rates.cacheReadPerM
  );
}

// Firecrawl — flat ~$3 per 1,000 credits on the Standard tier as of
// 2026-05. /scrape = 1 credit, /search = 1 credit per result (default
// limit 5 ≈ 5 credits per call). Caller passes the credit count.
const FIRECRAWL_USD_PER_CREDIT = 3.0 / 1000;

export function estimateFirecrawlCostUsd(credits: number): number {
  return Math.max(0, credits) * FIRECRAWL_USD_PER_CREDIT;
}

// Apify — per-actor, per-result. Memorized from the engagement
// scraper shootout (REFERENCE.md §9, 2026-05-12 / 2026-05-14).
const APIFY_USD_PER_SCRAPE: Record<string, number> = {
  "apify/instagram-scraper": 0.0023,
  "apimaestro/linkedin-post-detail": 0.005, // $5 / 1k results (swapped 2026-06-03)
  "scrape.badger/twitter-tweets-scraper": 0.0002,
};

export function estimateApifyCostUsd(actorId: string, resultCount: number): number {
  const rate = APIFY_USD_PER_SCRAPE[actorId] ?? 0.0023;
  return Math.max(0, resultCount) * rate;
}

// Mirror of the per-brand AI cap enforced by web/api/ai/auth-lib.ts's
// BRAND_DAILY_AI_QUOTA. Re-exported here so the daily digest can show
// "X of 50" without importing across the AI folder. Keep in sync if
// the cap ever changes.
export const AI_QUOTA_PER_BRAND_PER_DAY = 50;
