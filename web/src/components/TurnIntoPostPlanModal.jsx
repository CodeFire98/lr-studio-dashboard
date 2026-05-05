/* eslint-disable */
/* TurnIntoPostPlanModal — Phase 5 of Trends Radar.
   Click "Turn into post plan" on a trend card → modal opens pre-filled with
   the trend → user picks a brand + date + platforms → submit creates a new
   post_plan in that brand's calendar with the trend pre-filled as the
   concept and the source URL captured for reference.

   This is the agentic moment of the feature — without it, Trends Radar is
   just a dashboard widget. With it, it's: spot trend → 2 clicks → live in
   calendar. */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { createPostPlan } from '../lib/db.js';

const PLATFORM_OPTIONS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'x',         label: 'X / Twitter' },
  { key: 'linkedin',  label: 'LinkedIn' },
];

// What platform should be pre-checked given the trend's source platform?
// Goal: a sensible default the user usually accepts. Trends from TikTok
// land naturally on IG Reels; X trends become X posts; etc.
const SUGGESTED_PLATFORMS = {
  tiktok:    ['instagram'],   // TikTok trends bleed to IG Reels
  instagram: ['instagram'],
  twitter:   ['x'],
  linkedin:  ['linkedin'],
};

// Format a Date as the value attribute for <input type="date">.
function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Default schedule: 3 days out at 09:00 local. Same convention as the
// duplicate-plan flow (db.js duplicatePostPlan).
function defaultScheduledDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d;
}

const TurnIntoPostPlanModal = ({
  open,
  trend,
  brandAccounts,       // [{id, name, slug, ...}, ...]
  defaultAccountId,    // current active brand if agency is in one
  userId,
  onClose,
  onCreated,           // (postPlan) => void — caller navigates / refreshes
}) => {
  const [accountId, setAccountId] = useState('');
  const [scheduledDate, setScheduledDate] = useState(() => ymd(defaultScheduledDate()));
  const [platforms, setPlatforms] = useState([]);
  const [conceptDraft, setConceptDraft] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'creating' | 'error'
  const [err, setErr] = useState('');

  const eligibleBrands = useMemo(() => brandAccounts || [], [brandAccounts]);

  // Re-seed defaults each time the modal opens or the trend changes.
  useEffect(() => {
    if (!open || !trend) return;
    setAccountId(defaultAccountId || eligibleBrands[0]?.id || '');
    setScheduledDate(ymd(defaultScheduledDate()));
    setPlatforms(SUGGESTED_PLATFORMS[trend.platform] || []);
    const isHashtag = trend.kind === 'hashtag';
    const display = isHashtag ? `#${trend.title}` : trend.title;
    setConceptDraft(`Use ${display}`);
    setStatus('idle');
    setErr('');
  }, [open, trend, defaultAccountId, eligibleBrands]);

  if (!open || !trend) return null;

  const isHashtag = trend.kind === 'hashtag';
  const trendDisplay = isHashtag ? `#${trend.title}` : trend.title;

  const togglePlatform = (key) => {
    setPlatforms((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]
    );
  };

  const handleClose = () => {
    if (status === 'creating') return; // don't let user dismiss mid-create
    onClose?.();
  };

  const handleCreate = async () => {
    setErr('');
    if (!accountId) {
      setErr('Pick a brand to schedule this for.');
      return;
    }
    if (platforms.length === 0) {
      setErr('Pick at least one platform.');
      return;
    }
    setStatus('creating');
    try {
      // Schedule at 09:00 local on the selected date — matches the
      // duplicate-plan convention so the chip lands in the morning slot.
      const [yy, mm, dd] = scheduledDate.split('-').map(Number);
      const scheduledAt = new Date(yy, mm - 1, dd, 9, 0, 0, 0).toISOString();

      // Build copy_variants seeded with the source URL on the suggested
      // platform — gives the lead something concrete to anchor copy on
      // when they open the post plan, instead of a blank textarea.
      const sourceLine = trend.url
        ? `Source: ${trend.url}`
        : `Source: ${trend.platform} ${trend.region || ''} trend`;
      const copySeed = `${trendDisplay}\n\n${sourceLine}`;
      const copyVariants = {};
      for (const p of platforms) copyVariants[p] = copySeed;

      const plan = await createPostPlan({
        accountId,
        scheduledAt,
        platforms,
        concept: conceptDraft.trim() || trendDisplay,
        copyVariants,
        status: 'drafting',
        userId: userId ?? null,
      });
      onCreated?.(plan);
    } catch (ex) {
      console.error('createPostPlan failed', ex);
      setErr(ex?.message || "Couldn't create the post plan.");
      setStatus('error');
    }
  };

  const trendMeta = [
    trend.platform === 'tiktok' ? 'TikTok' :
    trend.platform === 'twitter' ? 'X / Twitter' :
    trend.platform === 'instagram' ? 'Instagram' :
    trend.platform === 'linkedin' ? 'LinkedIn' : trend.platform,
    trend.region || null,
    trend.subtitle || null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="login-modal turn-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 520, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="turn-modal-head">
          <div className="turn-modal-eyebrow">Trends Radar · post plan</div>
          <h2 className="turn-modal-title">Turn this into a post plan</h2>
          <button
            className="turn-modal-close"
            onClick={handleClose}
            disabled={status === 'creating'}
            aria-label="Close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="turn-modal-body">
          <div className="turn-modal-trend">
            <div className="turn-modal-trend-title">{trendDisplay}</div>
            {trendMeta && <div className="turn-modal-trend-meta">{trendMeta}</div>}
          </div>

          <div className="turn-modal-field">
            <label htmlFor="turn-brand">Brand</label>
            <select
              id="turn-brand"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={status === 'creating'}
            >
              {eligibleBrands.length === 0 && <option value="">No brands</option>}
              {eligibleBrands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="turn-modal-field">
            <label htmlFor="turn-date">Schedule</label>
            <input
              id="turn-date"
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
            <label htmlFor="turn-concept">Concept</label>
            <input
              id="turn-concept"
              type="text"
              value={conceptDraft}
              onChange={(e) => setConceptDraft(e.target.value)}
              disabled={status === 'creating'}
              placeholder={`Use ${trendDisplay}`}
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
            disabled={status === 'creating' || eligibleBrands.length === 0}
          >
            {status === 'creating' ? 'Creating…' : 'Create post plan'}
          </button>
        </div>
      </div>
    </div>
  );
};

export { TurnIntoPostPlanModal };
