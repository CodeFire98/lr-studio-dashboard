-- =====================================================================
-- L+R Studio — Phase 14 migration:
--   Auto-assign every newly-created task to a default lead on the
--   agency account, and let agency users reassign tasks to teammates.
--
--   1. accounts.default_lead_id — per-account fallback lead (used on
--      the agency account; brand accounts can leave it null).
--   2. BEFORE-INSERT trigger on tasks: if assigned_lead_id is null,
--      copy the agency account's default_lead_id into it.
--   3. Seed: set the agency account's default lead to
--      agency@linkrunner.io's profile (if that user exists).
--
--   The existing log_task_activity() trigger already records 'assigned'
--   activity rows whenever assigned_lead_id changes on UPDATE — no
--   extra wiring needed for the activity feed.
-- =====================================================================

-- 1. Column ----------------------------------------------------------------
alter table public.accounts
  add column if not exists default_lead_id uuid references public.profiles(id) on delete set null;

-- 2. Trigger ---------------------------------------------------------------
-- Auto-fill assigned_lead_id from the agency account's default lead so brand
-- briefs land on someone the moment they're submitted. We always source from
-- the agency account, not the task's own account, because brand accounts have
-- no internal "lead" concept.
create or replace function public.tasks_apply_default_lead()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid;
begin
  if new.assigned_lead_id is not null then
    return new;
  end if;
  select default_lead_id into v_lead
  from public.accounts
  where type = 'agency'
  order by created_at asc
  limit 1;
  if v_lead is not null then
    new.assigned_lead_id := v_lead;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tasks_apply_default_lead on public.tasks;
create trigger trg_tasks_apply_default_lead
  before insert on public.tasks
  for each row execute function public.tasks_apply_default_lead();

-- 3. Seed ------------------------------------------------------------------
-- Resolve the L+R Studio agency account + the agency@linkrunner.io profile
-- and wire them together. Idempotent: re-running just no-ops if the user
-- doesn't exist yet, and overwrites nothing if a default is already set.
do $$
declare
  v_user_id    uuid;
  v_agency_id  uuid;
begin
  select id into v_user_id from auth.users
  where email = 'agency@linkrunner.io' limit 1;

  select id into v_agency_id from public.accounts
  where type = 'agency' order by created_at asc limit 1;

  if v_user_id is not null and v_agency_id is not null then
    update public.accounts
    set default_lead_id = v_user_id
    where id = v_agency_id
      and (default_lead_id is null or default_lead_id <> v_user_id);

    -- Backfill: any existing task with no lead inherits the same default.
    -- Set session_replication_role to suppress the activity trigger so this
    -- backfill doesn't flood every task's history with a synthetic
    -- 'assigned' event.
    set local session_replication_role = replica;
    update public.tasks
    set assigned_lead_id = v_user_id
    where assigned_lead_id is null;
    set local session_replication_role = origin;
  end if;
end;
$$;
