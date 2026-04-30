-- =====================================================================
-- L+R Studio — post_plan_status_log
-- =====================================================================
-- Records every status transition on a post_plan so the Activity tab
-- can show "Brand approved", "Agency requested changes", etc. — not just
-- the approved/posted milestones we already stamp on the plan row.
--
-- Populated by an AFTER UPDATE trigger that fires whenever status
-- changes. Actor is taken from auth.uid() at the time of the write.

create table public.post_plan_status_log (
  id            uuid primary key default gen_random_uuid(),
  post_plan_id  uuid not null references public.post_plans(id) on delete cascade,
  from_status   text,
  to_status     text not null,
  actor_id      uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index post_plan_status_log_post_idx
  on public.post_plan_status_log(post_plan_id, created_at);

alter table public.post_plan_status_log enable row level security;

-- Read: anyone who can see the post plan can see its log.
create policy psl_select on public.post_plan_status_log
  for select to authenticated
  using (post_plan_id in (select id from public.post_plans));

-- Insert: in practice the trigger (security definer) inserts these on
-- behalf of the user; client-side inserts are also allowed if the actor
-- matches auth.uid() or is null.
create policy psl_insert on public.post_plan_status_log
  for insert to authenticated
  with check (actor_id = auth.uid() or actor_id is null);

-- Trigger function: auto-log every status change.
create or replace function public.log_post_plan_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into public.post_plan_status_log(post_plan_id, from_status, to_status, actor_id)
    values (new.id, old.status, new.status, auth.uid());
  end if;
  return new;
end;
$$;

create trigger post_plans_status_log
  after update on public.post_plans
  for each row execute function public.log_post_plan_status_change();

alter publication supabase_realtime add table public.post_plan_status_log;
