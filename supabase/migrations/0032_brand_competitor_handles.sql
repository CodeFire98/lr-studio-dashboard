-- =====================================================================
-- L+R Studio — brand competitor IG handles (Trends Radar v2 IG flow)
-- =====================================================================
-- Each brand declares 5-10 competitor / aspiration Instagram accounts.
-- /api/fetch-trends?source=instagram&mode=competitors reads these and
-- scrapes recent posts via apify/instagram-profile-scraper (which is
-- much higher signal than the old hashtag-discovery flow that surfaced
-- random posts).
--
-- The previously-added trend_hashtags column (migration 0030) is left
-- in place — it's harmless and may still be reused later. This is a
-- separate concern: hashtags are about category/topic discovery,
-- handles are about specific account watching.
-- =====================================================================

alter table public.brand_kits
  add column if not exists competitor_handles text[] not null default '{}';

comment on column public.brand_kits.competitor_handles is
  'List of Instagram @handles (without @) to surface as the brand''s competitor / aspiration set. Read by /api/fetch-trends source=instagram mode=competitors. Edit via BrandKitView. Lowercase, no leading @ — normalised on insert. Cap 12 to bound Apify cost.';
