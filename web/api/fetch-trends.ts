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
  // For source=instagram, picks between two operating modes:
  //   - "region" (default): scrape curated regional creators per region
  //   - "competitors": scrape this brand's competitor list (requires accountId)
  // Ignored for tiktok / twitter (those are always region-scoped).
  mode?: "region" | "competitors";
  // For source=instagram + mode='competitors': which brand to fetch for.
  // Reads brand_kits.competitor_handles for this id and writes per-brand
  // trend_signals (account_id set on each row).
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
// TikTok handler — Apify automation-lab/tiktok-trends-scraper
//
// **Pivoted 2026-05-03** from Firecrawl Creative Center scraping. Why:
// the Firecrawl approach was returning identical content across every
// region (countryCode URL param wasn't actually scoping the page) AND
// the music page rarely surfaced play-count metrics. Apify's actor
// accepts countryCode natively and works correctly per region.
// =====================================================================

type ApifyTikTokTrendItem = {
  // Defensive parsing — different Apify TikTok actor variants expose
  // slightly different field names. We accept several common shapes
  // and stash the raw payload for forensics.
  rank?: number;
  position?: number;
  hashtag_name?: string;
  hashtag?: string;
  name?: string;
  title?: string;
  song_name?: string;
  songName?: string;
  song_title?: string;
  artist_name?: string;
  artistName?: string;
  artist?: string;
  posts?: number;
  postCount?: number;
  publishCnt?: number;
  views?: number;
  viewCount?: number;
  videoViews?: number;
  url?: string;
  link?: string;
  cover_url?: string;
  coverUrl?: string;
  countryCode?: string;
  [key: string]: unknown;
};

type TikTokFetchSummary = {
  region: string;
  hashtags: { fetched: number; written: number };
  sounds: { fetched: number; written: number };
  errors: string[];
};

function parseTikTokHashtag(
  item: ApifyTikTokTrendItem,
  region: string,
  trendWindow: string,
  fallbackRank: number,
): TrendInsertRow | null {
  const rawTitle = item.hashtag_name ?? item.hashtag ?? item.name ?? item.title;
  const title = normaliseTitle(typeof rawTitle === "string" ? rawTitle : null, "hashtag");
  if (!title) return null;
  const posts = item.posts ?? item.postCount ?? item.publishCnt ?? null;
  const views = item.views ?? item.viewCount ?? item.videoViews ?? null;
  // Prefer post count over views — for hashtag trends, post count is
  // the more agency-relevant signal ("how many people are making content
  // around this"). Fall back to views if posts isn't exposed.
  const m = coerceMetric(posts, "posts");
  const finalMetric = m.metric_value != null
    ? m
    : coerceMetric(views, "views");
  return {
    platform: "tiktok",
    kind: "hashtag",
    region,
    title,
    subtitle: finalMetric.metric_value != null
      ? `${finalMetric.metric_value.toLocaleString()} ${finalMetric.metric_label}`
      : null,
    url: item.url ?? item.link ?? null,
    thumbnail_url: item.cover_url ?? item.coverUrl ?? null,
    metric_value: finalMetric.metric_value,
    metric_label: finalMetric.metric_label,
    rank: typeof item.rank === "number" ? item.rank
        : typeof item.position === "number" ? item.position
        : fallbackRank,
    trend_window: trendWindow,
    raw_payload: item,
  };
}

function parseTikTokSound(
  item: ApifyTikTokTrendItem,
  region: string,
  trendWindow: string,
  fallbackRank: number,
): TrendInsertRow | null {
  const rawTitle = item.song_name ?? item.songName ?? item.song_title ?? item.title ?? item.name;
  const title = normaliseTitle(typeof rawTitle === "string" ? rawTitle : null, "sound");
  if (!title) return null;
  const artist = item.artist_name ?? item.artistName ?? item.artist;
  const posts = item.posts ?? item.postCount ?? item.publishCnt ?? null;
  const m = coerceMetric(posts, "posts");
  return {
    platform: "tiktok",
    kind: "sound",
    region,
    title,
    subtitle: typeof artist === "string" && artist.trim()
      ? artist.trim()
      : (m.metric_value != null ? `${m.metric_value.toLocaleString()} ${m.metric_label}` : null),
    url: item.url ?? item.link ?? null,
    thumbnail_url: item.cover_url ?? item.coverUrl ?? null,
    metric_value: m.metric_value,
    metric_label: m.metric_label,
    rank: typeof item.rank === "number" ? item.rank
        : typeof item.position === "number" ? item.position
        : fallbackRank,
    trend_window: trendWindow,
    raw_payload: item,
  };
}

async function callApifyTikTokTrends(args: {
  trendType: "hashtag" | "song";
  countryCode: string;
  period: 7 | 30;
  maxResults: number;
}): Promise<{ items: ApifyTikTokTrendItem[]; error?: string }> {
  const url =
    `https://api.apify.com/v2/acts/automation-lab~tiktok-trends-scraper` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trendType: args.trendType,
        countryCode: args.countryCode,
        period: args.period,
        maxResults: args.maxResults,
      }),
    });
  } catch (ex) {
    return { items: [], error: `network: ${(ex as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { items: [], error: `apify ${res.status}: ${text.slice(0, 200)}` };
  }
  const items = (await res.json().catch(() => [])) as ApifyTikTokTrendItem[];
  return { items: Array.isArray(items) ? items : [] };
}

async function fetchTikTokForRegion(args: {
  region: string;
  window: "7d" | "30d";
  serviceClient: SupabaseClient;
}): Promise<TikTokFetchSummary> {
  const { region, window: trendWindow, serviceClient } = args;
  const capturedAt = new Date();
  const period: 7 | 30 = trendWindow === "30d" ? 30 : 7;
  const summary: TikTokFetchSummary = {
    region,
    hashtags: { fetched: 0, written: 0 },
    sounds: { fetched: 0, written: 0 },
    errors: [],
  };

  // Hashtags
  {
    const { items, error } = await callApifyTikTokTrends({
      trendType: "hashtag",
      countryCode: region,
      period,
      maxResults: 25,
    });
    if (error) summary.errors.push(`hashtag fetch: ${error}`);
    summary.hashtags.fetched = items.length;
    const inserts = items
      .map((it, i) => parseTikTokHashtag(it, region, trendWindow, i + 1))
      .filter((row): row is TrendInsertRow => row !== null);
    if (inserts.length > 0) {
      const { error: writeErr } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (writeErr) summary.errors.push(`hashtag write: ${writeErr.message}`);
      else summary.hashtags.written = inserts.length;
    }
  }

  // Sounds (Apify uses trendType: "song" — different from our internal "sound" kind name)
  {
    const { items, error } = await callApifyTikTokTrends({
      trendType: "song",
      countryCode: region,
      period,
      maxResults: 25,
    });
    if (error) summary.errors.push(`sound fetch: ${error}`);
    summary.sounds.fetched = items.length;
    const inserts = items
      .map((it, i) => parseTikTokSound(it, region, trendWindow, i + 1))
      .filter((row): row is TrendInsertRow => row !== null);
    if (inserts.length > 0) {
      const { error: writeErr } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (writeErr) summary.errors.push(`sound write: ${writeErr.message}`);
      else summary.sounds.written = inserts.length;
    }
  }

  // Sweep stale rows for this slice. Only sweep if SOMETHING was written
  // this round — a totally-failed scrape shouldn't wipe existing data.
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

// Postgres' ON CONFLICT DO UPDATE rejects a batch where two input rows
// collide on the same target — `cannot affect row a second time`.
// Within a single Apify response, multiple Instagram posts often share
// the same caption snippet (template captions, generic "viral" posts),
// so they hash to the same dedupe key. Deduplicate in JS before upsert,
// keeping the highest-engagement entry per natural key. metric_value
// ties break by lower rank (i.e. earlier position in the source list).
function dedupeRowsByNaturalKey(rows: TrendInsertRow[]): TrendInsertRow[] {
  const map = new Map<string, TrendInsertRow>();
  for (const r of rows) {
    const key = [
      r.platform,
      r.kind,
      r.region,
      r.title,
      r.trend_window,
      r.account_id ?? "__null__",
    ].join("|");
    const existing = map.get(key);
    if (!existing) {
      map.set(key, r);
      continue;
    }
    const existingMetric = existing.metric_value ?? 0;
    const newMetric = r.metric_value ?? 0;
    if (newMetric > existingMetric) {
      map.set(key, r);
      continue;
    }
    if (newMetric === existingMetric) {
      const existingRank = existing.rank ?? Infinity;
      const newRank = r.rank ?? Infinity;
      if (newRank < existingRank) map.set(key, r);
    }
  }
  return Array.from(map.values());
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
  // Drop in-batch duplicates BEFORE adding the timestamps so the
  // engagement-aware tiebreak in dedupeRowsByNaturalKey picks the right
  // winner. Without this, Postgres' ON CONFLICT DO UPDATE errors out
  // with "cannot affect row a second time" when two input rows share
  // the natural key (common on IG where multiple posts have identical
  // caption snippets).
  const deduped = dedupeRowsByNaturalKey(rows);
  const enriched = deduped.map((r) => ({
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
// Instagram handler — Apify apify/instagram-profile-scraper (v3, 2026-05-03)
//
// Two operating modes the client picks via `mode`:
//   - region:      scrape a curated list of high-engagement creator accounts
//                  per region. Designed to surface "what's working on IG in
//                  this region right now."
//   - competitors: scrape a brand's competitor list (brand_kits.competitor_handles).
//                  Designed for "what are MY brand's competitors posting that's
//                  getting engagement?"
//
// Both modes feed @handles to the SAME Apify actor and share the same parser.
//
// Why this replaced the v2 hashtag-discovery approach:
// v2 scraped #viral, #trending, #india, #explorepage etc. and sorted by
// engagement. The discovery hashtags are spam-tagged by anyone, regional
// hashtags don't actually mean "from this region" (e.g. Spanish posts in
// the IN tab tagged #india), and there's no quality signal at all. Real-
// world test on 2026-05-03 returned random low-engagement noise.
//
// Profile-based scraping has none of those problems: the @handles are
// curated (either by us per-region or by the agency per-brand), so every
// post is from a known-quality source. Output: kind='post', engagement-
// sorted, with handle ownership baked into the subtitle.
//
// trend_hashtags column from migration 0030 is no longer read by any
// code path. Left in place for forensic value + possible Phase 7 reuse.
// =====================================================================

// Curated regional creator handles (no @ prefix, lowercase). 8-ish high-
// engagement accounts per region across categories (food, fashion,
// entertainment, news, sports). Hardcoded for now — once the agency
// wants to edit this without a deploy we can move it to a Supabase
// table, but a static list ships today and is easy to tune.
const IG_TOP_CREATORS_BY_REGION: Record<string, string[]> = {
  US: [
    "natgeo",
    "tasty",
    "voguemagazine",
    "theshaderoom",
    "starbucks",
    "nikemag",
    "glossier",
    "rollingstone",
  ],
  IN: [
    "indiatoday",
    "foodtalkindia",
    "vogueindia",
    "filmfare",
    "viratkohli",
    "diipakhosla",
    "myntra",
    "natgeoindia",
  ],
  GB: [
    "bbc",
    "voguemagazine_uk",
    "manchesterunited",
    "hellomag",
    "gordongram",
    "primeminister",
    "thetimes",
    "asos",
  ],
  CA: [
    "champagnepapi",
    "torontolife",
    "narcity_canada",
    "cbcnews",
    "cmagazinecanada",
    "raptors",
    "shawnmendes",
    "tim_hortons",
  ],
  AU: [
    "australia",
    "abcnews_au",
    "bondibeach",
    "gigi",
    "hughjackman",
    "broadsheet_aus",
    "9news",
    "kookaiclothing",
  ],
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

// Apify Instagram Profile Scraper output is inconsistent across actor
// versions and post types — owner username sometimes lives on `ownerUsername`,
// sometimes on `username`, sometimes nested in `owner.username`, and on
// some Reel/video items it's missing entirely. Try every known field
// position before falling back.
function extractOwnerHandle(post: ApifyInstagramPost): string | null {
  const tryString = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim().replace(/^@/, "").toLowerCase();
    return t.length > 0 ? t : null;
  };
  const direct = tryString(post.ownerUsername)
    ?? tryString((post as Record<string, unknown>).username)
    ?? tryString((post as Record<string, unknown>).inputUsername);
  if (direct) return direct;
  const owner = (post as Record<string, unknown>).owner;
  if (owner && typeof owner === "object") {
    const fromOwner = tryString((owner as Record<string, unknown>).username);
    if (fromOwner) return fromOwner;
  }
  const user = (post as Record<string, unknown>).user;
  if (user && typeof user === "object") {
    const fromUser = tryString((user as Record<string, unknown>).username);
    if (fromUser) return fromUser;
  }
  // Some scrapers expose the input URL on each item (e.g. inputUrl =
  // https://www.instagram.com/<handle>/). Parse it out.
  const inputUrl = (post as Record<string, unknown>).inputUrl;
  if (typeof inputUrl === "string") {
    const m = inputUrl.match(/instagram\.com\/([^/?#]+)/i);
    if (m) {
      const cleaned = tryString(m[1]);
      if (cleaned && !["p", "reel", "tv", "explore"].includes(cleaned)) {
        return cleaned;
      }
    }
  }
  return null;
}

// Extract audio metadata from an Instagram reel/post. Apify's
// instagram-scraper output puts music info in different shapes
// depending on actor version + post type. Try every known shape:
//   - `musicInfo` (most common on reels): { audio_canonical_id,
//     song_name, artist_name, ... }
//   - `clipsMusicMetadata.music_info.music_asset_info`: more recent
//     variant with audio_cluster_id, title, display_artist
//   - `original_sound_info` / `originalSoundInfo`: original audio
//     uploaded by the creator (no licensed song); we still want these
//     because creator-original sounds go viral too
// Returns null when the post has no detectable audio (carousel image,
// audio stripped by IG, etc.).
type ParsedReelAudio = {
  audioId: string;
  songName: string | null;
  artistName: string | null;
};
function extractAudioFromPost(post: ApifyInstagramPost): ParsedReelAudio | null {
  const p = post as Record<string, unknown>;

  const tryStr = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };

  // Shape 1: post.musicInfo.{audio_canonical_id|audio_id, song_name, artist_name}
  const mi = p.musicInfo as Record<string, unknown> | undefined;
  if (mi && typeof mi === "object") {
    const audioId =
      tryStr(mi.audio_canonical_id) ?? tryStr(mi.audio_id) ?? tryStr(mi.canonical_id);
    if (audioId) {
      return {
        audioId,
        songName: tryStr(mi.song_name) ?? tryStr(mi.title),
        artistName: tryStr(mi.artist_name) ?? tryStr(mi.artist),
      };
    }
  }

  // Shape 2: post.clipsMusicMetadata.music_info.music_asset_info
  const cm = p.clipsMusicMetadata as Record<string, unknown> | undefined;
  if (cm && typeof cm === "object") {
    const muInfo = cm.music_info as Record<string, unknown> | undefined;
    const mai = muInfo?.music_asset_info as Record<string, unknown> | undefined;
    if (mai && typeof mai === "object") {
      const audioId =
        tryStr(mai.audio_cluster_id) ?? tryStr(mai.id);
      if (audioId) {
        return {
          audioId,
          songName: tryStr(mai.title) ?? tryStr(mai.subtitle),
          artistName: tryStr(mai.display_artist) ?? tryStr(mai.artist),
        };
      }
    }
  }

  // Shape 3: original_sound_info — creator-original audio
  const osi =
    (p.originalSoundInfo as Record<string, unknown> | undefined) ??
    (p.original_sound_info as Record<string, unknown> | undefined);
  if (osi && typeof osi === "object") {
    const audioId =
      tryStr(osi.audio_asset_id) ??
      tryStr(osi.original_audio_id) ??
      tryStr(osi.id);
    if (audioId) {
      return {
        audioId,
        songName: tryStr(osi.original_audio_title) ?? tryStr(osi.title),
        artistName:
          tryStr(osi.username) ?? tryStr(osi.audio_owner) ?? "Original audio",
      };
    }
  }

  return null;
}

function parseInstagramPost(args: {
  post: ApifyInstagramPost;
  ownerHandle: string;        // fallback @handle when the post doesn't expose owner — typically the handle we asked Apify to scrape, derived from input position
  region: string;             // 'US' / 'IN' / ... / 'global'
  accountId: string | null;   // null for region mode, brand uuid for competitors mode
  fallbackRank: number;
}): TrendInsertRow | null {
  const { post, ownerHandle, region, accountId, fallbackRank } = args;
  const url = post.url ?? (post.shortCode ? `https://www.instagram.com/p/${post.shortCode}/` : null);
  if (!url && !post.id) return null;

  // Resolve owner handle: prefer fields ON the post; fall back to the
  // handle we asked Apify to scrape (input attribution).
  const resolvedOwner = extractOwnerHandle(post) ?? ownerHandle ?? "unknown";

  // Title: caption snippet (most informative) or fallback to "@handle · short-id"
  // so multiple caption-less posts from the same account don't collide on
  // the dedupe key.
  const usernameTag = `@${resolvedOwner}`;
  const snippet = captionSnippet(post.caption);
  const shortRef = post.shortCode || (post.id ? String(post.id).slice(-6) : "");
  const title = snippet || `${usernameTag}${shortRef ? ` · ${shortRef}` : " post"}`;

  const likes =
    typeof post.likesCount === "number"
      ? post.likesCount
      : typeof post.videoViewCount === "number"
      ? post.videoViewCount
      : null;
  const isVideoMetric = likes != null && typeof post.videoViewCount === "number" && post.likesCount == null;

  const subtitleParts = [
    usernameTag,
    likes != null ? `${likes.toLocaleString()} ${isVideoMetric ? "views" : "likes"}` : null,
  ].filter(Boolean);

  return {
    platform: "instagram",
    kind: "post",
    region,
    title: title.slice(0, 280),
    subtitle: subtitleParts.join(" · "),
    url,
    thumbnail_url: post.displayUrl ?? null,
    metric_value: likes,
    metric_label: likes != null ? (isVideoMetric ? "views" : "likes") : null,
    rank: fallbackRank,
    trend_window: "now",
    raw_payload: post,
    account_id: accountId,
  };
}

type InstagramRegionSummary = {
  // For region mode: { region, handles, ... }. For competitor mode: { region: 'global', handles (brand competitors), ... }.
  region: string;
  handles: string[];
  fetched: number;
  written: number;
  errors: string[];
};

// Single Apify call: feed N profile URLs, get back POSTS (not account
// metadata). The general-purpose apify/instagram-scraper returns post
// objects with caption, likes, displayUrl, etc. when given directUrls
// pointing at profiles + resultsType="posts".
//
// We previously used apify/instagram-profile-scraper with `usernames`
// — but that actor returns account-level records (bio, follower count,
// user ID) not posts. Every "post" came back as a single account
// record per username, parsed as a "post" with no caption + no
// shortcode + no likesCount, surfacing as "@handle · <last-6-of-user-id>".
async function callApifyInstagramPosts(args: {
  handles: string[];
  resultsLimit: number;
}): Promise<{ items: ApifyInstagramPost[]; error?: string }> {
  const directUrls = args.handles.map((h) => `https://www.instagram.com/${h}/`);
  const url =
    `https://api.apify.com/v2/acts/apify~instagram-scraper` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directUrls,
        resultsType: "posts",
        resultsLimit: args.resultsLimit,
        // Trim the response — these knobs reduce per-post payload and
        // stay well under Vercel's response size limit.
        addParentData: false,
        searchType: "user",
      }),
    });
  } catch (ex) {
    return { items: [], error: `network: ${(ex as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { items: [], error: `apify ${res.status}: ${text.slice(0, 200)}` };
  }
  const items = (await res.json().catch(() => [])) as ApifyInstagramPost[];
  return { items: Array.isArray(items) ? items : [] };
}

// Phase C — get audio virality data via doodledaron/instagram-audio-spy.
// Pass the brand's competitor + aggregator usernames; actor returns
// top tracks across the input set with `totalViews`, `viewsPerDay`
// (the velocity signal), `usedBy` handles, and audio URLs all
// pre-grouped. Single call per refresh covers everything.
//
// Note we tested apify/instagram-scraper directly with audio URLs
// (`instagram.com/reels/audio/{id}/`) and it returns
// {error:"no_items"} — that actor doesn't support audio URLs at
// all. The doodledaron actor specifically does the right thing.
//
// Response shape (1 dataset item):
//   {
//     top_5_tracks: [{ songName, artist, totalViews, viewsPerDay, usedBy[], audioUrl }],
//     fastest_growing_overall: {...},
//     fastest_growing_by_competitor: [{...}, ...]  // one per input username
//   }
//
// Since `usedBy` only contains the username that owned the source
// reel for THAT audio entry (not all users of the audio), we have
// to dedupe + merge ourselves when the same audio appears in both
// `top_5_tracks` and `fastest_growing_by_competitor`.
type AudioSpyTrack = {
  songName?: string;
  artist?: string;
  totalViews?: number;
  viewsPerDay?: number;
  usedBy?: string[];
  audioUrl?: string;
};
type AudioSpyResponse = {
  top_5_tracks?: AudioSpyTrack[];
  fastest_growing_overall?: AudioSpyTrack;
  fastest_growing_by_competitor?: AudioSpyTrack[];
};

async function callApifyAudioSpy(args: {
  usernames: string[];
}): Promise<{ result: AudioSpyResponse | null; error?: string }> {
  if (args.usernames.length === 0) return { result: null };
  const url =
    `https://api.apify.com/v2/acts/doodledaron~instagram-audio-spy` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Actor input: { username: ["a","b",...] } — singular field, plural array.
      body: JSON.stringify({ username: args.usernames }),
    });
  } catch (ex) {
    return { result: null, error: `audio-spy network: ${(ex as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { result: null, error: `audio-spy apify ${res.status}: ${text.slice(0, 200)}` };
  }
  const items = await res.json().catch(() => null);
  if (!Array.isArray(items) || items.length === 0) {
    return { result: null, error: "audio-spy returned no items" };
  }
  return { result: items[0] as AudioSpyResponse };
}

// Pull the audio_id back out of an instagram.com/reels/audio/{id}/ URL
// — used to keep stable dedupe identity even when the song name
// collides (e.g. two creator-original audios both labeled with
// the same artist handle).
function extractAudioIdFromUrl(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(/\/reels\/audio\/([^/?#]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// Format viewsPerDay velocity as "+12K/day" / "+1.2M/day".
function formatViewsPerDay(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `+${(n / 1_000_000).toFixed(1)}M/day`;
  if (n >= 1_000)     return `+${(n / 1_000).toFixed(1)}K/day`;
  return `+${Math.round(n)}/day`;
}

// Format totalViews as "1.2M views" / "127K views".
function formatTotalViews(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B views`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} view${n === 1 ? "" : "s"}`;
}

// Phase C v1 — DEAD CODE retained for one cycle. The
// apify/instagram-scraper actor does not support audio URLs as
// input (returns {error:"no_items"}). Kept here so the diff
// reading the new code is small; remove when audio-spy approach
// is bedded in.
async function callApifyAudioDetail(args: {
  audioUrls: string[];
}): Promise<{ items: ApifyInstagramPost[]; error?: string }> {
  if (args.audioUrls.length === 0) return { items: [] };
  const url =
    `https://api.apify.com/v2/acts/apify~instagram-scraper` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directUrls: args.audioUrls,
        resultsType: "posts",
        resultsLimit: 1,
        // addParentData=true asks Apify to include the parent media
        // metadata (the audio object itself, not just the reel) when
        // available. The audio object is where the global count
        // typically lives.
        addParentData: true,
        searchType: "user",
      }),
    });
  } catch (ex) {
    return { items: [], error: `audio-detail network: ${(ex as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { items: [], error: `audio-detail apify ${res.status}: ${text.slice(0, 200)}` };
  }
  const items = (await res.json().catch(() => [])) as ApifyInstagramPost[];
  return { items: Array.isArray(items) ? items : [] };
}

// Defensively extract the global "N reels using this audio" count
// from an Apify response item. The field location depends on actor
// version + audio type (licensed song vs creator-original); we try
// every known shape and return the first non-zero number found.
// Returns null when no count is detectable.
function extractAudioUsageCount(item: ApifyInstagramPost): number | null {
  const p = item as Record<string, unknown>;
  const get = (path: string): unknown => {
    return path.split(".").reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object") {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, p);
  };
  const candidatePaths = [
    // Original sound (creator-recorded audio)
    "clipsMusicMetadata.original_sound_info.use_count",
    "clipsMusicMetadata.original_sound_info.original_audio_use_count",
    "originalSoundInfo.use_count",
    "originalSoundInfo.original_audio_use_count",
    "original_sound_info.use_count",
    // Licensed music
    "clipsMusicMetadata.music_info.music_asset_info.use_count",
    "clipsMusicMetadata.music_info.music_asset_info.video_count",
    // Top-level musicInfo
    "musicInfo.use_count",
    "musicInfo.video_count",
    "musicInfo.related_post_count",
    "musicInfo.usage_count",
    // Audio object directly
    "audio.use_count",
    "audio.video_count",
    "audio.usage_count",
    // Top-level shorthand fields some actors expose
    "useCount",
    "videoCount",
    "usageCount",
    "reels_count",
    "reelsCount",
  ];
  for (const path of candidatePaths) {
    const v = get(path);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) {
      const n = parseInt(v, 10);
      if (n > 0) return n;
    }
  }
  return null;
}

// Pull the audio_id back out of the URL we sent to Apify so we can
// re-associate the response items with our buckets. Apify echoes the
// input URL on each item under `inputUrl` (sometimes `input` or
// `url`); we try each shape.
function parseAudioIdFromInputUrl(item: ApifyInstagramPost): string | null {
  const p = item as Record<string, unknown>;
  const candidateUrls: unknown[] = [
    p.inputUrl,
    p.input,
    p.url,
  ];
  for (const u of candidateUrls) {
    if (typeof u !== "string") continue;
    const m = u.match(/\/reels\/audio\/([^/?#]+)/i);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
  }
  return null;
}

// Format a global count as "1.2M reels" / "127K reels" / "987 reels".
// Server-side formatter so the stored subtitle is readable without
// relying on the client to format. The client also formats from
// raw_payload so it can re-render if we change the format later.
function formatGlobalReelCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B reels`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M reels`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K reels`;
  return `${n} reel${n === 1 ? "" : "s"}`;
}

async function handleInstagram(
  body: FetchTrendsRequest,
  serviceClient: SupabaseClient,
): Promise<{ status: number; payload: unknown }> {
  // Pre-2026-05-06 the IG handler had two modes: 'region' (curated
  // creators per region, global) and 'competitors' (per-brand). The
  // 'region' mode was retired with the brand-scoping refactor — every
  // IG fetch is now per-brand and produces audio-level rows
  // (kind='sound') via handleInstagramAudios. The dispatcher accepts
  // mode='competitors' as a backward-compat token (it's what the UI
  // still sends) and routes any IG call to the audios pipeline.
  // handleInstagramRegion is preserved below as dead code for one
  // cycle in case we want to revive a global "trending audio" feed
  // (e.g. once aggregator-account seeding lands in Phase B-extension).
  return handleInstagramAudios(body, serviceClient);
}

async function handleInstagramRegion(
  body: FetchTrendsRequest,
  serviceClient: SupabaseClient,
): Promise<{ status: number; payload: unknown }> {
  const regions = (body.regions && body.regions.length > 0 ? body.regions : DEFAULT_REGIONS)
    .map((r) => r.trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}$/.test(r));
  if (regions.length === 0) {
    return { status: 400, payload: { error: "No valid regions; expected ISO-3166 alpha-2 codes" } };
  }

  const capturedAt = new Date();
  const summaries: InstagramRegionSummary[] = [];

  for (const region of regions) {
    const handles = IG_TOP_CREATORS_BY_REGION[region] ?? [];
    const summary: InstagramRegionSummary = {
      region,
      handles,
      fetched: 0,
      written: 0,
      errors: [],
    };
    if (handles.length === 0) {
      summary.errors.push(`no curated creators for region ${region}`);
      summaries.push(summary);
      continue;
    }

    const RESULTS_PER_HANDLE = 4;
    const { items, error } = await callApifyInstagramPosts({ handles, resultsLimit: RESULTS_PER_HANDLE });
    if (error) summary.errors.push(error);
    summary.fetched = items.length;

    // Apify Instagram Profile Scraper returns posts in input-handle
    // order: handles[0]'s posts first, then handles[1]'s, etc. Tag each
    // post with the handle whose chunk it falls into so we have a
    // positional fallback when the post object itself doesn't expose
    // owner. parseInstagramPost will prefer fields on the post over this.
    const tagged = items.map((post, originalIdx) => ({
      post,
      inputHandle: handles[Math.floor(originalIdx / RESULTS_PER_HANDLE)] ?? handles[handles.length - 1],
    }));
    // Sort posts by engagement desc so the highest-performing land at top
    // ranks regardless of which creator they came from.
    tagged.sort((a, b) => {
      const am = (a.post.likesCount ?? a.post.videoViewCount ?? 0);
      const bm = (b.post.likesCount ?? b.post.videoViewCount ?? 0);
      return bm - am;
    });

    const inserts: TrendInsertRow[] = [];
    tagged.forEach(({ post, inputHandle }, i) => {
      const row = parseInstagramPost({
        post,
        ownerHandle: inputHandle,
        region,
        accountId: null,
        fallbackRank: i + 1,
      });
      if (row) inserts.push(row);
    });

    if (inserts.length > 0) {
      const { error: writeErr } = await upsertTrends(serviceClient, inserts, capturedAt);
      if (writeErr) summary.errors.push(`write: ${writeErr.message}`);
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
      mode: "region",
      regions,
      written: totalWritten,
      summaries,
    },
  };
}

// Aggregator IG accounts that manually curate viral-audio reels.
// Reels from these accounts seed the candidate audio pool alongside
// each brand's competitors — humans pre-filter for virality so the
// signal density is higher than random hashtag reels. Hardcoded for
// now; Phase B-extension will move this to a `trend_aggregator_accounts`
// table with a small agency-only admin UI for adding handles.
//
// User-supplied initial set (2026-05-06): `creators`,
// `early.trending.audio`, `notsorrysocial`.
const IG_AGGREGATOR_HANDLES: readonly string[] = [
  "creators",
  "early.trending.audio",
  "notsorrysocial",
];

// Pivoted to doodledaron/instagram-audio-spy on 2026-05-06 because
// the prior approach (scrape competitor reels via apify/instagram-scraper,
// bucket by audio_id, then enrich each bucket with global counts via a
// second Apify call) had two problems: (1) the bucket-grouping fallback
// gave us "1 reel" sample counts that misled users into thinking audios
// were unused; (2) apify/instagram-scraper does NOT support audio URLs
// — it returns {error:"no_items"} when given /reels/audio/{id}/ as
// directUrl. The doodledaron actor is purpose-built for this: pass it a
// list of competitor + aggregator usernames and it returns top tracks
// with `totalViews`, `viewsPerDay` (velocity!), `usedBy` handles, and
// audio URLs already grouped — exactly what the user asked for.
//
// Trade-off vs the prior approach: doodledaron returns ~5-20 audios per
// refresh (top_5_tracks + one per input username via
// fastest_growing_by_competitor), where the prior approach surfaced
// 30-50. Fewer rows but each carries real virality data instead of
// noisy bucket counts. Better signal density beats volume.
//
// The legacy handler is preserved as `handleInstagramAudiosLegacy`
// below in case audio-spy proves unreliable in production.
async function handleInstagramAudios(
  body: FetchTrendsRequest,
  serviceClient: SupabaseClient,
): Promise<{ status: number; payload: unknown }> {
  if (!body.accountId) {
    return { status: 400, payload: { error: "accountId is required for mode=competitors" } };
  }

  // Read this brand's competitor list. Prefer the new `competitors`
  // jsonb column ({name, handle, url}); fall back to the legacy
  // `competitor_handles text[]` (migration 0032) if the brand was
  // edited under the old code path and never re-enriched.
  const { data: kit, error: kitErr } = await serviceClient
    .from("brand_kits")
    .select("competitors, competitor_handles, account_id")
    .eq("account_id", body.accountId)
    .maybeSingle();
  if (kitErr) return { status: 500, payload: { error: kitErr.message } };
  if (!kit) return { status: 404, payload: { error: "Brand kit not found for that accountId" } };

  type CompetitorEntry = { name?: string; handle?: string; url?: string };
  const fromJsonb = (kit.competitors as CompetitorEntry[] | null) ?? [];
  const fromLegacy = (kit.competitor_handles as string[] | null) ?? [];
  const allHandlesRaw: string[] = [
    ...fromJsonb.map((c) => (typeof c?.handle === "string" ? c.handle : "")),
    ...fromLegacy,
  ];
  const competitorHandles = Array.from(
    new Set(
      allHandlesRaw
        .map((h) => String(h).trim().replace(/^@/, "").toLowerCase())
        .filter((h) => h.length > 0 && /^[a-z0-9._]+$/i.test(h)),
    ),
  ).slice(0, 12);
  if (competitorHandles.length === 0) {
    return {
      status: 200,
      payload: {
        ok: true,
        source: "instagram",
        mode: "competitors",
        accountId: body.accountId,
        written: 0,
        summaries: [],
        note: "This brand has no competitors configured. Click \"Fetch Brand\" in Brand Intelligence to auto-populate them, or add them manually in the Competitors section.",
      },
    };
  }

  // Hybrid pipeline (2026-05-06 #2):
  //   Step 1: apify/instagram-scraper on competitor handles (fast,
  //           ~30s for any number of handles). Gives us reels we
  //           can bucket-by-audio for the "Used by @competitor"
  //           signal across ALL the brand's competitors.
  //   Step 2: doodledaron/instagram-audio-spy on aggregator handles
  //           ONLY (3 fixed handles, ~150-200s, 1 chunk). Returns
  //           top tracks with totalViews + viewsPerDay (the global
  //           virality signal we want to display).
  //   Step 3: merge results by audioId. An audio with both signals
  //           shows "{Artist} · Used by @h1, @h2 · 1.2M views" +
  //           "+12K/day" pill. An audio with only competitor data
  //           shows "Used by @h1, @h2" (no views — we omit rather
  //           than show a misleading scrape-sample number).
  //
  // Why split the work: audio-spy alone can only handle 5 usernames
  // per call (actor cap) AND each call is slow because it internally
  // launches apify/instagram-reel-scraper which takes minutes. Free
  // Apify also has an 8GB concurrent-memory cap that prevents running
  // multiple audio-spy chunks in parallel. By using audio-spy ONLY
  // for the 3 fixed aggregator handles (one chunk, no scaling needed)
  // we get the global virality data without hitting any constraint,
  // and instagram-scraper covers the per-brand competitor signal in
  // a single fast call regardless of competitor count. Total runtime
  // ~210-240s, comfortably within Vercel's 300s function timeout.
  const aggregatorHandlesNorm = IG_AGGREGATOR_HANDLES
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter((h) => h.length > 0 && /^[a-z0-9._]+$/i.test(h));
  const aggregatorSet = new Set(aggregatorHandlesNorm);

  const capturedAt = new Date();
  const summary: InstagramRegionSummary = {
    region: "global",
    handles: [...competitorHandles, ...aggregatorHandlesNorm],
    fetched: 0,
    written: 0,
    errors: [],
  };

  // Shared bucket structure across both scrapers — keyed by audioId
  // so an audio that BOTH a competitor uses AND an aggregator features
  // gets both signals merged onto a single trend_signals row.
  type MergedAudio = {
    audioId: string;
    songName: string | null;
    artistName: string | null;
    audioUrl: string;
    totalViews: number;        // from audio-spy (0 when not surfaced)
    viewsPerDay: number;       // from audio-spy (0 when not surfaced)
    competitorsUsing: Set<string>;
    aggregatorsUsing: Set<string>;
  };
  const merged = new Map<string, MergedAudio>();

  // Run both scrapers in PARALLEL via Promise.all. Originally split
  // into sequential steps because TWO audio-spy parents in parallel
  // bumped the Apify free-tier 8GB memory cap (each parent launches a
  // 1024MB child reel-scraper). But ONE audio-spy + ONE
  // instagram-scraper running together is ~6GB peak — under the cap.
  // Real production timings for the sequential version drifted past
  // Vercel's 300s function timeout (instagram-scraper 100-180s +
  // audio-spy 150-260s = up to 440s, too risky). Parallelizing makes
  // total wall time max(t1, t2) ≈ 260s, comfortably under 300s.
  const RESULTS_PER_HANDLE = 8;
  console.log("[fetch-trends] running competitor-scrape and audio-spy in parallel");

  const competitorScrapePromise = callApifyInstagramPosts({
    handles: competitorHandles,
    resultsLimit: RESULTS_PER_HANDLE,
  });
  const audioSpyPromise = aggregatorHandlesNorm.length > 0
    ? callApifyAudioSpy({ usernames: aggregatorHandlesNorm })
    : Promise.resolve({ result: null });

  const [competitorRes, audioSpyRes] = await Promise.all([
    competitorScrapePromise,
    audioSpyPromise,
  ]);

  // ---- Step 1: ingest competitor reels ------------------------------
  const { items: postItems, error: postErr } = competitorRes;
  if (postErr) {
    summary.errors.push(`competitor-scrape: ${postErr}`);
    console.warn("[fetch-trends] competitor-scrape error:", postErr);
  }
  console.log("[fetch-trends] competitor-scrape: got", postItems.length, "posts");

  postItems.forEach((post, originalIdx) => {
    const audio = extractAudioFromPost(post);
    if (!audio) return;
    const inputHandle = competitorHandles[Math.floor(originalIdx / RESULTS_PER_HANDLE)] ?? competitorHandles[competitorHandles.length - 1];
    const ownerHandle = extractOwnerHandle(post) ?? inputHandle ?? "unknown";

    let m = merged.get(audio.audioId);
    if (!m) {
      m = {
        audioId: audio.audioId,
        songName: audio.songName,
        artistName: audio.artistName,
        audioUrl: `https://www.instagram.com/reels/audio/${encodeURIComponent(audio.audioId)}/`,
        totalViews: 0,
        viewsPerDay: 0,
        competitorsUsing: new Set(),
        aggregatorsUsing: new Set(),
      };
      merged.set(audio.audioId, m);
    }
    m.competitorsUsing.add(ownerHandle);
    if (!m.songName && audio.songName) m.songName = audio.songName;
    if (!m.artistName && audio.artistName) m.artistName = audio.artistName;
  });
  console.log("[fetch-trends] competitor-scrape: bucketed into", merged.size, "audios");

  // ---- Step 2: ingest audio-spy results -----------------------------
  const ingestSpyTrack = (t: AudioSpyTrack | undefined) => {
    if (!t || typeof t !== "object") return;
    const audioId = extractAudioIdFromUrl(t.audioUrl);
    if (!audioId) return;
    let m = merged.get(audioId);
    if (!m) {
      m = {
        audioId,
        songName: typeof t.songName === "string" && t.songName.trim().length > 0 ? t.songName.trim() : null,
        artistName: typeof t.artist === "string" && t.artist.trim().length > 0 ? t.artist.trim() : null,
        audioUrl: t.audioUrl ?? `https://www.instagram.com/reels/audio/${encodeURIComponent(audioId)}/`,
        totalViews: 0,
        viewsPerDay: 0,
        competitorsUsing: new Set(),
        aggregatorsUsing: new Set(),
      };
      merged.set(audioId, m);
    }
    if (!m.songName && typeof t.songName === "string" && t.songName.trim()) m.songName = t.songName.trim();
    if (!m.artistName && typeof t.artist === "string" && t.artist.trim()) m.artistName = t.artist.trim();
    if (typeof t.totalViews === "number" && t.totalViews > m.totalViews) m.totalViews = t.totalViews;
    if (typeof t.viewsPerDay === "number" && t.viewsPerDay > m.viewsPerDay) m.viewsPerDay = t.viewsPerDay;
    if (Array.isArray(t.usedBy)) {
      for (const u of t.usedBy) {
        if (typeof u !== "string") continue;
        const norm = u.trim().replace(/^@/, "").toLowerCase();
        if (!norm) continue;
        if (aggregatorSet.has(norm)) m.aggregatorsUsing.add(norm);
      }
    }
  };

  if (aggregatorHandlesNorm.length > 0) {
    const { result: spyResult, error: spyErr } = audioSpyRes as { result: AudioSpyResponse | null; error?: string };
    if (spyErr) {
      summary.errors.push(`audio-spy: ${spyErr}`);
      console.warn("[fetch-trends] audio-spy error:", spyErr);
    }
    if (spyResult) {
      for (const t of spyResult.top_5_tracks ?? []) ingestSpyTrack(t);
      for (const t of spyResult.fastest_growing_by_competitor ?? []) ingestSpyTrack(t);
      ingestSpyTrack(spyResult.fastest_growing_overall);
      console.log("[fetch-trends] audio-spy: merged into", merged.size, "audios total");
    }
  }

  summary.fetched = merged.size;

  // Rank: audios with audio-spy data (totalViews > 0) get top spots
  // sorted by viewsPerDay desc (velocity — actively climbing beats
  // historic size). Audios with only competitor data sort below by
  // competitor count desc. This way the strategist always sees the
  // virality-confirmed audios first, then category-relevant audios
  // their competitors are riding even without aggregator coverage.
  const ranked = Array.from(merged.values()).sort((a, b) => {
    const aHasViews = a.totalViews > 0 ? 1 : 0;
    const bHasViews = b.totalViews > 0 ? 1 : 0;
    if (bHasViews !== aHasViews) return bHasViews - aHasViews;
    if (aHasViews) {
      if (b.viewsPerDay !== a.viewsPerDay) return b.viewsPerDay - a.viewsPerDay;
      if (b.totalViews !== a.totalViews)   return b.totalViews - a.totalViews;
    }
    return b.competitorsUsing.size - a.competitorsUsing.size;
  });

  // Format up to `cap` @-handles into a comma-joined string, with a
  // trailing "+ N more" when there are more.
  const formatHandles = (handles: string[], cap = 3): string => {
    if (handles.length === 0) return "";
    const at = handles.map((h) => `@${h}`);
    if (at.length <= cap) return at.join(", ");
    return `${at.slice(0, cap).join(", ")} + ${at.length - cap} more`;
  };

  const inserts: TrendInsertRow[] = ranked.map((m, i) => {
    const competitorList = Array.from(m.competitorsUsing);
    const aggregatorList = Array.from(m.aggregatorsUsing);
    // Title falls back to a short audio-id stub when songName is
    // missing (creator-original audio without a labeled track).
    // Without this, every untitled audio would collide on the dedupe
    // key (platform, kind, region, title, ...) and we'd lose all but
    // the highest-metric one.
    const title = m.songName && m.songName.length > 0
      ? m.songName
      : `Audio · ${m.audioId.slice(-8)}`;

    // Subtitle: artist + brand-relevance signal + global views.
    // Brand-relevance prefers competitor handles (the brand's own
    // category context); falls back to "Featured by @aggregator"
    // when no competitor surfaced the audio (early-mover signal).
    // Velocity goes in the metric pill.
    const subtitleParts: string[] = [];
    if (m.artistName) subtitleParts.push(m.artistName);
    if (competitorList.length > 0) {
      subtitleParts.push(`Used by ${formatHandles(competitorList, 3)}`);
    } else if (aggregatorList.length > 0) {
      subtitleParts.push(`Featured by ${formatHandles(aggregatorList, 2)}`);
    }
    if (m.totalViews > 0) {
      subtitleParts.push(formatTotalViews(m.totalViews));
    }

    // Metric pill: velocity (viewsPerDay) — the actionable signal.
    // "+12K/day" tells the strategist this audio is climbing now,
    // not just historically big. When velocity is unknown we leave
    // the pill empty rather than showing a misleading zero.
    const velocityStr = formatViewsPerDay(m.viewsPerDay);
    const metricLabel = velocityStr || null;

    return {
      platform: "instagram",
      kind: "sound",
      region: "global",
      title: title.slice(0, 280),
      subtitle: subtitleParts.join(" · "),
      url: m.audioUrl,
      thumbnail_url: null,
      metric_value: m.viewsPerDay > 0 ? Math.round(m.viewsPerDay) : null,
      metric_label: metricLabel,
      rank: i + 1,
      trend_window: "now",
      raw_payload: {
        audioId: m.audioId,
        songName: m.songName,
        artistName: m.artistName,
        // Real virality numbers from the audio-spy actor — both
        // are aggregate global stats, not scrape-sample counts.
        totalViews: m.totalViews,
        viewsPerDay: m.viewsPerDay,
        competitorHandles: competitorList,
        aggregatorHandles: aggregatorList,
      },
      account_id: body.accountId!,
    };
  });

  if (inserts.length > 0) {
    const { error: writeErr } = await upsertTrends(serviceClient, inserts, capturedAt);
    if (writeErr) summary.errors.push(`write: ${writeErr.message}`);
    else summary.written = inserts.length;
  }

  if (summary.written > 0) {
    // Only sweep stale `kind='sound'` rows — leave legacy `kind='post'`
    // IG rows from the pre-2026-05-06 handler to age out via the
    // 14-day expires_at on their own.
    await sweepStaleTrends(serviceClient, {
      platform: "instagram",
      region: "global",
      kind: "sound",
      accountId: body.accountId,
      cutoff: capturedAt,
    });
  }

  return {
    status: 200,
    payload: {
      ok: true,
      source: "instagram",
      mode: "competitors",
      accountId: body.accountId,
      written: summary.written,
      summaries: [summary],
      audiosFound: merged.size,
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
