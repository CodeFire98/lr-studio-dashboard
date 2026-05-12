// =====================================================================
// /api/engagement/refresh — Vercel serverless function
//
// Scrapes live engagement metrics + post-content for a single
// `post_plan_publications` row and writes the results to
// `post_engagement_snapshots` (append-only) and `post_embed_cache` (1:1).
//
// PR 2 in the Live Posts engagement series — Instagram only.
// X and LinkedIn handlers ship in PRs 5 and 6; this route returns
// 501 for non-IG platforms with a clear message so the UI can render
// "Instagram metrics only for now" instead of guessing.
//
// Why this design:
//
// Write path is service-role only. The companion migration `0041` has
// no INSERT/UPDATE/DELETE policies for `authenticated` on either table
// — every snapshot/embed update must go through this route. Apify
// scrapes cost real money per call; gating "who can trigger a refresh"
// at the route, with the service-role key writing back, prevents brand
// users from burning Apify budget (intentional or accidental) by
// hitting a client-side INSERT. Read RLS stays open to agency + brand
// so the tile can render for everyone once written.
//
// Agency-only at the route layer. After JWT validation we look up
// `profiles.is_agency` and 403 brand users. When/if we extend "refresh
// now" to brand users, the gate becomes a rate-limit + daily quota at
// this same layer — still not RLS.
//
// Same auth shape as /api/ai/* routes (JWT in Authorization header,
// validated by a user-scoped Supabase client, profile lookup via
// service-role).
//
// Same Apify invocation shape as fetch-trends.ts (the existing consumer
// of APIFY_API_TOKEN) — `run-sync-get-dataset-items` against the
// public actor, no run polling needed for a single-URL scrape.
//
// Env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// APIFY_API_TOKEN.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL    = process.env.SUPABASE_URL ?? "";
const ANON_KEY        = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE    = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// ---------------------------------------------------------------- Types

type RequestBody = {
  publicationId?: string;
};

type Platform = "instagram" | "linkedin" | "x";

type PublicationRow = {
  id: string;
  post_plan_id: string;
  platform: Platform;
  live_url: string | null;
};

type ScrapeStatus = "ok" | "partial" | "failed" | "blocked";

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

// ----------------------------------------------------- Apify — Instagram

const IG_ACTOR_ID = "apify/instagram-scraper";

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

async function scrapeInstagram(liveUrl: string): Promise<{
  ok: boolean;
  status: ScrapeStatus;
  errorMessage: string | null;
  metrics: NormalizedMetrics | null;
  embed: NormalizedEmbed | null;
  raw: unknown;
  actorRunId: string | null;
}> {
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
    return {
      ok: false,
      status: "failed",
      errorMessage: `network: ${(ex as Error).message}`,
      metrics: null,
      embed: null,
      raw: null,
      actorRunId: null,
    };
  }

  // Apify exposes the run id on the response headers — useful for debugging
  // a specific scrape later in the Apify console.
  const actorRunId =
    res.headers.get("x-apify-act-run-id") ??
    res.headers.get("x-apify-run-id") ??
    null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const isBlocked =
      res.status === 403 ||
      text.includes("Monthly usage hard limit") ||
      text.includes("usage-limit");
    return {
      ok: false,
      status: isBlocked ? "blocked" : "failed",
      errorMessage: `apify ${res.status}: ${text.slice(0, 300)}`,
      metrics: null,
      embed: null,
      raw: null,
      actorRunId,
    };
  }

  const items = (await res.json().catch(() => [])) as ApifyInstagramItem[];
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) {
    return {
      ok: false,
      status: "failed",
      errorMessage: "Apify returned no items for this URL",
      metrics: null,
      embed: null,
      raw: items,
      actorRunId,
    };
  }

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

  // Note: real-data dry-run on 2026-05-12 returned `type:"Image"` with
  // a non-empty `childPosts` array whose entries' displayUrls were all
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

  // Partial = we got some metrics but the post is missing key fields
  // (e.g. caption + display URL absent → embed card will look bare).
  const partial = !embed.media_url && !embed.caption;

  return {
    ok: true,
    status: partial ? "partial" : "ok",
    errorMessage: null,
    metrics,
    embed,
    raw: item,
    actorRunId,
  };
}

// ----------------------------------------------------- Apify — LinkedIn
//
// supreme_coder/linkedin-post — won the actor shootout on 2026-05-12.
// 6.4M runs, 13k users on Apify Store. "No cookies · $1 per 1k" (so
// ~$0.001 per scrape, well under our cost projection). Validated
// against a real public LinkedIn post and returned:
//   { type, images: [string], url, urn, text, timeSincePosted,
//     numLikes, numComments, numShares, reactions: [...], comments: [...],
//     canReact, canPostComments, canShare, ... }
//
// Notes:
// - `numLikes` is the total reactions count (LinkedIn rolls
//   like/celebrate/support/etc into one bucket for public scrapes).
//   We map it to BOTH `like_count` and `reaction_count` so the metrics
//   row's ♥ icon shows the headline number, AND a future "reactions"
//   breakdown can use reaction_count without remapping.
// - `timeSincePosted` is a relative string ("3 weeks ago"), not an
//   ISO timestamp. We can't recover the exact post moment from that
//   alone; `posted_at` stays null for now. The agency-marked
//   `published_at` on `post_plan_publications` remains the source of
//   truth for "when did this go live".
// - Image URLs live under `images[]` and use `media.licdn.com`. That
//   host needs to be on the `/api/engagement/image-proxy` allowlist
//   (added in this PR).

const LINKEDIN_ACTOR_ID = "supreme_coder/linkedin-post";

type SupremeCoderLinkedInItem = {
  type?: string;                     // 'image' | 'video' | 'text' | 'document'
  images?: string[];                 // media.licdn.com URLs
  isActivity?: boolean;
  urn?: string;
  url?: string;
  timeSincePosted?: string;          // "3 weeks ago" (no absolute ts)
  text?: string;
  numLikes?: number;
  numComments?: number;
  numShares?: number;
  reactions?: unknown;               // array of reactor objects, not a count
  comments?: unknown;                // array of comment objects, not a count
  // Author info — supreme_coder returns it under `rootShare.actor`
  // for re-shares, OR top-level `actor` for original posts. We try
  // both paths in the normalizer; if neither exists we leave the
  // author fields null and the tile renders the post anonymously.
  actor?: { name?: string; vanityName?: string; profileUrl?: string; picture?: string };
  rootShare?: { actor?: { name?: string; vanityName?: string; profileUrl?: string; picture?: string } };
  // Catch-all for other shapes — log into raw_payload for debug.
  [k: string]: unknown;
};

function extractLinkedInAuthor(item: SupremeCoderLinkedInItem) {
  const a = item.actor || item.rootShare?.actor || null;
  if (!a) return { handle: null, name: null, avatar: null };
  return {
    handle: a.vanityName || null,
    name: a.name || null,
    avatar: a.picture || null,
  };
}

async function scrapeLinkedIn(liveUrl: string): Promise<{
  ok: boolean;
  status: ScrapeStatus;
  errorMessage: string | null;
  metrics: NormalizedMetrics | null;
  embed: NormalizedEmbed | null;
  raw: unknown;
  actorRunId: string | null;
}> {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(LINKEDIN_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_API_TOKEN)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Input shape `urls` confirmed by 2026-05-12 dry-run.
        urls: [liveUrl],
      }),
    });
  } catch (ex) {
    return {
      ok: false, status: "failed",
      errorMessage: `network: ${(ex as Error).message}`,
      metrics: null, embed: null, raw: null, actorRunId: null,
    };
  }

  const actorRunId =
    res.headers.get("x-apify-act-run-id") ??
    res.headers.get("x-apify-run-id") ??
    null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const isBlocked =
      res.status === 403 ||
      text.includes("Monthly usage hard limit") ||
      text.includes("usage-limit");
    return {
      ok: false,
      status: isBlocked ? "blocked" : "failed",
      errorMessage: `apify ${res.status}: ${text.slice(0, 300)}`,
      metrics: null, embed: null, raw: null, actorRunId,
    };
  }

  const items = (await res.json().catch(() => [])) as SupremeCoderLinkedInItem[];
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) {
    return {
      ok: false, status: "failed",
      errorMessage: "supreme_coder/linkedin-post returned no items for this URL",
      metrics: null, embed: null, raw: items, actorRunId,
    };
  }

  const likes    = numOrNull(item.numLikes);
  const comments = numOrNull(item.numComments);
  const shares   = numOrNull(item.numShares);

  const metrics: NormalizedMetrics = {
    // LinkedIn rolls reactions into one bucket on public scrapes —
    // both fields point at the same number so future UIs that prefer
    // either name read the same data.
    like_count: likes,
    reaction_count: likes,
    comment_count: comments,
    share_count: shares,
    save_count: null,
    view_count: null,        // not exposed for public posts
    bookmark_count: null,
    quote_count: null,
    engagement_rate: null,   // can't compute without views
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

  const author = extractLinkedInAuthor(item);

  const embed: NormalizedEmbed = {
    author_handle: author.handle,
    author_display_name: author.name,
    author_avatar_url: author.avatar,
    caption: item.text ?? null,
    media_type: mediaType,
    media_url: images[0] ?? null,
    media_urls: images.length > 1 ? images : null,
    media_aspect_ratio: null,    // not in this actor's output
    posted_at: null,             // `timeSincePosted` is a relative string, not parseable
  };

  // "Partial" same definition as IG — counts present but the visible
  // card has nothing to render.
  const partial = !embed.media_url && !embed.caption;

  return {
    ok: true,
    status: partial ? "partial" : "ok",
    errorMessage: null,
    metrics,
    embed,
    raw: item,
    actorRunId,
  };
}

// ----------------------------------------------------- Handler

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) {
    return res.status(500).json({ error: "Supabase env not fully configured." });
  }
  if (!APIFY_API_TOKEN) {
    return res.status(500).json({
      error: "APIFY_API_TOKEN not configured. Add it under Vercel Project Settings → Environment Variables.",
    });
  }

  let body: RequestBody;
  if (typeof req.body === "string") {
    try { body = JSON.parse(req.body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  } else {
    body = (req.body ?? {}) as RequestBody;
  }
  const publicationId = body?.publicationId?.trim();
  if (!publicationId) {
    return res.status(400).json({ error: "publicationId is required" });
  }

  // -------- AUTH: JWT → is_agency → 403 if brand

  const authHeader =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["Authorization"] as string | undefined) ??
    "";
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const userClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_agency) {
    // Brand users CAN read snapshots + embed cache (the tile renders for
    // them), they just can't trigger a fresh Apify scrape. When/if we
    // extend this, the gate becomes a rate-limit + daily quota at this
    // same layer.
    return res.status(403).json({ error: "Engagement refresh is agency-only for now." });
  }

  // -------- LOAD the publication row

  const { data: pub, error: pubErr } = await serviceClient
    .from("post_plan_publications")
    .select("id, post_plan_id, platform, live_url")
    .eq("id", publicationId)
    .maybeSingle<PublicationRow>();
  if (pubErr || !pub) {
    return res.status(404).json({ error: "Publication not found" });
  }
  if (!pub.live_url) {
    return res.status(400).json({
      error: "Publication has no live_url — paste the live post URL on the plan first.",
    });
  }

  // -------- PLATFORM dispatch
  //
  // IG       — apify/instagram-scraper (PR 2)
  // LinkedIn — supreme_coder/linkedin-post (PR 6, this commit)
  // X        — intentionally unsupported in MVP. Apify shootout on
  //            2026-05-12 found no actor that returns real metrics
  //            without hostile pricing. Route returns 501; the UI
  //            renders the tile with a "not tracked" label so X
  //            publications still show up in Live Posts.
  //
  // `actorId` is captured so the snapshot row's `actor_id` field
  // accurately attributes which scraper produced the data.

  let result;
  let actorId: string;
  if (pub.platform === "instagram") {
    actorId = IG_ACTOR_ID;
    result = await scrapeInstagram(pub.live_url);
  } else if (pub.platform === "linkedin") {
    actorId = LINKEDIN_ACTOR_ID;
    result = await scrapeLinkedIn(pub.live_url);
  } else {
    // X (and anything else added later) — 501 with a stable message
    // the client can branch on. UI doesn't fire the route for X, but
    // a curl smoke test should get a clear answer.
    return res.status(501).json({
      error: `Engagement refresh is not supported for ${pub.platform}. (X has no viable Apify actor as of 2026-05-12.)`,
      platform: pub.platform,
    });
  }

  // -------- WRITE the snapshot (always — failures are part of the audit trail)

  const snapshotRow = {
    publication_id: pub.id,
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
    actor_id: actorId,
    actor_run_id: result.actorRunId,
    scrape_status: result.status,
    error_message: result.errorMessage,
  };

  const { data: insertedSnapshot, error: snapErr } = await serviceClient
    .from("post_engagement_snapshots")
    .insert(snapshotRow)
    .select("*")
    .single();
  if (snapErr) {
    return res.status(500).json({
      error: `Failed to write snapshot: ${snapErr.message}`,
      scrape_status: result.status,
      scrape_error: result.errorMessage,
    });
  }

  // -------- UPSERT the embed cache (only on a successful scrape)

  let upsertedEmbed: unknown = null;
  if (result.ok && result.embed) {
    const embedRow = {
      publication_id: pub.id,
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
      // Snapshot already written — embed-cache failure is a soft error.
      // The tile will still render counts; the visual card just won't
      // refresh until the next successful scrape.
      console.warn("post_embed_cache upsert failed", embedErr);
    } else {
      upsertedEmbed = data;
    }
  }

  return res.status(200).json({
    ok: result.ok,
    publication_id: pub.id,
    snapshot: insertedSnapshot,
    embed: upsertedEmbed,
    scrape_status: result.status,
    scrape_error: result.errorMessage,
  });
}
