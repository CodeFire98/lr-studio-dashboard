// =====================================================================
// Engagement scraper shared helpers — imported by both /api/engagement/
// refresh (on-demand) and /api/engagement/refresh-cron (scheduled).
//
// **Filename has no leading underscore and the import statements
// use the `.js` extension** (e.g. `from "./scraper-lib.js"`). Both
// matter under Node 24's strict ESM resolution:
//   - Node 24 ESM doesn't auto-extend `./scraper-lib` → `./scraper-
//     lib.js`. Missing extension = `ERR_MODULE_NOT_FOUND` at runtime
//     (even though the source file is `.ts`, the compiled artifact is
//     `.js` and that's what the runtime resolver sees). All four
//     `web/api/ai/*.ts` routes import their shared helpers with `.js`
//     extensions for the same reason.
//   - Leading underscore on the filename was a red herring during
//     the 2026-05-14 debug — earlier attempt was `_shared.ts` and
//     the rename to `scraper-lib.ts` happened at the same time as
//     the extension fix; the extension is what actually fixed it.
//     Underscore-prefix is still bad style for shared helpers (the
//     `_` is reserved by convention for Vercel route-skip behavior
//     — see `feedback_vercel_underscore_prefix.md`); keeping the
//     non-underscore name regardless.
//
// Why a shared module instead of duplicating: PR 7 added the cron
// route, which needs the same scrapeInstagram + scrapeLinkedIn logic
// the on-demand route uses. Duplicating would mean every bugfix has
// to land in two places; centralising here keeps the dispatch + the
// normalized output schema honest across both callers.
//
// Note: this file has no top-level side effects beyond reading
// `process.env.APIFY_API_TOKEN` once. All HTTP work happens inside
// the exported async functions.
// =====================================================================

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// ---------------------------------------------------------------- Types

export type Platform = "instagram" | "linkedin" | "x";

export type ScrapeStatus = "ok" | "partial" | "failed" | "blocked";

export type NormalizedMetrics = {
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

export type NormalizedEmbed = {
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

export type ScrapeResult = {
  ok: boolean;
  status: ScrapeStatus;
  errorMessage: string | null;
  metrics: NormalizedMetrics | null;
  embed: NormalizedEmbed | null;
  raw: unknown;
  actorRunId: string | null;
  actorId: string;       // attribute the row to the actor that produced it
};

export type PublicationLite = {
  id: string;
  platform: Platform;
  live_url: string | null;
};

// ---------------------------------------------------------------- Helpers

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

function classifyApifyError(status: number, body: string): {
  isBlocked: boolean;
} {
  const isBlocked =
    status === 403 ||
    body.includes("Monthly usage hard limit") ||
    body.includes("usage-limit");
  return { isBlocked };
}

// ----------------------------------------------------- Apify — Instagram

export const IG_ACTOR_ID = "apify/instagram-scraper";

type ApifyInstagramItem = {
  id?: string;
  shortCode?: string;
  type?: string; // "Image" | "Video" | "Sidecar"
  caption?: string;
  url?: string;
  displayUrl?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  timestamp?: string;
  ownerUsername?: string;
  ownerFullName?: string;
  dimensionsHeight?: number;
  dimensionsWidth?: number;
  childPosts?: Array<{ displayUrl?: string; type?: string }>;
};

export async function scrapeInstagram(liveUrl: string): Promise<ScrapeResult> {
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
    res.headers.get("x-apify-act-run-id") ??
    res.headers.get("x-apify-run-id") ??
    null;

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

  const items = (await res.json().catch(() => [])) as ApifyInstagramItem[];
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return failed(IG_ACTOR_ID, actorRunId, "Apify returned no items for this URL", items);

  const likes      = numOrNull(item.likesCount);
  const comments   = numOrNull(item.commentsCount);
  const videoViews = numOrNull(item.videoViewCount ?? item.videoPlayCount);
  const carousel   = Array.isArray(item.childPosts) ? item.childPosts : null;

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

  // Real-data dry-run on 2026-05-12 returned `type:"Image"` with a
  // non-empty `childPosts` array whose entries' displayUrls were all
  // missing. Treat "carousel with zero usable child URLs" as a single
  // image so the badge + slide indicators don't render misleading "0".
  const carouselUrls = carousel
    ? carousel.map((c) => c.displayUrl ?? null).filter((s): s is string => Boolean(s))
    : null;
  const isRealCarousel = (carouselUrls?.length ?? 0) > 1;
  const mediaType: NormalizedEmbed["media_type"] =
    isRealCarousel
      ? "carousel"
      : item.type === "Video"
      ? "video"
      : "image";

  const embed: NormalizedEmbed = {
    author_handle: item.ownerUsername ?? null,
    author_display_name: item.ownerFullName ?? null,
    author_avatar_url: null,
    caption: item.caption ?? null,
    media_type: mediaType,
    media_url: item.displayUrl ?? null,
    media_urls: isRealCarousel ? carouselUrls : null,
    media_aspect_ratio: aspect(item.dimensionsWidth, item.dimensionsHeight),
    posted_at: item.timestamp ?? null,
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
// the actor crashed on every URL, returning {error,inputUrl}). Swapped to
// apimaestro/linkedin-post-detail (no-cookies, single post URL or activity
// id, returns stats.total_reactions/comments/shares + author + media).
// Verified 2026-06-03 against Bamboo Bear's 3 live posts (e.g. 193 reactions
// / 14 comments / 2 shares, matching our last good supreme_coder scrape).
export const LINKEDIN_ACTOR_ID = "apimaestro/linkedin-post-detail";

type ApiMaestroLinkedInItem = {
  post?: {
    id?: string;
    url?: string;
    text?: string;
    type?: string;                              // "image" | "video" | "article" | …
    created_at?: { timestamp?: number; date?: string; relative?: string };
    urn?: unknown;
  };
  author?: {
    name?: string;                              // "Shruti Mishra" / "Bamboo Bear"
    headline?: string;
    profile_url?: string;                       // …/in/<handle> or …/company/<handle>/posts
    profile_picture?: string;
  };
  media?: Array<{ type?: string; url?: string }>;
  stats?: {
    total_reactions?: number;                   // rolled-up sum of all reaction types
    reactions?: Record<string, number>;         // breakdown (not persisted)
    comments?: number;
    shares?: number;
  };
  // Defensive: if the actor ever returns an explicit error item.
  error?: string;
};

// Derive a clean handle from a LinkedIn profile/company URL, e.g.
// ".../in/theshrutimishra?miniProfileUrn=…" → "theshrutimishra" and
// ".../company/drinkbamboobear/posts" → "drinkbamboobear".
function parseLinkedInHandle(profileUrl: string | null | undefined): string | null {
  if (!profileUrl) return null;
  const m = /\/(?:in|company|school|showcase)\/([^/?#]+)/i.exec(profileUrl);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function scrapeLinkedIn(liveUrl: string): Promise<ScrapeResult> {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(LINKEDIN_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  // Strip the query string (utm_*, miniProfileUrn, rcm, …) — the actor
  // resolves the post from the slug/activity id and a clean URL avoids
  // parser edge cases.
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
    res.headers.get("x-apify-act-run-id") ??
    res.headers.get("x-apify-run-id") ??
    null;

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

  const items = (await res.json().catch(() => [])) as ApiMaestroLinkedInItem[];
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return failed(LINKEDIN_ACTOR_ID, actorRunId, "apimaestro/linkedin-post-detail returned no items for this URL", items);

  // Surface explicit error items / empty shells as real failures rather than
  // null-metric `partial`s — keeps actor outages alertable (see the 2026-06
  // supreme_coder breakage RCA).
  if (typeof item.error === "string" && item.error.trim()) {
    return failed(LINKEDIN_ACTOR_ID, actorRunId, `apimaestro/linkedin-post-detail actor error: ${item.error.slice(0, 240)}`, item);
  }
  if (!item.stats && !item.post) {
    return failed(LINKEDIN_ACTOR_ID, actorRunId, "apimaestro/linkedin-post-detail returned an item with no post/stats", item);
  }

  const stats = item.stats ?? {};
  const reactions = numOrNull(stats.total_reactions);
  const comments  = numOrNull(stats.comments);
  const shares    = numOrNull(stats.shares);

  const metrics: NormalizedMetrics = {
    like_count: reactions,
    reaction_count: reactions,
    comment_count: comments,
    share_count: shares,
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
  const media = (Array.isArray(item.media) ? item.media : []).filter((m) => m && typeof m.url === "string");
  const mediaUrls = media.map((m) => m.url as string);
  const mediaType: NormalizedEmbed["media_type"] =
    post.type === "video" || media.some((m) => m.type === "video")
      ? "video"
      : mediaUrls.length > 1
      ? "carousel"
      : mediaUrls.length === 1
      ? "image"
      : "text";

  const ts = post.created_at?.timestamp;
  const postedAt =
    typeof ts === "number"
      ? new Date(ts).toISOString()
      : post.created_at?.date
      ? new Date(`${post.created_at.date.replace(" ", "T")}Z`).toISOString()
      : null;

  const embed: NormalizedEmbed = {
    author_handle: parseLinkedInHandle(author.profile_url),
    author_display_name: author.name ?? null,
    author_avatar_url: author.profile_picture ?? null,
    caption: post.text ?? null,
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
    metrics, embed, raw: item,
    actorRunId, actorId: LINKEDIN_ACTOR_ID,
  };
}

// ----------------------------------------------------- Apify — X (Twitter)
//
// scrape.badger/twitter-tweets-scraper — won the 2026-05-14 second-pass
// shootout after the first round disqualified every Apify X scraper
// (hostile pricing, demo data, profile-only input, etc.) and the
// external option (TwitterAPI.io) blocked us at their Google OAuth.
//
// Why this actor:
//   - $0.0002/result ($0.20/1K) — cheapest tweet-by-ID Apify actor.
//   - 700k+ runs, 1.2k users — mature.
//   - Takes `{ id: "<numeric tweet id>" }` — confirmed by real-data run.
//     (The other two input shapes its docs hint at — `tweets: "csv"`
//     and `tweets: [...]` — both error with HTTP 400. The third shape
//     `id` works cleanly. Documented inline so the next reader doesn't
//     repeat the mistake.)
//
// Output schema confirmed via dry-run against the user's real Bamboo
// Bear tweet (https://x.com/DrinkBambooBear/status/2052954209377497405):
//   id, text, full_text, created_at, lang,
//   user_id, username, user_name, user_profile_image_url,
//   user_description, user_location, user_url,
//   user_followers_count, user_following_count, user_tweet_count,
//   user_verified, user_is_blue_verified, user_created_at,
//   favorite_count, retweet_count
// (Plus a `views` field that wasn't in the first-20 keys snapshot but
//  was confirmed by the preflight's signals heuristic — value `82`.)
//
// **Reply count + bookmark count + quote count are NOT in the visible
// schema**. The actor may or may not expose them past key #20. The
// normalizer below checks several candidate field names; if none match,
// the metric stays null with an `availability_notes` string. The
// safest path is "don't pretend we have data we don't" — same pattern
// as IG's missing share_count.

export const X_ACTOR_ID = "scrape.badger/twitter-tweets-scraper";

type ScrapeBadgerTweetItem = {
  id?: string | number;
  text?: string;
  full_text?: string;
  created_at?: string;            // Twitter format: "Sat May 09 03:30:00 +0000 2026"
  lang?: string;
  // Author
  user_id?: string | number;
  username?: string;              // handle, e.g. "DrinkBambooBear"
  user_name?: string;             // display name
  user_profile_image_url?: string;
  // Engagement — confirmed field names
  favorite_count?: number;        // likes
  retweet_count?: number;         // retweets/reposts
  // Engagement — fields we hope exist past key #20. We probe several
  // plausible names; whichever is present wins, otherwise null.
  view_count?: number;
  views?: number;
  viewCount?: number;
  impression_count?: number;
  reply_count?: number;
  replies?: number;
  replyCount?: number;
  bookmark_count?: number;
  bookmarks?: number;
  bookmarkCount?: number;
  quote_count?: number;
  quotes?: number;
  quoteCount?: number;
  // Media for the embed card — same probe pattern as above.
  media?: Array<{ media_url_https?: string; type?: string }>;
  extended_entities?: { media?: Array<{ media_url_https?: string; type?: string }> };
};

function firstNum(item: ScrapeBadgerTweetItem, ...keys: Array<keyof ScrapeBadgerTweetItem>): number | null {
  for (const k of keys) {
    const v = item[k];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Convert Twitter's "Sat May 09 03:30:00 +0000 2026" → ISO 8601.
// JavaScript Date parses this format natively in Node, but on older
// runtimes it can return NaN — defensive fallback returns null so we
// don't write garbage into `posted_at`.
function twitterDateToIso(s: string | undefined | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function scrapeX(liveUrl: string): Promise<ScrapeResult> {
  // The actor wants a numeric tweet id, not a URL. Pull it from the
  // /status/<id> segment. URLs that don't match are a configuration
  // error — return failed instead of trying anyway.
  const tweetId = liveUrl.match(/\/status\/(\d+)/)?.[1];
  if (!tweetId) {
    return failed(X_ACTOR_ID, null, `Could not extract tweet id from URL: ${liveUrl}`);
  }

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
    res.headers.get("x-apify-act-run-id") ??
    res.headers.get("x-apify-run-id") ??
    null;

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

  const items = (await res.json().catch(() => [])) as ScrapeBadgerTweetItem[];
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) {
    return failed(X_ACTOR_ID, actorRunId, "scrape.badger returned no items for this tweet id", items);
  }

  const likes      = firstNum(item, "favorite_count");
  const reposts    = firstNum(item, "retweet_count");
  const views      = firstNum(item, "view_count", "views", "viewCount", "impression_count");
  const replies    = firstNum(item, "reply_count", "replies", "replyCount");
  const bookmarks  = firstNum(item, "bookmark_count", "bookmarks", "bookmarkCount");
  const quotes     = firstNum(item, "quote_count", "quotes", "quoteCount");

  // Honest availability note — explain which fields we couldn't find,
  // matching IG's pattern. The first integration run will surface
  // which counts are actually exposed; after that we can tighten this.
  const missing: string[] = [];
  if (replies === null)   missing.push("reply_count");
  if (bookmarks === null) missing.push("bookmark_count");
  if (quotes === null)    missing.push("quote_count");

  const metrics: NormalizedMetrics = {
    like_count: likes,
    comment_count: replies,
    share_count: reposts,
    save_count: null,            // X doesn't have a save concept; bookmark is the closest
    view_count: views,
    bookmark_count: bookmarks,
    quote_count: quotes,
    reaction_count: null,        // X doesn't have a unified reaction count
    engagement_rate: engagementRate(likes, replies, reposts, views),
    availability_notes: missing.length
      ? `X: not exposed by scrape.badger: ${missing.join(", ")}`
      : null,
  };

  // Pick the first available media URL for the embed hero. Twitter's
  // media URLs live under `media` or `extended_entities.media` —
  // probe both. If neither exists, it's a text-only tweet (most are).
  const mediaList = item.media ?? item.extended_entities?.media ?? [];
  const firstMedia = mediaList[0];
  const mediaUrl = firstMedia?.media_url_https ?? null;
  const mediaType: NormalizedEmbed["media_type"] =
    !mediaList.length
      ? "text"
      : firstMedia?.type === "video" || firstMedia?.type === "animated_gif"
      ? "video"
      : mediaList.length > 1
      ? "carousel"
      : "image";

  const embed: NormalizedEmbed = {
    author_handle: item.username ?? null,
    author_display_name: item.user_name ?? null,
    author_avatar_url: item.user_profile_image_url ?? null,
    caption: item.full_text ?? item.text ?? null,
    media_type: mediaType,
    media_url: mediaUrl,
    media_urls: mediaList.length > 1 ? mediaList.map((m) => m.media_url_https ?? null).filter((s): s is string => Boolean(s)) : null,
    media_aspect_ratio: null,    // not in this actor's output
    posted_at: twitterDateToIso(item.created_at),
  };

  // Partial = counts present but the visible card has nothing to render.
  // For X, text-only tweets are normal so a missing media_url isn't
  // partial as long as there's caption text.
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

// Single entry-point both callers use. Returns null when the platform
// isn't supported (none currently — X was re-enabled 2026-05-14).
export async function dispatchScrape(platform: Platform, liveUrl: string): Promise<ScrapeResult | null> {
  if (platform === "instagram") return scrapeInstagram(liveUrl);
  if (platform === "linkedin")  return scrapeLinkedIn(liveUrl);
  if (platform === "x")         return scrapeX(liveUrl);
  return null;
}

// ----------------------------------------------------- Internal helpers

function failed(actorId: string, actorRunId: string | null, msg: string, raw: unknown = null): ScrapeResult {
  return {
    ok: false,
    status: "failed",
    errorMessage: msg,
    metrics: null,
    embed: null,
    raw,
    actorRunId,
    actorId,
  };
}

// ----------------------------------------------------- DB write helpers
//
// Both routes write the same snapshot + embed cache rows after a
// scrape. Centralising the write keeps the shape consistent and lets
// the cron route batch many scrapes without each one re-implementing
// the same logic. The route still uses its own SupabaseClient instance
// (service-role) — we just thread the result through.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function persistScrapeResult(
  serviceClient: SupabaseClient,
  publicationId: string,
  result: ScrapeResult,
): Promise<{ snapshot: unknown; embed: unknown }> {
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
  const { data: insertedSnapshot, error: snapErr } = await serviceClient
    .from("post_engagement_snapshots")
    .insert(snapshotRow)
    .select("*")
    .single();
  if (snapErr) throw new Error(`Failed to write snapshot: ${snapErr.message}`);

  // Only write the embed cache when the scrape actually returned content.
  // A degraded/empty scrape (e.g. a `partial` whose author/caption/media all
  // came back null) must NOT clobber a previously-good embed with nulls —
  // that's what produced the "Unknown author", caption-less cards. This is
  // the embed-side analog of the last-good metrics fallback in db.js: a
  // failed refresh means "couldn't read it this time", not "the post has no
  // author/content now". A genuinely good scrape always repopulates it.
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

  let upsertedEmbed: unknown = null;
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
    const { data, error: embedErr } = await serviceClient
      .from("post_embed_cache")
      .upsert(embedRow, { onConflict: "publication_id" })
      .select("*")
      .single();
    if (embedErr) {
      // Snapshot already written; embed-cache failure is a soft error.
      console.warn("post_embed_cache upsert failed", embedErr);
    } else {
      upsertedEmbed = data;
    }
  }

  return { snapshot: insertedSnapshot, embed: upsertedEmbed };
}
