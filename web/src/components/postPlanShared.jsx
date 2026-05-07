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
// `posted` is NOT a real status enum value (migration 0035 removed it).
// It's a derived display state — see `getDisplayStatus` below — that
// fires when a plan is approved AND has at least one publications row.
// We keep its STATUS_CONFIG entry so the same <StatusPill> machinery
// can render it without a special case.
//
// Legacy keys (`not_started`, `wip`, `needs_brand_feedback`, etc.) are
// kept here as fallback aliases so any cached client / server cron that
// fires a row through realtime with an old value still renders with a
// sane label and colour. Once we're confident no surface still emits
// the old values we can prune the aliases.
//
// Posted colour: a violet that reads as "shipped, complete" — distinct
// from approved-green so a calendar full of approved-but-not-yet-posted
// plans visually separates from the actually-live ones.
//
// Needs-review colour: a mustard yellow. Was previously --status-review
// (blue #6579BE) but that clashed with POSTED_TINT (violet #7C5CFF) in
// the blue/purple family — leads were confusing the two on a dense
// calendar. Yellow makes the "this needs your eyes" signal distinct
// from "this is live, leave it alone".
const POSTED_TINT       = '#7C5CFF';
const NEEDS_REVIEW_TINT = '#A16207';
export const STATUS_CONFIG = {
  drafting:     { label: 'Drafting',     color: 'var(--ink-4)',     background: 'var(--surface-2)' },
  needs_review: { label: 'Needs review', color: NEEDS_REVIEW_TINT,  background: `color-mix(in oklab, ${NEEDS_REVIEW_TINT} 18%, var(--surface))` },
  approved:     { label: 'Approved',     color: 'var(--good)',      background: 'color-mix(in oklab, var(--good) 14%, var(--surface))' },
  posted:       { label: 'Posted',       color: POSTED_TINT,        background: `color-mix(in oklab, ${POSTED_TINT} 16%, var(--surface))` },

  // Legacy aliases — render any cached row that slips through with a
  // sensible bucket equivalent rather than the unknown-status fallback.
  not_started:          { label: 'Drafting',     color: 'var(--ink-4)',     background: 'var(--surface-2)' },
  wip:                  { label: 'Drafting',     color: 'var(--ink-4)',     background: 'var(--surface-2)' },
  delayed:              { label: 'Drafting',     color: 'var(--ink-4)',     background: 'var(--surface-2)' },
  needs_brand_feedback: { label: 'Needs review', color: NEEDS_REVIEW_TINT,  background: `color-mix(in oklab, ${NEEDS_REVIEW_TINT} 18%, var(--surface))` },
  needs_admin_revision: { label: 'Needs review', color: NEEDS_REVIEW_TINT,  background: `color-mix(in oklab, ${NEEDS_REVIEW_TINT} 18%, var(--surface))` },
  scheduled:            { label: 'Approved',     color: 'var(--good)',      background: 'color-mix(in oklab, var(--good) 14%, var(--surface))' },
};

// Derive the display status for a plan, given any publications it has.
// "Posted" is a derived terminal state, not a stored enum value —
// approved + has ≥1 publication row = display as Posted. Every surface
// rendering a status pill should call this instead of reading
// `plan.status` directly so the calendar / detail view / repo all agree.
export function getDisplayStatus(plan, publications) {
  if (!plan) return 'drafting';
  const isApproved = plan.status === 'approved'
    || plan.status === 'scheduled'   // legacy
    || plan.status === 'posted';     // legacy
  const hasPub = Array.isArray(publications) && publications.length > 0;
  if (isApproved && hasPub) return 'posted';
  return plan.status || 'drafting';
}

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
