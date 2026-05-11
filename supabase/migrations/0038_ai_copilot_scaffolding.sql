-- =====================================================================
-- L+R Studio — AI Co-pilot scaffolding (PR 1 of the AI-native phase)
-- =====================================================================
-- Pure additive migration laying foundations for the agency-side AI
-- Co-pilot. Nothing in the app reads these yet — the schema lands first,
-- the Vercel /api/ai/* route and the sidebar Co-pilot panel land in
-- follow-up PRs gated behind a brand-id whitelist env var.
--
-- Two pieces:
--
--   1. brand_kit_notes
--      Free-form admin annotations that don't fit the structured columns
--      on brand_kits. These are the "remember that the founder hates the
--      word 'authentic'" / "no holiday content until Oct 15" facts the
--      agency admin will accumulate over time, written either by hand
--      from the BrandKit UI (later) or by the Co-pilot itself when the
--      admin says "remember that …". The compiled brand-context blob we
--      send to Claude as a cached system prompt reads from this table
--      alongside brand_kits.
--
--      `is_pinned = true` rows are "always-true" facts the model should
--      see on every call. Non-pinned rows are recent context that decays
--      out of the window once we cap how many we inject (~20 most recent).
--
--      RLS mirrors post_plan_ideas / post_plans: agency staff or members
--      of the account can read and write. created_by is set null on
--      profile delete so notes survive staff turnover. Cascade on
--      account_id matches every other brand-scoped table.
--
--   2. post_plans.ai_generated + ai_draft_payload
--      Marks plans the AI Co-pilot proposed. The admin still owns the
--      row — they edit it in PostPlanDetailView and submit for review
--      through the existing workflow. The pill is purely informational
--      ("✨ AI draft") so the agency can tell at a glance which plans
--      came from a human idea vs an AI proposal.
--
--      ai_draft_payload stores the original tool-call arguments so we
--      can diff "what the AI proposed" vs "what the admin shipped" later
--      — useful both for telemetry (which proposals get accepted as-is
--      vs heavily edited) and for letting the admin "reset to AI draft"
--      if they over-edit and want to start over.
--
-- Defaults: ai_generated = false, ai_draft_payload = '{}'::jsonb. Every
-- existing post_plans row is back-compatible — nothing in prod reads
-- these columns until PR 2 lands.

-- =====================================================================
-- 1. brand_kit_notes
-- =====================================================================

create table public.brand_kit_notes (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  body        text not null,
  is_pinned   boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index brand_kit_notes_account_idx
  on public.brand_kit_notes(account_id, is_pinned desc, created_at desc);

alter table public.brand_kit_notes enable row level security;

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

create trigger brand_kit_notes_touch_updated_at
  before update on public.brand_kit_notes
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.brand_kit_notes;

-- =====================================================================
-- 2. post_plans AI columns
-- =====================================================================

alter table public.post_plans
  add column if not exists ai_generated     boolean not null default false,
  add column if not exists ai_draft_payload jsonb   not null default '{}'::jsonb;

-- Partial index — only useful for the (eventually) "show me AI drafts I
-- haven't reviewed yet" query path. Keeps the index small since the vast
-- majority of rows will be ai_generated = false.
create index if not exists post_plans_ai_generated_idx
  on public.post_plans(account_id, created_at desc)
  where ai_generated = true;
