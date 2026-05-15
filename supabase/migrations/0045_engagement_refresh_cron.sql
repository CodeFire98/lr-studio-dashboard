-- =====================================================================
-- Linkrunner Media — Engagement refresh cron + observability
-- =====================================================================
-- Moves the engagement-refresh cron from Vercel (Hobby plan: once-per-
-- day, 60s function timeout, 5-per-run cap) to Supabase pg_cron +
-- engagement-refresh Edge Function (400s function timeout, sub-daily
-- schedules supported).
--
-- What this migration does:
--   1. Enables `pg_cron` and `pg_net` extensions (idempotent).
--   2. Creates `cron_run_log` for single-query "did the cron run?"
--      observability — replaces hunting through edge function logs.
--   3. Stores `CRON_SECRET` and the project URL in Vault so the pg_cron
--      job can fetch them at schedule time without hardcoding.
--   4. Schedules the cron job: `engagement-refresh-daily` at 00:30 UTC
--      (= 6:00 AM IST) every day. Hits the Edge Function via pg_net.
--
-- Why 00:30 UTC: user expects 6 AM IST. Previously the Vercel schedule
-- was `0 1 * * *` = 1:00 UTC = 6:30 AM IST. Tightened the time here.
--
-- Re-cadencing: just `select cron.unschedule('engagement-refresh-daily');`
-- and `select cron.schedule(...)` with a new cron expr. No code change.
-- e.g. for hourly:  `0 * * * *`
--      for every 4h: `0 */4 * * *`

-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- =====================================================================
-- 2. cron_run_log TABLE
-- =====================================================================
-- Every cron run (success or failure) writes one row here. Lets us
-- answer "did the cron run today?" with a single SELECT, and gives a
-- compact failure log without spelunking through edge function logs.
--
-- Append-only. Pruning is manual via a future migration once it gets
-- big — at one row per cron per day, this stays small for years.

create table public.cron_run_log (
  id              uuid primary key default gen_random_uuid(),
  function_name   text not null,
  started_at      timestamptz not null,
  finished_at     timestamptz,
  duration_ms     integer,
  status          text not null check (status in ('ok', 'error')),
  pubs_eligible   integer,
  pubs_due        integer,
  pubs_processed  integer,
  pubs_failed     integer,
  pubs_blocked    integer,
  error_message   text,
  details         jsonb,
  created_at      timestamptz not null default now()
);

create index cron_run_log_function_started_idx
  on public.cron_run_log (function_name, started_at desc);

-- RLS: agency staff can read, nobody can write via the API. Inserts
-- come from service-role inside the Edge Function.
alter table public.cron_run_log enable row level security;

create policy "cron_run_log: agency can read"
  on public.cron_run_log
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_agency = true
    )
  );

-- =====================================================================
-- 3. VAULT SECRETS for the pg_cron job
-- =====================================================================
-- pg_cron jobs run as a low-privilege role; they can't `Deno.env.get`.
-- Stash the values they need in Supabase Vault and fetch via
-- `vault.decrypted_secrets` at schedule time.
--
-- We store TWO things:
--   - cron_secret: the bearer token the Edge Function expects
--   - project_url: full Supabase URL (Edge Function URL is
--     `<project_url>/functions/v1/engagement-refresh`)
--
-- These are idempotent: on re-run, the SELECT FROM vault.decrypted_secrets
-- branch is a no-op if rows already exist. Manual rotation: update the
-- secret value via the Supabase Dashboard (Project Settings → Vault).
--
-- IMPORTANT: applying this migration does NOT set the secret values.
-- After applying, the dashboard owner sets:
--   - vault secret `engagement_cron_secret` = same value as Vercel's CRON_SECRET
--   - vault secret `engagement_project_url` = https://<project-ref>.supabase.co
-- We create placeholder rows here so the cron schedule statement below
-- doesn't fail; the operator overwrites them via dashboard or:
--   select vault.create_secret('REPLACE_ME', 'engagement_cron_secret');
--   select vault.create_secret('https://REPLACE.supabase.co', 'engagement_project_url');
-- If a row with that name already exists, the create_secret call no-ops.

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'engagement_cron_secret'
  ) then
    perform vault.create_secret('REPLACE_ME', 'engagement_cron_secret');
  end if;
  if not exists (
    select 1 from vault.secrets where name = 'engagement_project_url'
  ) then
    perform vault.create_secret('https://REPLACE.supabase.co', 'engagement_project_url');
  end if;
end $$;

-- =====================================================================
-- 4. CRON SCHEDULE
-- =====================================================================
-- Daily at 00:30 UTC = 6:00 AM IST. pg_cron runs in DB time (UTC).
--
-- Re-schedule is idempotent: unschedule any existing entry by name
-- first, then schedule fresh. Safe to run this migration multiple
-- times (the unschedule errors if the job doesn't exist, which is
-- swallowed by the DO block).

do $$
begin
  -- Best-effort cleanup of any prior schedule with this name. If the
  -- job doesn't exist yet (first apply), cron.unschedule raises an
  -- exception which we ignore.
  begin
    perform cron.unschedule('engagement-refresh-daily');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'engagement-refresh-daily',
    '30 0 * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_project_url')
               || '/functions/v1/engagement-refresh',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 390000
      );
    $cron$
  );
end $$;

-- =====================================================================
-- HOW TO VERIFY (run these after applying):
-- =====================================================================
-- 1) Cron schedule registered:
--      select jobname, schedule, command from cron.job where jobname = 'engagement-refresh-daily';
--
-- 2) Vault secrets populated (replace REPLACE_ME values first!):
--      select name, decrypted_secret from vault.decrypted_secrets
--      where name in ('engagement_cron_secret', 'engagement_project_url');
--
-- 3) Manually trigger a run (does NOT wait for the next schedule):
--      select net.http_post(
--        url := (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_project_url')
--               || '/functions/v1/engagement-refresh',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')
--        ),
--        body := '{}'::jsonb
--      );
--
-- 4) Check the run log:
--      select * from cron_run_log order by started_at desc limit 5;
--
-- 5) See the raw HTTP response from pg_net:
--      select * from net._http_response order by created desc limit 5;
