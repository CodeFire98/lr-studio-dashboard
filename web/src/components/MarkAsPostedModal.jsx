/* eslint-disable */
/* MarkAsPostedModal — opens from PostPlanDetailView when an approved
   plan needs to be marked as posted. One row per platform on the plan,
   each with a "Posted" checkbox and an optional live-post URL.
   Pre-fills from existing publications so this doubles as the edit
   surface (the brand wants to fix a typo'd URL → same modal).

   Submit semantics, applied per-platform:
     * checkbox on  + URL non-empty → upsert with that URL
     * checkbox on  + URL empty     → upsert with null URL (still posted)
     * checkbox off + had publication → delete the row
     * checkbox off + no publication  → no-op

   URL validation is intentionally light — must start with https:// when
   non-empty; we don't enforce per-platform domain rules so the brand
   can paste shortlinks (linkr.ee, bit.ly, branded short URLs) without
   the modal complaining. */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { PLATFORM_BY_KEY, PlatformChip } from './postPlanShared.jsx';

function validateUrl(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null; // optional → empty is fine
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) {
    return 'Must be a full https:// URL';
  }
  return null;
}

const MarkAsPostedModal = ({
  open,
  plan,
  publications,           // existing publications for this plan, []
  onSubmit,                // ({ upserts: [{platform, liveUrl}], deletes: [publicationId] }) => Promise
  onCancel,
}) => {
  // Map<platform, { posted: bool, url: string }>. Hydrated from plan +
  // existing publications whenever the modal opens; not synced after that
  // so in-flight typing isn't clobbered by realtime updates.
  const [rows, setRows] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});

  const platforms = useMemo(() => Array.isArray(plan?.platforms) ? plan.platforms : [], [plan?.platforms]);
  const pubsByPlatform = useMemo(() => {
    const m = {};
    for (const p of publications || []) m[p.platform] = p;
    return m;
  }, [publications]);

  useEffect(() => {
    if (!open) return;
    const next = {};
    for (const k of platforms) {
      const existing = pubsByPlatform[k];
      next[k] = existing
        ? { posted: true, url: existing.liveUrl || '' }
        : { posted: false, url: '' };
    }
    setRows(next);
    setErrors({});
  }, [open, platforms, pubsByPlatform]);

  if (!open) return null;

  const togglePosted = (key) => {
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], posted: !prev[key]?.posted } }));
    setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };

  const setUrl = (key, value) => {
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], url: value, posted: prev[key]?.posted ?? true } }));
    setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };

  const handleConfirm = async () => {
    // Validate URLs first — only checked rows with a URL get validated.
    const errs = {};
    for (const k of platforms) {
      const r = rows[k];
      if (r?.posted) {
        const e = validateUrl(r.url);
        if (e) errs[k] = e;
      }
    }
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    const upserts = [];
    const deletes = [];
    for (const k of platforms) {
      const r = rows[k];
      const existing = pubsByPlatform[k];
      if (r?.posted) {
        upserts.push({ platform: k, liveUrl: (r.url || '').trim() });
      } else if (existing) {
        deletes.push(existing.id);
      }
    }

    if (upserts.length === 0 && deletes.length === 0) {
      onCancel?.();
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({ upserts, deletes });
    } catch (e) {
      console.error('mark-as-posted submit failed', e);
      setErrors({ __form: e?.message || String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  const anyChange = (() => {
    for (const k of platforms) {
      const r = rows[k];
      const existing = pubsByPlatform[k];
      if (!r) continue;
      if (r.posted && !existing) return true;
      if (!r.posted && existing) return true;
      if (r.posted && existing && (r.url || '').trim() !== (existing.liveUrl || '')) return true;
    }
    return false;
  })();

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 480, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 10 }}>
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>
            Mark as posted
          </h2>
          <p className="login-modal-sub" style={{ marginTop: 4, fontSize: 13 }}>
            Tick the platforms this went live on, optionally drop in the link to the live post.
          </p>
        </div>

        <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {platforms.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>
              This plan doesn't target any platforms yet — pick at least one before marking it posted.
            </div>
          )}
          {platforms.map((k) => {
            const cfg = PLATFORM_BY_KEY[k];
            const row = rows[k] || { posted: false, url: '' };
            const err = errors[k];
            return (
              <div
                key={k}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 12,
                  background: row.posted ? 'var(--surface)' : 'var(--surface-2)',
                  opacity: row.posted ? 1 : 0.85,
                }}
              >
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13.5 }}>
                  <input
                    type="checkbox"
                    checked={row.posted}
                    onChange={() => togglePosted(k)}
                  />
                  <PlatformChip platform={k} size="sm" />
                  <strong style={{ fontWeight: 600 }}>{cfg?.label || k}</strong>
                  <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>
                    {row.posted ? 'posted' : 'not posted'}
                  </span>
                </label>
                {row.posted && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="url"
                      placeholder="https://… (optional)"
                      value={row.url}
                      onChange={(e) => setUrl(k, e.target.value)}
                      autoComplete="off"
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        border: `1px solid ${err ? 'var(--accent)' : 'var(--line)'}`,
                        borderRadius: 6,
                        background: 'var(--surface)',
                        color: 'var(--ink-1)',
                        fontSize: 13,
                        outline: 'none',
                      }}
                    />
                    {err && (
                      <div style={{ fontSize: 11.5, color: 'var(--accent)', marginTop: 4 }}>{err}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {errors.__form && (
            <div style={{ fontSize: 12.5, color: 'var(--accent)' }}>
              {errors.__form}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '0 20px 20px',
          }}
        >
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleConfirm}
            disabled={submitting || !anyChange || platforms.length === 0}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export { MarkAsPostedModal };
