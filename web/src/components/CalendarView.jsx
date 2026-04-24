/* eslint-disable */
/* Calendar — tasks grouped by deadline month. Read-only surface for scanning
   what's due when; clicking a row opens the task detail. */
import React, { useMemo } from 'react';
import { Icon } from './Icon.jsx';
import { AvatarStack, StatusBadge } from './primitives.jsx';

const MONTH_FORMAT = { month: 'long', year: 'numeric' };

function formatMonthHeading(ym) {
  if (ym === 'no-deadline') return 'No deadline';
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  if (isNaN(d.getTime())) return ym;
  return d.toLocaleDateString('en-US', MONTH_FORMAT);
}

const CalendarView = ({ tasks = [], setRoute }) => {
  const groups = useMemo(() => {
    const byMonth = new Map();
    for (const t of tasks) {
      const iso = t.deadlineDate;
      const key = iso ? String(iso).slice(0, 7) : 'no-deadline';
      const list = byMonth.get(key) || [];
      list.push(t);
      byMonth.set(key, list);
    }
    // Sort each bucket by date ascending; push undated entries to the bottom.
    for (const [k, list] of byMonth) {
      list.sort((a, b) => {
        const ad = a.deadlineDate || '';
        const bd = b.deadlineDate || '';
        return ad.localeCompare(bd);
      });
    }
    // Order buckets: dated ascending, no-deadline last.
    const keys = Array.from(byMonth.keys());
    keys.sort((a, b) => {
      if (a === 'no-deadline') return 1;
      if (b === 'no-deadline') return -1;
      return a.localeCompare(b);
    });
    return keys.map((k) => [k, byMonth.get(k)]);
  }, [tasks]);

  const open = (id) => setRoute?.({ view: 'tasks', id });

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>Schedule</div>
          <h1>Calendar</h1>
          <div className="sub">Every task grouped by deadline month. Click a row to jump in.</div>
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="empty" style={{ padding: 32 }}>
          <div className="big">No tasks yet.</div>
          Submit a brief from Home and it'll appear here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {groups.map(([ym, list]) => (
            <section key={ym}>
              <div className="tiny" style={{ marginBottom: 10 }}>{formatMonthHeading(ym)} · {list.length}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {list.map((t) => (
                  <div
                    key={t.id}
                    className="admin-q-row"
                    onClick={() => open(t.id)}
                  >
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
      )}
    </div></div>
  );
};

export { CalendarView };
