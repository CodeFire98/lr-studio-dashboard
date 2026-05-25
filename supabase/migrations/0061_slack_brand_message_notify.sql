-- =====================================================================
-- L+R Studio — Slack relay for brand → agency messages
-- =====================================================================
-- Pings #lrmedia-inbox in Slack whenever a brand user posts a message
-- in the Conversations tab. Single channel for all brands — staff use
-- it as a unified inbox so nothing slips through.
--
-- Pipeline:
--   conversation_messages INSERT
--     → AFTER trigger pre-filters (brand-authored, user kind, not deleted, non-empty)
--     → claims a dedupe row in slack_notify_log (unique on message_id)
--     → net.http_post to /api/slack/brand-message-notify with the message_id
--     → Vercel route re-fetches with service role, builds Block Kit, POSTs to Slack
--     → Vercel route updates the log row with delivery status
--
-- Why this shape (vs. pg_net straight to Slack):
--   - Brand name, plan title, deep links live in joined tables. Doing
--     those joins in plpgsql + assembling Block Kit JSON is painful.
--     The Vercel route does it in TypeScript next to the rest of the
--     app's Supabase reads.
--   - Slack webhook URL stays out of pg_dump / Vault drift — it lives
--     in Vercel env where the rest of the third-party keys live.
--   - The trigger only knows one secret (the shared bearer) and one
--     destination (the Vercel route). Slack itself can be swapped, rate-
--     limited, or fanned out later without touching the DB.
--
-- Why an AFTER INSERT trigger (vs. supabase_functions.http_request hook):
--   - Same primitive under the hood, but writing it as a plpgsql trigger
--     with SECURITY DEFINER + a SAVEPOINT-style exception block lets us
--     guarantee the trigger NEVER rolls back the user's message even if
--     pg_net or the Vault lookup misbehaves.
--   - Matches the shape of emit_plan_system_message / emit_post_plan_-
--     publication_message — one consistent pattern for "message inserts
--     emit downstream effects".
--
-- Idempotency / dedupe:
--   - slack_notify_log.message_id is the PK. INSERT … ON CONFLICT DO
--     NOTHING means a replayed trigger (rare, but possible across logical
--     replication or manual re-INSERT) won't re-ping Slack.

-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================
-- pg_net is already enabled by 0045 / 0054. Declared again as a defensive
-- no-op so this migration is independently runnable.

create extension if not exists pg_net;

-- =====================================================================
-- 2. VAULT — shared bearer secret for the Vercel route
-- =====================================================================
-- Reuses the existing `vercel_app_url` Vault entry from 0054 — same
-- Vercel project, same host. Only the bearer is new.
--
-- Idempotent on re-apply: only inserts a placeholder if missing. Operator
-- MUST overwrite the placeholder via Dashboard → Vault before any brand
-- message will reach Slack. The placeholder fails the bearer check on
-- the Vercel side, which surfaces as a clean 401 in net._http_response
-- rather than a silent drop.

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'slack_notify_shared_secret'
  ) then
    perform vault.create_secret('REPLACE_WITH_SLACK_NOTIFY_SHARED_SECRET', 'slack_notify_shared_secret');
  end if;
end $$;

-- =====================================================================
-- 3. AUDIT / DEDUPE LOG
-- =====================================================================
-- One row per dispatched message. PK on message_id gives us free dedupe
-- (the trigger uses INSERT … ON CONFLICT DO NOTHING and only fires the
-- HTTP call when it actually claimed the row).
--
-- The trigger writes `dispatched_at`; the Vercel route fills in
-- `delivered_at`, `slack_status`, `slack_error` after the Slack POST.
-- A row with dispatched_at IS NOT NULL but delivered_at IS NULL means
-- "trigger fired but Vercel never ACK'd" — the alert signal for cron
-- archaeology when Slack goes quiet.

create table public.slack_notify_log (
  message_id     uuid        primary key references public.conversation_messages(id) on delete cascade,
  dispatched_at  timestamptz not null default now(),
  delivered_at   timestamptz,
  slack_status   int,
  slack_error    text
);

create index slack_notify_log_dispatched_idx
  on public.slack_notify_log(dispatched_at desc);

-- ---- RLS -------------------------------------------------------------
-- Mirrors daily_digest_log: agency-readable for ops; no client writes
-- (service role bypasses RLS, the trigger uses SECURITY DEFINER).

alter table public.slack_notify_log enable row level security;

create policy slack_notify_log_select on public.slack_notify_log
  for select to authenticated
  using (public.is_agency_user());

-- =====================================================================
-- 4. TRIGGER FUNCTION
-- =====================================================================
-- Fires after every conversation_messages INSERT. Returns NULL (the
-- AFTER convention) regardless of branch — we never want to influence
-- the parent transaction.
--
-- Exception model: any error inside the function is swallowed and a
-- WARNING is raised. Slack ping failures must NOT block a brand's
-- message from landing. The cost is "silent Slack misses" → caught by
-- the slack_notify_log row missing delivered_at + the net._http_response
-- table for raw network errors.

create or replace function public.notify_slack_on_brand_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_url    text;
  bearer      text;
  is_brand    boolean;
  log_claimed boolean;
begin
  -- ---- Cheap pre-filters (no JOIN, no Vault lookup) -----------------
  if new.kind is distinct from 'user' then
    return null;
  end if;
  if new.deleted_at is not null then
    return null;
  end if;
  if new.body is null or length(btrim(new.body)) = 0 then
    return null;
  end if;
  if new.author_id is null then
    return null;
  end if;

  -- ---- Author must be a brand user (not agency) ---------------------
  select not is_agency
    into is_brand
    from public.profiles
   where id = new.author_id;
  if is_brand is distinct from true then
    return null;
  end if;

  -- ---- Claim the dedupe row -----------------------------------------
  -- ON CONFLICT DO NOTHING returns 0 rows on dupe → FOUND = false →
  -- skip the HTTP call. Belt-and-braces against logical-replication
  -- replay or any future pathway that re-fires the trigger.
  insert into public.slack_notify_log (message_id)
    values (new.id)
    on conflict (message_id) do nothing;
  log_claimed := found;
  if not log_claimed then
    return null;
  end if;

  -- ---- Vault lookups ------------------------------------------------
  select decrypted_secret into base_url
    from vault.decrypted_secrets
   where name = 'vercel_app_url';
  select decrypted_secret into bearer
    from vault.decrypted_secrets
   where name = 'slack_notify_shared_secret';

  if base_url is null or bearer is null then
    -- Misconfigured environment; surface as warning, leave the log row
    -- in place (with delivered_at IS NULL) so it's grep-able later.
    raise warning 'notify_slack_on_brand_message: missing vault secret (base_url=%, bearer set=%)',
      base_url is not null, bearer is not null;
    return null;
  end if;

  -- ---- Fire-and-forget HTTP POST ------------------------------------
  -- pg_net queues the request in net._http_response; the function
  -- itself returns immediately. timeout matches our other pg_net callers.
  perform net.http_post(
    url := base_url || '/api/slack/brand-message-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer
    ),
    body := jsonb_build_object('message_id', new.id::text),
    timeout_milliseconds := 30000
  );

  return null;
exception
  when others then
    -- Last-resort guard: never let a Slack-relay error roll back the
    -- user's message. Surface the SQLERRM as a warning for log mining.
    raise warning 'notify_slack_on_brand_message failed for message %: %', new.id, sqlerrm;
    return null;
end;
$$;

-- =====================================================================
-- 5. TRIGGER
-- =====================================================================
-- AFTER INSERT only — we explicitly do NOT fire on UPDATE (edits don't
-- re-ping) or DELETE (soft-deletes are tombstones, no signal).

drop trigger if exists conversation_messages_slack_notify on public.conversation_messages;

create trigger conversation_messages_slack_notify
  after insert on public.conversation_messages
  for each row execute function public.notify_slack_on_brand_message();

-- =====================================================================
-- HOW TO VERIFY (run these after applying):
-- =====================================================================
-- 1) Set the new Vault secret (Dashboard → Project Settings → Vault, OR):
--      select vault.update_secret(
--        (select id from vault.secrets where name = 'slack_notify_shared_secret'),
--        '<the secret from the PR description>'
--      );
--
-- 2) Confirm the trigger is registered:
--      select tgname, tgenabled from pg_trigger
--      where tgrelid = 'public.conversation_messages'::regclass
--        and tgname = 'conversation_messages_slack_notify';
--
-- 3) Smoke test by inserting a fake brand message (run as service role).
--    Substitute a real conversation_id + brand-user author_id:
--      insert into public.conversation_messages
--        (conversation_id, author_id, body, kind)
--      values
--        ('<conv-id>', '<brand-profile-id>', 'slack relay smoke test', 'user');
--
-- 4) Check the dispatch landed:
--      select * from public.slack_notify_log order by dispatched_at desc limit 5;
--      select id, status_code, content_short, created from net._http_response
--      order by created desc limit 5;
--
-- 5) Look in #lrmedia-inbox for the Block Kit message.
--
-- IF THIS DOESN'T FIRE:
--   - vercel_app_url Vault entry still says REPLACE.example.com? Fix it.
--   - slack_notify_shared_secret still placeholder? Bearer check on
--     Vercel will 401 — visible in net._http_response.status_code.
--   - net._http_response shows a non-2xx? Check the Vercel route logs.
--   - net._http_response empty entirely? Trigger likely raised — check
--     server logs for the "notify_slack_on_brand_message failed" warning.
