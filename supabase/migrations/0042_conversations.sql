-- =====================================================================
-- L+R Studio — Conversations: unified per-brand chat (PR 1 of 2)
-- =====================================================================
-- Replaces the per-plan post_plan_comments thread with one ongoing chat
-- per brand. The brand sees a single Conversations tab in the sidebar;
-- agency staff see the same chat scoped via BrandPicker. Messages can
-- optionally be tagged to a post plan (renders as a clickable preview
-- card in the bubble) and can be replied to in a Slack-style thread
-- (parent_message_id = the message you're replying to).
--
-- This PR is data-layer only:
--   1. New tables (conversations, conversation_messages,
--      message_attachments, conversation_views) with RLS + realtime.
--   2. One conversation auto-created per brand account.
--   3. Existing post_plan_comments back-filled into conversation_messages
--      with the plan auto-tagged.
--
-- NOTE on the table name `conversation_messages`. The intuitive name
-- `messages` is already taken by the legacy tasks-chat table from
-- migration 0001 (still on disk while the tasks-table cleanup work is
-- pending in §14). Using `conversation_messages` here avoids the
-- collision and reads fine in code; we can revisit a shorter name in
-- the cleanup PR that drops the legacy table.
--
-- The old post_plan_comments table is left in place for rollback safety
-- and dropped in a follow-up after one bake cycle. The detail-view UI
-- gets repointed at the new tables so the user sees no behaviour change.

-- =====================================================================
-- 1. TABLES
-- =====================================================================

-- One conversation per brand account. The unique constraint on
-- account_id is the whole "channels list" — there is no list, every
-- brand has exactly one chat. DMs / multi-channel are deliberately not
-- modelled here (would require dropping the unique + adding a kind/
-- participants table); revisit only if the simple model proves wrong.
create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null unique references public.accounts(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index conversations_account_idx on public.conversations(account_id);

create table public.conversation_messages (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null references public.conversations(id) on delete cascade,
  -- null = top-level message in the channel feed.
  -- non-null = reply inside a Slack-style thread anchored to the parent.
  -- One level of nesting only: replies-to-replies still set
  -- parent_message_id to the thread root, never to a sibling reply.
  parent_message_id    uuid references public.conversation_messages(id) on delete cascade,
  author_id            uuid references public.profiles(id) on delete set null,
  body                 text not null default '',
  -- Optional. When set, renders as a clickable plan preview card inline
  -- with the message. Brand uses this to scope a question to a plan
  -- without leaving the unified chat.
  tagged_post_plan_id  uuid references public.post_plans(id) on delete set null,
  created_at           timestamptz not null default now(),
  edited_at            timestamptz,
  deleted_at           timestamptz
);

-- Hot read paths:
--   * top-level feed for a conversation, newest first
--   * replies for a given thread
--   * "messages tagged to plan X" filter (used by the plan-detail
--     "Discussion" panel after PR 2 ships)
create index conversation_messages_conversation_top_idx
  on public.conversation_messages(conversation_id, created_at desc)
  where parent_message_id is null;

create index conversation_messages_thread_idx
  on public.conversation_messages(parent_message_id, created_at)
  where parent_message_id is not null;

create index conversation_messages_tagged_plan_idx
  on public.conversation_messages(tagged_post_plan_id, created_at)
  where tagged_post_plan_id is not null;

-- Forward-compatible attachments table. Wired up in PR 2/3 when the new
-- chat UI lands; created here so PR 2 doesn't need a schema migration.
-- Mirrors the post_plan_attachments shape (storage_path + uploader),
-- but adds a kind discriminator that includes 'link' for pasted-URL
-- preview cards (no storage path, just the URL + scraped metadata).
create table public.message_attachments (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references public.conversation_messages(id) on delete cascade,
  kind          text not null check (kind in ('image', 'video', 'file', 'link')),
  storage_path  text,           -- null for kind='link'
  url           text,           -- null for kind in ('image','video','file')
  filename      text,
  mime_type     text,
  size_bytes    bigint,
  width         int,            -- media only, optional
  height        int,            -- media only, optional
  uploaded_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index message_attachments_message_idx
  on public.message_attachments(message_id);

-- Per-(user, conversation) "last seen" stamp powering the sidebar
-- Conversations badge. A message is "unread" for user U if either
-- there's no view row for (U, conv), or the message's created_at >
-- view.last_seen_at, AND the message author is not U.
--
-- Mirrors the post_plan_views pattern from migration 0022 — same shape
-- so the App-level unread plumbing in App.jsx can be reused almost
-- verbatim against this table.
create table public.conversation_views (
  user_id          uuid not null references public.profiles(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  last_seen_at     timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

-- =====================================================================
-- 2. ROW-LEVEL SECURITY
-- =====================================================================

alter table public.conversations          enable row level security;
alter table public.conversation_messages  enable row level security;
alter table public.message_attachments    enable row level security;
alter table public.conversation_views     enable row level security;

-- ---- conversations --------------------------------------------------
-- Read iff agency OR member of the conversation's account. No client
-- INSERT — service-role provisions one per brand (this migration does
-- the initial backfill; the trigger at the bottom handles new brand
-- accounts). UPDATE/DELETE blocked from clients.

create policy conversations_select on public.conversations
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

-- ---- conversation_messages -----------------------------------------
-- SELECT mirrors conversations: visible iff you can see the parent
-- conversation. INSERT requires self-author + visible conversation.
-- (We don't cross-check that parent_message_id lives in the same
-- conversation — the UI always derives parent from the current
-- conversation, and a mis-pointed reply would just orphan itself in
-- the rendering layer rather than leak. RLS recursion would be the
-- only way to enforce it and the safety win isn't worth the risk.)
-- UPDATE/DELETE limited to own messages or agency.

create policy conversation_messages_select on public.conversation_messages
  for select to authenticated
  using (conversation_id in (select id from public.conversations));

create policy conversation_messages_insert on public.conversation_messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and conversation_id in (select id from public.conversations)
  );

create policy conversation_messages_update_own on public.conversation_messages
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy conversation_messages_delete_own_or_agency on public.conversation_messages
  for delete to authenticated
  using (author_id = auth.uid() or public.is_agency_user());

-- ---- message_attachments -------------------------------------------
-- Visible iff parent message is visible. Insert requires self-uploader
-- + visible parent message. Delete limited to uploader or agency.

create policy message_attachments_select on public.message_attachments
  for select to authenticated
  using (message_id in (select id from public.conversation_messages));

create policy message_attachments_insert on public.message_attachments
  for insert to authenticated
  with check (
    (uploaded_by = auth.uid() or uploaded_by is null)
    and message_id in (select id from public.conversation_messages)
  );

create policy message_attachments_delete_own_or_agency on public.message_attachments
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_agency_user());

-- ---- conversation_views --------------------------------------------
-- Each user only ever sees / writes their own view rows.

create policy cv_select_own on public.conversation_views
  for select to authenticated using (user_id = auth.uid());
create policy cv_insert_own on public.conversation_views
  for insert to authenticated with check (user_id = auth.uid());
create policy cv_update_own on public.conversation_views
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- 3. REALTIME
-- =====================================================================

alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.conversation_messages;
alter publication supabase_realtime add table public.message_attachments;

-- =====================================================================
-- 4. BACKFILL — one conversation per brand + comments → messages
-- =====================================================================

-- 4a. One conversation row per brand account.
insert into public.conversations (account_id)
select a.id
from public.accounts a
where a.type = 'brand'
  and not exists (
    select 1 from public.conversations c where c.account_id = a.id
  );

-- 4b. Copy every existing post_plan_comments row into
-- conversation_messages, with conversation = the comment's plan's brand
-- conversation, plan auto-tagged so the new "Discussion" panel (PR 2)
-- shows them filtered. created_at preserved so chronological ordering
-- survives the move.
insert into public.conversation_messages (
  conversation_id,
  parent_message_id,
  author_id,
  body,
  tagged_post_plan_id,
  created_at
)
select
  c.id            as conversation_id,
  null            as parent_message_id,
  pc.author_id,
  pc.body,
  pc.post_plan_id as tagged_post_plan_id,
  pc.created_at
from public.post_plan_comments pc
join public.post_plans pp   on pp.id = pc.post_plan_id
join public.conversations c on c.account_id = pp.account_id;

-- =====================================================================
-- 5. AUTO-PROVISION CONVERSATION FOR NEW BRAND ACCOUNTS
-- =====================================================================
-- Brands created after this migration need a conversation row too.
-- Trigger fires on accounts INSERT with type='brand' and is idempotent
-- via the unique(account_id) constraint on conversations.

create or replace function public.ensure_brand_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type = 'brand' then
    insert into public.conversations (account_id)
    values (new.id)
    on conflict (account_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger accounts_ensure_brand_conversation
  after insert on public.accounts
  for each row execute function public.ensure_brand_conversation();
