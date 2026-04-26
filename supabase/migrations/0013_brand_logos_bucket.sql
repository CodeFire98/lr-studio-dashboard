-- =====================================================================
-- L+R Studio — Phase 13 migration:
--   Public storage bucket for brand logos + RLS policies on storage.objects.
--
--   Bucket: 'brand-logos' (public-read so <img> can render the URL directly
--   without signed URLs — logos appear all over the app).
--
--   Path scheme: '<accountId>/<timestamp>_<filename>'. The first path
--   segment is the brand account UUID, which is what the write policies
--   use to authorise uploads / overwrites / deletes.
--
--   Authorisation:
--     - Public read for everyone (incl. anon visitors loading <img>).
--     - Insert / Update / Delete: agency users OR brand owners of the
--       account whose UUID is the first path segment.
-- =====================================================================

-- 1. Create the bucket (idempotent).
insert into storage.buckets (id, name, public)
values ('brand-logos', 'brand-logos', true)
on conflict (id) do update set public = excluded.public;

-- 2. Helper: extract the first path segment (account UUID) and verify it.
-- Wrapped so policy expressions stay readable. Returns NULL on any parse
-- failure rather than raising, so a malformed path simply fails the check.
create or replace function public.brand_logo_account_id(p_name text)
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

-- 3. RLS policies on storage.objects scoped to this bucket.
-- We don't enable RLS on storage.objects (Supabase manages that), but our
-- policies are additive — the public bucket grants read by default.

drop policy if exists "brand_logos_public_read" on storage.objects;
create policy "brand_logos_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'brand-logos');

drop policy if exists "brand_logos_owner_write" on storage.objects;
create policy "brand_logos_owner_write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'brand-logos'
    and (
      public.is_agency_user()
      or exists (
        select 1 from public.account_members am
        where am.user_id = auth.uid()
          and am.role = 'owner'
          and am.account_id = public.brand_logo_account_id(name)
      )
    )
  );

drop policy if exists "brand_logos_owner_update" on storage.objects;
create policy "brand_logos_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'brand-logos'
    and (
      public.is_agency_user()
      or exists (
        select 1 from public.account_members am
        where am.user_id = auth.uid()
          and am.role = 'owner'
          and am.account_id = public.brand_logo_account_id(name)
      )
    )
  );

drop policy if exists "brand_logos_owner_delete" on storage.objects;
create policy "brand_logos_owner_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'brand-logos'
    and (
      public.is_agency_user()
      or exists (
        select 1 from public.account_members am
        where am.user_id = auth.uid()
          and am.role = 'owner'
          and am.account_id = public.brand_logo_account_id(name)
      )
    )
  );
