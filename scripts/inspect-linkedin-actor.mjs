#!/usr/bin/env node
/**
 * One-shot inspector for supreme_coder/linkedin-post.
 *
 * The preflight script truncates keys at 20 and raw samples at 400
 * chars. PR #80 shipped with author extraction looking at `item.actor`
 * and `item.rootShare?.actor`, but those fields aren't there — the
 * tile renders "Unknown author". This script prints the FULL first
 * item so we can see exactly where the author lives and patch the
 * normalizer in a follow-up commit.
 *
 * Usage:
 *   APIFY_API_TOKEN=apify_api_... node scripts/inspect-linkedin-actor.mjs \
 *     https://www.linkedin.com/posts/<slug>
 *
 * Output:
 *   1. All top-level keys
 *   2. Pretty-printed full JSON of item[0] (truncated at 8KB)
 *   3. Search results for any field whose value looks like a person
 *      name or LinkedIn handle (matches against the post URL slug).
 */

const TOKEN = process.env.APIFY_API_TOKEN;
if (!TOKEN) {
  console.error("APIFY_API_TOKEN env var required.");
  process.exit(1);
}

const url = process.argv[2];
if (!url || !url.includes("linkedin.com/posts/")) {
  console.error("Pass a real LinkedIn post URL as the only argument.");
  process.exit(1);
}

// Pull the slug prefix from the URL — the author's vanity name is
// usually the first segment of the slug. E.g.
// https://www.linkedin.com/posts/theshrutimishra_a-few-days-back-i-was-...
// → "theshrutimishra"
const slugMatch = url.match(/\/posts\/([^_\/]+)/);
const probableHandle = slugMatch ? slugMatch[1] : null;
if (probableHandle) {
  console.log(`Expected author handle from URL slug: ${probableHandle}`);
}

const actorUrl =
  `https://api.apify.com/v2/acts/${encodeURIComponent("supreme_coder/linkedin-post")}` +
  `/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN)}`;

console.log("\nCalling supreme_coder/linkedin-post...");
const res = await fetch(actorUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ urls: [url] }),
});

if (!res.ok) {
  console.error(`apify ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const items = await res.json();
if (!Array.isArray(items) || items.length === 0) {
  console.error("No items returned.");
  process.exit(1);
}

const item = items[0];

console.log("\n=== All top-level keys ===");
console.log(Object.keys(item).join("\n"));

console.log("\n=== Full pretty-printed item (truncated 8KB) ===");
const pretty = JSON.stringify(item, null, 2);
console.log(pretty.length > 8000 ? pretty.slice(0, 8000) + "\n... (truncated)" : pretty);

// Walk the object up to depth 3 looking for any string value that
// contains the expected handle (case-insensitive) — that tells us
// the field path the author info actually lives on.
if (probableHandle) {
  console.log(`\n=== Field paths whose string values mention "${probableHandle}" (case-insensitive) ===`);
  const hits = [];
  function walk(obj, path = "", depth = 0) {
    if (depth > 4 || obj == null) return;
    if (typeof obj === "string") {
      if (obj.toLowerCase().includes(probableHandle.toLowerCase())) {
        hits.push({ path, value: obj.length > 200 ? obj.slice(0, 200) + "…" : obj });
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  }
  walk(item);
  if (hits.length === 0) {
    console.log("(no matches — handle may not be in the payload at all)");
  } else {
    for (const h of hits) {
      console.log(`  ${h.path}: ${h.value}`);
    }
  }
}
