// =====================================================================
// /api/find-competitors — Vercel serverless function
//
// Identifies 3-6 competitor / aspiration brands for a given brand and
// writes them to brand_kits.competitors (jsonb). Each entry: {name,
// handle, url}.
//
// Why on Vercel and not bundled into the existing Supabase
// `enrich-brand-kit` edge function: that edge function exists on prod
// but the Apify/Supabase deploy infrastructure is currently 403'ing
// for our PAT (account-level permission issue with the multipart
// deploy endpoint, see project-memory). Moving this surface to Vercel
// lets us co-deploy with the SPA on every push to main with no
// friction — same pattern we adopted for /api/fetch-trends.
//
// The BrandKitView's "Fetch Brand" action invokes BOTH the existing
// enrich-brand-kit edge function AND this route in parallel. Each
// updates a different slice of brand_kits; neither blocks the other.
//
// Auth model:
//   - Caller's JWT verified against Supabase auth.
//   - Caller must be agency staff (profiles.is_agency = true) OR a
//     member of the target brand. The JWT-scoped read of brand_kits
//     enforces this via RLS.
//   - Writes use the service-role client (RLS denies authenticated
//     UPDATE of arbitrary brand_kits — same model as enrich-brand-kit).
//
// Env vars (all on the lr-studio-dashboard-3kkp Vercel project):
//   FIRECRAWL_API_KEY         — required, fc-...
//   SUPABASE_URL              — https://vmfwnfflhvskadkfnvds.supabase.co
//   SUPABASE_ANON_KEY         — for JWT verification
//   SUPABASE_SERVICE_ROLE_KEY — for writing brand_kits.competitors
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Firecrawl /v2/scrape extract schema. We ask Firecrawl's LLM to read
// the brand's website and infer 3-6 competitor brands with active
// Instagram presence. Conservative — better to return fewer real ones
// than fabricate handles.
const COMPETITORS_SCHEMA = {
  type: "object",
  properties: {
    competitors: {
      type: "array",
      description:
        "3-6 brands that compete with this one or that this brand likely looks up to in its category. Use brands the website itself references where possible (testimonials, partner logos, comparison tables); otherwise infer from the category. Each entry should be a real, well-known brand with an active Instagram presence.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Brand display name as humans say it (e.g. 'NYT Cooking', 'Drunk Elephant').",
          },
          instagram_handle: {
            type: "string",
            description:
              "The competitor's Instagram username (without the @). Confirm it's active and matches the brand. Lowercase. Allow letters, digits, underscores and dots (e.g. nyt.cooking, drunk_elephant).",
          },
        },
        required: ["name", "instagram_handle"],
      },
    },
  },
  required: ["competitors"],
};

const COMPETITORS_PROMPT =
  "Read this brand's website and identify 3-6 competitor brands or aspirational peers in the same category. For each, return the display name and the brand's actual Instagram handle (without the @). Use real, verifiable brands with active Instagram accounts. Don't fabricate handles — leave the list short rather than guess.";

type FirecrawlExtractResponse = {
  success?: boolean;
  data?: {
    json?: {
      competitors?: Array<{ name?: string; instagram_handle?: string }>;
    };
  };
  error?: string;
};

async function firecrawlExtractCompetitors(url: string): Promise<{
  competitors: Array<{ name: string; instagram_handle: string }>;
  error?: string;
}> {
  let res: Response;
  try {
    res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: [
          {
            type: "json",
            schema: COMPETITORS_SCHEMA,
            prompt: COMPETITORS_PROMPT,
          },
        ],
        onlyMainContent: false, // footer often lists partner / competitor brands
        waitFor: 2500,
        proxy: "auto",
      }),
    });
  } catch (ex) {
    return { competitors: [], error: `firecrawl network: ${(ex as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { competitors: [], error: `firecrawl ${res.status}: ${text.slice(0, 200)}` };
  }
  const body = (await res.json().catch(() => ({}))) as FirecrawlExtractResponse;
  const raw = body?.data?.json?.competitors ?? [];
  const cleaned: Array<{ name: string; instagram_handle: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const rawHandle = typeof item.instagram_handle === "string" ? item.instagram_handle.trim() : "";
    if (!name || !rawHandle) continue;
    cleaned.push({ name, instagram_handle: rawHandle });
  }
  return { competitors: cleaned };
}

function normaliseCompetitors(
  raw: Array<{ name: string; instagram_handle: string }>,
): Array<{ name: string; handle: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; handle: string; url: string }> = [];
  for (const item of raw) {
    const handle = item.instagram_handle.replace(/^@/, "").toLowerCase();
    if (!handle || !/^[a-z0-9._]+$/.test(handle)) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    const name = item.name.trim() || handle.split(/[._]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
    out.push({
      name,
      handle,
      url: `https://www.instagram.com/${handle}/`,
    });
    if (out.length >= 8) break;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!FIRECRAWL_API_KEY) {
    return res.status(500).json({
      error:
        "FIRECRAWL_API_KEY not configured. Add it under Vercel Project Settings → Environment Variables.",
    });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
    return res.status(500).json({
      error:
        "Supabase env not fully configured. Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY in Vercel.",
    });
  }

  let body: { accountId?: string; websiteUrl?: string };
  if (typeof req.body === "string") {
    try {
      body = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  } else {
    body = (req.body ?? {}) as typeof body;
  }
  if (!body?.accountId) {
    return res.status(400).json({ error: "accountId is required" });
  }

  const authHeader =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["Authorization"] as string | undefined) ??
    "";
  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  // Verify caller. The JWT-scoped client also enforces RLS on brand_kits
  // reads — so if the caller can't read this brand's kit, this request
  // shouldn't be able to populate competitors for it.
  const userClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { data: kit, error: kitErr } = await userClient
    .from("brand_kits")
    .select("account_id, website_url, name:account_id")
    .eq("account_id", body.accountId)
    .maybeSingle();
  if (kitErr) {
    return res.status(403).json({ error: `Cannot read brand_kit: ${kitErr.message}` });
  }
  if (!kit) {
    return res.status(404).json({ error: "Brand kit not found or not accessible" });
  }

  // Resolve which URL to scrape: caller-provided websiteUrl wins (lets
  // the agency override if the kit's stored URL is wrong), else the
  // kit's stored URL.
  const url =
    (body.websiteUrl && typeof body.websiteUrl === "string" && body.websiteUrl.trim()) ||
    (typeof (kit as { website_url?: string }).website_url === "string" ? (kit as { website_url?: string }).website_url : "");
  if (!url) {
    return res.status(400).json({
      error:
        "No website URL on file for this brand. Set the website on Brand Intelligence first, then try Fetch Brand again.",
    });
  }

  const { competitors: rawCompetitors, error: fcErr } = await firecrawlExtractCompetitors(url);
  if (fcErr) {
    return res.status(502).json({ error: fcErr });
  }
  const cleaned = normaliseCompetitors(rawCompetitors);

  if (cleaned.length === 0) {
    return res.status(200).json({
      ok: true,
      accountId: body.accountId,
      written: 0,
      competitors: [],
      note: "Firecrawl couldn't find any competitor candidates with valid Instagram handles. The brand's website may not reference any, or the LLM was conservative. Add competitors manually in Brand Intelligence → Competitors.",
    });
  }

  // Service-role write — bypasses RLS so we can write to brand_kits even
  // when the user is brand-owner-only (RLS allows the agency to write
  // any kit, but the JWT-scoped client may not have that grant for
  // every shape of caller).
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: writeErr } = await serviceClient
    .from("brand_kits")
    .update({ competitors: cleaned })
    .eq("account_id", body.accountId);
  if (writeErr) {
    return res.status(500).json({ error: `write: ${writeErr.message}` });
  }

  return res.status(200).json({
    ok: true,
    accountId: body.accountId,
    written: cleaned.length,
    competitors: cleaned,
  });
}
