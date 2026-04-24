/* eslint-disable */
/* Tasks list — cards/rows with filters */
import React, { useState, useMemo } from 'react';
import { Icon } from './Icon.jsx';
import { Art, AvatarStack, StatusBadge, STATUS_LABELS } from './primitives.jsx';

const TasksView = ({ setRoute, tasks, mode }) => {
  const [layout, setLayout] = useState("grid");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = tasks.filter((p) => statusFilter === "all" || p.status === statusFilter);

  const statusCounts = useMemo(() => {
    const c = { all: tasks.length };
    for (const p of tasks) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [tasks]);

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Tasks</h1>
          <div className="sub">{tasks.length} briefs · 2 delivered this month</div>
        </div>
        <div className="actions">
          <button className="btn"><Icon name="filter" size={14}/>Filter</button>
          <button className="btn btn-primary" onClick={() => setRoute({ view: "home" })}>
            <Icon name="plus" size={14}/>New brief
          </button>
        </div>
      </div>

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
          <div className="big">Nothing matches that filter.</div>
          <div>Try another status, or <a onClick={() => setStatusFilter("all")} style={{color: "var(--accent)", cursor: "pointer"}}>clear it</a>.</div>
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
