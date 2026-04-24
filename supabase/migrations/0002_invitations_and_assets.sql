-- =====================================================================
-- L+R Studio — Phase 5 migration:
--   1. accept_invitation(token) RPC — atomic token consumption
--   2. remove_team_member(user_id, account_id) RPC — agency-only removal
--   3. Realtime opt-in for assets table
--   4. Ensures `invitations` + `assets` are in the realtime publication
-- Safe to run on top of 0001_initial.sql.
-- =====================================================================

-- ----- 1. accept_invitation ---------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_user_email text;
begin
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;

  select email into v_user_email from auth.users where id = auth.uid();

  select * into v_invitation
  from public.invitations
  where token = p_token
    and accepted_at is null
    and expires_at > now()
  limit 1;

  if v_invitation.id is null then
    raise exception 'invitation invalid or expired';
  end if;

  if lower(v_invitation.email) <> lower(v_user_email) then
    raise exception 'invitation is for %, but you are signed in as %',
      v_invitation.email, v_user_email;
  end if;

  insert into public.account_members (account_id, user_id, role)
  values (v_invitation.account_id, auth.uid(), v_invitation.role)
  on conflict (account_id, user_id) do nothing;

  -- If the invite is to the agency account, promote this profile to is_agency.
  update public.profiles set is_agency = true
  where id = auth.uid()
    and exists (
      select 1 from public.accounts
      where id = v_invitation.account_id and type = 'agency'
    );

  update public.invitations set accepted_at = now() where id = v_invitation.id;

  return v_invitation.account_id;
end;
$$;

revoke all on function public.accept_invitation(text) from public;
grant execute on function public.accept_invitation(text) to authenticated;

-- ----- 2. remove_team_member --------------------------------------------
create or replace function public.remove_team_member(p_user_id uuid, p_account_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_agency_user() then
    raise exception 'only agency staff can remove team members';
  end if;
  -- Don't let someone remove themselves (guard against locking out the agency).
  if p_user_id = auth.uid() then
    raise exception 'use a teammate to remove your own membership';
  end if;
  delete from public.account_members
  where user_id = p_user_id and account_id = p_account_id;
end;
$$;

revoke all on function public.remove_team_member(uuid, uuid) from public;
grant execute on function public.remove_team_member(uuid, uuid) to authenticated;

-- ----- 3. Realtime for assets + invitations ----------------------------
-- Add (or move to add_if_not_exists semantics) the two tables to the
-- supabase_realtime publication. Wrap in a DO block so re-running this
-- file on a project that already had the tables added doesn't error.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'assets'
  ) then
    execute 'alter publication supabase_realtime add table public.assets';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'invitations'
  ) then
    execute 'alter publication supabase_realtime add table public.invitations';
  end if;
end$$;
