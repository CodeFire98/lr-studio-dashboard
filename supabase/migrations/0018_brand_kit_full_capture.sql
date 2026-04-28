-- =====================================================================
-- L+R Studio — Phase 18 migration:
--   Capture every signal Firecrawl returns. The first enrichment build
--   (migration 0017) extracted the headline visual + editorial fields
--   but dropped the entire `data.metadata` block plus several useful
--   sub-objects under `branding` (confidence scores, design system
--   detection, LLM reasoning, full CSS font stacks).
--
--   This migration adds those columns so a single enrichment run gives
--   us everything Firecrawl can offer, without re-scraping just to
--   surface a missing field.
--
--   All new fields default to null/empty so existing rows are unaffected.
-- =====================================================================

alter table public.brand_kits
  -- Page metadata block (data.metadata) — was entirely dropped before.
  add column if not exists meta_title              text,
  add column if not exists meta_description        text,
  add column if not exists og_title                text,
  add column if not exists og_description          text,
  add column if not exists twitter_card            jsonb not null default '{}'::jsonb,
  add column if not exists language                text,
  -- Branding subfields we weren't promoting.
  add column if not exists font_stacks             jsonb not null default '{}'::jsonb,
  add column if not exists confidence_scores       jsonb not null default '{}'::jsonb,
  add column if not exists design_system           jsonb not null default '{}'::jsonb,
  add column if not exists llm_reasoning           jsonb not null default '{}'::jsonb,
  -- Enrichment telemetry / support breadcrumbs.
  add column if not exists enrichment_credits_used integer,
  add column if not exists enrichment_scrape_id    text;
