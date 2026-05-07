-- =====================================================================
-- L+R Studio — post_plan_publications
-- =====================================================================
-- "Posted" is a terminal outcome, not a workflow state. Migration 0035
-- collapsed post_plans.status to a clean 3-value workflow enum
-- (drafting / needs_review / approved) on purpose. Re-adding `posted`
-- to that enum would re-mix two axes (workflow vs. shipped-yet) and
-- undo the simplification.
--
-- Instead: a publication is its own row. Each row says
-- "this plan was posted on this platform, here's the live URL,
-- here's who marked it, here's when". One row per (plan, platform);
-- editing the URL after the fact updates the existing row.
--
-- The "Posted" pill in the UI is derived: a plan is shown as Posted
-- when status='approved' and it has at least one publications row.
-- The status enum stays at 3 values; no STATUS_CONFIG migration needed.
--
-- A separate table (over columns on post_plans) is the right shape
-- because a plan targets multiple platforms with different URLs and
-- different publish times. A jsonb-on-post_plans alternative was
-- considered and rejected — losing FK constraints, RLS granularity
-- on `published_by`, and clean realtime updates wasn't worth saving
-- one join.

-- =====================================================================
-- 1. TABLE
-- =====================================================================

create table public.post_plan_publications (
  id             uuid primary key default gen_random_uuid(),
  post_plan_id   uuid not null references public.post_plans(id) on delete cascade,
  -- Match the values used in post_plans.platforms[]. UI ensures the
  -- platform here is one the parent plan actually targets, but we
  -- don't enforce that cross-row check at the DB level — it's a UX
  -- concern, not a data-integrity one (republishing on a 4th platform
  -- later shouldn't be blocked by a constraint).
  platform       text not null check (platform in ('instagram', 'linkedin', 'x')),
  -- Optional. The user can mark posted without pasting a URL — the
  -- existence of the row is the "marked posted" signal; the URL is
  -- decoration that powers the live-posts repository view.
  live_url       text,
  published_at   timestamptz not null default now(),
  published_by   uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One publication row per (plan, platform). Republishing edits the
  -- URL on the existing row instead of stacking a second row.
  unique (post_plan_id, platform)
);

create index post_plan_publications_plan_idx
  on public.post_plan_publications(post_plan_id);

-- For the "Live posts" repository view per brand. Joining to
-- post_plans by plan_id is fine, but we hit publications by recency
-- so an index on published_at helps the brand-wide list query.
create index post_plan_publications_published_idx
  on public.post_plan_publications(published_at desc);

-- =====================================================================
-- 2. ROW-LEVEL SECURITY
-- =====================================================================
--
-- Mirror post_plan_attachments: anyone with read access to the parent
-- plan can read; anyone with edit access on the plan can insert/update;
-- own rows or agency can delete.
--
-- Note: this is intentionally NOT brand-only. The agency often does the
-- physical posting (Buffer / Later / scheduled tools), so gating to
-- brand-only would force a friction step. `published_by` records who
-- actually marked it for the activity feed.

alter table public.post_plan_publications enable row level security;

create policy post_plan_publications_select on public.post_plan_publications
  for select to authenticated
  using (post_plan_id in (select id from public.post_plans));

create policy post_plan_publications_insert on public.post_plan_publications
  for insert to authenticated
  with check (
    published_by = auth.uid()
    and post_plan_id in (select id from public.post_plans)
  );

create policy post_plan_publications_update on public.post_plan_publications
  for update to authenticated
  using (post_plan_id in (select id from public.post_plans))
  with check (post_plan_id in (select id from public.post_plans));

create policy post_plan_publications_delete on public.post_plan_publications
  for delete to authenticated
  using (
    published_by = auth.uid()
    or public.is_agency_user()
  );

-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

create trigger post_plan_publications_touch_updated_at
  before update on public.post_plan_publications
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 4. REALTIME
-- =====================================================================

alter publication supabase_realtime add table public.post_plan_publications;
