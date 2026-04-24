-- =====================================================================
-- Clean up the accidental brand account created for agency@linkrunner.io
-- when they accepted an agency invite. The invite flow should have been
-- the only thing assigning their account.
-- =====================================================================
do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id
  from auth.users
  where email = 'agency@linkrunner.io'
  limit 1;

  if v_user_id is null then return; end if;

  -- Delete brand accounts owned by this user (they should only be in the agency).
  delete from public.accounts
  where type = 'brand'
    and id in (
      select a.id
      from public.account_members am
      join public.accounts a on a.id = am.account_id
      where am.user_id = v_user_id
        and a.type = 'brand'
    );
end;
$$;
