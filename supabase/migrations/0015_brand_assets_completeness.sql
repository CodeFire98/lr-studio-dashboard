-- =====================================================================
-- L+R Studio — Phase 15 migration:
--   The brand-assets bucket already exists (created in 0001) with public
--   read + member write policies, but it has no UPDATE or DELETE policy
--   so users can upload references for the agency to see — and never get
--   rid of them. Add the missing two policies so brand owners and agency
--   staff can prune their reference library.
--
--   Path scheme (mirrors brand-logos): '<accountId>/<timestamp>_<file>'.
--   Authorisation: agency users OR an owner of the matching account.
-- =====================================================================

create or replace function public.brand_asset_account_id(p_name text)
returns uuid
language plpgsql immutable
as $$
declare v uuid;
begin
  begin
    v := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return null;
  end;
  return v;
end;
$$;

drop policy if exists "brand_assets_owner_update" on storage.objects;
create policy "brand_assets_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'brand-assets'
    and (
      public.is_agency_user()
      or exists (
        select 1 from public.account_members am
        where am.user_id = auth.uid()
          and am.role = 'owner'
          and am.account_id = public.brand_asset_account_id(name)
      )
    )
  );

drop policy if exists "brand_assets_owner_delete" on storage.objects;
create policy "brand_assets_owner_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'brand-assets'
    and (
      public.is_agency_user()
      or exists (
        select 1 from public.account_members am
        where am.user_id = auth.uid()
          and am.role = 'owner'
          and am.account_id = public.brand_asset_account_id(name)
      )
    )
  );
