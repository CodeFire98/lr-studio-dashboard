-- =====================================================================
-- L+R Studio — post engagement snapshots + embed cache
-- =====================================================================
-- Companion data for `post_plan_publications`: live engagement metrics
-- (likes, comments, shares, etc.) and a cached snapshot of the post's
-- visible content (image, caption, author) for embedding in the dashboard.
--
-- Two tables instead of one:
--
--   `post_engagement_snapshots` — append-only. One row per scrape. Lets
--   us compute deltas over time without losing history (powers monthly
--   reports). Refresh cadence is tiered: every 6h for new posts, weekly
--   for old ones — see /api/engagement/refresh-cron.
--
--   `post_embed_cache` — 1:1 with publications. Overwritten on each
--   refresh. Holds the visible content (caption, hero image URL,
--   author handle) plus optional X oEmbed HTML. Separate from snapshots
--   because the visible content rarely changes after first scrape
--   while counts change every refresh — combining them would store the
--   same caption N times.
--
-- Scraped via Apify actors from a Vercel route (`/api/engagement/refresh`).
-- Inserts/updates happen exclusively via service-role; no client
-- INSERT/UPDATE/DELETE policies are defined. Brands and agency can SELECT
-- (same access model as the parent publication).

-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table public.post_engagement_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  publication_id      uuid not null references public.post_plan_publications(id) on delete cascade,
  fetched_at          timestamptz not null default now(),

  -- Cross-platform metrics. Each is nullable because the same metric
  -- isn't exposed consistently across IG / X / LinkedIn. The
  -- `availability_notes` column documents the per-row reason a field
  -- is null so the UI can show "not exposed by this platform" instead
  -- of treating null as "we don't know yet".
  like_count          integer,
  comment_count       integer,
  share_count         integer,  -- IG: not exposed. X: reposts. LinkedIn: shares.
  save_count          integer,  -- IG saves
  view_count          integer,  -- video views / impressions
  bookmark_count      integer,  -- X only
  quote_count         integer,  -- X only
  reaction_count      integer,  -- LinkedIn total reactions
  engagement_rate     numeric,  -- derived: (likes+comments+shares)/views, when views known

  availability_notes  text,

  -- The full Apify response — schema drift insurance. When an actor
  -- changes its output shape or we want to extract a new metric from
  -- a row we already scraped, the original payload is here.
  raw_payload         jsonb,

  -- Provenance — which actor produced this row, and which run.
  actor_id            text not null,
  actor_run_id        text,

  scrape_status       text not null check (scrape_status in ('ok','partial','failed','blocked')),
  error_message       text,

  created_at          timestamptz not null default now()
);

-- Hot read path: "latest snapshot for this publication" + "snapshots in
-- date range for monthly reports". Both want (publication_id, fetched_at desc).
create index post_engagement_snapshots_pub_fetched_idx
  on public.post_engagement_snapshots(publication_id, fetched_at desc);

-- Cron's scan: "rows that were scraped before time X" so we know who's
-- due for a refresh. Standalone index on fetched_at.
create index post_engagement_snapshots_fetched_idx
  on public.post_engagement_snapshots(fetched_at desc);


create table public.post_embed_cache (
  publication_id        uuid primary key references public.post_plan_publications(id) on delete cascade,

  -- Author surfacing — what we render in the tile header.
  author_handle         text,
  author_display_name   text,
  author_avatar_url     text,

  caption               text,

  -- Visual content for the custom embed card.
  media_type            text check (media_type in ('image','video','carousel','text','unknown')),
  media_url             text,      -- hero image / video poster
  media_urls            jsonb,     -- carousel slides — array of URLs
  media_aspect_ratio    numeric,   -- width / height, for layout reservation

  -- Actual platform post timestamp (distinct from our marked-posted timestamp).
  posted_at             timestamptz,

  -- X-only. Official oEmbed HTML. Stored once, rendered as-is for
  -- platforms with public oEmbed. v1 ships static cards across the
  -- board (see decision log) so this is here for the eventual upgrade.
  oembed_html           text,

  last_refreshed_at     timestamptz not null default now(),
  refresh_status        text not null check (refresh_status in ('ok','failed','stale')),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);


-- =====================================================================
-- 2. ROW-LEVEL SECURITY
-- =====================================================================
--
-- Read access mirrors post_plan_publications: anyone with access to the
-- parent plan's account (members) OR any agency user can SELECT.
--
-- Crucially, NO INSERT/UPDATE/DELETE policies for authenticated. That
-- means every write must come through the service-role key, which only
-- the Vercel API routes hold. Brands and brand-side users cannot
-- trigger an Apify scrape (saves spend, prevents abuse). Once we're
-- confident in v1, a future migration can grant brand-side users a
-- rate-limited "refresh now" affordance.

alter table public.post_engagement_snapshots enable row level security;
alter table public.post_embed_cache enable row level security;

create policy post_engagement_snapshots_select on public.post_engagement_snapshots
  for select to authenticated
  using (
    public.is_agency_user()
    or exists (
      select 1
      from public.post_plan_publications pp
      join public.post_plans p on p.id = pp.post_plan_id
      where pp.id = post_engagement_snapshots.publication_id
        and p.account_id in (select public.accessible_account_ids())
    )
  );

create policy post_embed_cache_select on public.post_embed_cache
  for select to authenticated
  using (
    public.is_agency_user()
    or exists (
      select 1
      from public.post_plan_publications pp
      join public.post_plans p on p.id = pp.post_plan_id
      where pp.id = post_embed_cache.publication_id
        and p.account_id in (select public.accessible_account_ids())
    )
  );

-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

create trigger post_embed_cache_touch_updated_at
  before update on public.post_embed_cache
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 4. REALTIME
-- =====================================================================
--
-- LivePostsView subscribes to both so a fresh snapshot or updated embed
-- triggers a tile re-render without a manual refresh.

alter publication supabase_realtime add table public.post_engagement_snapshots;
alter publication supabase_realtime add table public.post_embed_cache;
