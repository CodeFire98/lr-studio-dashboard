-- =====================================================================
-- Owner-only team management:
--   1. change_member_role RPC — only agency owners can change roles
--   2. Tighten remove_team_member — only agency owners can remove
-- =====================================================================

-- 1. Change member role (owner-only)
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

  -- Must be an owner of this account to change roles.
  if not exists (
    select 1 from public.account_members
    where account_id = p_account_id
      and user_id = auth.uid()
      and role = 'owner'
  ) then
    raise exception 'only account owners can change member roles';
  end if;

  -- Can't change your own role (prevent accidental lockout).
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role';
  end if;

  update public.account_members
  set role = p_new_role
  where user_id = p_user_id
    and account_id = p_account_id;
end;
$$;

revoke all on function public.change_member_role(uuid, uuid, text) from public;
grant execute on function public.change_member_role(uuid, uuid, text) to authenticated;

-- 2. Tighten remove_team_member to owner-only
create or replace function public.remove_team_member(p_user_id uuid, p_account_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Must be an owner of this account to remove members.
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
