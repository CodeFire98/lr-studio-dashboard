-- =====================================================================
-- 0064_drop_brand_kit_product_images.sql
-- Revert 0063 — the persisted brand-level product-image library.
-- =====================================================================
-- We replaced the persisted approach with EPHEMERAL per-generation
-- reference images: the admin attaches images inline when generating an
-- image prompt (in the post-plan "AI image prompts" panel or LinkAI
-- chat), they ride in the request body for that one call, and nothing is
-- stored. So the 0063 column + bucket are dead weight. They never held
-- data (feature was never shipped to prod), so this drop is safe.
-- =====================================================================

-- Storage policies (removing these makes the bucket inaccessible to all
-- normal roles). NOTE: the empty `brand-product-images` bucket itself
-- cannot be dropped from SQL — Postgres blocks DELETE on storage.buckets
-- via storage.protect_delete(). It's empty and now policy-less (so no
-- role can read/write it), which is harmless; delete it via the Supabase
-- Storage API / dashboard if you want it fully gone.
drop policy if exists "brand-product-images read by members" on storage.objects;
drop policy if exists "brand-product-images write by members" on storage.objects;
drop policy if exists "brand-product-images update by members" on storage.objects;
drop policy if exists "brand-product-images delete by members" on storage.objects;

drop function if exists public.brand_product_image_account_id(text);

alter table public.brand_kits drop column if exists product_reference_images;
