-- =====================================================================
-- L+R Studio — accept_invitation idempotency fix
--
-- Bug: when a user clicks an invite link, signs in, and the session
-- refresh fires, `auto_accept_pending_invitations()` (added in 0010) can
-- bulk-redeem the invite by email match BEFORE the URL-token redemption
-- code in App.jsx gets to call `accept_invitation(token)`. The original
-- `accept_invitation` from 0002 only matched rows with
-- `accepted_at is null`, so by the time it ran, the invitation looked
-- like it was gone — and it raised "invitation invalid or expired".
--
-- The redemption actually succeeded (the user IS a member of the new
-- account), so the error message was just wrong.
--
-- Fix: look up the invitation regardless of accepted state. If it's
-- already accepted AND the caller is already a member of that account,
-- treat as success and return the account_id (no-op). Only raise
-- "invalid or expired" when the invitation truly doesn't exist or the
-- user isn't a member.
--
-- Also: pull the expiry check out of the WHERE clause so the email-
-- mismatch error fires before the expiry error (better UX — tells the
-- user "you're signed in as the wrong email" instead of vaguely "expired").
-- =====================================================================

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_user_email text;
  v_already_member boolean;
begin
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;

  select email into v_user_email from auth.users where id = auth.uid();

  -- Look up the invitation by token regardless of accepted state, so we
  -- can handle the "already accepted by auto_accept" race idempotently.
  select * into v_invitation
  from public.invitations
  where token = p_token
  limit 1;

  if v_invitation.id is null then
    raise exception 'invitation invalid or expired';
  end if;

  if lower(v_invitation.email) <> lower(v_user_email) then
    raise exception 'invitation is for %, but you are signed in as %',
      v_invitation.email, v_user_email;
  end if;

  -- Idempotency: if the invitation was already accepted AND the caller
  -- is a member of the target account, it's the auto_accept race — treat
  -- as success.
  if v_invitation.accepted_at is not null then
    select exists(
      select 1 from public.account_members
      where account_id = v_invitation.account_id and user_id = auth.uid()
    ) into v_already_member;
    if v_already_member then
      return v_invitation.account_id;
    end if;
    raise exception 'invitation invalid or expired';
  end if;

  -- Expiry only applies to fresh (still-pending) invitations.
  if v_invitation.expires_at <= now() then
    raise exception 'invitation invalid or expired';
  end if;

  insert into public.account_members (account_id, user_id, role)
  values (v_invitation.account_id, auth.uid(), v_invitation.role)
  on conflict (account_id, user_id) do nothing;

  -- If the invite is to the agency account, promote this profile.
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
