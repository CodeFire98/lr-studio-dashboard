#!/usr/bin/env node
/**
 * Actor-selection preflight for PRs 5 (X) and 6 (LinkedIn).
 *
 * The IG actor was settled in PR 1 (apify/instagram-scraper, validated
 * against a real Bamboo Bear post). X and LinkedIn need a real shootout
 * because:
 *   - apidojo/tweet-scraper (my first X pick) returned {noResults:true}
 *     × 10 for a real tweet URL. Input shape may be wrong, or actor
 *     may be broken — either way it's not viable as-is.
 *   - Both LinkedIn candidates I named in PR 1 turned out to not exist
 *     on Apify (apify/linkedin-post-scraper AND
 *     harvestapi/linkedin-post-scraper both 404 record-not-found).
 *
 * This script tries 3 candidate actors per platform against a real
 * public post URL, prints what each one returns (metrics + author +
 * media + run cost in items), and stops. The user reads the output,
 * picks a winner per platform, and PRs 5/6 wire that winner.
 *
 * Cost estimate: at worst 6 actor invocations against 2 URLs. Most
 * pay-per-result actors are free when they return 0 items; even fully
 * loaded this is ~$0.05 in Apify credit.
 *
 * Usage:
 *   APIFY_API_TOKEN=apify_api_... node scripts/scrape-engagement-actor-preflight.mjs \
 *     --x https://x.com/<handle>/status/<id> \
 *     --linkedin https://www.linkedin.com/posts/<slug>
 *
 * You can omit one platform with --skip-x or --skip-linkedin. The
 * script reports a per-actor summary at the end so you can compare
 * side-by-side without re-running.
 */

const TOKEN = process.env.APIFY_API_TOKEN;
if (!TOKEN) {
  console.error("APIFY_API_TOKEN env var required.");
  process.exit(1);
}

// ---------------------------------------------------------------- CLI args

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}
const xUrl        = flag("--x");
const linkedinUrl = flag("--linkedin");
const skipX        = argv.includes("--skip-x");
const skipLinkedIn = argv.includes("--skip-linkedin");

if (!xUrl && !skipX) {
  console.error("Pass --x <real tweet URL>, or --skip-x to only test LinkedIn.");
  process.exit(1);
}
if (!linkedinUrl && !skipLinkedIn) {
  console.error("Pass --linkedin <real post URL>, or --skip-linkedin to only test X.");
  process.exit(1);
}

// ----------------------------------------------------------- Actor candidates

// Each candidate declares its actor ID + one or more input shapes to try.
// Some actors take `tweetURLs`, others `urls`, others `startUrls: [{url}]`
// — we try shapes top-to-bottom and take the first that returns items.

const X_CANDIDATES = [
  {
    actor: "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
    inputs: [
      (url) => ({ tweetURLs: [url], maxItems: 1 }),
      (url) => ({ urls: [url], maxItems: 1 }),
      (url) => ({ startUrls: [{ url }], maxItems: 1 }),
    ],
  },
  {
    actor: "apidojo/twitter-scraper-lite",
    inputs: [
      (url) => ({ startUrls: [{ url }], maxItems: 1 }),
      (url) => ({ tweetUrls: [url], maxItems: 1 }),
      (url) => ({ urls: [url], maxItems: 1 }),
    ],
  },
  {
    actor: "tugkan/twitter-tweet-scraper-pay-per-result",
    inputs: [
      (url) => ({ startUrls: [{ url }], maxItems: 1 }),
      (url) => ({ tweetUrls: [url], maxItems: 1 }),
      (url) => ({ urls: [url], maxItems: 1 }),
    ],
  },
];

const LINKEDIN_CANDIDATES = [
  {
    actor: "apimaestro/linkedin-post-search-scraper",
    inputs: [
      (url) => ({ urls: [url] }),
      (url) => ({ postUrls: [url] }),
    ],
  },
  {
    actor: "curious_coder/linkedin-post-scraper",
    inputs: [
      (url) => ({ urls: [url] }),
      (url) => ({ startUrls: [{ url }] }),
    ],
  },
  {
    actor: "dev_fusion/linkedin-post-scraper",
    inputs: [
      (url) => ({ urls: [url] }),
      (url) => ({ postUrls: [url] }),
    ],
  },
];

// ----------------------------------------------------- HTTP helper

async function runActor(actor, body) {
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN)}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (ex) {
    return { error: `network: ${ex.message}`, elapsed: Date.now() - t0 };
  }
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}`, elapsed };
  }
  const items = await res.json().catch(() => []);
  return { items: Array.isArray(items) ? items : [], elapsed };
}

// ----------------------------------------------------- Per-candidate driver

async function tryCandidate(platform, candidate, postUrl) {
  for (let i = 0; i < candidate.inputs.length; i++) {
    const input = candidate.inputs[i](postUrl);
    const inputKey = Object.keys(input).filter((k) => k !== "maxItems").join("+");
    console.log(`\n  → ${candidate.actor}  (input: ${inputKey})`);
    const r = await runActor(candidate.actor, input);
    if (r.error) {
      console.log(`    ERROR: ${r.error}  [${r.elapsed}ms]`);
      // 404 = actor missing; bail entirely. Network = bail. Otherwise try next shape.
      if (r.error.startsWith("HTTP 404") || r.error.startsWith("network")) {
        return { actor: candidate.actor, status: "missing", error: r.error };
      }
      continue;
    }
    const itemCount = r.items.length;
    console.log(`    items: ${itemCount}  elapsed: ${r.elapsed}ms`);
    if (itemCount === 0) {
      console.log("    (zero items — trying next input shape)");
      continue;
    }
    // Inspect the first item for engagement-signal heuristics.
    const item = r.items[0];
    const signals = engagementSignals(platform, item);
    const sample = JSON.stringify(item).slice(0, 400);
    console.log(`    signals: ${JSON.stringify(signals)}`);
    console.log(`    sample : ${sample}${sample.length >= 400 ? "..." : ""}`);
    return {
      actor: candidate.actor,
      status: signals.hasEngagement ? "ok" : "empty",
      inputShape: inputKey,
      itemCount,
      elapsed: r.elapsed,
      signals,
      firstItemKeys: Object.keys(item).slice(0, 20),
    };
  }
  return { actor: candidate.actor, status: "all-shapes-failed" };
}

// Heuristic — does this item have ANY engagement count we can use?
function engagementSignals(platform, item) {
  if (!item || typeof item !== "object") return { hasEngagement: false };
  const get = (...keys) => {
    for (const k of keys) {
      const v = item[k];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
        return Number(v);
      }
    }
    return null;
  };
  if (platform === "x") {
    const likes  = get("likeCount", "likes", "favorite_count");
    const replies = get("replyCount", "replies", "reply_count");
    const reposts = get("retweetCount", "retweets", "retweet_count");
    const views = get("viewCount", "views", "view_count", "impressionCount");
    const bookmarks = get("bookmarkCount", "bookmarks", "bookmark_count");
    return {
      hasEngagement: likes != null || replies != null || reposts != null || views != null,
      likes, replies, reposts, views, bookmarks,
      hasAuthor: Boolean(item.user || item.author || item.username || item.handle),
      hasText: Boolean(item.text || item.fullText || item.tweetText),
    };
  }
  if (platform === "linkedin") {
    const reactions = get("totalReactions", "reactionsCount", "numLikes", "likes", "likeCount");
    const comments = get("commentsCount", "numComments", "comments");
    const shares = get("sharesCount", "numShares", "shares", "repostCount");
    return {
      hasEngagement: reactions != null || comments != null || shares != null,
      reactions, comments, shares,
      hasAuthor: Boolean(item.author || item.authorName || item.user),
      hasText: Boolean(item.text || item.postText || item.content),
    };
  }
  return { hasEngagement: false };
}

// ----------------------------------------------------- Summary table

function printSummary(title, results) {
  console.log(`\n\n=== ${title.toUpperCase()} SHOOTOUT ===`);
  console.log("┌─────────────────────────────────────────────────────────────────┬──────────────┬──────────┐");
  console.log("│ Actor                                                           │ Status       │ Items    │");
  console.log("├─────────────────────────────────────────────────────────────────┼──────────────┼──────────┤");
  for (const r of results) {
    const actor = r.actor.padEnd(63).slice(0, 63);
    const status = (r.status || "?").padEnd(12).slice(0, 12);
    const items = String(r.itemCount ?? "—").padEnd(8).slice(0, 8);
    console.log(`│ ${actor} │ ${status} │ ${items} │`);
  }
  console.log("└─────────────────────────────────────────────────────────────────┴──────────────┴──────────┘");
  const winner = results.find((r) => r.status === "ok");
  if (winner) {
    console.log(`\n✅ Winner: ${winner.actor}`);
    console.log(`   input shape: ${winner.inputShape}`);
    console.log(`   signals    : ${JSON.stringify(winner.signals)}`);
    console.log(`   keys       : ${winner.firstItemKeys.join(", ")}`);
  } else {
    console.log("\n❌ No winner — all 3 actors failed or returned no engagement data.");
    console.log("   Recommendation:");
    if (title === "x") console.log("   → Skip X in MVP (per the pre-agreed decision).");
    if (title === "linkedin") console.log("   → Re-evaluate. None of the 3 candidates worked.");
  }
}

// ----------------------------------------------------- Main

(async () => {
  const xResults = [];
  const linkedinResults = [];

  if (xUrl && !skipX) {
    console.log(`\n────── X — testing 3 candidates against ${xUrl} ──────`);
    for (const c of X_CANDIDATES) {
      const r = await tryCandidate("x", c, xUrl);
      xResults.push(r);
    }
  }

  if (linkedinUrl && !skipLinkedIn) {
    console.log(`\n────── LINKEDIN — testing 3 candidates against ${linkedinUrl} ──────`);
    for (const c of LINKEDIN_CANDIDATES) {
      const r = await tryCandidate("linkedin", c, linkedinUrl);
      linkedinResults.push(r);
    }
  }

  if (xResults.length) printSummary("x", xResults);
  if (linkedinResults.length) printSummary("linkedin", linkedinResults);
  console.log("\nDone. Paste this output back — PR 5 + PR 6 actor selection is locked from here.");
  console.log("Check Apify console (https://console.apify.com/usage) for exact spend on this run.");
})();
