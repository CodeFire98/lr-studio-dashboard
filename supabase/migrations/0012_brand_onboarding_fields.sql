-- =====================================================================
-- L+R Studio — Phase 12 migration:
--   Add brand-onboarding fields to brand_kits and a completion marker
--   so the welcome modal only fires once per brand.
--
--   - website_url: brand's primary site URL
--   - social_links: jsonb { instagram, tiktok, linkedin, ... }
--   - onboarding_completed_at: set when the owner finishes (or skips)
--     the onboarding modal. NULL means the modal should be offered.
--
-- Backfill: any brand that already has substantive content (tagline /
-- audience / voice tags) is treated as already onboarded so the modal
-- doesn't ambush existing users like the Luma seed brand.
-- =====================================================================

alter table public.brand_kits
  add column if not exists website_url text,
  add column if not exists social_links jsonb not null default '{}'::jsonb,
  add column if not exists onboarding_completed_at timestamptz;

update public.brand_kits
set onboarding_completed_at = now()
where onboarding_completed_at is null
  and (
    tagline is not null
    or audience is not null
    or jsonb_array_length(coalesce(voice_tags, '[]'::jsonb)) > 0
  );
