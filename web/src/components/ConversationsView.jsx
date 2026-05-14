/* eslint-disable */
/* ConversationsView — unified per-brand chat (PR 2).
   One thread per brand: brand sees their chat with the agency, agency
   sees the same chat scoped via BrandPicker. Optional plan-tag chip,
   Slack-style thread drawer for replies, realtime updates. Attachments
   land in PR 3.

   Layout: full-width feed (scrolls) + composer pinned at the bottom.
   Click "Reply in thread" on any message → drawer slides in from the
   right with the parent pinned + replies + its own composer.

   Deep-linking: `?plan=<uuid|prefix>` on the URL pre-fills the composer
   tag and pops the user straight into "I'm here to talk about plan X."
   That's the handoff for the "💬 Discuss this plan" button on
   PostPlanDetailView. */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import { StatusPill } from './postPlanShared.jsx';
import {
  loadConversationForAccount,
  loadConversationMessages,
  loadThreadReplies,
  loadThreadReplyCountsForMessages,
  addConversationMessage,
  subscribeToConversationMessages,
  markConversationSeen,
  loadPostPlans,
} from '../lib/db.js';

// Short-UUID matcher mirroring App.jsx's `findFullId` flow so `?plan=a3f9c2d8`
// resolves to the full plan row.
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

// ----- Plan-chip card ------------------------------------------------
// Renders inside a message bubble when the sender tagged a plan.
// Clickable — navigates to the plan detail. The non-clickable variant
// is used inside the composer's "tag chip" affordance above the
// textarea before send.
function PlanChip({ plan, brandSlug, navigate, removable, onRemove }) {
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
// Click 🔖 next to the composer → this opens. Searchable list of the
// brand's plans (most recent first). Picking a plan sets it as the
// composer's tag chip; clicking outside or pressing Esc closes.
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
    const ranked = [...(plans || [])].sort((a, b) => {
      // Newest scheduledAt first — agency typically wants to chat about
      // the upcoming / recent work, not last quarter's posts.
      return (b.scheduledAt || '').localeCompare(a.scheduledAt || '');
    });
    if (!ql) return ranked.slice(0, 40);
    return ranked.filter((p) => (p.concept || '').toLowerCase().includes(ql)).slice(0, 40);
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
              <span className="conv-tag-item-concept">{p.concept || 'Untitled plan'}</span>
              <StatusPill status={p.status} />
            </button>
          ))
        )}
      </div>
    </div>
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
}) {
  if (!message) return null;
  return (
    <div
      className={
        'conv-msg ' +
        (message.from === 'me' ? 'conv-msg-me' : 'conv-msg-them') +
        (isActiveThread ? ' conv-msg-active' : '')
      }
    >
      <Avatar person={message.who} size="sm" />
      <div className="conv-msg-body">
        <div className="conv-msg-meta">
          <strong className="conv-msg-name">{message.who?.name || 'Someone'}</strong>
          <span className="conv-msg-time">{message.time}</span>
        </div>
        {message.body && (
          <div className="conv-msg-text">{message.body}</div>
        )}
        {plan && (
          <PlanChip plan={plan} brandSlug={brandSlug} navigate={navigate} />
        )}
        {showReplyAffordance && !isThreadParent && (
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
// Used both inline at the bottom of the feed AND inside the thread
// drawer. `parentMessageId` (if set) routes the send through the
// thread; otherwise it's a top-level message. Plan-tag affordance is
// only shown on the main composer (replies inherit the parent's
// context already — adding a different plan tag would be confusing).
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
}) {
  const textareaRef = useRef(null);
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (e) => {
    // Cmd/Ctrl+Enter sends; plain Enter inserts a newline (familiar
    // chat-style: shift+enter and ctrl+enter both fire send).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (draft.trim() && !busy) onSubmit?.();
    }
  };

  // Auto-grow up to a cap, then scroll inside.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(ta.scrollHeight, 160);
    ta.style.height = next + 'px';
  }, [draft]);

  const canSend = !!draft.trim() && !busy;

  return (
    <div className="conv-composer">
      {taggedPlan && (
        <div className="conv-composer-tag">
          <PlanChip plan={taggedPlan} removable onRemove={onClearTag} />
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
          {showTagAffordance && (
            <button
              type="button"
              className={'conv-composer-icon-btn' + (taggedPlan ? ' is-active' : '')}
              onClick={onOpenTagDropdown}
              title={taggedPlan ? 'Change tagged plan' : 'Tag a post plan (optional)'}
              aria-label="Tag a post plan"
            >
              <Icon name="paperclip" size={16} />
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
// Slides in from the right when the user clicks "Reply in thread" on
// any feed message. Parent pinned at top; replies stack below; own
// composer at the bottom. Close with ✕ or Esc.
function ThreadDrawer({
  parent,
  parentPlan,
  replies,
  brandSlug,
  navigate,
  draft,
  onDraftChange,
  onSubmit,
  onClose,
  busy,
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
            plan={parentPlan}
            isThreadParent
            brandSlug={brandSlug}
            navigate={navigate}
          />
        </div>
        <div className="conv-drawer-replies" ref={repliesRef}>
          {(!replies || replies.length === 0) ? (
            <div className="conv-drawer-empty">Be the first to reply.</div>
          ) : (
            replies.map((r) => (
              <MessageBubble key={r.id} message={r} brandSlug={brandSlug} navigate={navigate} />
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
          />
        </div>
      </aside>
    </>
  );
}

// ===================================================================
// Main view
// ===================================================================

export default function ConversationsView({ accountId, accountName, userId, brandSlug, isAgency }) {
  const navigate = useNavigate();
  const location = useLocation();

  const [conversation, setConversation] = useState(null);     // {id, accountId}
  const [messages, setMessages] = useState([]);               // top-level only, ascending
  const [replyCounts, setReplyCounts] = useState(() => new Map()); // parentId → count
  const [plans, setPlans] = useState([]);                     // for the tag dropdown
  const [draft, setDraft] = useState('');
  const [taggedPlanId, setTaggedPlanId] = useState(null);
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  // Thread state
  const [threadParentId, setThreadParentId] = useState(null);
  const [threadReplies, setThreadReplies] = useState([]);
  const [threadDraft, setThreadDraft] = useState('');
  const [threadSending, setThreadSending] = useState(false);

  const feedRef = useRef(null);
  // Tracks whether the feed is scrolled to (near) the bottom — used to
  // decide whether a realtime INSERT auto-scrolls or just stays put so
  // the user reading older messages isn't yanked away.
  const stuckToBottomRef = useRef(true);
  // Latest accountId we marked seen for, to avoid stamping repeatedly
  // on every realtime tick.
  const seenForAccountRef = useRef(null);

  const plansById = useMemo(() => {
    const m = new Map();
    for (const p of plans) m.set(p.id, p);
    return m;
  }, [plans]);

  const taggedPlan = taggedPlanId ? plansById.get(taggedPlanId) || null : null;

  // ----- Mount: load conversation + messages + plans + subscribe -----
  useEffect(() => {
    if (!accountId || !userId) return;
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const conv = await loadConversationForAccount(accountId);
        if (cancelled) return;
        setConversation(conv);
        if (!conv) {
          setMessages([]);
          setReplyCounts(new Map());
          setLoading(false);
          return;
        }
        const [msgs, brandPlans] = await Promise.all([
          loadConversationMessages(conv.id, userId),
          loadPostPlans({ accountId }),
        ]);
        if (cancelled) return;
        setMessages(msgs);
        setPlans(brandPlans);
        // Pull reply counts in one query for the messages we just loaded.
        const ids = msgs.map((m) => m.id);
        if (ids.length > 0) {
          loadThreadReplyCountsForMessages(ids)
            .then((c) => { if (!cancelled) setReplyCounts(c); })
            .catch((e) => console.warn('loadThreadReplyCountsForMessages failed', e));
        }
        setLoading(false);
        // Mark seen once data is in — Sidebar badge clears.
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

  // ----- Realtime: append new messages -----
  useEffect(() => {
    if (!conversation?.id || !userId) return;
    const unsub = subscribeToConversationMessages(conversation.id, userId, (evt) => {
      if (evt.type !== 'INSERT' || !evt.message) return;
      const m = evt.message;
      if (m.parentMessageId) {
        // Reply: bump the parent's count + push into thread state if open.
        setReplyCounts((prev) => {
          const next = new Map(prev);
          next.set(m.parentMessageId, (next.get(m.parentMessageId) || 0) + 1);
          return next;
        });
        setThreadParentId((openId) => {
          if (openId === m.parentMessageId) {
            setThreadReplies((prev) =>
              prev.some((r) => r.id === m.id) ? prev : [...prev, m]
            );
          }
          return openId;
        });
      } else {
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m]
        );
      }
      // Realtime stamps a "you've seen up to this moment" for the brand
      // so the user's own new reads don't keep the badge red.
      markConversationSeen({ userId, accountId }).catch(() => {});
    });
    return unsub;
  }, [conversation?.id, userId, accountId]);

  // ----- Deep-link: preselect a plan tag from ?plan=<id|prefix> -----
  useEffect(() => {
    if (plans.length === 0) return;
    const params = new URLSearchParams(location.search);
    const raw = params.get('plan');
    if (!raw) return;
    const full = resolveFullPlanId(raw, plans);
    if (full) setTaggedPlanId(full);
  }, [location.search, plans]);

  // ----- Scroll behavior -----
  // After the feed renders (load or new message), scroll to bottom if
  // the user is already at the bottom OR this is the initial load.
  useEffect(() => {
    if (!feedRef.current) return;
    if (stuckToBottomRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, loading]);

  const onFeedScroll = useCallback((e) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckToBottomRef.current = distance < 80;
  }, []);

  // ----- Open / close thread -----
  const openThread = useCallback(async (parent) => {
    if (!parent?.id) return;
    setThreadParentId(parent.id);
    setThreadReplies([]);
    setThreadDraft('');
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
  }, []);

  const threadParent = useMemo(() => {
    if (!threadParentId) return null;
    return messages.find((m) => m.id === threadParentId) || null;
  }, [threadParentId, messages]);
  const threadParentPlan = threadParent?.taggedPostPlanId
    ? plansById.get(threadParent.taggedPostPlanId) || null
    : null;

  // ----- Send handlers -----
  const sendTopLevel = useCallback(async () => {
    const body = draft.trim();
    if (!body || !conversation?.id || !userId || sending) return;
    setSending(true);
    try {
      const inserted = await addConversationMessage({
        conversationId: conversation.id,
        authorId: userId,
        body,
        taggedPostPlanId: taggedPlanId || null,
      });
      // Optimistically append (realtime will dedupe).
      setMessages((prev) => prev.some((x) => x.id === inserted.id) ? prev : [...prev, inserted]);
      setDraft('');
      setTaggedPlanId(null);
      stuckToBottomRef.current = true;
    } catch (e) {
      console.error('send failed', e);
    } finally {
      setSending(false);
    }
  }, [draft, conversation?.id, userId, taggedPlanId, sending]);

  const sendReply = useCallback(async () => {
    const body = threadDraft.trim();
    if (!body || !conversation?.id || !userId || !threadParentId || threadSending) return;
    setThreadSending(true);
    try {
      const inserted = await addConversationMessage({
        conversationId: conversation.id,
        authorId: userId,
        body,
        parentMessageId: threadParentId,
      });
      setThreadReplies((prev) => prev.some((x) => x.id === inserted.id) ? prev : [...prev, inserted]);
      setReplyCounts((prev) => {
        const next = new Map(prev);
        next.set(threadParentId, (next.get(threadParentId) || 0) + 1);
        return next;
      });
      setThreadDraft('');
    } catch (e) {
      console.error('reply send failed', e);
    } finally {
      setThreadSending(false);
    }
  }, [threadDraft, conversation?.id, userId, threadParentId, threadSending]);

  const onPickPlan = useCallback((p) => {
    setTaggedPlanId(p.id);
    setTagDropdownOpen(false);
  }, []);

  // ----- Render -----
  const composerPlaceholder = isAgency
    ? `Message ${accountName || 'the brand'}…`
    : 'Message your agency…';

  return (
    <div className="conv-wrap">
      <header className="conv-head">
        <div>
          <div className="conv-title">Conversations</div>
          <div className="conv-sub">
            Chat with your {isAgency ? <strong>{accountName || 'brand'}</strong> : <strong>agency</strong>}.
            Tag a post plan if you want context, or just say hi.
          </div>
        </div>
      </header>

      <div className="conv-feed" ref={feedRef} onScroll={onFeedScroll}>
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
          replies={threadReplies}
          brandSlug={brandSlug}
          navigate={navigate}
          draft={threadDraft}
          onDraftChange={setThreadDraft}
          onSubmit={sendReply}
          onClose={closeThread}
          busy={threadSending}
        />
      )}
    </div>
  );
}
