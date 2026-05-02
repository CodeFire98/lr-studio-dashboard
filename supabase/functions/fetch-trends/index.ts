// =====================================================================
// fetch-trends
//
// Scrapes external "what's trending right now" surfaces and writes them
// into public.trend_signals so the dashboard's Trends Radar can read a
// single normalized table regardless of source.
//
// Sources are dispatched by `source` in the request body:
//
//   tiktok  — TikTok Creative Center (free, no API key beyond Firecrawl).
//             Pulls trending hashtags + sounds for the requested countries
//             and time window from
//             https://ads.tiktok.com/business/creativecenter/inspiration/popular/...
//
// Future sources will land as sibling handlers (handleTwitter via Apify,
// handleInstagram via Apify/EnsembleData) without touching the dispatch
// shell. Same upsert path, same dedupe key, same UI.
//
// Auth model:
//   - Caller's JWT is verified by the platform (verify_jwt = true).
//   - Caller must be agency staff (profiles.is_agency = true). Brand
//     users get 403 even though the table's RLS would already hide the
//     read; we double-gate the write trigger to keep this feature
//     entirely agency-only at the API surface.
//   - Writes use the service-role client so we bypass the
//     authenticated-only-read RLS policy.
//
// Env vars (set with `supabase secrets set ...`):
//   FIRECRAWL_API_KEY  — required, fc-... key from firecrawl.dev
//   SUPABASE_URL       — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected
//   SUPABASE_ANON_KEY  — auto-injected
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Default region set for v1. Easy to override per-call. Keep small —
// every region is N Firecrawl scrapes per source.
const DEFAULT_REGIONS = ["US", "IN", "GB", "CA", "AU"];
// Default window — Creative Center supports 7 / 30 / 120 days; 7d is the
// most actionable for a calendar that runs weekly.
const DEFAULT_WINDOW: "7d" | "30d" = "7d";

type TrendKind = "hashtag" | "sound" | "topic" | "post" | "creator";
type Platform = "tiktok" | "instagram" | "twitter" | "linkedin";

type FetchTrendsRequest = {
  source: Platform;
  regions?: string[];
  window?: "7d" | "30d";
};

// Shape we hand Firecrawl's JSON extract format. Same schema works for
// hashtags and sounds; the only difference at parse time is what title /
// subtitle / metric mean. We keep it flexible so a single schema covers
// both pages.
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
          rank: {
            type: "number",
            description: "Position in the list — 1 for the top item.",
          },
          title: {
            type: "string",
            description:
              "The hashtag (without the #) for hashtag pages, or the song title for music pages.",
          },
          subtitle: {
            type: "string",
            description:
              "Secondary line shown next to the trend — for hashtags this is post-count text, for sounds this is the artist name.",
          },
          url: {
            type: "string",
            description: "Link to the detail page on Creative Center if shown.",
          },
          thumbnail_url: {
            type: "string",
            description: "Thumbnail image URL if shown.",
          },
          metric_value: {
            type: "number",
            description:
              "Numeric metric if shown (post count, view count, plays). Null otherwise.",
          },
          metric_label: {
            type: "string",
            description:
              "Human label for that metric, e.g. 'posts', 'views', 'plays'.",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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
      // first-touch. proxy:auto pays for stealth only when the basic scraper
      // hits a wall (same pattern enrich-brand-kit uses).
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

// Map a Creative Center country code to the URL we hit. TikTok uses ISO-2
// in `countryCode` and a numeric `period` (7 / 30 / 120). We expose only
// 7d and 30d to clients and translate here.
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
  serviceClient: ReturnType<typeof createClient>;
}): Promise<TikTokFetchSummary> {
  const { region, window, serviceClient } = args;
  const summary: TikTokFetchSummary = {
    region,
    hashtags: { fetched: 0, written: 0 },
    sounds: { fetched: 0, written: 0 },
    errors: [],
  };

  // Hashtags
  try {
    const rows = await firecrawlExtract({
      url: tiktokUrl({ kind: "hashtag", region, window }),
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
          trend_window: window,
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
      url: tiktokUrl({ kind: "sound", region, window }),
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
          trend_window: window,
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
  serviceClient: ReturnType<typeof createClient>,
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
  serviceClient: ReturnType<typeof createClient>,
): Promise<Response> {
  const regions = (body.regions && body.regions.length > 0 ? body.regions : DEFAULT_REGIONS)
    .map((r) => r.trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}$/.test(r));
  const window = body.window === "30d" ? "30d" : DEFAULT_WINDOW;
  if (regions.length === 0) {
    return jsonResponse({ error: "No valid regions; expected ISO-3166 alpha-2 codes" }, 400);
  }

  // Sequential per-region. Firecrawl bills per scrape and Creative Center
  // is rate-sensitive; parallelism would buy us little and risk a wall.
  const summaries: TikTokFetchSummary[] = [];
  for (const region of regions) {
    const s = await fetchTikTokForRegion({ region, window, serviceClient });
    summaries.push(s);
  }

  const totalWritten = summaries.reduce(
    (acc, s) => acc + s.hashtags.written + s.sounds.written,
    0,
  );
  return jsonResponse({
    ok: true,
    source: "tiktok",
    window,
    regions,
    written: totalWritten,
    summaries,
  });
}

// =====================================================================
// Server
// =====================================================================

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  if (!FIRECRAWL_API_KEY) {
    return jsonResponse(
      { error: "FIRECRAWL_API_KEY not configured. Run: supabase secrets set FIRECRAWL_API_KEY=..." },
      500,
    );
  }

  let body: FetchTrendsRequest;
  try {
    body = (await req.json()) as FetchTrendsRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Authz: agency-only at the API surface (in addition to the table RLS,
  // which would also hide the read).
  const { data: callerProfile, error: profileErr } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) return jsonResponse({ error: profileErr.message }, 500);
  if (!callerProfile?.is_agency) {
    return jsonResponse({ error: "fetch-trends requires agency staff access" }, 403);
  }

  if (body?.source === "tiktok") {
    return handleTikTok(body, serviceClient);
  }
  return jsonResponse(
    { error: `Unsupported source: ${(body as { source?: string } | null)?.source ?? "(missing)"}` },
    400,
  );
});
