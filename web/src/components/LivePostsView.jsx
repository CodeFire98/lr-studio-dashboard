/* eslint-disable */
/* LivePostsView — brand-scoped repository of every live post.
   Pulls from `post_plan_publications` joined with `post_plans` so each
   tile carries the originating plan's context (concept, schedule, etc).
   Feeds the activity-feed "marked posted" entries with their
   own visual surface — one click to a live post, one click back to
   the plan that produced it.

   Filter affordances:
     - Platform pill (All / IG / LinkedIn / X)
     - Free-text search (concept, plan creator, URL)

   Empty state nudges the agency / brand to mark plans as posted from
   the detail view; that's the only way rows land here. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import {
  PLATFORMS,
  PLATFORM_BY_KEY,
  PlatformChip,
} from './postPlanShared.jsx';
import { LivePostEmbed } from './LivePostEmbed.jsx';
import {
  loadBrandPublications,
  subscribeToAllPostPlanPublications,
  loadLatestEngagementSnapshots,
  loadEmbedCacheForPublications,
  subscribeToAllEngagementSnapshots,
  subscribeToAllEmbedCache,
  refreshEngagement,
} from '../lib/db.js';

const PLATFORM_FILTERS = [
  { key: 'all',       label: 'All' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin',  label: 'LinkedIn' },
  { key: 'x',         label: 'X' },
];

const formatDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
};

const groupByMonth = (rows) => {
  // Latest first. Posted-at is the key — the user thinks "what went
  // live recently" not "what plan was created recently".
  const sorted = [...rows].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const groups = new Map();
  for (const r of sorted) {
    const d = r.publishedAt ? new Date(r.publishedAt) : null;
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
    const label = d
      ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'Undated';
    const list = groups.get(key);
    if (list) list.rows.push(r);
    else groups.set(key, { key, label, rows: [r] });
  }
  return Array.from(groups.values());
};

// Format a count for the metrics row: 1234 → "1.2k", 1_200_000 → "1.2M".
// Returns "—" when the count is null/undefined (the platform doesn't
// expose this metric or we haven't scraped yet).
const formatCount = (n) => {
  if (n === null || n === undefined) return '—';
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
};

const formatRelative = (iso) => {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = Date.now() - then;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  } catch {
    return '';
  }
};

// Metrics row — only renders fields the platform exposes (per
// availability_notes on the snapshot). Null counts render "—" instead
// of "0" so the user can tell "metric not exposed" from "really zero".
const MetricsRow = ({ snapshot }) => {
  const items = [
    { key: 'like_count',     icon: '♥', label: 'likes',     value: snapshot?.likeCount },
    { key: 'comment_count',  icon: '💬', label: 'comments', value: snapshot?.commentCount },
    { key: 'share_count',    icon: '↗',  label: 'shares',   value: snapshot?.shareCount },
    { key: 'bookmark_count', icon: '🔖', label: 'saves',    value: snapshot?.bookmarkCount ?? snapshot?.saveCount },
    { key: 'view_count',     icon: '👁', label: 'views',    value: snapshot?.viewCount },
  ];
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        padding: '8px 4px 0',
        fontSize: 12,
        color: 'var(--ink-2)',
      }}
    >
      {items.map((m) => (
        <div
          key={m.key}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title={`${formatCount(m.value)} ${m.label}`}
        >
          <span aria-hidden style={{ opacity: 0.8 }}>{m.icon}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
            {formatCount(m.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

// One-liner reflecting refresh state — drives the "Refreshed 2h ago"
// footer below the metrics row.
const refreshFooter = ({ snapshot, refreshing, lastError, embed }) => {
  if (refreshing) return 'Fetching metrics…';
  if (lastError) return `Refresh failed: ${lastError}`;
  if (!snapshot) return 'No metrics yet';
  if (snapshot.scrapeStatus === 'blocked') {
    return 'Metrics paused — Apify monthly quota exhausted';
  }
  if (snapshot.scrapeStatus === 'failed') {
    return snapshot.errorMessage ? `Last refresh failed: ${snapshot.errorMessage}` : 'Last refresh failed';
  }
  const ts = formatRelative(snapshot.fetchedAt);
  const note = snapshot.scrapeStatus === 'partial' ? ' (partial)' : '';
  // Embed staleness flag: when the actor returned counts but no media,
  // the metrics are real but the card may be using an older image.
  const stale = embed?.refreshStatus === 'stale' ? ' · embed stale' : '';
  return ts ? `Refreshed ${ts}${note}${stale}` : `Refreshed${note}${stale}`;
};

const LiveTile = ({ row, snapshot, embed, isAgency, onRefresh, onOpenPlan }) => {
  const platCfg = PLATFORM_BY_KEY[row.platform];
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState('');
  const [hovered, setHovered] = useState(false);

  const handleRefresh = useCallback(async (e) => {
    // Don't trigger the tile-level "open live URL" when clicking the
    // refresh button — events bubble out of nested elements by default.
    e?.stopPropagation?.();
    if (refreshing) return;
    setRefreshing(true);
    setLastError('');
    try {
      await onRefresh(row.id);
    } catch (e) {
      setLastError(e?.message || String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, onRefresh, row.id]);

  // Whole-tile click → open live post URL in a new tab. No-op when
  // there's no live_url on this publication (user marked posted
  // without pasting a URL). Inner interactive elements (concept-title
  // button, refresh button) stopPropagation so they don't co-fire.
  const handleTileClick = useCallback((e) => {
    // Honor browser conventions for opening in a new tab regardless.
    if (!row.liveUrl) return;
    // If the user clicked on text they're trying to select, don't
    // hijack — let the selection survive. Common UX gotcha for
    // clickable cards.
    const selection = window.getSelection?.();
    if (selection && selection.toString().length > 0) return;
    window.open(row.liveUrl, '_blank', 'noopener,noreferrer');
  }, [row.liveUrl]);

  const tileClickable = !!row.liveUrl;

  return (
    <div
      onClick={handleTileClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role={tileClickable ? 'link' : undefined}
      tabIndex={tileClickable ? 0 : undefined}
      onKeyDown={tileClickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.open(row.liveUrl, '_blank', 'noopener,noreferrer');
        }
      } : undefined}
      title={tileClickable ? 'Open the live post in a new tab' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--surface)',
        minWidth: 0,
        cursor: tileClickable ? 'pointer' : 'default',
        // Subtle hover lift so the user knows the whole card is clickable.
        boxShadow: hovered && tileClickable ? '0 4px 14px rgba(0,0,0,0.06)' : 'none',
        transform: hovered && tileClickable ? 'translateY(-1px)' : 'none',
        transition: 'box-shadow 120ms ease, transform 120ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PlatformChip platform={row.platform} size="md" />
        <strong style={{ fontSize: 13, fontWeight: 600 }}>{platCfg?.label || row.platform}</strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{formatDate(row.publishedAt)}</span>
      </div>

      <button
        type="button"
        onClick={(e) => {
          // The concept-title still opens the post plan in-dashboard;
          // stopPropagation so the tile-level live-URL handler doesn't
          // also fire.
          e.stopPropagation();
          if (row.plan?.id) onOpenPlan(row.plan.id);
        }}
        style={{
          display: 'block',
          textAlign: 'left',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'var(--ink-1)',
          cursor: row.plan?.id ? 'pointer' : 'default',
          fontSize: 14,
          fontWeight: 500,
          lineHeight: 1.35,
          fontFamily: 'inherit',
        }}
        title={row.plan?.id ? 'Open the post plan that produced this' : undefined}
      >
        {row.plan?.concept || 'Untitled post'}
      </button>

      {/* Embed card — only when the embed cache has been populated for
          this publication. Until /api/engagement/refresh writes one, the
          slot stays empty (the metrics row + link below already convey
          the post identity). */}
      {embed && (
        <LivePostEmbed embed={embed} platform={row.platform} liveUrl={row.liveUrl} />
      )}

      {/* Metrics row — always renders, with "—" for null fields so the
          tile reads the same shape whether scraped or not. */}
      <MetricsRow snapshot={snapshot} />

      {/* Refresh state + agency-only "Refresh now" affordance */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--ink-4)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          {refreshFooter({ snapshot, refreshing, lastError, embed })}
        </span>
        {/* Refresh-now button: rendered for every platform with a
            wired scraper (IG, LinkedIn, X). X was re-enabled
            2026-05-14 via scrape.badger after the second-pass
            shootout (see web/api/engagement/_shared.ts file header). */}
        {isAgency && (row.platform === 'instagram' || row.platform === 'linkedin' || row.platform === 'x') && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'transparent',
              color: refreshing ? 'var(--ink-4)' : 'var(--ink-2)',
              cursor: refreshing ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
            title="Re-scrape engagement metrics from Apify"
          >
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        )}
      </div>

      {/* URL block removed 2026-05-14 — the whole tile is now clickable
          and opens the live URL in a new tab, so the redundant URL row
          (which used to dominate the bottom of every card with an
          underlined wrapped-string URL) was visual noise. The "No URL"
          indicator is folded into the footer below when liveUrl is
          missing, since that's the only remaining signal that the
          publication wasn't saved with a URL. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-4)' }}>
        <span>Marked by {row.publisher?.name || 'Someone'}</span>
        {row.plan?.scheduledAt && (
          <>
            <span>·</span>
            <span>Scheduled {formatDate(row.plan.scheduledAt)}</span>
          </>
        )}
        {!row.liveUrl && (
          <>
            <span>·</span>
            <span style={{ fontStyle: 'italic' }}>No URL added</span>
          </>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// Masonry grid — row-first reading order + per-column tight stacking
// =====================================================================
// CSS multi-column would stack tiles tightly within each column (which
// we want), but it fills column 1 top-to-bottom THEN column 2 etc.,
// so the top-left tile is the newest but the top-middle tile is
// item N+1 (not item 1). The user expectation for chronological sort
// is row-first: top-left = item 0, top-middle = item 1, etc.
//
// Solution: distribute items round-robin into N flex columns. Item 0
// goes to column 0 row 0 (top-left), item 1 to column 1 row 0 (top-
// middle), item 2 to column 2 row 0 (top-right), item 3 wraps back to
// column 0 row 1, and so on. Each column is a flex column so tiles
// inside stack tightly with no whitespace below short tiles.
//
// Column count is derived from container width via ResizeObserver,
// targeting a per-column min width of ~280px (matches the original
// CSS Grid's minmax).

const MIN_COLUMN_WIDTH = 280;
const COLUMN_GAP = 12;

function useColumnCount(containerRef) {
  const [cols, setCols] = useState(1);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const compute = (width) => {
      // Floor((w + gap) / (min + gap)) gives the largest column count
      // where each column is >= MIN_COLUMN_WIDTH including inter-column
      // gaps. Clamp to >= 1 so we always render at least one column.
      const n = Math.max(1, Math.floor((width + COLUMN_GAP) / (MIN_COLUMN_WIDTH + COLUMN_GAP)));
      setCols(n);
    };
    compute(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      compute(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);
  return cols;
}

const MasonryGrid = ({ items, renderItem }) => {
  const ref = useRef(null);
  const cols = useColumnCount(ref);
  const columns = useMemo(() => {
    const arr = Array.from({ length: cols }, () => []);
    items.forEach((item, i) => arr[i % cols].push(item));
    return arr;
  }, [items, cols]);
  return (
    <div
      ref={ref}
      style={{ display: 'flex', gap: COLUMN_GAP, alignItems: 'flex-start' }}
    >
      {columns.map((col, ci) => (
        <div
          key={ci}
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: COLUMN_GAP }}
        >
          {col.map((item) => renderItem(item))}
        </div>
      ))}
    </div>
  );
};

const LivePostsView = ({ accountId, accountName, setRoute, isAgency }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [platformKey, setPlatformKey] = useState('all');
  const [q, setQ] = useState('');
  // Sort mode for the tile list. Default = "recent" matches the
  // pre-PR-7 behaviour (latest published first, grouped by month).
  // "likes" + "engagement" sort flat (no month grouping) because
  // intercalating sort + month-group reads strangely — if you want
  // "most likes" you want a leaderboard, not a chronology.
  const [sortMode, setSortMode] = useState('recent');
  // Engagement state — keyed by publication id. The bulk loaders below
  // run after publications resolve, and realtime keeps them in sync as
  // /api/engagement/refresh writes new rows.
  const [snapshotsByPubId, setSnapshotsByPubId] = useState(() => new Map());
  const [embedsByPubId, setEmbedsByPubId] = useState(() => new Map());

  useEffect(() => {
    if (!accountId) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setErr('');
    loadBrandPublications(accountId)
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setErr(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  // Realtime — any publication change project-wide triggers a refetch.
  // We can't filter by brand at the realtime layer (publications don't
  // carry account_id directly), and `loadBrandPublications` is cheap
  // enough that "always refetch on any event" beats the bookkeeping of
  // optimistic merges. Deletes still apply optimistically so the tile
  // disappears the instant someone removes it from another tab.
  useEffect(() => {
    if (!accountId) return undefined;
    const unsub = subscribeToAllPostPlanPublications((evt) => {
      if (evt.type === 'DELETE') {
        setRows((prev) => prev.filter((p) => p.id !== evt.id));
        return;
      }
      loadBrandPublications(accountId)
        .then(setRows)
        .catch((e) => console.warn('LivePostsView refetch failed', e));
    });
    return () => unsub?.();
  }, [accountId]);

  // Bulk-load engagement once we know the publication ids in view. Two
  // round-trips: latest-snapshot-per-publication and the embed cache.
  // Both are cheap (skinny rows, indexed by publication_id).
  useEffect(() => {
    if (!Array.isArray(rows) || rows.length === 0) {
      setSnapshotsByPubId(new Map());
      setEmbedsByPubId(new Map());
      return undefined;
    }
    const pubIds = rows.map((r) => r.id);
    let cancelled = false;
    Promise.all([
      loadLatestEngagementSnapshots(pubIds).catch((e) => { console.warn('snapshots load failed', e); return new Map(); }),
      loadEmbedCacheForPublications(pubIds).catch((e) => { console.warn('embed cache load failed', e); return new Map(); }),
    ]).then(([snaps, embeds]) => {
      if (cancelled) return;
      setSnapshotsByPubId(snaps);
      setEmbedsByPubId(embeds);
    });
    return () => { cancelled = true; };
  }, [rows]);

  // Realtime — snapshot inserts and embed-cache upserts both write to
  // tables that are in `supabase_realtime`. Project-wide subscribe +
  // re-filter on receive matches the publications-stream pattern.
  useEffect(() => {
    if (!accountId) return undefined;
    const unsubSnap = subscribeToAllEngagementSnapshots((evt) => {
      if (evt.type === 'DELETE' || !evt.snapshot) return; // append-only; deletes rare
      setSnapshotsByPubId((prev) => {
        const pubId = evt.snapshot.publicationId;
        // Only update if this snapshot is newer than what we have (or first one).
        const existing = prev.get(pubId);
        if (existing && existing.fetchedAt && evt.snapshot.fetchedAt &&
            existing.fetchedAt > evt.snapshot.fetchedAt) {
          return prev;
        }
        const next = new Map(prev);
        next.set(pubId, evt.snapshot);
        return next;
      });
    });
    const unsubEmbed = subscribeToAllEmbedCache((evt) => {
      if (evt.type === 'DELETE') {
        setEmbedsByPubId((prev) => {
          const next = new Map(prev);
          next.delete(evt.publicationId);
          return next;
        });
        return;
      }
      if (!evt.embed) return;
      setEmbedsByPubId((prev) => {
        const next = new Map(prev);
        next.set(evt.embed.publicationId, evt.embed);
        return next;
      });
    });
    return () => { unsubSnap?.(); unsubEmbed?.(); };
  }, [accountId]);

  // Agency-only "Refresh now" handler — POSTs to /api/engagement/refresh.
  // Realtime picks up the new snapshot + embed; the tile re-renders
  // without us having to merge anything optimistically here.
  const handleRefresh = useCallback(async (publicationId) => {
    await refreshEngagement(publicationId);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (platformKey !== 'all' && r.platform !== platformKey) return false;
      if (needle) {
        const hay = `${r.plan?.concept || ''} ${r.publisher?.name || ''} ${r.liveUrl || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, platformKey, q]);

  // For the leaderboard sort modes we skip month-grouping and render
  // one flat section. `recent` keeps the existing grouped-by-month
  // shape so chronology stays readable.
  const sortedFlat = useMemo(() => {
    if (sortMode === 'recent') return null;
    const scored = filtered.map((r) => {
      const s = snapshotsByPubId.get(r.id) || null;
      let score = 0;
      if (sortMode === 'likes') {
        score = (s?.likeCount ?? 0);
      } else if (sortMode === 'engagement') {
        score = (s?.likeCount ?? 0) + (s?.commentCount ?? 0) + (s?.shareCount ?? 0);
      }
      return { row: r, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.row);
  }, [filtered, sortMode, snapshotsByPubId]);

  const groups = useMemo(
    () => (sortMode === 'recent' ? groupByMonth(filtered) : null),
    [filtered, sortMode],
  );
  const counts = useMemo(() => {
    const out = { all: rows.length };
    for (const p of PLATFORMS) {
      out[p.key] = rows.filter((r) => r.platform === p.key).length;
    }
    return out;
  }, [rows]);

  const openPlan = (planId) => setRoute?.({ view: 'plan', id: planId });

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>
            {accountName ? `${accountName} · Live posts` : 'Live posts'}
          </div>
          <h1>Live posts</h1>
          <div className="sub" style={{ marginTop: 8 }}>
            Every plan that's gone live. Tiles link to the post; click the title to open the originating plan.
          </div>
        </div>
      </div>

      {/* Filter pills + search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 20,
        }}
      >
        <div className="cal-filter-pills" role="tablist" aria-label="Filter by platform">
          {PLATFORM_FILTERS.map((f) => {
            const active = platformKey === f.key;
            const count = counts[f.key] || 0;
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={active}
                className={'cal-filter-pill' + (active ? ' on' : '')}
                onClick={() => setPlatformKey(f.key)}
              >
                <span>{f.label}</span>
                {count > 0 && <span className="cal-filter-pill-badge">{count}</span>}
              </button>
            );
          })}
        </div>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-3)' }}>
          Sort:
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value)}
            style={{
              padding: '6px 8px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: 'var(--surface)',
              color: 'var(--ink-1)',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
            aria-label="Sort live posts"
          >
            <option value="recent">Recently posted</option>
            <option value="likes">Most likes</option>
            <option value="engagement">Most engagement</option>
          </select>
        </label>
        <div style={{ position: 'relative', minWidth: 220 }}>
          <Icon
            name="search"
            size={13}
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-4)', pointerEvents: 'none' }}
          />
          <input
            type="search"
            placeholder="Search concept, URL, person…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              padding: '7px 10px 7px 30px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: 'var(--surface)',
              color: 'var(--ink-1)',
              fontSize: 13,
              outline: 'none',
              minWidth: 220,
            }}
          />
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, fontSize: 13, color: 'var(--ink-4)' }}>Loading live posts…</div>
      ) : err ? (
        <div style={{ padding: 40, fontSize: 13, color: 'var(--accent)' }}>
          Couldn't load live posts: {err}
        </div>
      ) : rows.length === 0 ? (
        <div className="empty" style={{ padding: 60, textAlign: 'center', color: 'var(--ink-4)' }}>
          <div style={{ fontSize: 15, marginBottom: 8, color: 'var(--ink-2)' }}>Nothing posted yet.</div>
          <div style={{ fontSize: 13 }}>
            Once a plan is approved, mark it as posted from its detail view —
            it'll show up here, optionally with a link to the live post.
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty" style={{ padding: 60, textAlign: 'center', color: 'var(--ink-4)' }}>
          <div style={{ fontSize: 13 }}>No live posts match this filter.</div>
        </div>
      ) : sortMode === 'recent' ? (
        // Default chronological view — month-grouped.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {groups.map((g) => (
            <section key={g.key}>
              <h3 style={{
                margin: '0 0 12px',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--ink-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {g.label}
                <span style={{ marginLeft: 8, color: 'var(--ink-4)', fontWeight: 400 }}>
                  · {g.rows.length}
                </span>
              </h3>
              <MasonryGrid
                items={g.rows}
                renderItem={(row) => (
                  <LiveTile
                    key={row.id}
                    row={row}
                    snapshot={snapshotsByPubId.get(row.id) || null}
                    embed={embedsByPubId.get(row.id) || null}
                    isAgency={!!isAgency}
                    onRefresh={handleRefresh}
                    onOpenPlan={openPlan}
                  />
                )}
              />
            </section>
          ))}
        </div>
      ) : (
        // Leaderboard view (likes / total engagement) — flat list,
        // tiles already render their metrics so no need for a separate
        // ranking column.
        <div>
          <h3 style={{
            margin: '0 0 12px',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--ink-3)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            {sortMode === 'likes' ? 'Most likes' : 'Most engagement'}
            <span style={{ marginLeft: 8, color: 'var(--ink-4)', fontWeight: 400 }}>
              · {sortedFlat?.length ?? 0}
            </span>
          </h3>
          <MasonryGrid
            items={sortedFlat ?? []}
            renderItem={(row) => (
              <LiveTile
                key={row.id}
                row={row}
                snapshot={snapshotsByPubId.get(row.id) || null}
                embed={embedsByPubId.get(row.id) || null}
                isAgency={!!isAgency}
                onRefresh={handleRefresh}
                onOpenPlan={openPlan}
              />
            )}
          />
        </div>
      )}
    </div></div>
  );
};

export { LivePostsView };
