-- =====================================================================
-- L+R Studio — brand-level trend hashtags (Trends Radar Phase 3)
-- =====================================================================
-- Each brand declares a small list of hashtags relevant to its category
-- (e.g. for a coffee brand: ["specialtycoffee", "coffeeshop", "latteart"]).
-- The Vercel route /api/fetch-trends?source=instagram reads this column
-- per brand, calls Apify's Instagram Hashtag Scraper for each hashtag,
-- and writes the resulting top posts back into public.trend_signals
-- with account_id set so only that brand's members + agency can see them
-- (RLS already enforces this — see migration 0029).
--
-- Why on brand_kits and not a separate table:
--   The list is small (3–5 entries), per-brand, and edited as a single
--   atomic blob. A separate table would be over-engineering. text[]
--   keeps it next to every other brand-defining attribute (palette,
--   voice tags, etc.) where it belongs conceptually.
-- =====================================================================

alter table public.brand_kits
  add column if not exists trend_hashtags text[] not null default '{}';

-- Existing RLS on brand_kits already covers reads + writes for this
-- column — agency staff can edit any brand's kit, brand members can
-- edit their own. No policy changes needed.

comment on column public.brand_kits.trend_hashtags is
  'List of hashtags (without #) the brand wants tracked on Instagram. Read by /api/fetch-trends source=instagram to scope the scrape. Edit via BrandKitView. Lowercase, no leading # — normalised on insert.';
