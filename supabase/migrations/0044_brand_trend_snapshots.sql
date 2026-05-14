-- =====================================================================
-- L+R Studio — Brand trend snapshots
-- =====================================================================
-- Daily-refreshed cache of "what's trending right now" for each brand.
-- Powers the AI Co-pilot's proactive trend awareness:
--
--   - A daily Vercel cron at /api/trends/refresh-cron fires per
--     allowlisted brand. For each brand it hits Firecrawl /search with
--     2-3 queries derived from brand_kits.industry + brand_kits.trend_hashtags,
--     dedupes the results, and INSERTs one row per (account_id, query,
--     source_url) into this table.
--
--   - brand_context.js's loader pulls the LATEST snapshot rows per brand
--     and compiles a `## Industry signals (last 24h)` block into the
--     system prompt for /api/ai/chat. The model leads with these when
--     the admin opens chat — no per-call Firecrawl spend.
--
--   - The chat's `web_search` tool (PR 3 same file as this migration ships
--     with) is the on-demand counterpart — model calls it for drill-downs
--     beyond the cached snapshot.
--
-- Append-only. Old snapshots stay (eventually we'll prune > 30 days but
-- one brand × 5 results/day = ~150 rows/month per brand, negligible).
-- The brand-context loader queries `latest per (account_id, query)`.
--
-- RLS mirrors post_engagement_snapshots: agency staff + brand members
-- can SELECT; INSERTs are service-role only (the cron handler uses
-- SUPABASE_SERVICE_ROLE_KEY).

-- =====================================================================
-- 1. TABLE
-- =====================================================================

create table public.brand_trend_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  fetched_at          timestamptz not null default now(),

  -- Which query produced this result row. Multiple queries per brand
  -- per day (industry-trends + hashtag-pulse + competitor-news), so a
  -- single brand has multiple rows in any given day's batch.
  query               text not null,

  -- The result content. `title`, `summary`, and `source_url` are what
  -- gets surfaced into the brand context. `raw_payload` keeps the full
  -- Firecrawl response for forensics / future re-extraction.
  source_url          text,
  title               text,
  summary             text,
  published_at        timestamptz,        -- when the article was published, if Firecrawl returned it

  raw_payload         jsonb,

  -- Provenance / debugging
  source              text not null default 'firecrawl' check (source in ('firecrawl')),
  scrape_status       text not null check (scrape_status in ('ok','partial','failed','blocked')),
  error_message       text,

  created_at          timestamptz not null default now()
);

-- Hot read: "latest snapshots for this brand". The loader filters by
-- account_id and orders by fetched_at desc, takes top N.
create index brand_trend_snapshots_account_fetched_idx
  on public.brand_trend_snapshots(account_id, fetched_at desc);

-- Skip-duplicate index: avoid re-inserting the same URL within a 24h
-- window. Cron handler checks before INSERT (or could use
-- ON CONFLICT). Partial index keeps it small.
create index brand_trend_snapshots_account_url_idx
  on public.brand_trend_snapshots(account_id, source_url)
  where source_url is not null;

-- =====================================================================
-- 2. ROW-LEVEL SECURITY
-- =====================================================================

alter table public.brand_trend_snapshots enable row level security;

-- Agency staff see everything. Brand members see their own brand's
-- snapshots (mirrors brand_kits / brand_kit_notes access for the
-- inevitable brand-side surface).
create policy brand_trend_snapshots_select on public.brand_trend_snapshots
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

-- No INSERT/UPDATE/DELETE policies — service role only via the cron
-- route. Same pattern as post_engagement_snapshots.

-- Add to realtime so future UI surfaces (a "what's trending" widget on
-- the agency dashboard, maybe) get live updates when the cron lands new
-- rows.
alter publication supabase_realtime add table public.brand_trend_snapshots;
