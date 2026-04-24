-- =====================================================================
-- Allow brand account owners to manage their team (not just agency owners).
-- Updates remove_team_member and change_member_role to check if the caller
-- is an owner of the specified account (works for both brand and agency).
-- =====================================================================

-- 1. Update remove_team_member: allow any account owner (brand or agency)
create or replace function public.remove_team_member(p_user_id uuid, p_account_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.account_members
    where account_id = p_account_id
      and user_id = auth.uid()
      and role = 'owner'
  ) then
    raise exception 'only account owners can remove team members';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'use a teammate to remove your own membership';
  end if;

  delete from public.account_members
  where user_id = p_user_id and account_id = p_account_id;
end;
$$;

-- 2. Update change_member_role: allow any account owner (brand or agency)
create or replace function public.change_member_role(
  p_user_id uuid,
  p_account_id uuid,
  p_new_role text
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_new_role not in ('owner', 'member') then
    raise exception 'invalid role: %', p_new_role;
  end if;

  if not exists (
    select 1 from public.account_members
    where account_id = p_account_id
      and user_id = auth.uid()
      and role = 'owner'
  ) then
    raise exception 'only account owners can change member roles';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role';
  end if;

  update public.account_members
  set role = p_new_role
  where user_id = p_user_id
    and account_id = p_account_id;
end;
$$;
