-- =====================================================================
-- L+R Studio — Brand proposals: status transition guard (PR 2 of 6)
-- =====================================================================
-- Tightens who can move a post_plan into which status. Two rules:
--
--   1. Agency can never set status='approved'.  Approval is exclusively
--      a brand action; the agency's terminal forward step is 'needs_review'.
--   2. Brand can only set status='approved', and only from 'needs_review'.
--      They can't push to 'drafting' / 'needs_review' / 'proposed' — those
--      are all agency-side moves.
--
-- Service-role / SECURITY DEFINER contexts (where auth.uid() is null)
-- bypass the guard entirely so server-side automations and migrations
-- aren't constrained. The only thing they cost us is "an attacker who
-- already has service-role can do anything" — which is already true.
--
-- Existing data is not touched: the trigger only fires on UPDATEs that
-- actually change status, going forward.

create or replace function public.guard_post_plan_status_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_agency boolean;
begin
  -- Not a status change → nothing to guard.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Service-role / definer contexts (cron, edge functions, migrations)
  -- aren't gated. auth.uid() is null in those contexts.
  if auth.uid() is null then
    return new;
  end if;

  is_agency := public.is_agency_user();

  if is_agency then
    if new.status = 'approved' then
      raise exception
        'POST_PLAN_AGENCY_CANNOT_APPROVE: agency cannot set status=approved; approval is brand-exclusive.'
        using errcode = 'P0001';
    end if;
  else
    if new.status <> 'approved' then
      raise exception
        'POST_PLAN_BRAND_FORBIDDEN_STATUS: brand can only set status=approved (got %).', new.status
        using errcode = 'P0001';
    end if;
    if old.status <> 'needs_review' then
      raise exception
        'POST_PLAN_BRAND_APPROVE_FROM_NEEDS_REVIEW: brand can only approve plans currently in needs_review (was %).', old.status
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger post_plans_guard_status_transitions
  before update of status on public.post_plans
  for each row execute function public.guard_post_plan_status_transitions();
