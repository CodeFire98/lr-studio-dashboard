-- =====================================================================
-- L+R Studio — Brand System v1 migration:
--   Extend brand_kits with two new JSONB columns that capture the
--   prescriptive, brand-specific rules the AI Co-pilot needs to write
--   on-brand content reliably.
--
--   1. claim_guardrails — structured claim rules the AI must honour:
--        - never_use: phrases to avoid, each with a `use_instead` swap
--          target so the model substitutes rather than just deletes
--        - always_pair: trigger phrases that require a companion phrase
--          (e.g. "zero refined sugar" must pair with "sweetened with
--          organic cane sugar")
--        - approved_qualifiers: positive list of claim-safe descriptors
--        - off_limits_numbers: categories of numeric claims that are
--          off-limits regardless of phrasing (e.g. specific calorie
--          counts)
--
--   2. channel_voice — per-channel voice prescription that the existing
--      universal platform playbook (skillRegistry / platforms.md) does
--      NOT cover. Captures brand-specific overlays like:
--        - case (sentence | lower | title)
--        - person (brand | first_person_founder)
--        - cadence, ending_pattern, posting_frequency
--        - per-channel pillars and tone modifiers
--
--   Why JSONB on brand_kits (not a new sections table):
--     - brand_kits is already SELECT *'d by brandContext.js and the
--       compiled blob is already sent to Claude (see lines 86–89 and
--       232–254 of web/src/lib/brandContext.js). Adding columns here
--       means zero new plumbing — the compile step just appends two
--       more sections.
--     - Mirrors the precedent set by the `enrichment` JSONB column in
--       migration 0017 (raw Firecrawl response cache).
--     - Single source of truth per brand; no JOINs at compile time.
--
--   Both columns default to empty {} so existing rows are unaffected.
--   Backfill (e.g. Bamboo Bear seed) ships as a separate data-only
--   migration so the schema change can land independently of content.
-- =====================================================================

-- ---- 1. Add JSONB columns to brand_kits ------------------------------

alter table public.brand_kits
  add column if not exists claim_guardrails jsonb not null default '{}'::jsonb,
  add column if not exists channel_voice    jsonb not null default '{}'::jsonb;

-- ---- 2. Column documentation -----------------------------------------

comment on column public.brand_kits.claim_guardrails is
  'Brand System v1 — structured claim rules consumed by the AI Co-pilot. '
  'Shape: { never_use: [{phrase, category, reason, use_instead, severity}], '
  'always_pair: [{trigger_phrase, required_pair | preferred_alternative, reason}], '
  'approved_qualifiers: [string], off_limits_numbers: [{type, rule}] }. '
  'Read by web/src/lib/brandContext.js and appended to the brand context blob '
  'sent to Claude. Empty object = no guardrails configured (safe default).';

comment on column public.brand_kits.channel_voice is
  'Brand System v1 — per-channel voice prescription overlay. '
  'Shape: { instagram: {...}, linkedin: {...}, twitter: {...}, whatsapp: {...} } '
  'where each channel may carry case, person, cadence, lead_with, '
  'ending_pattern, posting_frequency, pillars, rhythms, tone_modifiers, etc. '
  'Layered ABOVE the universal platform playbook from skillRegistry '
  '(web/src/data/skills/social-content/references/platforms.md) — universal '
  'mechanics stay there, brand-specific voice rules live here. '
  'Empty object = fall back to universal playbook only.';

-- ---- 3. RLS — no policy changes needed -------------------------------
-- brand_kits already has RLS in place from earlier migrations; the new
-- columns inherit those policies. Reads are gated by account membership
-- (agency or brand user on the same account). Writes follow the same
-- existing pattern.
