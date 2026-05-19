/* eslint-disable */
/* ConversationsView — unified per-brand chat (PR 2 + polish).
   One thread per brand. Slack-style threads, optional plan-tag chip,
   image/video/file attachments, soft-deletable bubbles (right-click).
   Realtime: INSERT, UPDATE (covers soft-delete) and new attachment
   rows arriving for visible messages.

   Layout: `.conv-wrap` is the scrolling container; `.conv-head` and
   `.conv-composer-wrap` use `position: sticky` so they stay visible
   regardless of scroll. Auto-scroll to bottom on mount + after send;
   stays put if the user has scrolled up to read history (tracked via
   stuckToBottomRef). */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import { StatusPill } from './postPlanShared.jsx';
import { linkifyText } from './IdeateView.jsx';
import {
  loadConversationForAccount,
  loadConversationMessages,
  loadThreadReplies,
  loadThreadReplyCountsForMessages,
  addConversationMessage,
  subscribeToConversationMessages,
  markConversationSeen,
  softDeleteMessage,
  addMessageAttachment,
  loadPostPlans,
} from '../lib/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveFullPlanId(prefixOrId, plans) {
  if (!prefixOrId) return null;
  if (UUID_RE.test(prefixOrId)) return prefixOrId;
  const m = plans?.find?.((p) => p?.id && p.id.startsWith(prefixOrId));
  return m?.id || null;
}
function shortenId(id) {
  if (!id) return id;
  return UUID_RE.test(id) ? id.slice(0, 8) : id;
}
function formatPlanRowTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
// Humanized variant used on the inline plan chip. Reuses formatPlanRowTime
// for anything outside the today/yesterday/tomorrow window so wording stays
// consistent with the tag-picker dropdown.
function formatPlanChipTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOfDay = (x) => { const c = new Date(x); c.setHours(0,0,0,0); return c; };
  const dayDiff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Tomorrow, ${time}`;
  if (dayDiff === -1) return `Yesterday, ${time}`;
  return formatPlanRowTime(iso);
}
function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ----- Plan-chip card ------------------------------------------------
function PlanChip({ plan, brandSlug, navigate, removable, onRemove, deletedPlaceholder }) {
  // Deleted-plan tombstone: rendered when the message still references
  // a plan id but the plan no longer exists for this brand (deleted).
  if (deletedPlaceholder) {
    return (
      <div className="conv-plan-chip is-deleted" aria-label="Plan deleted">
        <Icon name="calendar" size={14} />
        <span className="conv-plan-chip-concept">Plan deleted</span>
      </div>
    );
  }
  if (!plan) return null;
  const handleClick = () => {
    if (removable || !plan?.id) return;
    const path = brandSlug ? `/c/${brandSlug}/calendar/${shortenId(plan.id)}` : `/calendar/${shortenId(plan.id)}`;
    navigate?.(path);
  };
  return (
    <div
      className={`conv-plan-chip ${removable ? 'is-removable' : 'is-clickable'}`}
      onClick={handleClick}
      role={removable ? undefined : 'button'}
      tabIndex={removable ? -1 : 0}
      onKeyDown={(e) => {
        if (removable) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
      }}
    >
      <Icon name="calendar" size={14} />
      <span className="conv-plan-chip-concept">{plan.concept || 'Untitled plan'}</span>
      {plan.scheduledAt && (
        <span className="conv-plan-chip-time">{formatPlanChipTime(plan.scheduledAt)}</span>
      )}
      <StatusPill status={plan.status} />
      {removable
        ? (
          <button
            type="button"
            className="conv-plan-chip-remove"
            aria-label="Remove plan tag"
            onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          >
            <Icon name="x" size={12} />
          </button>
        )
        : <Icon name="arrow-up-right" size={12} />
      }
    </div>
  );
}

// ----- Plan-tag dropdown --------------------------------------------
function PlanTagDropdown({ plans, onPick, onClose }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onDoc = (e) => { if (popRef.current && !popRef.current.contains(e.target)) onClose?.(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    // Latest scheduledAt first — most chatter happens about upcoming or
    // recent work, so the agency / brand sees the most relevant rows
    // at the top. Older plans push down.
    const ranked = [...(plans || [])].sort((a, b) => {
      return (b.scheduledAt || '').localeCompare(a.scheduledAt || '');
    });
    if (!ql) return ranked.slice(0, 60);
    return ranked.filter((p) => (p.concept || '').toLowerCase().includes(ql)).slice(0, 60);
  }, [plans, q]);

  return (
    <div className="conv-tag-pop" ref={popRef} role="dialog" aria-label="Tag a plan">
      <input
        ref={inputRef}
        className="conv-tag-search"
        type="text"
        placeholder="Search plans by concept…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="conv-tag-list">
        {filtered.length === 0 ? (
          <div className="conv-tag-empty">No plans match.</div>
        ) : (
          filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              className="conv-tag-item"
              onClick={() => onPick?.(p)}
            >
              <div className="conv-tag-item-meta">
                <span className="conv-tag-item-concept">{p.concept || 'Untitled plan'}</span>
                <span className="conv-tag-item-time">{formatPlanRowTime(p.scheduledAt)}</span>
              </div>
              <StatusPill status={p.status} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ----- Attachment renderer (inside a message bubble) ----------------
function AttachmentBlock({ attachment }) {
  if (!attachment) return null;
  const { kind, url, filename, sizeBytes, mimeType } = attachment;
  if (kind === 'image' && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={filename || 'image'} className="conv-attachment-image" />
      </a>
    );
  }
  if (kind === 'video' && url) {
    return <video src={url} controls preload="metadata" className="conv-attachment-video" />;
  }
  // File chip — opens in a new tab on click.
  return (
    <a className="conv-attachment-file" href={url || '#'} target="_blank" rel="noreferrer">
      <Icon name="paperclip" size={14} />
      <span className="conv-attachment-file-name">{filename || 'attachment'}</span>
      {sizeBytes != null && <span className="conv-attachment-file-meta">{formatBytes(sizeBytes)}</span>}
    </a>
  );
}

// ----- Message bubble (used in both feed + thread) -------------------
function MessageBubble({
  message,
  plan,
  replyCount,
  showReplyAffordance,
  isThreadParent,
  isActiveThread,
  brandSlug,
  navigate,
  onReplyClick,
  onContextMenu,
}) {
  if (!message) return null;
  const isDeleted = !!message.deletedAt;
  // "Plan deleted" tombstone: the message references a plan id but the
  // plan no longer exists in the brand's loaded plans (deleted). FK was
  // dropped in 0043 so the orphaned id is the only signal.
  const taggedPlanMissing = !!message.taggedPostPlanId && !plan;

  return (
    <div
      className={
        'conv-msg ' +
        (message.from === 'me' ? 'conv-msg-me' : 'conv-msg-them') +
        (isActiveThread ? ' conv-msg-active' : '')
      }
      onContextMenu={(e) => {
        if (isDeleted) return;
        onContextMenu?.(e, message);
      }}
    >
      <Avatar person={message.who} size="sm" />
      <div className="conv-msg-body">
        <div className="conv-msg-meta">
          <strong className="conv-msg-name">{message.who?.name || 'Someone'}</strong>
          <span className="conv-msg-time">{message.time}</span>
        </div>
        {isDeleted ? (
          <div className="conv-msg-tombstone">Message deleted</div>
        ) : (
          <>
            {message.body && <div className="conv-msg-text">{linkifyText(message.body)}</div>}
            {message.attachments && message.attachments.length > 0 && (
              <div className="conv-msg-attachments">
                {message.attachments.map((a) => (
                  <AttachmentBlock key={a.id} attachment={a} />
                ))}
              </div>
            )}
            {plan && (
              <PlanChip plan={plan} brandSlug={brandSlug} navigate={navigate} />
            )}
            {taggedPlanMissing && <PlanChip deletedPlaceholder />}
          </>
        )}
        {showReplyAffordance && !isThreadParent && !isDeleted && (
          <div className="conv-msg-actions">
            <button
              type="button"
              className="conv-reply-btn"
              onClick={() => onReplyClick?.(message)}
            >
              <Icon name="reply" size={12} />
              {replyCount > 0
                ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
                : 'Reply in thread'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ----- Composer ------------------------------------------------------
function Composer({
  draft,
  onDraftChange,
  taggedPlan,
  onClearTag,
  onOpenTagDropdown,
  onSubmit,
  placeholder,
  showTagAffordance,
  autoFocus,
  busy,
  pendingFiles,
  onPickFiles,
  onRemoveFile,
}) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canSend) onSubmit?.();
    }
  };

  // Auto-grow textarea up to the CSS cap (132px = ~5 lines). After
  // that the textarea scrolls internally — the composer-wrap height
  // stays bounded so it can't push itself out of the sticky viewport.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(ta.scrollHeight, 132);
    ta.style.height = next + 'px';
  }, [draft]);

  const canSend = (!!draft.trim() || (pendingFiles?.length || 0) > 0) && !busy;

  const onFileInputChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    onPickFiles?.(files);
    // Reset so picking the same file twice still triggers onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="conv-composer">
      {taggedPlan && (
        <div className="conv-composer-tag">
          <PlanChip plan={taggedPlan} removable onRemove={onClearTag} />
        </div>
      )}
      {pendingFiles && pendingFiles.length > 0 && (
        <div className="conv-composer-pending-files">
          {pendingFiles.map((f, i) => (
            <span key={i} className="conv-pending-file">
              <Icon name="paperclip" size={12} />
              <span className="conv-pending-file-name">{f.name}</span>
              <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>{formatBytes(f.size)}</span>
              <button
                type="button"
                className="conv-pending-file-remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => onRemoveFile?.(i)}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="conv-composer-row">
        <textarea
          ref={textareaRef}
          className="conv-composer-textarea"
          rows={1}
          value={draft}
          onChange={(e) => onDraftChange?.(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder || 'Type a message…'}
          disabled={busy}
        />
        <div className="conv-composer-actions">
          {/* Attach file/image/video — always available, including in
              the thread composer. Hidden native input + icon button. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={onFileInputChange}
            accept="image/*,video/*,application/pdf,application/zip,application/x-zip-compressed,text/*"
          />
          <button
            type="button"
            className="conv-composer-icon-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
            aria-label="Attach file"
            disabled={busy}
          >
            <Icon name="paperclip" size={16} />
          </button>
          {showTagAffordance && (
            <button
              type="button"
              className={'conv-composer-icon-btn' + (taggedPlan ? ' is-active' : '')}
              onClick={onOpenTagDropdown}
              title={taggedPlan ? 'Change tagged plan' : 'Tag a post plan (optional)'}
              aria-label="Tag a post plan"
              disabled={busy}
            >
              <Icon name="calendar" size={16} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary conv-composer-send"
            onClick={() => canSend && onSubmit?.()}
            disabled={!canSend}
          >
            Send
          </button>
        </div>
      </div>
      <div className="conv-composer-hint">⌘↩ to send</div>
    </div>
  );
}

// ----- Thread drawer -------------------------------------------------
function ThreadDrawer({
  parent,
  parentPlan,
  parentTaggedMissing,
  replies,
  brandSlug,
  navigate,
  draft,
  onDraftChange,
  onSubmit,
  onClose,
  busy,
  pendingFiles,
  onPickFiles,
  onRemoveFile,
  onContextMenu,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const repliesRef = useRef(null);
  useEffect(() => {
    if (!repliesRef.current) return;
    repliesRef.current.scrollTop = repliesRef.current.scrollHeight;
  }, [replies?.length]);

  return (
    <>
      <div className="conv-drawer-scrim" onClick={onClose} aria-hidden />
      <aside className="conv-drawer" role="dialog" aria-label="Thread">
        <header className="conv-drawer-head">
          <span className="conv-drawer-title">Thread</span>
          <button type="button" className="conv-drawer-close" aria-label="Close thread" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="conv-drawer-parent">
          <MessageBubble
            message={parent}
            plan={parentTaggedMissing ? null : parentPlan}
            isThreadParent
            brandSlug={brandSlug}
            navigate={navigate}
          />
          {parentTaggedMissing && <div style={{ marginLeft: 36, marginTop: -6 }}><PlanChip deletedPlaceholder /></div>}
        </div>
        <div className="conv-drawer-replies" ref={repliesRef}>
          {(!replies || replies.length === 0) ? (
            <div className="conv-drawer-empty">Be the first to reply.</div>
          ) : (
            replies.map((r) => (
              <MessageBubble
                key={r.id}
                message={r}
                brandSlug={brandSlug}
                navigate={navigate}
                onContextMenu={onContextMenu}
              />
            ))
          )}
        </div>
        <div className="conv-drawer-composer">
          <Composer
            draft={draft}
            onDraftChange={onDraftChange}
            placeholder="Reply in thread…"
            onSubmit={onSubmit}
            autoFocus
            busy={busy}
            showTagAffordance={false}
            pendingFiles={pendingFiles}
            onPickFiles={onPickFiles}
            onRemoveFile={onRemoveFile}
          />
        </div>
      </aside>
    </>
  );
}

// ----- Right-click context menu --------------------------------------
function ContextMenu({ x, y, onDelete, onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  // Clamp to viewport so the menu never opens half off-screen on the
  // bottom row of messages.
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 80);
  return (
    <div
      ref={menuRef}
      className="conv-context-menu"
      style={{ left, top }}
      role="menu"
    >
      <button
        type="button"
        className="conv-context-item is-danger"
        onClick={() => { onDelete?.(); onClose?.(); }}
      >
        <Icon name="trash" size={13} />
        Delete message
      </button>
    </div>
  );
}

// ===================================================================
// Main view
// ===================================================================

export default function ConversationsView({ accountId, accountName, userId, brandSlug, isAgency }) {
  const navigate = useNavigate();
  const location = useLocation();

  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [replyCounts, setReplyCounts] = useState(() => new Map());
  const [plans, setPlans] = useState([]);
  const [draft, setDraft] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [taggedPlanId, setTaggedPlanId] = useState(null);
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  const [threadParentId, setThreadParentId] = useState(null);
  const [threadReplies, setThreadReplies] = useState([]);
  const [threadDraft, setThreadDraft] = useState('');
  const [threadPendingFiles, setThreadPendingFiles] = useState([]);
  const [threadSending, setThreadSending] = useState(false);

  // Right-click context menu on own messages.
  const [contextMenu, setContextMenu] = useState(null); // { x, y, messageId }

  const wrapRef = useRef(null);
  const stuckToBottomRef = useRef(true);
  const seenForAccountRef = useRef(null);

  const plansById = useMemo(() => {
    const m = new Map();
    for (const p of plans) m.set(p.id, p);
    return m;
  }, [plans]);

  const taggedPlan = taggedPlanId ? plansById.get(taggedPlanId) || null : null;

  // ----- Mount -----
  useEffect(() => {
    if (!accountId || !userId) return;
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setReplyCounts(new Map());

    (async () => {
      try {
        const conv = await loadConversationForAccount(accountId);
        if (cancelled) return;
        setConversation(conv);
        if (!conv) { setLoading(false); return; }
        const [msgs, brandPlans] = await Promise.all([
          loadConversationMessages(conv.id, userId),
          loadPostPlans({ accountId }),
        ]);
        if (cancelled) return;
        setMessages(msgs);
        setPlans(brandPlans);
        const ids = msgs.map((m) => m.id);
        if (ids.length > 0) {
          loadThreadReplyCountsForMessages(ids)
            .then((c) => { if (!cancelled) setReplyCounts(c); })
            .catch((e) => console.warn('loadThreadReplyCountsForMessages failed', e));
        }
        setLoading(false);
        if (seenForAccountRef.current !== accountId) {
          seenForAccountRef.current = accountId;
          markConversationSeen({ userId, accountId }).catch((e) =>
            console.warn('markConversationSeen failed', e)
          );
        }
      } catch (e) {
        console.warn('ConversationsView load failed', e);
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, userId]);

  // ----- Realtime -----
  useEffect(() => {
    if (!conversation?.id || !userId) return;
    const unsub = subscribeToConversationMessages(conversation.id, userId, (evt) => {
      if (!evt) return;
      if (evt.type === 'INSERT' && evt.message) {
        const m = evt.message;
        if (m.parentMessageId) {
          setReplyCounts((prev) => {
            const next = new Map(prev);
            next.set(m.parentMessageId, (next.get(m.parentMessageId) || 0) + 1);
            return next;
          });
          setThreadParentId((openId) => {
            if (openId === m.parentMessageId) {
              setThreadReplies((prev) => prev.some((r) => r.id === m.id) ? prev : [...prev, m]);
            }
            return openId;
          });
        } else {
          setMessages((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m]);
        }
        markConversationSeen({ userId, accountId }).catch(() => {});
        return;
      }
      if (evt.type === 'UPDATE' && evt.message) {
        // Covers soft-deletes (deleted_at flip) and future edited_at
        // changes. Replace in place across both panes.
        const m = evt.message;
        setMessages((prev) => prev.map((x) => x.id === m.id ? m : x));
        setThreadReplies((prev) => prev.map((x) => x.id === m.id ? m : x));
        return;
      }
      if (evt.type === 'ATTACHMENT_INSERT' && evt.attachment) {
        const a = evt.attachment;
        const mergeAtt = (msg) => {
          if (msg.id !== a.messageId) return msg;
          if ((msg.attachments || []).some((x) => x.id === a.id)) return msg;
          return { ...msg, attachments: [...(msg.attachments || []), a] };
        };
        setMessages((prev) => prev.map(mergeAtt));
        setThreadReplies((prev) => prev.map(mergeAtt));
        return;
      }
    });
    return unsub;
  }, [conversation?.id, userId, accountId]);

  // ----- Deep-link: ?plan=<id|prefix> -----
  useEffect(() => {
    if (plans.length === 0) return;
    const params = new URLSearchParams(location.search);
    const raw = params.get('plan');
    if (!raw) return;
    const full = resolveFullPlanId(raw, plans);
    if (full) setTaggedPlanId(full);
  }, [location.search, plans]);

  // ----- Scroll behavior -----
  useEffect(() => {
    if (!wrapRef.current) return;
    if (stuckToBottomRef.current) {
      wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
    }
  }, [messages.length, loading]);

  const onWrapScroll = useCallback((e) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckToBottomRef.current = distance < 80;
  }, []);

  // ----- Threads -----
  const openThread = useCallback(async (parent) => {
    if (!parent?.id) return;
    setThreadParentId(parent.id);
    setThreadReplies([]);
    setThreadDraft('');
    setThreadPendingFiles([]);
    try {
      const replies = await loadThreadReplies(parent.id, userId);
      setThreadReplies(replies);
    } catch (e) {
      console.warn('loadThreadReplies failed', e);
    }
  }, [userId]);

  const closeThread = useCallback(() => {
    setThreadParentId(null);
    setThreadReplies([]);
    setThreadDraft('');
    setThreadPendingFiles([]);
  }, []);

  const threadParent = useMemo(() => {
    if (!threadParentId) return null;
    return messages.find((m) => m.id === threadParentId) || null;
  }, [threadParentId, messages]);
  const threadParentPlan = threadParent?.taggedPostPlanId
    ? plansById.get(threadParent.taggedPostPlanId) || null
    : null;
  const threadParentTaggedMissing = !!threadParent?.taggedPostPlanId && !threadParentPlan;

  // ----- Send -----
  // Uploads happen AFTER message insert so the messageId is known and
  // the storage path can include it. Send is gated busy until both
  // the message AND every file finishes.
  const sendTopLevel = useCallback(async () => {
    const body = draft.trim();
    if ((!body && pendingFiles.length === 0) || !conversation?.id || !userId || sending) return;
    setSending(true);
    try {
      const inserted = await addConversationMessage({
        conversationId: conversation.id,
        authorId: userId,
        body: body || '',
        taggedPostPlanId: taggedPlanId || null,
      });
      setMessages((prev) => prev.some((x) => x.id === inserted.id) ? prev : [...prev, inserted]);
      stuckToBottomRef.current = true;
      // Optimistic clears so the composer feels snappy.
      setDraft('');
      setPendingFiles([]);
      setTaggedPlanId(null);
      if (pendingFiles.length > 0) {
        for (const f of pendingFiles) {
          try {
            const att = await addMessageAttachment({
              accountId, messageId: inserted.id, file: f, uploaderId: userId,
            });
            setMessages((prev) => prev.map((m) =>
              m.id === inserted.id
                ? { ...m, attachments: [...(m.attachments || []), att] }
                : m
            ));
          } catch (e) {
            console.error('attachment upload failed', e);
          }
        }
      }
    } catch (e) {
      console.error('send failed', e);
    } finally {
      setSending(false);
    }
  }, [draft, pendingFiles, conversation?.id, userId, taggedPlanId, sending, accountId]);

  const sendReply = useCallback(async () => {
    const body = threadDraft.trim();
    if ((!body && threadPendingFiles.length === 0) || !conversation?.id || !userId || !threadParentId || threadSending) return;
    setThreadSending(true);
    try {
      const inserted = await addConversationMessage({
        conversationId: conversation.id,
        authorId: userId,
        body: body || '',
        parentMessageId: threadParentId,
      });
      setThreadReplies((prev) => prev.some((x) => x.id === inserted.id) ? prev : [...prev, inserted]);
      setReplyCounts((prev) => {
        const next = new Map(prev);
        next.set(threadParentId, (next.get(threadParentId) || 0) + 1);
        return next;
      });
      setThreadDraft('');
      const files = threadPendingFiles;
      setThreadPendingFiles([]);
      for (const f of files) {
        try {
          const att = await addMessageAttachment({
            accountId, messageId: inserted.id, file: f, uploaderId: userId,
          });
          setThreadReplies((prev) => prev.map((m) =>
            m.id === inserted.id
              ? { ...m, attachments: [...(m.attachments || []), att] }
              : m
          ));
        } catch (e) {
          console.error('thread attachment upload failed', e);
        }
      }
    } catch (e) {
      console.error('reply send failed', e);
    } finally {
      setThreadSending(false);
    }
  }, [threadDraft, threadPendingFiles, conversation?.id, userId, threadParentId, threadSending, accountId]);

  const onPickPlan = useCallback((p) => {
    setTaggedPlanId(p.id);
    setTagDropdownOpen(false);
  }, []);

  // ----- Context menu (right-click on own message) -----
  const handleMessageContextMenu = useCallback((e, message) => {
    if (!message || message.authorId !== userId) return;  // own messages only for v1
    if (message.deletedAt) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, messageId: message.id });
  }, [userId]);

  const handleDeleteMessage = useCallback(async () => {
    const id = contextMenu?.messageId;
    if (!id) return;
    // Optimistic flip — realtime UPDATE will confirm.
    const stamp = new Date().toISOString();
    setMessages((prev) => prev.map((m) =>
      m.id === id ? { ...m, deletedAt: stamp, body: '' } : m
    ));
    setThreadReplies((prev) => prev.map((m) =>
      m.id === id ? { ...m, deletedAt: stamp, body: '' } : m
    ));
    try {
      await softDeleteMessage(id);
    } catch (e) {
      console.error('softDeleteMessage failed', e);
    }
  }, [contextMenu?.messageId]);

  // ----- Render -----
  const composerPlaceholder = isAgency
    ? `Message ${accountName || 'the brand'}…`
    : 'Message your agency…';

  return (
    <div className="conv-wrap" ref={wrapRef} onScroll={onWrapScroll}>
      <header className="conv-head">
        <div>
          <div className="conv-title">Conversations</div>
          <div className="conv-sub">
            Chat with your {isAgency ? <strong>{accountName || 'brand'}</strong> : <strong>agency</strong>}.
            Tag a post plan if you want context, attach files, or just say hi.
          </div>
        </div>
      </header>

      <div className="conv-feed">
        {loading ? (
          <div className="conv-feed-empty">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div className="conv-feed-empty">
            No messages yet. {isAgency ? 'Say hi — the brand will see it here.' : 'Send a note to get the conversation started.'}
          </div>
        ) : (
          messages.map((m) => {
            const plan = m.taggedPostPlanId ? plansById.get(m.taggedPostPlanId) || null : null;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                plan={plan}
                replyCount={replyCounts.get(m.id) || 0}
                showReplyAffordance
                isActiveThread={threadParentId === m.id}
                brandSlug={brandSlug}
                navigate={navigate}
                onReplyClick={openThread}
                onContextMenu={handleMessageContextMenu}
              />
            );
          })
        )}
      </div>

      <div className="conv-composer-wrap">
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          taggedPlan={taggedPlan}
          onClearTag={() => setTaggedPlanId(null)}
          onOpenTagDropdown={() => setTagDropdownOpen((v) => !v)}
          onSubmit={sendTopLevel}
          placeholder={composerPlaceholder}
          showTagAffordance
          busy={sending}
          pendingFiles={pendingFiles}
          onPickFiles={(files) => setPendingFiles((prev) => [...prev, ...files])}
          onRemoveFile={(i) => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
        />
        {tagDropdownOpen && (
          <PlanTagDropdown
            plans={plans}
            onPick={onPickPlan}
            onClose={() => setTagDropdownOpen(false)}
          />
        )}
      </div>

      {threadParentId && threadParent && (
        <ThreadDrawer
          parent={threadParent}
          parentPlan={threadParentPlan}
          parentTaggedMissing={threadParentTaggedMissing}
          replies={threadReplies}
          brandSlug={brandSlug}
          navigate={navigate}
          draft={threadDraft}
          onDraftChange={setThreadDraft}
          onSubmit={sendReply}
          onClose={closeThread}
          busy={threadSending}
          pendingFiles={threadPendingFiles}
          onPickFiles={(files) => setThreadPendingFiles((prev) => [...prev, ...files])}
          onRemoveFile={(i) => setThreadPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
          onContextMenu={handleMessageContextMenu}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onDelete={handleDeleteMessage}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
