-- =====================================================================
-- L+R Studio — Conversations: decouple tagged_post_plan_id from the FK
-- =====================================================================
-- Migration 0042 wired `conversation_messages.tagged_post_plan_id` as
-- a foreign key with `ON DELETE SET NULL`. That gave us cascade safety
-- but stripped the "this message was about plan X" signal the moment
-- the plan was deleted — leaving a tagged message indistinguishable
-- from an untagged one.
--
-- This migration drops the FK constraint but keeps the column. After
-- a plan is deleted, the id lingers on the message; the client can
-- detect "plan no longer in this brand's loaded plans" and render a
-- "Plan deleted" tombstone chip inside the bubble. No data is lost,
-- no rows need rewriting. The downside (no referential integrity on
-- this column) is intentional — the column behaves more like a tag
-- than a hard reference.

alter table public.conversation_messages
  drop constraint if exists conversation_messages_tagged_post_plan_id_fkey;
