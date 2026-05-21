// =====================================================================
// Linkrunner Media — Brand-context compiler for the LinkAI
// =====================================================================
//
// Single source of truth for the "who is this brand" blob we hand to
// Claude on every AI call. Compiled once per request from these inputs:
//
//   - brand_kits         the structured Brand Intelligence row
//   - brand_kit_notes    free-form admin annotations (the "memory" layer)
//   - post_plans         past approved (style refs) + upcoming (calendar)
//   - post_plan_publications + post_engagement_snapshots
//                        powers ## Top performers and ## Voice anchors
//
// Designed for prompt caching: the output is stable per brand within a
// short window so back-to-back AI calls for the same brand hit Anthropic's
// cache (~90% input-token discount) within the 5-minute TTL. The `## Today`
// section changes daily, so the chat route puts it behind its own cache
// breakpoint — see chat.ts.
//
// Two exports:
//
//   compileBrandContext({ brandKit, notes, recentApprovedPlans, ... opts })
//     Pure function. Takes raw DB rows (snake_case columns) and returns
//     the final string. Importable from both the browser SPA and the
//     Vercel API route so server-side rendering uses the same blob shape.
//
//   loadAndCompileBrandContext(supabaseClient, accountId, options?)
//     Async wrapper that does the queries and calls the pure compiler.
//     Works with publishable-key (browser, RLS-scoped) and service-role
//     (server, full access) clients. The `options` arg gates expensive
//     calendar/engagement queries — chat opts in, inline copy/image opts
//     out (they don't need the full calendar block).

import { getUpcomingMoments } from './marketingMoments.js';

const RECENT_PLANS_LIMIT = 6;
const NOTES_RECENT_LIMIT = 20;
const COPY_PREVIEW_CHARS = 280;
const UPCOMING_PLANS_LIMIT = 30;
const PUBLICATIONS_LIMIT = 20;
const TOP_PERFORMERS_COUNT = 3;
const VOICE_ANCHORS_COUNT = 5;
const HOLIDAY_LOOKAHEAD_DAYS = 30;
// Industry signals (Firecrawl /search results from the daily cron) —
// always loaded when calendar is enabled (chat route). Cheap: ~5-10
// rows max, ~1-2K tokens of context. The model leads with these to
// feel proactive about trends without paying for a per-call web
// search. Stale data is fine — trends don't change minute-to-minute.
const INDUSTRY_SIGNALS_LIMIT = 8;
const INDUSTRY_SIGNALS_MAX_AGE_DAYS = 7;

// brand_kits / accounts don't currently have country or timezone columns.
// Defaults match L+R Studio's reality: India-based agency, Asia/Kolkata
// timezone. Once we add a second brand in a different market, plumb
// columns through accounts (or brand_kits) and the helper will pick them
// up automatically.
const DEFAULT_COUNTRY = 'IN';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function getBrandLocale(brandKit, account) {
  return {
    country:
      brandKit?.primary_market ||
      brandKit?.country ||
      account?.country ||
      DEFAULT_COUNTRY,
    timezone:
      brandKit?.timezone ||
      account?.timezone ||
      DEFAULT_TIMEZONE,
  };
}

export async function loadAndCompileBrandContext(supabaseClient, accountId, options = {}) {
  if (!supabaseClient) throw new Error('supabaseClient required');
  if (!accountId) throw new Error('accountId required');

  // Opt-IN, not opt-out. Inline copy / image / suggestions routes pass
  // no options and skip the expensive calendar/engagement queries.
  // Only the chat route asks for them explicitly.
  const includeCalendar = options.includeCalendar === true;

  // The base queries — always run.
  const baseQueries = [
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
  ];

  // Calendar/engagement extras — gated by options.includeCalendar.
  //
  // Use a single date string (today, brand-local) for the upcoming-plans
  // floor. We accept some slop on the boundary (brand-local vs UTC) because
  // the model only sees day-resolution anyway. Anything stricter would
  // need brand_kits.timezone wired through, which we're deferring.
  const todayIso = new Date().toISOString();
  // Industry signals stale-cutoff: only show snapshots fresher than 7d.
  // Older trends aren't useful for "what should I post this week" and
  // would only confuse the model.
  const signalsCutoffIso = new Date(Date.now() - INDUSTRY_SIGNALS_MAX_AGE_DAYS * 86400_000).toISOString();

  const calendarQueries = includeCalendar
    ? [
        supabaseClient
          .from('post_plans')
          .select('id, concept, copy_variants, platforms, scheduled_at, status, ai_generated')
          .eq('account_id', accountId)
          .gte('scheduled_at', todayIso)
          .order('scheduled_at', { ascending: true })
          .limit(UPCOMING_PLANS_LIMIT),
        // Recently published — for engagement signal. We over-fetch a bit
        // because we filter to this brand's plans below; the publications
        // table doesn't carry account_id directly.
        supabaseClient
          .from('post_plan_publications')
          .select(
            'id, post_plan_id, platform, live_url, published_at, post_plans!inner(id, account_id, concept, copy_variants, platforms)',
          )
          .eq('post_plans.account_id', accountId)
          .order('published_at', { ascending: false })
          .limit(PUBLICATIONS_LIMIT),
        // Industry signals — from the daily cron's Firecrawl /search
        // results. The cron writes snapshots into brand_trend_snapshots.
        // We pull the latest non-failed rows, capped to a freshness
        // window so stale trends don't ride along forever if the cron
        // is broken.
        supabaseClient
          .from('brand_trend_snapshots')
          .select('id, query, source_url, title, summary, published_at, fetched_at, scrape_status')
          .eq('account_id', accountId)
          .neq('scrape_status', 'failed')
          .gte('fetched_at', signalsCutoffIso)
          .order('fetched_at', { ascending: false })
          .limit(INDUSTRY_SIGNALS_LIMIT * 3), // over-fetch then dedupe by URL
      ]
    : [];

  const results = await Promise.all([...baseQueries, ...calendarQueries]);
  const [kitResult, notesResult, plansResult, upcomingResult, pubsResult, signalsResult] = results;

  if (kitResult.error) throw kitResult.error;

  // For each publication, get the latest engagement snapshot. Single
  // query, filtered by publication_id IN (...). Then dedupe to the most
  // recent per publication in-memory.
  let snapshotsByPublication = {};
  const publications = pubsResult?.data || [];
  if (publications.length) {
    const pubIds = publications.map((p) => p.id);
    const { data: snapshots } = await supabaseClient
      .from('post_engagement_snapshots')
      .select('publication_id, like_count, comment_count, share_count, save_count, view_count, reaction_count, engagement_rate, fetched_at, scrape_status')
      .in('publication_id', pubIds)
      .order('fetched_at', { ascending: false });
    for (const snap of snapshots || []) {
      if (snap.scrape_status !== 'ok' && snap.scrape_status !== 'partial') continue;
      if (snapshotsByPublication[snap.publication_id]) continue; // already have newer
      snapshotsByPublication[snap.publication_id] = snap;
    }
  }

  // Dedupe industry signals by URL — same article can show up across
  // queries on the same day (industry-trends + hashtag-pulse often
  // overlap). Keep the newest version of each URL.
  const signalsRaw = signalsResult?.data || [];
  const signalsByUrl = new Map();
  for (const s of signalsRaw) {
    const url = s.source_url;
    if (!url) continue;
    if (signalsByUrl.has(url)) continue;
    signalsByUrl.set(url, s);
  }
  const industrySignals = Array.from(signalsByUrl.values()).slice(0, INDUSTRY_SIGNALS_LIMIT);

  return compileBrandContext({
    brandKit: kitResult.data,
    notes: notesResult.data || [],
    recentApprovedPlans: plansResult?.data || [],
    upcomingPlans: upcomingResult?.data || [],
    publications,
    snapshotsByPublication,
    industrySignals,
    includeCalendar,
  });
}

export function compileBrandContext({
  brandKit,
  notes = [],
  recentApprovedPlans = [],
  upcomingPlans = [],
  publications = [],
  snapshotsByPublication = {},
  industrySignals = [],
  includeCalendar = false,
  now,
} = {}) {
  if (!brandKit) return '';

  const sections = [];
  const name = brandKit.account?.name || 'this brand';
  const locale = getBrandLocale(brandKit, brandKit.account);

  // `now` overridable for deterministic tests. Defaults to wall-clock.
  const today = now ? new Date(now) : new Date();

  sections.push(`# Brand: ${name}`);

  // ----- ## Today --------------------------------------------------------
  // Stays small (5-10 lines) but anchors the model: what is the actual
  // date, what's coming up culturally, and what timezone defaults should
  // it use for new post plans.
  sections.push(todaySection({ today, locale }));

  // ----- identity / voice / strategy / visual ---------------------------
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

  // ----- calendar + engagement (opt-in) ---------------------------------
  // These are the blocks that make the model proactive. We gate them
  // behind includeCalendar so the inline-copy and image routes don't pay
  // for context they can't act on.
  if (includeCalendar) {
    const calendar = calendarSection({ upcomingPlans, today });
    if (calendar) sections.push(calendar);

    const cadence = cadenceSection({ publications, today });
    if (cadence) sections.push(cadence);

    const performers = topPerformersSection({ publications, snapshotsByPublication });
    if (performers) sections.push(performers);

    const anchors = voiceAnchorsSection({ publications, snapshotsByPublication });
    if (anchors) sections.push(anchors);

    const signals = industrySignalsSection({ industrySignals, today });
    if (signals) sections.push(signals);
  }

  // Past approved plans (style references) — always included. The voice
  // anchors above outrank these when both exist, but anchors require
  // engagement data which may not be there yet for a new brand.
  const examplesBlock = recentPlansSection(recentApprovedPlans);
  if (examplesBlock) sections.push(examplesBlock);

  return sections.join('\n\n');
}

// ---------- ## Today ---------------------------------------------------

function todaySection({ today, locale }) {
  const lines = [];
  const dateStr = formatDateInTimezone(today, locale.timezone);
  const dayName = formatDayInTimezone(today, locale.timezone);
  const weekOfYear = isoWeekOfYear(today);
  lines.push(`Date: ${dateStr} (${dayName})`);
  lines.push(`Brand timezone: ${locale.timezone}`);
  lines.push(`Primary market: ${locale.country}`);
  lines.push(`Week of year: W${weekOfYear}`);

  const moments = getUpcomingMoments({
    from: today,
    days: HOLIDAY_LOOKAHEAD_DAYS,
    country: locale.country,
  });
  if (moments.length) {
    lines.push('');
    lines.push(`Upcoming moments (next ${HOLIDAY_LOOKAHEAD_DAYS} days):`);
    for (const m of moments) {
      lines.push(`- ${m.date} (+${m.daysAway}d): ${m.name} [${m.tags.join(', ')}]`);
    }
  }
  return `## Today\n${lines.join('\n')}`;
}

// ---------- ## Upcoming calendar --------------------------------------

function calendarSection({ upcomingPlans, today }) {
  if (!Array.isArray(upcomingPlans) || !upcomingPlans.length) {
    // Explicit empty block so the model knows the calendar is empty —
    // a major signal that there are gaps to fill.
    return `## Upcoming calendar\n(The next 30 days are empty — no scheduled posts. This is a high-priority gap.)`;
  }

  const todayMs = startOfDayMs(today);
  const oneDayMs = 24 * 60 * 60 * 1000;

  const buckets = { detail: [], compact: [] };
  for (const plan of upcomingPlans) {
    const ts = new Date(plan.scheduled_at).getTime();
    const daysOut = Math.round((startOfDayMs(new Date(ts)) - todayMs) / oneDayMs);
    if (daysOut <= 7) buckets.detail.push({ plan, daysOut });
    else if (daysOut <= 30) buckets.compact.push({ plan, daysOut });
  }

  const lines = [];

  if (buckets.detail.length) {
    lines.push('### Next 7 days (full detail)');
    for (const { plan, daysOut } of buckets.detail) {
      const when = formatScheduledShort(plan.scheduled_at);
      const platforms = Array.isArray(plan.platforms) ? plan.platforms.join('/') : '';
      const status = plan.status || 'unknown';
      const concept = plan.concept || '(no concept yet)';
      const ai = plan.ai_generated ? ' [AI draft]' : '';
      lines.push(`- ${when} (+${daysOut}d) · ${platforms} · ${status}${ai}: ${concept}`);
    }
  } else {
    lines.push('### Next 7 days');
    lines.push('(empty — high-priority gap)');
  }

  if (buckets.compact.length) {
    lines.push('');
    lines.push('### Days 8-30 (compact)');
    // Group by ISO week start (Monday) for compactness.
    const byWeek = {};
    for (const { plan, daysOut } of buckets.compact) {
      const weekKey = isoWeekKey(new Date(plan.scheduled_at));
      if (!byWeek[weekKey]) byWeek[weekKey] = [];
      byWeek[weekKey].push({ plan, daysOut });
    }
    const sortedWeeks = Object.keys(byWeek).sort();
    for (const wk of sortedWeeks) {
      const items = byWeek[wk];
      const platformCounts = {};
      for (const { plan } of items) {
        for (const p of plan.platforms || []) {
          platformCounts[p] = (platformCounts[p] || 0) + 1;
        }
      }
      const summary = Object.entries(platformCounts)
        .map(([p, c]) => `${c} ${p}`)
        .join(', ') || 'none';
      lines.push(`- ${wk}: ${items.length} plan${items.length === 1 ? '' : 's'} (${summary})`);
    }
  }

  return `## Upcoming calendar\n${lines.join('\n')}`;
}

// ---------- ## Cadence (last 30 days, by platform) --------------------

function cadenceSection({ publications, today }) {
  if (!Array.isArray(publications) || !publications.length) return null;

  const todayMs = startOfDayMs(today);
  const oneDayMs = 24 * 60 * 60 * 1000;
  const thirtyDaysAgoMs = todayMs - 30 * oneDayMs;

  const byPlatform = {};
  for (const pub of publications) {
    const tMs = new Date(pub.published_at).getTime();
    if (tMs < thirtyDaysAgoMs) continue;
    const platform = pub.platform;
    if (!byPlatform[platform]) byPlatform[platform] = { count: 0, lastTs: 0 };
    byPlatform[platform].count += 1;
    byPlatform[platform].lastTs = Math.max(byPlatform[platform].lastTs, tMs);
  }

  const platforms = Object.keys(byPlatform);
  if (!platforms.length) return null;

  const lines = [];
  for (const p of platforms) {
    const info = byPlatform[p];
    const daysSinceLast = Math.round((todayMs - info.lastTs) / oneDayMs);
    const gap = daysSinceLast >= 7 ? '  ⚠ GAP' : '';
    lines.push(`- ${p}: ${info.count} post${info.count === 1 ? '' : 's'} in last 30d · last ${daysSinceLast}d ago${gap}`);
  }

  return `## Cadence (last 30 days)\n${lines.join('\n')}`;
}

// ---------- ## Top performers (last 90d by engagement) ----------------

function topPerformersSection({ publications, snapshotsByPublication }) {
  const scored = publications
    .map((pub) => {
      const snap = snapshotsByPublication[pub.id];
      if (!snap) return null;
      const score =
        (snap.like_count || 0) +
        (snap.comment_count || 0) * 3 +
        (snap.share_count || 0) * 4 +
        (snap.save_count || 0) * 4 +
        (snap.reaction_count || 0);
      if (score <= 0) return null;
      return { pub, snap, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_PERFORMERS_COUNT);

  if (!scored.length) return null;

  const lines = scored.map(({ pub, snap }) => {
    const plan = pub.post_plans || {};
    const concept = plan.concept || '(no concept)';
    const copy = plan.copy_variants || {};
    const platformCopy = copy[pub.platform];
    const copyPreview = typeof platformCopy === 'string'
      ? truncate(platformCopy, COPY_PREVIEW_CHARS)
      : typeof platformCopy === 'object' && platformCopy
      ? truncate(platformCopy.body || platformCopy.text || '', COPY_PREVIEW_CHARS)
      : '';
    const metrics = [
      snap.like_count != null && `${snap.like_count} likes`,
      snap.comment_count != null && `${snap.comment_count} comments`,
      snap.share_count != null && `${snap.share_count} shares`,
      snap.save_count != null && `${snap.save_count} saves`,
      snap.reaction_count != null && `${snap.reaction_count} reactions`,
    ].filter(Boolean).join(' · ');
    const out = [`- ${pub.platform} · ${pub.published_at.slice(0, 10)} · ${metrics}`];
    if (concept) out.push(`  Concept: ${concept}`);
    if (copyPreview) out.push(`  Copy: ${copyPreview}`);
    return out.join('\n');
  });

  return `## Top performers (recent, ranked by engagement)\n${lines.join('\n')}`;
}

// ---------- ## Voice anchors (hooks from top-engagement posts) --------

function voiceAnchorsSection({ publications, snapshotsByPublication }) {
  const scored = publications
    .map((pub) => {
      const snap = snapshotsByPublication[pub.id];
      if (!snap) return null;
      const score =
        (snap.like_count || 0) +
        (snap.comment_count || 0) * 3 +
        (snap.share_count || 0) * 4 +
        (snap.save_count || 0) * 4 +
        (snap.reaction_count || 0);
      if (score <= 0) return null;
      const copy = pub.post_plans?.copy_variants || {};
      const platformCopy = copy[pub.platform];
      const text = typeof platformCopy === 'string'
        ? platformCopy
        : platformCopy?.body || platformCopy?.text || '';
      if (!text) return null;
      const hook = extractFirstLine(text);
      if (!hook) return null;
      return { hook, platform: pub.platform, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, VOICE_ANCHORS_COUNT);

  if (!scored.length) return null;

  const lines = scored.map((s) => `- (${s.platform}) ${s.hook}`);
  return `## Voice anchors (opening lines of top-performing recent posts)\n${lines.join('\n')}`;
}

// ---------- ## Industry signals (Firecrawl /search cache) ------------

function industrySignalsSection({ industrySignals, today }) {
  if (!Array.isArray(industrySignals) || !industrySignals.length) return null;

  const lines = [];
  lines.push(
    "External news + trend articles relevant to this brand, refreshed daily. Use these to ground proactive suggestions in what's actually happening in the brand's world right now. Don't fabricate context that isn't here — if the admin asks about a topic NOT covered, call the web_search tool.",
  );
  lines.push('');

  const todayMs = today instanceof Date ? today.getTime() : new Date(today).getTime();
  for (const s of industrySignals) {
    const fetchedMs = s.fetched_at ? new Date(s.fetched_at).getTime() : NaN;
    const ageDays = Number.isFinite(fetchedMs)
      ? Math.max(0, Math.round((todayMs - fetchedMs) / 86400_000))
      : null;
    const ageTag = ageDays == null
      ? ''
      : ageDays === 0
        ? '(today)'
        : ageDays === 1
          ? '(yesterday)'
          : `(${ageDays}d ago)`;
    const title = (s.title || s.source_url || '(untitled)').trim().slice(0, 200);
    const summary = (s.summary || '').trim();
    const url = s.source_url || '';
    lines.push(`- ${ageTag} **${title}**`);
    if (summary) lines.push(`  ${truncate(summary, 280)}`);
    if (url) lines.push(`  source: ${url}`);
  }

  return `## Industry signals (recent trend articles)\n${lines.join('\n')}`;
}

// ---------- existing helpers (unchanged) ------------------------------

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

// ---------- date helpers (locale-aware) -------------------------------

function formatDateInTimezone(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatDayInTimezone(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    }).format(date);
  } catch {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }
}

// ISO 8601 week number — Mon-first week, week 1 contains Jan 4.
function isoWeekOfYear(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = d - firstThursday;
  return 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
}

function isoWeekKey(date) {
  const week = isoWeekOfYear(date);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function startOfDayMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function formatScheduledShort(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const day = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString('en-US', { month: 'short' });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${hh}:${mm}`;
}

function extractFirstLine(text) {
  if (!text) return '';
  const first = String(text).split(/\r?\n/)[0].trim();
  return truncate(first, 200);
}
