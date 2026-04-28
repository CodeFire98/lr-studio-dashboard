-- Brand owners couldn't actually delete their own workspace.
--
-- The accounts table has SELECT/INSERT/UPDATE policies but no DELETE
-- policy, so direct client deletes via supabase.from('accounts').delete()
-- silently affected zero rows. The UI didn't check the affected count,
-- signed the user out anyway, and on next login the original brand was
-- still there — looking like the delete did nothing.
--
-- This migration adds a SECURITY DEFINER RPC that performs the delete
-- server-side after enforcing:
--   - the caller is an owner of the account
--   - the account is of type 'brand' (the agency account is never deletable)
--
-- The accounts(id) FK cascades already in place (account_members, tasks,
-- assets, brand_kits, invitations, activity, messages) handle the rest of
-- the cleanup in one shot.

create or replace function public.delete_brand_account(p_account_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_type text;
begin
  if not exists (
    select 1 from public.account_members
    where account_id = p_account_id
      and user_id = auth.uid()
      and role = 'owner'
  ) then
    raise exception 'only the account owner can delete this workspace';
  end if;

  select type into v_type from public.accounts where id = p_account_id;
  if v_type is null then
    raise exception 'account not found';
  end if;
  if v_type = 'agency' then
    raise exception 'agency accounts cannot be deleted';
  end if;

  delete from public.accounts where id = p_account_id;
end;
$$;

grant execute on function public.delete_brand_account(uuid) to authenticated;
