-- =====================================================================
-- 0055 — Conversations log: "marked as posted" event
-- =====================================================================
-- Existing triggers in 0047 cover status transitions and proposals, but
-- nothing fires when a plan is marked as posted (a row lands in
-- post_plan_publications). Add a trigger that emits one system message
-- per "marked as posted" user action — even when the action spans
-- multiple platforms (one INSERT per platform inside the same modal
-- submit).
--
-- Strategy: AFTER INSERT row-level trigger that DEDUPES against any
-- recent "marked this as posted on …" message for the same plan + same
-- author within a 30-second window. If found, UPDATE that message's
-- body to append the new platform. If not, INSERT a fresh message.
--
-- 30s is the right window because:
--   - handleMarkPostedSubmit in PostPlanDetailView.jsx loops over
--     platforms one at a time (typical end-to-end well under 30s).
--   - Two genuinely separate user actions (e.g. mark IG today, mark
--     LinkedIn next week) deserve separate log entries, and 30s is
--     plenty of buffer between "one modal submit" and "another visit".
--
-- Format:
--   1 platform:  "marked this as posted on Instagram."
--   2 platforms: "marked this as posted on Instagram, LinkedIn."
--   3 platforms: "marked this as posted on Instagram, LinkedIn, X."
--
-- Comma-separated (no "and") because the trigger can't know in advance
-- how many platforms will arrive in this window, and rewriting the
-- entire phrase on every append would be fragile. Commas read fine.
--
-- The renderer in ConversationsView.jsx prefixes the body with the
-- actor's display name, so the user sees e.g.:
--   "Lakshith marked this as posted on Instagram, LinkedIn."

create or replace function public.emit_post_plan_publication_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_id          uuid;
  plan_account_id  uuid;
  platform_label   text;
  existing_msg_id  uuid;
  existing_body    text;
  new_body         text;
begin
  -- Map raw platform tokens to display-cased labels.
  platform_label := case new.platform
    when 'instagram' then 'Instagram'
    when 'linkedin'  then 'LinkedIn'
    when 'x'         then 'X'
    else initcap(new.platform)
  end;

  -- post_plan_publications doesn't store account_id directly — resolve
  -- via the parent post_plans row.
  select account_id into plan_account_id
    from public.post_plans
   where id = new.post_plan_id;
  if plan_account_id is null then
    return new;
  end if;

  -- Locate the brand's conversation thread. Bail silently if none
  -- exists (same pattern as emit_plan_system_message in 0047).
  select id into conv_id
    from public.conversations
   where account_id = plan_account_id;
  if conv_id is null then
    return new;
  end if;

  -- Dedupe window: look for a "marked this as posted on …" message for
  -- this plan + this author within the last 30 seconds.
  select id, body
    into existing_msg_id, existing_body
    from public.conversation_messages
   where tagged_post_plan_id = new.post_plan_id
     and author_id = new.published_by
     and kind = 'system'
     and body like 'marked this as posted on %'
     and created_at > now() - interval '30 seconds'
   order by created_at desc
   limit 1;

  if existing_msg_id is not null then
    -- Append the new platform. Guard against double-appends in the
    -- rare case the same platform fires twice (shouldn't happen due
    -- to the unique constraint on (post_plan_id, platform), but a
    -- defensive check costs nothing).
    if position(platform_label in existing_body) > 0 then
      return new;
    end if;
    -- Strip the trailing period, append ", <Platform>.", reattach.
    new_body := regexp_replace(existing_body, '\.$', '') || ', ' || platform_label || '.';
    update public.conversation_messages
       set body = new_body,
           edited_at = now()
     where id = existing_msg_id;
  else
    -- Fresh entry for this action window.
    new_body := 'marked this as posted on ' || platform_label || '.';
    insert into public.conversation_messages
      (conversation_id, author_id, body, tagged_post_plan_id, kind)
    values
      (conv_id, new.published_by, new_body, new.post_plan_id, 'system');
  end if;

  return new;
end;
$$;

create trigger post_plan_publications_emit_posted_message
  after insert on public.post_plan_publications
  for each row execute function public.emit_post_plan_publication_message();

-- Note: we deliberately do NOT fire on UPDATE (e.g. when a user pastes
-- a live_url onto an already-marked-posted row) or DELETE (when a user
-- unchecks a platform in the modal). Those are edits to the live-post
-- record, not "marking posted" actions, and noising up the log with
-- them was explicitly out of scope for this PR.
