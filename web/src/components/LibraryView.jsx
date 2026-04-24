/* eslint-disable */
/* Library — searchable grid of delivered creatives (real assets from DB). */
import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from './Icon.jsx';
import { loadLibraryAssets, assetSignedUrl } from '../lib/db.js';

const TYPE_FILTERS = [
  { key: 'all', label: 'All types', test: () => true },
  { key: 'image', label: 'Images', test: (a) => (a.mimeType || '').startsWith('image/') },
  { key: 'video', label: 'Videos', test: (a) => (a.mimeType || '').startsWith('video/') },
  { key: 'doc', label: 'Docs', test: (a) => !(a.mimeType || '').startsWith('image/') && !(a.mimeType || '').startsWith('video/') },
];

const DATE_WINDOWS = [
  { key: 'all', label: 'All time', cutoffMs: 0 },
  { key: 'week', label: 'Past week', cutoffMs: 7 * 86400000 },
  { key: 'month', label: 'Past month', cutoffMs: 30 * 86400000 },
  { key: 'quarter', label: 'Past 90 days', cutoffMs: 90 * 86400000 },
];

const LibraryView = () => {
  const [assets, setAssets] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [typeKey, setTypeKey] = useState('all');
  const [dateKey, setDateKey] = useState('all');
  const [taskId, setTaskId] = useState('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadLibraryAssets({ kind: 'deliverable' })
      .then((rows) => { if (!cancelled) setAssets(rows); })
      .catch((e) => setErr(e.message || String(e)))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Sign image URLs lazily.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const needs = assets.filter((a) => a.isImage && !thumbs[a.id]);
      if (!needs.length) return;
      const next = {};
      for (const a of needs) {
        try { next[a.id] = await assetSignedUrl(a.storagePath); } catch {}
      }
      if (!cancelled && Object.keys(next).length) setThumbs((p) => ({ ...p, ...next }));
    })();
    return () => { cancelled = true; };
  }, [assets]);

  const tasks = useMemo(() => {
    const seen = new Map();
    for (const a of assets) {
      if (!a.taskId) continue;
      if (!seen.has(a.taskId)) seen.set(a.taskId, { id: a.taskId, title: a.taskTitle });
    }
    return [{ id: 'all', title: 'All tasks' }, ...Array.from(seen.values())];
  }, [assets]);

  const filtered = useMemo(() => {
    const typeTest = TYPE_FILTERS.find((t) => t.key === typeKey)?.test || (() => true);
    const window = DATE_WINDOWS.find((w) => w.key === dateKey);
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    return assets.filter((a) => {
      if (!typeTest(a)) return false;
      if (taskId !== 'all' && a.taskId !== taskId) return false;
      if (window?.cutoffMs && now - new Date(a.createdAt).getTime() > window.cutoffMs) return false;
      if (needle) {
        const hay = `${a.filename} ${a.taskTitle || ''} ${a.accountName || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [assets, typeKey, dateKey, taskId, q]);

  const handleOpen = async (a) => {
    try {
      const url = await assetSignedUrl(a.storagePath);
      window.open(url, '_blank');
    } catch (e) { alert(`Couldn't open: ${e.message || e}`); }
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Library</h1>
          <div className="sub">Every deliverable your agency has shipped. Filter by task, date, or file type.</div>
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
          {TYPE_FILTERS.map((t) => (
            <button key={t.key} className={typeKey === t.key ? "on" : ""} onClick={() => setTypeKey(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{flex: 1}}/>
        <select
          className="filter-pill"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          style={{padding: "6px 12px", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 999}}
        >
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
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
                  <div className="type" style={{marginTop: 2}}>{a.taskTitle} · {formatShortDate(a.createdAt)}</div>
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
