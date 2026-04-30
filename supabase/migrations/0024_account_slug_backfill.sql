-- Phase 2 routing: backfill accounts.slug for existing rows + trigger to
-- auto-generate the slug from the name on every new insert. The `slug`
-- column already exists (added in 0001_initial.sql) but was nullable and
-- wasn't being populated by the create_brand_account / signup flows.
--
-- All operations are idempotent — running this migration again is a no-op.

-- Slugify helper: lowercase, replace non-alphanumeric runs with '-',
-- trim leading/trailing dashes. Pure SQL, IMMUTABLE so it can be used
-- in indexes / generated columns later if we ever want to.
create or replace function public.slugify(input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'));
$$;

-- Trigger function: when a row is inserted with a NULL/empty slug,
-- generate one from the name. If that slug collides with an existing
-- one, append a numeric suffix until unique.
create or replace function public.set_account_slug_if_null()
returns trigger
language plpgsql
as $$
declare
  base_slug text;
  candidate text;
  n int := 1;
begin
  if new.slug is null or new.slug = '' then
    base_slug := public.slugify(new.name);
    if base_slug = '' then
      -- Name was all non-alphanumeric; fall back to a stable prefix.
      base_slug := 'brand';
    end if;
    candidate := base_slug;
    while exists (select 1 from public.accounts where slug = candidate and id is distinct from new.id) loop
      n := n + 1;
      candidate := base_slug || '-' || n;
    end loop;
    new.slug := candidate;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounts_set_slug on public.accounts;
create trigger trg_accounts_set_slug
  before insert on public.accounts
  for each row
  execute function public.set_account_slug_if_null();

-- One-shot backfill for any existing rows with NULL/empty slugs.
-- Order by created_at so older accounts get the unsuffixed slug
-- ("acme") and newer collisions become "acme-2", "acme-3", etc.
do $$
declare
  rec record;
  base_slug text;
  candidate text;
  n int;
begin
  for rec in (
    select id, name
    from public.accounts
    where slug is null or slug = ''
    order by created_at
  ) loop
    base_slug := public.slugify(rec.name);
    if base_slug = '' then
      base_slug := 'brand';
    end if;
    candidate := base_slug;
    n := 1;
    while exists (
      select 1 from public.accounts
      where slug = candidate and id is distinct from rec.id
    ) loop
      n := n + 1;
      candidate := base_slug || '-' || n;
    end loop;
    update public.accounts set slug = candidate where id = rec.id;
  end loop;
end;
$$;
