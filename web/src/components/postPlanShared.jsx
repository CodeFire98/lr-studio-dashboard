/* eslint-disable */
/* Shared post-plan primitives — platform config, status config, and the
   small chips used across the calendar grid, the detail view, and any
   other surface that needs to render a post plan inline. */
import React from 'react';

// =====================================================================
// Platform config
// =====================================================================

export const PLATFORMS = [
  {
    key: 'instagram',
    label: 'Instagram',
    short: 'IG',
    background: 'linear-gradient(135deg, #F58529 0%, #DD2A7B 50%, #515BD4 100%)',
    color: '#fff',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    short: 'in',
    background: '#0A66C2',
    color: '#fff',
  },
  {
    key: 'x',
    label: 'X',
    short: 'X',
    background: '#000',
    color: '#fff',
  },
];

export const PLATFORM_BY_KEY = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));

// =====================================================================
// Status config
// =====================================================================

// Three-state workflow — see migration 0035 for the rationale and the
// row-remap from the legacy 8-value enum. Comments are how the brand
// signals "needs changes" — there's no separate revision status.
//
// Legacy keys (`not_started`, `wip`, `needs_brand_feedback`, etc.) are
// kept here as fallback aliases so any cached client / server cron that
// fires a row through realtime with an old value still renders with a
// sane label and colour. Once we're confident no surface still emits
// the old values we can prune the aliases.
export const STATUS_CONFIG = {
  drafting:     { label: 'Drafting',     color: 'var(--ink-4)',         background: 'var(--surface-2)' },
  needs_review: { label: 'Needs review', color: 'var(--status-review)', background: 'color-mix(in oklab, var(--status-review) 14%, var(--surface))' },
  approved:     { label: 'Approved',     color: 'var(--good)',          background: 'color-mix(in oklab, var(--good) 14%, var(--surface))' },

  // Legacy aliases — render any cached row that slips through with a
  // sensible bucket equivalent rather than the unknown-status fallback.
  not_started:          { label: 'Drafting',     color: 'var(--ink-4)',         background: 'var(--surface-2)' },
  wip:                  { label: 'Drafting',     color: 'var(--ink-4)',         background: 'var(--surface-2)' },
  delayed:              { label: 'Drafting',     color: 'var(--ink-4)',         background: 'var(--surface-2)' },
  needs_brand_feedback: { label: 'Needs review', color: 'var(--status-review)', background: 'color-mix(in oklab, var(--status-review) 14%, var(--surface))' },
  needs_admin_revision: { label: 'Needs review', color: 'var(--status-review)', background: 'color-mix(in oklab, var(--status-review) 14%, var(--surface))' },
  scheduled:            { label: 'Approved',     color: 'var(--good)',          background: 'color-mix(in oklab, var(--good) 14%, var(--surface))' },
  posted:               { label: 'Approved',     color: 'var(--good)',          background: 'color-mix(in oklab, var(--good) 14%, var(--surface))' },
};

// =====================================================================
// Display chips
// =====================================================================

export const PlatformChip = ({ platform, size = 'sm' }) => {
  const p = PLATFORM_BY_KEY[platform];
  if (!p) return null;
  const dim = size === 'lg' ? 24 : size === 'md' ? 20 : 16;
  return (
    <span
      title={p.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: dim,
        height: dim,
        borderRadius: 4,
        background: p.background,
        color: p.color,
        fontSize: dim <= 16 ? 9 : dim <= 20 ? 10 : 11,
        fontWeight: 700,
        letterSpacing: '-0.01em',
        flexShrink: 0,
      }}
    >
      {p.short}
    </span>
  );
};

export const StatusPill = ({ status, size = 'sm' }) => {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.drafting;
  const fontSize = size === 'lg' ? 12 : 11;
  const padding = size === 'lg' ? '4px 10px' : '2px 8px';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding,
        borderRadius: 99,
        background: cfg.background,
        color: cfg.color,
        fontSize,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: cfg.color,
        }}
      />
      {cfg.label}
    </span>
  );
};

// =====================================================================
// Datetime helpers
// =====================================================================

// Format a JS Date (or ISO string) as `YYYY-MM-DDTHH:MM` for the
// <input type=datetime-local> control. Local time, not UTC, so the
// input shows the user the time they actually picked.
export function toDatetimeLocal(d) {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDatetimeLocal(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
