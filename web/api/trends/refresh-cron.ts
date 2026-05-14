// =====================================================================
// /api/trends/refresh-cron — Vercel Cron, daily brand-trend snapshots
// =====================================================================
//
// Fires once daily (Hobby cron limit — see vercel.json `30 0 * * *` =
// 06:00 IST). For each brand on the AI_COPILOT_BRAND_IDS allowlist,
// it hits Firecrawl /search with two queries and writes the top
// results into `brand_trend_snapshots`. The brand-context compiler
// reads the latest snapshots per brand into the system prompt as
// `## Industry signals (last 24h)` so the AI Co-pilot can lead with
// what's trending without paying per-call for a Firecrawl search.
//
// Two queries per brand (kept narrow so Firecrawl spend is predictable):
//
//   1. Industry trends — `${industry} trends ${year}`
//   2. Hashtag pulse   — first 3 tracked hashtags joined with the
//                        industry as a multi-keyword query
//
// At ~1 credit per /search call, 2 calls × N brands = 2N credits/day.
// One allowlisted brand right now → ~60 credits/month. Negligible.
//
// Auth: Authorization: Bearer <CRON_SECRET>. Same pattern as
// /api/daily-digest and /api/engagement/refresh-cron — Vercel injects
// the header for cron invocations when CRON_SECRET is set. Manual curl
// invocations must pass the same header.
//
// On the brand-allowlist boundary: we scope the cron to brands in
// AI_COPILOT_BRAND_IDS specifically (not "all brands") because:
//   - Snapshots only get USED by the AI Co-pilot
//   - Allowlisted brands are the ones that pay Firecrawl in proportion
//     to the value they get
// When the Co-pilot rolls out to all brands, drop the allowlist filter.
//
// Failures: a per-brand error is logged but doesn't abort the run —
// the loop continues to the next brand. Snapshot rows always get
// inserted (even on partial/failed) with `scrape_status` set
// accordingly so the brand-context loader can decide whether to surface
// them.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";

const WHITELIST = (process.env.AI_COPILOT_BRAND_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RESULTS_PER_QUERY = 5;
const MAX_HASHTAGS_IN_QUERY = 3;

type FirecrawlSearchResult = {
  url?: string;
  title?: string;
  description?: string;
  publishedDate?: string;
  publishedAt?: string;
  [k: string]: unknown;
};

async function firecrawlSearch(
  query: string,
): Promise<{ ok: boolean; results: FirecrawlSearchResult[]; error?: string; raw?: unknown }> {
  let res: Response;
  try {
    res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        limit: RESULTS_PER_QUERY,
      }),
    });
  } catch (ex) {
    return { ok: false, results: [], error: `firecrawl network: ${(ex as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, results: [], error: `firecrawl ${res.status}: ${text.slice(0, 300)}` };
  }
  let json: { success?: boolean; data?: { web?: FirecrawlSearchResult[]; news?: FirecrawlSearchResult[] } | FirecrawlSearchResult[] };
  try {
    json = await res.json();
  } catch (ex) {
    return { ok: false, results: [], error: `firecrawl json parse: ${(ex as Error).message}` };
  }
  // Firecrawl v2/search returns `data.web[]` and optionally `data.news[]`.
  // Flatten both into a single list — for trend awareness we care about
  // both editorial articles and news pieces, and dedupe by URL.
  const data = json.data;
  let merged: FirecrawlSearchResult[] = [];
  if (Array.isArray(data)) {
    merged = data;
  } else if (data && typeof data === "object") {
    merged = [...(data.web ?? []), ...(data.news ?? [])];
  }
  return { ok: true, results: merged, raw: json };
}

function buildQueries(brandKit: {
  industry?: string | null;
  trend_hashtags?: string[] | null;
}): string[] {
  const year = new Date().getUTCFullYear();
  const queries: string[] = [];
  const industry = (brandKit.industry || "").trim();
  if (industry) {
    queries.push(`${industry} trends ${year}`);
  }
  const tags = (brandKit.trend_hashtags || [])
    .map((t) => String(t || "").replace(/^#/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_HASHTAGS_IN_QUERY);
  if (tags.length) {
    const hashtagQuery = industry
      ? `${industry} ${tags.join(" ")}`
      : tags.join(" ");
    queries.push(hashtagQuery);
  }
  if (!queries.length) {
    // Fallback: brand name. Not ideal (low signal) but better than
    // nothing for brands without industry / hashtags configured yet.
    queries.push("marketing trends 2026");
  }
  return queries;
}

type BrandRow = {
  account_id: string;
  industry: string | null;
  trend_hashtags: string[] | null;
  account: { name: string | null } | null;
};

async function refreshBrand(
  serviceClient: ReturnType<typeof createClient>,
  brand: BrandRow,
): Promise<{ inserted: number; queriesFired: number; error?: string }> {
  const queries = buildQueries(brand);
  let totalInserted = 0;
  let queriesFired = 0;
  const seenUrls = new Set<string>();

  for (const query of queries) {
    queriesFired += 1;
    const result = await firecrawlSearch(query);
    const status = result.ok ? "ok" : "failed";

    if (!result.ok) {
      // One row marking the failure so the brand-context loader can
      // surface "no fresh data" if needed. error_message helps debugging.
      await serviceClient.from("brand_trend_snapshots").insert({
        account_id: brand.account_id,
        query,
        source: "firecrawl",
        scrape_status: "failed",
        error_message: (result.error || "unknown").slice(0, 500),
        raw_payload: null,
      });
      continue;
    }

    const rowsToInsert = [];
    for (const hit of result.results) {
      const url = typeof hit.url === "string" ? hit.url.trim() : "";
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const publishedRaw = (hit as { publishedDate?: string }).publishedDate ?? (hit as { publishedAt?: string }).publishedAt ?? null;
      const publishedAt = publishedRaw ? new Date(publishedRaw).toISOString() : null;
      rowsToInsert.push({
        account_id: brand.account_id,
        query,
        source: "firecrawl",
        scrape_status: status,
        source_url: url,
        title: typeof hit.title === "string" ? hit.title.slice(0, 400) : null,
        summary: typeof hit.description === "string" ? hit.description.slice(0, 1200) : null,
        published_at: publishedAt,
        raw_payload: hit as unknown as Record<string, unknown>,
      });
    }

    if (rowsToInsert.length) {
      const { error: insertErr } = await serviceClient.from("brand_trend_snapshots").insert(rowsToInsert);
      if (insertErr) {
        return { inserted: totalInserted, queriesFired, error: `insert failed: ${insertErr.message}` };
      }
      totalInserted += rowsToInsert.length;
    }
  }

  return { inserted: totalInserted, queriesFired };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET or POST required" });
  }

  if (!CRON_SECRET || !SUPABASE_URL || !SERVICE_ROLE || !FIRECRAWL_API_KEY) {
    return res.status(500).json({
      error:
        "Missing env. Need CRON_SECRET + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + FIRECRAWL_API_KEY.",
    });
  }

  const auth = (req.headers["authorization"] as string | undefined) ?? "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!WHITELIST.length) {
    return res.status(200).json({
      ok: true,
      message: "No brands in AI_COPILOT_BRAND_IDS — nothing to refresh.",
      brands_processed: 0,
    });
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Load brand kits for every whitelisted brand. brand_kits has its own
  // account_id FK (1:1 with accounts) so the IN-clause filter is exact.
  const { data: brandRows, error: brandErr } = await serviceClient
    .from("brand_kits")
    .select("account_id, industry, trend_hashtags, account:accounts(name)")
    .in("account_id", WHITELIST);

  if (brandErr) {
    return res.status(500).json({ error: `failed to load brand kits: ${brandErr.message}` });
  }

  const summary: Array<{
    account_id: string;
    name: string | null;
    inserted: number;
    queries_fired: number;
    error?: string;
  }> = [];

  for (const brand of (brandRows || []) as BrandRow[]) {
    try {
      const r = await refreshBrand(serviceClient, brand);
      summary.push({
        account_id: brand.account_id,
        name: brand.account?.name ?? null,
        inserted: r.inserted,
        queries_fired: r.queriesFired,
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : String(ex);
      summary.push({
        account_id: brand.account_id,
        name: brand.account?.name ?? null,
        inserted: 0,
        queries_fired: 0,
        error: msg,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    brands_processed: summary.length,
    summary,
  });
}
