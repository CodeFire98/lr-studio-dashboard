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
    }),
  });
  const body = (await res.json().catch(() => ({}))) as FirecrawlResponse;
  if (!res.ok) {
    throw new Error(
      `Firecrawl ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
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
