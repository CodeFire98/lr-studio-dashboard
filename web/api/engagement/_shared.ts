// =====================================================================
// Engagement scraper shared helpers — imported by both /api/engagement/
// refresh (on-demand) and /api/engagement/refresh-cron (scheduled).
//
// Leading underscore tells Vercel "this isn't a route" — the file
// won't be deployed as `/api/engagement/_shared` (it'd return SPA
// fallback if anyone tried) but it's importable from sibling routes
// in the same bundle. See feedback_vercel_underscore_prefix.md.
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

export const LINKEDIN_ACTOR_ID = "supreme_coder/linkedin-post";

type SupremeCoderLinkedInItem = {
  type?: string;
  images?: string[];
  isActivity?: boolean;
  urn?: string;
  url?: string;
  timeSincePosted?: string;
  text?: string;
  numLikes?: number;
  numComments?: number;
  numShares?: number;
  reactions?: unknown;
  comments?: unknown;
  authorName?: string;               // "Shruti Mishra"
  authorProfileId?: string;          // "theshrutimishra"
  authorProfilePicture?: string;     // media.licdn.com URL
  authorProfileUrl?: string;
  authorType?: string;
  authorUrn?: string;
  postedAtISO?: string;
  postedAtTimestamp?: number;
};

export async function scrapeLinkedIn(liveUrl: string): Promise<ScrapeResult> {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(LINKEDIN_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [liveUrl] }),
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

  const items = (await res.json().catch(() => [])) as SupremeCoderLinkedInItem[];
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return failed(LINKEDIN_ACTOR_ID, actorRunId, "supreme_coder/linkedin-post returned no items for this URL", items);

  const likes    = numOrNull(item.numLikes);
  const comments = numOrNull(item.numComments);
  const shares   = numOrNull(item.numShares);

  const metrics: NormalizedMetrics = {
    like_count: likes,
    reaction_count: likes,
    comment_count: comments,
    share_count: shares,
    save_count: null,
    view_count: null,
    bookmark_count: null,
    quote_count: null,
    engagement_rate: null,
    availability_notes:
      "LinkedIn: like_count and reaction_count point at the same number (public scrapes return a single rolled-up reactions count). View counts not exposed for public posts.",
  };

  const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
  const mediaType: NormalizedEmbed["media_type"] =
    item.type === "video"
      ? "video"
      : images.length > 1
      ? "carousel"
      : images.length === 1
      ? "image"
      : "text";

  const embed: NormalizedEmbed = {
    author_handle: item.authorProfileId ?? null,
    author_display_name: item.authorName ?? null,
    author_avatar_url: item.authorProfilePicture ?? null,
    caption: item.text ?? null,
    media_type: mediaType,
    media_url: images[0] ?? null,
    media_urls: images.length > 1 ? images : null,
    media_aspect_ratio: null,
    posted_at:
      item.postedAtISO ??
      (typeof item.postedAtTimestamp === "number"
        ? new Date(item.postedAtTimestamp).toISOString()
        : null),
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

// ----------------------------------------------------- Dispatch

// Single entry-point both callers use. Returns null when the platform
// isn't supported (currently X) so the caller can decide whether to
// 501 (on-demand route) or skip (cron).
export async function dispatchScrape(platform: Platform, liveUrl: string): Promise<ScrapeResult | null> {
  if (platform === "instagram") return scrapeInstagram(liveUrl);
  if (platform === "linkedin")  return scrapeLinkedIn(liveUrl);
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

  let upsertedEmbed: unknown = null;
  if (result.ok && result.embed) {
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
