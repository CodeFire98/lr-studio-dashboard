-- =====================================================================
-- L+R Studio — Bamboo Bear Brand System v1 SEED
--
--   Populates the two new JSONB columns added in migration 0059:
--     - brand_kits.claim_guardrails
--     - brand_kits.channel_voice
--
--   Source of truth: Bamboo_Bear_Brand_System.md (Last updated 2026-05-15)
--   §4 (Claim Guardrails), §5 (Voice & Tone), §8 (Channel Strategy)
--
--   Scope discipline (deliberate non-goals for v1):
--     - Does NOT touch brand_kits.tone_voice, dos, donts, audience, etc.
--       Those columns are already enriched and may carry agency-curated
--       content; refresh of them is a separate manual review pass.
--     - Does NOT include content_frameworks or sample_bank — those are
--       v2 columns (separate future migration).
--     - X tweet "rhythms" from §9 are stored under channel_voice.twitter
--       because they read as channel-cadence patterns more than as
--       universal frameworks. Easy to move to content_frameworks later.
--
--   Safety:
--     - Wrapped in a transaction so it's all-or-nothing.
--     - Guard block raises a clear error if the Bamboo Bear account
--       isn't found by slug (better than a silent zero-row UPDATE).
--     - UPDATE is idempotent on the JSONB columns (running twice
--       overwrites with the same payload; no duplicates created).
-- =====================================================================

begin;

-- ---- 1. Safety guard ------------------------------------------------
do $$
begin
  if not exists (
    select 1 from public.accounts where slug = 'bamboo-bear'
  ) then
    raise exception
      'Seed aborted: no account found with slug = ''bamboo-bear''. '
      'Verify the slug against the target database before running.';
  end if;

  if not exists (
    select 1
    from public.brand_kits bk
    join public.accounts a on a.id = bk.account_id
    where a.slug = 'bamboo-bear'
  ) then
    raise exception
      'Seed aborted: Bamboo Bear account exists but has no brand_kits '
      'row. Create the brand_kit first (e.g. via enrich-brand-kit) then '
      'rerun this seed.';
  end if;
end $$;

-- ---- 2. Populate claim_guardrails -----------------------------------
update public.brand_kits
   set claim_guardrails = $$
{
  "never_use": [
    {
      "phrase": "under 20 calories",
      "category": "calorie_claim",
      "reason": "specific calorie counts are off-limits (regulatory + drift risk)",
      "use_instead": "tasty low-calorie beverage",
      "severity": "hard_block"
    },
    {
      "phrase": "zero artificial sweeteners",
      "category": "sweetener_claim",
      "reason": "stevia concerns make this claim unsafe to defend",
      "use_instead": null,
      "severity": "hard_block"
    },
    {
      "phrase": "no artificial sweeteners",
      "category": "sweetener_claim",
      "reason": "stevia concerns make this claim unsafe to defend",
      "use_instead": null,
      "severity": "hard_block"
    },
    {
      "phrase": "no chemicals",
      "category": "vague_claim",
      "reason": "too vague to defend; replaced with cleaner framing",
      "use_instead": "clean label / ingredients you can pronounce",
      "severity": "hard_block"
    },
    {
      "phrase": "cleanest fizz of the summer",
      "category": "seasonal_lead",
      "reason": "summer-led headlines are overused; summer is fine as flavour/seasonal context but not the lead hook",
      "use_instead": "lead with ingredient, founder POV, or category critique; reference summer only inside the body",
      "severity": "soft_block"
    },
    {
      "phrase": "DM 'subscribe'",
      "category": "cta",
      "reason": "moved to scannable link-in-bio + QR model for subscription posts",
      "use_instead": "link in bio",
      "severity": "hard_block"
    },
    {
      "phrase": "DM to order",
      "category": "cta",
      "reason": "moved to scannable link-in-bio + QR model for subscription posts",
      "use_instead": "link in bio",
      "severity": "hard_block"
    },
    {
      "phrase": "Swiggy",
      "category": "competitor_naming",
      "reason": "frame the positive case, never the negative one; do not name quick-commerce platforms",
      "use_instead": "make the category critique without naming a competitor",
      "severity": "hard_block"
    },
    {
      "phrase": "Zepto",
      "category": "competitor_naming",
      "reason": "frame the positive case, never the negative one; do not name quick-commerce platforms",
      "use_instead": "make the category critique without naming a competitor",
      "severity": "hard_block"
    }
  ],
  "always_pair": [
    {
      "trigger_phrase": "zero refined sugar",
      "required_pair": "sweetened with organic cane sugar",
      "reason": "transparency — 'zero refined sugar' alone implies zero sweetener and is misleading"
    },
    {
      "trigger_phrase": "live probiotics",
      "preferred_alternative": "live cultures",
      "reason": "both are safe but 'live cultures' matches the canonical standee language"
    }
  ],
  "approved_qualifiers": [
    "Low Sugar",
    "Zero Caffeine",
    "Gluten Free",
    "Vegan",
    "Cold-pressed",
    "Live cultures"
  ],
  "off_limits_numbers": [
    {
      "type": "calorie_count",
      "rule": "never state a specific calorie number. 'low-calorie' and 'low-cal' are fine; numerical claims like 'under 20 calories' are not."
    }
  ],
  "_meta": {
    "source": "Bamboo_Bear_Brand_System.md §4, §14",
    "schema_version": 1,
    "last_seeded_at": "2026-05-24"
  }
}
$$::jsonb
 where account_id = (
   select id from public.accounts where slug = 'bamboo-bear'
 );

-- ---- 3. Populate channel_voice --------------------------------------
update public.brand_kits
   set channel_voice = $$
{
  "global": {
    "sign_off": "🐼",
    "sign_off_usage": "End IG captions and most LinkedIn posts with 🐼. Optional on X (not forced). Use as natural close, never as ornament.",
    "signature_phrases": [
      {"phrase": "ginger-bug fermented", "usage": "leads ingredient stories — high-frequency anchor"},
      {"phrase": "no ingredients you need a chemistry degree to pronounce", "usage": "clean-label framing"},
      {"phrase": "your protein gets a whole shelf, your gut gets nothing", "usage": "category-jab hook (use sparingly)"},
      {"phrase": "all the fizz. zero regret.", "usage": "punchy closer"},
      {"phrase": "tastes good. feels good. zero regret.", "usage": "newer closer for launch content"},
      {"phrase": "loved the sip? subscribe.", "usage": "subscription stall CTA — physical-world echo"}
    ],
    "must_include_one_of": [
      "ginger-bug fermented",
      "70% real ingredients",
      "fermented fruit juices (vs vinegar taste of kombucha)",
      "specific fruit sourcing (e.g. Kerala pineapples)"
    ],
    "must_include_rationale": "Every post should carry at least one of the 4 core differentiators (§14 checklist item 10)."
  },
  "instagram": {
    "case": "sentence",
    "person": "brand",
    "cadence": "short lines, scannable; one idea per line",
    "lead_with": "lifestyle, ingredient, or in-the-moment scene",
    "ending_pattern": "a question, the brand line, or 🐼",
    "format_constraints": ["4:5 portrait aspect ratio for all future posts"],
    "posting_frequency": "every alternate day",
    "pillars": [
      "IRL events — run clubs, pickleball, pop-ups",
      "Ingredient-led posts (Synergy reference)",
      "IG-native day-in-the-life formats"
    ],
    "cta_default": "link in bio"
  },
  "linkedin": {
    "case": "sentence",
    "person": "first_person_founder",
    "founder_name": "Shruti",
    "founder_context": "Former AI / Data Science professional, 7+ years in tech before founding Bamboo Bear in 2021.",
    "cadence": "hook lands in the first 1–2 lines (before the 'see more' cut)",
    "lead_with": "a story, a statement, or a question",
    "stance": "opinionated but warm; can rant about category problems without naming competitors",
    "anchor_rule": "specific anecdotes beat generic claims — name the customer, the moment, the place",
    "ending_pattern": "quotable closer line + soft CTA + 🐼",
    "posting_frequency": "Tuesdays & Thursdays, 10–11am IST",
    "pillars": [
      "Founder journey",
      "On-the-ground pop-up content",
      "Industry rants ('the spreadsheet truth vs brand truth' energy)",
      "Industry observation pieces"
    ]
  },
  "twitter": {
    "case": "lower",
    "person": "brand",
    "cadence": "terse, meme-cadence",
    "tone_modifiers": ["funny", "a little smug", "anti-marketing"],
    "competitor_handling": "sharp category callouts allowed; no naming names",
    "posting_frequency": "daily, mid-afternoon / evening",
    "pillars": [
      "Memes",
      "Brand POVs",
      "Sharp category observations (no naming)",
      "Education (ginger bug vs kombucha pasteurisation)"
    ],
    "rhythms": [
      "1-liner punchy",
      "3-line stacked beat",
      "Listicle (3–5 short bullets)",
      "Hierarchy meme (4-tier ranking)",
      "Founder POV ('the thing nobody tells you about X')",
      "Reaction format ('overheard at the pop-up')",
      "Comparison ('X says Y. We do Z.')"
    ],
    "ending_pattern": "🐼 optional, not forced"
  },
  "whatsapp": {
    "case": "sentence",
    "person": "first_person_founder",
    "tone": "founder-to-friend — 'thought of you specifically because you get it' energy",
    "use_cases": [
      "Friends & Family outreach (use SHRUTI25 code framing)",
      "Pop-up / warm audience first-dibs notes",
      "Repost scripts that F&F can copy-paste"
    ]
  },
  "_meta": {
    "source": "Bamboo_Bear_Brand_System.md §5, §8, §9 (X rhythms only), §14",
    "schema_version": 1,
    "last_seeded_at": "2026-05-24"
  }
}
$$::jsonb
 where account_id = (
   select id from public.accounts where slug = 'bamboo-bear'
 );

-- ---- 4. Confirmation block ------------------------------------------
-- This raises a notice (visible in psql / Supabase SQL editor output)
-- so the operator can confirm both columns landed on the expected row.
do $$
declare
  populated_count int;
begin
  select count(*) into populated_count
  from public.brand_kits bk
  join public.accounts a on a.id = bk.account_id
  where a.slug = 'bamboo-bear'
    and bk.claim_guardrails != '{}'::jsonb
    and bk.channel_voice    != '{}'::jsonb;

  if populated_count != 1 then
    raise exception
      'Post-seed check failed: expected exactly 1 Bamboo Bear brand_kit '
      'with both JSONB columns populated, found %.', populated_count;
  end if;

  raise notice
    'Bamboo Bear Brand System v1 seed applied. Both columns populated on 1 row.';
end $$;

commit;
