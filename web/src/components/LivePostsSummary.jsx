/* eslint-disable */
/* LivePostsSummary — engagement KPI strip on /c/:slug/posts.
   Sits between the page-head and the filter pills.

   Layout:
     - Period picker top-right (7d / 30d / 90d / All, default 30d)
     - 3 KPI tiles: engagement / engagement-per-post / posts
       Each with a 24px sparkline + 3 deltas (yesterday / week / month).
       The middle tile was previously "Engagement rate" (a single %),
       but at brand level the math is fundamentally broken when only
       a subset of platforms expose view counts: numerator gets all
       engagement, denominator gets views-from-IG-video-and-X-only,
       producing >100% rates that misrepresent the brand. "Engagement
       per post" works for every platform regardless of view coverage.
       True engagement rate (as %) moved to per-platform rows where
       the math is honest (see PlatformRow).
     - "By platform" rows: IG / LinkedIn / X — only renders platforms
       with at least 1 publication. Per-platform engagement rate chip
       appears only when every in-scope post on that platform reports
       view counts (rateBasis === 'all').

   Data: single read via loadEngagementSummaryForBrand() — see db.js
   for the math. All computation client-side from cumulative snapshots.

   Period stored in localStorage.lr_live_posts_summary_period so the
   user's choice persists across reloads. */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { loadEngagementSummaryForBrand } from '../lib/db.js';
import { Icon } from './Icon.jsx';

const PERIOD_OPTIONS = [
  { value: 7,     label: 'Last 7 days' },
  { value: 30,    label: 'Last 30 days' },
  { value: 90,    label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];
const PERIOD_STORAGE_KEY = 'lr_live_posts_summary_period';

const PLATFORM_META = {
  instagram: { label: 'Instagram', dotColor: '#DD2A7B' },
  linkedin:  { label: 'LinkedIn',  dotColor: '#0A66C2' },
  x:         { label: 'X',         dotColor: '#000000' },
};

// Per-platform metric DISPLAY ORDER. Order = priority of importance for
// that platform's audience. The actual availability comes from
// summary.byPlatform[platform].metrics — a metric value of `null` means
// the scraper doesn't return it, so we hide the chip rather than render
// "—". This list says what to TRY to render; nulls drop out.
const PLATFORM_METRIC_DISPLAY = {
  instagram: ['likes', 'comments', 'views'],
  linkedin:  ['likes', 'comments', 'shares'],
  x:         ['likes', 'comments', 'shares', 'views', 'bookmarks'],
};

// Single-glyph icons per metric so per-platform chips read as a quick
// scan rather than a list of words. Heart / chat-bubble / repost-arrow
// / eye / bookmark-corner — kept ASCII-friendly so they render in every
// email + system font without needing emoji support.
const METRIC_ICON = {
  likes:     '♥',   // ♥
  comments:  '\u{1F4AC}', // 💬
  shares:    '⇱',   // ⇱  (close-enough for "repost")
  saves:     '⚑',   // ⚐
  views:     '\u{1F441}', // 👁
  bookmarks: '\u{1F516}', // 🔖
};
const METRIC_LABEL_LONG = {
  likes:     'likes',
  comments:  'comments',
  shares:    'shares',
  saves:     'saves',
  views:     'views',
  bookmarks: 'bookmarks',
};

const DELTA_FLAT_THRESHOLD_PCT = 5; // |Δ%| < 5 renders as "flat"
const DELTA_FLAT_THRESHOLD_PP  = 0.5; // |Δ ratePoints| < 0.5pp renders as flat

// ---------- Formatting helpers ---------------------------------------

function formatCount(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return (n / 1000).toFixed(0) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function formatRate(n) {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(2).replace(/\.?0+$/, '') + '%';
}

function formatPct(n) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(0)}%`;
}

// Average engagement per post — a brand-level KPI that works regardless
// of which platforms report view counts (replaced "Engagement rate" as
// the middle KPI tile on 2026-05-26). One decimal looks natural for a
// per-post value (e.g. "18.6"); strip the ".0" when the value is whole.
function formatPerPost(n) {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(1).replace(/\.0$/, '');
}

function formatIntDelta(n) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}`;
}

function trendKind(value, kind) {
  if (value == null || !isFinite(value)) return 'na';
  const threshold = kind === 'pct' ? DELTA_FLAT_THRESHOLD_PCT
                  : kind === 'pp'  ? DELTA_FLAT_THRESHOLD_PP
                  : 0;
  if (Math.abs(value) < threshold) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function TrendArrow({ kind }) {
  if (kind === 'up')   return <span className="lps-arrow lps-arrow-up">▲</span>;
  if (kind === 'down') return <span className="lps-arrow lps-arrow-down">▼</span>;
  if (kind === 'flat') return <span className="lps-arrow lps-arrow-flat">─</span>;
  return <span className="lps-arrow lps-arrow-na">—</span>;
}

// ---------- Sparkline component --------------------------------------
// Hand-rolled inline SVG. Accepts a series of { date, value } points.
// `value === null` means "no data for this day" — the path breaks at
// those points (Move instead of Line) so the line shows a visible gap
// rather than dropping to zero. Used by the rate sparkline where days
// with 0 views can't produce a rate.
function Sparkline({ data, width = 120, height = 24, color = 'var(--accent)' }) {
  if (!data || data.length === 0) {
    return <div className="lps-spark-empty" style={{ width, height }} />;
  }
  const numericValues = data.map((d) => (typeof d.value === 'number' ? d.value : null));
  const definedValues = numericValues.filter((v) => v !== null);
  if (definedValues.length === 0) {
    return <div className="lps-spark-empty" style={{ width, height }} />;
  }

  const max = Math.max(...definedValues, 1);
  const min = Math.min(...definedValues, 0);
  const range = Math.max(1, max - min);
  const step = width / Math.max(1, numericValues.length - 1);
  const padTop = 2;
  const padBottom = 2;
  const innerH = height - padTop - padBottom;

  // Build path with breaks: M for null-following segments, L otherwise.
  let path = '';
  let lastPoint = null;
  for (let i = 0; i < numericValues.length; i++) {
    const v = numericValues[i];
    if (v === null) continue;
    const x = i * step;
    const y = padTop + innerH - ((v - min) / range) * innerH;
    // Start a new sub-path if the previous point was null or this is the first defined value.
    const prevDefined = i > 0 && numericValues[i - 1] !== null;
    path += `${prevDefined && path ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)} `;
    lastPoint = [x, y];
  }

  return (
    <svg
      className="lps-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path d={path.trim()} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {lastPoint && (
        <circle cx={lastPoint[0]} cy={lastPoint[1]} r="2" fill={color} />
      )}
    </svg>
  );
}

// ---------- Period picker --------------------------------------------
function PeriodPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = PERIOD_OPTIONS.find((o) => o.value === value) || PERIOD_OPTIONS[1];

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="lps-period" ref={ref}>
      <button
        type="button"
        className="lps-period-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current.label}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="lps-period-menu" role="listbox">
          {PERIOD_OPTIONS.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={'lps-period-option' + (o.value === value ? ' is-active' : '')}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
              {o.value === value && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- KPI tile --------------------------------------------------
function KpiTile({ label, value, sparkData, deltas, valueAnnotation }) {
  return (
    <div className="lps-tile">
      <div className="lps-tile-value">{value}</div>
      {valueAnnotation && <div className="lps-tile-annotation">{valueAnnotation}</div>}
      <div className="lps-tile-label">{label}</div>
      <div className="lps-tile-spark">
        <Sparkline data={sparkData || []} width={140} height={24} />
      </div>
      <div className="lps-tile-deltas">
        {deltas.map((d) => (
          <div key={d.label} className="lps-tile-delta">
            <TrendArrow kind={d.kind} />
            <span className={'lps-delta-value lps-delta-' + d.kind}>{d.display}</span>
            <span className="lps-delta-label">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Per-platform row -----------------------------------------
// Renders one row per platform: name + post count + per-metric chip
// strip (only metrics the scraper actually returns for that platform —
// no "—" placeholders for missing data) + mini-sparkline + week-over-
// week % change.
function PlatformRow({ platform, info }) {
  const meta = PLATFORM_META[platform];
  if (!meta || !info) return null;
  const trend = trendKind(info.deltaWeek, 'pct');

  // Order the chips by the per-platform priority list; drop metrics
  // where the helper returned null (scraper doesn't expose the field).
  const displayOrder = PLATFORM_METRIC_DISPLAY[platform] || [];
  const metricsToShow = displayOrder
    .map((m) => ({ key: m, value: info.metrics?.[m] }))
    .filter((m) => m.value != null);

  // Engagement rate (true %) — render ONLY when math is honest, i.e.
  // every in-scope publication on this platform reported view counts.
  // rateBasis === 'all' means: 100% view-data coverage for this
  // platform's posts in the period. Common cases:
  //   - X:         usually 'all' (X tweets reliably expose view_count)
  //   - IG-video:  'all' when the brand only posts Reels/videos
  //   - IG-mixed:  'partial' when a brand posts both Reels + photos →
  //                hide the rate to avoid the same inflation that
  //                broke the old brand-level rate KPI
  //   - LinkedIn:  always null (no view data ever) → no rate shown
  const showRate = info.rateBasis === 'all' && info.rate != null;

  return (
    <div className="lps-platform-row">
      <div className="lps-platform-name">
        <span className="lps-platform-dot" style={{ background: meta.dotColor }} />
        {meta.label}
      </div>
      <div className="lps-platform-posts">
        {info.posts} {info.posts === 1 ? 'post' : 'posts'}
      </div>
      <div className="lps-platform-metrics">
        {metricsToShow.length === 0 ? (
          <span className="lps-platform-no-data">No metrics in this window</span>
        ) : (
          metricsToShow.map((m) => (
            <span key={m.key} className="lps-platform-metric" title={`${formatCount(m.value)} ${METRIC_LABEL_LONG[m.key]} gained in this window`}>
              <span className="lps-platform-metric-icon" aria-hidden="true">{METRIC_ICON[m.key]}</span>
              <span className="lps-platform-metric-val">{formatCount(m.value)}</span>
            </span>
          ))
        )}
        {showRate && (
          <span
            className="lps-platform-metric lps-platform-rate"
            title={`Engagement rate = engagement ${formatCount(info.engagement)} ÷ views ${formatCount(info.views)} × 100. Calculated only when every in-scope post on this platform reports view counts.`}
          >
            <span className="lps-platform-metric-icon" aria-hidden="true">📊</span>
            <span className="lps-platform-metric-val">{formatRate(info.rate)}</span>
          </span>
        )}
      </div>
      <div className="lps-platform-spark">
        <Sparkline data={info.sparklineDaily || []} width={100} height={20} />
      </div>
      <div className={'lps-platform-delta lps-delta-' + trend}>
        <TrendArrow kind={trend} />
        <span>{formatPct(info.deltaWeek)}</span>
        <span className="lps-delta-label">vs last week</span>
      </div>
    </div>
  );
}

// ---------- Main component -------------------------------------------
export function LivePostsSummary({ accountId, refreshSignal = 0 }) {
  const [period, setPeriod] = useState(() => {
    try {
      const stored = localStorage.getItem(PERIOD_STORAGE_KEY);
      if (stored === 'all') return 'all';
      const num = stored ? parseInt(stored, 10) : NaN;
      return [7, 30, 90].includes(num) ? num : 30;
    } catch {
      return 30;
    }
  });
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Persist period choice.
  useEffect(() => {
    try { localStorage.setItem(PERIOD_STORAGE_KEY, String(period)); } catch {}
  }, [period]);

  // Fetch on mount + brand-change + period-change + when a new engagement
  // snapshot lands (refreshSignal bumps from the parent's realtime handler).
  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    loadEngagementSummaryForBrand(accountId, period)
      .then((s) => { if (!cancelled) { setSummary(s); setLoading(false); } })
      .catch((e) => {
        if (!cancelled) {
          console.warn('engagement summary load failed', e);
          setError(e?.message || String(e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [accountId, period, refreshSignal]);

  const tiles = useMemo(() => {
    if (!summary || summary.isEmpty) return null;
    const { period: p, deltas, sparklines } = summary;
    const engKinds = {
      yesterday: trendKind(deltas.vsYesterday.engagement, 'pct'),
      week:      trendKind(deltas.vsLastWeek.engagement, 'pct'),
      month:     trendKind(deltas.vsLastMonth.engagement, 'pct'),
    };
    // Per-post deltas use the same 'pct' classification as the
    // engagement tile — both are continuous % changes, not pp deltas.
    const perPostKinds = {
      yesterday: trendKind(deltas.vsYesterday.avgPerPost, 'pct'),
      week:      trendKind(deltas.vsLastWeek.avgPerPost, 'pct'),
      month:     trendKind(deltas.vsLastMonth.avgPerPost, 'pct'),
    };
    const postsKinds = {
      yesterday: trendKind(deltas.vsYesterday.postsCount, 'int'),
      week:      trendKind(deltas.vsLastWeek.postsCount, 'int'),
      month:     trendKind(deltas.vsLastMonth.postsCount, 'int'),
    };
    return {
      engagement: {
        value: formatCount(p.engagement),
        label: 'Engagement',
        sparkData: sparklines?.engagement || [],
        deltas: [
          { label: 'vs yesterday',   kind: engKinds.yesterday, display: formatPct(deltas.vsYesterday.engagement) },
          { label: 'vs last week',   kind: engKinds.week,      display: formatPct(deltas.vsLastWeek.engagement) },
          { label: 'vs last month',  kind: engKinds.month,     display: formatPct(deltas.vsLastMonth.engagement) },
        ],
      },
      // "Engagement per post" replaces the older "Engagement rate" KPI.
      // The old rate rollup divided engagement-from-all-posts by
      // views-from-IG-video-and-X-only, which routinely produced
      // values >100% when LinkedIn / IG-photo engagement got divided
      // by IG-video-only view counts. The new metric works for every
      // platform regardless of view availability. True engagement rate
      // (as a %) still appears in the "By platform" section below for
      // platforms where the math is honest (all in-scope pubs report
      // views).
      avgPerPost: {
        value: formatPerPost(p.avgEngagementPerPost),
        label: 'Engagement per post',
        sparkData: sparklines?.avgPerPost || [],
        deltas: [
          { label: 'vs yesterday',  kind: perPostKinds.yesterday, display: formatPct(deltas.vsYesterday.avgPerPost) },
          { label: 'vs last week',  kind: perPostKinds.week,      display: formatPct(deltas.vsLastWeek.avgPerPost) },
          { label: 'vs last month', kind: perPostKinds.month,     display: formatPct(deltas.vsLastMonth.avgPerPost) },
        ],
      },
      posts: {
        value: String(p.postsCount),
        label: 'Posts',
        sparkData: sparklines?.posts || [],
        deltas: [
          { label: 'vs yesterday',  kind: postsKinds.yesterday, display: formatIntDelta(deltas.vsYesterday.postsCount) },
          { label: 'vs last week',  kind: postsKinds.week,      display: formatIntDelta(deltas.vsLastWeek.postsCount) },
          { label: 'vs last month', kind: postsKinds.month,     display: formatIntDelta(deltas.vsLastMonth.postsCount) },
        ],
      },
    };
  }, [summary]);

  // Don't render anything if no brand context.
  if (!accountId) return null;

  // Loading skeleton: a soft placeholder so layout doesn't jump.
  if (loading && !summary) {
    return (
      <div className="lps-wrap">
        <div className="lps-header">
          <div className="lps-title">Engagement summary</div>
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
        <div className="lps-skeleton">
          <div className="lps-skel-tile" /><div className="lps-skel-tile" /><div className="lps-skel-tile" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lps-wrap">
        <div className="lps-header">
          <div className="lps-title">Engagement summary</div>
        </div>
        <div className="lps-error">Couldn't load engagement summary: {error}</div>
      </div>
    );
  }

  if (!summary || summary.isEmpty) {
    return (
      <div className="lps-wrap lps-wrap-empty">
        <div className="lps-header">
          <div className="lps-title">Engagement summary</div>
        </div>
        <div className="lps-empty">
          No live posts yet. Mark a post plan as posted (with its live URL) to start tracking engagement here.
        </div>
      </div>
    );
  }

  return (
    <div className="lps-wrap">
      <div className="lps-header">
        <div className="lps-title">Engagement summary</div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      <div className="lps-tiles">
        <KpiTile {...tiles.engagement} />
        <KpiTile {...tiles.avgPerPost} />
        <KpiTile {...tiles.posts} />
      </div>

      <div className="lps-divider" />

      <div className="lps-platforms">
        <div className="lps-platforms-label">By platform</div>
        {['instagram', 'linkedin', 'x'].map((platform) => (
          summary.byPlatform[platform] && (
            <PlatformRow key={platform} platform={platform} info={summary.byPlatform[platform]} />
          )
        ))}
        {Object.keys(summary.byPlatform).length === 0 && (
          <div className="lps-platforms-empty">No platform-level data in this window.</div>
        )}
      </div>
    </div>
  );
}
