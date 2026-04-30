-- =====================================================================
-- L+R Studio — Social Calendar (post_plans)
-- =====================================================================
-- Adds the post_plans entity that powers the new Social Calendar landing
-- page. A post_plan is a single content concept that may target multiple
-- platforms (IG / LinkedIn / X) with per-platform copy variants. The
-- agency drafts plans; the brand reviews and approves them via the
-- two-way "needs feedback" status split.
--
-- Companion tables:
--   post_plan_comments     — threaded back-and-forth on a plan
--   post_plan_attachments  — references + final assets (versioned)

-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table public.post_plans (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts(id) on delete cascade,
  scheduled_at    timestamptz not null,
  -- Multi-platform targeting. Values: 'instagram', 'linkedin', 'x'.
  platforms       text[] not null default '{}',
  concept         text not null default '',
  -- Per-platform copy keyed by platform slug, e.g.
  --   { "instagram": "...", "linkedin": "...", "x": "..." }
  copy_variants   jsonb not null default '{}'::jsonb,
  status          text not null default 'not_started'
                  check (status in (
                    'not_started', 'wip',
                    'needs_brand_feedback', 'needs_admin_revision',
                    'approved', 'scheduled', 'posted', 'delayed'
                  )),
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  approved_at     timestamptz,
  posted_at       timestamptz
);

create index post_plans_account_idx     on public.post_plans(account_id);
create index post_plans_scheduled_idx   on public.post_plans(scheduled_at);
create index post_plans_status_idx      on public.post_plans(status);

create table public.post_plan_comments (
  id            uuid primary key default gen_random_uuid(),
  post_plan_id  uuid not null references public.post_plans(id) on delete cascade,
  author_id     uuid not null references public.profiles(id) on delete cascade,
  body          text not null,
  created_at    timestamptz not null default now()
);

create index post_plan_comments_post_idx
  on public.post_plan_comments(post_plan_id, created_at);

create table public.post_plan_attachments (
  id            uuid primary key default gen_random_uuid(),
  post_plan_id  uuid not null references public.post_plans(id) on delete cascade,
  kind          text not null check (kind in ('reference', 'final')),
  version       int  not null default 1,
  storage_path  text not null,
  filename      text not null,
  mime_type     text,
  size_bytes    bigint,
  uploaded_by   uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create index post_plan_attachments_post_idx
  on public.post_plan_attachments(post_plan_id);

-- =====================================================================
-- 2. ROW-LEVEL SECURITY
-- =====================================================================

alter table public.post_plans            enable row level security;
alter table public.post_plan_comments    enable row level security;
alter table public.post_plan_attachments enable row level security;

-- ---- post_plans ------------------------------------------------------

create policy post_plans_select on public.post_plans
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy post_plans_insert on public.post_plans
  for insert to authenticated
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy post_plans_update on public.post_plans
  for update to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  )
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy post_plans_delete on public.post_plans
  for delete to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

-- ---- post_plan_comments ---------------------------------------------

create policy post_plan_comments_select on public.post_plan_comments
  for select to authenticated
  using (post_plan_id in (select id from public.post_plans));   -- post_plans RLS filters

create policy post_plan_comments_insert on public.post_plan_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and post_plan_id in (select id from public.post_plans)
  );

create policy post_plan_comments_update_own on public.post_plan_comments
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy post_plan_comments_delete_own_or_agency on public.post_plan_comments
  for delete to authenticated
  using (author_id = auth.uid() or public.is_agency_user());

-- ---- post_plan_attachments ------------------------------------------

create policy post_plan_attachments_select on public.post_plan_attachments
  for select to authenticated
  using (post_plan_id in (select id from public.post_plans));

create policy post_plan_attachments_insert on public.post_plan_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and post_plan_id in (select id from public.post_plans)
  );

create policy post_plan_attachments_delete_own_or_agency on public.post_plan_attachments
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_agency_user());

-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

create trigger post_plans_touch_updated_at
  before update on public.post_plans
  for each row execute function public.touch_updated_at();

-- Auto-stamp approved_at and posted_at when status moves into those states.
-- Idempotent: doesn't overwrite a non-null timestamp on subsequent re-flips.
create or replace function public.touch_post_plan_status_stamps()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'UPDATE') then
    if new.status = 'approved'
       and old.status is distinct from 'approved'
       and new.approved_at is null then
      new.approved_at := now();
    end if;
    if new.status = 'posted'
       and old.status is distinct from 'posted'
       and new.posted_at is null then
      new.posted_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger post_plans_status_stamps
  before update on public.post_plans
  for each row execute function public.touch_post_plan_status_stamps();

-- =====================================================================
-- 4. REALTIME
-- =====================================================================

alter publication supabase_realtime add table public.post_plans;
alter publication supabase_realtime add table public.post_plan_comments;
alter publication supabase_realtime add table public.post_plan_attachments;
