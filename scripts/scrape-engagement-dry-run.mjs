#!/usr/bin/env node
/**
 * Dry-run: hit each Apify actor with a real public post URL, print the
 * normalized metrics + embed fields, and confirm the actors we chose in
 * the plan actually return what we expect before wiring the production
 * /api/engagement/refresh route.
 *
 * Usage:
 *   APIFY_API_TOKEN=apify_api_... node scripts/scrape-engagement-dry-run.mjs \
 *     <ig-or-x-or-linkedin-url> [more-urls...]
 *
 *   # or with built-in samples:
 *   APIFY_API_TOKEN=apify_api_... node scripts/scrape-engagement-dry-run.mjs --samples
 *
 * Actors used (one per platform — same set the production route will use):
 *   instagram  apify/instagram-scraper           (we already use it in fetch-trends)
 *   x          apidojo/tweet-scraper             (cheapest stable pay-per-result)
 *   linkedin   apify/linkedin-post-scraper       (Apify-maintained, public posts)
 *
 * Output for each URL:
 *   - Platform detection
 *   - Normalized metrics row (matches post_engagement_snapshots columns)
 *   - Normalized embed row   (matches post_embed_cache columns)
 *   - Run cost (charged events / dataset items, as reported by Apify)
 *   - First 300 chars of the raw payload for sanity-checking
 *
 * No DB writes. Safe to run on production credentials.
 */

const TOKEN = process.env.APIFY_API_TOKEN;
if (!TOKEN) {
  console.error("APIFY_API_TOKEN env var required.");
  process.exit(1);
}

const SAMPLES = {
  instagram: "https://www.instagram.com/p/C0000000000/", // overridden via CLI for a real URL
  x:         "https://x.com/elonmusk/status/1000000000000000000/",
  linkedin:  "https://www.linkedin.com/posts/williamhgates_example-activity-0000000000000000000-AAAA/",
};

const argv = process.argv.slice(2);
const useSamples = argv.includes("--samples");
const urls = useSamples
  ? Object.values(SAMPLES)
  : argv.filter((a) => a.startsWith("http"));

if (urls.length === 0) {
  console.error("No URLs given. Pass URLs as arguments or use --samples.");
  process.exit(1);
}

// ---------------------------------------------------------------- URL parsing

function detectPlatform(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.endsWith("instagram.com")) return "instagram";
    if (host === "x.com" || host === "twitter.com") return "x";
    if (host.endsWith("linkedin.com")) return "linkedin";
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- Actor wrappers

async function runActor({ actorId, body }) {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN)}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`apify ${res.status}: ${text.slice(0, 300)}`);
  }
  const items = await res.json();
  return { items: Array.isArray(items) ? items : [], elapsedMs };
}

// ------------------------------------------------------------------ Normalize

function normalizeInstagram(item) {
  if (!item) return null;
  const likes        = numOrNull(item.likesCount);
  const comments     = numOrNull(item.commentsCount);
  const videoViews   = numOrNull(item.videoViewCount ?? item.videoPlayCount);
  const carousel     = Array.isArray(item.childPosts) ? item.childPosts : null;
  return {
    metrics: {
      like_count: likes,
      comment_count: comments,
      share_count: null, // IG doesn't expose this
      save_count: null,  // IG doesn't expose this publicly
      view_count: videoViews,
      bookmark_count: null,
      quote_count: null,
      reaction_count: null,
      engagement_rate: viewBased(likes, comments, null, videoViews),
      availability_notes: "IG: share/save/bookmark counts not exposed via apify/instagram-scraper",
    },
    embed: {
      author_handle: item.ownerUsername || null,
      author_display_name: item.ownerFullName || null,
      author_avatar_url: null, // not in this actor's output
      caption: item.caption || null,
      media_type: carousel ? "carousel" : (item.type === "Video" ? "video" : "image"),
      media_url: item.displayUrl || null,
      media_urls: carousel ? carousel.map((c) => c.displayUrl).filter(Boolean) : null,
      media_aspect_ratio: aspect(item.dimensionsWidth, item.dimensionsHeight),
      posted_at: item.timestamp || null,
    },
  };
}

function normalizeX(item) {
  if (!item) return null;
  // apidojo/tweet-scraper output: { likeCount, retweetCount, replyCount, quoteCount,
  //   viewCount, bookmarkCount, text, user: { userName, name, profilePicture }, createdAt,
  //   media: [{ media_url_https }] }
  const likes      = numOrNull(item.likeCount);
  const comments   = numOrNull(item.replyCount);
  const shares     = numOrNull(item.retweetCount);
  const views      = numOrNull(item.viewCount);
  const bookmarks  = numOrNull(item.bookmarkCount);
  const quotes     = numOrNull(item.quoteCount);
  const media      = Array.isArray(item.media) ? item.media : [];
  return {
    metrics: {
      like_count: likes,
      comment_count: comments,
      share_count: shares,
      save_count: null,
      view_count: views,
      bookmark_count: bookmarks,
      quote_count: quotes,
      reaction_count: null,
      engagement_rate: viewBased(likes, comments, shares, views),
      availability_notes: null,
    },
    embed: {
      author_handle: item.user?.userName || null,
      author_display_name: item.user?.name || null,
      author_avatar_url: item.user?.profilePicture || null,
      caption: item.text || null,
      media_type: media.length > 0 ? (media[0]?.type === "video" ? "video" : "image") : "text",
      media_url: media[0]?.media_url_https || null,
      media_urls: media.length > 1 ? media.map((m) => m.media_url_https).filter(Boolean) : null,
      media_aspect_ratio: null,
      posted_at: item.createdAt || null,
    },
  };
}

function normalizeLinkedIn(item) {
  if (!item) return null;
  // apify/linkedin-post-scraper output (public posts):
  //   { totalReactions, commentsCount, sharesCount, text, author: { name, profileUrl, image },
  //     postedAt, image, video, type }
  const reactions = numOrNull(item.totalReactions);
  const comments  = numOrNull(item.commentsCount);
  const shares    = numOrNull(item.sharesCount);
  const blocked   = reactions == null && comments == null;
  return {
    metrics: {
      like_count: reactions, // LinkedIn rolls reactions into one bucket for public reads
      comment_count: comments,
      share_count: shares,
      save_count: null,
      view_count: null, // not exposed publicly
      bookmark_count: null,
      quote_count: null,
      reaction_count: reactions,
      engagement_rate: null,
      availability_notes: blocked
        ? "LinkedIn returned no metrics — likely behind a login wall"
        : "LinkedIn: view counts not exposed via public scrape",
    },
    embed: {
      author_handle: item.author?.profileUrl?.split("/").filter(Boolean).pop() || null,
      author_display_name: item.author?.name || null,
      author_avatar_url: item.author?.image || null,
      caption: item.text || null,
      media_type: item.video ? "video" : (item.image ? "image" : "text"),
      media_url: item.video || item.image || null,
      media_urls: null,
      media_aspect_ratio: null,
      posted_at: item.postedAt || null,
    },
  };
}

// ----------------------------------------------------------------- helpers

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function aspect(w, h) {
  const wn = numOrNull(w);
  const hn = numOrNull(h);
  if (!wn || !hn) return null;
  return Math.round((wn / hn) * 1000) / 1000;
}

function viewBased(likes, comments, shares, views) {
  if (!views || views <= 0) return null;
  const eng = (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
  if (eng <= 0) return null;
  return Math.round((eng / views) * 10000) / 10000; // 4 decimal places
}

// ---------------------------------------------------------------- Per-platform call

async function scrapeOne(url) {
  const platform = detectPlatform(url);
  if (!platform) return { url, error: "unknown platform" };

  if (platform === "instagram") {
    const { items, elapsedMs } = await runActor({
      actorId: "apify/instagram-scraper",
      body: {
        directUrls: [url],
        resultsType: "posts",
        resultsLimit: 1,
        addParentData: false,
      },
    });
    return {
      url,
      platform,
      actorId: "apify/instagram-scraper",
      elapsedMs,
      rawSample: items[0],
      normalized: normalizeInstagram(items[0]),
      itemCount: items.length,
    };
  }

  if (platform === "x") {
    const { items, elapsedMs } = await runActor({
      actorId: "apidojo/tweet-scraper",
      body: {
        startUrls: [url],
        maxItems: 1,
      },
    });
    return {
      url,
      platform,
      actorId: "apidojo/tweet-scraper",
      elapsedMs,
      rawSample: items[0],
      normalized: normalizeX(items[0]),
      itemCount: items.length,
    };
  }

  if (platform === "linkedin") {
    const { items, elapsedMs } = await runActor({
      actorId: "apify/linkedin-post-scraper",
      body: {
        urls: [url],
        deepScrape: false,
      },
    });
    return {
      url,
      platform,
      actorId: "apify/linkedin-post-scraper",
      elapsedMs,
      rawSample: items[0],
      normalized: normalizeLinkedIn(items[0]),
      itemCount: items.length,
    };
  }
}

// ------------------------------------------------------------------- Main

function printResult(r) {
  const div = "─".repeat(72);
  console.log(`\n${div}`);
  console.log(`URL:       ${r.url}`);
  if (r.error) {
    console.log(`ERROR:     ${r.error}`);
    return;
  }
  console.log(`Platform:  ${r.platform}`);
  console.log(`Actor:     ${r.actorId}`);
  console.log(`Elapsed:   ${r.elapsedMs}ms`);
  console.log(`Items:     ${r.itemCount}`);
  if (!r.normalized) {
    console.log("No item returned — check the URL or the actor's output schema.");
    return;
  }
  console.log("\nNormalized metrics →");
  console.table(r.normalized.metrics);
  console.log("\nNormalized embed →");
  console.table(r.normalized.embed);
  console.log("\nRaw payload sample (first 300 chars):");
  console.log(JSON.stringify(r.rawSample).slice(0, 300) + "...");
}

(async () => {
  for (const url of urls) {
    try {
      const r = await scrapeOne(url);
      printResult(r);
    } catch (e) {
      console.log(`\n──── ${url}\nFAILED: ${e.message}`);
    }
  }
  console.log("\nDone. Verify each platform returned the fields the production route expects.");
  console.log("Cost so far: charged per dataset item by each actor — check the Apify console");
  console.log("(https://console.apify.com/usage) for exact $$$ on this run.");
})();
