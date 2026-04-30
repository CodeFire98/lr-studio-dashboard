-- =====================================================================
-- L+R Studio — Post-plan unread tracking + attachment storage
-- =====================================================================
-- 1. post_plan_views: per-(user, post_plan) "last seen" stamp powering
--    the unread-comment badge on the calendar + sidebar. A comment is
--    "unread" for user U if (last_seen_at IS NULL) OR
--    (comment.created_at > last_seen_at), and author_id != U.
--
-- 2. post-plan-attachments storage bucket + RLS, mirroring the
--    brand-assets convention. Path scheme:
--      <accountId>/<postPlanId>/<ts>_<filename>
--    so storage RLS can scope by accountId via split_part(name, '/', 1).

-- =====================================================================
-- 1. post_plan_views
-- =====================================================================

create table public.post_plan_views (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  post_plan_id uuid not null references public.post_plans(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, post_plan_id)
);

alter table public.post_plan_views enable row level security;

create policy ppv_select_own on public.post_plan_views
  for select to authenticated using (user_id = auth.uid());
create policy ppv_insert_own on public.post_plan_views
  for insert to authenticated with check (user_id = auth.uid());
create policy ppv_update_own on public.post_plan_views
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- 2. post-plan-attachments bucket
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('post-plan-attachments', 'post-plan-attachments', true)
on conflict (id) do nothing;

-- Helper: extract <accountId> from a path "<accountId>/<postPlanId>/..."
create or replace function public.post_plan_attachment_account_id(name text)
returns uuid language sql immutable as $$
  select nullif(split_part(name, '/', 1), '')::uuid;
$$;

-- Read: anyone with access to the account (or agency) can read.
create policy "post-plan-attachments read by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'post-plan-attachments'
    and (
      public.is_agency_user()
      or public.post_plan_attachment_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );

-- Write: same gate.
create policy "post-plan-attachments write by members" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'post-plan-attachments'
    and (
      public.is_agency_user()
      or public.post_plan_attachment_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );

-- Delete: same gate (the row-level RLS on post_plan_attachments enforces
-- the "uploader OR agency" rule, but storage doesn't know about that
-- table — match the broader account-membership rule here so neither side
-- is locked out of cleaning up their own files).
create policy "post-plan-attachments delete by members" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'post-plan-attachments'
    and (
      public.is_agency_user()
      or public.post_plan_attachment_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );
