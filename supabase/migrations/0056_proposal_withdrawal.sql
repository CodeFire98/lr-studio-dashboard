-- =====================================================================
-- 0056 — Proposal withdrawal (proposer can recall a pending proposal)
-- =====================================================================
-- Migration 0047 left a "v1" hole on plan_proposals:
--
--   "UPDATE: agency only. Brand can't withdraw or edit a pending proposal
--   in v1 — if they want different terms, they propose again."
--
-- That assumption broke when we replaced the "Propose changes" modal
-- with the inline Edit pill (2026-05-22, PR B): a brand user clicks
-- Edit, makes an accidental change, hits Propose change… and now has
-- no way to undo it short of waiting for the agency to reject.
--
-- This migration closes the hole with a third terminal status —
-- 'withdrawn' — that ONLY the proposer can set, ONLY from 'pending',
-- and ONLY on their own proposals. Agency-side UPDATEs and the existing
-- approve/reject path are untouched.
--
-- Three layers:
--   1. Allow 'withdrawn' as a status value (CHECK constraint).
--   2. RLS: proposer (auth.uid() = proposed_by) can flip pending →
--      withdrawn on their own proposal. No other transitions allowed
--      through this policy — agency UPDATEs still go through the
--      existing plan_proposals_update_agency policy.
--   3. Trigger updates: emit "<proposer> withdrew their proposed <X>."
--      system message, and stamp resolved_at / resolved_by the same
--      way approved/rejected do.

-- =====================================================================
-- 1. Extend the status CHECK constraint to allow 'withdrawn'
-- =====================================================================
-- Drop + recreate is the only way to widen a CHECK in Postgres.

alter table public.plan_proposals
  drop constraint if exists plan_proposals_status_check;

alter table public.plan_proposals
  add constraint plan_proposals_status_check
  check (status in ('pending', 'approved', 'rejected', 'withdrawn'));

-- =====================================================================
-- 2. New RLS UPDATE policy — proposer-can-withdraw-their-own-pending
-- =====================================================================
-- Symmetric to plan_proposals_update_agency: agency can update any
-- proposal (existing policy); proposer can update only their own
-- pending proposal and only to flip it to withdrawn.
--
-- PostgreSQL's RLS evaluates UPDATE policies as: at least one USING
-- clause must pass for the row to be visible to UPDATE; at least one
-- WITH CHECK clause must pass for the new row. With both policies,
-- the agency policy lets agency through any transition; this policy
-- lets the proposer through ONLY the pending→withdrawn transition.

create policy plan_proposals_update_proposer_withdraw on public.plan_proposals
  for update to authenticated
  using (
    proposed_by = auth.uid()
    and status = 'pending'
  )
  with check (
    proposed_by = auth.uid()
    and status = 'withdrawn'
  );

-- =====================================================================
-- 3a. Trigger update: emit_plan_proposal_resolved_message
-- =====================================================================
-- Adds the 'withdrawn' branch alongside approved/rejected. Same shape
-- as 0047; just three more case-arms.

create or replace function public.emit_plan_proposal_resolved_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  msg text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status <> 'pending' then
    return new;  -- only emit on first resolution (no re-fire on later edits)
  end if;

  msg := case new.kind
    when 'new_plan' then case new.status
      when 'approved'  then 'accepted the proposed plan.'
      when 'rejected'  then 'rejected the proposed plan.'
      when 'withdrawn' then 'withdrew their proposed plan.'
      else format('marked the proposed plan as %s.', new.status) end
    when 'date_change' then case new.status
      when 'approved'  then 'accepted the proposed date change.'
      when 'rejected'  then 'rejected the proposed date change.'
      when 'withdrawn' then 'withdrew their proposed date change.'
      else format('marked the date proposal as %s.', new.status) end
    when 'copy_change' then case new.status
      when 'approved'  then 'accepted the proposed copy changes.'
      when 'rejected'  then 'rejected the proposed copy changes.'
      when 'withdrawn' then 'withdrew their proposed copy changes.'
      else format('marked the copy proposal as %s.', new.status) end
    else format('resolved a %s proposal as %s.', new.kind, new.status)
  end;

  -- Actor depends on the transition direction: on withdrawal it's the
  -- proposer themselves; on approve/reject it's the resolver (agency).
  -- auth.uid() captures whichever is calling — same in both cases
  -- because the policy gates ensure only the right role can transition.
  perform public.emit_plan_system_message(new.account_id, new.post_plan_id, auth.uid(), msg);
  return new;
end;
$$;

-- Trigger itself is unchanged — already wired in 0047. The CREATE
-- OR REPLACE above swaps in the new function body.

-- =====================================================================
-- 3b. Trigger update: stamp_plan_proposal_resolution
-- =====================================================================
-- Same idea: stamp resolved_at / resolved_by on withdrawn just like
-- approved / rejected. Keeps the audit-trail columns symmetric across
-- all three terminal states.

create or replace function public.stamp_plan_proposal_resolution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and old.status = 'pending'
     and new.status in ('approved', 'rejected', 'withdrawn') then
    if new.resolved_at is null then new.resolved_at := now(); end if;
    if new.resolved_by is null then new.resolved_by := auth.uid(); end if;
  end if;
  return new;
end;
$$;
