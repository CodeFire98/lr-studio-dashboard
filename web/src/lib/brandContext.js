// =====================================================================
// Linkrunner Media — Brand-context compiler for the AI Co-pilot
// =====================================================================
//
// Single source of truth for the "who is this brand" blob we hand to
// Claude on every AI call. Compiled once per request from three inputs:
//
//   - brand_kits         the structured Brand Intelligence row
//   - brand_kit_notes    free-form admin annotations (the "memory" layer)
//   - post_plans         the last few approved plans (style references)
//
// Designed for prompt caching: the output is stable per brand until any
// of those three sources change, so back-to-back AI calls for the same
// brand hit Anthropic's cache (~90% input-token discount) within the
// 5-minute TTL.
//
// Two exports:
//
//   compileBrandContext({ brandKit, notes, recentApprovedPlans })
//     Pure function. Takes raw DB rows (snake_case columns) and returns
//     the final string. Importable from both the browser SPA and the
//     Vercel API route (PR 2) so server-side rendering uses the same
//     blob shape.
//
//   loadAndCompileBrandContext(supabaseClient, accountId)
//     Async wrapper that does the three queries and calls the pure
//     compiler. Works with both the publishable-key client (browser,
//     RLS-scoped) and the service-role client (server, full access).
//
// Nothing in the SPA reads this yet — PR 1 lands the compiler so PR 2
// can wire it into /api/ai/chat without re-architecting.

const RECENT_PLANS_LIMIT = 6;
const NOTES_RECENT_LIMIT = 20;
const COPY_PREVIEW_CHARS = 280;

export async function loadAndCompileBrandContext(supabaseClient, accountId) {
  if (!supabaseClient) throw new Error('supabaseClient required');
  if (!accountId) throw new Error('accountId required');

  const [kitResult, notesResult, plansResult] = await Promise.all([
    supabaseClient
      .from('brand_kits')
      .select('*, account:accounts(id, name, type)')
      .eq('account_id', accountId)
      .maybeSingle(),
    supabaseClient
      .from('brand_kit_notes')
      .select('id, body, is_pinned, created_at')
      .eq('account_id', accountId)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(NOTES_RECENT_LIMIT + 10),
    supabaseClient
      .from('post_plans')
      .select('id, concept, copy_variants, platforms, scheduled_at, status')
      .eq('account_id', accountId)
      .eq('status', 'approved')
      .order('scheduled_at', { ascending: false })
      .limit(RECENT_PLANS_LIMIT),
  ]);

  if (kitResult.error) throw kitResult.error;

  return compileBrandContext({
    brandKit: kitResult.data,
    notes: notesResult.data || [],
    recentApprovedPlans: plansResult.data || [],
  });
}

export function compileBrandContext({ brandKit, notes = [], recentApprovedPlans = [] }) {
  if (!brandKit) return '';

  const sections = [];
  const name = brandKit.account?.name || 'this brand';
  sections.push(`# Brand: ${name}`);

  const identity = compactLines([
    brandKit.industry && `Industry: ${brandKit.industry}`,
    brandKit.tagline && `Tagline: ${brandKit.tagline}`,
    brandKit.mission && `Mission: ${brandKit.mission}`,
    brandKit.positioning_statement && `Positioning: ${brandKit.positioning_statement}`,
    brandKit.audience && `Audience: ${brandKit.audience}`,
  ]);
  if (identity) sections.push(identity);

  const voice = compactLines([
    brandKit.tone_voice && `Tone: ${brandKit.tone_voice}`,
    arrayLine(brandKit.voice_tags, 'Voice tags'),
    bulletList(brandKit.dos, 'Do'),
    bulletList(brandKit.donts, "Don't"),
  ]);
  if (voice) sections.push(`## Voice\n${voice}`);

  const strategy = compactLines([
    bulletList(brandKit.value_props, 'Value props'),
    bulletList(brandKit.brand_pillars, 'Pillars'),
    bulletList(brandKit.key_differentiators, 'Differentiators'),
    arrayLine(brandKit.product_categories, 'Products / categories'),
  ]);
  if (strategy) sections.push(`## Strategy\n${strategy}`);

  const visual = compactLines([
    brandKit.primary_color && `Primary: ${brandKit.primary_color}`,
    brandKit.secondary_color && `Secondary: ${brandKit.secondary_color}`,
    brandKit.accent_color && `Accent: ${brandKit.accent_color}`,
    paletteLine(brandKit.palette),
    fontsLine(brandKit.fonts),
  ]);
  if (visual) sections.push(`## Visual identity\n${visual}`);

  const competitorLines = competitorBullets(brandKit.competitors);
  if (competitorLines) sections.push(`## Competitors\n${competitorLines}`);

  const hashtagLine = hashtagsLine(brandKit.trend_hashtags);
  if (hashtagLine) sections.push(`## Tracked hashtags\n${hashtagLine}`);

  const notesBlock = notesSection(notes);
  if (notesBlock) sections.push(notesBlock);

  const examplesBlock = recentPlansSection(recentApprovedPlans);
  if (examplesBlock) sections.push(examplesBlock);

  return sections.join('\n\n');
}

// ---------- helpers -----------------------------------------------------

function compactLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function arrayLine(values, label) {
  if (!Array.isArray(values) || !values.length) return null;
  const cleaned = values.map(v => (typeof v === 'string' ? v.trim() : v)).filter(Boolean);
  if (!cleaned.length) return null;
  return `${label}: ${cleaned.join(', ')}`;
}

function bulletList(values, label) {
  if (!Array.isArray(values) || !values.length) return null;
  const items = values
    .map(v => (typeof v === 'string' ? v.trim() : v?.text || v?.body || ''))
    .filter(Boolean);
  if (!items.length) return null;
  return `${label}:\n${items.map(i => `- ${i}`).join('\n')}`;
}

function paletteLine(palette) {
  if (!Array.isArray(palette) || !palette.length) return null;
  const hexes = palette
    .map(entry => (typeof entry === 'string' ? entry : entry?.hex || entry?.color))
    .filter(Boolean)
    .slice(0, 8);
  if (!hexes.length) return null;
  return `Palette: ${hexes.join(', ')}`;
}

function fontsLine(fonts) {
  if (!Array.isArray(fonts) || !fonts.length) return null;
  const families = fonts
    .map(entry => (typeof entry === 'string' ? entry : entry?.family || entry?.name))
    .filter(Boolean);
  if (!families.length) return null;
  return `Fonts: ${families.join(', ')}`;
}

function competitorBullets(competitors) {
  if (!Array.isArray(competitors) || !competitors.length) return null;
  const items = competitors.slice(0, 10).map(entry => {
    const parts = [];
    if (entry?.name) parts.push(entry.name);
    const handle = entry?.handle && entry.handle.replace(/^@/, '');
    if (handle && handle !== entry?.name) parts.push(`@${handle}`);
    return parts.length ? `- ${parts.join(' ')}` : null;
  }).filter(Boolean);
  return items.length ? items.join('\n') : null;
}

function hashtagsLine(hashtags) {
  if (!Array.isArray(hashtags) || !hashtags.length) return null;
  return hashtags
    .slice(0, 20)
    .map(h => `#${String(h).replace(/^#/, '')}`)
    .join(', ');
}

function notesSection(notes) {
  if (!Array.isArray(notes) || !notes.length) return null;
  const pinned = notes.filter(n => n.is_pinned);
  const others = notes.filter(n => !n.is_pinned).slice(0, NOTES_RECENT_LIMIT);
  const parts = [];
  if (pinned.length) {
    parts.push(`### Pinned (always-true facts)\n${pinned.map(n => `- ${n.body}`).join('\n')}`);
  }
  if (others.length) {
    parts.push(`### Recent context\n${others.map(n => `- ${n.body}`).join('\n')}`);
  }
  if (!parts.length) return null;
  return `## Notes from the agency admin\n${parts.join('\n\n')}`;
}

function recentPlansSection(plans) {
  if (!Array.isArray(plans) || !plans.length) return null;
  const examples = plans.slice(0, RECENT_PLANS_LIMIT).map(plan => {
    const lines = [];
    const platforms = Array.isArray(plan.platforms) ? plan.platforms.join(' / ') : '';
    const when = plan.scheduled_at ? String(plan.scheduled_at).slice(0, 10) : '';
    const header = [when, platforms].filter(Boolean).join(' · ');
    if (header) lines.push(header);
    if (plan.concept) lines.push(`Concept: ${plan.concept}`);
    const copy = plan.copy_variants || {};
    for (const platform of Object.keys(copy)) {
      const value = copy[platform];
      const body = typeof value === 'string' ? value : value?.body || value?.text;
      if (body) lines.push(`${platform}: ${truncate(body, COPY_PREVIEW_CHARS)}`);
    }
    return lines.join('\n');
  });
  return `## Recent approved posts (style references)\n${examples.join('\n\n---\n\n')}`;
}

function truncate(value, max) {
  const s = String(value || '');
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + '…';
}
