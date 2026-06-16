// =====================================================================
// engagement-refresh
//
// Daily-ish cron that keeps `post_engagement_snapshots` fresh for every
// publication with a `live_url` on a supported platform (IG / LinkedIn /
// X). Replaces the old `/api/engagement/refresh-cron` Vercel route — see
// REFERENCE.md "Cron jobs" section for the why.
//
// Why we moved off Vercel:
//   - Vercel Hobby caps cron jobs at once-per-day and serverless
//     function timeouts at 60s. That capped us at 5 scrapes per day,
//     which doesn't scale past ~5 publications.
//   - Supabase Edge Functions get a 400s wall-clock budget on Pro and
//     are co-located with Postgres (no inter-cloud hop on DB reads/
//     writes). pg_cron can fire as often as every minute.
//
// Trigger: `cron.schedule()` job inside Postgres → `pg_net.http_post()`
// → this function. See `supabase/migrations/0045_engagement_refresh_cron.sql`
// for the schedule definition. Default schedule: daily at 00:30 UTC
// (6:00 AM IST). To re-cadence, update the cron row — no code change.
//
// Auth: Authorization: Bearer <CRON_SECRET>. CRON_SECRET is set as both
// a Vercel env var (still used by `/api/daily-digest` for the email
// digest cron) and a Supabase Function secret (used here). Same opaque
// string on both sides. The pg_cron job pulls it from a vault secret.
//
// Tiered cadence (keyed on time-since-publication, NOT time-since-
// last-scrape, so a long-overdue publication catches up to the right
// tier instead of being stuck in the most-frequent one):
//   0-14 days after publication  → refresh daily (every cron fire)
//   15-60 days                   → every 3 days
//   60+ days                     → weekly
//   3+ consecutive failures      → demoted to weekly
//
// Per-run budget: 20 scrapes max, batched in groups of 3 with
// Promise.all. One scrape is ~7-12s; serial would cap us at ~30 in
// 400s. Parallel-3 fits ~80-100 comfortably, but Apify per-actor
// concurrency soft-limits suggest staying small. 20 is the cap.
//
// Observability:
//   - Every run writes one row into `cron_run_log` (started_at,
//     finished_at, status, pubs_due, pubs_processed, error_message,
//     details). Single-query "did the cron run today?" check beats
//     hunting through edge function logs.
//   - Push alerts (email on failure) are deferred. When we want them,
//     add an `engagement-cron-alert` template to `send-email` and call
//     it from here on `runError || failed>0 || blocked>0`.
//
// Env vars (set with `supabase secrets set ...`):
//   CRON_SECRET                — shared with Vercel (same value)
//   APIFY_API_TOKEN            — required (apify_api_...)
//   SUPABASE_URL               — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  — auto-injected
// =====================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Inlined from `../_shared/cors.ts`. The Supabase Dashboard's single-file
// editor can't resolve cross-directory imports during paste-deploy, so
// keep the function self-contained. If we later switch to CLI deploys
// (`supabase functions deploy`) we can re-import from `_shared` —
// the CLI bundles relative paths correctly.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

const CRON_SECRET     = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? "";

// Per-run scrape budget. 400s wall-clock minus DB I/O minus headroom
// gives ~20 scrapes at ~12s each batched 3-wide. Bump in tandem with
// schedule cadence if/when scale grows past current 10-brand plan.
const MAX_SCRAPES_PER_RUN = 20;
const SCRAPE_CONCURRENCY  = 3;

// Cadence tiers (ms).
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

type Platform = "instagram" | "linkedin" | "x";
type ScrapeStatus = "ok" | "partial" | "failed" | "blocked";

type PubRow = {
  id: string;
  platform: Platform;
  live_url: string | null;
  published_at: string;
  post_plan_id: string;
  // PostgREST join — single object or array depending on FK generics.
  post_plans?: { account_id: string | null } | { account_id: string | null }[] | null;
};

// Apify rate card mirror — kept in sync with web/api/_shared/usage.ts.
// Deno edge function can't import from the Vercel API tree, so this
// duplication is intentional. If a third caller appears later it
// warrants extraction; two is the threshold for staying inline.
const APIFY_USD_PER_SCRAPE: Record<string, number> = {
  "apify/instagram-scraper": 0.0023,
  "apimaestro/linkedin-post-detail": 0.005, // $5 / 1k results
  "scrape.badger/twitter-tweets-scraper": 0.0002,
};

function estimateApifyCostUsd(actorId: string): number {
  return APIFY_USD_PER_SCRAPE[actorId] ?? 0.0023;
}

/**
 * Append a single row to service_usage_log for this Apify call.
 * Fire-and-forget — never throws. The cron writes its own
 * cron_run_log row for the overall run; this is per-scrape telemetry
 * that rolls up into the daily usage digest.
 */
async function logScrapeUsage(
  client: SupabaseClient,
  args: {
    accountId: string | null;
    publicationId: string;
    platform: Platform;
    actorId: string;
    actorRunId: string | null;
    scrapeStatus: ScrapeStatus;
    errorMessage: string | null;
    latencyMs: number;
  },
): Promise<void> {
  try {
    const status: "ok" | "failed" | "blocked" =
      args.scrapeStatus === "blocked" ? "blocked"
      : args.scrapeStatus === "failed" ? "failed"
      : "ok";
    await client.from("service_usage_log").insert({
      service: "apify",
      route: "engagement-refresh",
      account_id: args.accountId,
      cost_usd: estimateApifyCostUsd(args.actorId),
      latency_ms: args.latencyMs,
      status,
      error: args.errorMessage ? args.errorMessage.slice(0, 500) : null,
      meta: {
        actor_id: args.actorId,
        actor_run_id: args.actorRunId,
        platform: args.platform,
        scrape_status: args.scrapeStatus,
        publication_id: args.publicationId,
      },
    });
  } catch (e) {
    console.warn("logScrapeUsage failed", e);
  }
}

type SnapshotMini = {
  publication_id: string;
  fetched_at: string;
  scrape_status: ScrapeStatus;
};

type NormalizedMetrics = {
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  save_count: number | null;
  view_count: number | null;
  bookmark_count: number | null;
  quote_count: number | null;
  reaction_count: number | null;
  engagement_rate: number | null;
  availability_notes: string | null;
};

type NormalizedEmbed = {
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_url: string | null;
  caption: string | null;
  media_type: "image" | "video" | "carousel" | "text" | "unknown";
  media_url: string | null;
  media_urls: string[] | null;
  media_aspect_ratio: number | null;
  posted_at: string | null;
};

type ScrapeResult = {
  ok: boolean;
  status: ScrapeStatus;
  errorMessage: string | null;
  metrics: NormalizedMetrics | null;
  embed: NormalizedEmbed | null;
  raw: unknown;
  actorRunId: string | null;
  actorId: string;
};

// ----------------------------------------------------- Helpers

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function aspect(w: unknown, h: unknown): number | null {
  const wn = numOrNull(w);
  const hn = numOrNull(h);
  if (!wn || !hn) return null;
  return Math.round((wn / hn) * 1000) / 1000;
}

function engagementRate(
  likes: number | null,
  comments: number | null,
  shares: number | null,
  views: number | null,
): number | null {
  if (!views || views <= 0) return null;
  const eng = (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
  if (eng <= 0) return null;
  return Math.round((eng / views) * 10000) / 10000;
}

function classifyApifyError(status: number, body: string): { isBlocked: boolean } {
  const isBlocked =
    status === 403 ||
    body.includes("Monthly usage hard limit") ||
    body.includes("usage-limit");
  return { isBlocked };
}

function failed(actorId: string, actorRunId: string | null, msg: string, raw: unknown = null): ScrapeResult {
  return {
    ok: false,
    status: "failed",
    errorMessage: msg,
    metrics: null, embed: null, raw,
    actorRunId, actorId,
  };
}

// ----------------------------------------------------- Apify — Instagram

const IG_ACTOR_ID = "apify/instagram-scraper";

async function scrapeInstagram(liveUrl: string): Promise<ScrapeResult> {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(IG_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directUrls: [liveUrl],
        resultsType: "posts",
        resultsLimit: 1,
        addParentData: false,
      }),
    });
  } catch (ex) {
    return failed(IG_ACTOR_ID, null, `network: ${(ex as Error).message}`);
  }

  const actorRunId =
    res.headers.get("x-apify-act-run-id") ?? res.headers.get("x-apify-run-id") ?? null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const { isBlocked } = classifyApifyError(res.status, text);
    return {
      ok: false,
      status: isBlocked ? "blocked" : "failed",
      errorMessage: `apify ${res.status}: ${text.slice(0, 300)}`,
      metrics: null, embed: null, raw: null,
      actorRunId, actorId: IG_ACTOR_ID,
    };
  }

  const items = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return failed(IG_ACTOR_ID, actorRunId, "Apify returned no items for this URL", items);

  const likes      = numOrNull(item.likesCount);
  const comments   = numOrNull(item.commentsCount);
  const videoViews = numOrNull(item.videoViewCount ?? item.videoPlayCount);
  const carousel   = Array.isArray(item.childPosts) ? (item.childPosts as Array<Record<string, unknown>>) : null;

  const metrics: NormalizedMetrics = {
    like_count: likes,
    comment_count: comments,
    share_count: null,
    save_count: null,
    view_count: videoViews,
    bookmark_count: null,
    quote_count: null,
    reaction_count: null,
    engagement_rate: engagementRate(likes, comments, null, videoViews),
    availability_notes:
      "IG: share / save / bookmark counts not exposed via apify/instagram-scraper",
  };

  const carouselUrls = carousel
    ? carousel.map((c) => (typeof c.displayUrl === "string" ? c.displayUrl : null)).filter((s): s is string => Boolean(s))
    : null;
  const isRealCarousel = (carouselUrls?.length ?? 0) > 1;
  const mediaType: NormalizedEmbed["media_type"] =
    isRealCarousel ? "carousel" : item.type === "Video" ? "video" : "image";

  const embed: NormalizedEmbed = {
    author_handle: typeof item.ownerUsername === "string" ? item.ownerUsername : null,
    author_display_name: typeof item.ownerFullName === "string" ? item.ownerFullName : null,
    author_avatar_url: null,
    caption: typeof item.caption === "string" ? item.caption : null,
    media_type: mediaType,
    media_url: typeof item.displayUrl === "string" ? item.displayUrl : null,
    media_urls: isRealCarousel ? carouselUrls : null,
    media_aspect_ratio: aspect(item.dimensionsWidth, item.dimensionsHeight),
    posted_at: typeof item.timestamp === "string" ? item.timestamp : null,
  };

  const partial = !embed.media_url && !embed.caption;

  return {
    ok: true,
    status: partial ? "partial" : "ok",
    errorMessage: null,
    metrics, embed, raw: item,
    actorRunId, actorId: IG_ACTOR_ID,
  };
}

// ----------------------------------------------------- Apify — LinkedIn

// supreme_coder/linkedin-post broke ~2026-06-01 (LinkedIn markup change →
// crashed on every URL, returning {error,inputUrl}). Swapped to
// apimaestro/linkedin-post-detail (no-cookies, single post URL or activity
// id → stats.total_reactions/comments/shares + author + media). Verified
// 2026-06-03 against Bamboo Bear's 3 live posts.
const LINKEDIN_ACTOR_ID = "apimaestro/linkedin-post-detail";

// ".../in/theshrutimishra?…" → "theshrutimishra"; ".../company/drinkbamboobear/posts" → "drinkbamboobear".
function parseLinkedInHandle(profileUrl: string | null): string | null {
  if (!profileUrl) return null;
  const m = /\/(?:in|company|school|showcase)\/([^/?#]+)/i.exec(profileUrl);
  return m ? decodeURIComponent(m[1]) : null;
}

async function scrapeLinkedIn(liveUrl: string): Promise<ScrapeResult> {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(LINKEDIN_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  // Strip query string (utm_*, miniProfileUrn, …) — the actor resolves the
  // post from the slug/activity id; a clean URL avoids parser edge cases.
  const cleanUrl = liveUrl.split("?")[0];

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_urls: [cleanUrl] }),
    });
  } catch (ex) {
    return failed(LINKEDIN_ACTOR_ID, null, `network: ${(ex as Error).message}`);
  }

  const actorRunId =
    res.headers.get("x-apify-act-run-id") ?? res.headers.get("x-apify-run-id") ?? null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const { isBlocked } = classifyApifyError(res.status, text);
    return {
      ok: false,
      status: isBlocked ? "blocked" : "failed",
      errorMessage: `apify ${res.status}: ${text.slice(0, 300)}`,
      metrics: null, embed: null, raw: null,
      actorRunId, actorId: LINKEDIN_ACTOR_ID,
    };
  }

  const items = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  const raw = Array.isArray(items) ? items[0] : null;
  if (!raw) {
    return failed(LINKEDIN_ACTOR_ID, actorRunId, "apimaestro/linkedin-post-detail returned no items for this URL", items);
  }
  const item = raw as {
    post?: { text?: unknown; type?: unknown; created_at?: { timestamp?: unknown; date?: unknown } };
    author?: { name?: unknown; profile_url?: unknown; profile_picture?: unknown };
    media?: Array<{ type?: unknown; url?: unknown }>;
    stats?: { total_reactions?: unknown; comments?: unknown; shares?: unknown };
    error?: unknown;
  };

  // Surface explicit error items / empty shells as real failures rather than
  // null-metric `partial`s — keeps actor outages alertable (see the 2026-06
  // supreme_coder breakage RCA).
  if (typeof item.error === "string" && item.error.trim()) {
    return failed(LINKEDIN_ACTOR_ID, actorRunId, `apimaestro/linkedin-post-detail actor error: ${item.error.slice(0, 240)}`, raw);
  }
  if (!item.stats && !item.post) {
    return failed(LINKEDIN_ACTOR_ID, actorRunId, "apimaestro/linkedin-post-detail returned an item with no post/stats", raw);
  }

  const stats = item.stats ?? {};
  const metrics: NormalizedMetrics = {
    like_count: numOrNull(stats.total_reactions),
    reaction_count: numOrNull(stats.total_reactions),
    comment_count: numOrNull(stats.comments),
    share_count: numOrNull(stats.shares),
    save_count: null,
    view_count: null,
    bookmark_count: null,
    quote_count: null,
    engagement_rate: null,
    availability_notes:
      "LinkedIn: like_count and reaction_count are the same rolled-up total_reactions (sum of like/empathy/praise/etc.). View counts not exposed for public posts.",
  };

  const post = item.post ?? {};
  const author = item.author ?? {};
  const media = (Array.isArray(item.media) ? item.media : []).filter(
    (m): m is { type?: unknown; url: string } => !!m && typeof m.url === "string",
  );
  const mediaUrls = media.map((m) => m.url);
  const mediaType: NormalizedEmbed["media_type"] =
    post.type === "video" || media.some((m) => m.type === "video") ? "video" :
    mediaUrls.length > 1 ? "carousel" :
    mediaUrls.length === 1 ? "image" : "text";

  const ts = post.created_at?.timestamp;
  const dateStr = post.created_at?.date;
  const postedAt =
    typeof ts === "number" ? new Date(ts).toISOString() :
    typeof dateStr === "string" ? new Date(`${dateStr.replace(" ", "T")}Z`).toISOString() :
    null;

  const embed: NormalizedEmbed = {
    author_handle: parseLinkedInHandle(typeof author.profile_url === "string" ? author.profile_url : null),
    author_display_name: typeof author.name === "string" ? author.name : null,
    author_avatar_url: typeof author.profile_picture === "string" ? author.profile_picture : null,
    caption: typeof post.text === "string" ? post.text : null,
    media_type: mediaType,
    media_url: mediaUrls[0] ?? null,
    media_urls: mediaUrls.length > 1 ? mediaUrls : null,
    media_aspect_ratio: null,
    posted_at: postedAt,
  };

  const partial = !embed.media_url && !embed.caption;

  return {
    ok: true,
    status: partial ? "partial" : "ok",
    errorMessage: null,
    metrics, embed, raw,
    actorRunId, actorId: LINKEDIN_ACTOR_ID,
  };
}

// ----------------------------------------------------- Apify — X (Twitter)

const X_ACTOR_ID = "scrape.badger/twitter-tweets-scraper";

function firstNum(item: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = item[k];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function twitterDateToIso(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function scrapeX(liveUrl: string): Promise<ScrapeResult> {
  const tweetId = liveUrl.match(/\/status\/(\d+)/)?.[1];
  if (!tweetId) return failed(X_ACTOR_ID, null, `Could not extract tweet id from URL: ${liveUrl}`);

  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(X_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tweetId }),
    });
  } catch (ex) {
    return failed(X_ACTOR_ID, null, `network: ${(ex as Error).message}`);
  }

  const actorRunId =
    res.headers.get("x-apify-act-run-id") ?? res.headers.get("x-apify-run-id") ?? null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const { isBlocked } = classifyApifyError(res.status, text);
    return {
      ok: false,
      status: isBlocked ? "blocked" : "failed",
      errorMessage: `apify ${res.status}: ${text.slice(0, 300)}`,
      metrics: null, embed: null, raw: null,
      actorRunId, actorId: X_ACTOR_ID,
    };
  }

  const items = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return failed(X_ACTOR_ID, actorRunId, "scrape.badger returned no items for this tweet id", items);

  const likes     = firstNum(item, "favorite_count");
  const reposts   = firstNum(item, "retweet_count");
  const views     = firstNum(item, "view_count", "views", "viewCount", "impression_count");
  const replies   = firstNum(item, "reply_count", "replies", "replyCount");
  const bookmarks = firstNum(item, "bookmark_count", "bookmarks", "bookmarkCount");
  const quotes    = firstNum(item, "quote_count", "quotes", "quoteCount");

  const missing: string[] = [];
  if (replies === null)   missing.push("reply_count");
  if (bookmarks === null) missing.push("bookmark_count");
  if (quotes === null)    missing.push("quote_count");

  const metrics: NormalizedMetrics = {
    like_count: likes,
    comment_count: replies,
    share_count: reposts,
    save_count: null,
    view_count: views,
    bookmark_count: bookmarks,
    quote_count: quotes,
    reaction_count: null,
    engagement_rate: engagementRate(likes, replies, reposts, views),
    availability_notes: missing.length ? `X: not exposed by scrape.badger: ${missing.join(", ")}` : null,
  };

  const mediaList = (Array.isArray(item.media)
    ? item.media
    : Array.isArray((item.extended_entities as Record<string, unknown> | undefined)?.media)
    ? (item.extended_entities as Record<string, unknown>).media
    : []) as Array<Record<string, unknown>>;
  const firstMedia = mediaList[0];
  const mediaUrl = typeof firstMedia?.media_url_https === "string" ? firstMedia.media_url_https : null;
  const mediaType: NormalizedEmbed["media_type"] =
    !mediaList.length ? "text" :
    firstMedia?.type === "video" || firstMedia?.type === "animated_gif" ? "video" :
    mediaList.length > 1 ? "carousel" : "image";

  const embed: NormalizedEmbed = {
    author_handle: typeof item.username === "string" ? item.username : null,
    author_display_name: typeof item.user_name === "string" ? item.user_name : null,
    author_avatar_url: typeof item.user_profile_image_url === "string" ? item.user_profile_image_url : null,
    caption: typeof item.full_text === "string" ? item.full_text : typeof item.text === "string" ? item.text : null,
    media_type: mediaType,
    media_url: mediaUrl,
    media_urls: mediaList.length > 1
      ? mediaList.map((m) => (typeof m.media_url_https === "string" ? m.media_url_https : null)).filter((s): s is string => Boolean(s))
      : null,
    media_aspect_ratio: null,
    posted_at: twitterDateToIso(item.created_at),
  };

  const partial = !embed.caption && !embed.media_url;

  return {
    ok: true,
    status: partial ? "partial" : "ok",
    errorMessage: null,
    metrics, embed, raw: item,
    actorRunId, actorId: X_ACTOR_ID,
  };
}

// ----------------------------------------------------- Dispatch

async function dispatchScrape(platform: Platform, liveUrl: string): Promise<ScrapeResult | null> {
  if (platform === "instagram") return scrapeInstagram(liveUrl);
  if (platform === "linkedin")  return scrapeLinkedIn(liveUrl);
  if (platform === "x")         return scrapeX(liveUrl);
  return null;
}

// ----------------------------------------------------- DB write

async function persistScrapeResult(
  client: SupabaseClient,
  publicationId: string,
  result: ScrapeResult,
): Promise<void> {
  const snapshotRow = {
    publication_id: publicationId,
    fetched_at: new Date().toISOString(),
    like_count: result.metrics?.like_count ?? null,
    comment_count: result.metrics?.comment_count ?? null,
    share_count: result.metrics?.share_count ?? null,
    save_count: result.metrics?.save_count ?? null,
    view_count: result.metrics?.view_count ?? null,
    bookmark_count: result.metrics?.bookmark_count ?? null,
    quote_count: result.metrics?.quote_count ?? null,
    reaction_count: result.metrics?.reaction_count ?? null,
    engagement_rate: result.metrics?.engagement_rate ?? null,
    availability_notes: result.metrics?.availability_notes ?? null,
    raw_payload: result.raw ?? null,
    actor_id: result.actorId,
    actor_run_id: result.actorRunId,
    scrape_status: result.status,
    error_message: result.errorMessage,
  };
  const { error: snapErr } = await client
    .from("post_engagement_snapshots")
    .insert(snapshotRow);
  if (snapErr) throw new Error(`Failed to write snapshot: ${snapErr.message}`);

  // Don't let a degraded/empty scrape (a `partial` with all-null author/
  // caption/media) clobber a previously-good embed with nulls — that's what
  // produced the "Unknown author", caption-less cards. Mirrors the Vercel
  // scraper-lib.ts persist guard + the last-good metrics fallback in db.js.
  const e = result.embed;
  const embedHasContent =
    !!e &&
    !!(
      e.author_display_name ||
      e.author_handle ||
      e.author_avatar_url ||
      e.caption ||
      e.media_url ||
      (Array.isArray(e.media_urls) && e.media_urls.length > 0)
    );

  if (result.ok && result.embed && embedHasContent) {
    const embedRow = {
      publication_id: publicationId,
      author_handle: result.embed.author_handle,
      author_display_name: result.embed.author_display_name,
      author_avatar_url: result.embed.author_avatar_url,
      caption: result.embed.caption,
      media_type: result.embed.media_type,
      media_url: result.embed.media_url,
      media_urls: result.embed.media_urls,
      media_aspect_ratio: result.embed.media_aspect_ratio,
      posted_at: result.embed.posted_at,
      last_refreshed_at: new Date().toISOString(),
      refresh_status: result.status === "partial" ? "stale" : "ok",
    };
    const { error: embedErr } = await client
      .from("post_embed_cache")
      .upsert(embedRow, { onConflict: "publication_id" });
    if (embedErr) console.warn("post_embed_cache upsert failed", embedErr);
  }
}

// ----------------------------------------------------- Cron orchestrator

type RunResult = {
  total_eligible: number;
  due: number;
  processed: number;
  failed: number;
  blocked: number;
  results: Array<{ publicationId: string; platform: Platform; scrape_status: string; error?: string | null }>;
};

async function runCron(client: SupabaseClient): Promise<RunResult> {
  // ----- Load eligible publications -----
  // Soft-deleted rows (deleted_at IS NOT NULL) are excluded — users can
  // click "Remove post" in the Live Posts grid to stop tracking a
  // publication without losing historical engagement snapshots. Filter
  // added 2026-05-22 alongside migration 0057.
  const { data: pubs, error: pubErr } = await client
    .from("post_plan_publications")
    .select("id, platform, live_url, published_at, post_plan_id, post_plans(account_id)")
    .in("platform", ["instagram", "linkedin", "x"])
    .not("live_url", "is", null)
    .is("deleted_at", null);
  if (pubErr) throw new Error(`Load publications failed: ${pubErr.message}`);
  const publications = (pubs as PubRow[]) ?? [];

  if (publications.length === 0) {
    return { total_eligible: 0, due: 0, processed: 0, failed: 0, blocked: 0, results: [] };
  }

  // ----- Load latest snapshot per publication + last-3 statuses -----
  const ids = publications.map((p) => p.id);
  const { data: snapsRaw, error: snapErr } = await client
    .from("post_engagement_snapshots")
    .select("publication_id, fetched_at, scrape_status")
    .in("publication_id", ids)
    .order("fetched_at", { ascending: false });
  if (snapErr) throw new Error(`Load snapshots failed: ${snapErr.message}`);

  const latestByPub = new Map<string, SnapshotMini>();
  const last3StatusesByPub = new Map<string, string[]>();
  for (const row of (snapsRaw as SnapshotMini[]) ?? []) {
    if (!latestByPub.has(row.publication_id)) latestByPub.set(row.publication_id, row);
    const list = last3StatusesByPub.get(row.publication_id) ?? [];
    if (list.length < 3) {
      list.push(row.scrape_status);
      last3StatusesByPub.set(row.publication_id, list);
    }
  }

  // ----- Decide which are due -----
  const now = Date.now();
  type DueEntry = { pub: PubRow; lastFetchedAt: string | null };
  const due: DueEntry[] = [];
  for (const pub of publications) {
    const ageMs = now - new Date(pub.published_at).getTime();
    let intervalMs = refreshIntervalForAge(ageMs);
    const last3 = last3StatusesByPub.get(pub.id) ?? [];
    if (last3.length === 3 && last3.every((s) => s === "failed" || s === "blocked")) {
      intervalMs = Math.max(intervalMs, ONE_WEEK);
    }
    const latest = latestByPub.get(pub.id);
    if (!latest) {
      due.push({ pub, lastFetchedAt: null });
      continue;
    }
    const sinceMs = now - new Date(latest.fetched_at).getTime();
    if (sinceMs >= intervalMs) due.push({ pub, lastFetchedAt: latest.fetched_at });
  }

  // Oldest-snapshot first; never-scraped at the very top.
  due.sort((a, b) => {
    const ta = a.lastFetchedAt ? new Date(a.lastFetchedAt).getTime() : 0;
    const tb = b.lastFetchedAt ? new Date(b.lastFetchedAt).getTime() : 0;
    return ta - tb;
  });

  const batch = due.slice(0, MAX_SCRAPES_PER_RUN);

  // ----- Scrape in chunks of SCRAPE_CONCURRENCY -----
  const results: RunResult["results"] = [];
  for (let i = 0; i < batch.length; i += SCRAPE_CONCURRENCY) {
    const slice = batch.slice(i, i + SCRAPE_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map(async (entry) => {
        const pub = entry.pub;
        if (!pub.live_url) return null;
        const startedAt = Date.now();
        const scraped = await dispatchScrape(pub.platform, pub.live_url);
        if (!scraped) return null;
        const latencyMs = Date.now() - startedAt;
        await persistScrapeResult(client, pub.id, scraped);
        // Fire-and-forget per-scrape telemetry into service_usage_log.
        const planAccount = Array.isArray(pub.post_plans) ? pub.post_plans[0] : pub.post_plans;
        void logScrapeUsage(client, {
          accountId: planAccount?.account_id ?? null,
          publicationId: pub.id,
          platform: pub.platform,
          actorId: scraped.actorId,
          actorRunId: scraped.actorRunId,
          scrapeStatus: scraped.status,
          errorMessage: scraped.errorMessage,
          latencyMs,
        });
        return { pub, scraped };
      })
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const pub = slice[j].pub;
      if (s.status === "fulfilled" && s.value) {
        results.push({
          publicationId: pub.id,
          platform: pub.platform,
          scrape_status: s.value.scraped.status,
          error: s.value.scraped.errorMessage,
        });
      } else if (s.status === "rejected") {
        results.push({
          publicationId: pub.id,
          platform: pub.platform,
          scrape_status: "failed",
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
  }

  const failedCount  = results.filter((r) => r.scrape_status === "failed").length;
  const blockedCount = results.filter((r) => r.scrape_status === "blocked").length;

  return {
    total_eligible: publications.length,
    due: due.length,
    processed: results.length,
    failed: failedCount,
    blocked: blockedCount,
    results,
  };
}

// Email alerts: deferred. The `cron_run_log` row written below carries
// failed/blocked counts and per-publication detail, so a single SELECT
// shows you what went wrong. When we want push alerts, add a new
// `engagement-cron-alert` template to send-email and call it here.

// ----------------------------------------------------- HTTP entrypoint

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

  if (!CRON_SECRET)     return jsonResponse({ error: "CRON_SECRET not configured" }, 500);
  if (!SUPABASE_URL || !SERVICE_ROLE) return jsonResponse({ error: "Supabase env not configured" }, 500);
  if (!APIFY_API_TOKEN) return jsonResponse({ error: "APIFY_API_TOKEN not configured" }, 500);

  const auth = (req.headers.get("Authorization") ?? "").trim();
  if (auth !== `Bearer ${CRON_SECRET}`) return jsonResponse({ error: "Unauthorized" }, 401);

  const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let runResult: RunResult | null = null;
  let runError: string | null = null;

  try {
    runResult = await runCron(client);
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;

  // Always log the run, success or fail. RLS-free table, written via
  // service role.
  try {
    await client.from("cron_run_log").insert({
      function_name: "engagement-refresh",
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      status: runError ? "error" : "ok",
      pubs_eligible: runResult?.total_eligible ?? null,
      pubs_due: runResult?.due ?? null,
      pubs_processed: runResult?.processed ?? null,
      pubs_failed: runResult?.failed ?? null,
      pubs_blocked: runResult?.blocked ?? null,
      error_message: runError,
      details: runResult?.results ?? null,
    });
  } catch (e) {
    console.warn("Failed to write cron_run_log row", e);
  }

  if (runError) return jsonResponse({ ok: false, error: runError, durationMs }, 500);
  return jsonResponse({ ok: true, ...runResult, durationMs });
});
