# enrich-brand-kit

Firecrawl-powered brand kit autofill. Scrapes a brand's website (visual
tokens via the `branding` format + editorial signals via the `extract`
format) and persists the result onto `brand_kits` plus an audit row in
`brand_kit_enrichments`.

## Phase 1 setup (one-time)

### 1. Provision the Firecrawl API key

1. Create an account at <https://www.firecrawl.dev>. Free tier (500
   credits) is enough for development — abcoffee enrichment burns ~10
   credits.
2. Copy the key from <https://www.firecrawl.dev/app/api-keys> (format:
   `fc-...`).

**Where the key lives** — two places, do both:

```bash
# (a) Local dev — used by the Firecrawl CLI when you run scrape commands
#     interactively from your terminal:
firecrawl auth --api-key fc-YOUR_KEY

# (b) Production — used by the deployed edge function:
supabase secrets set FIRECRAWL_API_KEY=fc-YOUR_KEY
```

The CLI `auth` command writes the key to `~/.config/firecrawl/config.toml`
on macOS — never commit it.

### 2. Install the Firecrawl CLI + agent skill (dev convenience)

```bash
npm run firecrawl:init
# = npx -y firecrawl-cli@latest init --all --browser
```

This installs the CLI globally and registers the Firecrawl skill so Claude
Code (and other agent runners) can drive scrape/extract/browser actions
from the editor. Production code calls Firecrawl over HTTPS directly from
the edge function — the CLI is only for development workflows.

### 3. Apply the migration

The new fields and audit table live in
[`migrations/0017_brand_kit_enrichment.sql`](../../migrations/0017_brand_kit_enrichment.sql).

```bash
# Link this checkout to the hosted project (only the first time):
supabase login
supabase link --project-ref vmfwnfflhvskadkfnvds

# Push the migration:
supabase db push
```

### 4. Deploy the function

```bash
supabase functions deploy enrich-brand-kit
```

The function reads `FIRECRAWL_API_KEY` from secrets (set above). Supabase
auto-injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` at runtime — no extra config needed.

## Triggering enrichment for abcoffee

```bash
# From repo root:
SUPABASE_URL=https://vmfwnfflhvskadkfnvds.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ...  \
WEBSITE_URL=https://abcoffee.example.com \
npm run enrich:abcoffee
```

The script:

1. Looks up the auth user with email `lakshithd98@gmail.com`.
2. Finds the brand account named (case-insensitive) "abcoffee" they
   belong to.
3. Calls the deployed `enrich-brand-kit` function with
   `{ brand_id, website_url }`.
4. Re-reads the `brand_kits` row + latest `brand_kit_enrichments` row and
   prints a populated/empty marker for every field we expect to fill.

`SUPABASE_SERVICE_ROLE_KEY` is the `service_role` key from
**Project Settings → API → Project API keys**. Treat it like a password.

`WEBSITE_URL` is optional — if omitted the function uses whatever's
currently stored on `brand_kits.website_url`. Pass it explicitly the
first time so we know the scrape target.

## Request shape (for direct curl / dashboard use)

```json
POST /functions/v1/enrich-brand-kit
Authorization: Bearer <user JWT or service-role key>
{
  "brand_id":      "<uuid of brand_kit OR account>",
  "account_slug":  "abcoffee",   // alternative
  "account_name":  "abcoffee",   // alternative (ilike match)
  "website_url":   "https://..." // optional override
}
```

Response on success:

```json
{
  "ok": true,
  "run_id": "...",
  "brand_kit_id": "...",
  "account_id": "...",
  "source_url": "https://abcoffee.example.com",
  "populated_fields": ["primary_color", "tagline", "mission", ...]
}
```

## Fields populated

Already on `brand_kits` and now Firecrawl-driven:
`primary_color`, `secondary_color`, `logo_url`, `palette`, `fonts`,
`tagline`, `mission`, `audience`, `tone_voice`, `voice_tags`,
`dos`, `donts`, `social_links` (merged, never overwritten).

**New fields added in migration 0017** (visible in `brand_kits` and the
raw `enrichment` JSONB blob):

- Visual: `accent_color`, `background_color`, `text_primary_color`,
  `text_secondary_color`, `color_scheme`, `favicon_url`, `og_image_url`,
  `semantic_colors`, `type_scale`, `spacing_tokens`, `ui_components`
- Editorial: `positioning_statement`, `industry`, `personality`,
  `value_props`, `brand_pillars`, `key_differentiators`,
  `product_categories`
- Meta: `enrichment` (raw Firecrawl response), `enrichment_url`,
  `enriched_at`, `enrichment_status`, `enrichment_error`

Phase 2 will surface these in the BrandKitView and the onboarding modal.
