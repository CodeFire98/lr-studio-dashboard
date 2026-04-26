-- =====================================================================
-- L+R Studio — Phase 11 migration:
--   Fix accessible_account_ids() so users with 2+ memberships don't
--   trigger Postgres error 21000 ("more than one row returned by a
--   subquery used as an expression").
--
-- The original definition in 0001 used a SQL CASE expression:
--   select case when is_agency_user() then (select id from accounts)
--                                     else (select account_id from
--                                           account_members where ...)
--   end;
-- Both branches are scalar-subquery contexts, so they break the moment
-- a non-agency user belongs to more than one account. Every RLS policy
-- that references this helper (accounts, account_members, tasks,
-- brand_kits, etc.) then fails for that user — the client sees empty
-- result sets and the UI behaves as if the user has no memberships.
--
-- Rewrite as a plpgsql function using RETURN QUERY, which is a true
-- set-returning context.
-- =====================================================================

create or replace function public.accessible_account_ids()
returns setof uuid
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.is_agency_user() then
    return query select id from public.accounts;
  else
    return query
      select account_id from public.account_members where user_id = auth.uid();
  end if;
end;
$$;
