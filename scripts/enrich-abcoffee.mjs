#!/usr/bin/env node
/**
 * Trigger Firecrawl enrichment for the "abcoffee" brand owned by
 * lakshithd98@gmail.com, then print a verification report.
 *
 * Usage:
 *   SUPABASE_URL=https://vmfwnfflhvskadkfnvds.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   WEBSITE_URL=https://abcoffee.example.com \
 *   node scripts/enrich-abcoffee.mjs
 *
 * - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: hosted project + service role
 *   key (Project Settings → API → service_role).
 * - WEBSITE_URL (optional): override the URL Firecrawl scrapes. If omitted
 *   we use whatever brand_kits.website_url has.
 *
 * The script uses the service-role client to:
 *   1. Find the auth user with email lakshithd98@gmail.com.
 *   2. Find the *brand* account they own called "abcoffee" (case-insensitive).
 *   3. Call the enrich-brand-kit edge function with that brand_id.
 *   4. Re-read the brand_kits row + latest brand_kit_enrichments row and
 *      print which fields were populated.
 *
 * The edge function does the actual Firecrawl call — this script only
 * triggers and verifies. Make sure you've already run:
 *   supabase secrets set FIRECRAWL_API_KEY=fc-...
 *   supabase functions deploy enrich-brand-kit
 *   supabase db push     # applies migration 0017
 */
import { createClient } from "@supabase/supabase-js";

const TARGET_EMAIL = "lakshithd98@gmail.com";
const TARGET_BRAND_NAME = "abcoffee";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBSITE_URL_OVERRIDE = process.env.WEBSITE_URL || null;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    "Missing env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.",
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function abbreviate(value, max = 80) {
  if (value == null) return "—";
  if (typeof value === "string") {
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  }
  if (Array.isArray(value)) return `[${value.length}] ${JSON.stringify(value).slice(0, max)}`;
  if (typeof value === "object") return JSON.stringify(value).slice(0, max);
  return String(value);
}

async function findUser() {
  // listUsers paginates; abcoffee is the only target so first page is fine.
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`auth.admin.listUsers: ${error.message}`);
  const user = data.users.find(
    (u) => (u.email || "").toLowerCase() === TARGET_EMAIL.toLowerCase(),
  );
  if (!user) throw new Error(`No auth user with email ${TARGET_EMAIL}`);
  return user;
}

async function findAbcoffeeBrand(userId) {
  const { data, error } = await sb
    .from("account_members")
    .select("account_id, role, accounts!inner(id, name, slug, type)")
    .eq("user_id", userId);
  if (error) throw new Error(`account_members lookup: ${error.message}`);

  const matches = (data || [])
    .filter((m) => m.accounts?.type === "brand")
    .filter((m) => (m.accounts?.name || "").toLowerCase().includes(TARGET_BRAND_NAME));

  if (matches.length === 0) {
    const allBrands = (data || [])
      .filter((m) => m.accounts?.type === "brand")
      .map((m) => `${m.accounts.name} (${m.accounts.id})`);
    throw new Error(
      `No brand named like "${TARGET_BRAND_NAME}" owned by ${TARGET_EMAIL}. ` +
        `Brands available: ${allBrands.join(", ") || "none"}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple matches: ${matches.map((m) => m.accounts.name).join(", ")}. Narrow the filter.`,
    );
  }
  return matches[0].accounts;
}

async function findBrandKit(accountId) {
  const { data, error } = await sb
    .from("brand_kits")
    .select("id, account_id, website_url, social_links")
    .eq("account_id", accountId)
    .single();
  if (error) throw new Error(`brand_kits lookup: ${error.message}`);
  return data;
}

async function callEnrichFunction({ brandId, websiteUrl }) {
  const url = `${SUPABASE_URL}/functions/v1/enrich-brand-kit`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Service-role bearer; the function detects role=service_role and
      // skips the per-user auth path.
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({
      brand_id: brandId,
      ...(websiteUrl ? { website_url: websiteUrl } : {}),
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function readBack(brandKitId) {
  const { data: kit, error: kitErr } = await sb
    .from("brand_kits")
    .select("*")
    .eq("id", brandKitId)
    .single();
  if (kitErr) throw new Error(`re-read brand_kits: ${kitErr.message}`);

  const { data: runs, error: runErr } = await sb
    .from("brand_kit_enrichments")
    .select("id, status, source_url, error_message, created_at, completed_at")
    .eq("brand_kit_id", brandKitId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (runErr) throw new Error(`re-read brand_kit_enrichments: ${runErr.message}`);

  return { kit, lastRun: runs?.[0] ?? null };
}

function reportPopulatedFields(kit) {
  const groups = {
    "Visual — colors": [
      "primary_color",
      "secondary_color",
      "accent_color",
      "background_color",
      "text_primary_color",
      "text_secondary_color",
      "color_scheme",
      "semantic_colors",
    ],
    "Visual — assets": ["logo_url", "favicon_url", "og_image_url"],
    "Visual — tokens": ["palette", "fonts", "type_scale", "spacing_tokens", "ui_components"],
    "Editorial": [
      "tagline",
      "mission",
      "audience",
      "tone_voice",
      "positioning_statement",
      "industry",
      "voice_tags",
      "value_props",
      "brand_pillars",
      "key_differentiators",
      "product_categories",
      "dos",
      "donts",
      "personality",
    ],
    "Onboarding": ["website_url", "social_links"],
    "Enrichment meta": [
      "enrichment_status",
      "enriched_at",
      "enrichment_url",
      "enrichment_error",
    ],
  };

  for (const [groupName, fields] of Object.entries(groups)) {
    console.log(`\n  ${groupName}`);
    for (const f of fields) {
      const v = kit[f];
      const filled =
        v !== null &&
        v !== undefined &&
        !(typeof v === "string" && v === "") &&
        !(Array.isArray(v) && v.length === 0) &&
        !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
      const marker = filled ? "✓" : "·";
      console.log(`    ${marker} ${f.padEnd(24)} ${abbreviate(v)}`);
    }
  }
}

async function main() {
  console.log(`Looking up user ${TARGET_EMAIL} ...`);
  const user = await findUser();
  console.log(`  → user_id=${user.id}`);

  console.log(`Finding "${TARGET_BRAND_NAME}" brand owned by them ...`);
  const account = await findAbcoffeeBrand(user.id);
  console.log(`  → account: ${account.name} (${account.id})`);

  const kit = await findBrandKit(account.id);
  console.log(`  → brand_kit_id=${kit.id}, current website_url=${kit.website_url ?? "(none)"}`);

  const websiteUrl = WEBSITE_URL_OVERRIDE || kit.website_url;
  if (!websiteUrl) {
    console.error(
      `\nNo website_url stored on the brand kit and WEBSITE_URL env not set. Aborting.`,
    );
    process.exit(2);
  }
  console.log(`\nCalling enrich-brand-kit for ${websiteUrl} ...`);

  const t0 = Date.now();
  const { status, body } = await callEnrichFunction({
    brandId: kit.id,
    websiteUrl: WEBSITE_URL_OVERRIDE,
  });
  const ms = Date.now() - t0;
  console.log(`  ← HTTP ${status} in ${ms}ms`);
  console.log(`  ← body: ${JSON.stringify(body).slice(0, 600)}`);

  if (status >= 400) {
    process.exit(3);
  }

  console.log(`\nVerifying — re-reading brand_kits row ...`);
  const { kit: kitAfter, lastRun } = await readBack(kit.id);
  console.log(
    `  Last enrichment run: status=${lastRun?.status ?? "?"}  source=${lastRun?.source_url ?? "?"}  error=${lastRun?.error_message ?? "—"}`,
  );

  console.log(`\nField population report:`);
  reportPopulatedFields(kitAfter);
  console.log(`\nDone.`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
