-- =====================================================================
-- L+R Studio — Post-plan ideas (brand "Got ideas?" / agency "Inbox")
-- =====================================================================
-- A post_plan_idea is a content suggestion submitted by the brand for
-- the agency to turn into a real post_plans row. The two surfaces that
-- read/write this table:
--   * Brand "Got ideas?" view  — composer + the brand's own idea list
--   * Agency "Inbox" view      — list of submitted ideas per brand,
--                                edit + "Add to Social Calendar" CTA
--
-- Once the agency converts an idea into a post_plan, idea.status flips
-- to 'converted' and idea.converted_post_plan_id points at the new row.
-- The default Inbox filter excludes converted/archived rows so they
-- naturally drop off the queue once handled.
--
-- Storage: reuses the existing `post-plan-attachments` bucket. Path
-- scheme: `<accountId>/ideas/<ideaId>/<ts>_<filename>`. The bucket's
-- storage RLS extracts accountId via split_part(name, '/', 1) (set up
-- in migration 0022), so this path layout works without policy changes.

-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table public.post_plan_ideas (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts(id) on delete cascade,
  title                    text not null default '',
  details                  text not null default '',
  -- Optional date the brand wants this posted. Date-only because the
  -- agency picks the actual time when scheduling. Stored as `date`,
  -- not `timestamptz`, so timezone shifts can't move it day-over-day.
  desired_date             date,
  -- Multi-platform targeting — same vocabulary as post_plans.platforms.
  platforms                text[] not null default '{}',
  status                   text not null default 'submitted'
                           check (status in ('submitted', 'converted', 'archived')),
  submitted_by             uuid references public.profiles(id) on delete set null,
  -- Set when the idea is converted to a post_plan via the Inbox flow.
  converted_post_plan_id   uuid references public.post_plans(id) on delete set null,
  converted_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index post_plan_ideas_account_idx on public.post_plan_ideas(account_id);
create index post_plan_ideas_status_idx  on public.post_plan_ideas(status);

create table public.post_plan_idea_attachments (
  id            uuid primary key default gen_random_uuid(),
  idea_id       uuid not null references public.post_plan_ideas(id) on delete cascade,
  storage_path  text not null,
  filename      text not null,
  mime_type     text,
  size_bytes    bigint,
  uploaded_by   uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create index post_plan_idea_attachments_idea_idx
  on public.post_plan_idea_attachments(idea_id);

-- =====================================================================
-- 2. ROW-LEVEL SECURITY
-- =====================================================================

alter table public.post_plan_ideas            enable row level security;
alter table public.post_plan_idea_attachments enable row level security;

-- ---- post_plan_ideas -------------------------------------------------
-- Same gate as post_plans: agency staff or members of the account.

create policy post_plan_ideas_select on public.post_plan_ideas
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy post_plan_ideas_insert on public.post_plan_ideas
  for insert to authenticated
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy post_plan_ideas_update on public.post_plan_ideas
  for update to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  )
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy post_plan_ideas_delete on public.post_plan_ideas
  for delete to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

-- ---- post_plan_idea_attachments -------------------------------------

create policy ppia_select on public.post_plan_idea_attachments
  for select to authenticated
  using (idea_id in (select id from public.post_plan_ideas));

create policy ppia_insert on public.post_plan_idea_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and idea_id in (select id from public.post_plan_ideas)
  );

create policy ppia_delete on public.post_plan_idea_attachments
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_agency_user());

-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

create trigger post_plan_ideas_touch_updated_at
  before update on public.post_plan_ideas
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 4. REALTIME
-- =====================================================================

alter publication supabase_realtime add table public.post_plan_ideas;
alter publication supabase_realtime add table public.post_plan_idea_attachments;
