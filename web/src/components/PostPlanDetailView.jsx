/* eslint-disable */
/* PostPlanDetailView — full-page surface for planning, reviewing, and
   approving a post plan. Mirrors TaskDetailView's bones: page head with
   title + status + workflow CTAs, tabbed main column (Overview /
   Conversation / Activity), sticky sidebar with Team + Timeline.

   Replaces the old popup modal — the calendar now navigates to this
   route instead of opening a modal in place. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import { diffWords } from '../lib/wordDiff.js';
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
  loadMessagesForPostPlan,
  loadProposalsForPlan,
  createProposal,
  resolveProposal,
  withdrawProposal,
  acknowledgeProposal,
  addMessageForPostPlan,
  subscribeToMessagesForPostPlan,
  loadPostPlanAttachments,
  addPostPlanAttachment,
  deletePostPlanAttachment,
  updatePostPlanAttachment,
  markPostPlanSeen,
  loadPostPlanStatusLog,
  duplicatePostPlan,
  loadPostPlanPublications,
  upsertPostPlanPublication,
  deletePostPlanPublication,
  subscribeToPostPlanPublications,
  refreshEngagement,
} from '../lib/db.js';
import { DuplicateDatePicker } from './DuplicateDatePicker.jsx';
import { MarkAsPostedModal } from './MarkAsPostedModal.jsx';
import { SafeImage } from './SafeImage.jsx';
import { VideoThumb } from './VideoThumb.jsx';
import { confirm as confirmDialog } from './ConfirmDialog.jsx';
import { useLightbox } from './Lightbox.jsx';
import { AICopyPreview } from './AICopyPreview.jsx';
import { AIImagePromptPanel } from './AIImagePromptPanel.jsx';

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

// =====================================================================
// Auto-title derivation — when an admin saves the FIRST piece of copy on
// an untitled post plan, we slot the opening of that copy into the
// `concept` field so the calendar / lists stop showing "Untitled post".
// Pure string transform; no external deps. Kept here (module-local) so
// the rule is obvious from a single read.
// =====================================================================
// Target: ~5-10 words. 50 chars covers that comfortably (English averages
// ~5 chars/word + spaces). Long opening lines truncate at the last word
// boundary with an ellipsis; short complete sentences are kept as-is.
const AUTO_TITLE_MAX_LEN = 50;
function deriveTitleFromCopy(text, maxLen = AUTO_TITLE_MAX_LEN) {
  if (!text) return '';
  // First non-empty line — captions almost always lead with a hook on
  // line 1, and that's a far better "title" than a mid-paragraph clip.
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  if (!firstLine) return '';
  // Strip leading emoji + punctuation noise so titles don't start with
  // a stray emoji, dash, or quote. Prefer Unicode property classes (covers
  // all emoji ranges); fall back to ASCII punctuation if the runtime
  // rejects the property escape.
  let cleaned = firstLine;
  try {
    cleaned = cleaned.replace(/^(?:\p{Extended_Pictographic}|\p{P}|\s)+/u, '');
  } catch {
    cleaned = cleaned.replace(/^[\s!"#$%&'()*+,\-./:;<=>?@\[\]^_`{|}~]+/, '');
  }
  cleaned = cleaned.trim();
  if (!cleaned) return '';
  // If the line starts with a complete short sentence, prefer that —
  // gives nicer titles like "Three reasons we ditched the cold-call"
  // instead of mid-thought "Three reasons we ditched the cold-call and".
  const sentenceMatch = cleaned.match(/^[^.!?\n]{8,}?[.!?](?:\s|$)/);
  if (sentenceMatch && sentenceMatch[0].length <= maxLen + 12) {
    cleaned = sentenceMatch[0].replace(/[.!?\s]+$/, '').trim();
  }
  if (cleaned.length <= maxLen) return cleaned;
  // Truncate at the last word boundary that's not too short. Falls back
  // to a hard cut if there's no reasonable space.
  const cut = cleaned.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const sliced = lastSpace > Math.floor(maxLen * 0.6) ? cut.slice(0, lastSpace) : cut;
  return sliced.replace(/[\s,.;:!?-]+$/, '') + '\u2026';
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
const isVideoMime = (m) => typeof m === 'string' && m.startsWith('video/');

// =====================================================================
// PendingDateProposalCard — surfaces a brand's pending date_change
// proposal at the top of the plan detail view. Agency sees Accept /
// Reject buttons; brand sees a read-only "Awaiting agency review" notice.
// =====================================================================
function formatProposalTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

const PendingDateProposalCard = ({ proposal, plan, isAdmin, busy, onAccept, onReject }) => {
  if (!proposal || !plan) return null;
  const proposedAt = proposal.payload?.scheduled_at || null;
  return (
    <div
      style={{
        marginTop: 16,
        padding: '12px 14px',
        border: '1px solid color-mix(in oklab, #C44A2C 35%, var(--line))',
        background: 'color-mix(in oklab, #C44A2C 6%, var(--surface))',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 640,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--ink-1)', fontWeight: 500 }}>
            Brand proposed a new date
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{formatProposalTimestamp(plan.scheduledAt)}</span>
            <span style={{ color: 'var(--ink-4)' }}>→</span>
            <strong style={{ color: 'var(--ink-1)', fontWeight: 500 }}>{formatProposalTimestamp(proposedAt)}</strong>
          </div>
          {proposal.note && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)', fontStyle: 'italic' }}>
              "{proposal.note}"
            </div>
          )}
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={onAccept}
              style={{ background: 'var(--good)', borderColor: 'var(--good)', color: '#fff' }}
            >
              {busy ? 'Working…' : 'Accept'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={onReject}
            >
              Reject
            </button>
          </div>
        )}
        {!isAdmin && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', flexShrink: 0, alignSelf: 'center' }}>
            Awaiting agency review
          </div>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// Inline word-diff renderer — shows tokens from wordDiff.diffWords()
// with red strikethrough for removed and green underline for added.
// =====================================================================
const DiffView = ({ tokens, emptyText }) => {
  if (!tokens || tokens.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'var(--ink-4)', fontStyle: 'italic' }}>{emptyText || '(no copy)'}</div>;
  }
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--ink-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {tokens.map((tok, i) => {
        if (tok.type === 'unchanged') return <span key={i}>{tok.text}</span>;
        if (tok.type === 'removed') {
          return (
            <span
              key={i}
              style={{
                textDecoration: 'line-through',
                textDecorationColor: '#b91c1c',
                background: 'color-mix(in oklab, #b91c1c 8%, transparent)',
                color: '#7f1d1d',
              }}
            >
              {tok.text}
            </span>
          );
        }
        // added
        return (
          <span
            key={i}
            style={{
              background: 'color-mix(in oklab, var(--good) 14%, transparent)',
              color: 'var(--good)',
              fontWeight: 500,
            }}
          >
            {tok.text}
          </span>
        );
      })}
    </div>
  );
};

// =====================================================================
// PendingCopyProposalCard — agency Accept/Reject for a brand-proposed
// copy change. Shows a per-platform diff inline; only platforms whose
// copy actually differs are rendered.
// =====================================================================
const PendingCopyProposalCard = ({ proposal, plan, isAdmin, isOwnProposal, busy, onAccept, onReject, onCancel }) => {
  if (!proposal || !plan) return null;
  const proposedVariants = proposal.payload?.copy_variants || {};
  const currentVariants = plan.copyVariants || {};
  const changedPlatforms = Object.keys(proposedVariants).filter((k) => {
    const before = currentVariants[k] ?? '';
    const after  = proposedVariants[k] ?? '';
    return before !== after;
  });
  return (
    <div
      style={{
        marginTop: 12,
        padding: '12px 14px',
        border: '1px solid color-mix(in oklab, #C44A2C 35%, var(--line))',
        background: 'color-mix(in oklab, #C44A2C 6%, var(--surface))',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 760,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--ink-1)', fontWeight: 500 }}>
            Brand proposed copy changes
          </div>
          {proposal.note && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink-2)', fontStyle: 'italic' }}>
              "{proposal.note}"
            </div>
          )}
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={onAccept}
              style={{ background: 'var(--good)', borderColor: 'var(--good)', color: '#fff' }}
            >
              {busy ? 'Working…' : 'Accept'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={onReject}
            >
              Reject
            </button>
          </div>
        )}
        {!isAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              Awaiting agency review
            </span>
            {/* Brand can recall their OWN pending proposal — RLS lets
                the proposer flip pending → withdrawn (migration 0056).
                Trigger emits "X withdrew their proposed copy changes."
                in the Conversations log. Confirmation dialog handled
                upstream in the parent's onCancel handler. */}
            {isOwnProposal && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={onCancel}
                title="Cancel this proposed change. You can propose new edits afterwards."
              >
                {busy ? 'Cancelling…' : 'Cancel proposal'}
              </button>
            )}
          </div>
        )}
      </div>
      {changedPlatforms.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-4)', fontStyle: 'italic' }}>
          No copy differences — proposed text matches the current plan.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {changedPlatforms.map((k) => {
            const platform = PLATFORMS.find((p) => p.key === k);
            const label = platform?.label || k;
            const before = currentVariants[k] ?? '';
            const after  = proposedVariants[k] ?? '';
            const tokens = diffWords(before, after);
            return (
              <div key={k} style={{ padding: '10px 12px', border: '1px solid var(--line)', background: 'var(--surface)', borderRadius: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {platform && <PlatformChip platform={k} size="sm" />}
                  <span style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 500 }}>{label}</span>
                </div>
                <DiffView tokens={tokens} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// =====================================================================
// ProposeCopyChangesModal — brand-side composer for proposing edits
// to a needs_review or approved plan's copy. Per-platform textareas
// pre-filled with the current copy; live diff preview at the bottom;
// optional note; send proposal.
// =====================================================================
const ProposeCopyChangesModal = ({ plan, accountId, userId, onCancel, onSent }) => {
  const initial = plan?.copyVariants || {};
  // Show ALL supported platforms in tabs (not just the plan's currently
  // targeted ones) — brand can propose adding a platform the plan didn't
  // originally include (e.g. plan was IG-only, brand wants to add a
  // LinkedIn variant). Tabs that aren't currently on the plan are marked
  // visually so the brand knows they're proposing a new platform. On
  // accept, the agency-side handler extends plan.platforms with any
  // newly-touched platform so the editor surfaces it normally.
  const planPlatforms = new Set(plan?.platforms || []);
  const platformKeys = PLATFORMS.map((p) => p.key);
  const [drafts, setDrafts] = useState(() => {
    const out = {};
    for (const k of platformKeys) out[k] = initial[k] ?? '';
    return out;
  });
  // Default tab: first currently-targeted platform, else first platform.
  const [activeTab, setActiveTab] = useState(() => {
    const first = platformKeys.find((k) => planPlatforms.has(k));
    return first || platformKeys[0] || null;
  });
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

  // Only include platforms whose copy actually differs.
  const changedVariants = useMemo(() => {
    const out = {};
    for (const k of platformKeys) {
      const before = initial[k] ?? '';
      const after  = drafts[k] ?? '';
      if (before !== after) out[k] = after;
    }
    return out;
  }, [drafts, initial, platformKeys]);

  const hasChanges = Object.keys(changedVariants).length > 0;

  const send = async () => {
    if (sending || !hasChanges || !plan?.id || !accountId || !userId) return;
    setSending(true);
    setError(null);
    try {
      await createProposal({
        planId: plan.id,
        accountId,
        kind: 'copy_change',
        payload: { copy_variants: changedVariants },
        note: note.trim() || null,
        userId,
      });
      onSent?.();
    } catch (err) {
      console.error('createProposal copy_change failed', err);
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
        style={{ maxWidth: 720, width: 'calc(100vw - 48px)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 14 }}>
          <h2 className="login-modal-title" style={{ fontSize: 22 }}>Propose copy changes</h2>
          <p className="login-modal-sub" style={{ marginTop: 6 }}>
            Edit the copy per platform. Your agency reviews a diff of what changed and can accept or reject.
          </p>
        </div>
        <div className="login-modal-body" style={{ paddingTop: 4, paddingBottom: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {platformKeys.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {platformKeys.map((k) => {
                const platform = PLATFORMS.find((p) => p.key === k);
                const label = platform?.label || k;
                const before = initial[k] ?? '';
                const after  = drafts[k] ?? '';
                const dirty = before !== after;
                const active = activeTab === k;
                const onPlan = planPlatforms.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setActiveTab(k)}
                    title={onPlan ? undefined : 'Not on this plan yet — write copy here to propose adding it.'}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 999,
                      border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
                      background: active ? 'color-mix(in oklab, var(--accent) 10%, var(--surface))' : 'var(--surface)',
                      color: active ? 'var(--ink-1)' : 'var(--ink-2)',
                      opacity: onPlan ? 1 : 0.72,
                      fontSize: 12.5,
                      fontWeight: 500,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                    }}
                  >
                    <PlatformChip platform={k} size="sm" />
                    <span>{label}</span>
                    {!onPlan && (
                      <span style={{ fontSize: 10.5, color: 'var(--ink-4)', fontStyle: 'italic', fontWeight: 400 }}>
                        + add
                      </span>
                    )}
                    {dirty && (
                      <span
                        aria-hidden
                        style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--accent)' }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {activeTab && (
            <textarea
              value={drafts[activeTab] || ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [activeTab]: e.target.value }))}
              placeholder={`Edit the ${PLATFORMS.find((p) => p.key === activeTab)?.label || activeTab} copy…`}
              rows={8}
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
                minHeight: 180,
                fontFamily: 'inherit',
                lineHeight: 1.5,
              }}
            />
          )}
          {activeTab && (initial[activeTab] ?? '') !== (drafts[activeTab] ?? '') && (
            <div style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Diff preview
              </div>
              <DiffView tokens={diffWords(initial[activeTab] ?? '', drafts[activeTab] ?? '')} />
            </div>
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the agency — why these changes?"
            rows={2}
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
              minHeight: 50,
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
            <button type="button" className="btn btn-primary" disabled={sending || !hasChanges} onClick={send}>
              {sending ? 'Sending…' : 'Send proposal'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const AttachmentTile = ({ att, canDelete, onDelete, onLightboxDelete, canEditCaption = false, onCaptionSave }) => {
  const showImage = isImageMime(att.mimeType) && att.url;
  // Video tiles use <VideoThumb>, which renders the sidecar JPEG when
  // present and gracefully falls back to a clean play-icon tile for
  // pre-2026-05-11 uploads (no sidecar yet) or extraction failures.
  const isVideo = isVideoMime(att.mimeType);
  const lightbox = useLightbox();

  // Caption editor state. Hover reveals a pencil affordance (agency
  // only); click flips to an inline input. Enter saves, Escape cancels.
  // The displayed primary label is the caption when present, falling
  // back to the filename — filename remains the source of truth for
  // downloads regardless of whether a caption exists.
  const caption = att.caption || '';
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(caption);
  const [hovering, setHovering] = useState(false);
  // Keep the draft in sync if the parent updates the underlying att
  // (e.g. after a successful optimistic save → server-canonical row
  // swap, or after a remote realtime change).
  useEffect(() => {
    if (!editingCaption) setCaptionDraft(caption);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caption]);
  const startEditingCaption = (e) => {
    if (!canEditCaption) return;
    if (e) { e.stopPropagation(); e.preventDefault(); }
    // Pre-fill the input with the CURRENT displayed label (caption when
    // set, filename otherwise) so the user can either tweak the existing
    // value or wipe and start fresh. Matches what they see on screen.
    setCaptionDraft(caption || att.filename || '');
    setEditingCaption(true);
  };
  const commitCaption = () => {
    setEditingCaption(false);
    const next = captionDraft.trim();
    // If the user kept the input identical to the filename (i.e. didn't
    // actually customize it), don't persist a redundant copy of the
    // filename as the caption. Store null instead so the UI's
    // caption-or-filename fallback keeps working uniformly.
    const normalized = next === (att.filename || '').trim() ? '' : next;
    onCaptionSave?.(att, normalized);
  };
  const cancelCaption = () => {
    setEditingCaption(false);
    setCaptionDraft(caption || att.filename || '');
  };
  const primaryLabel = caption || att.filename;
  const openInLightbox = () => {
    if (!att.url) return;
    lightbox.open({
      src: att.url,
      mimeType: att.mimeType,
      // Lightbox header prefers the human caption when present, falls
      // back to filename. The download button always uses filename
      // (filenames carry extensions; captions don't).
      name: caption || att.filename,
      alt: caption || att.filename,
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
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
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
        title={`Preview ${primaryLabel}`}
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
          <SafeImage
            src={att.url}
            alt={att.filename}
            filename={att.filename}
            caption="Preview unavailable"
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : isVideo ? (
          <VideoThumb thumbnailUrl={att.thumbnailUrl} alt={att.filename} badgeSize={36} />
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
        {editingCaption ? (
          <input
            autoFocus
            type="text"
            value={captionDraft}
            onChange={(e) => setCaptionDraft(e.target.value)}
            onBlur={commitCaption}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelCaption(); }
            }}
            placeholder={att.filename || 'Add a caption…'}
            maxLength={280}
            style={{
              fontSize: 12,
              color: 'var(--ink-1)',
              background: 'var(--surface-2)',
              border: '1px solid var(--accent)',
              borderRadius: 4,
              padding: '3px 6px',
              outline: 'none',
              width: '100%',
              fontFamily: 'inherit',
            }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <button
              type="button"
              onClick={canEditCaption ? startEditingCaption : openInLightbox}
              title={canEditCaption
                ? (caption ? 'Click to edit caption' : 'Click to edit — defaults to filename')
                : `Preview ${primaryLabel}`}
              style={{
                fontSize: 12,
                color: 'var(--ink-1)',
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: canEditCaption ? 'text' : 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'left',
                font: 'inherit',
                flex: 1,
                minWidth: 0,
              }}
            >
              {primaryLabel}
            </button>
            {canEditCaption && hovering && (
              <button
                type="button"
                onClick={startEditingCaption}
                aria-label={caption ? 'Edit caption' : 'Edit caption (defaults to filename)'}
                title={caption ? 'Edit caption' : 'Edit caption (defaults to filename)'}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'var(--ink-4)',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon name="edit" size={11}/>
              </button>
            )}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {caption ? att.filename : `${att.uploader?.name || 'Someone'} · ${formatBytes(att.sizeBytes)}`}
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
  onCaptionEdit,  // (attachment, newCaption) => void — agency-only edit; brand sees read-only
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
                canEditCaption={isAgency && !!onCaptionEdit}
                onCaptionSave={onCaptionEdit}
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
  linkAiEligible = false,    // ✨ LinkAI button in topbar (Phase 1: still agency-only)
  aiInlineEligible = false,   // ✨ AI draft / AI image prompt — open to brand on own brand_draft in Phase 1
}) => {
  const isAdmin = role === 'admin';

  // Brand slug derivation for the "💬 Discuss this plan" deep-link.
  // PostPlanDetailView lives at /c/:slug/calendar/:id, so we read the
  // first path segment after /c/. Guards against the legacy
  // /calendar/:id URL where there's no slug.
  const navigate = useNavigate();
  const location = useLocation();
  const brandSlug = useMemo(() => {
    const m = (location?.pathname || '').match(/^\/c\/([^/]+)\//);
    return m ? m[1] : null;
  }, [location?.pathname]);
  const openConversationsForPlan = () => {
    if (!plan?.id) return;
    const short = plan.id.slice(0, 8);
    const target = brandSlug
      ? `/c/${brandSlug}/conversations?plan=${short}`
      : `/conversations?plan=${short}`;
    navigate(target);
  };

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

  // Comments stream — still loaded so the Activity tab can list "X
  // commented" entries. The dedicated Conversation tab moved to the
  // unified Conversations surface (PR 2); messages-on-this-plan are
  // accessed via the "💬 Discuss this plan" button below, which deep-
  // links into /conversations with this plan pre-tagged.
  const [comments, setComments] = useState([]);
  // Inline "tell the brand what to change" panel — replaces the old
  // tab-switch friction for status transitions that demand a reason
  // (e.g. agency → needs revision). null = panel closed.
  // { status: nextStatus, draft: text } when open.
  const [pendingTransition, setPendingTransition] = useState(null);
  const [pendingDraft, setPendingDraft] = useState('');
  const pendingDraftRef = useRef(null);

  useEffect(() => {
    if (!postPlanId || !userId) return;
    let cancelled = false;
    loadMessagesForPostPlan(postPlanId, userId)
      .then((rows) => { if (!cancelled) setComments(rows); })
      .catch((e) => console.warn('loadMessagesForPostPlan failed', e));
    const unsub = subscribeToMessagesForPostPlan(postPlanId, userId, (evt) => {
      if (evt.type === 'INSERT') {
        setComments((prev) =>
          prev.some((c) => c.id === evt.comment.id) ? prev : [...prev, evt.comment]
        );
      }
    });
    return () => { cancelled = true; unsub?.(); };
  }, [postPlanId, userId]);

  // Pending proposals on this plan (date_change / copy_change). Surfaced
  // to the agency with Accept / Reject buttons; brand sees a read-only
  // "pending" notice on their own proposal.
  const [proposals, setProposals] = useState([]);
  const [resolvingProposalId, setResolvingProposalId] = useState(null);
  // The old ProposeCopyChangesModal mount has been retired in favor of
  // the inline Edit pill on the copy textbox (brand sees the same pill
  // the agency uses; on submit it routes to createProposal instead of
  // direct save). The modal component definition is still in this file
  // (`ProposeCopyChangesModal`) — kept on disk for low-effort revival
  // if we ever want a "More options / add a note" deeper flow — but
  // it's no longer mounted, so no proposeCopyOpen state is needed.

  const refreshProposals = useCallback(() => {
    if (!postPlanId) return;
    loadProposalsForPlan(postPlanId)
      .then((rows) => setProposals(rows))
      .catch((e) => console.warn('loadProposalsForPlan failed', e));
  }, [postPlanId]);

  useEffect(() => { refreshProposals(); }, [refreshProposals]);

  const pendingDateProposal = proposals.find(
    (p) => p.status === 'pending' && p.kind === 'date_change'
  ) || null;
  // All pending copy_change proposals, ordered newest-first by the
  // server. With per-platform proposal logic (added 2026-05-22), a
  // single plan can have multiple simultaneous pending copy_change
  // proposals — one per platform the brand has touched. Each renders
  // as its own card and each carries its own Accept/Reject (agency)
  // or Cancel (brand) action. `pendingCopyProposals` is the list;
  // `pendingCopyProposalByPlatform` is a lookup map for "does this
  // specific platform have a pending proposal in flight?".
  const pendingCopyProposals = proposals.filter(
    (p) => p.status === 'pending' && p.kind === 'copy_change'
  );
  const pendingCopyProposalByPlatform = (() => {
    const map = {};
    for (const p of pendingCopyProposals) {
      const variants = p.payload?.copy_variants || {};
      for (const platform of Object.keys(variants)) {
        // First-seen wins (newest-first ordering means the most-recent
        // pending proposal for the platform — shouldn't have multiple,
        // but if a race created two we surface the latest).
        if (!map[platform]) map[platform] = p;
      }
    }
    return map;
  })();

  // When agency opens the plan, mark any unacknowledged pending proposals
  // as acknowledged so the red dot on the calendar card clears. Brand
  // doesn't get a red dot indicator in v1, so this is agency-only.
  useEffect(() => {
    if (!isAdmin) return;
    const unacked = proposals.filter((p) => p.status === 'pending' && !p.acknowledgedAt);
    if (unacked.length === 0) return;
    Promise.all(unacked.map((p) => acknowledgeProposal(p.id).catch(() => null)))
      .then(() => refreshProposals());
  }, [isAdmin, proposals, refreshProposals]);

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
  // AI draft preview — which platform's preview is currently open, if any.
  // Only one preview at a time; opening on platform B closes any preview on A.
  const [aiPreviewPlatform, setAiPreviewPlatform] = useState(null);
  const [status, setStatus] = useState(plan?.status || 'drafting');
  const [saving, setSaving] = useState(false);

  // Editor permission — who can modify plan fields (concept, copy, date,
  // platforms). Agency users always can. Brand users can edit ONLY their
  // own brand-drafted plans (private state before they hit "Propose plan").
  // Once a brand clicks Propose, status flips to 'proposed' and the plan
  // becomes read-only for the brand until the agency accepts or rejects.
  const isEditor = isAdmin
    || (status === 'brand_draft' && !!plan?.createdBy && plan.createdBy === userId);
  // Title editing — read mode by default with a pencil affordance; flips
  // to an autofocused input when the user clicks the pencil. Enter saves
  // and exits, Escape cancels and reverts.
  const [titleEditing, setTitleEditing] = useState(false);
  // One-shot notice shown after we auto-fill the concept from the first
  // saved copy. Shape: { title, previousConcept } | null. Cleared on
  // dismiss or after Undo. Not persisted — it's a transient acknowledgement
  // surface, not a permanent state.
  const [autoTitleNotice, setAutoTitleNotice] = useState(null);

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

  // Inline caption edit on an attachment tile. Optimistic: swap the row
  // in local state immediately, then persist. On failure, revert + alert.
  // Caption-only — other attachment fields are immutable.
  const handleAttachmentCaptionEdit = async (attachment, nextCaption) => {
    if (!attachment?.id) return;
    const prev = attachment.caption || '';
    if (prev.trim() === (nextCaption || '').trim()) return; // no-op
    // Optimistic
    setAttachments((list) =>
      list.map((a) => (a.id === attachment.id ? { ...a, caption: nextCaption } : a))
    );
    try {
      const updated = await updatePostPlanAttachment(attachment.id, { caption: nextCaption });
      setAttachments((list) =>
        list.map((a) => (a.id === updated.id ? updated : a))
      );
    } catch (e) {
      console.error('update attachment caption failed', e);
      // Revert
      setAttachments((list) =>
        list.map((a) => (a.id === attachment.id ? { ...a, caption: prev } : a))
      );
      alert(`Could not save caption: ${e?.message || e}`);
    }
  };

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
    if (!isEditor) return;
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

    // Auto-title: if this is the FIRST piece of copy on a still-untitled
    // post plan, derive a one-line title from the copy and persist it in
    // the same write. Surface a one-shot callout so the admin notices.
    // Conditions (read against the canonical `plan`, not local state):
    //   1. No existing concept on the plan
    //   2. No saved copy on ANY platform yet
    //   3. The incoming copy is non-empty after trim
    const savedVariants = plan?.copyVariants || {};
    const hasAnySavedCopy = Object.values(savedVariants).some(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    const conceptEmpty = !(plan?.concept || '').trim();
    let derivedTitle = '';
    if (conceptEmpty && !hasAnySavedCopy && val.trim()) {
      derivedTitle = deriveTitleFromCopy(val);
    }

    const patch = { copyVariants: next };
    if (derivedTitle) {
      patch.concept = derivedTitle;
      setConcept(derivedTitle);
    }
    await persist(patch);

    if (derivedTitle) {
      setAutoTitleNotice({ title: derivedTitle, previousConcept: '' });
    }
  };

  // Brand-side equivalent of saveCopyForKey: instead of writing the
  // change directly to the plan (which brand isn't allowed to do
  // anyway — RLS would block it), package the change as a copy_change
  // PROPOSAL via the existing createProposal RPC. Submits only the
  // active platform's diff — each "Propose change" click yields one
  // proposal, so a brand wanting to suggest tweaks on IG + LinkedIn
  // submits twice. Cleaner audit trail than the old modal's "submit
  // all dirty platforms in one go" pattern, at the cost of a couple
  // extra clicks.
  //
  // The existing emit_plan_proposal_created_message trigger from
  // migration 0047 emits the "X proposed copy changes for this plan."
  // system message in the Conversations log automatically — no
  // explicit log call needed here.
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [proposalError, setProposalError] = useState(null);

  const submitBrandCopyProposal = async (key) => {
    if (submittingProposal) return;
    const draft = copyDrafts[key] ?? '';
    const saved = (plan?.copyVariants || {})[key] ?? '';
    if (draft === saved) return; // nothing to propose
    if (!plan?.id || !plan?.accountId || !userId) return;
    setSubmittingProposal(true);
    setProposalError(null);
    try {
      await createProposal({
        planId: plan.id,
        accountId: plan.accountId,
        kind: 'copy_change',
        payload: { copy_variants: { [key]: draft } },
        note: null, // inline flow doesn't expose a note field by design
        userId,
      });
      // Reset the local draft back to the saved value so the textarea
      // re-renders the unchanged copy if they re-enter edit mode.
      // (The proposal is pending — plan.copyVariants stays untouched
      // until agency accepts.) Exit edit mode, refresh proposals so
      // the pending banner + pill-suppression both react.
      setCopyDrafts((prev) => ({ ...prev, [key]: saved }));
      exitEditMode(key);
      refreshProposals();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('createProposal copy_change (inline) failed', err);
      setProposalError(err?.message || 'Could not send proposal.');
    } finally {
      setSubmittingProposal(false);
    }
  };

  // Revert an auto-filled title. Restores the previous concept value
  // (typically empty) and clears the notice.
  const undoAutoTitle = async () => {
    if (!autoTitleNotice) return;
    const prev = autoTitleNotice.previousConcept || '';
    setAutoTitleNotice(null);
    setConcept(prev);
    await persist({ concept: prev });
  };

  // Auto-save fallback when the textarea loses focus — preserves the
  // existing on-blur-persist behaviour so users who don't click Save
  // still get their text saved.
  //
  // Agency only. Brand uses the same textarea via the inline Edit pill
  // but submits a copy_change PROPOSAL (not a direct save) via an
  // explicit "Propose change" button — blur shouldn't fire-and-forget
  // a proposal RPC.
  const handleCopyBlur = (key) => {
    if (!isEditor) return;
    saveCopyForKey(key);
  };

  // Whether the active platform's editor is in 'edit' (textarea) mode for
  // the current viewer.
  //   - Agency: defaults to 'edit' when there's no saved copy yet (so
  //     they can type immediately on a fresh plan), otherwise 'read'.
  //   - Brand on a populated platform: defaults to 'read'. Brand opts
  //     in via the inline Edit pill on the read view (only shown when
  //     proposal flow is eligible for that platform — see
  //     canEditCopyForPlatform).
  //   - Brand on an EMPTY platform (no saved copy) that they're
  //     eligible to propose into: defaults to 'edit', so a click on
  //     the "+ LinkedIn" tab lands the cursor directly in a textarea
  //     instead of an empty read pane with a pill on it. Mirrors the
  //     agency-on-empty behavior — symmetric UX.
  const isCopyEditing = (key) => {
    if (!key) return false;
    if (copyMode[key]) return copyMode[key] === 'edit';
    const saved = (plan?.copyVariants || {})[key] ?? '';
    if (saved.trim()) return false; // populated → read by default
    // Empty default: agency always, brand only when they can propose
    // a fresh platform addition for this slot.
    return isEditor || brandCanProposeCopyForPlatform(key);
  };

  // Drop the `!isEditor` gate — brand needs to enter edit mode too,
  // so they can type into the textarea before clicking "Propose
  // change". The pill that calls this is already gated on
  // canEditCopyForPlatform below, so we don't open it for non-
  // eligible viewers (wrong status, or pending proposal already
  // sitting in agency's queue for that platform).
  const enterEditMode = (key) => {
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
    if (requireComment) {
      // Pop the inline reason panel; the user types their note + clicks
      // "Send & change status" and confirmTransition() does the actual
      // work. Replaces the old setTab('conversation') friction.
      setPendingTransition({ status: next });
      setPendingDraft('');
      setTimeout(() => pendingDraftRef.current?.focus(), 0);
      return;
    }
    // Optimistic, then revert on DB error so the trigger guards from
    // migration 0048 (agency-can't-approve, brand-only-approves-from-
    // needs_review) don't leave the UI in a phantom state.
    const prevStatus = status;
    setStatus(next);
    setSaving(true);
    try {
      const updated = await updatePostPlan(plan.id, { status: next });
      setPlan(updated);
      onPlanChanged?.(updated);
      markPostPlanSeen(plan.id, userId);
      onPlanSeen?.(plan.id);
    } catch (e) {
      console.error('status transition failed', e);
      setStatus(prevStatus);
    } finally {
      setSaving(false);
    }
  };

  const cancelPendingTransition = () => {
    setPendingTransition(null);
    setPendingDraft('');
  };

  const confirmPendingTransition = async () => {
    const next = pendingTransition?.status;
    const body = pendingDraft.trim();
    if (!next || !body || !plan?.id || !plan?.accountId || !userId) return;
    try {
      const inserted = await addMessageForPostPlan({
        postPlanId: plan.id,
        accountId: plan.accountId,
        body,
        authorId: userId,
      });
      // Optimistic add so the activity feed shows the new message
      // immediately (without waiting for a refetch).
      setComments((prev) => prev.some((x) => x.id === inserted.id) ? prev : [...prev, inserted]);
    } catch (e) {
      console.error('reason post failed', e);
      return;
    }
    // Status transition with revert-on-failure (see transitionStatus).
    const prevStatus = status;
    setStatus(next);
    setSaving(true);
    try {
      const updated = await updatePostPlan(plan.id, { status: next });
      setPlan(updated);
      onPlanChanged?.(updated);
      markPostPlanSeen(plan.id, userId);
      onPlanSeen?.(plan.id);
    } catch (e) {
      console.error('status transition failed', e);
      setStatus(prevStatus);
    } finally {
      setSaving(false);
    }
    cancelPendingTransition();
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

  // Brand-side "Recall proposal" — symmetric to "Propose plan". Flips
  // the post_plan status from 'proposed' back to 'brand_draft', which
  // returns the plan to the brand's private workspace (invisible to
  // agency once PR D's RLS lands). Migration 0056b allows the
  // transition + emits "recalled the proposed plan." in the
  // Conversations log via the existing status-message trigger.
  //
  // No plan_proposals row to clean up — per migration 0049, new-plan
  // proposals don't create a proposal row in the first place ("the
  // plan IS the proposal"). Differs from copy_change / date_change
  // which DO have proposal rows and go through withdrawProposal().
  const handleRecallProposedPlan = async () => {
    if (!plan?.id) return;
    const conceptLabel = (plan.concept || '').trim();
    const ok = await confirmDialog({
      title: conceptLabel ? `Recall “${conceptLabel}”?` : 'Recall this proposed plan?',
      body: 'The plan will return to your private drafts. Your agency will no longer see it — you can resume editing and propose again whenever you’re ready.',
      confirmText: 'Recall proposal',
      cancelText: 'Keep it proposed',
      danger: false,
    });
    if (!ok) return;
    try {
      const updated = await updatePostPlan(plan.id, { status: 'brand_draft' });
      setPlan(updated);
      onPlanChanged?.(updated);
      // Stay on the detail page — the plan is still the user's, just
      // back in draft state. They can resume editing immediately.
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('recall proposed plan failed', e);
      // eslint-disable-next-line no-alert
      window.alert(`Could not recall the proposal: ${e?.message || String(e)}`);
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
    // If the user unchecked one or more platforms, those publications get
    // soft-deleted via deletePostPlanPublication — same destructive
    // operation as the Live Posts grid's "Remove post" menu. Gate it
    // behind the same confirmation copy so the friction matches the
    // intent on both surfaces (user direction 2026-05-22). Cancelling
    // aborts the entire submit (upserts included) so the modal state
    // stays exactly as the user left it — they can re-check the box(es)
    // before submitting again.
    if (deletes.length > 0) {
      const removedLabels = deletes
        .map((id) => {
          const pub = publications.find((p) => p.id === id);
          return pub ? (PLATFORM_BY_KEY[pub.platform]?.label || pub.platform) : null;
        })
        .filter(Boolean);
      const isOne = removedLabels.length === 1;
      const headerLine = isOne
        ? `Remove this ${removedLabels[0]} post from Live Posts?`
        : `Remove ${removedLabels.length} posts (${removedLabels.join(', ')}) from Live Posts?`;
      const confirmed = window.confirm(
        `${headerLine}\n\n` +
        `Future engagement tracking for ${isOne ? 'this post' : 'these posts'} will stop. ` +
        `Historical engagement data captured so far will be preserved for reference ` +
        `(totals on the brand summary won't change). ` +
        `You can re-mark ${isOne ? 'the post' : 'the posts'} as posted later to start tracking again.`
      );
      if (!confirmed) return;
    }
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

    // Fire-and-forget engagement refresh for every IG / LinkedIn / X
    // publication that has a URL. Apify scrape takes ~6-10s; we don't
    // block the modal close on it. When the snapshot + embed cache
    // write lands, LivePostsView's realtime subscription picks it up
    // and the tile populates without any further user action.
    //
    // All three platforms have viable scrapers as of 2026-05-14. X was
    // re-enabled via scrape.badger after the second-pass shootout (see
    // scraper-lib.ts file header). New platforms get added to this Set
    // as their dispatch entries land in scraper-lib.ts.
    //
    // Both agency and brand callers can trigger this since 2026-05-21:
    // brand callers get a one-shot first scrape per publication
    // (server enforces — see web/api/engagement/refresh.ts auth-model
    // comment); agency callers can re-scrape repeatedly via the Live
    // Posts "Refresh now" button. Any failure (Apify quota out, actor
    // down, etc.) gets captured in the snapshot row's `scrape_status`
    // ('blocked' / 'failed') so the tile reflects the real state on
    // the next refresh.
    const AUTO_REFRESH_PLATFORMS = new Set(['instagram', 'linkedin', 'x']);
    for (const r of created) {
      if (!AUTO_REFRESH_PLATFORMS.has(r.platform)) continue;
      if (!r.liveUrl) continue;
      refreshEngagement(r.id).catch((e) => {
        console.warn('auto-refresh on mark-posted failed', e);
      });
    }
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
    if (status === 'proposed') return 'proposed';
    if (status === 'brand_draft') return 'brand_draft';
    return 'drafting';
  })();
  // Derived display status — combines raw status with publications to
  // surface "posted" as a distinct terminal state. Use this (not bucket)
  // for any UI gate that should exclude posted plans.
  const displayStatus = getDisplayStatus({ status }, publications);

  // Workflow buttons replace the old status dropdown. The dropdown let
  // agency manually set "approved" by accident; under the brand-proposals
  // model approval is brand-exclusive. Forward + recall transitions are
  // explicit, named buttons; the underlying trigger (migration 0048)
  // hard-enforces the same rules at the DB level so the UI is not the
  // only line of defence.
  //
  // On `proposed` status (brand-originated): agency sees Accept + Reject.
  // Accept transitions to drafting (existing trigger emits the system
  // message); Reject deletes the plan (`action: 'delete'` branch in the
  // button click handler).
  const statusActions = (() => {
    const out = [];
    if (isAdmin) {
      if (statusBucket === 'proposed') {
        out.push({ label: 'Accept', tone: 'good', next: 'drafting' });
        out.push({ label: 'Reject', tone: 'ghost', action: 'delete' });
      } else if (statusBucket === 'drafting') {
        out.push({ label: 'Submit for review', tone: 'primary', next: 'needs_review' });
      } else if (statusBucket === 'needs_review') {
        out.push({ label: 'Recall to drafting', tone: 'ghost', next: 'drafting' });
      } else if (statusBucket === 'approved') {
        out.push({ label: 'Back to draft', tone: 'ghost', next: 'drafting' });
      }
    } else {
      // Brand-side workflow buttons.
      if (statusBucket === 'brand_draft' && !!plan?.createdBy && plan.createdBy === userId) {
        // The brand explicitly submits a brand_draft → proposed. This is
        // the click that emits the "proposed a new post plan." message
        // (via migration 0050's UPDATE trigger). Before this click the
        // plan is invisible to agency as actionable; only their own brand
        // teammates and the creator know it exists.
        out.push({ label: 'Propose plan', tone: 'primary', next: 'proposed' });
      } else if (statusBucket === 'proposed' && !!plan?.createdBy && plan.createdBy === userId) {
        // Symmetric to "Propose plan": the brand creator can pull their
        // proposal back to brand_draft before agency acts on it. Per
        // migration 0049, a new-plan proposal has no plan_proposals row
        // — the plan IS the proposal — so recalling is just a status
        // flip back. Permission added in migration 0056b's guard update.
        // The Conversations log gets a "recalled the proposed plan."
        // system message via the same migration's status-message trigger.
        out.push({ label: 'Recall proposal', tone: 'ghost', action: 'recall-new-plan' });
      } else if (statusBucket === 'needs_review') {
        out.push({ label: 'Approve', tone: 'good', next: 'approved' });
        // The old "Propose changes" button used to live here, opening
        // a full-page modal. Replaced by the inline Edit pill on the
        // copy textbox below — same proposal flow, lighter UX. The
        // pill is gated on the same conditions (needs_review or
        // approved-not-yet-posted, no pending copy proposal already
        // in flight for that platform) via the
        // brandCanProposeCopyForPlatform variable computed below.
      } else if (statusBucket === 'approved' && displayStatus !== 'posted') {
        // Same as above — once a plan reaches approved-not-posted,
        // brand keeps the inline Edit pill on the copy textbox.
      }
    }
    return out;
  })();

  // Brand-side proposal eligibility, scoped to a specific platform.
  // The "no pending copy proposal" check is now per-platform — brand
  // can propose changes to LinkedIn even if Instagram already has a
  // pending proposal sitting in agency's queue. Status conditions
  // (needs_review OR approved-not-yet-posted) are still plan-level.
  //
  // `brandCanProposeAnyCopy` is a coarser variant for "should the
  // brand see the extra platform tabs" — used for the all-PLATFORMS
  // tab rendering below. The per-platform "is this slot eligible
  // right now?" check still gates the actual pill / footer button.
  const brandCanProposeAnyCopy = !isEditor && (
    statusBucket === 'needs_review' ||
    (statusBucket === 'approved' && displayStatus !== 'posted')
  );
  const brandCanProposeCopyForPlatform = (platform) =>
    brandCanProposeAnyCopy && !pendingCopyProposalByPlatform[platform];
  const canEditCopyForPlatform = (platform) =>
    isEditor || brandCanProposeCopyForPlatform(platform);

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
            {titleEditing && isEditor ? (
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
                  onClick={() => isEditor && setTitleEditing(true)}
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-serif)',
                    fontSize: 40,
                    fontWeight: 400,
                    letterSpacing: '-0.01em',
                    color: concept ? 'var(--ink-1)' : 'var(--ink-4)',
                    lineHeight: 1.1,
                    cursor: isEditor ? 'text' : 'default',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {concept || 'Untitled post'}
                </h1>
                {isEditor && (
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
          {autoTitleNotice && isAdmin && (
            <div
              role="status"
              style={{
                marginTop: 12,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: 'var(--surface-2)',
                color: 'var(--ink-2)',
                fontSize: 13,
                lineHeight: 1.45,
                maxWidth: 640,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  flexShrink: 0,
                  color: 'var(--accent-ink, #7C5CFF)',
                }}
              >
                <Icon name="sparkles" size={16}/>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--ink-1)', marginBottom: 2 }}>
                  Titled this post from your copy
                </div>
                <div style={{ color: 'var(--ink-3)' }}>
                  Click the title to edit, or undo to clear it.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={undoAutoTitle}
                  className="btn btn-sm btn-ghost"
                  style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => setAutoTitleNotice(null)}
                  aria-label="Dismiss"
                  title="Dismiss"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--ink-4)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--ink-2)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-4)'; }}
                >
                  <Icon name="x" size={12}/>
                </button>
              </div>
            </div>
          )}
          {!isAdmin && statusBucket === 'drafting' && (
            <div
              role="status"
              style={{
                marginTop: 16,
                padding: '10px 14px',
                border: '1px solid color-mix(in oklab, var(--accent) 28%, var(--line))',
                background: 'color-mix(in oklab, var(--accent) 5%, var(--surface))',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                maxWidth: 640,
                fontSize: 13,
                color: 'var(--ink-2)',
                lineHeight: 1.45,
              }}
            >
              <span aria-hidden style={{ flexShrink: 0, display: 'inline-flex', color: 'var(--accent-ink, var(--accent))' }}>
                <Icon name="sparkles" size={14}/>
              </span>
              <span>Your agency is drafting this post. You'll see it for review when it's ready.</span>
            </div>
          )}
          {pendingDateProposal && (
            <PendingDateProposalCard
              proposal={pendingDateProposal}
              plan={plan}
              isAdmin={isAdmin}
              busy={resolvingProposalId === pendingDateProposal.id}
              onAccept={async () => {
                if (resolvingProposalId) return;
                setResolvingProposalId(pendingDateProposal.id);
                try {
                  // 1) Apply the proposed date to the plan, 2) mark proposal approved.
                  // The plan UPDATE is gated by RLS to agency; the proposal UPDATE is
                  // also agency-only. Trigger emits "accepted the proposed date change."
                  const updated = await updatePostPlan(plan.id, {
                    scheduledAt: pendingDateProposal.payload?.scheduled_at,
                  });
                  setPlan(updated);
                  onPlanChanged?.(updated);
                  await resolveProposal({ proposalId: pendingDateProposal.id, status: 'approved' });
                  refreshProposals();
                } catch (e) {
                  console.error('accept date proposal failed', e);
                } finally {
                  setResolvingProposalId(null);
                }
              }}
              onReject={async () => {
                if (resolvingProposalId) return;
                setResolvingProposalId(pendingDateProposal.id);
                try {
                  await resolveProposal({ proposalId: pendingDateProposal.id, status: 'rejected' });
                  refreshProposals();
                } catch (e) {
                  console.error('reject date proposal failed', e);
                } finally {
                  setResolvingProposalId(null);
                }
              }}
            />
          )}
          {/* One stacked card per pending copy proposal. Per-platform
              logic (2026-05-22): brand can have up to one in-flight
              proposal per platform, so the same plan may show
              multiple cards simultaneously. Each card has its own
              Accept/Reject (agency) or Cancel (brand-proposer) action
              — they resolve independently, so agency can accept the
              IG proposal while still mulling LinkedIn.

              Spacing between cards relies on each card's own marginTop
              (12px), giving a clean stack without extra wrapper CSS. */}
          {pendingCopyProposals.map((proposal) => (
            <PendingCopyProposalCard
              key={proposal.id}
              proposal={proposal}
              plan={plan}
              isAdmin={isAdmin}
              isOwnProposal={proposal.proposedBy === userId}
              busy={resolvingProposalId === proposal.id}
              onAccept={async () => {
                if (resolvingProposalId) return;
                setResolvingProposalId(proposal.id);
                try {
                  // Merge proposed copy_variants into the plan (only the
                  // keys the brand touched; other platforms untouched).
                  // Also extend plan.platforms with any newly-touched key
                  // so the post-plan editor surfaces it normally instead
                  // of orphaning the new copy.
                  const proposedVariants = proposal.payload?.copy_variants || {};
                  const nextVariants = {
                    ...(plan.copyVariants || {}),
                    ...proposedVariants,
                  };
                  const currentPlatforms = Array.isArray(plan.platforms) ? plan.platforms : [];
                  const newKeys = Object.keys(proposedVariants).filter(
                    (k) => !currentPlatforms.includes(k) && (proposedVariants[k] ?? '').trim() !== ''
                  );
                  const patch = { copyVariants: nextVariants };
                  if (newKeys.length > 0) patch.platforms = [...currentPlatforms, ...newKeys];
                  const updated = await updatePostPlan(plan.id, patch);
                  setPlan(updated);
                  setCopyVariants(updated.copyVariants || {});
                  setCopyDrafts(updated.copyVariants || {});
                  setPlatforms(updated.platforms || []);
                  onPlanChanged?.(updated);
                  await resolveProposal({ proposalId: proposal.id, status: 'approved' });
                  refreshProposals();
                } catch (e) {
                  console.error('accept copy proposal failed', e);
                } finally {
                  setResolvingProposalId(null);
                }
              }}
              onReject={async () => {
                if (resolvingProposalId) return;
                setResolvingProposalId(proposal.id);
                try {
                  await resolveProposal({ proposalId: proposal.id, status: 'rejected' });
                  refreshProposals();
                } catch (e) {
                  console.error('reject copy proposal failed', e);
                } finally {
                  setResolvingProposalId(null);
                }
              }}
              onCancel={async () => {
                if (resolvingProposalId) return;
                if (!window.confirm('Cancel this proposed change? You can propose new edits afterwards.')) return;
                setResolvingProposalId(proposal.id);
                try {
                  await withdrawProposal({ proposalId: proposal.id });
                  refreshProposals();
                } catch (e) {
                  console.error('withdraw copy proposal failed', e);
                } finally {
                  setResolvingProposalId(null);
                }
              }}
            />
          ))}
          <div className="sub" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <StatusPill status={getDisplayStatus({ status }, publications)} size="lg"/>
            {plan?.aiGenerated && (
              <span
                className="ai-draft-pill"
                title="Created by the LinkAI. Edit, then submit for review through the normal workflow."
              >
                <span aria-hidden style={{ marginRight: 4 }}>✨</span>
                AI draft
              </span>
            )}
            <span>·</span>
            <input
              type="datetime-local"
              value={scheduledDraft}
              onChange={(e) => setScheduledDraft(e.target.value)}
              onBlur={handleScheduledBlur}
              disabled={!isEditor || saving}
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
              onClick={() => {
                if (a.action === 'delete') {
                  handleDelete();
                } else if (a.action === 'recall-new-plan') {
                  handleRecallProposedPlan();
                } else {
                  transitionStatus(a.next, { requireComment: a.requireComment });
                }
              }}
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
          {/* "View in Live posts" — surfaces alongside "Edit live posts"
              when at least one publication exists. Per user direction
              (2026-05-22): NOT a replacement, an additional affordance.
              The "Edit live posts" button is still needed for multi-
              channel plans where some platforms aren't posted yet (the
              modal is the only way to add the missing channel URLs).
              The View button is the read-side complement — deep-links
              into /c/:slug/posts?focus=<firstPubId> which scrolls the
              matching card into view and briefly highlights it. We
              focus the FIRST publication (the rail orders by
              published_at desc so this is the most recent platform);
              the rest are nearby in the same view. */}
          {statusBucket === 'approved' && publications.length > 0 && brandSlug && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => navigate(`/c/${brandSlug}/posts?focus=${publications[0].id}`)}
              title="Jump to this post on the Live Posts page"
            >
              <Icon name="arrow-up-right" size={13}/>
              View in Live posts
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
          {/* Deep-link into the unified Conversations view, with this
              plan pre-tagged in the composer. Replaces the old per-plan
              Conversation tab — chat lives in one place now. */}
          <button
            type="button"
            className="discuss-plan-btn"
            onClick={openConversationsForPlan}
            title="Open this plan in the brand's chat"
          >
            <Icon name="chat" size={13}/>Discuss this plan
          </button>
        </div>
      </div>

      {/* Inline "tell the brand what to change" panel — opens when the
          agency clicks a status transition that requires a reason
          (e.g. → needs revision). Replaces the old tab-switch flow.
          On submit: posts the message to the brand's conversation
          (auto-tagged to this plan) AND flips the status. */}
      {pendingTransition && (
        <div
          className="card"
          style={{
            marginTop: -8,
            marginBottom: 16,
            borderColor: 'color-mix(in oklab, var(--accent) 35%, var(--line))',
          }}
        >
          <div className="card-head">
            <div>
              <div className="card-title">Tell the brand what needs to change</div>
              <div className="card-sub">
                This message is sent into your shared chat and the status flips when you send.
              </div>
            </div>
          </div>
          <div style={{ padding: '0 16px 16px' }}>
            <textarea
              ref={pendingDraftRef}
              rows={3}
              placeholder="What's the change you'd like the brand to make?"
              value={pendingDraft}
              onChange={(e) => setPendingDraft(e.target.value)}
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={cancelPendingTransition}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={confirmPendingTransition}
                disabled={!pendingDraft.trim()}
              >
                Send & change status
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        borderBottom: '1px solid var(--line)',
        marginBottom: 24, marginTop: -8,
      }}>
        {[
          { k: 'overview', label: 'Overview', icon: 'sparkles' },
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
                        disabled={!isEditor || saving}
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
                          cursor: isEditor && !saving ? 'pointer' : 'default',
                          opacity: !isEditor && !on ? 0.6 : 1,
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
                {(() => {
                  // For agency (and brand-not-eligible), the tab strip is
                  // just the plan's targeted platforms — same as before.
                  // For brand-in-eligible-status, surface ALL supported
                  // platforms so they can propose ADDING a new channel
                  // (e.g. the plan is IG-only, brand wants LinkedIn too).
                  // Tabs not in plan.platforms get a "+" prefix to cue
                  // "clicking this would propose adding a new channel"
                  // instead of "editing an existing one".
                  const visibleTabs = brandCanProposeAnyCopy
                    ? PLATFORMS.map((p) => p.key)
                    : platforms;
                  if (visibleTabs.length === 0) return null;
                  return (
                  <div style={{ padding: '0 16px 16px' }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                      {visibleTabs.map((p) => {
                        const on = activeCopyTab === p;
                        const platCfg = PLATFORM_BY_KEY[p];
                        const isNewChannel = !platforms.includes(p);
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setActiveCopyTab(p)}
                            title={isNewChannel
                              ? `Propose adding a ${platCfg?.label || p} version of this post`
                              : undefined}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '6px 12px',
                              borderRadius: 99,
                              // Match the Platforms-section pill weight
                              // exactly (var(--ink-2) on active, var(--line)
                              // on inactive). Previously used var(--ink-1)
                              // for active which read as a heavier border
                              // than the rest of the page; the active-state
                              // surface-2 fill + bolder text already do the
                              // distinguishing work.
                              border: `1px solid ${on ? 'var(--ink-2)' : 'var(--line)'}`,
                              background: on ? 'var(--surface-2)' : 'transparent',
                              color: on ? 'var(--ink-1)' : 'var(--ink-4)',
                              fontWeight: on ? 600 : 400,
                              cursor: 'pointer',
                              fontSize: 12.5,
                              transition: 'background 120ms, color 120ms, border-color 120ms',
                              // Dashed border ONLY for inactive "+ would-add"
                              // tabs (subtle cue). Plan-platform tabs and
                              // any active tab use the solid border above.
                              borderStyle: isNewChannel && !on ? 'dashed' : 'solid',
                              opacity: isNewChannel && !on ? 0.85 : 1,
                            }}
                          >
                            {isNewChannel && (
                              <Icon name="plus" size={11}/>
                            )}
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
                              className="copy-edit-textarea"
                              rows={6}
                              value={draft}
                              onChange={(e) => handleCopyChange(activeCopyTab, e.target.value)}
                              onBlur={() => handleCopyBlur(activeCopyTab)}
                              placeholder={`Write the ${platLabel} version of this post…`}
                              disabled={saving || submittingProposal}
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
                            {/* Agency footer — direct save semantics + AI
                                co-pilot affordances. */}
                            {isEditor && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                <span style={{ fontSize: 11.5, color: isDirty ? 'var(--accent-ink)' : 'var(--ink-4)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  {saving && isDirty
                                    ? 'Saving…'
                                    : isDirty
                                      ? 'Unsaved changes'
                                      : (<><Icon name="check" size={11}/>Saved</>)}
                                </span>
                                <span style={{ flex: 1 }}/>
                                {aiInlineEligible && aiPreviewPlatform !== activeCopyTab && (
                                  <button
                                    type="button"
                                    className="btn btn-sm ai-draft-btn"
                                    onClick={() => setAiPreviewPlatform(activeCopyTab)}
                                    disabled={saving}
                                    title={draft.trim() ? 'Generate a fresh draft (you can replace or discard)' : 'Generate a draft from the brand voice'}
                                  >
                                    <span aria-hidden style={{ marginRight: 4 }}>✨</span>
                                    {draft.trim() ? 'AI redraft' : 'AI draft'}
                                  </button>
                                )}
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
                            {/* Brand footer — proposal semantics. Submit
                                is gated on isDirty (no point proposing
                                identical copy). AI Draft / AI Redraft is
                                available here too (gated on aiInlineEligible
                                which is already brand-friendly per App.jsx
                                — "open to brand on own brand_draft in
                                Phase 1") so brand can lean on the AI when
                                drafting a proposal. AICopyPreview's onAccept
                                writes into copyDrafts via handleCopyChange,
                                which makes isDirty true and surfaces the
                                "Propose change" button on the next render. */}
                            {!isEditor && brandCanProposeCopyForPlatform(activeCopyTab) && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                <span style={{ fontSize: 11.5, color: 'var(--ink-4)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  {submittingProposal
                                    ? 'Sending…'
                                    : isDirty
                                      ? 'Your edits will be sent for approval'
                                      : 'Make a change to propose'}
                                </span>
                                <span style={{ flex: 1 }}/>
                                {proposalError && (
                                  <span style={{ fontSize: 11.5, color: 'var(--bad)' }}>
                                    {proposalError}
                                  </span>
                                )}
                                {aiInlineEligible && aiPreviewPlatform !== activeCopyTab && (
                                  <button
                                    type="button"
                                    className="btn btn-sm ai-draft-btn"
                                    onClick={() => setAiPreviewPlatform(activeCopyTab)}
                                    disabled={submittingProposal}
                                    title={draft.trim() ? 'Generate a fresh draft (you can replace or discard before proposing)' : 'Generate a draft from the brand voice'}
                                  >
                                    <span aria-hidden style={{ marginRight: 4 }}>✨</span>
                                    {draft.trim() ? 'AI redraft' : 'AI draft'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost"
                                  onClick={() => cancelCopyEdit(activeCopyTab)}
                                  disabled={submittingProposal}
                                >
                                  Cancel
                                </button>
                                {isDirty && (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-primary"
                                    onClick={() => submitBrandCopyProposal(activeCopyTab)}
                                    disabled={submittingProposal}
                                    title="Send these edits to the agency for review"
                                  >
                                    {submittingProposal ? 'Sending…' : 'Propose change'}
                                  </button>
                                )}
                              </div>
                            )}
                            {aiInlineEligible && aiPreviewPlatform === activeCopyTab && plan?.id && (
                              <AICopyPreview
                                accountId={plan.accountId}
                                planId={plan.id}
                                platform={activeCopyTab}
                                mode={draft.trim() ? 'improve' : 'draft'}
                                currentCopy={draft}
                                onAccept={(generated) => {
                                  handleCopyChange(activeCopyTab, generated);
                                  setAiPreviewPlatform(null);
                                }}
                                onDismiss={() => setAiPreviewPlatform(null)}
                              />
                            )}
                          </>
                        );
                      }

                      // READ mode — linkified rendering of the SAVED copy,
                      // visually styled to match the textarea slot so the
                      // swap is seamless. Click anywhere not-on-a-link to
                      // re-enter edit mode (agency only).
                      // For brand, the pill is the proposal entry point;
                      // for agency, it's direct-edit. Same visual, same
                      // state-machine transition (enterEditMode), different
                      // submit semantics handled in the edit-view footer
                      // below.
                      const canEditThis = canEditCopyForPlatform(activeCopyTab);
                      const editTooltip = isEditor ? 'Click to edit' : 'Click to propose changes';
                      // Brand-and-platform-has-a-pending-proposal: surface
                      // a quiet hint instead of an inert read view, so the
                      // disappearing pill doesn't look like a bug.
                      const platformPending = !isEditor && pendingCopyProposalByPlatform[activeCopyTab];
                      return (
                        <div
                          role={canEditThis ? 'button' : undefined}
                          tabIndex={canEditThis ? 0 : undefined}
                          onClick={
                            canEditThis
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
                            canEditThis
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
                            cursor: canEditThis ? 'text' : 'default',
                            position: 'relative',
                          }}
                          title={canEditThis ? editTooltip : undefined}
                        >
                          {saved
                            ? linkifySegments(saved)
                            : (
                              <span style={{ color: 'var(--ink-4)' }}>
                                {isEditor
                                  ? `Click to write the ${platLabel} copy…`
                                  : `No ${platLabel} copy yet.`}
                              </span>
                            )}
                          {canEditThis && saved && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); enterEditMode(activeCopyTab); }}
                              title={editTooltip}
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
                          {platformPending && (
                            <span
                              title="Your proposed change for this platform is awaiting agency review. Cancel it from the proposal banner above to edit again."
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                padding: '3px 8px',
                                borderRadius: 999,
                                border: '1px solid color-mix(in oklab, #C44A2C 35%, var(--line))',
                                background: 'color-mix(in oklab, #C44A2C 8%, var(--surface-2))',
                                color: 'var(--ink-2)',
                                fontSize: 11,
                              }}
                            >
                              Proposal pending
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  );
                })()}
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
                onCaptionEdit={isAdmin ? handleAttachmentCaptionEdit : undefined}
                isAgency={isAdmin}
              />

              {/* AI image prompts — generate 3-5 direction ideas, pick one,
                  get a paste-ready prompt for image-gen tools. Agency-only,
                  whitelisted brands only. Sits above Deliverables since it's
                  the "plan the image" step that happens before the upload. */}
              {aiInlineEligible && isEditor && plan?.id && (
                <AIImagePromptPanel
                  accountId={plan.accountId}
                  planId={plan.id}
                  platform={activeCopyTab || (platforms[0] || 'instagram')}
                />
              )}

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
                onCaptionEdit={isAdmin ? handleAttachmentCaptionEdit : undefined}
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

              {isEditor && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleDelete} style={{ color: 'var(--accent)' }}>
                    Delete post plan
                  </button>
                </div>
              )}
            </>
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
                // Four-step lifecycle: Drafting → Sent for review →
                // Approved → Posted. ("Created" was dropped — every plan
                // starts there, the step was always-done noise.) Each
                // step is explicitly 'done' | 'current' | 'pending', and
                // "current" reflects WHERE WE ARE — not WHERE WE'RE
                // GOING NEXT. The Drafting macro covers brand_draft,
                // drafting, and proposed (all "being put together, not
                // yet handed to brand for approval").
                //
                // Each step gets a date stamp pinned to when the plan
                // transitioned INTO that step:
                //   Drafting        → plan.createdAt (when work began).
                //   Sent for review → earliest status_log row with
                //                     to_status in needs_review*.
                //   Approved        → plan.approvedAt (auto-stamped by
                //                     the trigger from migration 0021).
                //   Posted          → earliest publication.publishedAt.
                const earliestPub = publications.reduce((earliest, p) => {
                  if (!p.publishedAt) return earliest;
                  if (!earliest || p.publishedAt < earliest) return p.publishedAt;
                  return earliest;
                }, null);
                const sentForReviewLog = (statusLog || []).find((l) =>
                  l.toStatus === 'needs_review'
                  || l.toStatus === 'needs_brand_feedback'
                  || l.toStatus === 'needs_admin_revision'
                );
                const sentForReviewAt = sentForReviewLog?.createdAt || null;

                const isPosted = publications.length > 0;
                const isApproved = !isPosted && (!!plan.approvedAt || ['approved','scheduled'].includes(plan.status));
                const isInReview = !isApproved && !isPosted
                  && ['needs_review','needs_brand_feedback','needs_admin_revision'].includes(plan.status);
                const isDraftingStage = !isPosted && !isApproved && !isInReview;

                const stateOf = (stepKey) => {
                  switch (stepKey) {
                    case 'drafting':
                      if (isDraftingStage) return 'current';
                      return 'done';
                    case 'sent_for_review':
                      if (isInReview) return 'current';
                      if (isApproved || isPosted) return 'done';
                      return 'pending';
                    case 'approved':
                      if (isApproved) return 'current';
                      if (isPosted) return 'done';
                      return 'pending';
                    case 'posted':
                      if (isPosted) return 'current';
                      return 'pending';
                    default:
                      return 'pending';
                  }
                };

                return [
                  { key: 'drafting',        label: 'Drafting',        v: plan.createdAt },
                  { key: 'sent_for_review', label: 'Sent for review', v: sentForReviewAt },
                  { key: 'approved',        label: 'Approved',        v: plan.approvedAt },
                  { key: 'posted',          label: 'Posted',          v: earliestPub },
                ].map((step) => ({ ...step, state: stateOf(step.key) }));
              })().map((step, i) => {
                const isDone    = step.state === 'done';
                const isCurrent = step.state === 'current';
                return (
                  <div key={step.key} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: 4,
                      background: (isDone || isCurrent) ? 'var(--accent)' : 'var(--ink-5)',
                      boxShadow: isDone
                        ? '0 0 0 3px var(--accent-soft)'
                        : isCurrent
                          ? '0 0 0 3px color-mix(in oklab, var(--accent) 30%, transparent)'
                          : 'none',
                      flex: '0 0 auto',
                    }}/>
                    <div style={{
                      flex: 1,
                      color: (isDone || isCurrent) ? 'var(--ink)' : 'var(--ink-3)',
                      fontWeight: (isDone || isCurrent) ? 500 : 400,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                      <span>{step.label}</span>
                      {isCurrent && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 500,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            padding: '1px 6px',
                            borderRadius: 99,
                            background: 'color-mix(in oklab, var(--accent) 14%, var(--surface))',
                            color: 'var(--accent-ink, var(--accent))',
                          }}
                        >
                          Now
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--ink-4)', fontSize: 12 }}>
                      {step.v ? new Date(step.v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                    </div>
                  </div>
                );
              })}
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

      {/* ProposeCopyChangesModal mount removed — superseded by the
          inline Edit pill on the copy textbox (PR B, 2026-05-22).
          The component definition is still in this file in case we
          want to revive a deeper "Propose with a note" flow later. */}
    </div></div>
  );
};

export { PostPlanDetailView };
