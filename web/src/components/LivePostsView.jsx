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
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import {
  PLATFORMS,
  PLATFORM_BY_KEY,
  PlatformChip,
} from './postPlanShared.jsx';
import {
  loadBrandPublications,
  subscribeToAllPostPlanPublications,
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

const LiveTile = ({ row, onOpenPlan }) => {
  const platCfg = PLATFORM_BY_KEY[row.platform];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 14,
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--surface)',
        minWidth: 0,
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
        onClick={() => row.plan?.id && onOpenPlan(row.plan.id)}
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

      {row.liveUrl ? (
        <a
          href={row.liveUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: 'var(--accent-ink)',
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          <Icon name="link" size={11} />
          {row.liveUrl}
        </a>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>No URL added</span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-4)' }}>
        <span>Marked by {row.publisher?.name || 'Someone'}</span>
        {row.plan?.scheduledAt && (
          <>
            <span>·</span>
            <span>Scheduled {formatDate(row.plan.scheduledAt)}</span>
          </>
        )}
      </div>
    </div>
  );
};

const LivePostsView = ({ accountId, accountName, setRoute }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [platformKey, setPlatformKey] = useState('all');
  const [q, setQ] = useState('');

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

  const groups = useMemo(() => groupByMonth(filtered), [filtered]);
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
      ) : (
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
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 12,
              }}>
                {g.rows.map((row) => (
                  <LiveTile key={row.id} row={row} onOpenPlan={openPlan} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div></div>
  );
};

export { LivePostsView };
