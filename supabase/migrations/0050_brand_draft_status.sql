-- =====================================================================
-- L+R Studio — Brand proposals: explicit submit step (PR 4 of 6)
-- =====================================================================
-- Splits the brand's "create" from "submit". Previously a brand "Propose
-- plan" click would (a) insert the post_plans row in status='proposed'
-- AND (b) immediately emit the "Shruti proposed a new post plan."
-- system message. That pinged the agency before the brand had typed
-- anything.
--
-- New flow:
--   1. Brand clicks "+ Propose plan" → stub row inserts in 'brand_draft'.
--      Not visible to agency as actionable; no system message yet.
--   2. Brand fills in concept / copy / date / platforms inline.
--   3. Brand clicks "Propose plan" (UI button in PR 4 — separate from
--      the create CTA) → status flips brand_draft → proposed. The
--      existing status-change trigger emits the conversation message.
--
-- This migration:
--   1. Adds 'brand_draft' to the status CHECK constraint.
--   2. Updates emit_post_plan_status_message() to add a case for
--      brand_draft → proposed (the "submit" event).
--   3. Updates guard_post_plan_status_transitions() to allow the brand
--      brand_draft → proposed transition AND to forbid agency from
--      setting status='brand_draft' (brand-only state).
--
-- The AFTER INSERT trigger from migration 0049 stays in place as a
-- safety net: if anyone direct-inserts a row in status='proposed'
-- (admin SQL, future automation), the audit message still fires.

-- =====================================================================
-- 1. Extend post_plans.status CHECK with 'brand_draft'
-- =====================================================================

do $$
declare
  cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'public.post_plans'::regclass
     and contype  = 'c'
     and pg_get_constraintdef(oid) ilike '%status%in%';
  if cname is not null then
    execute format('alter table public.post_plans drop constraint %I', cname);
  end if;
end$$;

alter table public.post_plans
  add constraint post_plans_status_check
  check (status in ('drafting', 'needs_review', 'approved', 'proposed', 'brand_draft'));

-- =====================================================================
-- 2. Status-change message trigger — add brand_draft → proposed case
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

-- =====================================================================
-- 3. Status transition guard — allow brand_draft → proposed (brand)
--    and block agency from creating brand_drafts
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
    --   brand_draft  → proposed   (submit for agency review)
    --   needs_review → approved   (final sign-off)
    if old.status = 'brand_draft'  and new.status = 'proposed' then
      return new;
    end if;
    if old.status = 'needs_review' and new.status = 'approved' then
      return new;
    end if;
    raise exception
      'POST_PLAN_BRAND_FORBIDDEN_TRANSITION: brand cannot transition from % to %.', old.status, new.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
