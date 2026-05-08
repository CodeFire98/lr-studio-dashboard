/* eslint-disable */
/* IdeateView — brand-side "Got ideas?" composer + history list.
   Drops an idea into post_plan_ideas. Agency picks it up in Inbox and
   converts it into a real post_plans row. */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Icon } from './Icon.jsx';
import {
  loadPostPlanIdeas,
  createPostPlanIdea,
  addPostPlanIdeaAttachment,
  loadPostPlanIdeaAttachments,
  subscribeToPostPlanIdeas,
  deletePostPlanIdea,
} from '../lib/db.js';

const PLATFORMS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin',  label: 'LinkedIn' },
  { key: 'x',         label: 'X' },
];

// Auto-linkify URLs in plain text. Used for the recent-ideas list
// preview only — the agency Inbox renders details with the same helper.
export function linkifyText(text) {
  if (!text) return null;
  const re = /(https?:\/\/[^\s<]+)/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) != null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={m[1]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>
    );
    last = m.index + m[1].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function formatDateChip(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return null;
  }
}

const STATUS_LABELS = {
  submitted: 'Submitted',
  converted: 'On the calendar',
  archived:  'Archived',
};

function StatusPill({ status }) {
  return (
    <span className={`idea-status idea-status-${status}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

const IdeateView = ({ auth, accountId }) => {
  const [title, setTitle]       = useState('');
  const [details, setDetails]   = useState('');
  const [date, setDate]         = useState('');
  const [platforms, setPlatforms] = useState(new Set());
  const [pendingFiles, setPendingFiles] = useState([]); // File[]
  const [submitting, setSubmitting] = useState(false);
  const [submittedFlash, setSubmittedFlash] = useState(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  const [ideas, setIdeas] = useState([]);
  const [loadingIdeas, setLoadingIdeas] = useState(true);

  const refresh = useCallback(async () => {
    if (!accountId) {
      setIdeas([]);
      setLoadingIdeas(false);
      return;
    }
    try {
      const rows = await loadPostPlanIdeas({ accountId });
      setIdeas(rows);
    } catch (e) {
      console.error('loadPostPlanIdeas failed', e);
    } finally {
      setLoadingIdeas(false);
    }
  }, [accountId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Realtime — pick up agency edits, conversions, etc.
  useEffect(() => {
    if (!accountId) return undefined;
    const unsub = subscribeToPostPlanIdeas(() => { refresh(); }, { accountId });
    return unsub;
  }, [accountId, refresh]);

  const togglePlatform = (key) => {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const addFiles = (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setPendingFiles((prev) => [...prev, ...list]);
  };

  const removePendingFile = (idx) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit = !submitting && !!title.trim();

  const reset = () => {
    setTitle('');
    setDetails('');
    setDate('');
    setPlatforms(new Set());
    setPendingFiles([]);
    setError('');
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (!accountId) {
      setError('No brand workspace found on your account.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const idea = await createPostPlanIdea({
        accountId,
        title,
        details,
        desiredDate: date || null,
        platforms: Array.from(platforms),
        userId: auth?.id,
      });
      // Upload any attached references against the new idea.
      for (const file of pendingFiles) {
        try {
          await addPostPlanIdeaAttachment({
            ideaId: idea.id,
            accountId,
            file,
            uploadedBy: auth?.id,
          });
        } catch (e) {
          console.warn('idea attachment upload failed', e);
        }
      }
      setSubmittedFlash({ id: idea.id, title: idea.title });
      reset();
      refresh();
      // Auto-clear flash after a few seconds.
      setTimeout(() => setSubmittedFlash(null), 4000);
    } catch (e) {
      console.error('createPostPlanIdea failed', e);
      setError(e?.message || 'Could not submit your idea. Try again?');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this idea?')) return;
    try {
      await deletePostPlanIdea(id);
      refresh();
    } catch (e) {
      alert(`Could not delete: ${e?.message || e}`);
    }
  };

  if (!accountId) {
    return (
      <div className="view"><div className="view-inner">
        <div className="empty" style={{padding: 32, textAlign: 'center', color: 'var(--ink-3)'}}>
          Pick a brand from the sidebar to submit an idea.
        </div>
      </div></div>
    );
  }

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Idea dump</h1>
          <div className="sub">Drop an idea for the team — title, details, when you'd like it posted, and where. We'll turn it into a post plan.</div>
        </div>
      </div>

      {submittedFlash && (
        <div className="ideate-flash" role="status">
          <Icon name="check" size={14} />
          <span>Idea sent — "{submittedFlash.title}"</span>
        </div>
      )}

      <div className="ideate-card">
        <label className="ideate-label">Title</label>
        <input
          className="ideate-input"
          type="text"
          placeholder="Give your idea a one-line title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
        />

        <label className="ideate-label">Details</label>
        <textarea
          className="ideate-textarea"
          placeholder="Spell out the idea. Paste links — they'll auto-link. Reference previous posts, products, hooks, etc."
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={6}
        />

        <div className="ideate-row">
          <div className="ideate-field">
            <label className="ideate-label">Wanted date <span className="ideate-optional">— optional</span></label>
            <input
              className="ideate-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="ideate-field">
            <label className="ideate-label">Platforms <span className="ideate-optional">— optional</span></label>
            <div className="ideate-platforms">
              {PLATFORMS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  className={"ideate-platform-pill " + (platforms.has(p.key) ? 'on' : '')}
                  onClick={() => togglePlatform(p.key)}
                >
                  {platforms.has(p.key) && <Icon name="check" size={10} stroke={2.5} />}
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {pendingFiles.length > 0 && (
          <div className="ideate-attachments">
            {pendingFiles.map((f, i) => (
              <div key={i} className="ideate-attachment-chip">
                <Icon name="paperclip" size={11} />
                <span>{f.name}</span>
                <button
                  type="button"
                  className="ideate-attachment-rm"
                  onClick={() => removePendingFile(i)}
                  aria-label="Remove"
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <div className="ideate-error">{error}</div>}

        <div className="ideate-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{display: 'none'}}
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            type="button"
            className="ideate-icon-btn"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach reference files"
            title="Attach reference files"
          >
            <Icon name="paperclip" size={16} />
          </button>
          <div style={{flex: 1}} />
          <button
            type="button"
            className="composer-send"
            disabled={!canSubmit}
            data-ready={canSubmit}
            onClick={handleSubmit}
          >
            <span>{submitting ? 'Sending…' : 'Submit idea'}</span>
            <Icon name="arrow-right" size={13} />
          </button>
        </div>
      </div>

      {/* Recent ideas — show what the brand has submitted so far. */}
      <div className="ideate-history">
        <div className="ideate-history-head">
          <span className="tiny">Your recent ideas</span>
        </div>
        {loadingIdeas ? (
          <div className="empty" style={{padding: 18, fontSize: 13, color: 'var(--ink-4)'}}>Loading…</div>
        ) : ideas.length === 0 ? (
          <div className="empty" style={{padding: 18, fontSize: 13, color: 'var(--ink-4)'}}>
            Nothing submitted yet — your first idea will land here.
          </div>
        ) : (
          <div className="ideate-history-list">
            {ideas.map((idea) => (
              <div key={idea.id} className="ideate-history-row">
                <div className="ideate-history-main">
                  <div className="ideate-history-title">{idea.title}</div>
                  {idea.details && (
                    <div className="ideate-history-details">
                      {linkifyText(idea.details.length > 220 ? `${idea.details.slice(0, 220)}…` : idea.details)}
                    </div>
                  )}
                  <div className="ideate-history-meta">
                    <StatusPill status={idea.status} />
                    {idea.desiredDate && <span>· Wants {formatDateChip(idea.desiredDate)}</span>}
                    {idea.platforms?.length > 0 && (
                      <span>· {idea.platforms.map((p) => PLATFORMS.find((x) => x.key === p)?.label || p).join(', ')}</span>
                    )}
                  </div>
                </div>
                {idea.status === 'submitted' && (
                  <button
                    type="button"
                    className="ideate-history-rm"
                    onClick={() => handleDelete(idea.id)}
                    aria-label="Delete idea"
                    title="Delete idea"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div></div>
  );
};

export { IdeateView };
