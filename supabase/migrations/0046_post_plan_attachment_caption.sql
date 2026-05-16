-- =====================================================================
-- 0046 — Post-plan attachment captions
-- =====================================================================
-- Adds an optional, user-editable caption to post_plan_attachments. Distinct
-- from `filename` (which is the original upload name, used for downloads):
-- the caption is a human-readable label the admin can edit later from the
-- attachment tile or the lightbox preview, so a grid of files reads as
-- "Maya's testimonial frame" / "Hero close-up" / "Backup B-roll" instead of
-- "IMG_2384.jpg" / "FINAL_v3_REAL.mov".
--
-- Nullable + no default — existing rows keep null and the UI falls back
-- to filename when caption is empty. No data migration needed.
--
-- Also fills an RLS gap discovered while shipping captions: post_plan_
-- attachments had SELECT / INSERT / DELETE policies from migration 0021,
-- but no UPDATE policy. With RLS enabled and no policy for an operation,
-- the default is deny — so caption edits were silently failing with
-- PostgREST's "Cannot coerce the result to a single JSON object" error
-- (the UPDATE matched 0 rows, the chained .select().single() then errored).
-- New UPDATE policy mirrors the DELETE policy shape: own row OR agency.
--
-- Idempotent: safe to re-run if you already applied a partial version of
-- this migration (e.g. the ADD COLUMN step ran but you need the policy).
-- =====================================================================

alter table public.post_plan_attachments
  add column if not exists caption text;

comment on column public.post_plan_attachments.caption is
  'Optional human-readable label for the file, editable post-upload. UI falls back to filename when null.';

-- UPDATE policy — uploader can edit their own rows, agency staff can edit
-- any row. Matches the auth shape of post_plan_attachments_delete_own_or_agency.
-- with check uses the same predicate so the post-update row still passes.
drop policy if exists post_plan_attachments_update_own_or_agency on public.post_plan_attachments;
create policy post_plan_attachments_update_own_or_agency on public.post_plan_attachments
  for update to authenticated
  using (uploaded_by = auth.uid() or public.is_agency_user())
  with check (uploaded_by = auth.uid() or public.is_agency_user());
