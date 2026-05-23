-- =====================================================================
-- 0058 — Post-plan visibility gated by status × role
-- =====================================================================
-- Two distinct "drafting" stages exist in the workflow today:
--
--   - brand_draft (added in migration 0050): brand's private editing
--     space BEFORE they click "Propose plan". Agency should never see
--     these — surfacing them would defeat the whole "let brand prep
--     in peace, then announce" pattern that 0050 added.
--
--   - drafting: agency's private editing space AFTER accepting a
--     proposal OR after creating a plan from scratch, but BEFORE
--     clicking "Submit for review". Brand should never see these —
--     they'd be peering over the agency's shoulder mid-draft, which
--     is the exact UX problem 0050 fixed in the other direction.
--
-- Until this migration, post_plans.RLS only checked account membership
-- and let both roles see ALL statuses inside an account. The UI tried
-- to enforce role-gated visibility on `brand_draft` but did so loosely
-- (some surfaces still surfaced them); `drafting` was completely
-- ungated and visible to everyone.
--
-- This migration tightens post_plans_select so:
--
--   - Agency users:   see every plan EXCEPT brand_draft.
--   - Brand users:    see their account's plans EXCEPT drafting.
--   - Other statuses (proposed, needs_review, approved) → visible to
--     both, as before.
--
-- Realtime: Supabase Realtime v2 respects RLS per-event for
-- postgres_changes streams. After this change, a brand client with
-- the calendar open won't receive INSERT/UPDATE events for plans
-- transitioning into `drafting`, and an agency client similarly
-- won't receive events for `brand_draft` inserts. No client-side
-- change needed for that — the subscription naturally goes quiet
-- for filtered-out rows.
--
-- The INSERT / UPDATE / DELETE policies stay UNCHANGED. Their
-- account-membership check already prevents cross-role meddling,
-- and the status-transition guard from migration 0050 already
-- forbids brand→brand_draft for agency and agency→drafting transitions
-- being attempted by brand. So we don't need to layer status filters
-- on the write policies — RLS gates SELECT, the guard trigger gates
-- transitions, and the result is consistent.

-- Drop the old broad-membership policy.
drop policy if exists post_plans_select on public.post_plans;

-- Replace with a role-aware policy that adds status filters.
create policy post_plans_select on public.post_plans
  for select to authenticated
  using (
    -- Agency sees everything except the brand's private draft space.
    (public.is_agency_user() and status <> 'brand_draft')
    or
    -- Brand sees their account's plans except the agency's private
    -- draft space. `accessible_account_ids()` already gates multi-
    -- brand brand users to only their own accounts.
    (
      not public.is_agency_user()
      and account_id in (select public.accessible_account_ids())
      and status <> 'drafting'
    )
  );
