-- =====================================================================
-- Linkrunner Media — service_usage_log
-- =====================================================================
-- Append-only telemetry for every external-service call we make on
-- behalf of users — Anthropic (Claude), Firecrawl (web scrape/search),
-- Apify (engagement scrape). Powers:
--
--   1. The 07:30 IST daily usage digest email to agency staff
--      (totals + per-brand breakdown + alerts + errors).
--   2. The per-brand AI quota enforcer (50 chat messages / brand /
--      24h, agency users bypass — see `checkBrandAiQuota` helper).
--   3. Ad-hoc operational queries — "did Bamboo Bear spend a lot last
--      week?", "which routes are throwing the most errors?", etc.
--
-- Shape mirrors `daily_digest_log` (one row per event, no UPDATE/DELETE
-- policy, service-role writes only, agency-only reads). Append-only by
-- contract; the cron route + edge functions + Vercel API routes all
-- write through the `logServiceUsage` helper at
-- `web/api/_shared/usage.ts`, never the client.

create table public.service_usage_log (
  id              uuid        primary key default gen_random_uuid(),
  created_at      timestamptz not null    default now(),
  -- Which external service was called. Constrained so a typo doesn't
  -- silently bucket calls into 'antrhopic' or similar. Add new values
  -- via migration when we add a service (e.g. nano-banana image gen).
  service         text        not null    check (service in ('anthropic', 'firecrawl', 'apify')),
  -- Logical route name. For Vercel API routes this is the path
  -- ('/api/ai/chat', '/api/fetch-trends', '/api/engagement/refresh').
  -- For Supabase edge functions it's the function name
  -- ('engagement-refresh'). The cron variant uses '-cron' suffix where
  -- relevant. Free-text; not enum'd because routes get added often.
  route           text        not null,
  -- Caller context. Both nullable: cron-driven calls have no user_id;
  -- service-wide health-check calls would have no account_id.
  account_id      uuid                    references public.accounts(id) on delete set null,
  user_id         uuid                    references public.profiles(id) on delete set null,
  -- Token accounting (Anthropic only; null for other services). Cache
  -- read / write breakdown lives in `meta` since not all services have
  -- a comparable concept.
  tokens_in       int,
  tokens_out      int,
  -- Cost estimate in USD, 6 decimals (sub-cent precision: Anthropic
  -- pricing is in fractions of a cent per call, X scrape is $0.0002).
  -- Computed by the caller using current rate cards baked into
  -- `usage.ts`. Refresh the rate-card constants annually; the
  -- historical rows stay accurate to what we believed at the time.
  cost_usd        numeric(12, 6),
  -- Round-trip latency for the external call only (does not include
  -- our own queueing). Null when not measured (synchronous-but-not-
  -- timed code paths).
  latency_ms      int,
  -- Terminal status. 'blocked' is distinct from 'failed' for the case
  -- where the upstream returns 4xx/quota-exhausted (Apify monthly cap,
  -- Anthropic 429, etc.) versus a genuine 5xx / network blip.
  status          text        not null    check (status in ('ok', 'failed', 'blocked')),
  -- Error message when status != 'ok'. Truncated to 500 chars in the
  -- helper so a bad stack trace doesn't bloat a row.
  error           text,
  -- Service-specific extras. Anthropic: { model, cache_read_tokens,
  -- cache_write_tokens }. Apify: { actor_id, run_id, platform }.
  -- Firecrawl: { endpoint, query_kind }. Always-present keys are
  -- enforced by the helper's TypeScript types, not by the DB — the
  -- jsonb just stores whatever the caller passes.
  meta            jsonb       not null    default '{}'::jsonb
);

-- Three b-trees cover every read pattern the digest cron + ad-hoc
-- queries care about:
--   * created_at desc        → "last 24h totals" (the most-hit query)
--   * (service, created_at)  → "Anthropic spend over last 7 days"
--   * (account_id, created_at) → "top 5 brands by spend"
create index service_usage_log_created_at_idx
  on public.service_usage_log(created_at desc);
create index service_usage_log_service_created_idx
  on public.service_usage_log(service, created_at desc);
create index service_usage_log_account_created_idx
  on public.service_usage_log(account_id, created_at desc);

-- Partial index just for chat-message quota enforcement — the hot
-- path on every AI chat request. Service+route+account+24h-window is
-- the exact shape of `checkBrandAiQuota`. Partial index keeps it
-- small (only Anthropic rows, only recent), which is what we want
-- for an index that gets hit on every chat send.
create index service_usage_log_quota_idx
  on public.service_usage_log(account_id, created_at desc)
  where service = 'anthropic';

-- =====================================================================
-- RLS
-- =====================================================================
-- Read: agency staff only. This is an internal ops surface; brand
-- users have no business seeing what other brands spend on Claude.
-- The digest email is the user-facing view, and that's already
-- agency-only.
--
-- Write: NO POLICY. Service-role bypasses RLS; everything else hits
-- no-policy-matched and gets denied. Same shape as
-- `post_plan_status_log` (trigger-only writes) and `daily_digest_log`
-- (route-only writes).

alter table public.service_usage_log enable row level security;

create policy service_usage_log_select on public.service_usage_log
  for select to authenticated
  using (public.is_agency_user());
