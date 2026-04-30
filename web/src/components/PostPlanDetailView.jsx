/* eslint-disable */
/* PostPlanDetailView — full-page surface for planning, reviewing, and
   approving a post plan. Mirrors TaskDetailView's bones: page head with
   title + status + workflow CTAs, tabbed main column (Overview /
   Conversation / Activity), sticky sidebar with Team + Timeline.

   Replaces the old popup modal — the calendar now navigates to this
   route instead of opening a modal in place. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import {
  PLATFORMS,
  PLATFORM_BY_KEY,
  STATUS_CONFIG,
  PlatformChip,
  StatusPill,
  toDatetimeLocal,
  fromDatetimeLocal,
} from './postPlanShared.jsx';
import {
  loadPostPlanById,
  updatePostPlan,
  deletePostPlan,
  loadPostPlanComments,
  addPostPlanComment,
  subscribeToPostPlanComments,
  loadPostPlanAttachments,
  addPostPlanAttachment,
  deletePostPlanAttachment,
  markPostPlanSeen,
} from '../lib/db.js';

// =====================================================================
// Attachments card
// =====================================================================
// Shared between References (kind='reference', brand uploads) and
// Final assets (kind='final', admin uploads). Both sides see the other's
// uploads read-only — only the matching role gets the upload control.

const formatBytes = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const isImageMime = (m) => typeof m === 'string' && m.startsWith('image/');

const AttachmentTile = ({ att, canDelete, onDelete }) => {
  const showImage = isImageMime(att.mimeType) && att.url;
  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--line)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <a
        href={att.url}
        target="_blank"
        rel="noopener noreferrer"
        title={att.filename}
        style={{
          display: 'block',
          height: 110,
          background: 'var(--surface-2)',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        {showImage ? (
          <img
            src={att.url}
            alt={att.filename}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-3)',
            }}
          >
            <Icon name="paperclip" size={28} />
          </div>
        )}
      </a>
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <a
          href={att.url}
          target="_blank"
          rel="noopener noreferrer"
          title={att.filename}
          style={{
            fontSize: 12,
            color: 'var(--ink-1)',
            textDecoration: 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {att.filename}
        </a>
        <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>
          {att.uploader?.name || 'Someone'} · {formatBytes(att.sizeBytes)}
        </div>
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={() => onDelete(att)}
          aria-label="Delete attachment"
          title="Delete"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            border: 0,
            borderRadius: 99,
            width: 24,
            height: 24,
            background: 'rgba(0,0,0,0.55)',
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <Icon name="trash" size={12}/>
        </button>
      )}
    </div>
  );
};

const AttachmentsCard = ({
  title,
  subtitle,
  emptyText,
  items,
  canUpload,
  uploading,
  onUpload,
  currentUserId,
}) => {
  const inputRef = useRef(null);
  const onPick = () => inputRef.current?.click();
  const onChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) onUpload(files);
    if (inputRef.current) inputRef.current.value = '';
  };
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">{subtitle}</div>
        </div>
        {canUpload && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onPick}
            disabled={uploading}
          >
            <Icon name="upload" size={13}/>{uploading ? 'Uploading…' : 'Upload'}
          </button>
        )}
      </div>
      <div style={{ padding: '0 16px 16px' }}>
        {canUpload && (
          <input
            ref={inputRef}
            type="file"
            multiple
            onChange={onChange}
            style={{ display: 'none' }}
          />
        )}
        {items.length === 0 ? (
          <div className="empty" style={{ padding: 20, color: 'var(--ink-4)', fontSize: 13 }}>
            {emptyText}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 10,
            }}
          >
            {items.map((a) => (
              <AttachmentTile
                key={a.id}
                att={a}
                canDelete={canUpload && a.uploadedBy === currentUserId}
                onDelete={(att) => onUpload([], att)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// Component
// =====================================================================

const PostPlanDetailView = ({
  postPlanId,
  postPlans = [],
  userId,
  role,           // 'admin' | 'brand'
  setRoute,
  onPlanChanged,  // (plan) => void — optimistic upsert into App's postPlans
  onPlanDeleted,  // (planId) => void
  onPlanSeen,     // (planId) => void — clear unread badge in App-level map
}) => {
  const isAdmin = role === 'admin';

  // Hydrate from the App-level list first (instant), then refetch for
  // the freshest copy + anything not in the list snapshot.
  const fromList = useMemo(
    () => postPlans.find((p) => p.id === postPlanId) || null,
    [postPlans, postPlanId]
  );
  const [plan, setPlan] = useState(fromList);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    if (!postPlanId) return;
    let cancelled = false;
    loadPostPlanById(postPlanId)
      .then((p) => {
        if (cancelled) return;
        if (p) setPlan(p);
        else setLoadErr('Post plan not found.');
      })
      .catch((e) => { if (!cancelled) setLoadErr(e?.message || 'Failed to load.'); });
    return () => { cancelled = true; };
  }, [postPlanId]);

  // Sync local state with realtime updates from App.jsx (which already
  // subscribes to post_plans). When the App list refreshes the row, our
  // detail view picks up the change without a manual refetch.
  useEffect(() => {
    if (fromList) setPlan(fromList);
  }, [fromList]);

  // Tabs.
  const [tab, setTab] = useState('overview');

  // Comments stream.
  const [comments, setComments] = useState([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentHint, setCommentHint] = useState('');
  const commentInputRef = useRef(null);

  useEffect(() => {
    if (!postPlanId || !userId) return;
    let cancelled = false;
    loadPostPlanComments(postPlanId, userId)
      .then((rows) => { if (!cancelled) setComments(rows); })
      .catch((e) => console.warn('loadPostPlanComments failed', e));
    const unsub = subscribeToPostPlanComments(postPlanId, userId, (evt) => {
      if (evt.type === 'INSERT') {
        setComments((prev) =>
          prev.some((c) => c.id === evt.comment.id) ? prev : [...prev, evt.comment]
        );
      }
    });
    return () => { cancelled = true; unsub?.(); };
  }, [postPlanId, userId]);

  // Locally-edited fields. We hydrate from `plan` and write back to the
  // server on blur/change so the page feels live without a Save button.
  const [concept, setConcept] = useState(plan?.concept || '');
  // Draft = the raw `YYYY-MM-DDTHH:MM` string the input is showing right
  // now. Keeping it as a string (not the ISO timestamp) lets the user
  // type through the date/time fields without re-renders nuking their
  // cursor between keystrokes. Persists on blur, not on change.
  const [scheduledDraft, setScheduledDraft] = useState(toDatetimeLocal(plan?.scheduledAt || ''));
  const [platforms, setPlatforms] = useState(plan?.platforms || []);
  const [copyVariants, setCopyVariants] = useState(plan?.copyVariants || {});
  const [activeCopyTab, setActiveCopyTab] = useState((plan?.platforms || [])[0] || null);
  const [status, setStatus] = useState(plan?.status || 'not_started');
  const [saving, setSaving] = useState(false);
  // Title editing — read mode by default with a pencil affordance; flips
  // to an autofocused input when the user clicks the pencil. Enter saves
  // and exits, Escape cancels and reverts.
  const [titleEditing, setTitleEditing] = useState(false);

  // Refresh local fields whenever the canonical plan changes.
  useEffect(() => {
    if (!plan) return;
    setConcept(plan.concept || '');
    setScheduledDraft(toDatetimeLocal(plan.scheduledAt || ''));
    setPlatforms(plan.platforms || []);
    setCopyVariants(plan.copyVariants || {});
    setStatus(plan.status || 'not_started');
    setActiveCopyTab((prev) => (plan.platforms || []).includes(prev) ? prev : (plan.platforms || [])[0] || null);
  }, [plan?.id, plan?.updatedAt]);

  // Mark this plan as "seen" for the viewer so its unread badge clears
  // immediately on open. Idempotent — runs once per (plan, viewer) tuple.
  // Also clears the App-level unread map directly so the calendar dot
  // disappears as soon as we navigate back, without waiting on realtime.
  useEffect(() => {
    if (!postPlanId || !userId) return;
    markPostPlanSeen(postPlanId, userId);
    onPlanSeen?.(postPlanId);
    const onFocus = () => {
      markPostPlanSeen(postPlanId, userId);
      onPlanSeen?.(postPlanId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [postPlanId, userId]);

  // ---- Attachments (References + Final assets) ----
  const [attachments, setAttachments] = useState([]);
  const [uploadingKind, setUploadingKind] = useState(null); // 'reference' | 'final' | null

  useEffect(() => {
    if (!postPlanId) return;
    let cancelled = false;
    loadPostPlanAttachments(postPlanId)
      .then((rows) => { if (!cancelled) setAttachments(rows); })
      .catch((e) => console.warn('loadPostPlanAttachments failed', e));
    return () => { cancelled = true; };
  }, [postPlanId]);

  const referenceAttachments = useMemo(
    () => attachments.filter((a) => a.kind === 'reference'),
    [attachments]
  );
  const finalAttachments = useMemo(
    () => attachments.filter((a) => a.kind === 'final'),
    [attachments]
  );

  // Single-channel handler for both upload and delete from AttachmentsCard.
  // `files` is the new file list (empty when only deleting), `toDelete` is
  // an attachment row to remove.
  const handleAttachmentChange = async (kind, files, toDelete) => {
    if (toDelete) {
      try {
        await deletePostPlanAttachment(toDelete);
        setAttachments((prev) => prev.filter((a) => a.id !== toDelete.id));
      } catch (e) {
        console.error('delete attachment failed', e);
        alert(`Could not delete: ${e?.message || e}`);
      }
      return;
    }
    if (!files || files.length === 0) return;
    if (!plan?.accountId) return;
    setUploadingKind(kind);
    try {
      for (const file of files) {
        const created = await addPostPlanAttachment({
          postPlanId: plan.id,
          accountId: plan.accountId,
          kind,
          file,
          uploadedBy: userId,
        });
        setAttachments((prev) => [created, ...prev]);
      }
    } catch (e) {
      console.error('upload attachment failed', e);
      alert(`Could not upload: ${e?.message || e}`);
    } finally {
      setUploadingKind(null);
    }
  };

  // ---- Save helpers ---------------------------------------------------

  const persist = async (patch) => {
    if (!plan?.id) return;
    setSaving(true);
    try {
      const next = await updatePostPlan(plan.id, patch);
      setPlan(next);
      onPlanChanged?.(next);
      // Re-stamp last_seen so our own edits don't surface as unread
      // activity for ourselves on the next refresh tick.
      markPostPlanSeen(plan.id, userId);
      onPlanSeen?.(plan.id);
    } catch (e) {
      console.error('save plan failed', e);
    } finally {
      setSaving(false);
    }
  };

  const handleConceptBlur = () => {
    if (concept !== plan?.concept) persist({ concept });
  };

  const handleScheduledBlur = () => {
    const iso = fromDatetimeLocal(scheduledDraft);
    if (iso !== plan?.scheduledAt) persist({ scheduledAt: iso });
  };

  const togglePlatform = (key) => {
    if (!isAdmin) return;
    const next = platforms.includes(key) ? platforms.filter((p) => p !== key) : [...platforms, key];
    setPlatforms(next);
    if (!next.includes(activeCopyTab)) setActiveCopyTab(next[0] || null);
    persist({ platforms: next });
  };

  const handleCopyBlur = (key, val) => {
    if ((plan?.copyVariants || {})[key] !== val) {
      const next = { ...copyVariants, [key]: val };
      setCopyVariants(next);
      persist({ copyVariants: next });
    }
  };

  const transitionStatus = async (next, { requireComment = false } = {}) => {
    if (requireComment && !commentDraft.trim()) {
      setCommentHint('Add a comment explaining what needs to change.');
      setTab('conversation');
      setTimeout(() => commentInputRef.current?.focus(), 0);
      return;
    }
    if (requireComment && commentDraft.trim()) {
      try {
        await addPostPlanComment({
          postPlanId: plan.id,
          body: commentDraft.trim(),
          authorId: userId,
        });
        setCommentDraft('');
      } catch (e) {
        console.error('post comment failed', e);
        return;
      }
    }
    persist({ status: next });
    setStatus(next);
  };

  const handlePostComment = async () => {
    const body = commentDraft.trim();
    if (!body || !plan?.id || !userId) return;
    setCommentHint('');
    try {
      const c = await addPostPlanComment({ postPlanId: plan.id, body, authorId: userId });
      setCommentDraft('');
      setComments((prev) => prev.some((x) => x.id === c.id) ? prev : [...prev, c]);
    } catch (e) {
      console.error('post comment failed', e);
    }
  };

  const handleDelete = async () => {
    if (!plan?.id) return;
    if (!window.confirm('Delete this post plan? This can’t be undone.')) return;
    try {
      await deletePostPlan(plan.id);
      onPlanDeleted?.(plan.id);
      setRoute({ view: 'calendar' });
    } catch (e) {
      console.error('delete failed', e);
    }
  };

  // ---- Activity feed (synthesized) ------------------------------------
  // No dedicated activity table — we synthesize the timeline from the
  // events we already store: created, comments, attachments uploaded,
  // approval, posted. Hook stays above the null-plan early-return so
  // React sees the same hook count on every render (Rules of Hooks).
  const activityFeed = useMemo(() => {
    if (!plan) return [];
    const items = [];
    if (plan.createdAt) {
      items.push({
        id: 'created', kind: 'created',
        actor: plan.creator,
        time: plan.createdAt,
        label: `${plan.creator?.name || 'Someone'} created this post plan`,
      });
    }
    for (const c of comments) {
      items.push({
        id: `comment_${c.id}`, kind: 'comment',
        actor: c.who,
        time: c.createdAt,
        label: `${c.who?.name || 'Someone'} commented`,
        body: c.body,
      });
    }
    for (const a of attachments) {
      const verb = a.kind === 'final' ? 'uploaded a deliverable' : 'shared a reference';
      items.push({
        id: `att_${a.id}`, kind: 'attachment',
        actor: a.uploader,
        time: a.createdAt,
        label: `${a.uploader?.name || 'Someone'} ${verb}`,
        body: a.filename,
      });
    }
    if (plan.approvedAt) {
      items.push({ id: 'approved', kind: 'approved', actor: null, time: plan.approvedAt, label: 'Plan approved' });
    }
    if (plan.postedAt) {
      items.push({ id: 'posted', kind: 'posted', actor: null, time: plan.postedAt, label: 'Marked as posted' });
    }
    return items.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  }, [plan?.createdAt, plan?.approvedAt, plan?.postedAt, plan?.creator, comments, attachments]);

  // ---- Loading / not-found --------------------------------------------

  if (!plan) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head">
          <div className="titles">
            <div className="tiny" style={{ marginBottom: 8 }}>
              <a onClick={() => setRoute({ view: 'calendar' })} style={{ cursor: 'pointer' }}>← Social Calendar</a>
            </div>
            <h1>{loadErr || 'Loading post plan…'}</h1>
          </div>
        </div>
      </div></div>
    );
  }

  // ---- Status workflow buttons ---------------------------------------

  const statusActions = (() => {
    const out = [];
    if (isAdmin) {
      if (status === 'not_started' || status === 'wip' || status === 'needs_admin_revision') {
        out.push({ label: 'Submit for review', tone: 'primary', next: 'needs_brand_feedback' });
      }
      if (status === 'approved') {
        out.push({ label: 'Mark posted', tone: 'good', next: 'posted' });
      }
      if (status !== 'posted' && status !== 'delayed') {
        out.push({ label: 'Mark delayed', tone: 'ghost', next: 'delayed' });
      }
    } else if (status === 'needs_brand_feedback') {
      out.push({ label: 'Approve', tone: 'good', next: 'approved' });
      out.push({ label: 'Request changes', tone: 'accent', next: 'needs_admin_revision', requireComment: true });
    }
    return out;
  })();

  // ---- Render ---------------------------------------------------------

  return (
    <div className="view"><div className="view-inner">
      {/* Page head */}
      <div className="page-head">
        <div className="titles" style={{ flex: 1, minWidth: 0 }}>
          <div className="tiny" style={{ marginBottom: 8 }}>
            <a onClick={() => setRoute({ view: 'calendar' })} style={{ cursor: 'pointer' }}>← Social Calendar</a>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48 }}>
            {titleEditing && isAdmin ? (
              <input
                autoFocus
                type="text"
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                onBlur={() => { handleConceptBlur(); setTitleEditing(false); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.currentTarget.blur(); }
                  if (e.key === 'Escape') {
                    setConcept(plan?.concept || '');
                    setTitleEditing(false);
                  }
                }}
                placeholder="Untitled post"
                disabled={saving}
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 40,
                  fontWeight: 400,
                  letterSpacing: '-0.01em',
                  color: 'var(--ink-1)',
                  border: 0,
                  outline: 'none',
                  background: 'transparent',
                  width: '100%',
                  padding: 0,
                  lineHeight: 1.1,
                }}
              />
            ) : (
              <>
                <h1
                  onClick={() => isAdmin && setTitleEditing(true)}
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-serif)',
                    fontSize: 40,
                    fontWeight: 400,
                    letterSpacing: '-0.01em',
                    color: concept ? 'var(--ink-1)' : 'var(--ink-4)',
                    lineHeight: 1.1,
                    cursor: isAdmin ? 'text' : 'default',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {concept || 'Untitled post'}
                </h1>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setTitleEditing(true)}
                    aria-label="Edit title"
                    title="Edit title"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 30,
                      height: 30,
                      borderRadius: 6,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--ink-4)',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--ink-2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-4)'; }}
                  >
                    <Icon name="edit" size={16}/>
                  </button>
                )}
              </>
            )}
          </div>
          <div className="sub" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <StatusPill status={status} size="lg"/>
            <span>·</span>
            <input
              type="datetime-local"
              value={scheduledDraft}
              onChange={(e) => setScheduledDraft(e.target.value)}
              onBlur={handleScheduledBlur}
              disabled={!isAdmin || saving}
              style={{
                padding: '4px 8px',
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--surface)',
                color: 'var(--ink-2)',
                fontSize: 13,
                outline: 'none',
              }}
            />
            {platforms.length > 0 && (
              <>
                <span>·</span>
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {platforms.map((p) => <PlatformChip key={p} platform={p} size="sm"/>)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {statusActions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`btn btn-sm ${a.tone === 'ghost' ? 'btn-ghost' : 'btn-primary'}`}
              onClick={() => transitionStatus(a.next, { requireComment: a.requireComment })}
              disabled={saving}
              style={
                a.tone === 'good'
                  ? { background: 'var(--good)', borderColor: 'var(--good)' }
                  : a.tone === 'accent'
                  ? { background: 'var(--accent)', borderColor: 'var(--accent)' }
                  : undefined
              }
            >
              {a.label}
            </button>
          ))}
          {isAdmin && (
            <select
              className="btn btn-sm"
              value={status}
              onChange={(e) => { setStatus(e.target.value); persist({ status: e.target.value }); }}
              disabled={saving}
              style={{ appearance: 'none', paddingRight: 28 }}
            >
              {Object.entries(STATUS_CONFIG).map(([k, c]) => (
                <option key={k} value={k}>Set: {c.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        borderBottom: '1px solid var(--line)',
        marginBottom: 24, marginTop: -8,
      }}>
        {[
          { k: 'overview', label: 'Overview', icon: 'sparkles' },
          { k: 'conversation', label: 'Conversation', icon: 'comment', count: comments.length },
          { k: 'activity', label: 'Activity', icon: 'clock', count: activityFeed.length },
        ].map((t) => {
          const active = tab === t.k;
          return (
            <button key={t.k} type="button" onClick={() => setTab(t.k)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 16px',
              border: 0, background: 'transparent',
              fontSize: 13.5, fontWeight: 500,
              color: active ? 'var(--ink)' : 'var(--ink-3)',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
              cursor: 'pointer',
              transition: 'color 150ms',
            }}>
              <Icon name={t.icon} size={14}/>
              <span>{t.label}</span>
              {typeof t.count === 'number' && t.count > 0 && (
                <span style={{
                  fontSize: 11, fontVariantNumeric: 'tabular-nums',
                  padding: '1px 7px', borderRadius: 999,
                  background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: active ? 'var(--accent-ink)' : 'var(--ink-3)',
                  fontWeight: 500,
                }}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="detail">
        <div className="detail-main">
          {tab === 'overview' && (
            <>
              {/* Platforms */}
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Platforms</div>
                    <div className="card-sub">Where this post will go live.</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 16px 16px' }}>
                  {PLATFORMS.map((p) => {
                    const on = platforms.includes(p.key);
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => togglePlatform(p.key)}
                        disabled={!isAdmin || saving}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 12px',
                          borderRadius: 99,
                          border: `1px solid ${on ? 'var(--ink-2)' : 'var(--line)'}`,
                          background: on ? 'var(--surface-2)' : 'transparent',
                          color: 'var(--ink-1)',
                          fontSize: 13,
                          cursor: isAdmin && !saving ? 'pointer' : 'default',
                          opacity: !isAdmin && !on ? 0.6 : 1,
                        }}
                      >
                        <PlatformChip platform={p.key} size="sm"/>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Copy variants */}
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Copy</div>
                    <div className="card-sub">
                      {platforms.length === 0
                        ? 'Pick a platform above to start writing.'
                        : 'Per-platform copy. Tweak each so the post lands in that platform’s voice.'}
                    </div>
                  </div>
                </div>
                {platforms.length > 0 && (
                  <div style={{ padding: '0 16px 16px' }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                      {platforms.map((p) => {
                        const on = activeCopyTab === p;
                        const platCfg = PLATFORM_BY_KEY[p];
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setActiveCopyTab(p)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '6px 12px',
                              borderRadius: 99,
                              border: on ? '1px solid var(--ink-1)' : '1px solid var(--line)',
                              background: on ? 'var(--surface-2)' : 'transparent',
                              color: on ? 'var(--ink-1)' : 'var(--ink-4)',
                              fontWeight: on ? 600 : 400,
                              cursor: 'pointer',
                              fontSize: 12.5,
                              transition: 'background 120ms, color 120ms, border-color 120ms',
                            }}
                          >
                            <PlatformChip platform={p} size="sm"/>
                            {platCfg?.label || p}
                          </button>
                        );
                      })}
                    </div>
                    <textarea
                      key={activeCopyTab}
                      rows={6}
                      defaultValue={(copyVariants[activeCopyTab] || '')}
                      onBlur={(e) => handleCopyBlur(activeCopyTab, e.target.value)}
                      placeholder={`Write the ${PLATFORM_BY_KEY[activeCopyTab]?.label || ''} version of this post…`}
                      disabled={!isAdmin || saving}
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
                        minHeight: 130,
                        fontFamily: 'inherit',
                      }}
                    />
                  </div>
                )}
              </div>

              {/* References — brand uploads inspiration, both sides view. */}
              <AttachmentsCard
                title="References"
                subtitle={isAdmin
                  ? 'Inspiration shared by the brand — the look and feel they’re after.'
                  : 'Drop in inspiration images for what you want this post to feel like.'}
                emptyText={isAdmin
                  ? 'No references shared yet.'
                  : 'No references yet — upload images, screenshots, or examples.'}
                items={referenceAttachments}
                canUpload={!isAdmin}
                uploading={uploadingKind === 'reference'}
                currentUserId={userId}
                onUpload={(files, toDelete) => handleAttachmentChange('reference', files, toDelete)}
              />

              {/* Deliverables — admin uploads final creatives, both sides view. */}
              <AttachmentsCard
                title="Deliverables"
                subtitle={isAdmin
                  ? 'Final creatives for review and posting. Pushed to Library when marked posted.'
                  : 'Approved creatives from your agency lead.'}
                emptyText={isAdmin
                  ? 'No deliverables yet — upload the final creatives.'
                  : 'Your agency hasn’t shared the final creatives yet.'}
                items={finalAttachments}
                canUpload={isAdmin}
                uploading={uploadingKind === 'final'}
                currentUserId={userId}
                onUpload={(files, toDelete) => handleAttachmentChange('final', files, toDelete)}
              />

              {isAdmin && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleDelete} style={{ color: 'var(--accent)' }}>
                    Delete post plan
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'conversation' && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Conversation</div>
                  <div className="card-sub">Use this thread to align on copy, references, and feedback.</div>
                </div>
              </div>
              <div style={{ padding: '0 16px 16px' }}>
                {comments.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--ink-4)', padding: '4px 0 12px' }}>
                    No comments yet. Start the conversation below.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
                    {comments.map((c) => (
                      <div key={c.id} style={{ display: 'flex', gap: 10 }}>
                        <Avatar person={c.who} size="sm"/>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                            <strong style={{ fontSize: 13 }}>{c.who?.name || 'Someone'}</strong>
                            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{c.time}</span>
                          </div>
                          <div style={{ fontSize: 13.5, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={commentInputRef}
                  rows={3}
                  placeholder="Add a comment…"
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  disabled={!userId}
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
                    minHeight: 80,
                    fontFamily: 'inherit',
                  }}
                />
                {commentHint && (
                  <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 4 }}>{commentHint}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={handlePostComment} disabled={!commentDraft.trim() || !userId}>
                    Post comment
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'activity' && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Activity</div>
                  <div className="card-sub">Everything that’s happened on this plan.</div>
                </div>
              </div>
              <div style={{ padding: '0 16px 20px' }}>
                {activityFeed.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--ink-4)', padding: '8px 0' }}>No activity yet.</div>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {activityFeed.map((a) => (
                      <li key={a.id} style={{ display: 'flex', gap: 10 }}>
                        <Icon
                          name={a.kind === 'comment' ? 'comment' : a.kind === 'approved' ? 'check' : a.kind === 'posted' ? 'send' : 'sparkles'}
                          size={14}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{a.label}</div>
                          {a.body && (
                            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              {a.body}
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 3 }}>
                            {new Date(a.time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="detail-side">
          <div className="card">
            <div className="card-head"><div className="card-title" style={{ fontSize: 18 }}>Team</div></div>
            <div className="collab-list">
              <div className="collab-row">
                <Avatar person={plan.creator} size="sm"/>
                <div>
                  <div className="name">{plan.creator?.name || 'Unassigned'}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{plan.creator?.role}</div>
                </div>
                <div className="role">Created by</div>
              </div>
              {plan.accountName && (
                <div className="collab-row">
                  <span style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: 'var(--surface-2)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 600, fontSize: 12, color: 'var(--ink-2)',
                  }}>
                    {(plan.accountName || '??').slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <div className="name">{plan.accountName}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>Brand</div>
                  </div>
                  <div className="role">Client</div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title" style={{ fontSize: 18 }}>Timeline</div></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, padding: '0 16px 16px' }}>
              {[
                { k: 'Created', v: plan.createdAt, on: !!plan.createdAt },
                { k: 'Submitted for review', v: null, on: ['needs_brand_feedback','needs_admin_revision','approved','scheduled','posted'].includes(plan.status) },
                { k: 'Approved', v: plan.approvedAt, on: !!plan.approvedAt },
                { k: 'Posted', v: plan.postedAt, on: !!plan.postedAt },
              ].map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: step.on ? 'var(--accent)' : 'var(--ink-5)',
                    boxShadow: step.on ? '0 0 0 3px var(--accent-soft)' : 'none',
                    flex: '0 0 auto',
                  }}/>
                  <div style={{ flex: 1, color: step.on ? 'var(--ink)' : 'var(--ink-3)', fontWeight: step.on ? 500 : 400 }}>
                    {step.k}
                  </div>
                  <div style={{ color: 'var(--ink-4)', fontSize: 12 }}>
                    {step.v ? new Date(step.v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div></div>
  );
};

export { PostPlanDetailView };
