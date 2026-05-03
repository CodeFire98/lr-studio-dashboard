/* eslint-disable */
/* Library — searchable grid of delivered creatives (real assets from DB). */
import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from './Icon.jsx';
import { loadLibraryAssets, loadLibraryPostPlanFinals, assetSignedUrl } from '../lib/db.js';
import { useLightbox } from './Lightbox.jsx';

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

const LibraryView = ({ auth, accountId }) => {
  const [assets, setAssets] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [platformKey, setPlatformKey] = useState('all');
  const [dateKey, setDateKey] = useState('all');
  const [q, setQ] = useState('');

  // Library is always scoped to the active brand — `accountId` is the brand
  // currently selected in the BrandPicker (or the brand owner's own brand).
  // For agency users, this means switching brands changes which creatives
  // show up here. RLS filters work alongside this for non-agency users.
  //
  // We pull from two sources and merge: task deliverables (assets where
  // kind='deliverable') and post-plan finals (post_plan_attachments where
  // kind='final'). Both count as delivered creatives in the user's mental
  // model. Each row carries `source: 'task' | 'post_plan'` so the URL
  // resolution downstream picks the right bucket strategy.
  useEffect(() => {
    if (auth?.requiresBrandSelection) { setAssets([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      loadLibraryAssets({ kind: 'deliverable', accountId }),
      loadLibraryPostPlanFinals({ accountId }),
    ])
      .then(([taskRows, postPlanRows]) => {
        if (cancelled) return;
        // Merge + sort by createdAt desc — newest at the top regardless
        // of which source it came from.
        const merged = [...taskRows, ...postPlanRows].sort(
          (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')
        );
        setAssets(merged);
      })
      .catch((e) => setErr(e.message || String(e)))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, auth?.requiresBrandSelection]);

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
      if (window?.cutoffMs && now - new Date(a.createdAt).getTime() > window.cutoffMs) return false;
      if (needle) {
        const hay = `${a.filename} ${a.taskTitle || ''} ${a.accountName || ''} ${a.taskPlatform || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [assets, platformKey, dateKey, q]);

  const lightbox = useLightbox();
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
      });
    } catch (e) { alert(`Couldn't open: ${e.message || e}`); }
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Library</h1>
          <div className="sub">Every deliverable your agency has shipped. Filter by platform or date.</div>
        </div>
        <div className="actions">
          <div className="topbar-search" style={{background: "var(--surface)", border: "1px solid var(--line)"}}>
            <Icon name="search" size={14}/>
            <input
              placeholder="Search by filename or task…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{border: 0, background: "transparent", outline: "none", fontSize: 13, width: 220}}
            />
          </div>
        </div>
      </div>

      <div className="filterbar">
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
            ? "As your agency delivers creatives, they'll land here."
            : "No delivered creatives match those filters."}
        </div>
      ) : (
        <div className="lib-grid">
          {filtered.map((a) => (
            <div className="lib-tile" key={a.id} onClick={() => handleOpen(a)} style={{cursor: "pointer"}}>
              <div className="canvas" style={{display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-2)", overflow: "hidden"}}>
                {a.isImage && thumbs[a.id] ? (
                  <img src={thumbs[a.id]} alt={a.filename} style={{width: "100%", height: "100%", objectFit: "cover"}}/>
                ) : (
                  <div style={{textAlign: "center", padding: 12}}>
                    <Icon name="upload" size={36}/>
                    <div style={{fontSize: 11, color: "var(--ink-4)", marginTop: 6, textTransform: "uppercase", letterSpacing: 0.5}}>
                      {(a.mimeType.split('/')[1] || 'file').slice(0, 8)}
                    </div>
                  </div>
                )}
              </div>
              <div className="meta">
                <div>
                  <div style={{fontWeight: 500}}>{a.filename}</div>
                  <div className="type" style={{marginTop: 2}}>
                    {a.source === 'post_plan' ? 'Post plan' : 'Task'} · {a.parentTitle || a.taskTitle} · {formatShortDate(a.createdAt)}
                  </div>
                </div>
                <Icon name="download" size={14} style={{color: "var(--ink-4)"}}/>
              </div>
              <div className="hover-strip">
                <Icon name="eye" size={12}/> Preview
                <span style={{marginLeft: "auto"}}><Icon name="arrow-up-right" size={12}/></span>
              </div>
            </div>
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
