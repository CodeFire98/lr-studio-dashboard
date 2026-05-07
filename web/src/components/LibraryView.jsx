/* eslint-disable */
/* Library — universal asset repo for the active brand. Toggle between
   delivered creatives and brand-uploaded references; both pull from
   post_plan_attachments (legacy task assets are surfaced under
   Deliverables for backward-compat). */
import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from './Icon.jsx';
import {
  loadLibraryAssets,
  loadLibraryPostPlanAttachments,
  assetSignedUrl,
  deleteAsset,
  deletePostPlanAttachment,
} from '../lib/db.js';
import { useLightbox } from './Lightbox.jsx';

const LS_LIBRARY_KIND = 'lr_library_kind';

// Platform filter — we focus the AI Social Media Manager service on
// Instagram, LinkedIn, and X. The platform is captured on the parent task
// (free-text, often comma-separated like "Instagram, LinkedIn"), so we
// match case-insensitively and accept common synonyms (Twitter == X).
const PLATFORM_FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  {
    key: 'instagram',
    label: 'Instagram',
    test: (a) => /\binstagram\b|\big\b/i.test(a.taskPlatform || ''),
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    test: (a) => /\blinkedin\b/i.test(a.taskPlatform || ''),
  },
  {
    key: 'x',
    label: 'X',
    // Match either the modern "X" handle or its predecessor "Twitter".
    // The negative lookarounds keep us from grabbing stray X's inside
    // longer words (e.g. "TikTokX" or "Mixed").
    test: (a) => /(?:^|[^A-Za-z])(x|twitter)(?:$|[^A-Za-z])/i.test(a.taskPlatform || ''),
  },
];

const DATE_WINDOWS = [
  { key: 'all', label: 'All time', cutoffMs: 0 },
  { key: 'week', label: 'Past week', cutoffMs: 7 * 86400000 },
  { key: 'month', label: 'Past month', cutoffMs: 30 * 86400000 },
  { key: 'quarter', label: 'Past 90 days', cutoffMs: 90 * 86400000 },
];

const LibraryView = ({ auth, accountId, setRoute }) => {
  // Two parallel asset pools — deliverables (final creatives the agency
  // has shipped) and references (inspiration files the brand has dropped
  // on post plans). Toggle picks one, but we load both eagerly so the
  // counts up top stay accurate as the user flips between them.
  const [deliverables, setDeliverables] = useState([]);
  const [references, setReferences]     = useState([]);
  const [kind, setKind] = useState(() => {
    try {
      const v = localStorage.getItem(LS_LIBRARY_KIND);
      if (v === 'deliverable' || v === 'reference') return v;
    } catch {}
    return 'deliverable';
  });
  useEffect(() => {
    try { localStorage.setItem(LS_LIBRARY_KIND, kind); } catch {}
  }, [kind]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [platformKey, setPlatformKey] = useState('all');
  const [dateKey, setDateKey] = useState('all');
  const [q, setQ] = useState('');

  // Library is always scoped to the active brand — `accountId` is the brand
  // currently selected in the BrandPicker (or the brand owner's own brand).
  //
  // Three queries on mount:
  //   1. legacy task deliverables (kind='deliverable')
  //   2. post-plan finals (post_plan_attachments where kind='final')
  //   3. post-plan references (post_plan_attachments where kind='reference')
  // Pools (1)+(2) feed Deliverables; pool (3) feeds References.
  useEffect(() => {
    if (auth?.requiresBrandSelection) {
      setDeliverables([]);
      setReferences([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      loadLibraryAssets({ kind: 'deliverable', accountId }),
      loadLibraryPostPlanAttachments({ accountId, kind: 'final' }),
      loadLibraryPostPlanAttachments({ accountId, kind: 'reference' }),
    ])
      .then(([taskRows, finalRows, refRows]) => {
        if (cancelled) return;
        const sortDesc = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
        setDeliverables([...taskRows, ...finalRows].sort(sortDesc));
        setReferences([...refRows].sort(sortDesc));
      })
      .catch((e) => setErr(e.message || String(e)))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, auth?.requiresBrandSelection]);

  const assets = kind === 'reference' ? references : deliverables;

  // Sign / resolve image URLs lazily, source-aware:
  //   - task deliverables live in the private `assets` bucket → signed URL
  //   - post-plan finals live in the public `post-plan-attachments` bucket
  //     and already carry a public `url` from mapPostPlanAttachmentRow
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const needs = assets.filter((a) => a.isImage && !thumbs[a.id]);
      if (!needs.length) return;
      const next = {};
      for (const a of needs) {
        try {
          if (a.source === 'post_plan' && a.url) {
            next[a.id] = a.url;
          } else {
            next[a.id] = await assetSignedUrl(a.storagePath);
          }
        } catch {}
      }
      if (!cancelled && Object.keys(next).length) setThumbs((p) => ({ ...p, ...next }));
    })();
    return () => { cancelled = true; };
  }, [assets]);

  const filtered = useMemo(() => {
    const platformTest = PLATFORM_FILTERS.find((t) => t.key === platformKey)?.test || (() => true);
    const window = DATE_WINDOWS.find((w) => w.key === dateKey);
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    return assets.filter((a) => {
      if (!platformTest(a)) return false;
      // Date window filter uses the parent's scheduled date (post plan) /
      // deadline (task) so filtering is anchored to "when the work is for"
      // rather than when the file was uploaded.
      const dateForWindow = a.parentDate || a.createdAt;
      if (window?.cutoffMs && Math.abs(now - new Date(dateForWindow).getTime()) > window.cutoffMs) return false;
      if (needle) {
        const hay = `${a.filename} ${a.taskTitle || ''} ${a.accountName || ''} ${a.taskPlatform || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [assets, platformKey, dateKey, q]);

  // Group filtered deliverables by their parent (post plan or task) and
  // sort groups by parent date descending — the user's mental model is
  // "show me what's scheduled most recently / next" rather than a flat
  // file collage. Within each group, items stay sorted newest-uploaded
  // first (the existing default).
  const groups = useMemo(() => {
    const byParent = new Map();
    for (const a of filtered) {
      const key = `${a.source}:${a.parentId || a.id}`;
      const existing = byParent.get(key);
      if (existing) {
        existing.items.push(a);
      } else {
        byParent.set(key, {
          key,
          source: a.source,
          parentId: a.parentId,
          parentTitle: a.parentTitle || a.taskTitle || 'Untitled',
          parentDate: a.parentDate || a.createdAt,
          parentDateLabel: a.parentDateLabel || 'Uploaded',
          parentStatus: a.parentStatus || null,
          platforms: a.taskPlatform || '',
          accountName: a.accountName || null,
          items: [a],
        });
      }
    }
    return Array.from(byParent.values()).sort(
      (a, b) => (b.parentDate || '').localeCompare(a.parentDate || ''),
    );
  }, [filtered]);

  const lightbox = useLightbox();
  const isAgency = !!auth?.isAgency;

  // Source-aware delete: post-plan attachments use the post_plan_attachments
  // table + bucket; legacy task deliverables use the assets table + 'assets'
  // bucket. Lightbox shows its own confirm before calling this — no need
  // to re-prompt here. Refresh the matching local list on success.
  const deleteFromLibrary = async (a) => {
    if (a.source === 'post_plan') {
      await deletePostPlanAttachment(a);
    } else {
      await deleteAsset(a);
    }
    setDeliverables((prev) => prev.filter((x) => !(x.source === a.source && x.id === a.id)));
    setReferences((prev)   => prev.filter((x) => !(x.source === a.source && x.id === a.id)));
  };

  const handleOpen = async (a) => {
    try {
      // Post-plan finals already have a public URL on the row; only task
      // deliverables need a fresh signed URL.
      const url = a.source === 'post_plan' && a.url
        ? a.url
        : await assetSignedUrl(a.storagePath);
      lightbox.open({
        src: url,
        mimeType: a.mimeType,
        name: a.filename,
        alt: a.filename,
        downloadUrl: url,
        onDelete: isAgency ? () => deleteFromLibrary(a) : undefined,
      });
    } catch (e) { alert(`Couldn't open: ${e.message || e}`); }
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Library</h1>
          <div className="sub">
            Every creative your agency has shipped, plus reference files the brand has shared on post plans.
            <span style={{ marginLeft: 8, color: 'var(--ink-4)' }}>
              {deliverables.length} deliverable{deliverables.length === 1 ? '' : 's'}
              {' · '}
              {references.length} reference{references.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="actions">
          <div className="topbar-search" style={{background: "var(--surface)", border: "1px solid var(--line)"}}>
            <Icon name="search" size={14}/>
            <input
              placeholder="Search by filename or post plan…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{border: 0, background: "transparent", outline: "none", fontSize: 13, width: 220}}
            />
          </div>
        </div>
      </div>

      <div className="filterbar">
        <div className="seg" role="tablist" aria-label="Asset kind" style={{ marginRight: 8 }}>
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'deliverable'}
            className={kind === 'deliverable' ? 'on' : ''}
            onClick={() => setKind('deliverable')}
          >
            Deliverables
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'reference'}
            className={kind === 'reference' ? 'on' : ''}
            onClick={() => setKind('reference')}
          >
            References
          </button>
        </div>
        <div className="seg">
          {PLATFORM_FILTERS.map((t) => (
            <button key={t.key} className={platformKey === t.key ? "on" : ""} onClick={() => setPlatformKey(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{flex: 1}}/>
        <select
          className="filter-pill"
          value={dateKey}
          onChange={(e) => setDateKey(e.target.value)}
          style={{padding: "6px 12px", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 999}}
        >
          {DATE_WINDOWS.map((w) => (
            <option key={w.key} value={w.key}>{w.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="empty"><div>Loading your library…</div></div>
      ) : err ? (
        <div className="empty"><div className="big">Couldn't load</div>{err}</div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="big">Nothing here yet</div>
          {assets.length === 0
            ? (kind === 'reference'
                ? "As the brand drops reference files on post plans, they'll land here."
                : "As your agency delivers creatives, they'll land here.")
            : (kind === 'reference'
                ? 'No reference files match those filters.'
                : 'No delivered creatives match those filters.')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {groups.map((g) => (
            <section key={g.key}>
              <header
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  flexWrap: 'wrap',
                  paddingBottom: 10,
                  marginBottom: 14,
                  borderBottom: '1px solid var(--line)',
                }}
              >
                {g.source === 'post_plan' && g.parentId && setRoute ? (
                  <button
                    type="button"
                    onClick={() => setRoute({ view: 'plan', id: g.parentId })}
                    title="Open this post plan"
                    style={{
                      margin: 0,
                      padding: 0,
                      fontSize: 17,
                      fontWeight: 600,
                      color: 'var(--ink-1)',
                      background: 'transparent',
                      border: 0,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-ink)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-1)'; }}
                  >
                    <span>{g.parentTitle}</span>
                    <Icon name="arrow-up-right" size={13} />
                  </button>
                ) : (
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: 'var(--ink-1)' }}>
                    {g.parentTitle}
                  </h3>
                )}
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--ink-3)',
                    background: 'var(--surface-2)',
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--line)',
                  }}
                >
                  {g.parentDateLabel}: {formatShortDate(g.parentDate)}
                </span>
                {g.platforms && (
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>· {g.platforms}</span>
                )}
                <span style={{ fontSize: 11, color: 'var(--ink-4)', marginLeft: 'auto' }}>
                  {g.items.length} {g.items.length === 1 ? 'file' : 'files'}
                  {g.source === 'post_plan' ? ' · Post plan' : ' · Task'}
                </span>
              </header>
              <div className="lib-grid">
                {g.items.map((a) => (
                  <div
                    className="lib-tile"
                    key={a.id}
                    onClick={() => handleOpen(a)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div
                      className="canvas"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--surface-2)',
                        overflow: 'hidden',
                      }}
                    >
                      {a.isImage && thumbs[a.id] ? (
                        <img
                          src={thumbs[a.id]}
                          alt={a.filename}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <div style={{ textAlign: 'center', padding: 12 }}>
                          <Icon name="upload" size={36} />
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--ink-4)',
                              marginTop: 6,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            }}
                          >
                            {(a.mimeType.split('/')[1] || 'file').slice(0, 8)}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="meta">
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={a.filename}
                        >
                          {a.filename}
                        </div>
                      </div>
                      <Icon name="download" size={14} style={{ color: 'var(--ink-4)' }} />
                    </div>
                    <div className="hover-strip">
                      <Icon name="eye" size={12} /> Preview
                      <span style={{ marginLeft: 'auto' }}>
                        <Icon name="arrow-up-right" size={12} />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div></div>
  );
};

function formatShortDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

export { LibraryView };
