/* eslint-disable */
/* ConvertIdeaModal — agency turns a brand-submitted idea into a real
   post_plans row on the calendar. Pre-fills from the idea's title /
   details / desired_date / platforms; lets the agency tweak before
   committing. On submit: creates the post_plan, marks the idea as
   converted with a back-pointer, and the parent navigates to the new
   plan. */

import React, { useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';
import { convertIdeaToPostPlan } from '../lib/db.js';

const PLATFORM_OPTIONS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin',  label: 'LinkedIn' },
  { key: 'x',         label: 'X / Twitter' },
];

function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function defaultDate(idea) {
  if (idea?.desiredDate) return idea.desiredDate; // already YYYY-MM-DD from postgres date column
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return ymd(d);
}

const ConvertIdeaModal = ({ open, idea, userId, onClose, onConverted }) => {
  const [scheduledDate, setScheduledDate] = useState('');
  const [platforms, setPlatforms] = useState([]);
  const [concept, setConcept] = useState('');
  const [copySeed, setCopySeed] = useState('');
  const [status, setStatus] = useState('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || !idea) return;
    setScheduledDate(defaultDate(idea));
    setPlatforms(Array.isArray(idea.platforms) && idea.platforms.length ? idea.platforms : ['instagram']);
    setConcept(idea.title || '');
    setCopySeed(idea.details || '');
    setStatus('idle');
    setErr('');
  }, [open, idea]);

  if (!open || !idea) return null;

  const togglePlatform = (key) => {
    setPlatforms((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]
    );
  };

  const handleClose = () => {
    if (status === 'creating') return;
    onClose?.();
  };

  const handleCreate = async () => {
    setErr('');
    if (platforms.length === 0) {
      setErr('Pick at least one platform.');
      return;
    }
    setStatus('creating');
    try {
      const [yy, mm, dd] = scheduledDate.split('-').map(Number);
      const scheduledAt = new Date(yy, mm - 1, dd, 9, 0, 0, 0).toISOString();

      const copyVariants = {};
      for (const p of platforms) copyVariants[p] = copySeed || '';

      const { plan } = await convertIdeaToPostPlan({
        idea,
        scheduledAt,
        platforms,
        concept: concept.trim() || idea.title,
        copyVariants,
        userId: userId ?? null,
      });
      onConverted?.(plan);
    } catch (ex) {
      console.error('convertIdeaToPostPlan failed', ex);
      setErr(ex?.message || "Couldn't convert this idea.");
      setStatus('error');
    }
  };

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="login-modal turn-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 560, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="turn-modal-head">
          <div className="turn-modal-eyebrow">Inbox · post plan</div>
          <h2 className="turn-modal-title">Add to Social Calendar</h2>
          <button
            className="turn-modal-close"
            onClick={handleClose}
            disabled={status === 'creating'}
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="turn-modal-body">
          <div className="turn-modal-trend">
            <div className="turn-modal-trend-title">{idea.title}</div>
            {idea.accountName && (
              <div className="turn-modal-trend-meta">For {idea.accountName}</div>
            )}
          </div>

          <div className="turn-modal-field">
            <label htmlFor="conv-date">Schedule</label>
            <input
              id="conv-date"
              type="date"
              value={scheduledDate}
              min={ymd(new Date())}
              onChange={(e) => setScheduledDate(e.target.value)}
              disabled={status === 'creating'}
            />
          </div>

          <div className="turn-modal-field">
            <label>Platforms</label>
            <div className="turn-modal-platforms">
              {PLATFORM_OPTIONS.map((p) => (
                <label key={p.key} className="turn-modal-platform">
                  <input
                    type="checkbox"
                    checked={platforms.includes(p.key)}
                    onChange={() => togglePlatform(p.key)}
                    disabled={status === 'creating'}
                  />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="turn-modal-field">
            <label htmlFor="conv-concept">Concept</label>
            <input
              id="conv-concept"
              type="text"
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              disabled={status === 'creating'}
            />
          </div>

          <div className="turn-modal-field">
            <label htmlFor="conv-copy">Copy seed (used as starting copy on every selected platform)</label>
            <textarea
              id="conv-copy"
              rows={5}
              value={copySeed}
              onChange={(e) => setCopySeed(e.target.value)}
              disabled={status === 'creating'}
            />
          </div>

          {err && <div className="turn-modal-error">{err}</div>}
        </div>

        <div className="turn-modal-foot">
          <button
            className="turn-modal-btn ghost"
            onClick={handleClose}
            disabled={status === 'creating'}
          >
            Cancel
          </button>
          <button
            className="turn-modal-btn primary"
            onClick={handleCreate}
            disabled={status === 'creating'}
          >
            {status === 'creating' ? 'Creating…' : 'Add to calendar'}
          </button>
        </div>
      </div>
    </div>
  );
};

export { ConvertIdeaModal };
