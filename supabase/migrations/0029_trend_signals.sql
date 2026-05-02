-- =====================================================================
-- L+R Studio — trend_signals (Trends Radar)
-- =====================================================================
-- A platform-agnostic pool of "what's trending right now" rows. Each row
-- is one trending hashtag, sound, topic, post, or creator from a single
-- source (TikTok / Instagram / Twitter / LinkedIn) for a single region.
--
-- The schema is intentionally generic so all sources share one table —
-- adding Twitter or Instagram in later phases means writing a new edge
-- function handler that inserts here, with no schema or UI rebuild.
--
-- Read access (Phase 0 = agency-only):
--   - Agency staff (is_agency_user()) can SELECT every row.
--   - Brand users get no access yet. Phase 5+ may open per-account rows
--     (where account_id is set) to that account's members; until then the
--     feature is invisible to brand users by RLS.
--
-- Write access:
--   - Service role only (the fetch-trends edge function). No client-side
--     writes. This keeps the source of truth on the server and prevents
--     a brand user from polluting the pool via the SPA.
-- =====================================================================

create table public.trend_signals (
  id              uuid primary key default gen_random_uuid(),
  -- Source platform. New values are added by future phases (instagram, twitter, linkedin).
  platform        text not null check (platform in ('tiktok', 'instagram', 'twitter', 'linkedin')),
  -- Shape of the signal. Lets the same table hold hashtags, sounds, topics, etc.
  kind            text not null check (kind in ('hashtag', 'sound', 'topic', 'post', 'creator')),
  -- ISO-3166 alpha-2 country code (e.g. 'US', 'IN'), or 'global' for world-wide trends.
  region          text not null default 'global',
  -- Optional category bucket so per-brand filtering can match by industry later
  -- (e.g. 'food', 'fashion', 'fitness'). Null = uncategorized.
  category        text,
  -- The headline thing being trended: hashtag string, song title, topic name.
  title           text not null,
  -- Secondary line: artist for a sound, post-count for a hashtag, etc.
  subtitle        text,
  -- Link back to the source (Creative Center page, tweet, post URL).
  url             text,
  thumbnail_url   text,
  -- Numeric metric value (views / posts / tweet volume). Null if not provided.
  metric_value    numeric,
  -- Human label for that metric ('posts', 'tweet volume', 'plays').
  metric_label    text,
  -- Position in the trending list this row was scraped from (1, 2, 3…). Null
  -- when the source doesn't expose ranking.
  rank            int,
  -- The window the source measured against ('now' / '7d' / '30d').
  trend_window    text not null default '7d'
                  check (trend_window in ('now', '24h', '7d', '30d')),
  -- When this row was captured.
  captured_at     timestamptz not null default now(),
  -- When this row should be considered stale and pruned. Default 14 days.
  expires_at      timestamptz not null default (now() + interval '14 days'),
  -- Full payload from the source for forensics — useful when the parsing
  -- changes and we want to re-derive fields without re-scraping.
  raw_payload     jsonb,
  -- Optional brand scoping. Phase 0 always leaves this null (signals are
  -- global to the agency). Phase 3 will populate it for per-brand IG
  -- hashtag tracking, at which point the RLS policy below opens read
  -- access to that account's members.
  account_id      uuid references public.accounts(id) on delete cascade
);

create index trend_signals_platform_region_idx
  on public.trend_signals(platform, region, captured_at desc);
create index trend_signals_account_idx
  on public.trend_signals(account_id) where account_id is not null;
create index trend_signals_expires_idx
  on public.trend_signals(expires_at);
-- Dedupe key: same source captured the same trending thing in the same
-- region/window in the last few hours — overwrite rather than stack
-- duplicates. The fetch-trends edge function will use this with upsert.
create unique index trend_signals_dedupe_idx
  on public.trend_signals(platform, kind, region, title, trend_window, account_id);

-- Realtime not enabled for v1; the dashboard polls on mount + after a
-- manual refresh. Cheap, and avoids burning realtime quota on a slow-
-- moving table.

-- =====================================================================
-- RLS — agency-only read; service-role write.
-- =====================================================================

alter table public.trend_signals enable row level security;

-- Agency reads everything; per-brand rows additionally readable by that
-- brand's members (forward-compatible with Phase 3 even though Phase 0
-- never sets account_id).
create policy trend_signals_read_agency on public.trend_signals
  for select
  to authenticated
  using (
    public.is_agency_user()
    or (
      account_id is not null
      and exists(
        select 1 from public.account_members am
        where am.account_id = trend_signals.account_id
          and am.user_id = auth.uid()
      )
    )
  );

-- No INSERT/UPDATE/DELETE policies for authenticated users — only the
-- service-role client (used by the fetch-trends edge function) can write.
-- Service-role bypasses RLS entirely so we don't need an explicit policy
-- for it.

-- =====================================================================
-- Pruning helper — call from a cron or a manual cleanup. Service role
-- bypasses RLS; this is here so we have a single named entry point and
-- can grant EXECUTE to the cron user later.
-- =====================================================================

create or replace function public.prune_expired_trend_signals()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  removed int;
begin
  delete from public.trend_signals where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_expired_trend_signals() from public;
