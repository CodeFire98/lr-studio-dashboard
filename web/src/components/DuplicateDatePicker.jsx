/* eslint-disable */
/* DuplicateDatePicker — modal for selecting one or more target dates when
   duplicating a post plan. Renders a mini month grid with toggleable day
   cells, selected-date pills, and confirm/cancel actions. */
import React, { useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildMonthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const today = new Date();
  const todayKey = isoKey(today);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({
      date: d,
      key: isoKey(d),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      isToday: isoKey(d) === todayKey,
    });
  }
  return cells;
}

const DuplicateDatePicker = ({ open, onConfirm, onCancel, sourcePlan }) => {
  const [viewDate, setViewDate] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [selected, setSelected] = useState(new Map()); // key → Date

  const cells = useMemo(
    () => buildMonthMatrix(viewDate.getFullYear(), viewDate.getMonth()),
    [viewDate]
  );

  const goPrev = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  const goNext = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));

  const toggleDate = (cell) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(cell.key)) {
        next.delete(cell.key);
      } else {
        next.set(cell.key, cell.date);
      }
      return next;
    });
  };

  const removeDate = (key) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  };

  const handleConfirm = () => {
    const dates = Array.from(selected.values()).sort((a, b) => a - b);
    onConfirm(dates);
    setSelected(new Map());
  };

  const handleCancel = () => {
    setSelected(new Map());
    onCancel();
  };

  if (!open) return null;

  const count = selected.size;
  const sortedPills = Array.from(selected.entries()).sort((a, b) => a[1] - b[1]);

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 400, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="login-modal-head" style={{ paddingBottom: 10 }}>
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>
            Duplicate post plan
          </h2>
          {sourcePlan?.concept && (
            <p className="login-modal-sub" style={{ marginTop: 4, fontSize: 13 }}>
              {sourcePlan.concept}
            </p>
          )}
        </div>

        {/* Month navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px 8px' }}>
          <button className="btn btn-sm btn-ghost" onClick={goPrev} aria-label="Previous month" type="button">
            <Icon name="chevron-left" size={14} />
          </button>
          <div style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-serif)', fontSize: 18 }}>
            {viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={goNext} aria-label="Next month" type="button">
            <Icon name="chevron-right" size={14} />
          </button>
        </div>

        {/* Weekday headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 20px', gap: 0 }}>
          {WEEKDAY_LABEL.map((d) => (
            <div
              key={d}
              style={{
                textAlign: 'center',
                fontSize: 10.5,
                fontWeight: 500,
                color: 'var(--ink-4)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                padding: '4px 0',
              }}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 20px', gap: 2 }}>
          {cells.map((c) => {
            const isSelected = selected.has(c.key);
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleDate(c)}
                style={{
                  width: '100%',
                  aspectRatio: '1',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12.5,
                  fontWeight: c.isToday ? 600 : 400,
                  color: isSelected
                    ? 'var(--accent-contrast)'
                    : c.inMonth
                      ? (c.isToday ? 'var(--accent)' : 'var(--ink-1)')
                      : 'var(--ink-5)',
                  background: isSelected
                    ? 'var(--accent)'
                    : 'transparent',
                  border: 0,
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  transition: 'background 100ms, color 100ms',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--surface-2)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'transparent';
                }}
              >
                {c.day}
              </button>
            );
          })}
        </div>

        {/* Selected date pills */}
        {sortedPills.length > 0 && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            padding: '12px 20px 0',
          }}>
            {sortedPills.map(([key, date]) => (
              <span
                key={key}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px 3px 10px',
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent-ink)',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                <button
                  type="button"
                  onClick={() => removeDate(key)}
                  aria-label={`Remove ${date.toLocaleDateString()}`}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: 'var(--accent-ink)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: 0,
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div
          className="login-modal-body"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '16px 20px 20px' }}
        >
          <button type="button" className="btn btn-ghost" onClick={handleCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={count === 0}
            onClick={handleConfirm}
          >
            Duplicate to {count} date{count !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export { DuplicateDatePicker };
