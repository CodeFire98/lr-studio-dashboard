-- =====================================================================
-- L+R Studio — AI usage counter (Phase 1: brand-side AI rollout)
-- =====================================================================
-- One row per AI call (chat / copy / image / suggestions) so we can
-- enforce a per-brand daily quota. Used only for brand callers; agency
-- calls are still recorded so we have a full picture of spend, but
-- they don't count against the quota.
--
-- Quota policy (enforced in web/api/ai/auth-lib.ts):
--   * 50 calls / day / brand for brand callers, summed across all AI
--     surfaces (chat + inline copy + inline image + suggestion chips).
--   * Day boundary = midnight IST (Asia/Kolkata).
--   * Agency callers: unlimited; rows are still recorded for telemetry.
--
-- RLS: deny all from clients. Service role inserts + reads. No need to
-- expose this table to the dashboard UI.

create table public.ai_usage (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts(id)  on delete cascade,
  user_id           uuid references public.profiles(id)           on delete set null,
  caller_is_agency  boolean not null,
  kind              text not null check (kind in ('chat', 'copy', 'image', 'suggestions')),
  created_at        timestamptz not null default now()
);

-- Hot read path: count brand calls for an account since midnight IST.
-- Partial index keeps it tiny by excluding agency rows (they don't
-- count toward the quota check).
create index ai_usage_brand_today_idx
  on public.ai_usage(account_id, created_at desc)
  where caller_is_agency = false;

-- Secondary index for full telemetry queries (any caller).
create index ai_usage_account_created_idx
  on public.ai_usage(account_id, created_at desc);

alter table public.ai_usage enable row level security;
-- No policies = no client access. Service role bypasses RLS.
