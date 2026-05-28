/* eslint-disable */
/* CalendarView — Social Calendar landing page.
   Each day cell shows the post plans scheduled for that day; admins click
   an empty cell to plan a new post (creates a stub and routes to its
   detail page); anyone can click a chip to open the detail page. The
   chip surface shows platform icon(s) + concept one-liner + a colored
   status dot. The per-plan editor lives in <PostPlanDetailView/>. */
import React, { useMemo, useState, useEffect } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import { PlatformChip, STATUS_CONFIG, StatusPill, getDisplayStatus } from './postPlanShared.jsx';
import { SafeImage } from './SafeImage.jsx';
import { VideoThumb } from './VideoThumb.jsx';
import {
  createPostPlan,
  createProposal,
  duplicatePostPlan,
  loadAllPendingProposals,
  loadPostPlanListRollups,
  loadPublicationsForPlanIds,
  subscribeToAllPostPlanPublications,
  updatePostPlan,
} from '../lib/db.js';
import { supabase } from '../lib/supabase';
import { useCoarsePointer } from '../lib/useCoarsePointer.ts';

// =====================================================================
// Drag-to-reschedule helper. Given the plan's existing scheduled_at and
// a YYYY-MM-DD target (local time), returns a new ISO timestamp on the
// target date with the same hour/minute/second preserved. Brand-new
// plans without a scheduled_at default to 9am on the target day, mirror
// of the stub-create behaviour.
// =====================================================================
function rescheduleToDate(scheduledAtIso, targetIso) {
  const [y, m, d] = targetIso.split('-').map(Number);
  if (!scheduledAtIso) {
    return new Date(y, m - 1, d, 9, 0, 0, 0).toISOString();
  }
  const orig = new Date(scheduledAtIso);
  if (isNaN(orig.getTime())) {
    return new Date(y, m - 1, d, 9, 0, 0, 0).toISOString();
  }
  return new Date(
    y, m - 1, d,
    orig.getHours(), orig.getMinutes(), orig.getSeconds(), orig.getMilliseconds(),
  ).toISOString();
}

// MIME-ish marker stored on dataTransfer so foreign drag sources (image
// drags from elsewhere on the page, OS file drags, etc.) don't trip the
// drop handler. We read it back in onDragOver to decide whether to allow
// the drop at all.
const DRAG_MIME = 'application/x-lr-plan-id';
import { DuplicateDatePicker } from './DuplicateDatePicker.jsx';
import { UpdateBrandModal } from './UpdateBrandModal.jsx';

const HEADING_FMT   = { month: 'short', year: 'numeric' };
const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS_PER_CELL = 3;

// Time-of-day greeting tail — restored from the sunset HomeView.
// One short phrase per slot, kept in the same "lowercase, no terminal
// punctuation" voice as the original. The 17–20 line was retuned for
// the calendar (the original "let's wrap up something nice" was
// brief-composer flavour; calendar is a planning surface so the tail
// shifts to passive-observation).
const GREETINGS = {
  morning:   "it's a fresh morning at Linkrunner",                 // 5 → 11
  afternoon: "the afternoon's looking good at Linkrunner",         // 12 → 16
  evening:   "evening at Linkrunner — checking what's shipped",    // 17 → 20
  night:     "burning the late-night oil at Linkrunner",           // 21 → 4
};
function greetingTail(now = new Date()) {
  const h = now.getHours();
  if (h >= 5  && h <= 11) return GREETINGS.morning;
  if (h >= 12 && h <= 16) return GREETINGS.afternoon;
  if (h >= 17 && h <= 20) return GREETINGS.evening;
  return GREETINGS.night;
}

// Status order — earlier statuses sort first within a day so the brand
// sees "things needing my attention" near the top of a busy cell.
// Posted (derived) sinks below Approved since it's "done, doesn't need
// my eyes". Legacy enum values are mapped to their new-enum equivalent.
const STATUS_ORDER = {
  proposed:             0,
  needs_review:         0,
  needs_brand_feedback: 0,
  needs_admin_revision: 0,
  brand_draft:          1,
  drafting:             1,
  not_started:          1,
  wip:                  1,
  delayed:              1,
  approved:             2,
  scheduled:            2,
  posted:               3,
};

// Filter buckets — the three workflow stages plus an All sentinel and
// the derived Posted state. Each bucket's `displayStatuses` array maps
// to display-status values returned by `getDisplayStatus(post, pubs)`.
// The Posted bucket fires when a plan is approved AND has at least one
// publication row; the Approved bucket excludes those, so "Approved"
// becomes the actionable "approved-but-not-yet-live" pile the agency
// can chase.
//
// Role-aware visibility (added 2026-05-22 alongside migration 0058):
// brand_draft is brand-only, drafting is agency-only. The two are
// distinct internal statuses gated by RLS but share the same display
// label "Drafting" — see STATUS_CONFIG in postPlanShared.jsx. Each
// role's filter row surfaces just ONE "Drafting" pill that maps to
// the status they're actually allowed to see; the other status's pill
// is omitted so there's no confusing always-zero badge in the rail.
const STATUS_GROUPS_ALL = {
  all:          { label: 'All',          displayStatuses: null },
  brand_draft:  { label: 'Drafting',     displayStatuses: ['brand_draft'] },                                                       // brand-only
  proposed:     { label: 'Proposed',     displayStatuses: ['proposed'] },
  drafting:     { label: 'Drafting',     displayStatuses: ['drafting', 'not_started', 'wip', 'delayed'] },                          // agency-only
  needs_review: { label: 'Needs review', displayStatuses: ['needs_review', 'needs_brand_feedback', 'needs_admin_revision'] },
  approved:     { label: 'Approved',     displayStatuses: ['approved', 'scheduled'] },
  posted:       { label: 'Posted',       displayStatuses: ['posted'] },
};

// Subset based on viewer role. Agency drops the brand-only bucket;
// brand drops the agency-only bucket. Order is preserved either way
// so the surviving pills don't shuffle around relative to each other.
function getStatusGroupsForRole(isAdmin) {
  const out = {};
  for (const [key, group] of Object.entries(STATUS_GROUPS_ALL)) {
    if (isAdmin && key === 'brand_draft') continue;
    if (!isAdmin && key === 'drafting') continue;
    out[key] = group;
  }
  return out;
}

const LS_VIEW_MODE     = 'lr_calendar_view_mode';
const LS_STATUS_FILTER = 'lr_calendar_status_filter';

function readLS(key, fallback, allowed) {
  try {
    const v = localStorage.getItem(key);
    if (v && (!allowed || allowed.includes(v))) return v;
  } catch {}
  return fallback;
}
function writeLS(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function startOfWeek(d) {
  // Week starts Sunday — matches WEEKDAY_LABEL ordering.
  const out = new Date(d);
  out.setDate(out.getDate() - out.getDay());
  out.setHours(0, 0, 0, 0);
  return out;
}

function formatWeekRange(start) {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear  = start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${start.toLocaleDateString('en-US', { month: 'long' })} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
  }
  if (sameYear) {
    const a = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const b = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${a} – ${b}, ${end.getFullYear()}`;
  }
  const a = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const b = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${a} – ${b}`;
}

function isoLocalDate(d) {
  // YYYY-MM-DD in local time. We bucket post plans by local-day so the chip
  // appears in the cell the user picked, not the UTC-shifted neighbor.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

// =====================================================================
// ProposeNewDateModal — shown when a brand drags a needs_review/approved
// plan to a new day. Captures an optional note + sends a date_change
// proposal to the agency. Time-of-day is preserved (drag = date-only).
// =====================================================================
function formatProposalDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

const ProposeNewDateModal = ({ plan, fromIso, toIso, accountId, userId, onCancel, onSent }) => {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !sending) onCancel?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [sending, onCancel]);

  const send = async () => {
    if (sending || !plan?.id || !accountId || !userId) return;
    setSending(true);
    setError(null);
    try {
      await createProposal({
        planId: plan.id,
        accountId,
        kind: 'date_change',
        payload: { scheduled_at: toIso },
        note: note.trim() || null,
        userId,
      });
      onSent?.();
    } catch (err) {
      console.error('[Calendar] createProposal failed', err);
      setError(err?.message || 'Could not send proposal.');
      setSending(false);
    }
  };

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) onCancel?.(); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 460 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 14 }}>
          <h2 className="login-modal-title" style={{ fontSize: 22 }}>Propose a new date</h2>
          <p className="login-modal-sub" style={{ marginTop: 6 }}>
            Your agency will review and accept or reject the move. Time of day stays the same.
          </p>
        </div>
        <div className="login-modal-body" style={{ paddingTop: 4, paddingBottom: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
            <div style={{ color: 'var(--ink-3)' }}>{formatProposalDate(fromIso)}</div>
            <div style={{ color: 'var(--ink-4)' }}>→</div>
            <div style={{ color: 'var(--ink-1)', fontWeight: 500 }}>{formatProposalDate(toIso)}</div>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (why?) — helps the agency review faster."
            rows={3}
            disabled={sending}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: 'var(--surface)',
              color: 'var(--ink-1)',
              fontSize: 13,
              outline: 'none',
              resize: 'vertical',
              minHeight: 70,
              fontFamily: 'inherit',
              lineHeight: 1.5,
            }}
          />
          {error && (
            <div style={{ color: '#b91c1c', fontSize: 12 }}>{error}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => onCancel?.()}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={sending} onClick={send}>
              {sending ? 'Sending…' : 'Send proposal'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const PostChip = ({ post, onOpen, onContextMenu, unreadCount = 0, hasPendingProposal = false, draggable = false, isDragging = false, onDragStart, onDragEnd }) => {
  const displayStatus = post.displayStatus || post.status;
  const cfg = STATUS_CONFIG[displayStatus] || STATUS_CONFIG.drafting;
  const time = formatTime(post.scheduledAt);
  // One dot for ANY new activity (unread messages OR pending brand
  // proposal) — they collapse so a card with both pending things doesn't
  // sprout two adjacent dots. Title combines the breakdown for hover.
  const hasNewActivity = hasPendingProposal || unreadCount > 0;
  const titlePieces = [];
  if (unreadCount > 0) titlePieces.push(`${unreadCount} unread update${unreadCount === 1 ? '' : 's'}`);
  if (hasPendingProposal) titlePieces.push('brand proposal pending');
  const activitySuffix = titlePieces.length > 0 ? ' · ' + titlePieces.join(' · ') : '';
  const hoverTitle = `${post.concept || 'Untitled post'} · ${cfg.label}${time ? ' · ' + time : ''}${activitySuffix}`;

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(post); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, post);
      }}
      title={hoverTitle}
      draggable={draggable}
      onDragStart={draggable ? (e) => onDragStart?.(e, post) : undefined}
      onDragEnd={draggable ? () => onDragEnd?.() : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        padding: '4px 7px',
        marginBottom: 3,
        borderRadius: 5,
        border: 0,
        // Subtle tint per status so the chip itself reads its state at a
        // glance — replaces the small leading dot we used to draw.
        background: cfg.background,
        color: 'var(--ink-1)',
        fontSize: 11.5,
        lineHeight: 1.25,
        cursor: draggable ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        minWidth: 0,
        opacity: isDragging ? 0.4 : 1,
        transition: 'opacity 120ms ease',
      }}
    >
      {post.platforms?.slice(0, 3).map((p) => (
        <PlatformChip key={p} platform={p} size="sm" />
      ))}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {post.concept || 'Untitled post'}
      </span>
      {hasNewActivity && (
        <span
          aria-label={titlePieces.join(', ') || 'New activity'}
          style={{
            width: 8,
            height: 8,
            borderRadius: 99,
            background: 'var(--accent)',
            flexShrink: 0,
            boxShadow: '0 0 0 2px var(--surface)',
          }}
        />
      )}
    </button>
  );
};

// Larger card used in week view — multi-line title, status pill, time,
// platform icons. Trello-stack rather than a calendar time grid: dates
// matter more than times for content planning, and a stacked column
// gives each plan enough room to be scannable without opening it.
const WeekPostCard = ({ post, onOpen, onContextMenu, unreadCount = 0, draggable = false, isDragging = false, onDragStart, onDragEnd }) => {
  const displayStatus = post.displayStatus || post.status;
  const cfg = STATUS_CONFIG[displayStatus] || STATUS_CONFIG.drafting;
  const time = formatTime(post.scheduledAt);
  return (
    <button
      type="button"
      className="cal-week-card"
      onClick={(e) => { e.stopPropagation(); onOpen(post); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, post);
      }}
      draggable={draggable}
      onDragStart={draggable ? (e) => onDragStart?.(e, post) : undefined}
      onDragEnd={draggable ? () => onDragEnd?.() : undefined}
      style={{
        background: cfg.background,
        borderLeft: `3px solid ${cfg.color}`,
        cursor: draggable ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        opacity: isDragging ? 0.4 : 1,
        transition: 'opacity 120ms ease',
      }}
    >
      <div className="cal-week-card-row">
        {time && <span className="cal-week-card-time">{time}</span>}
        <div className="cal-week-card-platforms">
          {post.platforms?.slice(0, 3).map((p) => (
            <PlatformChip key={p} platform={p} size="sm" />
          ))}
        </div>
        {unreadCount > 0 && (
          <span
            aria-label={`${unreadCount} unread`}
            className="cal-week-card-unread"
          />
        )}
      </div>
      <div className="cal-week-card-title">
        {post.concept || 'Untitled post'}
      </div>
      <div className="cal-week-card-foot">
        <StatusPill status={displayStatus} size="sm" />
      </div>
    </button>
  );
};

const MonthGrid = ({ viewDate, postsByDate, onOpenPost, onOpenDay, isAdmin, unreadByPlan, unackedPlanIds, onChipContextMenu, dragState, onChipDragStart, onChipDragEnd, onCellDragOver, onCellDragLeave, onCellDrop }) => {
  const cells = useMemo(
    () => buildMonthMatrix(viewDate.getFullYear(), viewDate.getMonth()),
    [viewDate]
  );
  const maxChips = MAX_CHIPS_PER_CELL;

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
          const posts = postsByDate.get(c.iso) || [];
          const visible = posts.slice(0, maxChips);
          const overflow = posts.length - visible.length;
          // Both agency and brand can plan a new post via the small `+`
          // button in the cell header — brand's plan lands in 'proposed'
          // status pending agency review (handled in createStubAndOpen).
          // The whole-cell click target was removed (2026-05-07) because
          // users were creating accidental plans from stray clicks below
          // the day number. Now only the explicit `+` button creates.
          const canCreate = c.inMonth;
          // Drop target highlight — only when there's an active drag AND
          // the hover iso matches this cell. The source cell (where the
          // chip currently lives) is intentionally NOT highlighted, since
          // dropping there is a no-op.
          const isDropTarget =
            !!dragState?.planId && dragState?.overIso === c.iso && dragState?.sourceIso !== c.iso;
          return (
            <div
              key={c.iso + '_' + i}
              onDragOver={(e) => onCellDragOver?.(e, c.iso)}
              onDragLeave={(e) => onCellDragLeave?.(e, c.iso)}
              onDrop={(e) => onCellDrop?.(e, c.iso)}
              style={{
                padding: 6,
                borderRight: (i % 7 === 6) ? 'none' : '1px solid var(--line-2)',
                borderBottom: i < 35 ? '1px solid var(--line-2)' : 'none',
                background: isDropTarget
                  ? 'color-mix(in oklab, var(--accent) 16%, var(--surface))'
                  : c.isToday
                  ? 'color-mix(in oklab, var(--accent) 8%, var(--surface))'
                  : c.inMonth ? 'var(--surface)' : 'var(--surface-2)',
                outline: isDropTarget ? '2px dashed var(--accent)' : 'none',
                outlineOffset: isDropTarget ? -2 : 0,
                opacity: c.inMonth ? 1 : 0.55,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                transition: 'background 120ms ease, outline-color 120ms ease',
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
                {canCreate && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(c);
                    }}
                    title={isAdmin ? 'Plan a new post on this day' : 'Propose a new post on this day'}
                    aria-label={`${isAdmin ? 'Plan' : 'Propose'} a new post on ${c.iso}`}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: '0 4px',
                      fontSize: 14,
                      lineHeight: 1,
                      color: 'var(--ink-4)',
                      cursor: 'pointer',
                      borderRadius: 4,
                      opacity: 0.6,
                      transition: 'opacity 120ms, color 120ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.opacity = '1';
                      e.currentTarget.style.color = 'var(--ink)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.opacity = '0.6';
                      e.currentTarget.style.color = 'var(--ink-4)';
                    }}
                  >
                    +
                  </button>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {visible.map((p) => (
                  <PostChip
                    key={p.id}
                    post={p}
                    onOpen={onOpenPost}
                    onContextMenu={onChipContextMenu}
                    unreadCount={unreadByPlan?.get(p.id) || 0}
                    hasPendingProposal={unackedPlanIds?.has(p.id) || false}
                    draggable={p.canDrag}
                    isDragging={dragState?.planId === p.id}
                    onDragStart={onChipDragStart}
                    onDragEnd={onChipDragEnd}
                  />
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Open the first overflow plan as a starting point;
                      // the user can click "next" inside the modal later
                      // (we'll add that in a follow-up slice).
                      onOpenPost(posts[maxChips]);
                    }}
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

const WeekGrid = ({ weekStart, postsByDate, onOpenPost, onOpenDay, isAdmin, unreadByPlan, unackedPlanIds, onChipContextMenu, dragState, onChipDragStart, onChipDragEnd, onCellDragOver, onCellDragLeave, onCellDrop }) => {
  const days = useMemo(() => {
    const todayIso = isoLocalDate(new Date());
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      out.push({
        date: d,
        iso: isoLocalDate(d),
        day: d.getDate(),
        weekday: WEEKDAY_LABEL[i],
        monthLabel: d.toLocaleDateString('en-US', { month: 'short' }),
        isToday: isoLocalDate(d) === todayIso,
      });
    }
    return out;
  }, [weekStart]);

  return (
    <div className="cal-week-grid">
      {days.map((d) => {
        const posts = postsByDate.get(d.iso) || [];
        // Brand can also click a day header to propose a new plan on
        // that date. createStubAndOpen branches on isAdmin to set the
        // right initial status (drafting vs proposed).
        const cellClickable = true;
        const isDropTarget =
          !!dragState?.planId && dragState?.overIso === d.iso && dragState?.sourceIso !== d.iso;
        return (
          <div
            key={d.iso}
            className={
              'cal-week-col'
              + (d.isToday ? ' is-today' : '')
              + (isDropTarget ? ' is-drop-target' : '')
            }
            onDragOver={(e) => onCellDragOver?.(e, d.iso)}
            onDragLeave={(e) => onCellDragLeave?.(e, d.iso)}
            onDrop={(e) => onCellDrop?.(e, d.iso)}
          >
            <div
              className="cal-week-col-head"
              role={cellClickable ? 'button' : undefined}
              tabIndex={cellClickable ? 0 : undefined}
              onClick={cellClickable ? () => onOpenDay({ date: d.date }) : undefined}
              onKeyDown={(e) => {
                if (cellClickable && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onOpenDay({ date: d.date });
                }
              }}
              title={cellClickable ? (isAdmin ? 'Click to plan a new post on this day' : 'Click to propose a new post on this day') : undefined}
            >
              <div className="cal-week-col-weekday">{d.weekday}</div>
              <div className="cal-week-col-day">
                {d.day}
                <span className="cal-week-col-month">{d.monthLabel}</span>
                {d.isToday && <span className="cal-week-col-today">Today</span>}
              </div>
              {cellClickable && (
                <span aria-hidden className="cal-week-col-add">+</span>
              )}
            </div>
            <div className="cal-week-col-body">
              {posts.length === 0 ? (
                <div className="cal-week-col-empty">No posts</div>
              ) : (
                posts.map((p) => (
                  <WeekPostCard
                    key={p.id}
                    post={p}
                    onOpen={onOpenPost}
                    onContextMenu={onChipContextMenu}
                    unreadCount={unreadByPlan?.get(p.id) || 0}
                    draggable={p.canDrag}
                    isDragging={dragState?.planId === p.id}
                    onDragStart={onChipDragStart}
                    onDragEnd={onChipDragEnd}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// =====================================================================
// ListView — full-width agenda. Posts grouped by day with sticky day
// headers + week separators. Each row is the whole post: time, full
// platform icons, full title, status pill, comments count, references
// count (with hover-thumbnail popover), lead avatar, unread dot. Empty
// days are skipped entirely. Month-scoped — prev/next still moves by
// month, matching the Month/Week toggle's mental model.
// =====================================================================

const StatPill = ({ icon, count, accent }) => {
  if (!count) return null;
  return (
    <span
      className={'cal-list-row-stat' + (accent ? ' is-accent' : '')}
      aria-label={`${count} ${icon === 'comment' ? 'comments' : 'attachments'}`}
    >
      <Icon name={icon} size={11} />
      <span>{count}</span>
    </span>
  );
};

const AttachmentPopover = ({ items }) => {
  if (!items || items.length === 0) return null;
  return (
    <div className="cal-list-ref-popover" role="tooltip">
      {items.map((a) => {
        const isImage = (a.mimeType || '').startsWith('image/') && a.url;
        const isVideo = (a.mimeType || '').startsWith('video/');
        const isFinal = a.kind === 'final';
        return (
          <div
            key={a.id}
            className={'cal-list-ref-thumb' + (isFinal ? ' is-final' : '')}
            title={isFinal ? `${a.filename} (deliverable)` : a.filename}
          >
            {isImage ? (
              <SafeImage src={a.url} alt={a.filename} filename={a.filename} caption="Preview unavailable" loading="lazy" />
            ) : isVideo ? (
              <VideoThumb thumbnailUrl={a.thumbnailUrl} alt={a.filename} badgeSize={18} />
            ) : (
              <div className="cal-list-ref-thumb-fallback">
                <Icon name="paperclip" size={14} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const ListRow = ({ post, onOpen, onContextMenu, unreadCount, commentsCount, attachments }) => {
  const displayStatus = post.displayStatus || post.status;
  const cfg = STATUS_CONFIG[displayStatus] || STATUS_CONFIG.drafting;
  const time = formatTime(post.scheduledAt) || '—';
  const attachmentsCount = attachments?.length || 0;
  return (
    <div
      role="button"
      tabIndex={0}
      className={'cal-list-row' + (unreadCount > 0 ? ' has-unread' : '')}
      onClick={() => onOpen(post)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, post);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(post);
        }
      }}
      style={{ borderLeft: `3px solid ${cfg.color}` }}
    >
      <div className="cal-list-row-time">{time}</div>

      <div className="cal-list-row-platforms">
        {(post.platforms || []).slice(0, 3).map((p) => (
          <PlatformChip key={p} platform={p} size="sm" />
        ))}
      </div>

      <div className="cal-list-row-title">
        {post.concept || <span className="cal-list-row-untitled">Untitled post</span>}
      </div>

      <div className="cal-list-row-status">
        <StatusPill status={displayStatus} size="sm" />
      </div>

      <div className="cal-list-row-stats">
        <StatPill icon="comment" count={commentsCount} accent={unreadCount > 0} />
        {attachmentsCount > 0 && (
          <span className="cal-list-row-stat has-popover" aria-label={`${attachmentsCount} attachments`}>
            <Icon name="paperclip" size={11} />
            <span>{attachmentsCount}</span>
            <AttachmentPopover items={attachments} />
          </span>
        )}
      </div>

      <div className="cal-list-row-lead">
        {post.creator && <Avatar person={post.creator} size="sm" />}
      </div>

      {unreadCount > 0 && (
        <span
          aria-label={`${unreadCount} unread`}
          className="cal-list-row-unread"
        />
      )}
    </div>
  );
};

const ListView = ({ viewDate, postPlans, weekScoped, onOpenPost, onChipContextMenu, unreadByPlan, unackedPlanIds, isAdmin, onOpenDay }) => {
  // Two modes:
  // - Month-scoped (desktop default): anchor on viewDate's month/year,
  //   show every day in that calendar month.
  // - Week-scoped (mobile agenda): anchor on the week containing viewDate
  //   (Sun-start), show that one week only. Prev/Next step by week so the
  //   user pages through a focused 7-day chunk at a time.
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const weekBounds = useMemo(() => {
    if (!weekScoped) return null;
    const start = startOfWeek(viewDate);
    const end = new Date(start);
    end.setDate(start.getDate() + 7); // exclusive
    return { start, end };
  }, [weekScoped, viewDate]);

  const monthPosts = useMemo(() => {
    return (postPlans || [])
      .filter((p) => {
        if (!p.scheduledAt) return false;
        const d = new Date(p.scheduledAt);
        if (weekBounds) {
          return d >= weekBounds.start && d < weekBounds.end;
        }
        return d.getFullYear() === year && d.getMonth() === month;
      })
      .sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));
  }, [postPlans, year, month, weekBounds]);

  // Bulk-fetch comments + attachments (references + deliverables) for
  // every visible plan in one shot. Re-runs whenever the visible-plan
  // set changes (new month picked, status filter narrows, etc.). Also
  // includes plan.updatedAt in the dep key so a fresh comment elsewhere
  // triggers a refetch.
  const [rollups, setRollups] = useState({ commentsByPlan: new Map(), attachmentsByPlan: new Map() });
  const ids = monthPosts.map((p) => p.id);
  const idsKey = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    if (ids.length === 0) {
      setRollups({ commentsByPlan: new Map(), attachmentsByPlan: new Map() });
      return undefined;
    }
    loadPostPlanListRollups({ postPlanIds: ids })
      .then((r) => { if (!cancelled) setRollups(r); })
      .catch((e) => console.warn('list rollups failed', e));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // Group by day-iso. Skip empty days entirely (one of the design points
  // — list view is for "what's actually scheduled", not "what days exist").
  const days = useMemo(() => {
    const map = new Map();
    for (const p of monthPosts) {
      const iso = isoLocalDate(new Date(p.scheduledAt));
      const list = map.get(iso) || [];
      list.push(p);
      map.set(iso, list);
    }
    return Array.from(map.entries()).map(([iso, posts]) => {
      const date = new Date(posts[0].scheduledAt);
      return { iso, date, posts };
    });
  }, [monthPosts]);

  const todayIso = isoLocalDate(new Date());

  // Bucket days into week groups (Sun-anchored) so we can render the
  // "Week of May 3 · 12 posts · 3 needing review" separator headers.
  const weeks = useMemo(() => {
    const out = [];
    let current = null;
    for (const day of days) {
      const ws = startOfWeek(day.date);
      const wsIso = isoLocalDate(ws);
      if (!current || current.weekStartIso !== wsIso) {
        current = { weekStartIso: wsIso, weekStart: ws, days: [] };
        out.push(current);
      }
      current.days.push(day);
    }
    return out;
  }, [days]);

  // For the "Now" line: only on today's day group, only if today has
  // posts. Position = first index whose scheduledAt > now.
  const nowMs = Date.now();
  const nowIndexByDay = useMemo(() => {
    const m = new Map();
    for (const d of days) {
      if (d.iso !== todayIso) continue;
      const idx = d.posts.findIndex((p) => new Date(p.scheduledAt).getTime() > nowMs);
      m.set(d.iso, idx === -1 ? d.posts.length : idx);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, todayIso]);

  if (days.length === 0) {
    const emptyLabel = weekBounds
      ? `No posts the week of ${weekBounds.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`
      : `No posts in ${viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.`;
    const browseHint = weekBounds ? 'week' : 'month';
    return (
      <div className="cal-list-empty">
        <div className="big">{emptyLabel}</div>
        <div className="sub">
          {isAdmin
            ? `Use Today or the prev/next arrows to browse another ${browseHint}, or click below to plan one now.`
            : `Nothing here yet. Use the prev/next arrows to browse another ${browseHint}, or click below to propose a post for your agency to review.`}
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ marginTop: 14 }}
          onClick={() => onOpenDay({ date: new Date() })}
        >
          <Icon name="plus" size={13}/> {isAdmin ? 'Plan a post now' : 'Propose a post now'}
        </button>
      </div>
    );
  }

  return (
    <div className="cal-list">
      {weeks.map((week) => {
        const weekPosts = week.days.flatMap((d) => d.posts);
        const reviewCount = weekPosts.filter((p) =>
          p.status === 'needs_review' ||
          p.status === 'needs_brand_feedback' ||
          p.status === 'needs_admin_revision'
        ).length;
        return (
          <section key={week.weekStartIso} className="cal-list-week">
            <header className="cal-list-week-head">
              <span className="cal-list-week-label">
                Week of {week.weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <span className="cal-list-week-meta">
                {weekPosts.length} post{weekPosts.length === 1 ? '' : 's'}
                {reviewCount > 0 && <> · <strong>{reviewCount}</strong> needing review</>}
              </span>
            </header>

            {week.days.map((day) => {
              const isToday = day.iso === todayIso;
              const nowIdx = nowIndexByDay.get(day.iso);
              const dayHeader = isToday
                ? `Today · ${day.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`
                : day.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
              return (
                <div key={day.iso} className={'cal-list-day' + (isToday ? ' is-today' : '')}>
                  <header className="cal-list-day-head">
                    <span className="cal-list-day-label">{dayHeader}</span>
                    <span className="cal-list-day-count">{day.posts.length}</span>
                  </header>
                  <div className="cal-list-day-body">
                    {day.posts.map((post, i) => (
                      <React.Fragment key={post.id}>
                        {isToday && nowIdx === i && (
                          <div className="cal-list-now" aria-label="Now">
                            <span className="cal-list-now-label">Now</span>
                            <span className="cal-list-now-line" />
                          </div>
                        )}
                        <ListRow
                          post={post}
                          onOpen={onOpenPost}
                          onContextMenu={onChipContextMenu}
                          unreadCount={unreadByPlan?.get(post.id) || 0}
                          commentsCount={rollups.commentsByPlan.get(post.id) || 0}
                          attachments={rollups.attachmentsByPlan.get(post.id) || []}
                        />
                      </React.Fragment>
                    ))}
                    {/* Now line at the very end if all of today's posts have already passed */}
                    {isToday && nowIdx === day.posts.length && (
                      <div className="cal-list-now" aria-label="Now">
                        <span className="cal-list-now-label">Now</span>
                        <span className="cal-list-now-line" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
};

const CalendarView = ({
  postPlans = [],
  accountId,
  accountName,
  userId,
  mode,         // 'admin' | 'customer'
  setRoute,
  unreadByPlan,
  onPlanCreated,
  onPlanChanged,  // called with the updated plan after a drag-reschedule
  auth = null,  // optional — drives the time-of-day greeting tail above the title
}) => {
  const isAdmin = mode === 'admin';

  // Role-aware filter buckets (post-migration 0058). Memoized on
  // isAdmin since it's effectively a constant per session — but using
  // useMemo keeps the reference stable and avoids surprises if isAdmin
  // ever changes mid-mount (e.g. a debug tool toggling the role).
  const STATUS_GROUPS = useMemo(() => getStatusGroupsForRole(isAdmin), [isAdmin]);

  // View mode + status filter are persisted so an agency lead who lives
  // in list view doesn't have to set it back every reload. The legacy
  // density toggle was retired alongside the new List view — list view
  // is the proper "more rows than fits as chips" surface; the
  // density-toggle compact mode was a half-measure.
  //
  // Status-filter allow-list is the role-scoped keys — a brand who
  // previously had 'drafting' saved (or an agency with 'brand_draft'
  // saved) gracefully falls back to 'all' since the other role's
  // pill no longer exists in their group.
  const [storedViewMode, setStoredViewMode] = useState(() => readLS(LS_VIEW_MODE, 'month', ['month', 'week', 'list']));
  const [statusFilter, setStatusFilter] = useState(() => readLS(LS_STATUS_FILTER, 'all', Object.keys(STATUS_GROUPS)));

  // Force the day-grouped agenda list whenever the viewport is too
  // narrow OR the input device is touch — both signals point at "the
  // week grid will be horrible here". OR'ing them means Chrome
  // devtools mobile-emulation (narrow viewport, fine pointer) also
  // shows the agenda mode, matching what users actually see on their
  // phones. The agenda list is already day-grouped and purpose-built
  // for narrow viewports.
  // `setViewMode` still writes the user's preference to localStorage so
  // when they're back on desktop their week/month choice is preserved.
  const isCoarsePointer = useCoarsePointer();
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth <= 640
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsNarrow(mq.matches);
    update();
    if (mq.addEventListener) mq.addEventListener('change', update);
    else mq.addListener(update);
    // Belt-and-suspenders: some embedded preview environments don't fire
    // matchMedia change events on programmatic resize. The `resize`
    // event is universally supported. Both call setIsNarrow with the
    // same value when they agree, so double-firing is idempotent.
    window.addEventListener('resize', update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', update);
      else mq.removeListener(update);
      window.removeEventListener('resize', update);
    };
  }, []);
  const forceList = isCoarsePointer || isNarrow;
  const viewMode = forceList ? 'list' : storedViewMode;
  const setViewMode = setStoredViewMode;
  // When the agenda is force-rendered on mobile, treat it as week-scoped
  // (prev/next arrows step by week, heading shows "Week of …", ListView
  // filters to one week). Showing a whole month at once is too much to
  // scroll through on a phone — a focused week per swipe matches the
  // ergonomics of mobile email/calendar apps.
  const weekScoped = forceList;

  useEffect(() => { writeLS(LS_VIEW_MODE, storedViewMode); }, [storedViewMode]);
  useEffect(() => { writeLS(LS_STATUS_FILTER, statusFilter); }, [statusFilter]);

  const [viewDate, setViewDate] = useState(() => {
    // Anchor at "today" — matrix builders only inspect year/month (month
    // view) or compute startOfWeek (week view), so the day-of-month
    // doesn't need to be 1.
    return new Date();
  });
  const [creating, setCreating] = useState(false);
  // Drag-to-reschedule state. `planId` is the plan currently being
  // dragged (null when idle); `sourceIso` is the local-day cell it
  // started in (used to suppress the drop-target highlight on its own
  // cell, since same-day drops are no-ops); `overIso` is the cell the
  // pointer is currently hovering. Lives on the parent so MonthGrid and
  // WeekGrid both render against the same source of truth — switching
  // views mid-drag isn't a real flow we need to support, but keeping
  // state here means the visual feedback stays consistent.
  const [dragState, setDragState] = useState({ planId: null, sourceIso: null, overIso: null });

  const weekStart = useMemo(() => startOfWeek(viewDate), [viewDate]);

  // Context menu state for right-click on chips.
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, plan }
  // Duplicate date picker state (opened from context menu).
  const [dupSource, setDupSource] = useState(null); // plan or null
  // Send-update modal state (agency-only).
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  // Propose-new-date popover state — opened when brand drags a needs_review
  // or approved plan to a new day. `null` when closed.
  // { plan, fromIso, toIso } when open.
  const [proposeDateState, setProposeDateState] = useState(null);
  // Set of plan ids with at least one PENDING + UN-acknowledged proposal.
  // Drives the red unread dot on calendar chips for agency reviewers.
  // (Brand v1: no dot — they made the proposal, they know it's pending.)
  const [unackedPlanIds, setUnackedPlanIds] = useState(() => new Set());

  // Publications-by-plan-id, used to derive "Posted" display status. We
  // bulk-fetch on mount and whenever the visible plan-id set changes, and
  // listen for realtime publication events so a plan flipped to posted
  // from another tab updates the calendar without a manual refresh.
  const [pubsByPlanId, setPubsByPlanId] = useState(new Map());
  const planIdsKey = useMemo(() => postPlans.map((p) => p.id).sort().join(','), [postPlans]);
  useEffect(() => {
    let cancelled = false;
    const ids = postPlans.map((p) => p.id);
    if (ids.length === 0) {
      setPubsByPlanId(new Map());
      return undefined;
    }
    loadPublicationsForPlanIds(ids)
      .then((m) => { if (!cancelled) setPubsByPlanId(m); })
      .catch((e) => console.warn('loadPublicationsForPlanIds failed', e));
    return () => { cancelled = true; };
    // planIdsKey is the dependency-stable proxy for the ids array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planIdsKey]);

  // Pending-proposals "unread" tracking for the red-dot chip indicator.
  // Loaded once on mount and refreshed whenever the plan_proposals table
  // changes via realtime. Agency-only signal; brand v1 doesn't render
  // the dot (they made the proposal, they know it's pending).
  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    const refresh = () => {
      loadAllPendingProposals()
        .then((rows) => {
          if (cancelled) return;
          const ids = new Set();
          for (const r of rows) {
            if (!r.acknowledgedAt) ids.add(r.postPlanId);
          }
          setUnackedPlanIds(ids);
        })
        .catch((e) => console.warn('loadAllPendingProposals failed', e));
    };
    refresh();
    const channel = supabase
      .channel('plan_proposals_calendar_dots')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plan_proposals' }, refresh)
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [isAdmin]);

  useEffect(() => {
    const idSet = new Set(postPlans.map((p) => p.id));
    if (idSet.size === 0) return undefined;
    const unsub = subscribeToAllPostPlanPublications((evt) => {
      const planId = evt.publication?.postPlanId || evt.postPlanId;
      if (!planId || !idSet.has(planId)) return;
      setPubsByPlanId((prev) => {
        const next = new Map(prev);
        const list = next.get(planId) ? [...next.get(planId)] : [];
        if (evt.type === 'DELETE') {
          next.set(planId, list.filter((p) => p.id !== evt.id));
        } else if (evt.publication) {
          const idx = list.findIndex((p) => p.id === evt.publication.id);
          if (idx === -1) list.push(evt.publication);
          else list[idx] = evt.publication;
          next.set(planId, list);
        }
        return next;
      });
    });
    return () => unsub?.();
  }, [planIdsKey]);

  // Decorate every plan with its derived `displayStatus` once. Every
  // surface downstream (chip, week card, list row, sort, filter) reads
  // displayStatus instead of plan.status so "Posted" shows up uniformly
  // wherever a plan is rendered.
  const decoratedPostPlans = useMemo(() => {
    return postPlans.map((p) => {
      const displayStatus = getDisplayStatus(p, pubsByPlanId.get(p.id));
      // Drag rules:
      //   * posted plans: never draggable.
      //   * Agency: drag = free reschedule (existing behaviour).
      //   * Brand on own brand_draft: drag = free reschedule.
      //   * Brand on needs_review / approved: drag = propose new date.
      //   * Brand on own proposed plan: not draggable (already submitted,
      //     waiting on agency to accept / reject).
      //   * Brand on agency-owned drafting plan: shouldn't be visible,
      //     but defensively not draggable.
      let canDrag = false;
      let dragMode = null;  // 'free' | 'propose'
      if (displayStatus !== 'posted') {
        if (isAdmin) {
          canDrag = true;
          dragMode = 'free';
        } else if (p.status === 'brand_draft' && p.createdBy === userId) {
          canDrag = true;
          dragMode = 'free';
        } else if (p.status === 'needs_review' || p.status === 'approved') {
          canDrag = true;
          dragMode = 'propose';
        }
      }
      return { ...p, displayStatus, canDrag, dragMode };
    });
  }, [postPlans, pubsByPlanId, isAdmin, userId]);

  const filteredPostPlans = useMemo(() => {
    const allowed = STATUS_GROUPS[statusFilter]?.displayStatuses;
    if (!allowed) return decoratedPostPlans;
    return decoratedPostPlans.filter((p) => allowed.includes(p.displayStatus));
  }, [decoratedPostPlans, statusFilter]);

  // Counts per status group — drive the small badge inside each filter
  // pill so the agency lead can see at a glance "5 things in review,
  // 12 approved" without flipping filters.
  const groupCounts = useMemo(() => {
    const out = {};
    for (const [key, group] of Object.entries(STATUS_GROUPS)) {
      out[key] = group.displayStatuses
        ? decoratedPostPlans.filter((p) => group.displayStatuses.includes(p.displayStatus)).length
        : decoratedPostPlans.length;
    }
    return out;
  }, [decoratedPostPlans]);

  const postsByDate = useMemo(() => {
    const map = new Map();
    for (const p of filteredPostPlans) {
      if (!p.scheduledAt) continue;
      const iso = isoLocalDate(new Date(p.scheduledAt));
      const list = map.get(iso) || [];
      list.push(p);
      map.set(iso, list);
    }
    for (const [, list] of map) {
      list.sort((a, b) => {
        const sd = (STATUS_ORDER[a.displayStatus] ?? 99) - (STATUS_ORDER[b.displayStatus] ?? 99);
        if (sd !== 0) return sd;
        return (a.scheduledAt || '').localeCompare(b.scheduledAt || '');
      });
    }
    return map;
  }, [filteredPostPlans]);

  const goPrev = () => {
    if (viewMode === 'week' || weekScoped) {
      const d = new Date(viewDate);
      d.setDate(d.getDate() - 7);
      setViewDate(d);
    } else {
      setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
    }
  };
  const goNext = () => {
    if (viewMode === 'week' || weekScoped) {
      const d = new Date(viewDate);
      d.setDate(d.getDate() + 7);
      setViewDate(d);
    } else {
      setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
    }
  };
  const goToday  = () => setViewDate(new Date());

  // Create a stub plan for the given day at 9am, then route to its detail
  // page so the user fills in concept/copy/etc inline. Stubs are real
  // rows — if the user walks away, an empty card sits on the calendar
  // until they delete it. Cleanest UX vs. keeping a parallel "draft" path.
  //
  // Brand-side stubs land in status='brand_draft' — a private editing
  // state the brand can fill in without notifying agency. A separate
  // "Propose plan" button on PostPlanDetailView flips brand_draft →
  // 'proposed'; the status-change trigger from migration 0050 emits the
  // "proposed a new post plan." message at submission time, not now.
  // Agency-side still lands in 'drafting' as before.
  const createStubAndOpen = async (jsDate) => {
    if (!accountId) { console.warn('[Calendar] create blocked: no active brand selected'); return; }
    if (creating) return;
    setCreating(true);
    try {
      const at = new Date(
        jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate(),
        9, 0, 0, 0
      ).toISOString();
      const created = await createPostPlan({
        accountId,
        userId,
        scheduledAt: at,
        platforms: [],
        concept: '',
        copyVariants: {},
        status: isAdmin ? 'drafting' : 'brand_draft',
      });
      // Push into App-level state immediately so the chip appears on the
      // calendar without waiting for the realtime round-trip.
      onPlanCreated?.(created);
      setRoute?.({ view: 'plan', id: created.id });
    } catch (e) {
      console.error('[Calendar] create post plan stub failed', e);
      alert(`Could not create post plan: ${e?.message || e}`);
    } finally {
      setCreating(false);
    }
  };

  const openCreateForDay = (cell) => createStubAndOpen(cell.date);
  const openCreateNow = () => createStubAndOpen(new Date());
  const openExisting = (post) => {
    if (!post) return;
    setRoute?.({ view: 'plan', id: post.id });
  };

  // --- Drag-to-reschedule handlers ------------------------------------
  // HTML5 drag-and-drop is enough here: lightweight, no extra dep, and
  // it composes with the existing click/right-click behaviour on chips.
  // We stash the plan id on `dataTransfer` under a custom MIME so foreign
  // drag sources (OS file drags, image drags from elsewhere) don't trip
  // the drop handler.
  const handleChipDragStart = (e, post) => {
    if (!post?.id) return;
    if (!post.canDrag) return; // belt-and-suspenders; chip is non-draggable already
    try {
      e.dataTransfer.setData(DRAG_MIME, post.id);
      // Also set text/plain as a fallback so the browser doesn't reject
      // the drag in some corner cases (older Safari has been picky).
      e.dataTransfer.setData('text/plain', post.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      // setData can throw under permission-restricted iframes; ignore.
    }
    const sourceIso = post.scheduledAt ? isoLocalDate(new Date(post.scheduledAt)) : null;
    setDragState({ planId: post.id, sourceIso, overIso: null });
  };
  const handleChipDragEnd = () => {
    setDragState({ planId: null, sourceIso: null, overIso: null });
  };
  const handleCellDragOver = (e, iso) => {
    // Only accept our own drag mime — keeps file drags from triggering
    // the highlight. `types` is a string array of available MIMEs on the
    // current drag operation; `getData` is not allowed in `dragover`.
    if (!e.dataTransfer.types?.includes(DRAG_MIME)) return;
    e.preventDefault(); // required to allow the drop
    e.dataTransfer.dropEffect = 'move';
    setDragState((prev) => (prev.overIso === iso ? prev : { ...prev, overIso: iso }));
  };
  const handleCellDragLeave = (e, iso) => {
    // Only clear if we're actually leaving the cell — `dragleave` fires
    // for child elements too. Use `relatedTarget` to disambiguate: if
    // the new target is inside the same cell, ignore.
    const next = e.relatedTarget;
    if (next && e.currentTarget?.contains?.(next)) return;
    setDragState((prev) => (prev.overIso === iso ? { ...prev, overIso: null } : prev));
  };
  const handleCellDrop = async (e, iso) => {
    e.preventDefault();
    const planId = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    setDragState({ planId: null, sourceIso: null, overIso: null });
    if (!planId) return;
    const plan = decoratedPostPlans.find((p) => p.id === planId);
    if (!plan || !plan.canDrag) return;
    // Same-day drop — nothing to do.
    const currentIso = plan.scheduledAt ? isoLocalDate(new Date(plan.scheduledAt)) : null;
    if (currentIso === iso) return;
    const nextScheduledAt = rescheduleToDate(plan.scheduledAt, iso);

    if (plan.dragMode === 'propose') {
      // Brand dragging a non-own plan (needs_review / approved). Open the
      // propose-new-date popover; the actual write happens inside the
      // popover's send handler.
      setProposeDateState({ plan, fromIso: plan.scheduledAt, toIso: nextScheduledAt });
      return;
    }

    // Free reschedule path — agency on anything, or brand on own brand_draft.
    // Optimistic update + revert-on-failure so the chip jumps immediately.
    const optimistic = { ...plan, scheduledAt: nextScheduledAt };
    onPlanChanged?.(optimistic);
    try {
      const updated = await updatePostPlan(plan.id, { scheduledAt: nextScheduledAt });
      onPlanChanged?.(updated);
    } catch (err) {
      console.error('[Calendar] reschedule failed', err);
      onPlanChanged?.(plan); // revert
      alert(`Could not reschedule: ${err?.message || err}`);
    }
  };
  // --------------------------------------------------------------------

  // Context menu handlers for chip right-click. Brand users get the
  // browser default menu — they can't duplicate plans (no edit access),
  // so the only menu item we'd show would be a no-op.
  const handleChipContextMenu = (e, post) => {
    if (!isAdmin) return;
    setCtxMenu({ x: e.clientX, y: e.clientY, plan: post });
  };

  const closeCtxMenu = () => setCtxMenu(null);

  // Close context menu on click outside or Escape.
  React.useEffect(() => {
    if (!ctxMenu) return;
    const onClickOutside = () => closeCtxMenu();
    const onEscape = (e) => { if (e.key === 'Escape') closeCtxMenu(); };
    document.addEventListener('click', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [ctxMenu]);

  const handleDuplicateFromCtx = () => {
    if (!ctxMenu?.plan) return;
    setDupSource(ctxMenu.plan);
    closeCtxMenu();
  };

  const handleDuplicateConfirm = async (dates) => {
    const source = dupSource;
    setDupSource(null);
    if (!dates.length || !source) return;
    try {
      const { created, errors } = await duplicatePostPlan({
        sourcePlan: source,
        targetDates: dates,
        userId,
      });
      for (const p of created) {
        onPlanCreated?.(p);
      }
      if (errors.length > 0 && created.length > 0) {
        alert(`Created ${created.length} of ${dates.length} plans. ${errors.length} failed.`);
      } else if (errors.length > 0) {
        alert(`Duplication failed: ${errors[0]?.message || errors[0]}`);
        return;
      }
      if (created.length > 0) {
        const earliest = created.reduce((a, b) =>
          (a.scheduledAt || '') < (b.scheduledAt || '') ? a : b
        );
        setRoute?.({ view: 'plan', id: earliest.id });
      }
    } catch (e) {
      console.error('duplicate failed', e);
      alert(`Duplication failed: ${e?.message || e}`);
    }
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="greeting" style={{ marginBottom: 8 }}>
            {/* Override the legacy green status-dot to the Linkrunner accent so
                the greeting reads as a brand flourish, not a "system
                online" indicator. */}
            <span
              className="status-dot"
              style={{ background: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-soft)' }}
            />
            <span>
              {auth?.name
                ? `Hello, ${auth.name.split(' ')[0]} — ${greetingTail()}`
                : auth
                  ? `Hello — ${greetingTail()}`
                  : 'Welcome to Linkrunner Media — a calmer way to plan your social.'}
            </span>
          </div>
          <h1>Social Calendar</h1>
          <div className="sub">
            Plan and preview every Instagram, LinkedIn, and X post for your brand.
            {isAdmin
              ? ' Click the + on any day to plan a new post.'
              : ' Click the + on any day to propose a new post — your agency will review.'}
          </div>
        </div>
        {accountId && (
          <div className="actions" style={{ display: 'flex', gap: 8 }}>
            {isAdmin && (
              <button
                className="btn btn-sm"
                onClick={() => setUpdateModalOpen(true)}
                title="Send a summary message to everyone on this brand"
              >
                <Icon name="mail" size={13}/>Send update
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={openCreateNow}>
              <Icon name="plus" size={13}/>{isAdmin ? 'New post plan' : 'Propose plan'}
            </button>
          </div>
        )}
      </div>

      <div className="cal-controls">
        <div className="cal-controls-nav">
          <button
            className="btn btn-sm btn-ghost"
            onClick={goPrev}
            aria-label={(viewMode === 'week' || weekScoped) ? 'Previous week' : 'Previous month'}
          >
            <Icon name="chevron-left" size={14}/>
          </button>
          <div className="cal-controls-heading">
            {(viewMode === 'week' || weekScoped)
              ? formatWeekRange(weekStart)
              : viewDate.toLocaleDateString('en-US', HEADING_FMT)}
          </div>
          <button
            className="btn btn-sm btn-ghost"
            onClick={goNext}
            aria-label={(viewMode === 'week' || weekScoped) ? 'Next week' : 'Next month'}
          >
            <Icon name="chevron-right" size={14}/>
          </button>
          <button className="btn btn-sm" onClick={goToday}>Today</button>
        </div>

        <div className="cal-controls-right">
          <div className="cal-segmented" role="tablist" aria-label="Calendar view">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'month'}
              className={'cal-segmented-btn' + (viewMode === 'month' ? ' on' : '')}
              onClick={() => setViewMode('month')}
            >
              Month
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'week'}
              className={'cal-segmented-btn' + (viewMode === 'week' ? ' on' : '')}
              onClick={() => setViewMode('week')}
            >
              Week
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'list'}
              className={'cal-segmented-btn' + (viewMode === 'list' ? ' on' : '')}
              onClick={() => setViewMode('list')}
            >
              List
            </button>
          </div>
        </div>
      </div>

      <div className="cal-filter-pills" role="tablist" aria-label="Filter by status">
        {Object.entries(STATUS_GROUPS).map(([key, group]) => {
          const active = statusFilter === key;
          const count = groupCounts[key] || 0;
          // Tint each pill with the same color the matching cards wear on
          // the calendar. STATUS_GROUPS[key].displayStatuses lists the raw
          // post_plans.status values that fall into this bucket; we look
          // up the first one in STATUS_CONFIG to pull its display color +
          // background tint. The "All" pill has `displayStatuses: null`
          // and intentionally stays neutral (no single status to inherit
          // from). CSS custom props avoid a class-per-status explosion.
          const primaryStatus = group.displayStatuses?.[0];
          const statusConfig  = primaryStatus ? STATUS_CONFIG[primaryStatus] : null;
          const pillStyle     = statusConfig
            ? { '--pill-color': statusConfig.color, '--pill-bg-tint': statusConfig.background }
            : undefined;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              className={
                'cal-filter-pill'
                + (active ? ' on' : '')
                + (statusConfig ? ' has-status-color' : '')
              }
              style={pillStyle}
              onClick={() => setStatusFilter(key)}
            >
              {statusConfig && <span className="cal-filter-pill-dot" aria-hidden="true" />}
              <span>{group.label}</span>
              {count > 0 && <span className="cal-filter-pill-badge">{count}</span>}
            </button>
          );
        })}
      </div>

      {viewMode === 'week' && (
        <WeekGrid
          weekStart={weekStart}
          postsByDate={postsByDate}
          onOpenPost={openExisting}
          onOpenDay={openCreateForDay}
          isAdmin={isAdmin}
          unreadByPlan={unreadByPlan}
          unackedPlanIds={unackedPlanIds}
          onChipContextMenu={handleChipContextMenu}
          dragState={dragState}
          onChipDragStart={handleChipDragStart}
          onChipDragEnd={handleChipDragEnd}
          onCellDragOver={handleCellDragOver}
          onCellDragLeave={handleCellDragLeave}
          onCellDrop={handleCellDrop}
        />
      )}
      {viewMode === 'list' && (
        <ListView
          viewDate={viewDate}
          postPlans={filteredPostPlans}
          weekScoped={weekScoped}
          onOpenPost={openExisting}
          onChipContextMenu={handleChipContextMenu}
          unreadByPlan={unreadByPlan}
          unackedPlanIds={unackedPlanIds}
          isAdmin={isAdmin}
          onOpenDay={openCreateForDay}
        />
      )}
      {viewMode === 'month' && (
        <MonthGrid
          viewDate={viewDate}
          postsByDate={postsByDate}
          onOpenPost={openExisting}
          onOpenDay={openCreateForDay}
          isAdmin={isAdmin}
          unreadByPlan={unreadByPlan}
          unackedPlanIds={unackedPlanIds}
          onChipContextMenu={handleChipContextMenu}
          dragState={dragState}
          onChipDragStart={handleChipDragStart}
          onChipDragEnd={handleChipDragEnd}
          onCellDragOver={handleCellDragOver}
          onCellDragLeave={handleCellDragLeave}
          onCellDrop={handleCellDrop}
        />
      )}

      {/* Legacy generic empty state — only renders for Month/Week,
           since ListView already provides its own context-aware empty
           message ("No posts in <Month>"). */}
      {postPlans.length === 0 && viewMode !== 'list' && (
        <div className="empty" style={{ marginTop: 24, padding: 24 }}>
          <div className="big">No posts planned yet.</div>
          {isAdmin
            ? 'Click any day in the calendar above to draft your first post plan.'
            : 'Your agency is putting together your social calendar — posts will appear here once they’re drafted.'}
        </div>
      )}

      {/* Context menu for right-click on chips */}
      {ctxMenu && (
        <div
          style={{
            position: 'fixed',
            top: ctxMenu.y,
            left: ctxMenu.x,
            zIndex: 100,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            padding: 4,
            minWidth: 160,
            animation: 'popIn 150ms var(--ease-out)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleDuplicateFromCtx}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '8px 10px',
              border: 0,
              borderRadius: 'var(--radius-sm)',
              background: 'transparent',
              color: 'var(--ink-2)',
              fontSize: 13,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="calendar" size={14} />
            Duplicate
          </button>
        </div>
      )}

      <DuplicateDatePicker
        open={!!dupSource}
        onConfirm={handleDuplicateConfirm}
        onCancel={() => setDupSource(null)}
        sourcePlan={dupSource}
      />

      <UpdateBrandModal
        open={updateModalOpen}
        accountId={accountId}
        accountName={accountName}
        onClose={() => setUpdateModalOpen(false)}
      />

      {proposeDateState && (
        <ProposeNewDateModal
          plan={proposeDateState.plan}
          fromIso={proposeDateState.fromIso}
          toIso={proposeDateState.toIso}
          accountId={accountId}
          userId={userId}
          onCancel={() => setProposeDateState(null)}
          onSent={() => setProposeDateState(null)}
        />
      )}

    </div></div>
  );
};

export { CalendarView };
