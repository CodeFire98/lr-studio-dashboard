-- =====================================================================
-- L+R Studio — Initial schema, RLS, triggers, and seed.
-- Safe to run on a fresh Supabase project. Not designed to be re-run.
-- =====================================================================

-- Extensions --------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- =====================================================================
-- 1. TABLES
-- =====================================================================

-- Profile: one-to-one extension of auth.users ----------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '',
  initials      text not null default '',
  avatar_url    text,
  avatar_color  text default '#E8553D',
  is_agency     boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Accounts (workspaces): brands + the single agency ---------------------
create table public.accounts (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('brand', 'agency')),
  name          text not null,
  slug          text unique,
  logo_url      text,
  accent_color  text,
  created_at    timestamptz not null default now()
);

-- Only one agency account is allowed.
create unique index accounts_one_agency_idx
  on public.accounts ((true)) where type = 'agency';

-- Account membership ----------------------------------------------------
create table public.account_members (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null check (role in ('owner', 'member')),
  created_at    timestamptz not null default now(),
  unique (account_id, user_id)
);

create index account_members_user_idx on public.account_members(user_id);
create index account_members_account_idx on public.account_members(account_id);

-- Tasks (the core entity, formerly "projects") --------------------------
create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts(id) on delete cascade,
  title             text not null,
  brief_text        text,
  status            text not null default 'brief'
                    check (status in ('brief','progress','review','delivered','revising')),
  deadline          date,
  platform          text,
  format            text,
  objective         text,
  creatives_count   int,
  assigned_lead_id  uuid references public.profiles(id) on delete set null,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  delivered_at      timestamptz
);

create index tasks_account_idx on public.tasks(account_id);
create index tasks_status_idx on public.tasks(status);
create index tasks_created_idx on public.tasks(created_at desc);

-- Messages (comments/chat on a task) ------------------------------------
create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create index messages_task_idx on public.messages(task_id, created_at);

-- Assets (uploaded files tied to a task) --------------------------------
create table public.assets (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id) on delete cascade,
  uploaded_by   uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('reference','deliverable','wip')),
  version       int not null default 1,
  storage_path  text not null,
  filename      text not null,
  mime_type     text,
  size_bytes    bigint,
  thumbnail_url text,
  created_at    timestamptz not null default now()
);

create index assets_task_idx on public.assets(task_id);

-- Activity log ----------------------------------------------------------
create table public.activity (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_task_idx on public.activity(task_id, created_at desc);

-- Brand kit (one per brand account) -------------------------------------
create table public.brand_kits (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null unique references public.accounts(id) on delete cascade,
  primary_color   text,
  secondary_color text,
  logo_url        text,
  fonts           jsonb not null default '{}'::jsonb,
  tone_voice      text,
  "references"    jsonb not null default '[]'::jsonb,
  updated_at      timestamptz not null default now()
);

-- Invitations -----------------------------------------------------------
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('owner','member')),
  invited_by  uuid references public.profiles(id) on delete set null,
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

create index invitations_account_idx on public.invitations(account_id);
create index invitations_email_idx on public.invitations(lower(email));

-- =====================================================================
-- 2. HELPER FUNCTIONS (used by RLS policies)
-- =====================================================================

-- Is the current auth user part of L+R Studio (agency side)?
create or replace function public.is_agency_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_agency = true
  );
$$;

-- Is the current auth user a member of this account?
create or replace function public.is_account_member(p_account_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.account_members
    where account_id = p_account_id and user_id = auth.uid()
  );
$$;

-- Account IDs the current user can see (members + agency sees all).
create or replace function public.accessible_account_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select case when public.is_agency_user()
    then (select id from public.accounts)
    else (
      select account_id from public.account_members where user_id = auth.uid()
    )
  end;
$$;

-- =====================================================================
-- 3. ROW-LEVEL SECURITY
-- =====================================================================

alter table public.profiles        enable row level security;
alter table public.accounts        enable row level security;
alter table public.account_members enable row level security;
alter table public.tasks           enable row level security;
alter table public.messages        enable row level security;
alter table public.assets          enable row level security;
alter table public.activity        enable row level security;
alter table public.brand_kits      enable row level security;
alter table public.invitations     enable row level security;

-- ---- profiles ---------------------------------------------------------
-- Anyone authed can see any profile (names/avatars are cross-visible to collaborators).
create policy profiles_select_authed on public.profiles
  for select to authenticated using (true);
-- Users can update their own row only.
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- INSERT is handled by the auth trigger (security definer) — no user INSERT policy.

-- ---- accounts ---------------------------------------------------------
create policy accounts_select on public.accounts
  for select to authenticated
  using (public.is_agency_user() or id in (select public.accessible_account_ids()));

-- Only agency can create accounts directly. Brand account creation for new signups
-- happens via a SECURITY DEFINER function (see onboarding_bootstrap below) so a
-- new user can bootstrap their first account without having a membership row yet.
create policy accounts_insert_agency on public.accounts
  for insert to authenticated with check (public.is_agency_user());

create policy accounts_update on public.accounts
  for update to authenticated
  using (public.is_agency_user() or id in (select public.accessible_account_ids()))
  with check (public.is_agency_user() or id in (select public.accessible_account_ids()));

-- ---- account_members --------------------------------------------------
create policy account_members_select on public.account_members
  for select to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy account_members_insert_agency on public.account_members
  for insert to authenticated with check (public.is_agency_user());

create policy account_members_delete_agency on public.account_members
  for delete to authenticated using (public.is_agency_user());

-- ---- tasks ------------------------------------------------------------
create policy tasks_select on public.tasks
  for select to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

create policy tasks_update on public.tasks
  for update to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()))
  with check (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy tasks_delete_agency on public.tasks
  for delete to authenticated using (public.is_agency_user());

-- ---- messages ---------------------------------------------------------
create policy messages_select on public.messages
  for select to authenticated
  using (task_id in (select id from public.tasks));   -- tasks RLS filters

create policy messages_insert on public.messages
  for insert to authenticated
  with check (author_id = auth.uid() and task_id in (select id from public.tasks));

create policy messages_update_own on public.messages
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());

create policy messages_delete_own_or_agency on public.messages
  for delete to authenticated using (author_id = auth.uid() or public.is_agency_user());

-- ---- assets -----------------------------------------------------------
create policy assets_select on public.assets
  for select to authenticated
  using (task_id in (select id from public.tasks));

create policy assets_insert on public.assets
  for insert to authenticated
  with check (uploaded_by = auth.uid() and task_id in (select id from public.tasks));

create policy assets_delete_own_or_agency on public.assets
  for delete to authenticated using (uploaded_by = auth.uid() or public.is_agency_user());

-- ---- activity ---------------------------------------------------------
-- Read-only for users; writes come from triggers (SECURITY DEFINER).
create policy activity_select on public.activity
  for select to authenticated
  using (task_id in (select id from public.tasks));

-- ---- brand_kits -------------------------------------------------------
create policy brand_kits_select on public.brand_kits
  for select to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy brand_kits_insert on public.brand_kits
  for insert to authenticated
  with check (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy brand_kits_update on public.brand_kits
  for update to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()))
  with check (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

-- ---- invitations ------------------------------------------------------
create policy invitations_select on public.invitations
  for select to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy invitations_insert on public.invitations
  for insert to authenticated
  with check (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

create policy invitations_delete on public.invitations
  for delete to authenticated
  using (public.is_agency_user() or account_id in (select public.accessible_account_ids()));

-- =====================================================================
-- 4. TRIGGERS
-- =====================================================================

-- 4a. New auth user -> create profile row (with optional agency auto-link).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_display text := coalesce(new.raw_user_meta_data->>'display_name', '');
  v_initials text := upper(substring(
    coalesce(nullif(v_display, ''), new.email) from 1 for 2
  ));
  v_is_agency boolean := coalesce(
    (new.raw_user_meta_data->>'is_agency')::boolean,
    new.email like '%@lr.studio'
      or new.email like '%@linkrunner.io'
      or new.email like '%@linkrunner.com'
  );
  v_agency_id uuid;
begin
  insert into public.profiles (id, display_name, initials, is_agency)
  values (new.id, v_display, v_initials, v_is_agency);

  if v_is_agency then
    select id into v_agency_id from public.accounts where type = 'agency' limit 1;
    if v_agency_id is not null then
      insert into public.account_members (account_id, user_id, role)
      values (v_agency_id, new.id, 'member')
      on conflict do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4b. updated_at auto-bump on tasks.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- 4c. Activity log on task insert + status change + assignment change.
create or replace function public.log_task_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    insert into public.activity (task_id, actor_id, action, payload)
    values (new.id, new.created_by, 'created',
            jsonb_build_object('title', new.title, 'status', new.status));
  elsif (tg_op = 'UPDATE') then
    if new.status is distinct from old.status then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'status_changed',
              jsonb_build_object('from', old.status, 'to', new.status));
      if new.status = 'delivered' and old.status <> 'delivered' then
        new.delivered_at = now();
      end if;
    end if;
    if new.assigned_lead_id is distinct from old.assigned_lead_id then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'assigned',
              jsonb_build_object('from', old.assigned_lead_id, 'to', new.assigned_lead_id));
    end if;
  end if;
  return new;
end;
$$;

create trigger tasks_activity_insert
  after insert on public.tasks
  for each row execute function public.log_task_activity();

create trigger tasks_activity_update
  before update on public.tasks
  for each row execute function public.log_task_activity();

-- 4d. Activity log on new message + new asset.
create or replace function public.log_message_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity (task_id, actor_id, action, payload)
  values (new.task_id, new.author_id, 'comment_posted',
          jsonb_build_object('message_id', new.id, 'preview', left(new.body, 120)));
  return new;
end;
$$;

create trigger messages_activity
  after insert on public.messages
  for each row execute function public.log_message_activity();

create or replace function public.log_asset_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity (task_id, actor_id, action, payload)
  values (new.task_id, new.uploaded_by, 'asset_uploaded',
          jsonb_build_object('asset_id', new.id, 'kind', new.kind, 'filename', new.filename));
  return new;
end;
$$;

create trigger assets_activity
  after insert on public.assets
  for each row execute function public.log_asset_activity();

-- =====================================================================
-- 5. BRAND ONBOARDING (SECURITY DEFINER bootstrap)
-- =====================================================================
-- A brand new user has no account yet, but we want them to create their first
-- brand account and become its owner in a single atomic call. Using a SECURITY
-- DEFINER function so the RLS policies on accounts/members don't block the
-- first-time bootstrap.
create or replace function public.create_brand_account(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_account_id uuid;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'must be signed in';
  end if;

  insert into public.accounts (type, name)
  values ('brand', p_name)
  returning id into v_account_id;

  insert into public.account_members (account_id, user_id, role)
  values (v_account_id, v_user, 'owner');

  insert into public.brand_kits (account_id) values (v_account_id);

  return v_account_id;
end;
$$;

revoke all on function public.create_brand_account(text) from public;
grant execute on function public.create_brand_account(text) to authenticated;

-- =====================================================================
-- 6. STORAGE BUCKETS
-- =====================================================================
-- Note: storage.buckets inserts must be executed; policies on storage.objects
-- are managed via storage.create_policy or raw RLS below.

insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do nothing;

-- Storage RLS: derive access from the owning task. `storage_path` convention:
--   assets/<task_id>/<filename>
create policy "assets bucket read by task members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'assets'
    and (
      public.is_agency_user()
      or (split_part(name, '/', 1))::uuid in (select id from public.tasks)
    )
  );

create policy "assets bucket write by task members" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'assets'
    and (
      public.is_agency_user()
      or (split_part(name, '/', 1))::uuid in (select id from public.tasks)
    )
  );

create policy "brand-assets public read" on storage.objects
  for select to public
  using (bucket_id = 'brand-assets');

create policy "brand-assets write by members" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'brand-assets'
    and (
      public.is_agency_user()
      or (split_part(name, '/', 1))::uuid in (select public.accessible_account_ids())
    )
  );

-- =====================================================================
-- 7. REALTIME PUBLICATION
-- =====================================================================
-- Opt these tables into the supabase_realtime publication so the client
-- can subscribe to inserts/updates.

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.activity;

-- =====================================================================
-- 8. SEED
-- =====================================================================
-- One agency account (the L+R Studio workspace). New @lr.studio signups
-- are auto-linked via the handle_new_user trigger.

insert into public.accounts (type, name, slug, accent_color)
values ('agency', 'L+R Studio', 'lr-studio', '#E8553D')
on conflict do nothing;
