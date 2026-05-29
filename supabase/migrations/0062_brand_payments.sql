-- =====================================================================
-- 0062_brand_payments.sql
-- Billing v1 — payment-request inbox at /c/:slug/billing.
-- =====================================================================
-- Agency manually creates Razorpay payment links out-of-band, pastes
-- them into a payment request on the dashboard. Brand sees the
-- outstanding request, taps "Pay now" to follow the external link, and
-- the agency uploads the actual invoice PDF after payment for the brand
-- to download later.
--
-- v1 deliberately has no plans/tiers. Each row is independent — flat
-- list of payment requests per brand. RLS: agency full CRUD, brand
-- read-only on their own brand's rows.
--
-- Storage: private bucket `brand-invoices`. Path scheme
-- <accountId>/<paymentId>/<filename>. Brand download is via signed URL
-- (createSignedUrl, 1-hour TTL).
--
-- Per the 2026-10-30 convention (REFERENCE.md §6), this table includes
-- explicit GRANT … TO authenticated so PostgREST keeps exposing it
-- after the platform default flip.
-- =====================================================================

create table public.brand_payments (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  title               text not null,
  description         text,
  amount              numeric(14,2) not null check (amount >= 0),
  currency            text not null check (currency in ('USD','INR')),
  payment_link_url    text,
  status              text not null default 'outstanding'
                        check (status in ('outstanding','paid','voided')),
  due_on              date,
  issued_on           date not null default current_date,
  paid_at             date,
  paid_note           text,
  invoice_file_path   text,
  invoice_file_name   text,
  internal_notes      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id)
);

create index brand_payments_account_status_idx
  on public.brand_payments (account_id, status, issued_on desc);

create index brand_payments_account_created_idx
  on public.brand_payments (account_id, created_at desc);

-- updated_at trigger
create or replace function public.brand_payments_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger brand_payments_updated_at
  before update on public.brand_payments
  for each row execute function public.brand_payments_set_updated_at();

alter table public.brand_payments enable row level security;

-- SELECT — agency full, brand owners read their own rows.
create policy brand_payments_select on public.brand_payments
  for select to authenticated
  using (
    public.is_agency_user()
    or account_id in (select public.accessible_account_ids())
  );

-- INSERT/UPDATE/DELETE — agency only.
create policy brand_payments_insert_agency on public.brand_payments
  for insert to authenticated
  with check (public.is_agency_user());

create policy brand_payments_update_agency on public.brand_payments
  for update to authenticated
  using (public.is_agency_user())
  with check (public.is_agency_user());

create policy brand_payments_delete_agency on public.brand_payments
  for delete to authenticated
  using (public.is_agency_user());

-- Explicit GRANT per the 2026-10-30 convention. RLS still filters rows.
grant select, insert, update, delete on public.brand_payments to authenticated;

-- =====================================================================
-- Storage: brand-invoices bucket (private)
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('brand-invoices', 'brand-invoices', false)
on conflict (id) do nothing;

-- Helper: extract <accountId> from path "<accountId>/<paymentId>/..."
create or replace function public.brand_invoice_account_id(name text)
returns uuid language sql immutable as $$
  select nullif(split_part(name, '/', 1), '')::uuid;
$$;

create policy "brand-invoices read by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'brand-invoices'
    and (
      public.is_agency_user()
      or public.brand_invoice_account_id(name) in (
        select public.accessible_account_ids()
      )
    )
  );

-- Write/delete — agency only (mirrors the table-level write gate).
create policy "brand-invoices write by agency" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'brand-invoices'
    and public.is_agency_user()
  );

create policy "brand-invoices update by agency" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'brand-invoices'
    and public.is_agency_user()
  )
  with check (
    bucket_id = 'brand-invoices'
    and public.is_agency_user()
  );

create policy "brand-invoices delete by agency" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'brand-invoices'
    and public.is_agency_user()
  );

comment on table public.brand_payments is
  'Billing v1 — one row per payment request. Agency manually creates Razorpay payment links and pastes the URL; brand reads-only via /c/:slug/billing. Invoice PDFs live in storage bucket brand-invoices at <account_id>/<payment_id>/<filename>.';
