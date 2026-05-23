-- =====================================================================
-- 0057 — Soft-delete on post_plan_publications
-- =====================================================================
-- Two motivating use cases for soft-delete instead of hard-delete:
--
--   1. Live Posts "Remove post" (added 2026-05-22): user wants to take
--      a card off the Live Posts grid without losing the engagement
--      history they've already captured. With ON DELETE CASCADE on the
--      post_engagement_snapshots FK (migration 0041), any hard DELETE
--      of a publication wipes every snapshot row for that publication
--      — destroying the historical numbers we want to preserve.
--
--   2. The existing "uncheck a platform in MarkAsPostedModal" flow
--      was ALSO doing a hard DELETE (via deletePostPlanPublication
--      in db.js). Same cascade, same problem. Bringing both paths
--      onto soft-delete fixes that silently destructive behavior
--      too — engagement data is now never wiped except by an
--      explicit hard-delete of the parent post_plan.
--
-- Implementation: one nullable timestamptz column, one partial index
-- for fast "active publications" filtering. Display-side filtering
-- (`deleted_at IS NULL`) is enforced by the JS read helpers — RLS
-- doesn't get involved because soft-deleted rows must still be
-- readable by engagement-aggregation paths that need historical
-- snapshot context.
--
-- Cascade semantics:
--   - post_engagement_snapshots: deliberately UNCHANGED. The cascade
--     stays intact for hard-deletes of the parent post_plan (which is
--     a different, rare admin action). Soft-deletes don't trigger
--     the FK cascade because they're UPDATEs, not DELETEs.

-- =====================================================================
-- 1. Add the column
-- =====================================================================

alter table public.post_plan_publications
  add column if not exists deleted_at timestamptz;

-- =====================================================================
-- 2. Partial index for the common filtered query
-- =====================================================================
-- loadBrandPublications, loadPostPlanPublications, and the engagement-
-- refresh Edge Function all default to filtering `deleted_at IS NULL`.
-- A partial index keeps that filter cheap as soft-deleted rows
-- accumulate; without it the planner would scan the full table and
-- discard at runtime.

create index if not exists post_plan_publications_active_published_idx
  on public.post_plan_publications(published_at desc)
  where deleted_at is null;

-- =====================================================================
-- 3. (Optional belt-and-suspenders) Block re-INSERT collisions
-- =====================================================================
-- The unique constraint on (post_plan_id, platform) from migration
-- 0036 still applies and is what we want: if a row exists for
-- (plan, IG) and the user un-deletes by re-marking IG posted, the
-- upsert ON CONFLICT path in upsertPostPlanPublication kicks in
-- (no error) and clears deleted_at via the upsert payload's
-- `deleted_at: null`. No migration change needed for that — it's
-- a JS-side concern.
--
-- No new policy, no trigger. The column is data-only.
