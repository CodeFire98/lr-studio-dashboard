-- =====================================================================
-- L+R Studio — account_members_with_email RPC
--
-- Surfaces the team-member email next to display name in TeamView and
-- AdminTeamView so we can disambiguate when two people share a name.
--
-- Why an RPC: `auth.users.email` is the only place email lives — the
-- public `profiles` table mirrors auth.users for everything except email
-- (verified 2026-05-02: profiles columns are id, display_name, initials,
-- avatar_url, avatar_color, is_agency, created_at). Reading auth.users
-- requires the service role, which the SPA's anon-key client doesn't
-- have. SECURITY DEFINER lets us read it server-side with an explicit
-- authz gate.
--
-- Authz: caller must be a member of the account, OR be agency staff
-- (matches the access shape `loadTeamForAccount` already implies via
-- RLS on `account_members`).
-- =====================================================================

create or replace function public.account_members_with_email(p_account_id uuid)
returns table(
  member_id uuid,
  user_id uuid,
  role text,
  display_name text,
  initials text,
  avatar_url text,
  avatar_color text,
  is_agency boolean,
  email text,
  joined_at timestamptz
)
language plpgsql security definer set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;

  if not exists(
    select 1 from public.account_members am
    where am.account_id = p_account_id and am.user_id = auth.uid()
  ) and not coalesce(public.is_agency_user(), false) then
    raise exception 'not authorized to view members of this account';
  end if;

  return query
    select
      am.id          as member_id,
      am.user_id     as user_id,
      am.role        as role,
      p.display_name as display_name,
      p.initials     as initials,
      p.avatar_url   as avatar_url,
      p.avatar_color as avatar_color,
      p.is_agency    as is_agency,
      u.email::text  as email,
      am.created_at  as joined_at
    from public.account_members am
    join public.profiles p on p.id = am.user_id
    left join auth.users u on u.id = am.user_id
    where am.account_id = p_account_id
    order by am.created_at;
end;
$$;

revoke all on function public.account_members_with_email(uuid) from public;
grant execute on function public.account_members_with_email(uuid) to authenticated;
