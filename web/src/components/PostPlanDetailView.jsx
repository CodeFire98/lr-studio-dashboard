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
  getDisplayStatus,
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
  loadPostPlanStatusLog,
  duplicatePostPlan,
  loadPostPlanPublications,
  upsertPostPlanPublication,
  deletePostPlanPublication,
  subscribeToPostPlanPublications,
} from '../lib/db.js';
import { DuplicateDatePicker } from './DuplicateDatePicker.jsx';
import { MarkAsPostedModal } from './MarkAsPostedModal.jsx';
import { confirm as confirmDialog } from './ConfirmDialog.jsx';
import { useLightbox } from './Lightbox.jsx';

// =====================================================================
// Linkify helpers — turn http(s) URLs in copy text into clickable
// anchors that open in a new tab. Used by the linkified preview block
// under the copy editor. Kept module-local so the regex is allocated
// once per render path (no `g`-flag lastIndex traps).
// =====================================================================
const URL_PATTERN = 'https?:\\/\\/[^\\s<>()"\']+';
function hasUrl(text) {
  if (!text) return false;
  return new RegExp(URL_PATTERN).test(text);
}
function linkifySegments(text) {
  if (!text) return null;
  const splitRe = new RegExp(`(${URL_PATTERN})`, 'g');
  const matchRe = new RegExp(`^${URL_PATTERN}$`);
  return text.split(splitRe).map((part, i) => (
    matchRe.test(part)
      ? (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent-ink)', textDecoration: 'underline', wordBreak: 'break-all' }}
        >
          {part}
        </a>
      )
      : <React.Fragment key={i}>{part}</React.Fragment>
  ));
}

// Status transition → human verb. Used in the activity feed to render
// "Brand approved", "Agency submitted for review" etc. in past tense.
// New 3-status workflow first; legacy values kept for historical log
// rendering — anything in `post_plan_status_log` from before migration
// 0035 still uses the old enum keys.
const STATUS_VERB = {
  drafting:             'sent this plan back to draft',
  needs_review:         'submitted this plan for review',
  approved:             'approved this plan',
  // Legacy — only renders for pre-migration log rows.
  not_started:          'reset this plan to not started',
  wip:                  'moved this plan to in progress',
  needs_brand_feedback: 'submitted this plan for review',
  needs_admin_revision: 'requested changes',
  scheduled:            'scheduled this plan',
  posted:               'marked this plan as posted',
  delayed:              'marked this plan as delayed',
};

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

const AttachmentTile = ({ att, canDelete, onDelete, onLightboxDelete }) => {
  const showImage = isImageMime(att.mimeType) && att.url;
  const lightbox = useLightbox();
  const openInLightbox = () => {
    if (!att.url) return;
    lightbox.open({
      src: att.url,
      mimeType: att.mimeType,
      name: att.filename,
      alt: att.filename,
      downloadUrl: att.url,
      // Agency-only delete from the preview. The Lightbox shows its own
      // confirm modal; the callback should do the bare delete + parent
      // state update without re-prompting.
      onDelete: onLightboxDelete ? () => onLightboxDelete(att) : undefined,
    });
  };
  // Tile-level delete (the small × badge on the thumbnail). Other
  // surfaces (TaskDetailView, BrandKitView ReferencesCard) already
  // confirm at the tile level; PostPlan was the inconsistent one and
  // would delete on a single accidental click. Now matches the
  // lightbox path's safety.
  const handleTileDelete = async () => {
    const ok = await confirmDialog({
      title: att.filename ? `Delete ${att.filename}?` : 'Delete this file?',
      body: 'This permanently removes the file. This action cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    onDelete(att);
  };
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
      <button
        type="button"
        onClick={openInLightbox}
        title={`Preview ${att.filename}`}
        style={{
          display: 'block',
          height: 110,
          background: 'var(--surface-2)',
          color: 'inherit',
          padding: 0,
          border: 0,
          cursor: 'pointer',
          width: '100%',
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
      </button>
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          type="button"
          onClick={openInLightbox}
          title={`Preview ${att.filename}`}
          style={{
            fontSize: 12,
            color: 'var(--ink-1)',
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'left',
            font: 'inherit',
          }}
        >
          {att.filename}
        </button>
        <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>
          {att.uploader?.name || 'Someone'} · {formatBytes(att.sizeBytes)}
        </div>
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={handleTileDelete}
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
  // Agency-only: enables a Delete button in the preview lightbox for
  // every attachment in this card, regardless of who uploaded it.
  // Brand viewers don't see it (the prop is undefined for them).
  isAgency = false,
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
                onLightboxDelete={isAgency ? (att) => onUpload([], att) : undefined}
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
  // detail view picks up the change without a manual refetch — but only
  // if fromList is at least as fresh as our local plan. Without this
  // updatedAt guard, a stale postPlans cache (e.g. App's list loaded
  // hours ago, realtime missed an out-of-band status change) would clobber
  // the fresh row we just got from loadPostPlanById.
  useEffect(() => {
    if (!fromList) return;
    setPlan((prev) => {
      if (!prev) return fromList;
      const a = prev.updatedAt ? new Date(prev.updatedAt).getTime() : 0;
      const b = fromList.updatedAt ? new Date(fromList.updatedAt).getTime() : 0;
      return b >= a ? fromList : prev;
    });
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
  // Per-platform draft state, controlled. Diverges from `copyVariants` only
  // while the user has unsaved typing — drives the Save button + dirty
  // indicator. Synced when a different plan is loaded; intentionally not
  // synced on plan.updatedAt of the same plan, so realtime updates from
  // other clients don't clobber in-flight typing.
  const [copyDrafts, setCopyDrafts] = useState(() => plan?.copyVariants || {});
  // Per-platform editor mode. 'edit' shows the textarea + Save row; 'read'
  // shows the saved copy with URLs linkified inline (the email-composer
  // read state). Default for empty saved values is 'edit' so an admin can
  // immediately start typing; once there's saved content we default to
  // 'read' so the linkified view shows by default. Brand users are always
  // forced into 'read' mode regardless of what's in this map.
  const [copyMode, setCopyMode] = useState({});
  const [activeCopyTab, setActiveCopyTab] = useState((plan?.platforms || [])[0] || null);
  const [status, setStatus] = useState(plan?.status || 'drafting');
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

  // Reset copy drafts only when a DIFFERENT plan is loaded — switching
  // plans should bring in that plan's copy, but realtime updates of the
  // current plan should not blow away the user's in-progress typing.
  useEffect(() => {
    if (plan) setCopyDrafts(plan.copyVariants || {});
  }, [plan?.id]);

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

  // ---- Status log (drives status entries in the Activity feed) ----
  const [statusLog, setStatusLog] = useState([]);
  useEffect(() => {
    if (!postPlanId) return;
    let cancelled = false;
    loadPostPlanStatusLog(postPlanId)
      .then((rows) => { if (!cancelled) setStatusLog(rows); })
      .catch((e) => console.warn('loadPostPlanStatusLog failed', e));
    return () => { cancelled = true; };
    // Refetch when the plan's updated_at advances — covers our own
    // status changes AND realtime-relayed changes from another tab/user.
  }, [postPlanId, plan?.updatedAt]);

  // ---- Publications (the "Posted" terminal state) ----
  // A plan is shown as Posted when it's approved AND has at least one
  // publication row. The publications themselves carry the live URLs
  // surfaced by the brand-wide Live Posts repository.
  const [publications, setPublications] = useState([]);
  const [postedModalOpen, setPostedModalOpen] = useState(false);
  useEffect(() => {
    if (!postPlanId) return;
    let cancelled = false;
    loadPostPlanPublications(postPlanId)
      .then((rows) => { if (!cancelled) setPublications(rows); })
      .catch((e) => console.warn('loadPostPlanPublications failed', e));
    const unsub = subscribeToPostPlanPublications(postPlanId, (evt) => {
      if (evt.type === 'DELETE') {
        setPublications((prev) => prev.filter((p) => p.id !== evt.id));
      } else if (evt.publication) {
        setPublications((prev) => {
          const idx = prev.findIndex((p) => p.id === evt.publication.id);
          if (idx === -1) return [evt.publication, ...prev];
          const next = [...prev];
          next[idx] = evt.publication;
          return next;
        });
      }
    });
    return () => { cancelled = true; unsub?.(); };
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

  const handleCopyChange = (key, val) => {
    setCopyDrafts((prev) => ({ ...prev, [key]: val }));
  };

  const saveCopyForKey = async (key) => {
    const val = copyDrafts[key] ?? '';
    if (((plan?.copyVariants || {})[key] ?? '') === val) return; // already saved
    const next = { ...copyVariants, [key]: val };
    setCopyVariants(next);
    await persist({ copyVariants: next });
  };

  // Auto-save fallback when the textarea loses focus — preserves the
  // existing on-blur-persist behaviour so users who don't click Save
  // still get their text saved.
  const handleCopyBlur = (key) => {
    saveCopyForKey(key);
  };

  // Whether the active platform's editor is in 'edit' (textarea) mode for
  // the current viewer. Brand is always 'read'. Agency defaults to 'edit'
  // when there's no saved copy yet, otherwise 'read' (so links render).
  const isCopyEditing = (key) => {
    if (!isAdmin || !key) return false;
    if (copyMode[key]) return copyMode[key] === 'edit';
    const saved = (plan?.copyVariants || {})[key] ?? '';
    return !saved.trim(); // empty → start in edit mode
  };

  const enterEditMode = (key) => {
    if (!isAdmin) return;
    setCopyMode((p) => ({ ...p, [key]: 'edit' }));
  };

  const exitEditMode = (key) => {
    setCopyMode((p) => ({ ...p, [key]: 'read' }));
  };

  const cancelCopyEdit = (key) => {
    // Discard in-flight typing and bounce back to the read view.
    setCopyDrafts((prev) => ({
      ...prev,
      [key]: (plan?.copyVariants || {})[key] ?? '',
    }));
    exitEditMode(key);
  };

  // Single-click "done editing" path. We flip the mode to 'read' SYNCHRONOUSLY
  // (before awaiting persist) so the textarea unmounts and the linkified read
  // view renders on the very next render. The actual save runs in the
  // background — saveCopyForKey early-returns if there's nothing to save, so
  // calling it unconditionally is fine. This avoids a flash where the save
  // completes but the view is still in edit mode (which made it look like a
  // two-step "Save copy → Done" interaction).
  const finishCopyEdit = (key) => {
    exitEditMode(key);
    saveCopyForKey(key);
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
    const conceptLabel = (plan.concept || '').trim();
    const ok = await confirmDialog({
      title: conceptLabel ? `Delete “${conceptLabel}”?` : 'Delete this post plan?',
      body: 'This can’t be undone — the plan, its conversation, and uploaded files will all be removed.',
      confirmText: 'Delete plan',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePostPlan(plan.id);
      onPlanDeleted?.(plan.id);
      setRoute({ view: 'calendar' });
    } catch (e) {
      console.error('delete failed', e);
    }
  };

  // ---- Duplicate flow -------------------------------------------------
  const [dupPickerOpen, setDupPickerOpen] = useState(false);

  const handleDuplicateConfirm = async (dates) => {
    setDupPickerOpen(false);
    if (!dates.length || !plan) return;
    try {
      const { created, errors } = await duplicatePostPlan({
        sourcePlan: plan,
        targetDates: dates,
        userId,
      });
      // Optimistically push all created plans into App state.
      for (const p of created) {
        onPlanChanged?.(p);
      }
      if (errors.length > 0 && created.length > 0) {
        alert(`Created ${created.length} of ${dates.length} plans. ${errors.length} failed.`);
      } else if (errors.length > 0) {
        alert(`Duplication failed: ${errors[0]?.message || errors[0]}`);
        return;
      }
      // Navigate to the earliest-dated created plan.
      if (created.length > 0) {
        const earliest = created.reduce((a, b) =>
          (a.scheduledAt || '') < (b.scheduledAt || '') ? a : b
        );
        setRoute({ view: 'plan', id: earliest.id });
      }
    } catch (e) {
      console.error('duplicate failed', e);
      alert(`Duplication failed: ${e?.message || e}`);
    }
  };

  // ---- Mark-as-posted submit ------------------------------------------
  // The modal hands us batched upserts + deletes; we apply them serially
  // (per-platform) and update local state optimistically. Bumping the
  // plan's updatedAt via a no-op persist is intentional — it nudges the
  // status log + viewer "last seen" stamping on save without writing
  // anything new to the post_plans row itself.
  const handleMarkPostedSubmit = async ({ upserts, deletes }) => {
    if (!plan?.id || !userId) return;
    const created = [];
    for (const u of upserts) {
      const row = await upsertPostPlanPublication({
        postPlanId: plan.id,
        platform: u.platform,
        liveUrl: u.liveUrl,
        publishedBy: userId,
      });
      created.push(row);
    }
    for (const id of deletes) {
      await deletePostPlanPublication(id);
    }
    setPublications((prev) => {
      const byKey = new Map(prev.map((p) => [p.id, p]));
      for (const id of deletes) byKey.delete(id);
      for (const r of created) byKey.set(r.id, r);
      return Array.from(byKey.values()).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    });
    markPostPlanSeen(plan.id, userId);
    onPlanSeen?.(plan.id);
    setPostedModalOpen(false);
  };

  // ---- Activity feed (synthesized) ------------------------------------
  // No dedicated activity table — we synthesize the timeline from the
  // events we store across post_plans, post_plan_comments,
  // post_plan_attachments, post_plan_status_log, and
  // post_plan_publications. Hook stays above the null-plan early-return
  // so React sees the same hook count on every render (Rules of Hooks).
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
    for (const s of statusLog) {
      const verb = STATUS_VERB[s.toStatus] || `set status to ${s.toStatus}`;
      items.push({
        id: `status_${s.id}`, kind: 'status',
        actor: s.actor,
        time: s.createdAt,
        label: `${s.actor?.name || 'Someone'} ${verb}`,
      });
    }
    for (const p of publications) {
      const platLabel = PLATFORM_BY_KEY[p.platform]?.label || p.platform;
      items.push({
        id: `pub_${p.id}`, kind: 'posted',
        actor: p.publisher,
        time: p.publishedAt || p.createdAt,
        label: `${p.publisher?.name || 'Someone'} marked posted on ${platLabel}`,
        body: p.liveUrl || null,
      });
    }
    return items.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  }, [plan?.createdAt, plan?.creator, comments, attachments, statusLog, publications]);

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
  //
  // Three-state workflow (post-migration 0035):
  //   * Drafting       → agency clicks "Submit for review" → Needs review
  //   * Needs review   → brand clicks "Approve"            → Approved
  //   * Approved       → agency clicks "Back to draft"     → Drafting
  //
  // The brand never has a "Request changes" button — they leave a
  // comment instead and the row stays at Needs review until they're
  // satisfied and click Approve. Legacy enum values from before the
  // migration are normalised into the same three buckets so a row that
  // hasn't yet flowed through the migration still lights up the right
  // CTA.
  const statusBucket = (() => {
    if (status === 'approved' || status === 'scheduled' || status === 'posted') return 'approved';
    if (status === 'needs_review' || status === 'needs_brand_feedback' || status === 'needs_admin_revision') return 'needs_review';
    return 'drafting';
  })();

  const statusActions = (() => {
    const out = [];
    if (isAdmin) {
      if (statusBucket === 'drafting') {
        out.push({ label: 'Submit for review', tone: 'primary', next: 'needs_review' });
      } else if (statusBucket === 'approved') {
        out.push({ label: 'Back to draft', tone: 'ghost', next: 'drafting' });
      }
    } else if (statusBucket === 'needs_review') {
      out.push({ label: 'Approve', tone: 'good', next: 'approved' });
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
            <StatusPill status={getDisplayStatus({ status }, publications)} size="lg"/>
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
          {/* Mark-as-posted CTA — available to agency AND brand once
              the plan is approved. Both can mark posted (per workflow
              decision: agency often handles the actual posting via
              scheduling tools). Button label flips to Edit live posts
              once at least one publication row exists. */}
          {statusBucket === 'approved' && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPostedModalOpen(true)}
              title={publications.length > 0
                ? 'Edit which platforms this is live on and the live-post URLs'
                : 'Mark as posted and (optionally) add live-post URLs'}
              style={
                publications.length === 0
                  ? { background: '#7C5CFF', borderColor: '#7C5CFF', color: '#fff' }
                  : undefined
              }
            >
              <Icon name="send" size={13}/>
              {publications.length > 0 ? 'Edit live posts' : 'Mark as posted'}
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDupPickerOpen(true)}
              title="Duplicate this post plan to other dates"
            >
              <Icon name="calendar" size={13}/>Duplicate
            </button>
          )}
          {isAdmin && (
            <select
              className="btn btn-sm"
              value={statusBucket}
              onChange={(e) => { setStatus(e.target.value); persist({ status: e.target.value }); }}
              disabled={saving}
              style={{ appearance: 'none', paddingRight: 28 }}
              title="Override status"
            >
              <option value="drafting">Set: Drafting</option>
              <option value="needs_review">Set: Needs review</option>
              <option value="approved">Set: Approved</option>
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
                    {(() => {
                      const draft = copyDrafts[activeCopyTab] ?? '';
                      const saved = (plan?.copyVariants || {})[activeCopyTab] ?? '';
                      const isDirty = draft !== saved;
                      const editing = isCopyEditing(activeCopyTab);
                      const platLabel = PLATFORM_BY_KEY[activeCopyTab]?.label || '';

                      // EDIT mode — textarea + Save row. Default for agency
                      // when starting fresh; re-entered when the agency
                      // clicks the read view.
                      if (editing) {
                        return (
                          <>
                            <textarea
                              rows={6}
                              value={draft}
                              onChange={(e) => handleCopyChange(activeCopyTab, e.target.value)}
                              onBlur={() => handleCopyBlur(activeCopyTab)}
                              placeholder={`Write the ${platLabel} version of this post…`}
                              disabled={!isAdmin || saving}
                              autoFocus={!!saved}
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
                                lineHeight: 1.5,
                              }}
                            />
                            {isAdmin && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                <span style={{ fontSize: 11.5, color: isDirty ? 'var(--accent-ink)' : 'var(--ink-4)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  {saving && isDirty
                                    ? 'Saving…'
                                    : isDirty
                                      ? 'Unsaved changes'
                                      : (<><Icon name="check" size={11}/>Saved</>)}
                                </span>
                                <span style={{ flex: 1 }}/>
                                {isDirty && saved && (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    onClick={() => cancelCopyEdit(activeCopyTab)}
                                    disabled={saving}
                                  >
                                    Cancel
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  onClick={() => finishCopyEdit(activeCopyTab)}
                                  title="Save and exit edit mode — URLs become inline clickable links"
                                >
                                  Done
                                </button>
                              </div>
                            )}
                          </>
                        );
                      }

                      // READ mode — linkified rendering of the SAVED copy,
                      // visually styled to match the textarea slot so the
                      // swap is seamless. Click anywhere not-on-a-link to
                      // re-enter edit mode (agency only).
                      return (
                        <div
                          role={isAdmin ? 'button' : undefined}
                          tabIndex={isAdmin ? 0 : undefined}
                          onClick={
                            isAdmin
                              ? (e) => {
                                  // Don't intercept clicks on links — let the
                                  // browser open them in a new tab as the
                                  // anchor's target=_blank intends.
                                  if (e.target.closest && e.target.closest('a')) return;
                                  enterEditMode(activeCopyTab);
                                }
                              : undefined
                          }
                          onKeyDown={
                            isAdmin
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    enterEditMode(activeCopyTab);
                                  }
                                }
                              : undefined
                          }
                          style={{
                            width: '100%',
                            padding: '10px 12px',
                            border: '1px solid var(--line)',
                            borderRadius: 6,
                            background: 'var(--surface)',
                            color: 'var(--ink-1)',
                            fontSize: 13,
                            minHeight: 130,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            lineHeight: 1.5,
                            cursor: isAdmin ? 'text' : 'default',
                            position: 'relative',
                          }}
                          title={isAdmin ? 'Click to edit' : undefined}
                        >
                          {saved
                            ? linkifySegments(saved)
                            : (
                              <span style={{ color: 'var(--ink-4)' }}>
                                {isAdmin
                                  ? `Click to write the ${platLabel} copy…`
                                  : `No ${platLabel} copy yet.`}
                              </span>
                            )}
                          {isAdmin && saved && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); enterEditMode(activeCopyTab); }}
                              title="Edit copy"
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '3px 8px',
                                borderRadius: 999,
                                border: '1px solid var(--line)',
                                background: 'var(--surface-2)',
                                color: 'var(--ink-3)',
                                fontSize: 11,
                                cursor: 'pointer',
                              }}
                            >
                              <Icon name="edit" size={11}/>Edit
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* References — inspiration files. Both sides can upload now;
                   brand drops in their reference imagery, agency can add
                   competitor refs / mood boards / context as needed. */}
              <AttachmentsCard
                title="References"
                subtitle={isAdmin
                  ? 'Inspiration for this post — shared by the brand and anything you want to add for context.'
                  : 'Drop in inspiration images for what you want this post to feel like.'}
                emptyText={isAdmin
                  ? 'No references yet — upload inspiration, competitor refs, or any context that helps.'
                  : 'No references yet — upload images, screenshots, or examples.'}
                items={referenceAttachments}
                canUpload={true}
                uploading={uploadingKind === 'reference'}
                currentUserId={userId}
                onUpload={(files, toDelete) => handleAttachmentChange('reference', files, toDelete)}
                isAgency={isAdmin}
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
                isAgency={isAdmin}
              />

              {/* Live posts — populated once anyone clicks "Mark as
                  posted". Each row is a (platform, URL?) tuple. Hidden
                  entirely when there are no publications AND the plan
                  isn't approved yet, so it doesn't loiter on early-stage
                  plans. */}
              {(publications.length > 0 || statusBucket === 'approved') && (
                <div className="card">
                  <div className="card-head">
                    <div>
                      <div className="card-title">Live posts</div>
                      <div className="card-sub">
                        {publications.length === 0
                          ? 'Mark this plan as posted once it goes live, and drop in the URL for the live-posts repository.'
                          : 'Where this post is live. URLs feed the brand-wide Live Posts dashboard.'}
                      </div>
                    </div>
                    {statusBucket === 'approved' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setPostedModalOpen(true)}
                      >
                        <Icon name="send" size={13}/>
                        {publications.length > 0 ? 'Edit' : 'Mark as posted'}
                      </button>
                    )}
                  </div>
                  <div style={{ padding: '0 16px 16px' }}>
                    {publications.length === 0 ? (
                      <div className="empty" style={{ padding: 20, color: 'var(--ink-4)', fontSize: 13 }}>
                        Nothing posted yet.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {publications.map((p) => {
                          const cfg = PLATFORM_BY_KEY[p.platform];
                          return (
                            <div
                              key={p.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '10px 12px',
                                border: '1px solid var(--line)',
                                borderRadius: 8,
                                background: 'var(--surface)',
                              }}
                            >
                              <PlatformChip platform={p.platform} size="md"/>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, color: 'var(--ink-1)', fontWeight: 500 }}>
                                  {cfg?.label || p.platform}
                                </div>
                                {p.liveUrl ? (
                                  <a
                                    href={p.liveUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      fontSize: 12,
                                      color: 'var(--accent-ink)',
                                      textDecoration: 'underline',
                                      wordBreak: 'break-all',
                                    }}
                                  >
                                    {p.liveUrl}
                                  </a>
                                ) : (
                                  <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>
                                    No URL added
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>
                                {p.publisher?.name || 'Someone'} ·{' '}
                                {p.publishedAt ? new Date(p.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

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
              {(() => {
                // The Posted step lights up off the publications list
                // (the source of truth for "is this live") and the
                // earliest publishedAt becomes the step's timestamp —
                // so when a plan goes live on IG first and LinkedIn a
                // day later, the timeline shows the IG moment.
                const earliestPub = publications.reduce((earliest, p) => {
                  if (!p.publishedAt) return earliest;
                  if (!earliest || p.publishedAt < earliest) return p.publishedAt;
                  return earliest;
                }, null);
                return [
                  { k: 'Created', v: plan.createdAt, on: !!plan.createdAt },
                  { k: 'Submitted for review', v: null, on: ['needs_review','needs_brand_feedback','needs_admin_revision','approved','scheduled','posted'].includes(plan.status) },
                  { k: 'Approved', v: plan.approvedAt, on: !!plan.approvedAt },
                  { k: 'Posted', v: earliestPub, on: publications.length > 0 },
                ];
              })().map((step, i) => (
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

      <DuplicateDatePicker
        open={dupPickerOpen}
        onConfirm={handleDuplicateConfirm}
        onCancel={() => setDupPickerOpen(false)}
        sourcePlan={plan}
      />

      <MarkAsPostedModal
        open={postedModalOpen}
        plan={plan}
        publications={publications}
        onSubmit={handleMarkPostedSubmit}
        onCancel={() => setPostedModalOpen(false)}
      />
    </div></div>
  );
};

export { PostPlanDetailView };
