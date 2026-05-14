// =====================================================================
// /api/engagement/refresh-cron — Vercel Cron orchestrator
//
// Fires once daily at 1am UTC (`0 1 * * *` in vercel.json). For
// every publication on a supported platform with a live_url, decides
// whether the publication is "due for refresh" using a tiered
// cadence keyed off the publication's age + the latest snapshot's
// fetched_at. Due publications get scraped in batches and the
// snapshots + embed cache are written through `_shared.ts` helpers.
//
// **Why daily (not every 6h as originally planned).** Vercel Hobby
// caps cron jobs at "once per day max" per project. The original
// 6h schedule (`0 */6 * * *`) violated this and made the entire
// deployment fail (Vercel build rejects cron schedules that exceed
// plan limits — surfaced as "Deployment failed" with the cron-
// pricing docs page on click-through). Daily is what Hobby allows;
// to fire more often we'd need Vercel Pro ($20/mo). For MVP-scale
// the daily cadence is fine — the on-paste auto-refresh already
// captures the initial scrape, and the cron is for keeping numbers
// fresh over the multi-day curve.
//
// Why a cron at all (the user already has on-paste auto-refresh):
//   - Engagement numbers grow over hours/days; the first scrape
//     captures the initial state but doesn't track the curve.
//   - Monthly reports (PR 8) read deltas between first-of-month and
//     last-of-month snapshots. Without a cron, the snapshots table
//     only has one row per publication and there's nothing to delta.
//
// Tiered cadence (keyed on time-since-publication, NOT time-since-
// last-scrape — so a long-overdue publication catches up to the right
// tier instead of being stuck in the most-frequent one):
//   0-14 days after publication  → refresh daily (every cron fire)
//   15-60 days                   → every 3 days
//   60+ days                     → weekly
//   3+ consecutive failures      → demoted to weekly
//
// Batching: the route is bounded by Vercel's function timeout
// (60s on Pro). One IG scrape is ~7-12s, LinkedIn ~7-10s. We cap
// at 5 scrapes per run to stay safely inside the budget with
// headroom for DB writes. Anything past the cap waits for the next
// 6h fire. At full rollout (10 brands × 100 posts = 1000 publications,
// ~150 due/day at the steady-state cadence), 5 scrapes/run × 4 runs/day
// = 20 scrapes/day — well below the 150 throughput need.
//
// **TODO when scale demands**: switch to a job-queue model (qstash /
// supabase-queues / a publication_id round-robin column on the
// snapshots table) so the cron can hand off more work per fire.
// 5-per-run is intentional MVP simplicity, not a permanent ceiling.
//
// Auth: Authorization: Bearer <CRON_SECRET>. Same pattern as
// /api/daily-digest — Vercel injects the header for cron invocations
// when CRON_SECRET is set in project env. Manual curl invocations
// must pass the same header.
//
// X publications are intentionally never scraped here (dispatch
// returns null for X; the cron skips them silently).
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { dispatchScrape, persistScrapeResult, type Platform } from "./scraper-lib";

const CRON_SECRET     = process.env.CRON_SECRET ?? "";
const SUPABASE_URL    = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE    = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// Per-run scrape budget. See file header — kept small so a single
// 60s Vercel function can finish well inside the budget.
const MAX_SCRAPES_PER_RUN = 5;

// Cadence tiers (ms). The route picks the tier based on time-since-
// publication, then the publication is "due" iff time-since-latest-
// snapshot exceeds the tier's interval.
//
// Sub-day tiers are pointless on Hobby (the cron fires once a day),
// so the youngest tier is 1 day. If/when we upgrade to Pro and run
// the cron every 4-6 hours, add a `< TWO_DAYS → SIX_HOURS` tier
// at the top so new posts get sampled multiple times in their first
// 48h to capture the early engagement curve.
const ONE_DAY    = 24 * 60 * 60 * 1000;
const TWO_WEEKS  = 14 * ONE_DAY;
const SIXTY_DAYS = 60 * ONE_DAY;
const THREE_DAYS = 3 * ONE_DAY;
const ONE_WEEK   = 7 * ONE_DAY;

function refreshIntervalForAge(ageMs: number): number {
  if (ageMs < TWO_WEEKS)  return ONE_DAY;
  if (ageMs < SIXTY_DAYS) return THREE_DAYS;
  return ONE_WEEK;
}

type PubRow = {
  id: string;
  platform: Platform;
  live_url: string | null;
  published_at: string;
};

type SnapshotMini = {
  publication_id: string;
  fetched_at: string;
  scrape_status: "ok" | "partial" | "failed" | "blocked";
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // ----- AUTH -----
  if (!CRON_SECRET) {
    res.status(500).json({ error: "CRON_SECRET not configured on this deployment" });
    return;
  }
  const authHeader = (req.headers.authorization ?? "").trim();
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    res.status(500).json({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" });
    return;
  }
  if (!APIFY_API_TOKEN) {
    res.status(500).json({ error: "APIFY_API_TOKEN not configured" });
    return;
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ----- LOAD eligible publications -----
  // We only schedule scrapes for platforms with viable actors and a
  // pasted URL. The DB doesn't track "next scrape due" — we derive
  // it in JS from publication age + latest snapshot.
  // X was re-enabled 2026-05-14 via scrape.badger; add new platforms
  // here as their actors land in `_shared.ts`.
  const { data: pubs, error: pubErr } = await client
    .from("post_plan_publications")
    .select("id, platform, live_url, published_at")
    .in("platform", ["instagram", "linkedin", "x"])
    .not("live_url", "is", null);
  if (pubErr) {
    res.status(500).json({ error: `Load publications failed: ${pubErr.message}` });
    return;
  }
  const publications = (pubs as PubRow[]) ?? [];

  if (publications.length === 0) {
    res.status(200).json({
      ok: true,
      processed: 0,
      due: 0,
      total_eligible: 0,
      message: "No publications eligible for scraping.",
    });
    return;
  }

  // ----- LOAD latest snapshot per publication + recent-failure tally -----
  // Single round trip; ordered desc so the first hit per publication
  // is the latest. Failure tally uses the last 3 rows to know whether
  // to demote to weekly.
  const ids = publications.map((p) => p.id);
  const { data: snapsRaw, error: snapErr } = await client
    .from("post_engagement_snapshots")
    .select("publication_id, fetched_at, scrape_status")
    .in("publication_id", ids)
    .order("fetched_at", { ascending: false });
  if (snapErr) {
    res.status(500).json({ error: `Load snapshots failed: ${snapErr.message}` });
    return;
  }

  const latestByPub = new Map<string, SnapshotMini>();
  const last3StatusesByPub = new Map<string, string[]>();
  for (const row of (snapsRaw as SnapshotMini[]) ?? []) {
    if (!latestByPub.has(row.publication_id)) {
      latestByPub.set(row.publication_id, row);
    }
    const list = last3StatusesByPub.get(row.publication_id) ?? [];
    if (list.length < 3) {
      list.push(row.scrape_status);
      last3StatusesByPub.set(row.publication_id, list);
    }
  }

  // ----- DECIDE which publications are due -----
  const now = Date.now();
  type DueEntry = {
    pub: PubRow;
    reason: string;
    ageMs: number;
    lastFetchedAt: string | null;
    intervalMs: number;
  };
  const due: DueEntry[] = [];

  for (const pub of publications) {
    const publishedAtMs = new Date(pub.published_at).getTime();
    const ageMs = now - publishedAtMs;
    let intervalMs = refreshIntervalForAge(ageMs);

    // Demote to weekly if the last 3 attempts all failed/blocked.
    // Stops the cron from burning Apify credit on a permanently-
    // broken URL.
    const last3 = last3StatusesByPub.get(pub.id) ?? [];
    if (last3.length === 3 && last3.every((s) => s === "failed" || s === "blocked")) {
      intervalMs = Math.max(intervalMs, ONE_WEEK);
    }

    const latest = latestByPub.get(pub.id);
    if (!latest) {
      // Never scraped — always due. Caught by the on-paste auto-refresh
      // for new publications, but the cron also picks them up as a
      // safety net (e.g. if Apify was capped during mark-posted).
      due.push({ pub, reason: "never-scraped", ageMs, lastFetchedAt: null, intervalMs });
      continue;
    }
    const sinceMs = now - new Date(latest.fetched_at).getTime();
    if (sinceMs >= intervalMs) {
      due.push({
        pub, reason: "interval-elapsed", ageMs,
        lastFetchedAt: latest.fetched_at, intervalMs,
      });
    }
  }

  // Stable ordering: oldest-latest-snapshot first, so we attack the
  // most-stale tiles before re-scraping ones we just touched. Never-
  // scraped rows go first (null treated as epoch).
  due.sort((a, b) => {
    const ta = a.lastFetchedAt ? new Date(a.lastFetchedAt).getTime() : 0;
    const tb = b.lastFetchedAt ? new Date(b.lastFetchedAt).getTime() : 0;
    return ta - tb;
  });

  const batch = due.slice(0, MAX_SCRAPES_PER_RUN);

  // ----- SCRAPE the batch -----
  // Serial inside the batch — running 5 parallel Apify calls is fine
  // from Apify's side but ties up Vercel function memory + risks
  // hitting the platform's per-actor concurrency caps. Serial keeps
  // the function predictable.
  const results: Array<{
    publicationId: string;
    platform: Platform;
    scrape_status: string;
    error?: string | null;
  }> = [];
  for (const entry of batch) {
    const pub = entry.pub;
    if (!pub.live_url) continue; // belt-and-braces — filtered earlier too
    let scraped;
    try {
      scraped = await dispatchScrape(pub.platform, pub.live_url);
    } catch (e) {
      results.push({
        publicationId: pub.id, platform: pub.platform,
        scrape_status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (!scraped) continue; // platform unsupported (X) — skip silently
    try {
      await persistScrapeResult(client, pub.id, scraped);
    } catch (e) {
      results.push({
        publicationId: pub.id, platform: pub.platform,
        scrape_status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    results.push({
      publicationId: pub.id,
      platform: pub.platform,
      scrape_status: scraped.status,
      error: scraped.errorMessage,
    });
  }

  res.status(200).json({
    ok: true,
    total_eligible: publications.length,
    due: due.length,
    processed: results.length,
    backlog: Math.max(0, due.length - results.length),
    results,
  });
}
