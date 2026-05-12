// =====================================================================
// /api/engagement/image-proxy?u=<encoded-cdn-url>
//
// Same-origin proxy for Instagram / Facebook CDN images. The dashboard
// gets IG image URLs from Apify's scrape and tries to render them
// directly in <img> tags, but Meta's CDN sends
// Cross-Origin-Resource-Policy: same-origin (or same-site) which makes
// the browser refuse to embed those responses from a third-party
// origin (the dashboard). Verified 2026-05-12 with a real Bamboo Bear
// post URL: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin regardless of
// referrerpolicy or crossorigin attributes.
//
// Fix: proxy the request server-side. CORP is a browser-side mechanism
// — server-to-server fetches don't see it. We re-emit the bytes from
// our own origin with permissive CORP so the browser is happy.
//
// Security: validate that the upstream host is a known Meta CDN
// (`*.cdninstagram.com` or `*.fbcdn.net`). Without the allowlist this
// would be a general-purpose proxy that anyone on the internet could
// abuse for SSRF or as a bandwidth shield.
//
// Auth: deliberately unauthenticated. The proxy only fetches public
// IG/FB image URLs that the agency has already pasted into the system
// as live-post URLs. Adding JWT auth here would require signed image
// URLs (img tags can't send Authorization headers), which is more
// machinery than the threat warrants for v1.
//
// Cache: 1 day at the edge via Cache-Control. Meta's CDN URLs have a
// short lifetime anyway (~10 days from the signed timestamp); caching
// for a day means we burn ~1/30th of the bandwidth a perfectly-fresh
// proxy would.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_HOST_SUFFIXES = [
  ".cdninstagram.com",
  ".fbcdn.net",
];
// Exact hostnames (no leading dot) that should also be allowed.
const ALLOWED_HOSTS_EXACT = new Set([
  "cdninstagram.com",
  "scontent.cdninstagram.com",
]);

function hostIsAllowed(host: string): boolean {
  if (!host) return false;
  if (ALLOWED_HOSTS_EXACT.has(host)) return true;
  return ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Browsers don't preflight image requests, but allow OPTIONS for
  // tooling consistency with the other engagement routes.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });

  const rawU = req.query.u;
  const u = Array.isArray(rawU) ? rawU[0] : rawU;
  if (!u || typeof u !== "string") {
    return res.status(400).json({ error: "missing 'u' query param" });
  }

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return res.status(400).json({ error: "invalid URL" });
  }
  if (parsed.protocol !== "https:") {
    return res.status(400).json({ error: "only https:// upstreams allowed" });
  }
  if (!hostIsAllowed(parsed.hostname)) {
    return res.status(400).json({ error: `host '${parsed.hostname}' not on the allowlist` });
  }

  // Fetch the upstream image. No Referer is sent (Vercel functions
  // don't have a document origin); Meta's CDN treats it like a direct
  // CDN hit and serves the bytes.
  let upstream: Response;
  try {
    upstream = await fetch(u);
  } catch (ex) {
    return res.status(502).json({ error: `upstream fetch failed: ${(ex as Error).message}` });
  }

  if (!upstream.ok) {
    // Common cases: 410/404 once the IG-signed URL expires (~10 days).
    // Let the client's <img onError> fallback handle it visually.
    return res.status(upstream.status).end();
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const contentLength = upstream.headers.get("content-length");

  res.setHeader("Content-Type", contentType);
  if (contentLength) res.setHeader("Content-Length", contentLength);

  // Permissive CORP so other origins (the dashboard) can embed this.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  // Aggressive edge cache — IG URLs are signed and rotate every few
  // days, but within a day they're stable. `public` so Vercel's edge
  // can serve repeated requests without hitting the origin.
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");

  const buf = Buffer.from(await upstream.arrayBuffer());
  return res.status(200).send(buf);
}
