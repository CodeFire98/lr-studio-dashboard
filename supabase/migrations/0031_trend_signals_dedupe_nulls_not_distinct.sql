-- =====================================================================
-- L+R Studio — fix trend_signals dedupe (NULL account_id was breaking it)
-- =====================================================================
-- The unique index added in migration 0029 was
--   (platform, kind, region, title, trend_window, account_id)
-- intended to dedupe re-fetches of the same trend so refresh upserts
-- instead of stacking duplicates.
--
-- It worked for per-brand sources (Instagram in Phase 3 — account_id is
-- a real uuid). It DID NOT work for global sources (TikTok, Twitter)
-- because Postgres' default treatment of NULLs in a unique index
-- considers every NULL distinct from every other NULL. So an upsert
-- with `onConflict: "platform,kind,region,title,trend_window,account_id"`
-- found no conflict (NULL ≠ NULL) and inserted a fresh row every time.
-- Hitting the Refresh button N times produced N copies of every trend.
--
-- Fix: drop and recreate the index with NULLS NOT DISTINCT (Postgres 15+).
-- That treats NULL as a single equivalence class, so two rows with
-- account_id=NULL and otherwise-identical dedupe keys collapse into one.
--
-- Also: collapse the duplicates that already accumulated on prod before
-- this fix lands. We keep the most-recently-captured row per natural
-- key (the freshest signal) and delete the rest.
-- =====================================================================

-- 1) Collapse existing duplicates. row_number() over the natural key
--    (treating NULL as a sentinel) lets us keep rn=1 (the newest) and
--    drop everything else.
delete from public.trend_signals
where id in (
  select id
  from (
    select
      id,
      row_number() over (
        partition by platform, kind, region, title, trend_window,
                     coalesce(account_id::text, '__null__')
        order by captured_at desc, id desc
      ) as rn
    from public.trend_signals
  ) ranked
  where ranked.rn > 1
);

-- 2) Recreate the dedupe index so future inserts collapse correctly.
drop index if exists public.trend_signals_dedupe_idx;
create unique index trend_signals_dedupe_idx
  on public.trend_signals(platform, kind, region, title, trend_window, account_id)
  nulls not distinct;

comment on index public.trend_signals_dedupe_idx is
  'Natural key for trend dedupe. NULLS NOT DISTINCT so NULL account_id collapses correctly for global sources (TikTok, Twitter). Without it, every refresh on a global source inserted a fresh row instead of upserting. See migration 0031 for the bug history.';
