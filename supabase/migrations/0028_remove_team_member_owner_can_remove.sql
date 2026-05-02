-- =====================================================================
-- L+R Studio — remove_team_member: owners of an account can remove
-- members of that same account
--
-- Bug: the original (0002) and the 0026 patch both gated `remove_team_member`
-- on `public.is_agency_user()` — meaning ONLY agency staff could remove
-- anyone from any team. That blocked brand owners from removing teammates
-- from their own brand workspace. UI showed a Remove button (because the
-- caller is an account owner), the click hit the RPC, the RPC raised
-- "only agency staff can remove team members", and the user was stuck.
--
-- Correct rule (mirrors `change_member_role` from 0002):
--   The caller must be an OWNER of the account they're modifying.
--   That's it — works for both brand and agency accounts uniformly.
--
-- Naturally enforces:
--   - Brand owners can remove members + owners of their brand
--   - Agency owners can remove members + owners of the agency
--   - Members of either kind can't remove anyone
--   - Brand owners can't touch the agency team (not an owner there)
--   - Agency owners can't touch a brand team (not an owner there) —
--     they should manage brand teams via the brand owner, not directly
--
-- The agency `profiles.is_agency` reset logic from 0026 stays — when the
-- last agency membership is removed, the demoted user's `is_agency` flag
-- flips back to false so they don't keep landing in agency mode.
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
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;

  -- Caller must be an owner of the account they're modifying.
  if not exists (
    select 1 from public.account_members
    where account_id = p_account_id
      and user_id = auth.uid()
      and role = 'owner'
  ) then
    raise exception 'only account owners can remove team members';
  end if;

  -- Don't let someone remove themselves — prevents accidental self-lockout.
  -- Owners can demote each other, then leave; or use delete_brand_account
  -- for a full wind-down.
  if p_user_id = auth.uid() then
    raise exception 'use a teammate to remove your own membership';
  end if;

  -- Capture whether the target account is an agency BEFORE the delete so
  -- we know whether to maybe-flip is_agency on the removed user's profile.
  select type = 'agency' into v_was_agency
  from public.accounts where id = p_account_id;

  delete from public.account_members
  where user_id = p_user_id and account_id = p_account_id;

  -- If they just lost an agency membership, check for any remaining agency
  -- memberships. If none left, demote them on the profile so they don't
  -- keep landing in agency mode after joining a brand.
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
