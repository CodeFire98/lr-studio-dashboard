/* eslint-disable */
/* Tasks list — cards/rows with filters.
   Agency users get an extra scope toggle: All vs. Assigned to me, driven
   by tasks.assigned_lead_id (auto-set by the default-lead trigger and
   reassignable from a task's detail view). */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { Art, AvatarStack, StatusBadge, STATUS_LABELS } from './primitives.jsx';
import { readAuth } from '../lib/auth.js';

function deliveredThisMonthCount(tasks) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  let n = 0;
  for (const t of tasks) {
    if (t.status !== 'delivered') continue;
    const iso = t.deliveredAtISO || t.createdAtISO;
    if (!iso) continue;
    const d = new Date(iso);
    if (d.getFullYear() === y && d.getMonth() === m) n += 1;
  }
  return n;
}

// Reusable filter pill with a click-out dropdown. Active state highlights
// when the value is anything other than the "all" sentinel.
const FilterPill = ({ label, value, options, onChange, allValue = 'all' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const active = value !== allValue;
  const current = options.find((o) => o.value === value);
  const display = active ? current?.label || label : label;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="filter-pill"
        onClick={() => setOpen((v) => !v)}
        style={active ? {
          background: 'var(--accent-tint)',
          borderColor: 'color-mix(in oklab, var(--accent) 35%, transparent)',
          color: 'var(--accent-ink)',
        } : undefined}
      >
        {display}
        <span className="caret"><Icon name="chevron-down" size={12}/></span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 180,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            padding: 4,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {options.map((opt) => {
            const sel = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitem"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '7px 10px',
                  border: 0,
                  background: sel ? 'var(--surface-2)' : 'transparent',
                  color: 'var(--ink-2)',
                  fontSize: 13,
                  textAlign: 'left',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
              >
                <span>{opt.label}</span>
                {sel && <Icon name="check" size={12}/>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const DATE_OPTIONS = [
  { value: 'all',     label: 'Date · Any' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'week',    label: 'Due this week' },
  { value: 'month',   label: 'Due this month' },
  { value: 'unset',   label: 'No deadline' },
];

function passesDateFilter(task, value) {
  if (value === 'all') return true;
  const iso = task.deadlineDate;
  if (value === 'unset') return !iso;
  if (!iso) return false;
  const due = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === 'overdue') {
    return due < todayStart && task.status !== 'delivered';
  }
  if (value === 'week') {
    const weekEnd = new Date(todayStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return due >= todayStart && due <= weekEnd;
  }
  if (value === 'month') {
    return due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth();
  }
  return true;
}

function platformOf(task) {
  return task.brief?.chips?.platform?.value || null;
}

// Stage-tiered preview: real creative thumbnails when uploaded, otherwise a
// typographic poster keyed off the brief metadata. Falls back to the poster
// gracefully if a signed image URL fails to load.
const TaskPreview = ({ task }) => {
  const [failed, setFailed] = useState(false);
  const preview = task.previewAssets;
  const items = preview?.items || [];
  const kind = failed ? 'empty' : (preview?.kind || 'empty');

  if (kind === 'hero' && items[0]) {
    return (
      <div className="tp-hero">
        <img src={items[0].url} alt="" onError={() => setFailed(true)} loading="lazy" />
        {task.status === 'delivered' && task.artLabel && (
          <span className="tp-overlay-bottom">{task.artLabel}</span>
        )}
      </div>
    );
  }

  if (kind === 'collage') {
    return (
      <div className={`tp-collage tp-collage-${items.length}`}>
        {items.map((it, i) => (
          <div key={it.id} className="tp-tile">
            <img src={it.url} alt="" onError={() => setFailed(true)} loading="lazy" />
            {i === 0 && it.version > 1 && <span className="tp-version">v{it.version}</span>}
          </div>
        ))}
      </div>
    );
  }

  if (kind === 'reference' && items[0]) {
    return (
      <div className="tp-hero tp-reference">
        <img src={items[0].url} alt="" onError={() => setFailed(true)} loading="lazy" />
        <span className="tp-ref-tag">Reference</span>
      </div>
    );
  }

  return <TaskPoster task={task} />;
};

// Editorial empty state: brand-ish palette ground, big serif anchor (creative
// count / format / objective), thin format · platform subline, 3-stripe
// palette accent at the bottom edge. The card always renders something
// distinguishable, even before any asset has been uploaded.
const TaskPoster = ({ task }) => {
  const palette = task.palette || ['#F4EBDD', '#E8C9A8', '#1B1F1C'];
  const [bg, mid, ink] = palette;
  const chips = task.brief?.chips || {};
  const count = chips.count?.value;
  const countUnit = chips.count?.unit || 'creatives';
  const format = chips.format?.value || null;
  const platform = chips.platform?.value || null;
  const objective = chips.objective?.value || null;

  let heroNum = null;
  let heroLabel = null;
  if (count) {
    heroNum = String(count);
    heroLabel = countUnit;
  } else if (format) {
    heroLabel = format;
  } else {
    heroLabel = task.title.split(/\s+/).slice(0, 4).join(' ');
  }
  const subline = [format, platform].filter(Boolean).join(' · ');

  return (
    <div className="tp-poster" style={{ background: bg, color: ink }}>
      <div className="tp-poster-bleed" style={{ background: `radial-gradient(circle at 70% 25%, ${mid}, transparent 65%)` }} />
      <div className="tp-poster-inner">
        {heroNum && <div className="tp-poster-num" style={{ color: ink }}>{heroNum}</div>}
        <div className="tp-poster-label" style={{ color: ink }}>{heroLabel}</div>
        {(count && subline) && (
          <div className="tp-poster-sub" style={{ color: `color-mix(in oklab, ${ink} 65%, transparent)` }}>
            {subline}
          </div>
        )}
        {!count && objective && (
          <div className="tp-poster-sub" style={{ color: `color-mix(in oklab, ${ink} 65%, transparent)` }}>
            {objective}
          </div>
        )}
      </div>
      <div className="tp-poster-stripe">
        {palette.slice(0, 3).map((c, i) => <span key={i} style={{ background: c }} />)}
      </div>
    </div>
  );
};

// Thin progress-style line at the bottom edge of the thumbnail. Hidden when
// the deadline is far out (>14d), full green when delivered, full red when
// overdue and not delivered. Drives the eye toward what's actually due.
const UrgencyBar = ({ task }) => {
  if (task.status === 'delivered') {
    return <div className="urgency-bar"><div className="urgency-fill urgency-delivered" /></div>;
  }
  if (!task.deadlineDate) return null;
  const due = new Date(task.deadlineDate);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - todayStart) / 86400000);
  if (days > 14) return null;
  let pct, tone;
  if (days < 0) { pct = 100; tone = 'overdue'; }
  else if (days <= 2) { pct = 95; tone = 'urgent'; }
  else if (days <= 7) { pct = 70; tone = 'warm'; }
  else { pct = 40; tone = 'soon'; }
  return (
    <div className="urgency-bar">
      <div className={`urgency-fill urgency-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
};

const TasksView = ({ setRoute, tasks, mode }) => {
  const auth = readAuth();
  const viewerId = auth?.id;
  const isAgency = mode === 'admin';

  const [layout, setLayout] = useState("grid");
  const [statusFilter, setStatusFilter] = useState("all");
  const [scope, setScope] = useState("all"); // "all" | "mine" — agency only
  const [dateFilter, setDateFilter] = useState('all');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Apply scope first (agency-only), then chained filters on top.
  const scoped = useMemo(() => {
    if (!isAgency || scope !== 'mine' || !viewerId) return tasks;
    return tasks.filter((t) => t.assignedLeadId === viewerId);
  }, [tasks, isAgency, scope, viewerId]);

  // Build the platform options dynamically from whatever's in the (scoped) data
  // so we never offer a filter that returns zero results.
  const platformOptions = useMemo(() => {
    const seen = new Map();
    for (const t of scoped) {
      const p = platformOf(t);
      if (!p) continue;
      seen.set(p.toLowerCase(), p);
    }
    const opts = [{ value: 'all', label: 'Platform · Any' }];
    for (const [, label] of seen) opts.push({ value: label, label });
    return opts;
  }, [scoped]);

  // If the active platform filter no longer exists in the dataset, reset it.
  useEffect(() => {
    if (platformFilter === 'all') return;
    const has = platformOptions.some((o) => o.value === platformFilter);
    if (!has) setPlatformFilter('all');
  }, [platformOptions, platformFilter]);

  const filtered = scoped.filter((p) => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (platformFilter !== 'all' && platformOf(p) !== platformFilter) return false;
    if (!passesDateFilter(p, dateFilter)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const title = (p.title || '').toLowerCase();
      const brand = (p.tag || '').toLowerCase();
      if (!title.includes(q) && !brand.includes(q)) return false;
    }
    return true;
  });

  const statusCounts = useMemo(() => {
    const c = { all: scoped.length };
    for (const p of scoped) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [scoped]);

  const deliveredCount = useMemo(() => deliveredThisMonthCount(scoped), [scoped]);
  const assignedToMeCount = useMemo(() => {
    if (!isAgency || !viewerId) return 0;
    return tasks.filter((t) => t.assignedLeadId === viewerId).length;
  }, [tasks, isAgency, viewerId]);

  const subText = `${scoped.length} ${scoped.length === 1 ? 'brief' : 'briefs'} · ${deliveredCount} delivered this month`;
  const filtersDirty = statusFilter !== 'all' || platformFilter !== 'all' || dateFilter !== 'all' || searchQuery !== '';
  const clearAllFilters = () => {
    setStatusFilter('all');
    setPlatformFilter('all');
    setDateFilter('all');
    setSearchQuery('');
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Tasks</h1>
          <div className="sub">{subText}</div>
        </div>
        <div className="actions">
          {!isAgency && (
            <button className="btn btn-primary" onClick={() => setRoute({ view: "home" })}>
              <Icon name="plus" size={14}/>New brief
            </button>
          )}
        </div>
      </div>

      {isAgency && (
        <div className="filterbar" style={{ marginBottom: 12 }}>
          <div className="seg">
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
              All tasks<span className="seg-count">{tasks.length}</span>
            </button>
            <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>
              Assigned to me<span className="seg-count">{assignedToMeCount}</span>
            </button>
          </div>
        </div>
      )}

      <div className="filterbar">
        <div className="seg">
          {["all","brief","progress","review","delivered","revising"].map((s) => (
            <button key={s} className={statusFilter === s ? "on" : ""} onClick={() => setStatusFilter(s)}>
              {s === "all" ? "All" : STATUS_LABELS[s]}
              <span className="seg-count">{statusCounts[s] || 0}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {filtersDirty && (
          <button className="btn btn-sm btn-ghost" onClick={clearAllFilters} style={{ fontSize: 12 }}>
            Clear filters
          </button>
        )}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Icon name="search" size={13} style={{ position: 'absolute', left: 9, color: 'var(--ink-4)', pointerEvents: 'none' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search brand or task…"
            style={{
              padding: '6px 10px 6px 30px',
              fontSize: 13,
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              width: 200,
              outline: 'none',
            }}
          />
        </div>
        <FilterPill
          label="Platform"
          value={platformFilter}
          onChange={setPlatformFilter}
          options={platformOptions}
        />
        <FilterPill
          label="Date"
          value={dateFilter}
          onChange={setDateFilter}
          options={DATE_OPTIONS}
        />
        <div className="seg">
          <button className={layout === "grid" ? "on" : ""} onClick={() => setLayout("grid")}><Icon name="grid" size={13}/></button>
          <button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")}><Icon name="list" size={13}/></button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="big">
            {isAgency && scope === 'mine' && !filtersDirty
              ? "Nothing's assigned to you right now."
              : 'Nothing matches that filter.'}
          </div>
          <div>
            {isAgency && scope === 'mine' && !filtersDirty ? (
              <>Try switching to <a onClick={() => setScope('all')} style={{color: "var(--accent)", cursor: "pointer"}}>All tasks</a>.</>
            ) : (
              <>Try a different combination, or <a onClick={clearAllFilters} style={{color: "var(--accent)", cursor: "pointer"}}>clear all filters</a>.</>
            )}
          </div>
        </div>
      ) : layout === "grid" ? (
        <div className="project-grid">
          {filtered.map((p) => {
            const chips = p.brief?.chips || {};
            const count = chips.count?.value;
            const format = chips.format?.value;
            const platform = chips.platform?.value;
            return (
              <div key={p.id} className="project-card" onClick={() => setRoute({ view: "tasks", id: p.id })}>
                <div className="project-thumb">
                  <TaskPreview task={p} />
                  <div className="thumb-status"><StatusBadge status={p.status}/></div>
                  <UrgencyBar task={p} />
                </div>
                <div className="project-body">
                  <div className="project-tag">{p.tag}</div>
                  <div className="project-title">{p.title}</div>
                  {(count || format || platform) && (
                    <div className="project-meta-chips">
                      {count && <span className="meta-chip">{count} {chips.count?.unit || 'creatives'}</span>}
                      {format && <span className="meta-chip meta-chip-faded">{format}</span>}
                      {platform && <span className="meta-chip meta-chip-faded">{platform}</span>}
                    </div>
                  )}
                  <div className="project-meta">
                    <span>Due {p.deadline}</span>
                    <span className="dot"/>
                    <AvatarStack people={p.collaborators} size="sm"/>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="project-list">
          <div className="project-row is-head">
            <div>Task</div>
            <div>Status</div>
            <div>Deadline</div>
            <div>Team</div>
            <div></div>
          </div>
          {filtered.map((p) => (
            <div key={p.id} className="project-row" onClick={() => setRoute({ view: "tasks", id: p.id })}>
              <div className="name">
                <div className="thumb-mini" style={{ position: "relative" }}>
                  <Art palette={p.palette} variant={p.id.length}/>
                </div>
                <div>
                  <div className="title">{p.title}</div>
                  <div className="tag">{p.tag}</div>
                </div>
              </div>
              <div><StatusBadge status={p.status}/></div>
              <div style={{ fontSize: 13, color: "var(--ink-3)" }}>{p.deadline}</div>
              <div><AvatarStack people={p.collaborators} size="sm"/></div>
              <div style={{ color: "var(--ink-4)" }}><Icon name="chevron-right" size={16}/></div>
            </div>
          ))}
        </div>
      )}
    </div></div>
  );
};

export { TasksView };
