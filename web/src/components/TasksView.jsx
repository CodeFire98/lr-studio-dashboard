/* eslint-disable */
/* Tasks list — cards/rows with filters.
   Agency users get an extra scope toggle: All vs. Assigned to me, driven
   by tasks.assigned_lead_id (auto-set by the default-lead trigger and
   reassignable from a task's detail view). */
import React, { useState, useMemo } from 'react';
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

const TasksView = ({ setRoute, tasks, mode }) => {
  const auth = readAuth();
  const viewerId = auth?.id;
  const isAgency = mode === 'admin';

  const [layout, setLayout] = useState("grid");
  const [statusFilter, setStatusFilter] = useState("all");
  const [scope, setScope] = useState("all"); // "all" | "mine" — agency only

  // Apply scope first (agency-only), then the status filter on top.
  const scoped = useMemo(() => {
    if (!isAgency || scope !== 'mine' || !viewerId) return tasks;
    return tasks.filter((t) => t.assignedLeadId === viewerId);
  }, [tasks, isAgency, scope, viewerId]);

  const filtered = scoped.filter((p) => statusFilter === "all" || p.status === statusFilter);

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

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Tasks</h1>
          <div className="sub">{subText}</div>
        </div>
        <div className="actions">
          <button className="btn"><Icon name="filter" size={14}/>Filter</button>
          <button className="btn btn-primary" onClick={() => setRoute({ view: "home" })}>
            <Icon name="plus" size={14}/>New brief
          </button>
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
        <button className="filter-pill">Campaign <span className="caret"><Icon name="chevron-down" size={12}/></span></button>
        <button className="filter-pill">Date <span className="caret"><Icon name="chevron-down" size={12}/></span></button>
        <div className="seg">
          <button className={layout === "grid" ? "on" : ""} onClick={() => setLayout("grid")}><Icon name="grid" size={13}/></button>
          <button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")}><Icon name="list" size={13}/></button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="big">
            {isAgency && scope === 'mine' && statusFilter === 'all'
              ? "Nothing's assigned to you right now."
              : 'Nothing matches that filter.'}
          </div>
          <div>
            {isAgency && scope === 'mine' && statusFilter === 'all' ? (
              <>Try switching to <a onClick={() => setScope('all')} style={{color: "var(--accent)", cursor: "pointer"}}>All tasks</a>.</>
            ) : (
              <>Try another status, or <a onClick={() => setStatusFilter("all")} style={{color: "var(--accent)", cursor: "pointer"}}>clear it</a>.</>
            )}
          </div>
        </div>
      ) : layout === "grid" ? (
        <div className="project-grid">
          {filtered.map((p) => (
            <div key={p.id} className="project-card" onClick={() => setRoute({ view: "tasks", id: p.id })}>
              <div className="project-thumb">
                <Art palette={p.palette} kicker={p.artKicker} label={p.artLabel} variant={p.id.length}/>
                <div className="thumb-status"><StatusBadge status={p.status}/></div>
              </div>
              <div className="project-body">
                <div className="project-tag">{p.tag}</div>
                <div className="project-title">{p.title}</div>
                <div className="project-meta">
                  <span>Due {p.deadline}</span>
                  <span className="dot"/>
                  <AvatarStack people={p.collaborators} size="sm"/>
                </div>
              </div>
            </div>
          ))}
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
