-- =====================================================================
-- L+R Studio — Brand proposals: new-plan creation system message (PR 3)
-- =====================================================================
-- A brand "Propose plan" action lands a row in post_plans with
-- status='proposed' directly. We don't pair it with a plan_proposals
-- row (the plan IS the proposal — payload would just duplicate the
-- plan's own fields). To still get the "Shruti proposed a new post
-- plan." system message in the brand's conversation thread, this
-- migration adds an AFTER INSERT trigger on post_plans that fires
-- only when status='proposed' on insert.
--
-- The existing post_plans status-change trigger from 0047 only fires
-- on UPDATEs — INSERT is a separate code path, hence this trigger.
-- Future edits (PR 4 date drag, PR 5 copy diff) use plan_proposals
-- rows and ride PR 1's existing plan_proposals INSERT trigger.

create or replace function public.emit_post_plan_proposed_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'proposed' then
    perform public.emit_plan_system_message(
      new.account_id,
      new.id,
      new.created_by,
      'proposed a new post plan.'
    );
  end if;
  return new;
end;
$$;

create trigger post_plans_emit_proposed_message
  after insert on public.post_plans
  for each row execute function public.emit_post_plan_proposed_message();
