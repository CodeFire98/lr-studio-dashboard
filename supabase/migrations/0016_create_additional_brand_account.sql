-- =====================================================================
-- L+R Studio — Allow brand owners to create additional brand workspaces.
-- create_brand_account is idempotent (returns existing brand if any) so
-- it can't be used to spin up a second brand. This RPC always creates a
-- fresh brand + brand_kit row and makes the caller its owner.
-- =====================================================================

create or replace function public.create_additional_brand_account(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_account_id uuid;
  v_user uuid := auth.uid();
  v_name text := nullif(btrim(p_name), '');
begin
  if v_user is null then
    raise exception 'must be signed in';
  end if;
  if v_name is null then
    raise exception 'brand name is required';
  end if;

  -- Agency users manage brands via the agency relationship, not by owning
  -- their own brand workspace. Block them from this path explicitly so a
  -- misfired UI button can't pollute their account.
  if exists (
    select 1
    from public.profiles p
    where p.id = v_user and p.is_agency = true
  ) then
    raise exception 'agency users cannot create brand workspaces';
  end if;

  insert into public.accounts (type, name)
  values ('brand', v_name)
  returning id into v_account_id;

  insert into public.account_members (account_id, user_id, role)
  values (v_account_id, v_user, 'owner');

  insert into public.brand_kits (account_id) values (v_account_id);

  return v_account_id;
end;
$$;

revoke all on function public.create_additional_brand_account(text) from public;
grant execute on function public.create_additional_brand_account(text) to authenticated;
