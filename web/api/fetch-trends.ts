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
};

function normaliseTitle(input: string | null | undefined, kind: TrendKind): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (kind === "hashtag") return trimmed.replace(/^#/, "").toLowerCase();
  return trimmed;
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
        return {
          platform: "tiktok",
          kind: "hashtag",
          region,
          title,
          subtitle: r.subtitle ?? null,
          url: r.url ?? null,
          thumbnail_url: r.thumbnail_url ?? null,
          metric_value: typeof r.metric_value === "number" ? r.metric_value : null,
          metric_label: r.metric_label ?? null,
          rank: typeof r.rank === "number" ? r.rank : i + 1,
          trend_window: trendWindow,
          raw_payload: r,
        };
      })
      .filter((row): row is TrendInsertRow => row !== null);
    if (inserts.length > 0) {
      const { error } = await upsertTrends(serviceClient, inserts);
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
        return {
          platform: "tiktok",
          kind: "sound",
          region,
          title,
          subtitle: r.subtitle ?? null,
          url: r.url ?? null,
          thumbnail_url: r.thumbnail_url ?? null,
          metric_value: typeof r.metric_value === "number" ? r.metric_value : null,
          metric_label: r.metric_label ?? null,
          rank: typeof r.rank === "number" ? r.rank : i + 1,
          trend_window: trendWindow,
          raw_payload: r,
        };
      })
      .filter((row): row is TrendInsertRow => row !== null);
    if (inserts.length > 0) {
      const { error } = await upsertTrends(serviceClient, inserts);
      if (error) summary.errors.push(`sound write: ${error.message}`);
      else summary.sounds.written = inserts.length;
    }
  } catch (ex) {
    summary.errors.push(`sound fetch: ${(ex as Error).message}`);
  }

  return summary;
}

async function upsertTrends(
  serviceClient: SupabaseClient,
  rows: TrendInsertRow[],
): Promise<{ error: { message: string } | null }> {
  // Refresh capture timestamps + push expiry forward so a re-run after
  // cron extends the lifetime instead of rotating IDs. The unique index
  // (platform, kind, region, title, trend_window, account_id) is the
  // dedupe key. Default expires_at on insert is now() + 14d; we set it
  // explicitly on update so re-fetches don't decay too quickly.
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const enriched = rows.map((r) => ({
    ...r,
    captured_at: now.toISOString(),
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
      const { error } = await upsertTrends(serviceClient, inserts);
      if (error) summary.errors.push(`write: ${error.message}`);
      else summary.written = inserts.length;
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

  return res.status(400).json({
    error: `Unsupported source: ${
      (body as { source?: string } | null)?.source ?? "(missing)"
    }`,
  });
}
