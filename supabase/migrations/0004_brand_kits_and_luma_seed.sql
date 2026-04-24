-- =====================================================================
-- L+R Studio — Phase 6a migration:
--   1. Expand `brand_kits` with richer editorial fields
--   2. Seed the Luma sample brand: account, brand_kit, a few pipeline tasks
-- Safe to run on top of 0001–0003.
-- =====================================================================

-- ----- 1. Expand brand_kits --------------------------------------------

alter table public.brand_kits
  add column if not exists tagline    text,
  add column if not exists mission    text,
  add column if not exists audience   text,
  add column if not exists palette    jsonb not null default '[]'::jsonb,
  add column if not exists voice_tags jsonb not null default '[]'::jsonb,
  add column if not exists dos        jsonb not null default '[]'::jsonb,
  add column if not exists donts      jsonb not null default '[]'::jsonb,
  add column if not exists ai_summary text,
  add column if not exists photography  jsonb not null default '[]'::jsonb,
  add column if not exists inspiration  jsonb not null default '[]'::jsonb,
  add column if not exists past_creatives jsonb not null default '[]'::jsonb,
  add column if not exists logos jsonb not null default '[]'::jsonb;

-- ----- 2. Luma sample brand --------------------------------------------
-- We use a fixed UUID so re-runs are idempotent and the task seeds below
-- can target this account deterministically.

insert into public.accounts (id, type, name, slug, accent_color, logo_url)
values (
  '00000000-0000-4000-8000-000000000001',
  'brand',
  'Luma',
  'luma',
  '#C88A3F',
  null
)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  accent_color = excluded.accent_color;

-- Brand kit content, mirrored from the original mockData.js so the editorial
-- experience we designed stays visible from day one.
insert into public.brand_kits (
  account_id, tagline, mission, audience, tone_voice, ai_summary,
  primary_color, secondary_color, palette, fonts, voice_tags, dos, donts,
  photography, inspiration, past_creatives, logos, "references"
)
values (
  '00000000-0000-4000-8000-000000000001',
  'Skin-first. Science-backed. Unapologetically calm.',
  'Make a quiet, considered routine the new baseline for skin health — no hype, no smoke, no miracle claims.',
  'Women 28–45 in major US & UK cities. Design-conscious, ingredient-curious, brand-loyal once earned. Over-indexed on editorial media (Cereal, The Gentlewoman, Vogue) and ambient IG accounts.',
  'Warm, precise, confident-but-not-loud. Ingredient-first. Less is more.',
  'Luma is a premium DTC skincare brand built around a minimalist 4-step routine. Your customers are women 28–45 who value ingredient transparency and calm, editorial aesthetics. Creative should feel gallery-quiet, warm-toned, and ingredient-led — never glossy or hyperbolic.',
  '#1B1F1C',
  '#C9A88B',
  jsonb_build_array(
    jsonb_build_object('name','Ink','hex','#1B1F1C','role','Primary text'),
    jsonb_build_object('name','Clay','hex','#C9A88B','role','Secondary'),
    jsonb_build_object('name','Shell','hex','#F4EBDD','role','Background'),
    jsonb_build_object('name','Moss','hex','#5E6A52','role','Accent'),
    jsonb_build_object('name','Peach','hex','#F3B79A','role','Highlight'),
    jsonb_build_object('name','Cream','hex','#FBF6ED','role','Canvas')
  ),
  jsonb_build_array(
    jsonb_build_object('family','Söhne','role','UI / Body','sample','The quiet weight of considered typography.'),
    jsonb_build_object('family','Canela Deck','role','Display','sample','Skin, softly.')
  ),
  jsonb_build_array('Warm','Precise','Confident, not loud','Less is more','Ingredient-first'),
  jsonb_build_array(
    'Lead with skin outcomes, not hype',
    'Write like a knowledgeable friend',
    'Use clean, natural product photography',
    'Reference ingredients by name, briefly'
  ),
  jsonb_build_array(
    'Miracle claims or medical language',
    'Heavy retouching or unreal skin',
    'Jargon-heavy ingredient lists',
    'Emoji in hero copy'
  ),
  jsonb_build_array(
    jsonb_build_object('id','ph1','palette', jsonb_build_array('#F3E7D6','#E8C9A8','#C8A184'),'kicker','Ritual'),
    jsonb_build_object('id','ph2','palette', jsonb_build_array('#E8DFD1','#CABBA3','#7F7866'),'kicker','Product'),
    jsonb_build_object('id','ph3','palette', jsonb_build_array('#EFE9DD','#D6C4A5','#A78B6B'),'kicker','Texture'),
    jsonb_build_object('id','ph4','palette', jsonb_build_array('#F4EBDD','#C9A88B','#1B1F1C'),'kicker','Hero'),
    jsonb_build_object('id','ph5','palette', jsonb_build_array('#E6E2D6','#B9A989','#5E6A52'),'kicker','Still life'),
    jsonb_build_object('id','ph6','palette', jsonb_build_array('#F6EEE4','#F3B79A','#C4412C'),'kicker','Morning')
  ),
  jsonb_build_array(
    jsonb_build_object('id','i1','label','Aesop storefront — Marais','palette', jsonb_build_array('#E8DFD1','#7F7866','#1B1F1C')),
    jsonb_build_object('id','i2','label','Le Labo — fragrance lab','palette', jsonb_build_array('#F4EBDD','#C9A88B','#5E6A52')),
    jsonb_build_object('id','i3','label','Cereal mag — issue 24','palette', jsonb_build_array('#FBF6ED','#C9A88B','#1B1F1C')),
    jsonb_build_object('id','i4','label','Muji — packaging','palette', jsonb_build_array('#FBF6ED','#E8DFD1','#7F7866'))
  ),
  jsonb_build_array(
    jsonb_build_object('id','pc1','label','Gentle Cleanser — Launch','palette', jsonb_build_array('#F4EBDD','#C9A88B','#1B1F1C')),
    jsonb_build_object('id','pc2','label','Replenish — Teaser','palette', jsonb_build_array('#F3E7D6','#F3B79A','#C4412C')),
    jsonb_build_object('id','pc3','label','Spring Cleanse','palette', jsonb_build_array('#EFE9DD','#D6C4A5','#A78B6B')),
    jsonb_build_object('id','pc4','label','Founder Essay','palette', jsonb_build_array('#E6E2D6','#B9A989','#5E6A52'))
  ),
  jsonb_build_array(
    jsonb_build_object('id','lg1','label','Primary · Wordmark','variant','wordmark','bg','#FBF6ED','ink','#1B1F1C'),
    jsonb_build_object('id','lg2','label','Secondary · Monogram','variant','mono','bg','#FBF6ED','ink','#1B1F1C'),
    jsonb_build_object('id','lg3','label','Mono · Reverse','variant','wordmark','bg','#1B1F1C','ink','#FBF6ED')
  ),
  '[]'::jsonb
)
on conflict (account_id) do update set
  tagline = excluded.tagline,
  mission = excluded.mission,
  audience = excluded.audience,
  tone_voice = excluded.tone_voice,
  ai_summary = excluded.ai_summary,
  primary_color = excluded.primary_color,
  secondary_color = excluded.secondary_color,
  palette = excluded.palette,
  fonts = excluded.fonts,
  voice_tags = excluded.voice_tags,
  dos = excluded.dos,
  donts = excluded.donts,
  photography = excluded.photography,
  inspiration = excluded.inspiration,
  past_creatives = excluded.past_creatives,
  logos = excluded.logos,
  updated_at = now();

-- ----- 3. Sample tasks in Luma's pipeline ------------------------------
-- Fixed IDs so re-runs are idempotent. created_by stays NULL since we don't
-- seed an auth user for Luma; the tasks are shown to agency viewers.

insert into public.tasks (id, account_id, title, brief_text, status, deadline, platform, format, objective, creatives_count, created_at)
values
  ('11111111-1111-4111-8111-000000000001', '00000000-0000-4000-8000-000000000001',
   'Replenish Serum — Launch Campaign',
   '10 creatives for the Replenish Serum launch. Static and motion for Instagram and TikTok. Awareness + waitlist signups. Quiet, editorial, ingredient-led.',
   'progress', '2026-05-12', 'Instagram, TikTok', 'Static + motion', 'Awareness + waitlist', 10, now() - interval '10 days'),
  ('11111111-1111-4111-8111-000000000002', '00000000-0000-4000-8000-000000000001',
   '5 Instagram posts — trending: dewy not oily',
   '5 Instagram posts riding the dewy-not-oily conversation. Needs to ship by Friday. Conversational tone.',
   'review', '2026-04-25', 'Instagram', 'Static', 'Engagement', 5, now() - interval '5 days'),
  ('11111111-1111-4111-8111-000000000003', '00000000-0000-4000-8000-000000000001',
   'Summer 26 lifestyle photography set',
   '30 hero images plus supporting. Warm natural light, minimal props, outdoor + home interior.',
   'progress', '2026-06-03', 'Web + Social', 'Photography', 'Brand library refresh', 30, now() - interval '22 days'),
  ('11111111-1111-4111-8111-000000000004', '00000000-0000-4000-8000-000000000001',
   'Mother''s Day gift guide campaign',
   '6 creatives, email headers, 2 landing page banners. Soft and personal.',
   'delivered', '2026-04-15', 'Email, Web', 'Static', 'Conversion', 6, now() - interval '32 days'),
  ('11111111-1111-4111-8111-000000000005', '00000000-0000-4000-8000-000000000001',
   'Weekly ad creative refresh — Meta',
   '8 new variants for our top-performing Meta ad set. Swap imagery + hooks, keep format.',
   'revising', '2026-04-26', 'Meta', 'Motion + static', 'Conversion', 8, now() - interval '4 days')
on conflict (id) do nothing;

-- Mark the delivered one as actually delivered (timestamp-wise).
update public.tasks
set delivered_at = created_at + interval '20 days'
where id = '11111111-1111-4111-8111-000000000004'
  and delivered_at is null;
