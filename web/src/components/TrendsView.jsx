/* eslint-disable */
/* TrendsView — agency-only "Trends Radar" surface, brand-scoped at
   /c/:slug/trends as of 2026-05-06.
   Compartmentalized away from the rest of the dashboard:
   - Reads from public.trend_signals filtered by the active brand
   - Refetch via the fetch-trends edge function (agency-only)
   - Owns the "turn into post plan" CTA per trend card
   The IG tab feeds the brand's competitor reels through the
   audio-velocity pipeline (Phase B/C/D); TikTok + X stay region-based. */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { loadTrendSignals, refreshTrends, loadBrandKit } from '../lib/db.js';
import { TurnIntoPostPlanModal } from './TurnIntoPostPlanModal.jsx';

// Country code → display label. Easy to extend; the same codes drive the
// edge function's region whitelist.
const REGION_LABELS = {
  US: 'United States',
  IN: 'India',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
};
const DEFAULT_REGIONS = Object.keys(REGION_LABELS);

const PLATFORMS = [
  { key: 'tiktok',    label: 'TikTok',    available: true,  icon: 'sparkles' },
  { key: 'twitter',   label: 'X / Twitter', available: true, icon: 'send' },
  { key: 'instagram', label: 'Instagram', available: true,  icon: 'image' },
  { key: 'linkedin',  label: 'LinkedIn',  available: false, icon: 'team' },
];

// Platforms that scrape per-brand (require an accountId in the request).
// Instagram only — TikTok and Twitter trends are region-global. Adding
// another per-brand platform here is a one-line change; the load + refresh
// paths read from this set, not a per-platform special case.
const PER_BRAND_PLATFORMS = new Set(['instagram']);

const KIND_LABEL = {
  hashtag: 'Hashtags',
  sound:   'Sounds',
  topic:   'Topics',
  post:    'Posts',
  creator: 'Creators',
};

// Per-platform kind filter options. The `all` pseudo-kind is always first.
// Keep this small and curated so the UI doesn't show empty filter chips for
// kinds the platform never produces (e.g. "Sounds" on Twitter).
const PLATFORM_KINDS = {
  tiktok:    ['all', 'hashtag', 'sound'],
  twitter:   ['all', 'hashtag', 'topic'],
  // IG produces audio rows now (kind='sound') from the competitor reel
  // pipeline. Old kind='post' rows from the pre-2026-05-06 handler age
  // out via the 14-day expiry; we don't list 'post' as a filter so the
  // user always lands on the new audio leaderboard.
  instagram: ['all', 'sound'],
  linkedin:  ['all', 'topic'],
};

// When the user clicks a platform tab, default the kind filter to the
// platform's most-useful view rather than 'all'. For IG that's 'sound'
// — every other platform sticks with 'all'.
const DEFAULT_KIND_FOR_PLATFORM = {
  instagram: 'sound',
};

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatMetric(value, label) {
  if (value == null) return label || '';
  let formatted;
  if (value >= 1_000_000_000) formatted = `${(value / 1_000_000_000).toFixed(1)}B`;
  else if (value >= 1_000_000) formatted = `${(value / 1_000_000).toFixed(1)}M`;
  else if (value >= 1_000)     formatted = `${(value / 1_000).toFixed(1)}K`;
  else                          formatted = String(value);
  return label ? `${formatted} ${label}` : formatted;
}

// Build a comma-joined "@handle, @handle, @handle + N more" string.
// Mirrors the server's formatHandles in fetch-trends.ts so cards
// render the same string whether we use the server's stored subtitle
// or this client-side derivation (which we do for IG audio rows so
// old DB rows render the new format without needing a fresh refresh).
function formatHandlesClient(handles, cap = 3) {
  if (!Array.isArray(handles) || handles.length === 0) return '';
  const at = handles.map((h) => `@${h}`);
  if (at.length <= cap) return at.join(', ');
  return `${at.slice(0, cap).join(', ')} + ${at.length - cap} more`;
}

function TrendCard({ trend, onTurnIntoPostPlan }) {
  const isHashtag = trend.kind === 'hashtag';
  const isAudio = trend.kind === 'sound';
  const display = isHashtag ? `#${trend.title}` : trend.title;

  // For IG audio rows, derive subtitle + metric from rawPayload so the
  // card always renders the latest format (artist · @handles · N reels +
  // "Featured by @aggregator" pill) regardless of when the row was last
  // upserted. The stored row.subtitle / row.metric_label still get
  // written by the server — they're a fallback for surfaces that don't
  // know about rawPayload (Turn-into-post-plan modal, future
  // notifications, etc).
  let subtitle = trend.subtitle;
  let metric = formatMetric(trend.metricValue, trend.metricLabel);
  if (isAudio && trend.rawPayload && typeof trend.rawPayload === 'object') {
    const rp = trend.rawPayload;
    const competitors = Array.isArray(rp.competitorHandles) ? rp.competitorHandles : [];
    const aggregators = Array.isArray(rp.aggregatorHandles) ? rp.aggregatorHandles : [];
    const reelCount = typeof rp.reelCount === 'number'
      ? rp.reelCount
      : (Array.isArray(rp.exampleReels) ? rp.exampleReels.length : 0);
    const subParts = [];
    if (rp.artistName) subParts.push(rp.artistName);
    if (competitors.length > 0) subParts.push(`Used by ${formatHandlesClient(competitors, 3)}`);
    if (reelCount > 0) subParts.push(`${reelCount} ${reelCount === 1 ? 'reel' : 'reels'}`);
    subtitle = subParts.join(' · ') || trend.subtitle;
    metric = aggregators.length > 0
      ? `Featured by ${formatHandlesClient(aggregators, 2)}`
      : '';
  }

  return (
    <div className="trend-card-wrap">
      <a
        className="trend-card"
        href={trend.url || undefined}
        target={trend.url ? '_blank' : undefined}
        rel={trend.url ? 'noreferrer noopener' : undefined}
        aria-disabled={!trend.url}
        onClick={(e) => { if (!trend.url) e.preventDefault(); }}
      >
        <div className="trend-card-rank">{trend.rank ? `#${trend.rank}` : ''}</div>
        <div className="trend-card-body">
          <div className="trend-card-title">{display}</div>
          {subtitle && (
            <div className="trend-card-sub">{subtitle}</div>
          )}
          {metric && (
            <div className="trend-card-metric">{metric}</div>
          )}
        </div>
      </a>
      <button
        className="trend-card-action"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onTurnIntoPostPlan?.(trend);
        }}
        title="Turn into post plan"
        aria-label={`Turn ${display} into a post plan`}
      >
        <Icon name="plus" size={14} />
        <span>Post plan</span>
      </button>
    </div>
  );
}

function EmptyState({ onRefresh, refreshing, hasError, platform, brandName }) {
  const headline = (() => {
    if (platform === 'tiktok')    return 'Pull the latest from TikTok';
    if (platform === 'twitter')   return "Pull what's trending on X right now";
    if (platform === 'instagram') return `Pull viral audio for ${brandName || 'this brand'}`;
    return 'Fetch the latest trends';
  })();
  const body = (() => {
    if (platform === 'tiktok')    return "We'll fetch trending hashtags and sounds for each region from TikTok Creative Center. Returns in ~10s per region.";
    if (platform === 'twitter')   return 'Real-time trending topics + hashtags by region. Returns in a few seconds.';
    if (platform === 'instagram') return "We'll scrape recent reels from this brand's competitors and category hashtags, then check which audios are climbing fast — so you can post a reel using a viral sound before it saturates.";
    return '';
  })();

  return (
    <div className="trends-empty">
      <div className="trends-empty-eyebrow">No trends captured yet</div>
      <h3 className="trends-empty-title">{headline}</h3>
      <p className="trends-empty-body">{body}</p>
      <button
        className="trends-refresh-btn primary"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <Icon name="refresh" size={14} />
        <span>{refreshing ? 'Fetching trends…' : 'Fetch trends now'}</span>
      </button>
      {hasError && (
        <div className="trends-empty-error">
          That last fetch failed. Open the console for details.
        </div>
      )}
    </div>
  );
}

const TrendsView = ({
  // The brand this Trends Radar surface is scoped to. Resolved by
  // App.jsx from the URL slug — trends-radar is brand-scoped now, so
  // there's always exactly one brand in context (or the surface
  // doesn't render at all).
  accountId,
  brandName,
  brandSlug,
  // Full brand list — only used by the Turn-into-post-plan modal so an
  // agency user can optionally re-target the new plan to a sister brand.
  // Defaults to the active brand so the common case is one click.
  brandAccounts = [],
  userId = null,
  setRoute,              // forwarded from App so we can deep-link to /brand
  navigateToPlan,        // (planId, brandSlug) => void
}) => {
  const [activePlatform, setActivePlatform] = useState('tiktok');
  const [activeRegion, setActiveRegion] = useState('US');
  const [activeKind, setActiveKind] = useState('all'); // 'all' | 'hashtag' | 'sound' | 'topic' | 'post'
  const [trends, setTrends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSummary, setRefreshSummary] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [turnTrend, setTurnTrend] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  // null = not yet checked, 0 = brand has no competitors, >0 = count.
  // Drives the missing-competitors banner on the IG tab so the user
  // sees a CTA into Brand Intelligence instead of an empty grid.
  const [competitorCount, setCompetitorCount] = useState(null);

  // IG always reads brand-scoped rows now. Other platforms stay global.
  const isPerBrand = PER_BRAND_PLATFORMS.has(activePlatform);

  // When the active brand changes (or on mount), peek at the brand kit
  // to know if competitors are populated. Only matters for IG since
  // that's the only platform whose pipeline depends on competitor
  // handles. Cheap RLS-protected read; no scraper calls.
  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setCompetitorCount(null);
      return () => {};
    }
    loadBrandKit(accountId)
      .then((kit) => {
        if (cancelled) return;
        const fromJsonb = Array.isArray(kit?.competitors) ? kit.competitors : [];
        const fromLegacy = Array.isArray(kit?.competitorHandles) ? kit.competitorHandles : [];
        const handles = new Set(
          [...fromJsonb.map((c) => c?.handle), ...fromLegacy]
            .map((h) => (typeof h === 'string' ? h.trim().replace(/^@/, '').toLowerCase() : ''))
            .filter((h) => h.length > 0)
        );
        setCompetitorCount(handles.size);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('loadBrandKit for trends competitor check failed', e);
        // Treat unknown as "has competitors" so we don't block the user
        // with a misleading CTA on a transient read failure.
        setCompetitorCount(null);
      });
    return () => { cancelled = true; };
  }, [accountId, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const args = {
      platform: activePlatform,
      accountId: isPerBrand ? accountId : null,
    };
    if (!isPerBrand) {
      args.region = activeRegion;
    }
    if (isPerBrand && !accountId) {
      setTrends([]);
      setLoading(false);
      return () => {};
    }
    loadTrendSignals(args)
      .then((rows) => { if (!cancelled) setTrends(rows); })
      .catch((e) => { if (!cancelled) console.warn('loadTrendSignals failed', e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePlatform, activeRegion, accountId, isPerBrand, reloadKey]);

  const visibleTrends = useMemo(() => {
    if (activeKind === 'all') return trends;
    return trends.filter((t) => t.kind === activeKind);
  }, [trends, activeKind]);

  const grouped = useMemo(() => {
    const out = new Map();
    for (const t of visibleTrends) {
      if (!out.has(t.kind)) out.set(t.kind, []);
      out.get(t.kind).push(t);
    }
    // Sort each bucket by rank if present, else by metric_value desc
    for (const list of out.values()) {
      list.sort((a, b) => {
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1;
        if (b.rank != null) return 1;
        return (b.metricValue || 0) - (a.metricValue || 0);
      });
    }
    return out;
  }, [visibleTrends]);

  const newestCapture = useMemo(() => {
    if (trends.length === 0) return null;
    return trends.reduce((latest, t) => {
      if (!latest) return t.capturedAt;
      return new Date(t.capturedAt) > new Date(latest) ? t.capturedAt : latest;
    }, null);
  }, [trends]);

  const onRefresh = async () => {
    if (isPerBrand && !accountId) {
      setRefreshError('No brand in context — open this from a brand sidebar.');
      return;
    }
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSummary(null);
    try {
      const args = { source: activePlatform };
      if (activePlatform === 'instagram') {
        // IG is always brand-scoped now. The fetch-trends API still
        // accepts `mode: 'competitors'` for backward-compat with the
        // pre-2026-05-06 handler; Phase B/C will replace this with
        // the seed-pool + audio-velocity pipeline and we can drop
        // `mode` entirely.
        args.mode = 'competitors';
        args.accountId = accountId;
      } else {
        args.regions = DEFAULT_REGIONS;
        args.window = '7d';
      }
      const result = await refreshTrends(args);
      setRefreshSummary(result);
      setReloadKey((k) => k + 1);
    } catch (ex) {
      console.error('refreshTrends failed', ex);
      setRefreshError(ex?.message || String(ex));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="trends-view">
      <header className="trends-header">
        <div className="trends-header-row">
          <div>
            <div className="trends-eyebrow">Trends Radar · agency only</div>
            <h2 className="trends-title">
              {brandName ? `Viral signal for ${brandName}` : "What's trending right now"}
            </h2>
            <p className="trends-sub">
              Live signal from social platforms — pick a trend and turn it into a post plan.
              {newestCapture && <span className="trends-stamp"> · last fetched {formatRelative(newestCapture)}</span>}
            </p>
          </div>
          <button
            className="trends-refresh-btn"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <Icon name="refresh" size={14} />
            <span>{refreshing ? 'Fetching…' : 'Refresh'}</span>
          </button>
        </div>

        <nav className="trends-platform-tabs" role="tablist">
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={activePlatform === p.key}
              disabled={!p.available}
              className={'trends-tab' + (activePlatform === p.key ? ' active' : '')}
              onClick={() => {
                if (!p.available) return;
                setActivePlatform(p.key);
                // Default kind per platform: IG lands on "Sounds" (the
                // useful audio leaderboard); other platforms reset to
                // "all" so the user doesn't see an empty grid because
                // the selected kind doesn't exist on the new platform.
                setActiveKind(DEFAULT_KIND_FOR_PLATFORM[p.key] || 'all');
              }}
            >
              <Icon name={p.icon} size={14} />
              <span>{p.label}</span>
              {!p.available && <span className="trends-tab-soon">soon</span>}
            </button>
          ))}
        </nav>

        <div className="trends-filter-row">
          {/* Region selector — only meaningful for region-scoped platforms
              (TikTok / Twitter). Instagram is brand-scoped now, so the
              region selector is hidden when on the IG tab. */}
          {!isPerBrand && (
            <div className="trends-filter">
              <label>Region</label>
              <select
                value={activeRegion}
                onChange={(e) => setActiveRegion(e.target.value)}
              >
                {DEFAULT_REGIONS.map((code) => (
                  <option key={code} value={code}>
                    {REGION_LABELS[code] || code} · {code}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="trends-filter">
            <label>Type</label>
            <div className="trends-kind-pills">
              {(PLATFORM_KINDS[activePlatform] || ['all']).map((k) => (
                <button
                  key={k}
                  className={'trends-kind-pill' + (activeKind === k ? ' active' : '')}
                  onClick={() => setActiveKind(k)}
                >
                  {k === 'all' ? 'All' : KIND_LABEL[k] || k}
                </button>
              ))}
            </div>
          </div>
        </div>

        {refreshSummary && (() => {
          // Collect every error message from per-region / per-kind summaries
          // so the agency can see what failed on the server (Apify timed out,
          // Firecrawl bot-walled, parse error, etc.). Without this surfacing,
          // a totally-failed refresh just shows "Wrote 0 signals" with no
          // hint why — which is exactly what bit us during diagnosis.
          const perRegionErrors = (refreshSummary.summaries || [])
            .flatMap((s) => {
              const tag = s.region || s.hashtag || '?';
              const errs = Array.isArray(s.errors) ? s.errors : [];
              return errs.map((e) => `${tag}: ${e}`);
            });
          const totalWritten = refreshSummary.written ?? 0;
          const isAllZero = totalWritten === 0 && perRegionErrors.length > 0;
          return (
            <div className={'trends-flash' + (isAllZero ? ' error' : '')}>
              <div>
                Wrote {totalWritten} signals across {refreshSummary.regions?.length ?? 0} region(s).
              </div>
              {perRegionErrors.length > 0 && (
                <details className="trends-flash-details">
                  <summary>{perRegionErrors.length} error{perRegionErrors.length === 1 ? '' : 's'} (click to expand)</summary>
                  <ul>
                    {perRegionErrors.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })()}
        {refreshError && (
          <div className="trends-flash error">
            Refresh failed: {refreshError}
          </div>
        )}
      </header>

      <div className="trends-body">
        {/* Missing-competitors banner: only shown on the IG tab when the
            brand kit's competitors list is empty. Pulls the user into
            Brand Intelligence to populate competitors before scraping —
            without competitors, the audio pipeline only has the global
            aggregator handles to work with (still some signal, but
            misses the brand-specific category trend). */}
        {activePlatform === 'instagram' && competitorCount === 0 && (
          <div className="trends-missing-competitors">
            <div className="trends-missing-competitors-icon" aria-hidden="true">
              <Icon name="brand" size={18} />
            </div>
            <div className="trends-missing-competitors-body">
              <h4>No competitors identified for {brandName || 'this brand'} yet</h4>
              <p>
                Viral-audio detection works best when we know who your competitors are
                — we'll cross-reference your brand's competitive set against
                aggregator-curated audios to surface what's about to blow up in your
                category. Add competitors in Brand Intelligence first; the brand-info
                pull populates them automatically.
              </p>
              <button
                className="trends-missing-competitors-cta"
                onClick={() => setRoute?.({ view: 'brand' })}
              >
                <Icon name="brand" size={14} />
                <span>Go to Brand Intelligence</span>
                <Icon name="chevron-right" size={12} />
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="trends-loading">Loading trends…</div>
        ) : visibleTrends.length === 0 ? (
          <EmptyState
            onRefresh={onRefresh}
            refreshing={refreshing}
            hasError={!!refreshError}
            platform={activePlatform}
            brandName={brandName}
          />
        ) : (
          <>
            {Array.from(grouped.entries()).map(([kind, items]) => (
              <section key={kind} className="trends-section">
                <h3 className="trends-section-title">
                  {KIND_LABEL[kind] || kind} <span className="trends-section-count">{items.length}</span>
                </h3>
                <div className="trends-grid">
                  {items.map((t) => (
                    <TrendCard
                      key={t.id}
                      trend={t}
                      onTurnIntoPostPlan={(trend) => setTurnTrend(trend)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      <TurnIntoPostPlanModal
        open={!!turnTrend}
        trend={turnTrend}
        brandAccounts={brandAccounts}
        defaultAccountId={accountId}
        userId={userId}
        onClose={() => setTurnTrend(null)}
        onCreated={(plan) => {
          // Defaults to the active brand, but the modal lets the user
          // re-target to a sibling brand. Resolve the destination slug
          // from the plan's own accountId so we always land on the
          // right brand's calendar.
          setTurnTrend(null);
          const brand = brandAccounts.find((b) => b.id === plan.accountId);
          navigateToPlan?.(plan.id, brand?.slug || brandSlug);
        }}
      />
    </div>
  );
};

export { TrendsView };
