-- =====================================================================
-- L+R Studio — Phase 10 migration:
--   1. auto_accept_pending_invitations() RPC
--      Bulk-accepts every unexpired, unaccepted invitation whose email
--      matches the signed-in user's auth email. Returns an array of
--      account_ids the user was just added to (empty array if none).
--      Removes the need to click a per-invite token link — invitees can
--      just sign in with the invited email and membership(s) attach.
--
-- Token-based accept_invitation(token) from 0002 remains untouched so
-- existing invite links keep working.
-- =====================================================================

create or replace function public.auto_accept_pending_invitations()
returns uuid[]
language plpgsql security definer set search_path = public
as $$
declare
  v_user_email text;
  v_joined uuid[] := '{}';
  v_invitation public.invitations%rowtype;
  v_became_agency boolean := false;
begin
  if auth.uid() is null then
    return v_joined;
  end if;

  select email into v_user_email from auth.users where id = auth.uid();
  if v_user_email is null then
    return v_joined;
  end if;

  for v_invitation in
    select *
    from public.invitations
    where lower(email) = lower(v_user_email)
      and accepted_at is null
      and expires_at > now()
  loop
    insert into public.account_members (account_id, user_id, role)
    values (v_invitation.account_id, auth.uid(), v_invitation.role)
    on conflict (account_id, user_id) do nothing;

    update public.invitations set accepted_at = now() where id = v_invitation.id;

    -- Track whether any accepted invite targets an agency account; flip
    -- is_agency once at the end rather than per-row.
    if not v_became_agency and exists (
      select 1 from public.accounts
      where id = v_invitation.account_id and type = 'agency'
    ) then
      v_became_agency := true;
    end if;

    v_joined := array_append(v_joined, v_invitation.account_id);
  end loop;

  if v_became_agency then
    update public.profiles set is_agency = true where id = auth.uid();
  end if;

  return v_joined;
end;
$$;

revoke all on function public.auto_accept_pending_invitations() from public;
grant execute on function public.auto_accept_pending_invitations() to authenticated;
