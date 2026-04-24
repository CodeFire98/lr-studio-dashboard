-- =====================================================================
-- L+R Studio — Phase 5 hardening:
--   1. handle_new_user: remove domain-whitelist auto-agency + client-
--      controllable is_agency metadata. Agency membership now REQUIRES
--      a valid invitation redeemed via accept_invitation.
--   2. New: preview_invitation(token) — anon-callable, returns the invited
--      email + account type so the login UI can pre-fill + lock the field.
--   3. Tighten asset delete RLS: only the side that uploaded can delete.
--      Brand users can delete 'reference' assets; agency users can delete
--      'deliverable' / 'wip' assets. Cross-side delete is forbidden.
-- Safe to run on top of 0002.
-- =====================================================================

-- ----- 1. Tighter handle_new_user --------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_display  text := coalesce(new.raw_user_meta_data->>'display_name', '');
  v_initials text := upper(substring(
    coalesce(nullif(v_display, ''), new.email) from 1 for 2
  ));
begin
  -- Every new auth user gets a profile with is_agency = false by default.
  -- Agency membership is granted only through accept_invitation (which
  -- flips is_agency = true when redeeming an invite to the agency account)
  -- or by manual promotion in the Supabase dashboard.
  insert into public.profiles (id, display_name, initials, is_agency)
  values (new.id, v_display, v_initials, false);
  return new;
end;
$$;

-- The trigger itself (on_auth_user_created) was already created in 0001 —
-- replacing the function body above is enough.

-- ----- 2. preview_invitation (anon-safe) -------------------------------
create or replace function public.preview_invitation(p_token text)
returns table (
  email        text,
  role         text,
  account_name text,
  account_type text
)
language sql security definer set search_path = public
as $$
  select
    i.email,
    i.role,
    a.name as account_name,
    a.type as account_type
  from public.invitations i
  join public.accounts a on a.id = i.account_id
  where i.token = p_token
    and i.accepted_at is null
    and i.expires_at > now()
  limit 1;
$$;

revoke all on function public.preview_invitation(text) from public;
grant execute on function public.preview_invitation(text) to anon, authenticated;

-- ----- 3. Side-based asset delete RLS ----------------------------------
drop policy if exists assets_delete_own_or_agency on public.assets;

create policy assets_delete_by_side on public.assets
  for delete to authenticated
  using (
    (kind in ('deliverable', 'wip') and public.is_agency_user()
      and task_id in (select id from public.tasks))
    or
    (kind = 'reference' and not public.is_agency_user()
      and task_id in (select id from public.tasks))
  );
