-- =====================================================================
-- 0063_brand_kit_product_images.sql
-- Image-prompting PR 2 — product reference images on the brand kit.
-- =====================================================================
-- Adds a brand-level library of product reference photos. The agency
-- (or a brand member) uploads the real product shots once; the image-
-- prompting route (/api/ai/image) then feeds up to 3 of them to Claude
-- as vision input so generated prompts describe accurate proportions,
-- label text, colour and packaging from what the model actually SEES
-- (golden rules #2/#3/#4 of the Linkrunner Media image-prompting guide).
--
-- Storage: PRIVATE bucket `brand-product-images` (product shots may be
-- pre-launch / unreleased SKUs, so not public like brand-logos). Path
-- scheme <accountId>/<ts>_<filename>. UI renders via signed URLs; the
-- server reads bytes via the service-role client for vision.
--
-- The pointers live in a jsonb array on brand_kits (mirrors the existing
-- `logos` jsonb pattern) — small brand-level set, no per-post linkage,
-- so no dedicated table needed. Each entry:
--   { id, path, filename, mimeType, sizeBytes, addedAt }
-- =====================================================================

alter table public.brand_kits
  add column if not exists product_reference_images jsonb not null default '[]'::jsonb;

comment on column public.brand_kits.product_reference_images is
  'Brand-level product reference photos for AI image prompting. jsonb array of { id, path, filename, mimeType, sizeBytes, addedAt }. Files live in the private storage bucket brand-product-images at <account_id>/<ts>_<filename>; /api/ai/image feeds up to 3 (most recent) to Claude as vision input.';

-- =====================================================================
-- Storage: brand-product-images bucket (private)
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('brand-product-images', 'brand-product-images', false)
on conflict (id) do nothing;

-- Helper: extract <accountId> from path "<accountId>/<ts>_<filename>".
create or replace function public.brand_product_image_account_id(name text)
returns uuid language sql immutable as $$
  select nullif(split_part(name, '/', 1), '')::uuid;
$$;

-- READ — agency or members of the path's account.
create policy "brand-product-images read by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'brand-product-images'
    and (
      public.is_agency_user()
      or public.brand_product_image_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );

-- WRITE/UPDATE/DELETE — agency or members of the path's account (so a
-- brand can curate its own product shots; path-scoped so a member can
-- only touch their own account's objects).
create policy "brand-product-images write by members" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'brand-product-images'
    and (
      public.is_agency_user()
      or public.brand_product_image_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );

create policy "brand-product-images update by members" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'brand-product-images'
    and (
      public.is_agency_user()
      or public.brand_product_image_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  )
  with check (
    bucket_id = 'brand-product-images'
    and (
      public.is_agency_user()
      or public.brand_product_image_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );

create policy "brand-product-images delete by members" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'brand-product-images'
    and (
      public.is_agency_user()
      or public.brand_product_image_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );
