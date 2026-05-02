/* eslint-disable */
/* TrendsView — agency-only "Trends Radar" surface.
   Compartmentalized away from the rest of the dashboard:
   - Reads from public.trend_signals (RLS agency-only)
   - Refetch via the fetch-trends edge function (agency-only)
   - No coupling to post plans / brand kits / tasks — yet. The
     "turn into post plan" action is a deliberate Phase 5 follow-on.
   Phase 1 ships TikTok only; Twitter and Instagram tabs land later. */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { loadTrendSignals, refreshTrends } from '../lib/db.js';
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
// Empty for now — Instagram pivoted back to global on 2026-05-02 to match
// TikTok / Twitter behaviour. Kept as a Set so adding a per-brand source
// later (e.g. competitor monitoring in Phase 8) is a one-line change.
const PER_BRAND_PLATFORMS = new Set();

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
  instagram: ['all', 'post'],
  linkedin:  ['all', 'topic'],
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

function TrendCard({ trend, onTurnIntoPostPlan }) {
  const isHashtag = trend.kind === 'hashtag';
  const display = isHashtag ? `#${trend.title}` : trend.title;
  const metric = formatMetric(trend.metricValue, trend.metricLabel);
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
          {trend.subtitle && (
            <div className="trend-card-sub">{trend.subtitle}</div>
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

function EmptyState({ onRefresh, refreshing, hasError, platform }) {
  const headline = (() => {
    if (platform === 'tiktok')    return 'Pull the latest from TikTok Creative Center';
    if (platform === 'twitter')   return "Pull what's trending on X right now";
    if (platform === 'instagram') return "Pull what's viral on Instagram right now";
    return 'Fetch the latest trends';
  })();
  const body = (() => {
    if (platform === 'tiktok')    return "We'll fetch trending hashtags and sounds for the regions you've selected. First fetch takes ~30s per region.";
    if (platform === 'twitter')   return 'Real-time trending topics + hashtags by region. Returns in a few seconds.';
    if (platform === 'instagram') return 'Recent high-engagement posts under each region’s discovery hashtags. Approximates "trending now" since Instagram doesn’t expose a regional trends feed.';
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
  // From App.jsx — used by the Turn-into-post-plan modal so the user can
  // pick which brand the new post plan should land on.
  brandAccounts = [],
  defaultAccountId = null,
  userId = null,
  navigateToPlan,        // (planId, brandSlug) => void
}) => {
  const [activePlatform, setActivePlatform] = useState('tiktok');
  const [activeRegion, setActiveRegion] = useState('US');
  const [activeKind, setActiveKind] = useState('all'); // 'all' | 'hashtag' | 'sound' | 'topic' | 'post'
  // Active brand for per-brand platforms (currently Instagram). Null until
  // the user picks one — without it we can't read or write IG signals.
  const [activeAccountId, setActiveAccountId] = useState(defaultAccountId || (brandAccounts[0]?.id ?? null));
  const [trends, setTrends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSummary, setRefreshSummary] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  // Phase 5: Turn-into-post-plan modal state.
  const [turnTrend, setTurnTrend] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Keep activeAccountId reasonable: if the agency switches the active
  // admin brand from the sidebar, follow them; if no brands exist, null.
  useEffect(() => {
    if (defaultAccountId) setActiveAccountId(defaultAccountId);
    else if (brandAccounts.length > 0) setActiveAccountId((prev) => prev || brandAccounts[0].id);
  }, [defaultAccountId, brandAccounts]);

  const isPerBrand = PER_BRAND_PLATFORMS.has(activePlatform);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // For per-brand platforms (IG), filter rows to the picked account so
    // we never mix Brand A's IG trends into Brand B's view.
    // For global platforms, pass account_id IS NULL so we never accidentally
    // pull a brand-scoped row alongside the global ones.
    const args = {
      platform: activePlatform,
      accountId: isPerBrand ? activeAccountId : null,
    };
    if (!isPerBrand) args.region = activeRegion;
    if (isPerBrand && !activeAccountId) {
      // Per-brand mode but no brand picked yet — nothing to load.
      setTrends([]);
      setLoading(false);
      return () => {};
    }
    loadTrendSignals(args)
      .then((rows) => { if (!cancelled) setTrends(rows); })
      .catch((e) => { if (!cancelled) console.warn('loadTrendSignals failed', e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePlatform, activeRegion, activeAccountId, isPerBrand, reloadKey]);

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
    if (isPerBrand && !activeAccountId) {
      setRefreshError('Pick a brand first.');
      return;
    }
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSummary(null);
    try {
      const args = { source: activePlatform };
      if (isPerBrand) {
        args.accountId = activeAccountId;
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
            <h2 className="trends-title">What's trending right now</h2>
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
                // Different platforms expose different kinds; reset to "all"
                // so the user doesn't see an empty grid because the selected
                // kind doesn't exist on the new platform.
                setActiveKind('all');
              }}
            >
              <Icon name={p.icon} size={14} />
              <span>{p.label}</span>
              {!p.available && <span className="trends-tab-soon">soon</span>}
            </button>
          ))}
        </nav>

        <div className="trends-filter-row">
          {isPerBrand ? (
            // Per-brand sources show a brand selector instead of a region
            // dropdown; trends are tied to a single brand's tracked
            // hashtags rather than to a country.
            <div className="trends-filter">
              <label>Brand</label>
              <select
                value={activeAccountId || ''}
                onChange={(e) => setActiveAccountId(e.target.value || null)}
              >
                {brandAccounts.length === 0 && (
                  <option value="">No brands available</option>
                )}
                {brandAccounts.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          ) : (
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

        {refreshSummary && (
          <div className="trends-flash">
            Wrote {refreshSummary.written ?? 0} signals across {refreshSummary.regions?.length ?? 0} region(s).
          </div>
        )}
        {refreshError && (
          <div className="trends-flash error">
            Refresh failed: {refreshError}
          </div>
        )}
      </header>

      <div className="trends-body">
        {loading ? (
          <div className="trends-loading">Loading trends…</div>
        ) : visibleTrends.length === 0 ? (
          <EmptyState
            onRefresh={onRefresh}
            refreshing={refreshing}
            hasError={!!refreshError}
            platform={activePlatform}
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
        defaultAccountId={defaultAccountId}
        userId={userId}
        onClose={() => setTurnTrend(null)}
        onCreated={(plan) => {
          // Land the user in the new post plan's detail view inside the
          // brand we just scheduled it for. We can't use the parent's
          // setRoute because Trends Radar is agency-level (no implicit
          // brand context); navigateToPlan resolves the slug from the
          // plan's own accountId so we land on /c/:slug/calendar/:id.
          setTurnTrend(null);
          const brand = brandAccounts.find((b) => b.id === plan.accountId);
          navigateToPlan?.(plan.id, brand?.slug);
        }}
      />
    </div>
  );
};

export { TrendsView };
