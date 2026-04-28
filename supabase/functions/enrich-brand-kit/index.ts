// =====================================================================
// enrich-brand-kit
//
// Given a brand kit (looked up by brand_id, account_slug, or account_name)
// and a website URL, scrape the site with Firecrawl, extract visual brand
// tokens (branding format) plus editorial signals (extract format), and
// persist the result onto brand_kits + an audit row in
// brand_kit_enrichments.
//
// Auth model:
//   - Caller's JWT is verified by the platform (verify_jwt = true).
//   - We use the caller's JWT to load the target brand_kit through RLS so
//     a user can only enrich kits they actually have access to.
//   - Writes are done with the service-role client so we can populate
//     fields that the user's RLS update policy might not cover.
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

// JSON schema we hand Firecrawl's /extract format. Each field maps onto
// either an existing brand_kits column or a new one added in migration
// 0017. Keep names verbatim — they're written into brand_kits.* directly.
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    tagline: { type: "string", description: "Short brand tagline / hero strapline." },
    mission: { type: "string", description: "Mission or purpose statement, 1-2 sentences." },
    audience: {
      type: "string",
      description: "Plain-English description of the target audience / ICP.",
    },
    positioning_statement: {
      type: "string",
      description: "One-sentence positioning: what they offer, for whom, and why it matters.",
    },
    industry: {
      type: "string",
      description: "Industry/category, e.g. 'specialty coffee', 'B2B SaaS analytics'.",
    },
    tone_voice: {
      type: "string",
      description: "Brand voice in plain English (e.g. 'warm, confident, lightly playful').",
    },
    voice_tags: {
      type: "array",
      items: { type: "string" },
      description: "3-6 short adjectives describing tone (e.g. 'editorial', 'warm', 'bold').",
    },
    value_props: {
      type: "array",
      items: { type: "string" },
      description: "Top 3-5 customer-facing value propositions, each one short phrase.",
    },
    brand_pillars: {
      type: "array",
      items: { type: "string" },
      description: "3-5 conceptual pillars the brand returns to repeatedly.",
    },
    key_differentiators: {
      type: "array",
      items: { type: "string" },
      description: "What makes this brand notably different from competitors.",
    },
    product_categories: {
      type: "array",
      items: { type: "string" },
      description: "Major product or service categories the brand sells.",
    },
    dos: {
      type: "array",
      items: { type: "string" },
      description: "Stylistic do's: short phrasing rules visible from the site's copy.",
    },
    donts: {
      type: "array",
      items: { type: "string" },
      description: "Stylistic don'ts: things this brand notably avoids in tone or claims.",
    },
    social_links: {
      type: "object",
      properties: {
        instagram: { type: "string" },
        tiktok: { type: "string" },
        linkedin: { type: "string" },
        twitter: { type: "string" },
        youtube: { type: "string" },
        facebook: { type: "string" },
      },
      description: "Any social profile URLs visible on the page (footer, header, etc.).",
    },
  },
};

const EXTRACT_PROMPT = `Read this brand's website and fill the schema with what you can confidently infer. Be conservative: leave fields empty rather than fabricate. Voice tags should be specific (avoid generic 'modern', 'professional'). Mission and positioning should sound like the brand wrote them, not a third-party description.`;

type EnrichRequest = {
  brand_id?: string;
  account_slug?: string;
  account_name?: string;
  website_url?: string;
  // mode === 'discover': run URL discovery on seed_url, return the
  //   DiscoveredUrls map plus any pending_agents (slow sources whose
  //   Firecrawl Agent run was kicked off but won't be done synchronously).
  // mode === 'check_agent': given an agent_id, poll Firecrawl and return
  //   { status, data } for the run.
  // mode === 'enrich' (default): existing single-URL website enrichment
  //   path — preserved for the current onboarding flow until Day 2's
  //   multi-source dispatcher replaces it.
  mode?: "discover" | "check_agent" | "enrich";
  seed_url?: string;
  agent_id?: string;
};

type FirecrawlResponse = {
  success?: boolean;
  data?: {
    branding?: Record<string, unknown>;
    extract?: Record<string, unknown>;
    json?: Record<string, unknown>;
    markdown?: string;
    metadata?: Record<string, unknown>;
  };
  warning?: string;
  error?: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normaliseUrl(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function callFirecrawl(url: string): Promise<FirecrawlResponse> {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url,
      formats: [
        "branding",
        "markdown",
        {
          type: "json",
          schema: EXTRACT_SCHEMA,
          prompt: EXTRACT_PROMPT,
        },
      ],
      onlyMainContent: false,
      // Cloudflare-fronted Shopify / Webflow / Wix sites occasionally serve
      // Firecrawl's basic scraper a "Just a moment…" / "Something went wrong"
      // wall page on first contact. `proxy: "auto"` tries basic first and
      // transparently falls back to stealth on bot challenge — costs more
      // credits only when needed but stops us from saving wall-page text
      // (titled "Something went wrong") as if it were the real homepage.
      proxy: "auto",
      // Give JS-heavy storefronts a beat to render branding tokens.
      waitFor: 2500,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as FirecrawlResponse;
  if (!res.ok) {
    throw new Error(
      `Firecrawl ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`,
    );
  }
  assertNotBotWall(body, url);
  return body;
}

// Page titles served by common bot-protection pages. If Firecrawl returns
// a page whose title matches any of these, we got the wall — not the real
// site — and writing its contents to brand_kits would mean saving black/
// grey defaults with high confidence (the wall page has no real content).
// Throw instead so the existing failed-status path runs and the previous
// (real) values stay intact.
const BOT_WALL_TITLE_PATTERNS = [
  /^something went wrong$/i,
  /^just a moment/i,
  /attention required.*cloudflare/i,
  /^access denied/i,
  /verify you are human/i,
  /checking your browser/i,
  /please enable javascript/i,
];

function assertNotBotWall(fc: FirecrawlResponse, url: string): void {
  const data = (fc?.data ?? {}) as Record<string, unknown>;
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const title = typeof meta.title === "string" ? meta.title.trim() : "";
  if (title && BOT_WALL_TITLE_PATTERNS.some((re) => re.test(title))) {
    throw new Error(
      `Site protection blocked the scrape of ${url} (got "${title}" instead of the real page). Try again in a moment.`,
    );
  }
}

// =====================================================================
// URL DISCOVERY — given any seed URL (website, Instagram, TikTok,
// LinkedIn, etc.), figure out the brand's other channels so multi-source
// enrichment has a complete starting point. Brands often have a much
// richer presence on one social than their website (or no website at
// all), so we treat any source as a valid seed.
//
// Strategy:
//   - Detect the seed URL's platform
//   - Pull text from that source via the appropriate Firecrawl endpoint
//     (scrape for sites Firecrawl supports; agent for Instagram/TikTok
//     which scrape blocks)
//   - Extract every other supported URL we can find via regex on the
//     resulting markdown / agent response
//   - Return a normalised map { website, instagram, tiktok, linkedin,
//     twitter, youtube, facebook }, dropping anything we couldn't find
// =====================================================================

type DiscoveredUrls = {
  website?: string;
  instagram?: string;
  tiktok?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
  facebook?: string;
};

type Platform = keyof DiscoveredUrls;

function detectPlatform(url: string): Platform {
  const u = url.toLowerCase();
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("tiktok.com")) return "tiktok";
  if (u.includes("linkedin.com")) return "linkedin";
  if (u.includes("twitter.com") || u.includes("x.com/")) return "twitter";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("facebook.com") || u.includes("fb.com")) return "facebook";
  return "website";
}

// Content-path segments that are emphatically NOT profile URLs. We use
// a negative lookahead in each platform pattern so a page that links to
// a reel or a post doesn't get mistaken for the brand's profile.
const SOCIAL_PATTERNS: Record<Exclude<Platform, "website">, RegExp> = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/(?!reel|reels|p|tv|stories|explore|accounts|directory|s\/)([A-Za-z0-9._\-]+)/i,
  tiktok:    /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._\-]+/i,
  linkedin:  /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9._\-]+/i,
  twitter:   /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!i\/|search|home|explore|hashtag|intent|share)([A-Za-z0-9._\-]+)/i,
  youtube:   /https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|@|c\/|user\/)[A-Za-z0-9._\-]+/i,
  facebook:  /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|dialog|share|tr\?|plugins|business)([A-Za-z0-9._\-]+)/i,
};

// Find a plausible website link in raw markdown / text. We look for any
// http(s) URL whose hostname doesn't match a known social platform and
// isn't a well-known utility/CDN/short-link host.
const NON_BRAND_HOSTS = /(?:cdn|cloudfront|akamai|gstatic|googletagmanager|google-analytics|googleadservices|doubleclick|gravatar|imgur|wp\.com|wordpress\.com|wp-includes|fonts\.|fbcdn|cdninstagram|tiktokcdn|amazonaws|stripe|recaptcha|hcaptcha|cloudflare|jsdelivr|unpkg|githubusercontent|bit\.ly|linktr\.ee|lnk\.bio|beacons\.ai|t\.co|hubspot)/i;

function extractWebsiteFromText(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s)>"'`<]+/gi) || [];
  for (const raw of matches) {
    const trimmed = raw.replace(/[.,;:!?)\]]+$/g, "");
    let host: string;
    try { host = new URL(trimmed).hostname.toLowerCase(); }
    catch { continue; }
    if (/^(www\.)?(instagram|tiktok|linkedin|twitter|x|youtube|youtu|facebook|fb)\./.test(host)) continue;
    if (NON_BRAND_HOSTS.test(host)) continue;
    if (host.endsWith(".css") || host.endsWith(".js")) continue;
    // Skip typical asset paths
    if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|mp4|pdf)(\?|$)/i.test(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

function extractSocialsFromText(text: string): DiscoveredUrls {
  const out: DiscoveredUrls = {};
  for (const [platform, re] of Object.entries(SOCIAL_PATTERNS) as Array<[Exclude<Platform, "website">, RegExp]>) {
    // Collect every match across the whole text, then pick the most
    // frequently linked URL — the brand's real profile usually appears
    // in many places (header, footer, "Follow us"), while incidental
    // links (one-off reel embed, share button) appear once.
    const globalRe = new RegExp(re.source, "gi");
    const counts = new Map<string, number>();
    const matches = text.match(globalRe) || [];
    for (const raw of matches) {
      // Normalise: strip trailing punctuation and a trailing slash so
      // /abcoffeeindia and /abcoffeeindia/ count as the same handle.
      const normalised = raw.replace(/[.,;:!?)\]]+$/g, "").replace(/\/$/, "");
      counts.set(normalised, (counts.get(normalised) || 0) + 1);
    }
    if (counts.size === 0) continue;
    const [winner] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    out[platform] = winner;
  }
  return out;
}

// Fast scrape for sites Firecrawl supports natively (websites, LinkedIn).
// We only need markdown to find links — no need for the heavier formats.
async function quickScrapeMarkdown(url: string): Promise<string> {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({ url, formats: ["markdown", "links"], onlyMainContent: false }),
  });
  const body = await res.json().catch(() => ({})) as { data?: { markdown?: string; links?: string[] } };
  const md = body?.data?.markdown ?? "";
  const links = (body?.data?.links ?? []).join("\n");
  return md + "\n" + links;
}

// Kick off a Firecrawl Agent run and return the run ID immediately.
// Agent runs on social sites typically take 60-180s — far longer than
// a Supabase edge function CPU budget allows — so we always dispatch
// async and let callers (the discovery flow / multi-source enrichment)
// poll the run separately or stash the ID in the DB for a background
// worker to finish.
async function agentDispatch(url: string, prompt: string, schema: Record<string, unknown>): Promise<string> {
  const startRes = await fetch("https://api.firecrawl.dev/v2/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ urls: [url], prompt, schema, model: "spark-1-mini" }),
  });
  const startBody = (await startRes.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!startRes.ok || !startBody.id) {
    throw new Error(`Agent dispatch failed: ${startBody.error ?? "no id returned"}`);
  }
  return startBody.id;
}

type AgentPoll = { status: "processing" | "completed" | "failed"; data?: Record<string, unknown>; error?: string };

async function agentPoll(runId: string): Promise<AgentPoll> {
  const res = await fetch(`https://api.firecrawl.dev/v2/agent/${runId}`, {
    headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as AgentPoll;
  return body;
}

const URL_DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    website:   { type: "string", description: "Brand's website URL if mentioned in bio, link-in-bio, or post captions." },
    instagram: { type: "string", description: "Instagram profile URL if linked." },
    tiktok:    { type: "string", description: "TikTok profile URL if linked." },
    linkedin:  { type: "string", description: "LinkedIn company or profile URL if linked." },
    twitter:   { type: "string", description: "Twitter/X profile URL if linked." },
    youtube:   { type: "string", description: "YouTube channel URL if linked." },
    facebook:  { type: "string", description: "Facebook page URL if linked." },
  },
};

const URL_DISCOVERY_PROMPT = "Find every URL this brand uses to reach customers. Look in bio, profile fields, link-in-bio aggregators, and any links shown in recent posts. Only return URLs that clearly belong to this brand — skip third-party brand mentions, customer accounts, etc.";

// Main discovery entry point. Always returns within a few seconds.
//   - For "fast" seeds (website / LinkedIn / Facebook): runs a synchronous
//     scrape, parses links, returns a complete DiscoveredUrls map.
//   - For "slow" seeds (Instagram / TikTok / sometimes Twitter): kicks off
//     a Firecrawl Agent run and returns the run ID under
//     `pending_agents`. The caller polls those run IDs (via the
//     check_agent mode) and merges results when each completes.
type DiscoveryResult = {
  discovered: DiscoveredUrls;
  pending_agents: Array<{ platform: Platform; seed_url: string; agent_id: string }>;
};

async function discoverBrandUrls(seedUrl: string): Promise<DiscoveryResult> {
  const seed = normaliseUrl(seedUrl);
  if (!seed) return { discovered: {}, pending_agents: [] };
  const platform = detectPlatform(seed);
  const discovered: DiscoveredUrls = { [platform]: seed } as DiscoveredUrls;
  const pending: DiscoveryResult["pending_agents"] = [];

  try {
    if (platform === "website" || platform === "linkedin" || platform === "facebook") {
      // Firecrawl /v2/scrape supports these — fast sync path.
      const text = await quickScrapeMarkdown(seed);
      const socials = extractSocialsFromText(text);
      for (const [k, v] of Object.entries(socials)) {
        if (!discovered[k as Platform]) discovered[k as Platform] = v;
      }
      if (platform !== "website" && !discovered.website) {
        const w = extractWebsiteFromText(text);
        if (w) discovered.website = w;
      }
    } else if (platform === "instagram" || platform === "tiktok" || platform === "twitter") {
      // /v2/scrape blocks these (or returns nothing useful) — Agent only.
      // We dispatch and return the run ID; caller polls.
      const agentId = await agentDispatch(seed, URL_DISCOVERY_PROMPT, URL_DISCOVERY_SCHEMA);
      pending.push({ platform, seed_url: seed, agent_id: agentId });
    } else if (platform === "youtube") {
      // YouTube /scrape returns about pages OK most of the time.
      try {
        const text = await quickScrapeMarkdown(seed);
        const socials = extractSocialsFromText(text);
        for (const [k, v] of Object.entries(socials)) {
          if (!discovered[k as Platform]) discovered[k as Platform] = v;
        }
        if (!discovered.website) {
          const w = extractWebsiteFromText(text);
          if (w) discovered.website = w;
        }
      } catch {
        const agentId = await agentDispatch(seed, URL_DISCOVERY_PROMPT, URL_DISCOVERY_SCHEMA);
        pending.push({ platform, seed_url: seed, agent_id: agentId });
      }
    }
  } catch (e) {
    // Discovery is best-effort. Log + return whatever we have.
    console.error(`discoverBrandUrls(${platform}=${seed}) failed:`, e);
  }

  return { discovered, pending_agents: pending };
}

// Merge an Agent run's discovery payload into an existing DiscoveredUrls
// map. Used by callers who finish polling pending agents and want to
// fold the results back in.
function mergeAgentDiscovery(into: DiscoveredUrls, fromAgent: Record<string, unknown>): DiscoveredUrls {
  const out = { ...into };
  for (const k of Object.keys(URL_DISCOVERY_SCHEMA.properties) as Platform[]) {
    const v = fromAgent[k];
    if (typeof v === "string" && v.trim() && !out[k]) {
      out[k] = v.trim();
    }
  }
  return out;
}

// Pull a string out of a possibly-nested record without throwing.
function pickStr(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return null;
    }
  }
  return typeof cur === "string" && cur.trim() ? cur : null;
}

function pickArr<T = unknown>(obj: unknown, path: string[]): T[] | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return null;
    }
  }
  return Array.isArray(cur) ? (cur as T[]) : null;
}

function pickObj(obj: unknown, path: string[]): Record<string, unknown> | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return null;
    }
  }
  return cur && typeof cur === "object" && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null;
}

// Pull every image URL out of Firecrawl's markdown (![alt](url)) and
// rank candidates for the photography section. We skip:
//   - SVGs / known icon assets (social, play buttons, dashboard mockups)
//   - URLs that look like the brand's own logo/favicon (already stored)
//   - Mockup screenshots (customer/orders/dashboard)
//   - Tiny aspect-ratio-suggesting filenames (e.g. 100x40 logos)
// Returns up to `max` candidates with a kicker derived from the alt text or
// filename so the UI shows something readable while users curate.
function pickProductImages(
  markdown: string | undefined,
  branding: Record<string, unknown>,
  max = 6,
): Array<{ id: string; image_url: string; kicker: string; source: string }> {
  if (!markdown) return [];
  const logoUrl = (pickStr(branding, ["images", "logo"]) ?? pickStr(branding, ["logo"]) ?? "").toLowerCase();
  const faviconUrl = (pickStr(branding, ["images", "favicon"]) ?? "").toLowerCase();
  const seen = new Set<string>();
  const out: Array<{ id: string; image_url: string; kicker: string; source: string }> = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const alt = (m[1] || "").trim();
    const url = (m[2] || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const lc = url.toLowerCase();
    if (lc.endsWith(".svg")) continue;
    if (lc === logoUrl || lc === faviconUrl) continue;
    // Heuristic skips for icons/mockups commonly bundled in marketing sites.
    if (/_(logo|icon|fb|insta|instagram|twitter|linkedin|youtube|in|x|social|play-icon|dashboard)/i.test(url)) continue;
    if (/(customer|orders|dashboard|mockup|frame%20|frame_)/i.test(url)) continue;
    if (/yt3\.ggpht\.com/i.test(url)) continue;
    // Derive a kicker. Prefer the alt text when meaningful, otherwise pull
    // a readable slug from the filename.
    let kicker = alt && alt.length > 0 && alt.length < 60 ? alt : "";
    if (!kicker) {
      const filename = decodeURIComponent(url.split("/").pop() || "")
        .replace(/\.[a-z]+$/i, "")
        .replace(/^[0-9a-f]{16,}_?/i, "")
        .replace(/[_-]+/g, " ")
        .trim();
      kicker = filename.slice(0, 60);
    }
    if (!kicker) kicker = "Reference";
    out.push({ id: `ph-fc-${out.length + 1}`, image_url: url, kicker, source: "website" });
    if (out.length >= max) break;
  }
  return out;
}

// Build the brand_kits update payload from a Firecrawl response.
// Existing values are preserved unless Firecrawl returned a non-empty
// replacement — we never overwrite a user's manual edits with null.
function buildKitUpdate(fc: FirecrawlResponse, sourceUrl: string) {
  const branding = fc?.data?.branding ?? {};
  // Firecrawl returns extract under either `extract` or `json` depending
  // on version; check both.
  const extract =
    (fc?.data?.extract as Record<string, unknown>) ||
    (fc?.data?.json as Record<string, unknown>) ||
    {};

  const update: Record<string, unknown> = {
    enrichment: { branding, extract, metadata: fc?.data?.metadata ?? null },
    enrichment_url: sourceUrl,
    enriched_at: new Date().toISOString(),
    enrichment_status: "success",
    enrichment_error: null,
  };

  // ---- Visual ---------------------------------------------------------
  const colors = pickObj(branding, ["colors"]) ?? {};
  if (typeof colors.primary === "string") update.primary_color = colors.primary;
  if (typeof colors.secondary === "string") update.secondary_color = colors.secondary;
  if (typeof colors.accent === "string") update.accent_color = colors.accent;
  if (typeof colors.background === "string") update.background_color = colors.background;
  if (typeof colors.textPrimary === "string") update.text_primary_color = colors.textPrimary;
  if (typeof colors.textSecondary === "string") update.text_secondary_color = colors.textSecondary;

  const semantic: Record<string, unknown> = {};
  for (const k of ["link", "success", "warning", "error"]) {
    if (typeof colors[k] === "string") semantic[k] = colors[k];
  }
  if (Object.keys(semantic).length) update.semantic_colors = semantic;

  if (typeof (branding as Record<string, unknown>).colorScheme === "string") {
    update.color_scheme = (branding as Record<string, unknown>).colorScheme;
  }

  const logo = pickStr(branding, ["images", "logo"]) ?? pickStr(branding, ["logo"]);
  if (logo) update.logo_url = logo;
  const favicon = pickStr(branding, ["images", "favicon"]);
  if (favicon) update.favicon_url = favicon;
  const ogImage = pickStr(branding, ["images", "ogImage"]);
  if (ogImage) update.og_image_url = ogImage;

  // Compose a 'palette' array of the most actionable colors so the
  // existing UI (which already reads kit.palette) lights up immediately.
  const paletteCandidates = [
    colors.primary,
    colors.secondary,
    colors.accent,
    colors.background,
    colors.textPrimary,
  ].filter((c): c is string => typeof c === "string");
  if (paletteCandidates.length) {
    update.palette = paletteCandidates.map((hex, i) => ({
      hex,
      role: ["primary", "secondary", "accent", "background", "text"][i] ?? "extra",
    }));
  }

  // Typography
  const typography = pickObj(branding, ["typography"]);
  if (typography) update.type_scale = typography;
  const fonts = pickArr(branding, ["fonts"]);
  if (fonts && fonts.length) update.fonts = fonts;

  // Tokens / components
  const spacing = pickObj(branding, ["spacing"]);
  if (spacing) update.spacing_tokens = spacing;
  const components = pickObj(branding, ["components"]);
  if (components) update.ui_components = components;

  // Personality (Firecrawl branding includes its own personality block;
  // editorial extract may also produce voice tags, etc.)
  const personality = pickObj(branding, ["personality"]);
  if (personality) update.personality = personality;

  // ---- Editorial (extract format) ------------------------------------
  const editorialStringFields: Array<[string, string]> = [
    ["tagline", "tagline"],
    ["mission", "mission"],
    ["audience", "audience"],
    ["tone_voice", "tone_voice"],
    ["positioning_statement", "positioning_statement"],
    ["industry", "industry"],
  ];
  for (const [src, dst] of editorialStringFields) {
    const v = pickStr(extract, [src]);
    if (v) update[dst] = v;
  }

  const editorialArrayFields = [
    "voice_tags",
    "value_props",
    "brand_pillars",
    "key_differentiators",
    "product_categories",
    "dos",
    "donts",
  ];
  for (const f of editorialArrayFields) {
    const arr = pickArr(extract, [f]);
    if (arr && arr.length) update[f] = arr;
  }

  const social = pickObj(extract, ["social_links"]);
  if (social && Object.keys(social).length) {
    // Merge with whatever's already stored; we'll do this on the caller
    // side after fetching current row.
    update.__social_links_partial = social;
  }

  // Photography from website images. Each entry gets a brand-coloured
  // palette as fallback so the gradient placeholder stays on-brand if an
  // image ever 404s.
  const markdown = (fc?.data?.markdown ?? "") as string;
  const candidates = pickProductImages(markdown, branding as Record<string, unknown>, 6);
  if (candidates.length) {
    const fallbackPalette = [
      typeof colors.primary === "string" ? colors.primary : "#F4EBDD",
      typeof colors.background === "string" ? colors.background : "#1B1F1C",
      typeof colors.accent === "string"
        ? colors.accent
        : (typeof colors.secondary === "string" ? colors.secondary : "#E8C9A8"),
    ];
    update.photography = candidates.map((c) => ({ ...c, palette: fallbackPalette }));
  }

  // ---- Page metadata (data.metadata) ---------------------------------
  // The previous build dropped this entire block. Some of these are
  // higher-quality copy than the extract LLM produces (the brand wrote
  // them themselves) so we promote them to first-class columns.
  const metadata = pickObj(fc?.data, ["metadata"]) ?? {};
  const metaTitle = pickStr(metadata, ["title"]);
  if (metaTitle) update.meta_title = metaTitle;
  const metaDesc = pickStr(metadata, ["description"]);
  if (metaDesc) update.meta_description = metaDesc;
  const ogTitle = pickStr(metadata, ["ogTitle"]) ?? pickStr(metadata, ["og:title"]);
  if (ogTitle) update.og_title = ogTitle;
  const ogDesc = pickStr(metadata, ["ogDescription"]) ?? pickStr(metadata, ["og:description"]);
  if (ogDesc) update.og_description = ogDesc;
  const lang = pickStr(metadata, ["language"]);
  if (lang) update.language = lang;

  const twitter: Record<string, unknown> = {};
  for (const [src, dst] of [
    ["twitter:card", "card"],
    ["twitter:title", "title"],
    ["twitter:description", "description"],
    ["twitter:image", "image"],
  ] as const) {
    const v = pickStr(metadata, [src]);
    if (v) twitter[dst] = v;
  }
  if (Object.keys(twitter).length) update.twitter_card = twitter;

  // Telemetry breadcrumbs: useful for cost dashboards + Firecrawl support.
  const credits = (metadata as Record<string, unknown>).creditsUsed;
  if (typeof credits === "number") update.enrichment_credits_used = credits;
  const scrapeId = pickStr(metadata, ["scrapeId"]);
  if (scrapeId) update.enrichment_scrape_id = scrapeId;

  // ---- Branding subfields we weren't promoting -----------------------
  const fontStacks = pickObj(branding, ["typography", "fontStacks"]);
  if (fontStacks) update.font_stacks = fontStacks;

  const confidence = pickObj(branding, ["confidence"]);
  if (confidence) update.confidence_scores = confidence;

  const designSystem = pickObj(branding, ["designSystem"]);
  if (designSystem) update.design_system = designSystem;

  // Combine logo + button reasoning under one llm_reasoning column.
  const llmReasoning: Record<string, unknown> = {};
  const logoReasoning = pickObj(branding, ["__llm_logo_reasoning"]);
  if (logoReasoning) llmReasoning.logo = logoReasoning;
  const buttonReasoning = pickObj(branding, ["__llm_button_reasoning"]);
  if (buttonReasoning) llmReasoning.buttons = buttonReasoning;
  const llmMeta = pickObj(branding, ["__llm_metadata"]);
  if (llmMeta) llmReasoning.meta = llmMeta;
  if (Object.keys(llmReasoning).length) update.llm_reasoning = llmReasoning;

  return update;
}

async function resolveBrandKit(
  userClient: ReturnType<typeof createClient>,
  body: EnrichRequest,
): Promise<
  | {
      ok: true;
      kit: { id: string; account_id: string; website_url: string | null; social_links: Record<string, unknown> };
    }
  | { ok: false; status: number; error: string }
> {
  // Path 1: explicit brand_kit / account UUID.
  if (body.brand_id) {
    const { data, error } = await userClient
      .from("brand_kits")
      .select("id, account_id, website_url, social_links")
      .or(`id.eq.${body.brand_id},account_id.eq.${body.brand_id}`)
      .maybeSingle();
    if (error) return { ok: false, status: 400, error: error.message };
    if (!data) return { ok: false, status: 404, error: "brand_kit not found or not accessible" };
    return { ok: true, kit: data as typeof data & { social_links: Record<string, unknown> } };
  }

  // Path 2: account_slug or account_name lookup. Restricted to accounts
  // the caller has access to via RLS on accounts.
  const { data: accounts, error } = await userClient
    .from("accounts")
    .select("id, name, slug")
    .eq("type", "brand")
    .or(
      [
        body.account_slug ? `slug.eq.${body.account_slug}` : null,
        body.account_name ? `name.ilike.${body.account_name}` : null,
      ]
        .filter(Boolean)
        .join(","),
    );
  if (error) return { ok: false, status: 400, error: error.message };
  if (!accounts || accounts.length === 0) {
    return { ok: false, status: 404, error: "No matching brand account accessible to caller" };
  }
  if (accounts.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Multiple matches: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`,
    };
  }
  const acc = accounts[0];
  const { data: kit, error: kitErr } = await userClient
    .from("brand_kits")
    .select("id, account_id, website_url, social_links")
    .eq("account_id", acc.id)
    .maybeSingle();
  if (kitErr) return { ok: false, status: 400, error: kitErr.message };
  if (!kit) return { ok: false, status: 404, error: `brand_kit missing for account ${acc.id}` };
  return { ok: true, kit: kit as typeof kit & { social_links: Record<string, unknown> } };
}

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

  // 1. Parse body.
  let body: EnrichRequest;
  try {
    body = (await req.json()) as EnrichRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // 1a. Discovery short-circuit — given any seed URL, return the
  // DiscoveredUrls map plus a pending_agents list for slow sources whose
  // Agent runs were kicked off but won't finish synchronously. Caller
  // polls those via mode=check_agent. No DB writes.
  if (body.mode === "discover") {
    const seed = body.seed_url || body.website_url;
    if (!seed) return jsonResponse({ error: "discover mode requires seed_url" }, 400);
    const result = await discoverBrandUrls(seed);
    return jsonResponse({ ok: true, mode: "discover", seed_url: seed, ...result });
  }

  // 1b. Poll a Firecrawl Agent run started elsewhere (typically by a
  // prior discover call). Returns { status: 'processing'|'completed'|'failed' }
  // and the data payload when complete.
  if (body.mode === "check_agent") {
    if (!body.agent_id) return jsonResponse({ error: "check_agent mode requires agent_id" }, 400);
    const poll = await agentPoll(body.agent_id);
    if (poll.status === "completed" && poll.data) {
      return jsonResponse({ ok: true, mode: "check_agent", agent_id: body.agent_id, status: "completed", data: poll.data, merged: mergeAgentDiscovery({}, poll.data) });
    }
    return jsonResponse({ ok: true, mode: "check_agent", agent_id: body.agent_id, status: poll.status ?? "unknown", error: poll.error });
  }

  // 2. RLS-aware client (uses caller's JWT) for lookup + access check.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

  // Detect ops/service-role caller. The Supabase service-role JWT carries
  // role=service_role; in that mode we skip the per-user RLS lookup and
  // require an explicit brand_id from the caller.
  let isServiceRole = false;
  try {
    const payload = bearer.split(".")[1];
    if (payload) {
      const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      if (decoded?.role === "service_role") isServiceRole = true;
    }
  } catch (_) {
    /* malformed JWT — fall through to user-auth path */
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let triggeredBy: string | null = null;
  if (!isServiceRole) {
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return jsonResponse({ error: "Not authenticated" }, 401);
    }
    triggeredBy = user.id;
  }

  // 3. Resolve target brand kit. Service-role uses the admin client (no
  // RLS). User-mode uses the userClient so RLS scopes the lookup.
  const resolveClient = isServiceRole
    ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
    : userClient;
  if (isServiceRole && !body.brand_id && !body.account_slug && !body.account_name) {
    return jsonResponse(
      { error: "service-role calls must specify brand_id, account_slug, or account_name" },
      400,
    );
  }
  const resolved = await resolveBrandKit(resolveClient, body);
  if (!resolved.ok) return jsonResponse({ error: resolved.error }, resolved.status);
  const kit = resolved.kit;

  const sourceUrl = normaliseUrl(body.website_url) ?? normaliseUrl(kit.website_url);
  if (!sourceUrl) {
    return jsonResponse(
      { error: "No website_url provided and none stored on brand kit" },
      400,
    );
  }

  // 4. Service-role client for writes.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 5. Insert audit row (status=pending) so we always have a record even
  // if Firecrawl times out or panics.
  const { data: runRow, error: runErr } = await adminClient
    .from("brand_kit_enrichments")
    .insert({
      brand_kit_id: kit.id,
      account_id: kit.account_id,
      source_url: sourceUrl,
      status: "pending",
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();
  if (runErr) return jsonResponse({ error: `audit insert failed: ${runErr.message}` }, 500);
  const runId = runRow!.id;

  // Mark the brand_kit as enrichment-pending so the UI can show a spinner.
  await adminClient
    .from("brand_kits")
    .update({ enrichment_status: "pending", enrichment_error: null })
    .eq("id", kit.id);

  // 6. Call Firecrawl.
  let fcResponse: FirecrawlResponse;
  try {
    fcResponse = await callFirecrawl(sourceUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await adminClient
      .from("brand_kit_enrichments")
      .update({ status: "failed", error_message: msg, completed_at: new Date().toISOString() })
      .eq("id", runId);
    await adminClient
      .from("brand_kits")
      .update({ enrichment_status: "failed", enrichment_error: msg })
      .eq("id", kit.id);
    return jsonResponse({ error: msg, run_id: runId }, 502);
  }

  // 7. Build update payload and write back.
  const update = buildKitUpdate(fcResponse, sourceUrl);

  // Merge social_links from extract with any existing values (preserve
  // anything the user already set; only fill blanks).
  const partialSocial = update.__social_links_partial as
    | Record<string, unknown>
    | undefined;
  delete update.__social_links_partial;
  if (partialSocial) {
    const existing = (kit.social_links ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(partialSocial)) {
      if (v && (!existing[k] || existing[k] === "")) merged[k] = v;
    }
    update.social_links = merged;
  }

  const { error: updateErr } = await adminClient
    .from("brand_kits")
    .update(update)
    .eq("id", kit.id);

  if (updateErr) {
    await adminClient
      .from("brand_kit_enrichments")
      .update({
        status: "failed",
        raw_response: fcResponse,
        error_message: `db update: ${updateErr.message}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return jsonResponse({ error: updateErr.message, run_id: runId }, 500);
  }

  await adminClient
    .from("brand_kit_enrichments")
    .update({
      status: "success",
      raw_response: fcResponse,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  return jsonResponse({
    ok: true,
    run_id: runId,
    brand_kit_id: kit.id,
    account_id: kit.account_id,
    source_url: sourceUrl,
    populated_fields: Object.keys(update).filter(
      (k) => !["enrichment", "enrichment_url", "enriched_at", "enrichment_status", "enrichment_error"].includes(k),
    ),
  });
});
