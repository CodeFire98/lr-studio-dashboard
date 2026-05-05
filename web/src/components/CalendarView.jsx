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
import { PlatformChip, STATUS_CONFIG, StatusPill } from './postPlanShared.jsx';
import { createPostPlan, duplicatePostPlan, loadPostPlanListRollups } from '../lib/db.js';
import { DuplicateDatePicker } from './DuplicateDatePicker.jsx';
import { UpdateBrandModal } from './UpdateBrandModal.jsx';

const HEADING_FMT   = { month: 'short', year: 'numeric' };
const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS_PER_CELL = 3;

// Status order — earlier statuses sort first within a day so the brand
// sees "things needing my attention" near the top of a busy cell.
// Legacy enum values are mapped to the same slot as their new-enum
// equivalent so a cached realtime payload still sorts sanely.
const STATUS_ORDER = {
  needs_review:         0,
  needs_brand_feedback: 0,
  needs_admin_revision: 0,
  drafting:             1,
  not_started:          1,
  wip:                  1,
  delayed:              1,
  approved:             2,
  scheduled:            2,
  posted:               2,
};

// Filter buckets — the three workflow stages plus an All sentinel.
// Each bucket's `statuses` array also includes the legacy enum values
// so a row that hasn't yet been migrated still flows into the right
// bucket on the calendar.
const STATUS_GROUPS = {
  all:          { label: 'All',          statuses: null },
  drafting:     { label: 'Drafting',     statuses: ['drafting', 'not_started', 'wip', 'delayed'] },
  needs_review: { label: 'Needs review', statuses: ['needs_review', 'needs_brand_feedback', 'needs_admin_revision'] },
  approved:     { label: 'Approved',     statuses: ['approved', 'scheduled', 'posted'] },
};

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

const PostChip = ({ post, onOpen, onContextMenu, unreadCount = 0 }) => {
  const cfg = STATUS_CONFIG[post.status] || STATUS_CONFIG.drafting;
  const time = formatTime(post.scheduledAt);
  const titleSuffix = unreadCount > 0
    ? ` · ${unreadCount} unread update${unreadCount === 1 ? '' : 's'}`
    : '';
  const hoverTitle = `${post.concept || 'Untitled post'} · ${cfg.label}${time ? ' · ' + time : ''}${titleSuffix}`;

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
        cursor: 'pointer',
        minWidth: 0,
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
      {unreadCount > 0 && (
        <span
          aria-label={`${unreadCount} unread`}
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
const WeekPostCard = ({ post, onOpen, onContextMenu, unreadCount = 0 }) => {
  const cfg = STATUS_CONFIG[post.status] || STATUS_CONFIG.drafting;
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
      style={{
        background: cfg.background,
        borderLeft: `3px solid ${cfg.color}`,
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
        <StatusPill status={post.status} size="sm" />
      </div>
    </button>
  );
};

const MonthGrid = ({ viewDate, postsByDate, onOpenPost, onOpenDay, isAdmin, unreadByPlan, onChipContextMenu }) => {
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
          // Admins can click the empty area of a cell to drop a new plan
          // onto that day. Brands can't create — clicking an empty cell is
          // a no-op for them so they don't get a confusing dead button.
          const cellClickable = isAdmin;
          const handleCellClick = (e) => {
            // Don't fire when the click came from a chip (chips stop
            // propagation), but guard anyway in case bubbling slips through.
            if (e.target !== e.currentTarget && e.target.tagName === 'BUTTON') return;
            if (cellClickable) onOpenDay(c);
          };
          return (
            <div
              key={c.iso + '_' + i}
              onClick={handleCellClick}
              role={cellClickable ? 'button' : undefined}
              tabIndex={cellClickable ? 0 : undefined}
              onKeyDown={(e) => {
                if (cellClickable && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onOpenDay(c);
                }
              }}
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
                cursor: cellClickable ? 'pointer' : 'default',
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
                {cellClickable && c.inMonth && (
                  <span
                    aria-hidden
                    style={{ fontSize: 12, color: 'var(--ink-4)', opacity: 0.6 }}
                  >
                    +
                  </span>
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

const WeekGrid = ({ weekStart, postsByDate, onOpenPost, onOpenDay, isAdmin, unreadByPlan, onChipContextMenu }) => {
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
        const cellClickable = isAdmin;
        return (
          <div key={d.iso} className={'cal-week-col' + (d.isToday ? ' is-today' : '')}>
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
              title={cellClickable ? 'Click to plan a new post on this day' : undefined}
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
      aria-label={`${count} ${icon === 'comment' ? 'comments' : 'references'}`}
    >
      <Icon name={icon} size={11} />
      <span>{count}</span>
    </span>
  );
};

const ReferencePopover = ({ refs }) => {
  if (!refs || refs.length === 0) return null;
  return (
    <div className="cal-list-ref-popover" role="tooltip">
      {refs.map((r) => {
        const isImage = (r.mimeType || '').startsWith('image/') && r.url;
        return (
          <div key={r.id} className="cal-list-ref-thumb" title={r.filename}>
            {isImage ? (
              <img src={r.url} alt={r.filename} loading="lazy" />
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

const ListRow = ({ post, onOpen, onContextMenu, unreadCount, commentsCount, references }) => {
  const cfg = STATUS_CONFIG[post.status] || STATUS_CONFIG.drafting;
  const time = formatTime(post.scheduledAt) || '—';
  const referencesCount = references?.length || 0;
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
        <StatusPill status={post.status} size="sm" />
      </div>

      <div className="cal-list-row-stats">
        <StatPill icon="comment" count={commentsCount} accent={unreadCount > 0} />
        {referencesCount > 0 && (
          <span className="cal-list-row-stat has-popover" aria-label={`${referencesCount} references`}>
            <Icon name="paperclip" size={11} />
            <span>{referencesCount}</span>
            <ReferencePopover refs={references} />
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

const ListView = ({ viewDate, postPlans, onOpenPost, onChipContextMenu, unreadByPlan, isAdmin, onOpenDay }) => {
  // Month-scoped — anchor on viewDate's month/year. Filter posts to
  // those scheduled in that month, sort chronologically.
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthPosts = useMemo(() => {
    return (postPlans || [])
      .filter((p) => {
        if (!p.scheduledAt) return false;
        const d = new Date(p.scheduledAt);
        return d.getFullYear() === year && d.getMonth() === month;
      })
      .sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));
  }, [postPlans, year, month]);

  // Bulk-fetch comments + references for every visible plan in one shot.
  // Re-runs whenever the visible-plan set changes (new month picked,
  // status filter narrows, etc.). Also includes plan.updatedAt in the
  // dep key so a fresh comment elsewhere triggers a refetch.
  const [rollups, setRollups] = useState({ commentsByPlan: new Map(), referencesByPlan: new Map() });
  const ids = monthPosts.map((p) => p.id);
  const idsKey = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    if (ids.length === 0) {
      setRollups({ commentsByPlan: new Map(), referencesByPlan: new Map() });
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
    return (
      <div className="cal-list-empty">
        <div className="big">No posts in {viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.</div>
        <div className="sub">
          {isAdmin
            ? 'Use Today or the prev/next arrows to browse another month, or click below to plan one now.'
            : 'Your agency is putting together your social calendar — posts will show up here once they\'re drafted.'}
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ marginTop: 14 }}
            onClick={() => onOpenDay({ date: new Date() })}
          >
            <Icon name="plus" size={13}/> Plan a post now
          </button>
        )}
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
                          references={rollups.referencesByPlan.get(post.id) || []}
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
}) => {
  const isAdmin = mode === 'admin';

  // View mode + status filter are persisted so an agency lead who lives
  // in list view doesn't have to set it back every reload. The legacy
  // density toggle was retired alongside the new List view — list view
  // is the proper "more rows than fits as chips" surface; the
  // density-toggle compact mode was a half-measure.
  const [viewMode, setViewMode]   = useState(() => readLS(LS_VIEW_MODE, 'month', ['month', 'week', 'list']));
  const [statusFilter, setStatusFilter] = useState(() => readLS(LS_STATUS_FILTER, 'all', Object.keys(STATUS_GROUPS)));

  useEffect(() => { writeLS(LS_VIEW_MODE, viewMode); }, [viewMode]);
  useEffect(() => { writeLS(LS_STATUS_FILTER, statusFilter); }, [statusFilter]);

  const [viewDate, setViewDate] = useState(() => {
    // Anchor at "today" — matrix builders only inspect year/month (month
    // view) or compute startOfWeek (week view), so the day-of-month
    // doesn't need to be 1.
    return new Date();
  });
  const [creating, setCreating] = useState(false);

  const weekStart = useMemo(() => startOfWeek(viewDate), [viewDate]);

  // Context menu state for right-click on chips.
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, plan }
  // Duplicate date picker state (opened from context menu).
  const [dupSource, setDupSource] = useState(null); // plan or null
  // Send-update modal state (agency-only).
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

  const filteredPostPlans = useMemo(() => {
    const allowed = STATUS_GROUPS[statusFilter]?.statuses;
    if (!allowed) return postPlans;
    return postPlans.filter((p) => allowed.includes(p.status));
  }, [postPlans, statusFilter]);

  // Counts per status group — drive the small badge inside each filter
  // pill so the agency lead can see at a glance "5 things in review,
  // 12 approved" without flipping filters.
  const groupCounts = useMemo(() => {
    const out = {};
    for (const [key, group] of Object.entries(STATUS_GROUPS)) {
      out[key] = group.statuses
        ? postPlans.filter((p) => group.statuses.includes(p.status)).length
        : postPlans.length;
    }
    return out;
  }, [postPlans]);

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
        const sd = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
        if (sd !== 0) return sd;
        return (a.scheduledAt || '').localeCompare(b.scheduledAt || '');
      });
    }
    return map;
  }, [filteredPostPlans]);

  const goPrev = () => {
    if (viewMode === 'week') {
      const d = new Date(viewDate);
      d.setDate(d.getDate() - 7);
      setViewDate(d);
    } else {
      setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
    }
  };
  const goNext = () => {
    if (viewMode === 'week') {
      const d = new Date(viewDate);
      d.setDate(d.getDate() + 7);
      setViewDate(d);
    } else {
      setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
    }
  };
  const goToday  = () => setViewDate(new Date());

  // Create a stub plan for the given day at 9am, then route to its detail
  // page so the admin fills in concept/copy/etc inline. Stubs are real
  // rows — if the admin walks away, an empty card sits on the calendar
  // until they delete it. Cleanest UX vs. keeping a parallel "draft" path.
  const createStubAndOpen = async (jsDate) => {
    // Surface the gating reason to the console so a silent failure (e.g.
    // no active brand) is debuggable without instrumenting the click.
    if (!isAdmin) { console.warn('[Calendar] create blocked: not admin'); return; }
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
        status: 'drafting',
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
          <div className="tiny" style={{ marginBottom: 8 }}>Schedule</div>
          <h1>Social Calendar</h1>
          <div className="sub">
            Plan and preview every Instagram, LinkedIn, and X post for your brand.
            {isAdmin ? ' Click any day to plan a new post.' : ' Click a post to review and give feedback.'}
          </div>
        </div>
        {isAdmin && (
          <div className="actions" style={{ display: 'flex', gap: 8 }}>
            {accountId && (
              <button
                className="btn btn-sm"
                onClick={() => setUpdateModalOpen(true)}
                title="Send a summary message to everyone on this brand"
              >
                <Icon name="mail" size={13}/>Send update
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={openCreateNow}>
              <Icon name="plus" size={13}/>New post plan
            </button>
          </div>
        )}
      </div>

      <div className="cal-controls">
        <div className="cal-controls-nav">
          <button
            className="btn btn-sm btn-ghost"
            onClick={goPrev}
            aria-label={viewMode === 'week' ? 'Previous week' : 'Previous month'}
          >
            <Icon name="chevron-left" size={14}/>
          </button>
          <div className="cal-controls-heading">
            {viewMode === 'week'
              ? formatWeekRange(weekStart)
              : viewDate.toLocaleDateString('en-US', HEADING_FMT)}
          </div>
          <button
            className="btn btn-sm btn-ghost"
            onClick={goNext}
            aria-label={viewMode === 'week' ? 'Next week' : 'Next month'}
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
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              className={'cal-filter-pill' + (active ? ' on' : '')}
              onClick={() => setStatusFilter(key)}
            >
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
          onChipContextMenu={handleChipContextMenu}
        />
      )}
      {viewMode === 'list' && (
        <ListView
          viewDate={viewDate}
          postPlans={filteredPostPlans}
          onOpenPost={openExisting}
          onChipContextMenu={handleChipContextMenu}
          unreadByPlan={unreadByPlan}
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
          onChipContextMenu={handleChipContextMenu}
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

    </div></div>
  );
};

export { CalendarView };
