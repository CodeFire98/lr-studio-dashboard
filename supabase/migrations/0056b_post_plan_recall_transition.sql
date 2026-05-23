-- =====================================================================
-- 0056b — Brand can recall a proposed new-plan (proposed → brand_draft)
-- =====================================================================
-- Companion to migration 0056 (proposal withdrawal). 0056 closed the
-- gap for copy_change / date_change proposals — brand can flip their
-- own plan_proposals row from 'pending' to 'withdrawn'. But new_plan
-- proposals don't HAVE a plan_proposals row (per migration 0049: "the
-- plan IS the proposal — payload would just duplicate the plan's own
-- fields"). The "proposal" for a new plan is just the post_plan row
-- sitting in status='proposed'.
--
-- So recalling a new-plan proposal means flipping the post_plan back
-- to brand_draft. Two pieces wire that up:
--
--   1. guard_post_plan_status_transitions (originally migration 0050)
--      currently allows only TWO brand transitions: brand_draft →
--      proposed and needs_review → approved. proposed → brand_draft
--      raises POST_PLAN_BRAND_FORBIDDEN_TRANSITION. Adding it to the
--      allow-list is safe: any plan in 'proposed' state was created
--      by the brand in the first place (agency never sets status =
--      proposed), so the brand owning the recall right is consistent
--      with the original-author concept.
--
--   2. emit_post_plan_status_message (originally migration 0047,
--      extended in 0050) needs a case for the new transition so the
--      Conversations log shows "X recalled the proposed plan." instead
--      of the generic fallback "changed status from proposed to
--      brand_draft."
--
-- The UI gate ('Recall proposal' button shown only when statusBucket=
-- 'proposed' AND plan.createdBy === userId, mirroring the original
-- 'Propose plan' button's createdBy gate) keeps the action limited to
-- the original brand author — agency never sees it, other brand
-- teammates never see it. The RLS / guard layers don't enforce the
-- "only original author" rule (any brand member of the account COULD
-- recall via direct API call), but that's a sensible relaxation if
-- multiple brand owners want symmetric controls later.

-- =====================================================================
-- 1. Status-transition guard — add proposed → brand_draft
-- =====================================================================

create or replace function public.guard_post_plan_status_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_agency boolean;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is null then
    return new;  -- service-role / definer contexts unconstrained
  end if;

  is_agency := public.is_agency_user();

  if is_agency then
    if new.status = 'approved' then
      raise exception
        'POST_PLAN_AGENCY_CANNOT_APPROVE: agency cannot set status=approved; approval is brand-exclusive.'
        using errcode = 'P0001';
    end if;
    if new.status = 'brand_draft' then
      raise exception
        'POST_PLAN_AGENCY_CANNOT_BRAND_DRAFT: agency cannot set status=brand_draft; that is a brand-only state.'
        using errcode = 'P0001';
    end if;
  else
    -- Brand-only permitted transitions:
    --   brand_draft  → proposed     (submit for agency review)
    --   needs_review → approved     (final sign-off)
    --   proposed     → brand_draft  (recall — added 0056b 2026-05-22)
    if old.status = 'brand_draft'  and new.status = 'proposed' then
      return new;
    end if;
    if old.status = 'needs_review' and new.status = 'approved' then
      return new;
    end if;
    if old.status = 'proposed'     and new.status = 'brand_draft' then
      return new;
    end if;
    raise exception
      'POST_PLAN_BRAND_FORBIDDEN_TRANSITION: brand cannot transition from % to %.', old.status, new.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- =====================================================================
-- 2. Status-change message — friendlier copy for the recall transition
-- =====================================================================

create or replace function public.emit_post_plan_status_message()
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

  msg := case
    when old.status = 'brand_draft'  and new.status = 'proposed'     then 'proposed a new post plan.'
    when old.status = 'proposed'     and new.status = 'brand_draft'  then 'recalled the proposed plan.'   -- added 0056b
    when old.status = 'proposed'     and new.status = 'drafting'     then 'accepted the proposed plan.'
    when old.status = 'proposed'     and new.status = 'needs_review' then 'accepted and sent the proposed plan for brand review.'
    when old.status = 'drafting'     and new.status = 'needs_review' then 'sent this plan for brand review.'
    when old.status = 'needs_review' and new.status = 'approved'     then 'approved this plan.'
    when old.status = 'needs_review' and new.status = 'drafting'     then 'pulled this plan back to drafting.'
    when old.status = 'approved'     and new.status = 'drafting'     then 'moved this plan back to drafting.'
    when old.status = 'approved'     and new.status = 'needs_review' then 'reopened this plan for brand review.'
    else format('changed status from %s to %s.', old.status, new.status)
  end;

  perform public.emit_plan_system_message(new.account_id, new.id, auth.uid(), msg);
  return new;
end;
$$;
