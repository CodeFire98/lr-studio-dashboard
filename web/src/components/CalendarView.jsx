/* eslint-disable */
/* CalendarView — Social Calendar landing page.
   Each day cell shows the post plans scheduled for that day; admins click
   an empty cell to plan a new post (creates a stub and routes to its
   detail page); anyone can click a chip to open the detail page. The
   chip surface shows platform icon(s) + concept one-liner + a colored
   status dot. The per-plan editor lives in <PostPlanDetailView/>. */
import React, { useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { PlatformChip, STATUS_CONFIG } from './postPlanShared.jsx';
import { createPostPlan, duplicatePostPlan } from '../lib/db.js';
import { DuplicateDatePicker } from './DuplicateDatePicker.jsx';

const HEADING_FMT   = { month: 'short', year: 'numeric' };
const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS_PER_CELL = 3;

// Status order — earlier statuses sort first within a day so the brand
// sees "things needing my attention" near the top of a busy cell.
const STATUS_ORDER = {
  needs_brand_feedback: 0,
  needs_admin_revision: 1,
  delayed:              2,
  wip:                  3,
  not_started:          4,
  approved:             5,
  scheduled:            6,
  posted:               7,
};

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
  const cfg = STATUS_CONFIG[post.status] || STATUS_CONFIG.not_started;
  const time = formatTime(post.scheduledAt);
  const titleSuffix = unreadCount > 0
    ? ` · ${unreadCount} unread update${unreadCount === 1 ? '' : 's'}`
    : '';
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(post); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, post);
      }}
      title={`${post.concept || 'Untitled post'} · ${cfg.label}${time ? ' · ' + time : ''}${titleSuffix}`}
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

const MonthGrid = ({ viewDate, postsByDate, onOpenPost, onOpenDay, isAdmin, unreadByPlan, onChipContextMenu }) => {
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
          const posts = postsByDate.get(c.iso) || [];
          const visible = posts.slice(0, MAX_CHIPS_PER_CELL);
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
                      onOpenPost(posts[MAX_CHIPS_PER_CELL]);
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

const CalendarView = ({
  postPlans = [],
  accountId,
  userId,
  mode,         // 'admin' | 'customer'
  setRoute,
  unreadByPlan,
  onPlanCreated,
}) => {
  const isAdmin = mode === 'admin';

  const [viewDate, setViewDate] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [creating, setCreating] = useState(false);
  // Status filter — replaces the bottom legend. 'all' = no filter.
  const [statusFilter, setStatusFilter] = useState('all');

  // Context menu state for right-click on chips.
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, plan }
  // Duplicate date picker state (opened from context menu).
  const [dupSource, setDupSource] = useState(null); // plan or null

  const filteredPostPlans = useMemo(
    () => statusFilter === 'all' ? postPlans : postPlans.filter((p) => p.status === statusFilter),
    [postPlans, statusFilter]
  );

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

  const goPrev   = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  const goNext   = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  const goToday  = () => {
    const today = new Date();
    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
  };

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
        status: 'not_started',
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

  // Context menu handlers for chip right-click.
  const handleChipContextMenu = (e, post) => {
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
          <div className="actions">
            <button className="btn btn-primary btn-sm" onClick={openCreateNow}>
              <Icon name="plus" size={13}/>New post plan
            </button>
          </div>
        )}
      </div>

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

        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {statusFilter !== 'all' && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: 'var(--ink-3)',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 99,
                  background: (STATUS_CONFIG[statusFilter] || STATUS_CONFIG.not_started).color,
                }}
              />
            </span>
          )}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="btn btn-sm"
            aria-label="Filter by status"
            style={{
              padding: '4px 28px 4px 10px',
              appearance: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="all">Status: All</option>
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.label}</option>
            ))}
          </select>
        </div>
      </div>

      <MonthGrid
        viewDate={viewDate}
        postsByDate={postsByDate}
        onOpenPost={openExisting}
        onOpenDay={openCreateForDay}
        isAdmin={isAdmin}
        unreadByPlan={unreadByPlan}
        onChipContextMenu={handleChipContextMenu}
      />

      {postPlans.length === 0 && (
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

    </div></div>
  );
};

export { CalendarView };
