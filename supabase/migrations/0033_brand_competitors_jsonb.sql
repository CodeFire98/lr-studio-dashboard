-- =====================================================================
-- L+R Studio — competitors jsonb on brand_kits
-- =====================================================================
-- Replaces the simpler `competitor_handles text[]` from migration 0032
-- with a richer structure: each entry is {name, handle, url}. Names are
-- shown in the BrandKit UI (more human than @handles); handles drive
-- the IG fetch in /api/fetch-trends?source=instagram&mode=competitors;
-- url is for direct linking.
--
-- Auto-populated by enrich-brand-kit when the agency hits "Fetch brand"
-- (Firecrawl identifies 3-5 competitors from the brand's website +
-- category context). Manually editable in BrandKit afterwards.
--
-- Shape:
--   [
--     {"name": "Glossier",       "handle": "glossier",       "url": "https://www.instagram.com/glossier/"},
--     {"name": "Drunk Elephant", "handle": "drunkelephant",  "url": "https://www.instagram.com/drunkelephant/"}
--   ]
--
-- The `competitor_handles text[]` column from migration 0032 is left
-- in place for one cycle to allow no-downtime deploys; a follow-up
-- migration can drop it once the new code is bedded in.
-- =====================================================================

alter table public.brand_kits
  add column if not exists competitors jsonb not null default '[]'::jsonb;

comment on column public.brand_kits.competitors is
  'List of competitor / aspiration brands. Each entry: {name, handle, url}. handle is the IG username (no @, lowercase). url is the IG profile URL. Auto-populated by enrich-brand-kit (Fetch Brand action) and manually editable in BrandKitView. Read by /api/fetch-trends source=instagram mode=competitors which extracts handles for the Apify call.';
