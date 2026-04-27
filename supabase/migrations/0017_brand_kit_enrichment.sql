-- =====================================================================
-- L+R Studio — Phase 17 migration:
--   Brand kit enrichment scaffolding (Firecrawl-powered autofill).
--
--   1. Extend brand_kits with the additional fields Firecrawl can give us
--      (semantic palette, full type scale, design tokens, components,
--      positioning, industry, personality, etc.) plus an `enrichment`
--      JSONB column that holds the most recent raw Firecrawl response so
--      we can re-derive any field without re-scraping.
--
--   2. Add brand_kit_enrichments — append-only audit log, one row per
--      scrape attempt, so we can debug, replay, and (later) diff
--      enrichments over time when we add the brand-drift watcher.
--
-- All new fields default to empty/null so existing rows are unaffected.
-- =====================================================================

-- ---- 1. Extend brand_kits --------------------------------------------

alter table public.brand_kits
  -- Raw Firecrawl response cache (single source of truth for re-derivation)
  add column if not exists enrichment           jsonb        not null default '{}'::jsonb,
  add column if not exists enrichment_url       text,
  add column if not exists enriched_at          timestamptz,
  add column if not exists enrichment_status    text         not null default 'never',
  add column if not exists enrichment_error     text,
  -- Visual tokens (promoted from Firecrawl branding format)
  add column if not exists accent_color         text,
  add column if not exists background_color     text,
  add column if not exists text_primary_color   text,
  add column if not exists text_secondary_color text,
  add column if not exists color_scheme         text,
  add column if not exists favicon_url          text,
  add column if not exists og_image_url         text,
  add column if not exists semantic_colors      jsonb        not null default '{}'::jsonb,
  add column if not exists type_scale           jsonb        not null default '{}'::jsonb,
  add column if not exists spacing_tokens       jsonb        not null default '{}'::jsonb,
  add column if not exists ui_components        jsonb        not null default '{}'::jsonb,
  -- Editorial / strategic (from Firecrawl extract format)
  add column if not exists positioning_statement text,
  add column if not exists industry             text,
  add column if not exists personality          jsonb        not null default '{}'::jsonb,
  add column if not exists value_props          jsonb        not null default '[]'::jsonb,
  add column if not exists brand_pillars        jsonb        not null default '[]'::jsonb,
  add column if not exists key_differentiators  jsonb        not null default '[]'::jsonb,
  add column if not exists product_categories   jsonb        not null default '[]'::jsonb;

alter table public.brand_kits
  drop constraint if exists brand_kits_enrichment_status_check;
alter table public.brand_kits
  add constraint brand_kits_enrichment_status_check
  check (enrichment_status in ('never','pending','success','partial','failed'));

-- ---- 2. Audit table: brand_kit_enrichments ---------------------------

create table if not exists public.brand_kit_enrichments (
  id              uuid primary key default gen_random_uuid(),
  brand_kit_id    uuid not null references public.brand_kits(id) on delete cascade,
  account_id      uuid not null references public.accounts(id)   on delete cascade,
  source_url      text not null,
  formats         text[] not null default array['branding','extract','markdown'],
  status          text not null default 'pending',
  raw_response    jsonb,
  error_message   text,
  credits_used    integer,
  triggered_by    uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint brand_kit_enrichments_status_check
    check (status in ('pending','success','partial','failed'))
);

create index if not exists brand_kit_enrichments_brand_idx
  on public.brand_kit_enrichments(brand_kit_id, created_at desc);
create index if not exists brand_kit_enrichments_account_idx
  on public.brand_kit_enrichments(account_id, created_at desc);

alter table public.brand_kit_enrichments enable row level security;

-- Read: agency users see all; brand members see their account's runs.
drop policy if exists brand_kit_enrichments_select on public.brand_kit_enrichments;
create policy brand_kit_enrichments_select on public.brand_kit_enrichments
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

-- Inserts/updates happen exclusively from the edge function via service
-- role. Authenticated users have no direct write path here; they trigger
-- enrichment by calling the edge function, not by writing rows.
