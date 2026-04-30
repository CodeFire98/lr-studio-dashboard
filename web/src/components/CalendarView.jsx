/* eslint-disable */
/* Calendar — content-calendar style. Month-grid view places task chips in
   their deadline day cell; List view keeps the older grouped-by-month
   layout for dense scanning. Read-only — clicking a chip opens the task. */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { AvatarStack, StatusBadge } from './primitives.jsx';

const MONTH_FORMAT  = { month: 'long',  year: 'numeric' };
const HEADING_FMT   = { month: 'short', year: 'numeric' };
const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_COLOR = {
  brief:     'var(--status-brief)',
  progress:  'var(--status-progress)',
  review:    'var(--status-review)',
  delivered: 'var(--status-delivered)',
  revising:  'var(--status-progress)',
};
const MAX_CHIPS_PER_CELL = 3;

function isoLocalDate(d) {
  // YYYY-MM-DD in local time, matches the format `tasks.deadline` is stored as.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildMonthMatrix(viewYear, viewMonth) {
  // Start from the Sunday on or before the 1st of the month.
  const first = new Date(viewYear, viewMonth, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const today = new Date();
  const todayIso = isoLocalDate(today);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({
      date: d,
      iso: isoLocalDate(d),
      day: d.getDate(),
      inMonth: d.getMonth() === viewMonth,
      isToday: isoLocalDate(d) === todayIso,
    });
  }
  return cells;
}

function formatMonthHeading(ym) {
  if (ym === 'no-deadline') return 'No deadline';
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-US', MONTH_FORMAT);
}

const TaskChip = ({ task, onOpen, showBrand }) => {
  const color = STATUS_COLOR[task.status] || 'var(--ink-4)';
  const brand = task.accountName || task.tag;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(task.id); }}
      title={`${task.title} · ${brand || 'Brief'} · ${task.status}`}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '3px 6px 3px 8px',
        marginBottom: 3,
        borderRadius: 4,
        border: 0,
        borderLeft: `3px solid ${color}`,
        background: 'var(--surface-2)',
        color: 'var(--ink-2)',
        fontSize: 11.5,
        lineHeight: 1.25,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {showBrand && brand && (
        <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}>{brand} · </span>
      )}
      {task.title}
    </button>
  );
};

const MonthGrid = ({ viewDate, setViewDate, tasksByDate, onOpenTask, onOpenDay, showBrand }) => {
  const cells = useMemo(
    () => buildMonthMatrix(viewDate.getFullYear(), viewDate.getMonth()),
    [viewDate]
  );

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--surface)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        {WEEKDAY_LABEL.map((d) => (
          <div
            key={d}
            style={{
              padding: '8px 10px',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {d}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(110px, 1fr)' }}>
        {cells.map((c, i) => {
          const tasks = tasksByDate.get(c.iso) || [];
          const visible = tasks.slice(0, MAX_CHIPS_PER_CELL);
          const overflow = tasks.length - visible.length;
          return (
            <div
              key={c.iso + '_' + i}
              style={{
                padding: 6,
                borderRight: (i % 7 === 6) ? 'none' : '1px solid var(--line-2)',
                borderBottom: i < 35 ? '1px solid var(--line-2)' : 'none',
                background: c.isToday
                  ? 'color-mix(in oklab, var(--accent) 8%, var(--surface))'
                  : c.inMonth ? 'var(--surface)' : 'var(--surface-2)',
                opacity: c.inMonth ? 1 : 0.55,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
              }}
            >
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: c.isToday ? 600 : 500,
                  color: c.isToday ? 'var(--accent)' : 'var(--ink-3)',
                  marginBottom: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                }}
              >
                <span>
                  {c.day}
                  {c.isToday && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500 }}>Today</span>}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {visible.map((t) => (
                  <TaskChip key={t.id} task={t} onOpen={onOpenTask} showBrand={showBrand}/>
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpenDay(c.iso); }}
                    style={{
                      border: 0,
                      background: 'transparent',
                      color: 'var(--ink-3)',
                      padding: '2px 6px',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ListLayout = ({ tasks, onOpenTask }) => {
  const groups = useMemo(() => {
    const byMonth = new Map();
    for (const t of tasks) {
      const iso = t.deadlineDate;
      const key = iso ? String(iso).slice(0, 7) : 'no-deadline';
      const list = byMonth.get(key) || [];
      list.push(t);
      byMonth.set(key, list);
    }
    for (const [, list] of byMonth) {
      list.sort((a, b) => (a.deadlineDate || '').localeCompare(b.deadlineDate || ''));
    }
    const keys = Array.from(byMonth.keys()).sort((a, b) => {
      if (a === 'no-deadline') return 1;
      if (b === 'no-deadline') return -1;
      return a.localeCompare(b);
    });
    return keys.map((k) => [k, byMonth.get(k)]);
  }, [tasks]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {groups.map(([ym, list]) => (
        <section key={ym}>
          <div className="tiny" style={{ marginBottom: 10 }}>{formatMonthHeading(ym)} · {list.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map((t) => (
              <div key={t.id} className="admin-q-row" onClick={() => onOpenTask(t.id)}>
                <div className="urgency"/>
                <div>
                  <div className="title">{t.title}</div>
                  <div className="sub">{t.accountName || t.tag || 'Brief'} · {t.createdAt}</div>
                </div>
                <div><StatusBadge status={t.status}/></div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Due {t.deadline}</div>
                <div><AvatarStack people={t.collaborators || []} size="sm"/></div>
                <div style={{ color: 'var(--ink-4)' }}><Icon name="chevron-right" size={16}/></div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

const CalendarView = ({ tasks = [], setRoute }) => {
  const [layout, setLayout] = useState(() => {
    const hasDated = tasks.some((t) => t.deadlineDate);
    return hasDated ? 'month' : 'list';
  });
  const [viewDate, setViewDate] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });

  // Ensure stale state doesn't survive a fully-empty dataset.
  useEffect(() => {
    if (layout === 'month' && tasks.length === 0) setLayout('list');
  }, [tasks.length, layout]);

  const tasksByDate = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      if (!t.deadlineDate) continue;
      const list = map.get(t.deadlineDate) || [];
      list.push(t);
      map.set(t.deadlineDate, list);
    }
    // Stable sort within a day: brief → progress → review → revising → delivered.
    const order = { brief: 0, progress: 1, review: 2, revising: 3, delivered: 4 };
    for (const [, list] of map) {
      list.sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99));
    }
    return map;
  }, [tasks]);

  const undatedCount = useMemo(() => tasks.filter((t) => !t.deadlineDate).length, [tasks]);

  // If the dataset spans multiple brand accounts (i.e. agency view), show
  // the brand name on each chip so the day cell is meaningful at a glance.
  const showBrand = useMemo(() => {
    const seen = new Set();
    for (const t of tasks) {
      if (t.accountId) seen.add(t.accountId);
      if (seen.size > 1) return true;
    }
    return false;
  }, [tasks]);

  const open = (id) => setRoute?.({ view: 'tasks', id });
  const openDay = (iso) => {
    // Day-overflow: easiest is to flip to list view; the bucket for that
    // month is right at the top.
    setLayout('list');
  };

  const goPrev = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  const goNext = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  const goToday = () => {
    const today = new Date();
    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>Schedule</div>
          <h1>Social Calendar</h1>
          <div className="sub">Plan and preview every Instagram, LinkedIn, and X post for your brand. Click a chip to open the post.</div>
        </div>
        <div className="actions">
          <div className="seg">
            <button className={layout === 'month' ? 'on' : ''} onClick={() => setLayout('month')}>Month</button>
            <button className={layout === 'list'  ? 'on' : ''} onClick={() => setLayout('list')}>List</button>
          </div>
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="empty" style={{ padding: 32 }}>
          <div className="big">No posts scheduled yet.</div>
          Once your agency lead schedules Instagram, LinkedIn, or X posts they'll show up here.
        </div>
      ) : layout === 'month' ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 14,
            }}
          >
            <button className="btn btn-sm btn-ghost" onClick={goPrev} aria-label="Previous month">
              <Icon name="chevron-left" size={14}/>
            </button>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, minWidth: 180 }}>
              {viewDate.toLocaleDateString('en-US', HEADING_FMT)}
            </div>
            <button className="btn btn-sm btn-ghost" onClick={goNext} aria-label="Next month">
              <Icon name="chevron-right" size={14}/>
            </button>
            <button className="btn btn-sm" onClick={goToday}>Today</button>
            <div style={{ flex: 1 }}/>
            {undatedCount > 0 && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setLayout('list')}
                title="No-deadline tasks live in the List view"
              >
                {undatedCount} undated · view in list
              </button>
            )}
          </div>
          <MonthGrid
            viewDate={viewDate}
            setViewDate={setViewDate}
            tasksByDate={tasksByDate}
            onOpenTask={open}
            onOpenDay={openDay}
            showBrand={showBrand}
          />
          <div style={{ display: 'flex', gap: 14, marginTop: 14, fontSize: 11.5, color: 'var(--ink-3)', flexWrap: 'wrap' }}>
            {[
              ['Brief', 'brief'],
              ['In progress', 'progress'],
              ['In review', 'review'],
              ['Revising', 'revising'],
              ['Delivered', 'delivered'],
            ].map(([label, key]) => (
              <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLOR[key] }}/>
                {label}
              </span>
            ))}
          </div>
        </>
      ) : (
        <ListLayout tasks={tasks} onOpenTask={open}/>
      )}
    </div></div>
  );
};

export { CalendarView };
