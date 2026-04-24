-- =====================================================================
-- Fix display_name for Google OAuth users.
-- Google sets full_name/name in raw_user_meta_data, not display_name.
-- =====================================================================

-- 1. Update handle_new_user to check all possible name fields.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_display  text := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    ''
  );
  v_initials text := upper(substring(
    coalesce(nullif(v_display, ''), new.email) from 1 for 2
  ));
begin
  insert into public.profiles (id, display_name, initials, is_agency)
  values (new.id, v_display, v_initials, false);
  return new;
end;
$$;

-- 2. Backfill: fix existing profiles that have empty display_name
--    by pulling the name from auth.users metadata.
update public.profiles p
set
  display_name = coalesce(
    nullif(u.raw_user_meta_data->>'display_name', ''),
    nullif(u.raw_user_meta_data->>'full_name', ''),
    nullif(u.raw_user_meta_data->>'name', ''),
    p.display_name
  ),
  initials = upper(substring(
    coalesce(
      nullif(u.raw_user_meta_data->>'display_name', ''),
      nullif(u.raw_user_meta_data->>'full_name', ''),
      nullif(u.raw_user_meta_data->>'name', ''),
      u.email
    ) from 1 for 2
  ))
from auth.users u
where u.id = p.id
  and (p.display_name is null or p.display_name = '');
