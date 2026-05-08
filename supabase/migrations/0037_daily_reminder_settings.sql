-- =====================================================================
-- L+R Studio — accounts.daily_reminder_enabled
-- =====================================================================
-- Per-brand toggle for the 6pm-IST daily digest of next-day posts.
-- Default ON for every existing brand and every new one — the email is
-- meant to be a heartbeat for the brand-side workflow ("here's what's
-- going live tomorrow, and what still needs your eyes"). Brands that
-- don't want it can flip the switch from Settings.
--
-- Timezone is intentionally NOT a column — v1 hardcodes IST since every
-- current customer is Indian. When customers expand, add an
-- `accounts.timezone` column and have the cron route honour it.

alter table public.accounts
  add column daily_reminder_enabled boolean not null default true;
