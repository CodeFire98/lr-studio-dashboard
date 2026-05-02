// =====================================================================
// /api/fetch-trends — Vercel serverless function
//
// Replaces what would have been a Supabase Edge Function. Lives in the
// same Vercel deploy as the SPA so a single push-to-main updates the
// whole stack — no Supabase CLI / PAT scope / multipart-deploy friction.
//
// Scrapes external "what's trending right now" surfaces and writes them
// into public.trend_signals so the dashboard's Trends Radar can read a
// single normalized table regardless of source.
//
// Sources are dispatched by `source` in the request body:
//   tiktok   — TikTok Creative Center hashtags + sounds (free; uses Firecrawl).
//   twitter  — X / Twitter trending topics per region via Apify's
//              automation-lab/twitter-trends-scraper actor.
// Future sources land as sibling handlers (handleInstagram).
//
// Auth model:
//   - Caller MUST send Authorization: Bearer <user JWT>. The handler
//     verifies it server-side via supabase.auth.getUser() (anon-key
//     scoped client).
//   - Caller must be agency staff (profiles.is_agency = true). Brand
//     users get 403 even though the table's RLS would also hide the read.
//   - Writes use the service-role client (bypasses RLS).
//
// Env vars (set in Vercel Project Settings → Environment Variables):
//   FIRECRAWL_API_KEY            — required for `tiktok` source. fc-... key.
//   APIFY_API_TOKEN              — required for `twitter` source. apify_api_...
//   SUPABASE_URL                 — https://vmfwnfflhvskadkfnvds.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — sb_secret_... from Supabase API settings
//   SUPABASE_ANON_KEY            — sb_publishable_... from Supabase API
//                                  settings (same key the SPA uses)
//
// Runtime: defaults to Node (no `export const config` block — the older
// `runtime: "nodejs20.x"` literal we tried initially failed Vercel's bundler
// silently, and `maxDuration: 60` requires Pro plan. Default Node runtime
// + default 10s/25s budget is enough for a single-region scrape; multi-
// region scrapes will hit the per-call timeout and we'll fan-out across
// multiple invocations from the client when we get there.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

// Default region set for v1. Easy to override per-call. Keep small —
// every region is N Firecrawl scrapes per source.
const DEFAULT_REGIONS = ["US", "IN", "GB", "CA", "AU"];
const DEFAULT_WINDOW: "7d" | "30d" = "7d";

type TrendKind = "hashtag" | "sound" | "topic" | "post" | "creator";
type Platform = "tiktok" | "instagram" | "twitter" | "linkedin";

type FetchTrendsRequest = {
  source: Platform;
  regions?: string[];
  window?: "7d" | "30d";
  // For source=instagram only: which brand to scope the scrape to.
  // The handler reads brand_kits.trend_hashtags for this account_id and
  // writes trend_signals rows tagged with this same account_id (per-brand
  // visibility). Required for Instagram; ignored for other sources.
  accountId?: string;
};

const TIKTOK_TREND_SCHEMA = {
  type: "object",
  properties: {
    trends: {
      type: "array",
      description:
        "Trending items shown on this Creative Center page, in the order they appear.",
      items: {
        type: "object",
        properties: {
          rank: { type: "number", description: "Position in the list — 1 for top." },
          title: {
            type: "string",
            description:
              "The hashtag (without #) for hashtag pages, or the song title for music pages.",
          },
          subtitle: {
            type: "string",
            description:
              "Secondary line — for hashtags this is post-count text, for sounds this is the artist name.",
          },
          url: { type: "string", description: "Link to the detail page if shown." },
          thumbnail_url: { type: "string", description: "Thumbnail image URL if shown." },
          metric_value: {
            type: "number",
            description: "Numeric metric if shown (post count / view count / plays).",
          },
          metric_label: {
            type: "string",
            description: "Human label for the metric, e.g. 'posts', 'views', 'plays'.",
          },
        },
        required: ["title"],
      },
    },
  },
  required: ["trends"],
};

const TIKTOK_HASHTAG_PROMPT =
  "Extract every trending hashtag visible on this page in display order. " +
  "For each row capture: rank (1-indexed), the hashtag name without the # symbol, " +
  "the post count text or any subtitle line, and any numeric metric shown.";

const TIKTOK_SOUND_PROMPT =
  "Extract every trending song / sound visible on this page in display order. " +
  "For each row capture: rank (1-indexed), the song title, the artist name as subtitle, " +
  "and any numeric metric (plays / posts) shown.";

// =====================================================================
// Plumbing
// =====================================================================

type FirecrawlExtractRow = {
  rank?: number | null;
  title?: string | null;
  subtitle?: string | null;
  url?: string | null;
  thumbnail_url?: string | null;
  metric_value?: number | null;
  metric_label?: string | null;
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    json?: { trends?: FirecrawlExtractRow[] } | null;
    metadata?: Record<string, unknown>;
  };
  error?: string;
};

async function firecrawlExtract(args: {
  url: string;
  prompt: string;
}): Promise<FirecrawlExtractRow[]> {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url: args.url,
      formats: [
        {
          type: "json",
          schema: TIKTOK_TREND_SCHEMA,
          prompt: args.prompt,
        },
      ],
      onlyMainContent: true,
      // Creative Center is a JS-heavy SPA — give it a beat to render the list.
      waitFor: 3500,
      // Some Creative Center pages hide content behind a soft bot wall on
      // first-touch. proxy:auto pays for stealth only when basic hits a wall
      // (same pattern enrich-brand-kit uses).
      proxy: "auto",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as FirecrawlScrapeResponse;
  if (!res.ok || body?.success === false) {
    throw new Error(
      `Firecrawl ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body?.data?.json?.trends ?? [];
}

function tiktokUrl(args: {
  kind: "hashtag" | "sound";
  region: string;
  window: "7d" | "30d";
}): string {
  const base = "https://ads.tiktok.com/business/creativecenter/inspiration/popular";
  const path = args.kind === "sound" ? "music" : "hashtag";
  const period = args.window === "30d" ? 30 : 7;
  // language=en gives English-localized labels even for non-EN regions, which
  // simplifies parsing. Country still controls the trend mix.
  return `${base}/${path}/pc/en?countryCode=${encodeURIComponent(args.region)}&period=${period}`;
}

type TrendInsertRow = {
  platform: Platform;
  kind: TrendKind;
  region: string;
  title: string;
  subtitle?: string | null;
  url?: string | null;
  thumbnail_url?: string | null;
  metric_value?: number | null;
  metric_label?: string | null;
  rank?: number | null;
  trend_window: string;
  raw_payload?: unknown;
  // Set only for per-brand sources (Instagram). Null for global rows
  // (TikTok, Twitter). The unique dedupe index includes account_id, so
  // a global TikTok #foo and a brand-scoped IG #foo are different rows.
  account_id?: string | null;
};

function normaliseTitle(input: string | null | undefined, kind: TrendKind): string | null {
  if (!input) return null;
  // Collapse all whitespace runs to a single space + trim ends. Without
  // this, "song name" and "song  name" produce different dedupe keys.
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (kind === "hashtag") return collapsed.replace(/^#/, "").toLowerCase();
  if (kind === "sound") {
    // TikTok sometimes appends an internal numeric ID like "song name(1403785)"
    // — strip those (6+ digits in trailing parens) so re-fetches dedupe
    // even when TikTok's pagination shifts which post the ID is pulled from.
    // Lowercase for the same reason hashtags lowercase: case can drift.
    return collapsed.replace(/\s*\(\d{6,}\)\s*$/, "").toLowerCase();
  }
  return collapsed;
}

// Firecrawl's JSON extract sometimes returns 0 for metrics that simply
// weren't visible on the page (TikTok Creative Center music tab doesn't
// expose a play count next to each sound, for instance). Treating those
// as real zeros makes every sound card display "0", which looks broken.
// We normalise 0 → null and drop the metric label too so the card just
// hides the metric chip entirely.
function coerceMetric(rawValue: unknown, rawLabel: unknown): {
  metric_value: number | null;
  metric_label: string | null;
} {
  const n = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) {
    return { metric_value: null, metric_label: null };
  }
  return { metric_value: n, metric_label: typeof rawLabel === "string" ? rawLabel : null };
}

// =====================================================================
// TikTok handler
// =====================================================================

type TikTokFetchSummary = {
  region: string;
  hashtags: { fetched: number; written: number };
  sounds: { fetched: number; written: number };
  errors: string[];
};

async function fetchTikTokForRegion(args: {
  region: string;
  window: "7d" | "30d";
  serviceClient: SupabaseClient;
}): Promise<TikTokFetchSummary> {
  const { region, window: trendWindow, serviceClient } = args;
  // Stamp every row from this scrape with the same capturedAt so we can
  // sweep older rows in the same slice as stale once we're done.
  const capturedAt = new Date();
  const summary: TikTokFetchSummary = {
    region,
    hashtags: { fetched: 0, written: 0 },
    sounds: { fetched: 0, written: 0 },
    errors: [],
  };

  // Hashtags
  try {
    const rows = await firecrawlExtract({
      url: tiktokUrl({ kind: "hashtag", region, window: trendWindow }),
      prompt: TIKTOK_HASHTAG_PROMPT,
    });
    summary.hashtags.fetched = rows.length;
    const inserts: TrendInsertRow[] = rows
      .map((r, i): TrendInsertRow | null => {
        const title = normaliseTitle(r.title, "hashtag");
        if (!title) return null;
        const m = coerceMetric(r.metric_value, r.metric_label);
        return {
          platform: "tiktok",
          kind: "hashtag",
          region,
          title,
          subtitle: r.subtitle ?? null,
          url: r.url ?? null,
          thumbnail_url: r.thumbnail_url ?? null,
          metric_value: m.metric_value,
          metric_label: m.metric_label,
          rank: typeof r.rank === "number" ? r.rank : i + 1,
          trend_window: trendWindow,
          raw_payload: r,
        };
      })
      .filter((row): row is TrendInsertRow => row !== null);
    if (inserts.length > 0) {
      const { error } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (error) summary.errors.push(`hashtag write: ${error.message}`);
      else summary.hashtags.written = inserts.length;
    }
  } catch (ex) {
    summary.errors.push(`hashtag fetch: ${(ex as Error).message}`);
  }

  // Sounds
  try {
    const rows = await firecrawlExtract({
      url: tiktokUrl({ kind: "sound", region, window: trendWindow }),
      prompt: TIKTOK_SOUND_PROMPT,
    });
    summary.sounds.fetched = rows.length;
    const inserts: TrendInsertRow[] = rows
      .map((r, i): TrendInsertRow | null => {
        const title = normaliseTitle(r.title, "sound");
        if (!title) return null;
        const m = coerceMetric(r.metric_value, r.metric_label);
        return {
          platform: "tiktok",
          kind: "sound",
          region,
          title,
          subtitle: r.subtitle ?? null,
          url: r.url ?? null,
          thumbnail_url: r.thumbnail_url ?? null,
          metric_value: m.metric_value,
          metric_label: m.metric_label,
          rank: typeof r.rank === "number" ? r.rank : i + 1,
          trend_window: trendWindow,
          raw_payload: r,
        };
      })
      .filter((row): row is TrendInsertRow => row !== null);
    if (inserts.length > 0) {
      const { error } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (error) summary.errors.push(`sound write: ${error.message}`);
      else summary.sounds.written = inserts.length;
    }
  } catch (ex) {
    summary.errors.push(`sound fetch: ${(ex as Error).message}`);
  }

  // Sweep stale rows for this slice (TikTok / region / global). Anything
  // that wasn't refreshed in this scrape was either dropped from the
  // trending list or partial-failure — either way it's no longer "current"
  // and shouldn't accumulate. Only sweep if SOMETHING was written this
  // round; a totally-failed scrape (network error, bot wall) shouldn't
  // wipe the existing data.
  if (summary.hashtags.written + summary.sounds.written > 0) {
    await sweepStaleTrends(serviceClient, {
      platform: "tiktok",
      region,
      accountIdIsNull: true,
      cutoff: capturedAt,
    });
  }

  return summary;
}

async function upsertTrends(
  serviceClient: SupabaseClient,
  rows: TrendInsertRow[],
  capturedAt: Date = new Date(),
): Promise<{ error: { message: string } | null }> {
  // Refresh capture timestamps + push expiry forward so a re-run after
  // cron extends the lifetime instead of rotating IDs. The unique index
  // (platform, kind, region, title, trend_window, account_id) is the
  // dedupe key. Default expires_at on insert is now() + 14d; we set it
  // explicitly on update so re-fetches don't decay too quickly.
  // capturedAt is hoisted into a parameter so callers can later sweep
  // stale rows using the same timestamp as the cutoff.
  const expires = new Date(capturedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const enriched = rows.map((r) => ({
    ...r,
    captured_at: capturedAt.toISOString(),
    expires_at: expires.toISOString(),
  }));
  const { error } = await serviceClient
    .from("trend_signals")
    .upsert(enriched, {
      onConflict: "platform,kind,region,title,trend_window,account_id",
      ignoreDuplicates: false,
    });
  return { error: error ? { message: error.message } : null };
}

// After a successful refresh for a (platform, kind?, region, account_id)
// slice, sweep any rows whose captured_at is older than the refresh
// started — those represent trends that were trending in a previous
// fetch but didn't come back this time, i.e. stale. Without this, the
// dashboard accumulates ghost rows that say "this was trending 3 days
// ago" alongside the actual current trends.
//
// Run this AFTER the upsert so a failed scrape doesn't wipe the existing
// data. Rows from this scrape have captured_at = `refreshStartedAt`
// (set in upsertTrends), so the cutoff is strict-less-than.
async function sweepStaleTrends(
  serviceClient: SupabaseClient,
  args: {
    platform: Platform;
    region?: string;
    kind?: TrendKind;
    accountIdIsNull?: boolean;
    accountId?: string;
    cutoff: Date;
  },
): Promise<void> {
  let q = serviceClient
    .from("trend_signals")
    .delete()
    .eq("platform", args.platform)
    .lt("captured_at", args.cutoff.toISOString());
  if (args.region) q = q.eq("region", args.region);
  if (args.kind)   q = q.eq("kind", args.kind);
  if (args.accountIdIsNull) q = q.is("account_id", null);
  else if (args.accountId)  q = q.eq("account_id", args.accountId);
  const { error } = await q;
  if (error) {
    // Sweep failures are non-fatal — the data we just upserted is still
    // valid; we just have some lingering stale rows. Log and move on.
    console.warn("sweepStaleTrends failed", error.message);
  }
}

async function handleTikTok(
  body: FetchTrendsRequest,
  serviceClient: SupabaseClient,
): Promise<{ status: number; payload: unknown }> {
  const regions = (body.regions && body.regions.length > 0 ? body.regions : DEFAULT_REGIONS)
    .map((r) => r.trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}$/.test(r));
  const trendWindow = body.window === "30d" ? "30d" : DEFAULT_WINDOW;
  if (regions.length === 0) {
    return {
      status: 400,
      payload: { error: "No valid regions; expected ISO-3166 alpha-2 codes" },
    };
  }

  // Sequential per-region. Firecrawl bills per scrape and Creative Center
  // is rate-sensitive; parallelism would buy us little and risk a wall.
  const summaries: TikTokFetchSummary[] = [];
  for (const region of regions) {
    const s = await fetchTikTokForRegion({ region, window: trendWindow, serviceClient });
    summaries.push(s);
  }

  const totalWritten = summaries.reduce(
    (acc, s) => acc + s.hashtags.written + s.sounds.written,
    0,
  );
  return {
    status: 200,
    payload: {
      ok: true,
      source: "tiktok",
      window: trendWindow,
      regions,
      written: totalWritten,
      summaries,
    },
  };
}

// =====================================================================
// Twitter / X handler — Apify automation-lab/twitter-trends-scraper
//
// Apify accepts a single multi-region call (one POST → all regions back),
// so the architecture is simpler than TikTok's per-region Firecrawl loop.
// We translate our ISO-3166 alpha-2 region list to whatever the actor
// expects (mostly identity, except GB → UK which Twitter trends use).
//
// Output shape from the actor isn't formally documented, so we parse
// defensively: each dataset item is treated as a single trend with a
// best-effort mapping of common field names. Anything we don't
// recognise gets stashed in `raw_payload` for forensics.
// =====================================================================

const TWITTER_REGION_MAP: Record<string, string> = {
  // Keep our internal codes ISO-3166 alpha-2 everywhere; only translate at
  // the API boundary. GB is the ISO code for United Kingdom but Twitter
  // trends data is universally exposed under "UK" — Apify follows that.
  GB: "UK",
};

function toApifyLocation(region: string): string {
  const code = region.trim().toUpperCase();
  return TWITTER_REGION_MAP[code] ?? code;
}

function fromApifyLocation(location: string): string {
  // Inverse mapping so rows are stored under our canonical region code.
  if (location?.toUpperCase() === "UK") return "GB";
  return (location ?? "").toUpperCase();
}

type ApifyTrendItem = {
  // Common shapes we've seen from various Twitter trends scrapers. Any of
  // these may be present; we coalesce in `parseApifyTrendItem`.
  name?: string;
  topic?: string;
  hashtag?: string;
  trend?: string;
  url?: string;
  query?: string;
  tweet_volume?: number | string | null;
  tweetVolume?: number | string | null;
  volume?: number | string | null;
  rank?: number;
  position?: number;
  location?: string;
  country?: string;
  countryCode?: string;
  woeid?: number | string;
  promoted_content?: unknown;
};

type TwitterFetchSummary = {
  region: string;
  fetched: number;
  written: number;
  errors: string[];
};

function parseApifyTrendItem(
  item: ApifyTrendItem,
  fallbackRegion: string,
  fallbackRank: number,
): TrendInsertRow | null {
  // Pick the first non-empty title-ish field. Twitter trends are typically
  // either a hashtag (#foo) or a topic phrase ("Taylor Swift").
  const rawTitle =
    item.name ?? item.topic ?? item.hashtag ?? item.trend ?? null;
  if (!rawTitle || typeof rawTitle !== "string") return null;
  const trimmed = rawTitle.trim();
  if (!trimmed) return null;

  const isHashtag = trimmed.startsWith("#");
  const kind: TrendKind = isHashtag ? "hashtag" : "topic";
  const title = isHashtag
    ? trimmed.slice(1).toLowerCase()
    : trimmed;

  const region = item.countryCode
    ? fromApifyLocation(String(item.countryCode))
    : item.location
    ? fromApifyLocation(String(item.location))
    : item.country
    ? fromApifyLocation(String(item.country))
    : fallbackRegion;

  // tweet_volume is a number from the Twitter trends API but may come back
  // as a string from some scrapers — coerce defensively.
  const rawVolume =
    item.tweet_volume ?? item.tweetVolume ?? item.volume ?? null;
  const numericVolume =
    rawVolume == null ? null : typeof rawVolume === "number"
    ? rawVolume
    : Number(rawVolume) || null;

  const rank =
    typeof item.rank === "number"
      ? item.rank
      : typeof item.position === "number"
      ? item.position
      : fallbackRank;

  return {
    platform: "twitter",
    kind,
    region,
    title,
    subtitle: numericVolume
      ? `${numericVolume.toLocaleString()} tweets`
      : null,
    url: item.url ?? null,
    thumbnail_url: null, // Twitter trends don't expose a thumbnail
    metric_value: numericVolume,
    metric_label: numericVolume ? "tweets" : null,
    rank,
    trend_window: "now", // Twitter trends are real-time, not windowed.
    raw_payload: item,
  };
}

async function handleTwitter(
  body: FetchTrendsRequest,
  serviceClient: SupabaseClient,
): Promise<{ status: number; payload: unknown }> {
  const regions = (body.regions && body.regions.length > 0 ? body.regions : DEFAULT_REGIONS)
    .map((r) => r.trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}$/.test(r));
  if (regions.length === 0) {
    return {
      status: 400,
      payload: { error: "No valid regions; expected ISO-3166 alpha-2 codes" },
    };
  }

  const apifyLocations = regions.map(toApifyLocation);

  // Single multi-region call. Apify's run-sync-get-dataset-items endpoint
  // blocks until the actor finishes and returns the dataset directly —
  // saves us a separate poll loop.
  const apifyUrl =
    `https://api.apify.com/v2/acts/automation-lab~twitter-trends-scraper` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  let res: Response;
  try {
    res = await fetch(apifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locations: apifyLocations,
        maxTrendsPerLocation: 25,
      }),
    });
  } catch (ex) {
    return {
      status: 502,
      payload: { error: `Apify request failed: ${(ex as Error).message}` },
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      status: 502,
      payload: { error: `Apify ${res.status}: ${text.slice(0, 300)}` },
    };
  }

  const items = (await res.json().catch(() => [])) as ApifyTrendItem[];

  // Group rows by region for the per-region rank fallback. Items for the
  // same location come back in display order, so the array index is a
  // good rank fallback when the actor doesn't expose one.
  const byRegion = new Map<string, ApifyTrendItem[]>();
  for (const item of items) {
    const code = item.countryCode
      ? fromApifyLocation(String(item.countryCode))
      : item.location
      ? fromApifyLocation(String(item.location))
      : item.country
      ? fromApifyLocation(String(item.country))
      : null;
    const region = code && regions.includes(code) ? code : regions[0];
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region)!.push(item);
  }

  const capturedAt = new Date();
  const summaries: TwitterFetchSummary[] = [];
  for (const region of regions) {
    const list = byRegion.get(region) ?? [];
    const summary: TwitterFetchSummary = {
      region,
      fetched: list.length,
      written: 0,
      errors: [],
    };
    const inserts: TrendInsertRow[] = [];
    list.forEach((item, i) => {
      const row = parseApifyTrendItem(item, region, i + 1);
      if (row) inserts.push(row);
    });
    if (inserts.length > 0) {
      const { error } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (error) summary.errors.push(`write: ${error.message}`);
      else summary.written = inserts.length;
    }
    // Sweep stale Twitter rows for this region — same rationale as TikTok.
    // Only sweep if we actually wrote something this round.
    if (summary.written > 0) {
      await sweepStaleTrends(serviceClient, {
        platform: "twitter",
        region,
        accountIdIsNull: true,
        cutoff: capturedAt,
      });
    }
    summaries.push(summary);
  }

  const totalWritten = summaries.reduce((acc, s) => acc + s.written, 0);
  return {
    status: 200,
    payload: {
      ok: true,
      source: "twitter",
      window: "now",
      regions,
      written: totalWritten,
      summaries,
    },
  };
}

// =====================================================================
// Instagram handler — Apify apify/instagram-hashtag-scraper
//
// **Pivoted 2026-05-02**: this used to be per-brand (read each brand's
// configured hashtags from brand_kits.trend_hashtags). We pivoted back
// to global trends to match TikTok/Twitter behaviour: surface what's
// trending on Instagram RIGHT NOW by region, not "top posts for THIS
// brand's tracked hashtags."
//
// Strategy: Instagram doesn't expose a public "trends per country" API
// the way TikTok Creative Center does. The closest signal we can get is
// engagement-sorted recent posts under high-volume regional discovery
// hashtags (#viralreels, #explorepage, regional flavour like #india /
// #usa). It's not perfect — it's "viral-tagged" not "objectively viral"
// — but it gives the agency a usable feed and matches the user
// expectation of "Instagram trends like TikTok / X".
//
// Output: kind='post' rows with region set to the requested ISO code,
// account_id=NULL (global pool), trend_window='now'. Same
// trend_signals table; same TrendsView shell.
//
// brand_kits.trend_hashtags column added in migration 0030 stays —
// it's harmless and may be reused by Phase 7 (brand-fit AI scoring).
// =====================================================================

// Curated discovery hashtags per region. The first few are always-trending
// generic discovery tags; the rest are regional flavour. The Apify scraper
// orders posts by engagement, so what comes back is "viral content right now
// in this region" — close enough to "trending" for the agency's purposes.
const IG_DISCOVERY_TAGS_BY_REGION: Record<string, string[]> = {
  US: ["viral", "trending", "viralreels", "explorepage", "usa"],
  IN: ["viralreels", "trendingreels", "india", "indianreels", "explorepage"],
  GB: ["viral", "trending", "uk", "british", "explorepage"],
  CA: ["viral", "trending", "canada", "viralreels", "explorepage"],
  AU: ["viral", "trending", "australia", "aussie", "viralreels"],
};

type ApifyInstagramPost = {
  id?: string;
  shortCode?: string;
  type?: string;
  caption?: string;
  url?: string;
  displayUrl?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  timestamp?: string;
  ownerUsername?: string;
  hashtags?: string[];
  // Some scrapers expose the source hashtag the post matched against.
  // We tolerate either spelling.
  hashtag?: string;
  inputHashtag?: string;
  searchHashtag?: string;
  [key: string]: unknown;
};

type InstagramFetchSummary = {
  hashtag: string;
  fetched: number;
  written: number;
  errors: string[];
};

function captionSnippet(caption: string | undefined | null, max = 140): string | null {
  if (!caption) return null;
  const oneLine = caption.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

function parseInstagramPost(
  post: ApifyInstagramPost,
  hashtag: string,
  accountId: string,
  fallbackRank: number,
): TrendInsertRow | null {
  const url = post.url ?? (post.shortCode ? `https://www.instagram.com/p/${post.shortCode}/` : null);
  if (!url && !post.id) return null; // Need at least one stable identifier.

  // Title preference: caption snippet → username post → fallback.
  // We keep the source hashtag in subtitle so the agency can tell which
  // of the brand's tracked hashtags surfaced this post.
  const username = post.ownerUsername ? `@${post.ownerUsername}` : "anonymous";
  const snippet = captionSnippet(post.caption);
  const title = snippet || `${username} post`;

  const likes =
    typeof post.likesCount === "number"
      ? post.likesCount
      : typeof post.videoViewCount === "number"
      ? post.videoViewCount
      : null;

  const subtitleParts = [
    username,
    `#${hashtag}`,
    likes != null ? `${likes.toLocaleString()} ${post.videoViewCount ? "views" : "likes"}` : null,
  ].filter(Boolean);

  return {
    platform: "instagram",
    kind: "post",
    region: "global", // IG posts aren't region-scoped per row
    title: title.slice(0, 280),
    subtitle: subtitleParts.join(" · "),
    url,
    thumbnail_url: post.displayUrl ?? null,
    metric_value: likes,
    metric_label: likes != null
      ? (post.videoViewCount ? "views" : "likes")
      : null,
    rank: fallbackRank,
    trend_window: "now",
    raw_payload: post,
  };
}

type InstagramRegionSummary = {
  region: string;
  hashtags: string[];
  fetched: number;
  written: number;
  errors: string[];
};

async function handleInstagram(
  body: FetchTrendsRequest,
  serviceClient: SupabaseClient,
): Promise<{ status: number; payload: unknown }> {
  const regions = (body.regions && body.regions.length > 0 ? body.regions : DEFAULT_REGIONS)
    .map((r) => r.trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}$/.test(r));
  if (regions.length === 0) {
    return {
      status: 400,
      payload: { error: "No valid regions; expected ISO-3166 alpha-2 codes" },
    };
  }

  const apifyUrl =
    `https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  const capturedAt = new Date();
  const summaries: InstagramRegionSummary[] = [];

  // Per-region Apify call. We could merge all regions into a single
  // multi-hashtag call to save quota, but then post→region attribution
  // becomes guesswork (a post tagged with #viral matches every region's
  // discovery list). Keeping calls per-region preserves clean
  // attribution and matches the TikTok per-region pattern.
  for (const region of regions) {
    const tags = IG_DISCOVERY_TAGS_BY_REGION[region] ?? IG_DISCOVERY_TAGS_BY_REGION.US;
    const summary: InstagramRegionSummary = {
      region,
      hashtags: tags,
      fetched: 0,
      written: 0,
      errors: [],
    };

    let res: Response;
    try {
      res = await fetch(apifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hashtags: tags,
          resultsLimit: 6, // per hashtag — keeps the per-region call small
          resultsType: "posts",
        }),
      });
    } catch (ex) {
      summary.errors.push(`apify request: ${(ex as Error).message}`);
      summaries.push(summary);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      summary.errors.push(`apify ${res.status}: ${text.slice(0, 200)}`);
      summaries.push(summary);
      continue;
    }

    const items = (await res.json().catch(() => [])) as ApifyInstagramPost[];
    summary.fetched = items.length;

    // Sort by likes / views desc so the highest-engagement posts get the
    // top ranks. The Apify scraper returns items in API order, not
    // engagement order.
    const sorted = [...items].sort((a, b) => {
      const aMetric = (a.likesCount ?? a.videoViewCount ?? 0);
      const bMetric = (b.likesCount ?? b.videoViewCount ?? 0);
      return bMetric - aMetric;
    });

    const inserts: TrendInsertRow[] = [];
    sorted.forEach((post, i) => {
      // Pick the first hashtag we can attribute to from this region's
      // discovery set; fall back to the first one in the list. Used for
      // the subtitle "@user · #foo · 1.2K likes" so the agency knows
      // which discovery tag surfaced the post.
      let attributedTag = tags[0];
      if (Array.isArray(post.hashtags)) {
        const found = post.hashtags
          .map((h) => String(h).replace(/^#/, "").toLowerCase())
          .find((h) => tags.includes(h));
        if (found) attributedTag = found;
      }
      const row = parseInstagramPost(post, attributedTag, "", i + 1);
      if (!row) return;
      // Override region/account_id from the per-brand defaults to global.
      inserts.push({ ...row, region, account_id: null });
    });

    if (inserts.length > 0) {
      const { error } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (error) summary.errors.push(`write: ${error.message}`);
      else summary.written = inserts.length;
    }

    if (summary.written > 0) {
      await sweepStaleTrends(serviceClient, {
        platform: "instagram",
        region,
        accountIdIsNull: true,
        cutoff: capturedAt,
      });
    }

    summaries.push(summary);
  }

  const totalWritten = summaries.reduce((acc, s) => acc + s.written, 0);
  return {
    status: 200,
    payload: {
      ok: true,
      source: "instagram",
      regions,
      written: totalWritten,
      summaries,
    },
  };
}

// =====================================================================
// Handler
// =====================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST required" });
  }

  // Supabase env is needed for ALL sources (auth + service-role upsert).
  // Source-specific provider keys (FIRECRAWL_API_KEY, APIFY_API_TOKEN) are
  // checked by the individual handlers so a misconfigured `tiktok` env
  // doesn't break a `twitter` call.
  if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
    return res.status(500).json({
      error:
        "Supabase env not fully configured. Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY in Vercel.",
    });
  }

  // Vercel parses JSON bodies into req.body when Content-Type is application/json.
  // Tolerate string bodies too (some clients).
  let body: FetchTrendsRequest;
  if (typeof req.body === "string") {
    try {
      body = JSON.parse(req.body) as FetchTrendsRequest;
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  } else {
    body = (req.body ?? {}) as FetchTrendsRequest;
  }

  const authHeader =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["Authorization"] as string | undefined) ??
    "";
  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  // Verify the caller's JWT against Supabase. We use an anon-key client with
  // the user's JWT scoped in — getUser() validates the token signature +
  // expiry against the same project.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Authz: agency-only at the API surface (in addition to the table RLS,
  // which would also hide the read).
  const { data: callerProfile, error: profileErr } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) return res.status(500).json({ error: profileErr.message });
  if (!callerProfile?.is_agency) {
    return res.status(403).json({ error: "fetch-trends requires agency staff access" });
  }

  if (body?.source === "tiktok") {
    if (!FIRECRAWL_API_KEY) {
      return res.status(500).json({
        error:
          "FIRECRAWL_API_KEY not configured. Add it under Vercel Project Settings → Environment Variables.",
      });
    }
    try {
      const result = await handleTikTok(body, serviceClient);
      return res.status(result.status).json(result.payload);
    } catch (ex) {
      return res
        .status(500)
        .json({ error: `TikTok handler crashed: ${(ex as Error).message}` });
    }
  }

  if (body?.source === "twitter") {
    if (!APIFY_API_TOKEN) {
      return res.status(500).json({
        error:
          "APIFY_API_TOKEN not configured. Add it under Vercel Project Settings → Environment Variables.",
      });
    }
    try {
      const result = await handleTwitter(body, serviceClient);
      return res.status(result.status).json(result.payload);
    } catch (ex) {
      return res
        .status(500)
        .json({ error: `Twitter handler crashed: ${(ex as Error).message}` });
    }
  }

  if (body?.source === "instagram") {
    if (!APIFY_API_TOKEN) {
      return res.status(500).json({
        error:
          "APIFY_API_TOKEN not configured. Add it under Vercel Project Settings → Environment Variables.",
      });
    }
    try {
      const result = await handleInstagram(body, serviceClient);
      return res.status(result.status).json(result.payload);
    } catch (ex) {
      return res
        .status(500)
        .json({ error: `Instagram handler crashed: ${(ex as Error).message}` });
    }
  }

  return res.status(400).json({
    error: `Unsupported source: ${
      (body as { source?: string } | null)?.source ?? "(missing)"
    }`,
  });
}
