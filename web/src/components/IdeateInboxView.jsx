/* eslint-disable */
/* IdeateInboxView — agency-side "Inbox" for brand-submitted ideas.
   List of post_plan_ideas for the active brand; click to open inline
   detail panel; edit fields; archive or "Add to Social Calendar" via
   ConvertIdeaModal. Once converted/archived, ideas drop off the
   default queue but are reachable via the status filter. */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Icon } from './Icon.jsx';
import {
  loadPostPlanIdeas,
  loadPostPlanIdeaAttachments,
  updatePostPlanIdea,
  deletePostPlanIdeaAttachment,
  subscribeToPostPlanIdeas,
} from '../lib/db.js';
import { ConvertIdeaModal } from './ConvertIdeaModal.jsx';
import { linkifyText } from './IdeateView.jsx';

const PLATFORMS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin',  label: 'LinkedIn' },
  { key: 'x',         label: 'X' },
];

const FILTERS = [
  { key: 'queue',     label: 'Queue',     statuses: ['submitted'] },
  { key: 'converted', label: 'On calendar', statuses: ['converted'] },
  { key: 'archived',  label: 'Archived',  statuses: ['archived'] },
];

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

const IdeateInboxView = ({ auth, accountId, accountName, navigateToPlan }) => {
  const [filter, setFilter]       = useState('queue');
  const [ideas, setIdeas]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [savingPatch, setSavingPatch] = useState(false);

  const refresh = useCallback(async () => {
    if (!accountId) {
      setIdeas([]);
      setLoading(false);
      return;
    }
    try {
      const rows = await loadPostPlanIdeas({ accountId });
      setIdeas(rows);
    } catch (e) {
      console.error('loadPostPlanIdeas failed', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!accountId) return undefined;
    const unsub = subscribeToPostPlanIdeas(() => { refresh(); }, { accountId });
    return unsub;
  }, [accountId, refresh]);

  const visible = useMemo(() => {
    const target = FILTERS.find((f) => f.key === filter);
    if (!target) return ideas;
    return ideas.filter((i) => target.statuses.includes(i.status));
  }, [ideas, filter]);

  const selected = useMemo(
    () => ideas.find((i) => i.id === selectedId) || null,
    [ideas, selectedId]
  );

  // When the visible list changes (filter switch, conversion, etc.),
  // make sure selectedId still points at something visible — otherwise
  // jump to the first row in the queue.
  useEffect(() => {
    if (visible.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!visible.find((i) => i.id === selectedId)) {
      setSelectedId(visible[0].id);
    }
  }, [visible, selectedId]);

  const queueCount = useMemo(
    () => ideas.filter((i) => i.status === 'submitted').length,
    [ideas]
  );

  const updateField = async (patch) => {
    if (!selected) return;
    setSavingPatch(true);
    try {
      const next = await updatePostPlanIdea(selected.id, patch);
      setIdeas((prev) => prev.map((i) => (i.id === next.id ? next : i)));
    } catch (e) {
      alert(`Could not save: ${e?.message || e}`);
    } finally {
      setSavingPatch(false);
    }
  };

  const handleArchive = () => updateField({ status: 'archived' });
  const handleRestore = () => updateField({ status: 'submitted' });

  const handleConverted = (plan) => {
    setConvertOpen(false);
    refresh();
    navigateToPlan?.(plan.id);
  };

  if (!accountId) {
    return (
      <div className="view"><div className="view-inner">
        <div className="empty" style={{padding: 32, textAlign: 'center', color: 'var(--ink-3)'}}>
          Pick a brand from the sidebar to see its inbox.
        </div>
      </div></div>
    );
  }

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{marginBottom: 8, color: 'var(--accent-ink)'}}>L+R Agency</div>
          <h1>Inbox</h1>
          <div className="sub">
            {accountName ? `Ideas from ${accountName}` : 'Brand-submitted ideas. Open one to refine and add to the calendar.'}
          </div>
        </div>
      </div>

      <div className="inbox-filters">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const isQueue = f.key === 'queue';
          return (
            <button
              key={f.key}
              type="button"
              className={'inbox-filter ' + (active ? 'on' : '')}
              onClick={() => setFilter(f.key)}
            >
              <span>{f.label}</span>
              {isQueue && queueCount > 0 && (
                <span className="inbox-filter-badge">{queueCount}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="inbox-split">
        <div className="inbox-list">
          {loading ? (
            <div className="empty" style={{padding: 18, fontSize: 13, color: 'var(--ink-4)'}}>Loading…</div>
          ) : visible.length === 0 ? (
            <div className="empty" style={{padding: 24, fontSize: 13, color: 'var(--ink-4)', textAlign: 'center'}}>
              {filter === 'queue' ? "No new ideas — you're caught up." : 'Nothing here.'}
            </div>
          ) : (
            visible.map((idea) => {
              const isSel = idea.id === selectedId;
              return (
                <button
                  key={idea.id}
                  type="button"
                  className={'inbox-row ' + (isSel ? 'on' : '')}
                  onClick={() => setSelectedId(idea.id)}
                >
                  <div className="inbox-row-title">{idea.title || 'Untitled idea'}</div>
                  <div className="inbox-row-snippet">
                    {(idea.details || '').replace(/\s+/g, ' ').slice(0, 120) || 'No details'}
                  </div>
                  <div className="inbox-row-meta">
                    <span>{formatRelative(idea.createdAt)}</span>
                    {idea.submitter?.name && <span>· {idea.submitter.name}</span>}
                    {idea.platforms?.length > 0 && (
                      <span>· {idea.platforms.length} platform{idea.platforms.length === 1 ? '' : 's'}</span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="inbox-detail">
          {selected ? (
            <InboxDetail
              idea={selected}
              onSave={updateField}
              onConvert={() => setConvertOpen(true)}
              onArchive={handleArchive}
              onRestore={handleRestore}
              saving={savingPatch}
            />
          ) : (
            <div className="empty" style={{padding: 32, fontSize: 13, color: 'var(--ink-4)', textAlign: 'center'}}>
              Pick an idea on the left.
            </div>
          )}
        </div>
      </div>

      <ConvertIdeaModal
        open={convertOpen}
        idea={selected}
        userId={auth?.id}
        onClose={() => setConvertOpen(false)}
        onConverted={handleConverted}
      />
    </div></div>
  );
};

// ---------------------------------------------------------------------
// Detail panel — editable fields, attachments, archive / convert CTAs.
// ---------------------------------------------------------------------
const InboxDetail = ({ idea, onSave, onConvert, onArchive, onRestore, saving }) => {
  const [title, setTitle]       = useState(idea.title || '');
  const [details, setDetails]   = useState(idea.details || '');
  const [date, setDate]         = useState(idea.desiredDate || '');
  const [platforms, setPlatforms] = useState(new Set(idea.platforms || []));
  const [attachments, setAttachments] = useState([]);
  const [loadingAtt, setLoadingAtt]   = useState(true);
  // Click-to-edit toggle for details. Default = render the linkified
  // text inline so URLs are clickable directly. Click anywhere
  // (except on a link) → open the textarea for editing.
  const [editingDetails, setEditingDetails] = useState(false);
  const detailsTextareaRef = useRef(null);

  // Re-seed when switching ideas.
  useEffect(() => {
    setTitle(idea.title || '');
    setDetails(idea.details || '');
    setDate(idea.desiredDate || '');
    setPlatforms(new Set(idea.platforms || []));
    setEditingDetails(false);
  }, [idea.id]);

  useEffect(() => {
    let cancelled = false;
    setLoadingAtt(true);
    loadPostPlanIdeaAttachments(idea.id)
      .then((rows) => { if (!cancelled) setAttachments(rows); })
      .catch((e) => console.warn('idea attachments load failed', e))
      .finally(() => { if (!cancelled) setLoadingAtt(false); });
    return () => { cancelled = true; };
  }, [idea.id]);

  const togglePlatform = (key) => {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const dirty =
    title !== (idea.title || '') ||
    details !== (idea.details || '') ||
    date !== (idea.desiredDate || '') ||
    Array.from(platforms).sort().join(',') !==
      (idea.platforms || []).slice().sort().join(',');

  const save = () => {
    onSave({
      title,
      details,
      desiredDate: date || null,
      platforms: Array.from(platforms),
    });
  };

  const removeAttachment = async (att) => {
    if (!confirm('Remove this reference file?')) return;
    try {
      await deletePostPlanIdeaAttachment(att);
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    } catch (e) {
      alert(`Could not remove: ${e?.message || e}`);
    }
  };

  const isConverted = idea.status === 'converted';
  const isArchived  = idea.status === 'archived';

  return (
    <div className="inbox-detail-inner">
      <div className="inbox-detail-head">
        <div className="inbox-detail-meta">
          <span>From {idea.submitter?.name || 'a brand member'}</span>
          <span>· {formatDate(idea.createdAt)}</span>
          {isConverted && <span>· On the calendar</span>}
          {isArchived && <span>· Archived</span>}
        </div>
        <div className="inbox-detail-actions">
          {!isConverted && !isArchived && (
            <button type="button" className="btn btn-sm" onClick={onArchive}>
              <Icon name="trash" size={12} />
              <span>Archive</span>
            </button>
          )}
          {isArchived && (
            <button type="button" className="btn btn-sm" onClick={onRestore}>
              <Icon name="refresh" size={12} />
              <span>Restore</span>
            </button>
          )}
          {!isConverted && (
            <button type="button" className="btn btn-sm btn-primary" onClick={onConvert}>
              <Icon name="calendar" size={12} />
              <span>Add to Social Calendar</span>
            </button>
          )}
        </div>
      </div>

      <div className="inbox-detail-fields">
        <label className="ideate-label">Title</label>
        <input
          className="ideate-input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={isConverted || saving}
        />

        <label className="ideate-label">Details</label>
        {editingDetails && !isConverted ? (
          <textarea
            ref={detailsTextareaRef}
            className="ideate-textarea"
            rows={6}
            autoFocus
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            onBlur={() => setEditingDetails(false)}
            disabled={saving}
          />
        ) : (
          <div
            className={'ideate-textarea inbox-detail-view ' + (isConverted ? 'is-readonly' : '')}
            onClick={(e) => {
              // Let URL clicks fall through to the browser; only
              // enter edit mode when the click was on plain text.
              if (e.target.closest('a')) return;
              if (isConverted) return;
              setEditingDetails(true);
            }}
            role={isConverted ? undefined : 'textbox'}
            tabIndex={isConverted ? undefined : 0}
            onKeyDown={(e) => {
              if (isConverted) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setEditingDetails(true);
              }
            }}
          >
            {details
              ? linkifyText(details)
              : <span className="inbox-detail-view-placeholder">No details yet — click to add.</span>}
          </div>
        )}

        <div className="ideate-row">
          <div className="ideate-field">
            <label className="ideate-label">Wanted date</label>
            <input
              className="ideate-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={isConverted || saving}
            />
          </div>

          <div className="ideate-field">
            <label className="ideate-label">Platforms</label>
            <div className="ideate-platforms">
              {PLATFORMS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  className={'ideate-platform-pill ' + (platforms.has(p.key) ? 'on' : '')}
                  onClick={() => togglePlatform(p.key)}
                  disabled={isConverted || saving}
                >
                  {platforms.has(p.key) && <Icon name="check" size={10} stroke={2.5} />}
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {!isConverted && dirty && (
          <div className="inbox-detail-save">
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      <div className="inbox-detail-attachments">
        <div className="tiny" style={{marginBottom: 8}}>References</div>
        {loadingAtt ? (
          <div className="empty" style={{padding: 12, fontSize: 12, color: 'var(--ink-4)'}}>Loading…</div>
        ) : attachments.length === 0 ? (
          <div className="empty" style={{padding: 12, fontSize: 12, color: 'var(--ink-4)'}}>No reference files attached.</div>
        ) : (
          <div className="inbox-attachments-grid">
            {attachments.map((att) => (
              <div key={att.id} className="inbox-attachment-tile">
                {(att.mimeType || '').startsWith('image/') && att.url ? (
                  <a href={att.url} target="_blank" rel="noopener noreferrer">
                    <img src={att.url} alt={att.filename} />
                  </a>
                ) : (
                  <a href={att.url} target="_blank" rel="noopener noreferrer" className="inbox-attachment-file">
                    <Icon name="paperclip" size={14} />
                    <span>{att.filename}</span>
                  </a>
                )}
                <button
                  type="button"
                  className="inbox-attachment-rm"
                  onClick={() => removeAttachment(att)}
                  aria-label="Remove"
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export { IdeateInboxView };
