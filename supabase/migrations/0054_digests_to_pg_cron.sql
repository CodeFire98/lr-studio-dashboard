-- =====================================================================
-- Linkrunner Media — move daily-digest + usage-digest off Vercel cron
-- =====================================================================
-- Both digest crons (the 6pm-IST brand-side daily-digest and the
-- 7:30am-IST agency-side usage-digest) move off Vercel Hobby cron onto
-- Supabase pg_cron, calling the same Vercel API routes via pg_net.
--
-- Why: Vercel Hobby cron is best-effort against deploy churn. If a
-- deploy is in the build window when a cron is scheduled to fire, the
-- scheduler skips that fire rather than queueing it. Confirmed missed
-- twice (2026-05-11 and 2026-05-19) on the brand daily digest — both
-- days had heavy PR-merge activity. pg_cron runs inside Postgres and
-- is completely decoupled from Vercel deploys.
--
-- The Vercel API routes themselves (/api/daily-digest, /api/usage-
-- digest) stay unchanged. They keep their CRON_SECRET bearer auth,
-- their idempotency checks, their daily_digest_log writes. The only
-- thing that changes is the caller — pg_cron instead of Vercel cron.
-- vercel.json's `crons` array drops both entries in the same PR.
--
-- Re-uses the existing `engagement_cron_secret` Vault entry from
-- migration 0045 (the secret value matches Vercel's CRON_SECRET, which
-- is what every cron in the project shares). Adds one new Vault entry
-- for the Vercel app URL.
--
-- Schedule choices (UTC, matching the previously-Vercel times):
--   - daily-digest-brand:   30 12 * * *  = 18:00 IST (6pm)
--   - usage-digest-agency:   0  2 * * *  = 07:30 IST
--
-- Re-cadencing: `select cron.unschedule('<name>'); select cron.schedule(...);`
-- with the new expression. No code change required.

-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================
-- Already enabled in migration 0045 but declared again as a defensive
-- no-op so this migration is independently runnable.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- =====================================================================
-- 2. VAULT SECRET for the Vercel app URL
-- =====================================================================
-- pg_cron jobs run as a low-privilege role and can't read Vercel env
-- vars. Stash the public app URL in Vault so the cron statement reads
-- it at fire time. Not a secret per se (https://agency.linkrunner.io
-- is the production custom domain) but lives in Vault to match the
-- existing pattern from 0045 and to make domain changes a no-code
-- operation.
--
-- Idempotent on re-apply: only inserts if missing. Operator must
-- overwrite the placeholder via Dashboard → Vault before the cron
-- will actually hit a real URL.

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'vercel_app_url'
  ) then
    perform vault.create_secret('https://REPLACE.example.com', 'vercel_app_url');
  end if;
end $$;

-- =====================================================================
-- 3. CRON SCHEDULES
-- =====================================================================
-- Both jobs follow the same shape as 0045's engagement-refresh-daily:
--   - net.http_post to the Vercel route
--   - Bearer auth using the shared engagement_cron_secret Vault entry
--   - timeout_milliseconds = 90000 (Vercel functions cap at 60s; 90s
--     gives pg_net headroom plus a short tail for network egress)
--   - Empty JSON body — the routes don't need any input
--
-- Idempotent on re-apply: unschedule any prior entry with the same name
-- first, swallow the not-found exception, then schedule fresh.

do $$
begin
  -- daily-digest-brand: 18:00 IST = 12:30 UTC, 7 days a week.
  begin
    perform cron.unschedule('daily-digest-brand');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'daily-digest-brand',
    '30 12 * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'vercel_app_url')
               || '/api/daily-digest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 90000
      );
    $cron$
  );

  -- usage-digest-agency: 07:30 IST = 02:00 UTC, 7 days a week.
  begin
    perform cron.unschedule('usage-digest-agency');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'usage-digest-agency',
    '0 2 * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'vercel_app_url')
               || '/api/usage-digest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 90000
      );
    $cron$
  );
end $$;

-- =====================================================================
-- HOW TO VERIFY (run these after applying):
-- =====================================================================
-- 1) Set the new Vault secret (Dashboard → Project Settings → Vault, OR):
--      select vault.update_secret(
--        (select id from vault.secrets where name = 'vercel_app_url'),
--        'https://agency.linkrunner.io'
--      );
--
-- 2) Cron schedules registered:
--      select jobname, schedule, command from cron.job
--      where jobname in ('daily-digest-brand', 'usage-digest-agency');
--
-- 3) Manually trigger a fire (does NOT wait for the schedule):
--      select net.http_post(
--        url := (select decrypted_secret from vault.decrypted_secrets where name = 'vercel_app_url')
--               || '/api/daily-digest',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')
--        ),
--        body := '{}'::jsonb
--      );
--
-- 4) See the raw HTTP response from pg_net:
--      select id, status_code, created from net._http_response
--      order by created desc limit 5;
--
-- 5) For the brand-side daily digest, also confirm rows landed in the
--    audit log:
--      select run_at at time zone 'Asia/Kolkata' as run_ist, account_id,
--             brand_name, sent, failed, recipients, skip_reason
--      from daily_digest_log order by run_at desc limit 5;
--
-- 6) For the usage digest, the agency staff inbox is the verification
--    signal — same as on Vercel.
--
-- IF THIS DOESN'T FIRE AT THE EXPECTED TIME:
--   - Confirm vercel_app_url is set (step 1). If it's still REPLACE.example.com,
--     the cron fires and pg_net POSTs to a non-existent host. net._http_response
--     will show DNS-level errors.
--   - Confirm engagement_cron_secret matches Vercel's CRON_SECRET env var.
--     Mismatched secret = 401 from the Vercel route. net._http_response shows
--     status_code = 401.
--   - pg_cron runs in UTC. 12:30 UTC = 18:00 IST. 02:00 UTC = 07:30 IST.
