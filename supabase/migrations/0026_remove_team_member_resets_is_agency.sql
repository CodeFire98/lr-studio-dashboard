-- =====================================================================
-- L+R Studio — remove_team_member: reset profiles.is_agency
--
-- Bug: `accept_invitation` (0002) sets `profiles.is_agency = true` when
-- a user joins an agency account, but `remove_team_member` (also 0002)
-- only deletes the `account_members` row — it never flips `is_agency`
-- back. Result: a user removed from the agency keeps `is_agency = true`
-- on their profile, lands in agency mode on next session refresh, and
-- even after accepting a brand invite they still see the agency UI.
--
-- Fix: after the delete, if the removed account was an agency account
-- AND the user has no remaining agency memberships, set
-- `profiles.is_agency = false`.
--
-- Note: there's only one agency in this codebase (`lr-studio`), so the
-- "remaining agency memberships" check effectively just tests "did we
-- just remove their last one." The check is written generally in case
-- a second agency is ever added.
-- =====================================================================

create or replace function public.remove_team_member(
  p_user_id uuid,
  p_account_id uuid
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_was_agency boolean;
  v_still_in_agency boolean;
begin
  if not public.is_agency_user() then
    raise exception 'only agency staff can remove team members';
  end if;
  -- Don't let someone remove themselves (guard against locking out the agency).
  if p_user_id = auth.uid() then
    raise exception 'use a teammate to remove your own membership';
  end if;

  -- Was the account being removed an agency account? Capture before delete
  -- (the account row stays — only the membership row goes).
  select type = 'agency' into v_was_agency
  from public.accounts where id = p_account_id;

  delete from public.account_members
  where user_id = p_user_id and account_id = p_account_id;

  -- If we just removed an agency membership, check whether the user has
  -- any other agency memberships left. If not, demote them on the profile
  -- so they don't keep landing in agency mode after joining a brand.
  if coalesce(v_was_agency, false) then
    select exists(
      select 1
      from public.account_members am
      join public.accounts a on a.id = am.account_id
      where am.user_id = p_user_id and a.type = 'agency'
    ) into v_still_in_agency;

    if not v_still_in_agency then
      update public.profiles set is_agency = false where id = p_user_id;
    end if;
  end if;
end;
$$;

-- ----- One-shot backfill ----------------------------------------------
-- Fix any users whose `profiles.is_agency` is currently true but who no
-- longer have any agency membership (i.e. they were removed via the old
-- `remove_team_member` that didn't reset the flag). Idempotent: re-running
-- this migration is a no-op because already-fixed rows won't match.
update public.profiles p
set is_agency = false
where p.is_agency = true
  and not exists (
    select 1
    from public.account_members am
    join public.accounts a on a.id = am.account_id
    where am.user_id = p.id and a.type = 'agency'
  );
