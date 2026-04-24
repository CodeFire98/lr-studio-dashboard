-- =====================================================================
-- L+R Studio — Fix duplicate brand accounts:
--   1. Make create_brand_account idempotent (skip if user already owns one)
--   2. Clean up duplicate brand accounts for tools@linkrunner.io
-- =====================================================================

-- ----- 1. Idempotent create_brand_account --------------------------------
create or replace function public.create_brand_account(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_account_id uuid;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'must be signed in';
  end if;

  -- If the user already owns a brand account, return it instead of creating a new one.
  select a.id into v_account_id
  from public.account_members am
  join public.accounts a on a.id = am.account_id
  where am.user_id = v_user
    and a.type = 'brand'
  limit 1;

  if v_account_id is not null then
    return v_account_id;
  end if;

  insert into public.accounts (type, name)
  values ('brand', p_name)
  returning id into v_account_id;

  insert into public.account_members (account_id, user_id, role)
  values (v_account_id, v_user, 'owner');

  insert into public.brand_kits (account_id) values (v_account_id);

  return v_account_id;
end;
$$;

-- ----- 2. Clean up duplicate accounts for tools@linkrunner.io -----------
-- Keep only the oldest brand account for this user, delete the rest.
-- This deletes the accounts + cascades to account_members and brand_kits.
do $$
declare
  v_user_id uuid;
  v_keep_account_id uuid;
begin
  select id into v_user_id
  from auth.users
  where email = 'tools@linkrunner.io'
  limit 1;

  if v_user_id is null then
    return;
  end if;

  -- Find the oldest brand account this user owns (the one to keep).
  select a.id into v_keep_account_id
  from public.account_members am
  join public.accounts a on a.id = am.account_id
  where am.user_id = v_user_id
    and a.type = 'brand'
  order by a.created_at asc
  limit 1;

  -- Delete all other brand accounts owned by this user.
  delete from public.accounts
  where id in (
    select a.id
    from public.account_members am
    join public.accounts a on a.id = am.account_id
    where am.user_id = v_user_id
      and a.type = 'brand'
      and a.id != v_keep_account_id
  );
end;
$$;
