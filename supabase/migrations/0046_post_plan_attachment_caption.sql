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
-- =====================================================================

alter table public.post_plan_attachments
  add column caption text;

comment on column public.post_plan_attachments.caption is
  'Optional human-readable label for the file, editable post-upload. UI falls back to filename when null.';

-- No RLS policy changes needed — the existing post_plan_attachments
-- policies already gate writes on agency/owner, which is the correct
-- scope for caption edits too.
