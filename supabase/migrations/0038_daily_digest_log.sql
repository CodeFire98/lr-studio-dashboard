-- =====================================================================
-- L+R Studio — daily_digest_log
-- =====================================================================
-- Audit trail for the 6pm-IST daily-digest cron. Every per-brand
-- decision the cron makes (sent / failed / skipped) lands here so
-- "did the brand X email go out on date Y?" becomes a one-line SQL
-- query — no Vercel-log archaeology, no Resend-dashboard pivot.
--
-- One row per (cron_run, account). All rows from the same cron tick
-- share an identical `run_at` timestamp, so grouping by that gives
-- you "the X brands considered on May 10, with Y emails sent, Z
-- skipped". The route also writes one extra row per failed brand
-- when an unexpected exception is caught — captured under
-- skip_reason='exception' with skip_details = error message.
--
-- This is intentionally a write-only audit log from the cron's
-- perspective — no UPDATE / DELETE policy, no UI mutation surface.
-- Future cleanup can prune rows older than e.g. 90 days via a
-- scheduled SQL job; not setting that up now, low cost at our scale.

create table public.daily_digest_log (
  id                   uuid        primary key default gen_random_uuid(),
  run_at               timestamptz not null    default now(),
  account_id           uuid                    references public.accounts(id) on delete set null,
  brand_name           text,
  -- Outcome counters. Three terminal states the cron writes:
  --   * sent > 0, skip_reason IS NULL                  → emails dispatched
  --   * sent = 0, skip_reason = '<enum>'               → skipped (no plans, no recipients, reminder off…)
  --   * sent = 0, failed > 0, skip_reason LIKE 'send%' → tried, Resend rejected
  sent                 int         not null    default 0,
  failed               int         not null    default 0,
  recipients           int         not null    default 0,
  plans_needs_review   int         not null    default 0,
  plans_approved       int         not null    default 0,
  -- Skip / failure annotations. `skip_reason` is one of the enum
  -- values the route surfaces (no_qualifying_plans, reminder_disabled,
  -- no_members_with_email, all_already_posted, query_failed,
  -- exception, send_failed); `skip_details` is the Postgres / Resend
  -- error message when applicable, trimmed to 500 chars.
  skip_reason          text,
  skip_details         text,
  -- Run-level metadata. Same for every row from a given cron run,
  -- denormalised here so a single-row SELECT tells the full story
  -- without joining elsewhere.
  window_start_utc     timestamptz,
  window_end_utc       timestamptz,
  tomorrow_ist_label   text
);

-- Filter-by-recency and filter-by-brand are the only access patterns;
-- two indexes cover both. The (account_id, run_at desc) composite
-- gives us the brand-history view in one b-tree seek.
create index daily_digest_log_run_at_idx
  on public.daily_digest_log(run_at desc);
create index daily_digest_log_account_run_idx
  on public.daily_digest_log(account_id, run_at desc);

-- =====================================================================
-- RLS
-- =====================================================================
-- Read: agency staff only (this is an internal audit surface — brands
-- don't need to see their own row's status; if they did, they'd just
-- see "we tried to email you" which isn't useful information).
--
-- Write: service-role only via the cron route. We don't create an
-- INSERT policy at all — service-role bypasses RLS, regular auth'd
-- users hit no-policy-matched and get rejected. Same shape as
-- `post_plan_status_log` (writes via SECURITY DEFINER trigger only).

alter table public.daily_digest_log enable row level security;

create policy daily_digest_log_select on public.daily_digest_log
  for select to authenticated
  using (public.is_agency_user());
