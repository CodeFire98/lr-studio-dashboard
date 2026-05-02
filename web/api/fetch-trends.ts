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
//   tiktok  — TikTok Creative Center hashtags + sounds (free; uses Firecrawl).
// Future sources land as sibling handlers (handleTwitter, handleInstagram).
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
//   FIRECRAWL_API_KEY            — required, fc-... key from firecrawl.dev
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

  if (!FIRECRAWL_API_KEY) {
    return res.status(500).json({
      error:
        "FIRECRAWL_API_KEY not configured. Add it under Vercel Project Settings → Environment Variables.",
    });
  }
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
    try {
      const result = await handleTikTok(body, serviceClient);
      return res.status(result.status).json(result.payload);
    } catch (ex) {
      return res
        .status(500)
        .json({ error: `TikTok handler crashed: ${(ex as Error).message}` });
    }
  }

  return res.status(400).json({
    error: `Unsupported source: ${
      (body as { source?: string } | null)?.source ?? "(missing)"
    }`,
  });
}
