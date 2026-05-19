-- =====================================================================
-- 0052_brand_kit_notes_open_to_brand.sql
-- Revert 0040's agency-only tighten. Brand users can now SELECT /
-- INSERT / UPDATE / DELETE notes for their own brand again.
-- =====================================================================
--
-- Context — 0040 (2026-05-12) tightened brand_kit_notes to agency-only.
-- The thinking then was that notes contained internal agency planning
-- ("the founder hates the word 'authentic'", voice criticisms, etc.)
-- that shouldn't be brand-visible.
--
-- Brand-side AI Phase 2 (this PR, 2026-05-19) flips that. The user
-- explicitly opted to surface brand notes to the brand too: "we can
-- open up brand notes to brand-view as well, not keep it gated to
-- agency only; I think this opens up a lot of constraints." So:
--
--   * Brand teammates SELECT / INSERT / UPDATE / DELETE notes for
--     their own brand (account_id in accessible_account_ids()).
--   * Agency staff retain full access (is_agency_user()).
--   * The AI Co-pilot tool `write_brand_note` also works for brand
--     callers now — they can curate their own brand's memory layer
--     via the chat.
--
-- The frontend BrandNotesView gating that was agency-only also needs
-- to relax in the same PR; this migration alone surfaces the rows,
-- but the read/write UI still has to be wired for brand visibility.

drop policy if exists brand_kit_notes_select on public.brand_kit_notes;
drop policy if exists brand_kit_notes_insert on public.brand_kit_notes;
drop policy if exists brand_kit_notes_update on public.brand_kit_notes;
drop policy if exists brand_kit_notes_delete on public.brand_kit_notes;

create policy brand_kit_notes_select on public.brand_kit_notes
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy brand_kit_notes_insert on public.brand_kit_notes
  for insert to authenticated
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy brand_kit_notes_update on public.brand_kit_notes
  for update to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  )
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy brand_kit_notes_delete on public.brand_kit_notes
  for delete to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );
