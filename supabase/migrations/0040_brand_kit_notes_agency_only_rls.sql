-- =====================================================================
-- 0040_brand_kit_notes_agency_only_rls.sql
-- Tighten brand_kit_notes RLS: agency staff ONLY (was: agency staff OR
-- account members).
-- =====================================================================
--
-- Context — the brand_kit_notes table was introduced in migration 0039
-- as the AI Co-pilot's long-term memory layer for each brand. The
-- original policies allowed both `is_agency_user()` AND account
-- members (`accessible_account_ids()`) to read / write rows — that
-- mirrored the post_plan_ideas / post_plans pattern at the time.
--
-- Why we're tightening (Phase 3 brand-notes restructure, 2026-05-12):
--
-- Brand notes are a "thinking-out-loud" surface for the agency. They
-- contain raw memory dumps like "the founder's wife hates the word
-- 'authentic'", "Q3 launch is the new bamboo onesie line", "no
-- holiday content before Oct 15". This is internal agency context,
-- NOT customer-facing content. Brand users shouldn't see the raw
-- memory dump — it would expose internal planning, voice criticisms,
-- and other content that's meant to inform the AI but not be
-- consumed by the brand directly.
--
-- The frontend in this same PR also stops rendering the notes UI for
-- non-agency users (defense in depth), but RLS is the real enforcement
-- — direct PostgREST hits with a brand-user JWT will return 0 rows
-- (not 403; that's the standard RLS behaviour) after this migration.
--
-- Safe to deploy: only the agency staff are using this table today
-- (no brand users have written notes via the Co-pilot — that surface
-- is agency-gated already, and the BrandNotesSection write affordances
-- were already disabled for non-agency users). The change only
-- HIDES existing rows from non-agency users; nothing breaks for the
-- intended (agency) callers.
--
-- Rollback (if needed):
--   drop policy brand_kit_notes_select on public.brand_kit_notes;
--   drop policy brand_kit_notes_insert on public.brand_kit_notes;
--   drop policy brand_kit_notes_update on public.brand_kit_notes;
--   drop policy brand_kit_notes_delete on public.brand_kit_notes;
--   create policy brand_kit_notes_select on public.brand_kit_notes
--     for select to authenticated
--     using (
--       public.is_agency_user()
--       or account_id in (select public.accessible_account_ids())
--     );
--   -- (repeat for insert / update / delete with the same predicate)
-- =====================================================================

-- Drop the existing 4 policies (member-or-agency).
drop policy if exists brand_kit_notes_select on public.brand_kit_notes;
drop policy if exists brand_kit_notes_insert on public.brand_kit_notes;
drop policy if exists brand_kit_notes_update on public.brand_kit_notes;
drop policy if exists brand_kit_notes_delete on public.brand_kit_notes;

-- Recreate as agency-only on all four operations. Agency staff is
-- defined by the existing `public.is_agency_user()` helper (reads
-- profiles.is_agency for the current auth.uid()).
create policy brand_kit_notes_select on public.brand_kit_notes
  for select to authenticated
  using (public.is_agency_user());

create policy brand_kit_notes_insert on public.brand_kit_notes
  for insert to authenticated
  with check (public.is_agency_user());

create policy brand_kit_notes_update on public.brand_kit_notes
  for update to authenticated
  using (public.is_agency_user())
  with check (public.is_agency_user());

create policy brand_kit_notes_delete on public.brand_kit_notes
  for delete to authenticated
  using (public.is_agency_user());

-- Realtime publication unchanged — the realtime stream itself is gated
-- by RLS, so non-agency users subscribed to the channel will see no
-- payloads after this migration (and shouldn't have been subscribed
-- in the first place; the frontend gating removes that surface).
