/* eslint-disable */
/* Settings — workspace-level controls.
   Workspace section: rename the current workspace (brand side only — the
     agency name is fixed as "Linkrunner Media").
   Danger zone: delete workspace (brand-only). Requires typing the workspace
     name to confirm. On success, sign out and reload the app. */
import React, { useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Modal } from './primitives.jsx';
import { updateAccountName, loadDailyReminderEnabled, updateDailyReminderEnabled } from '../lib/db.js';
import { supabase } from '../lib/supabase';
import { signOut, setActiveBrand } from '../lib/auth.js';

const SettingsView = ({ auth, mode }) => {
  const account = auth?.account || null;
  const isAdminWorkspace = mode === 'admin';

  const [name, setName] = useState(account?.name || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');

  // Confirm-delete modal state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');

  // Daily-digest reminder toggle (brand-only — agency workspace doesn't
  // get the email; the cron route filters to type='brand' anyway).
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderSaving, setReminderSaving] = useState(false);
  const [reminderErr, setReminderErr] = useState('');

  useEffect(() => { setName(account?.name || ''); }, [account?.name]);

  // Hydrate the reminder toggle from the brand row on mount + when the
  // active brand changes. Default to ON if the row hasn't been migrated
  // yet (matches the column's default — migration 0037).
  useEffect(() => {
    if (!account?.id || isAdminWorkspace) return;
    let cancelled = false;
    loadDailyReminderEnabled(account.id)
      .then((v) => { if (!cancelled) setReminderEnabled(v); })
      .catch((e) => { if (!cancelled) setReminderErr(e?.message || 'Could not load preference'); });
    return () => { cancelled = true; };
  }, [account?.id, isAdminWorkspace]);

  const toggleReminder = async (next) => {
    if (!account?.id) return;
    // Optimistic — flip the UI immediately, revert on failure.
    setReminderEnabled(next);
    setReminderSaving(true);
    setReminderErr('');
    try {
      await updateDailyReminderEnabled(account.id, next);
    } catch (e) {
      setReminderEnabled(!next);
      setReminderErr(e?.message || 'Save failed');
    } finally {
      setReminderSaving(false);
    }
  };

  const dirty = (name || '').trim() !== (account?.name || '').trim() && !!name.trim();

  const save = async () => {
    if (!account?.id || !dirty) return;
    setSaving(true); setErr(''); setFlash('');
    try {
      await updateAccountName(account.id, name.trim());
      setFlash('Workspace renamed.');
      setTimeout(() => setFlash(''), 1800);
      // The account name is part of the auth snapshot; ping auth.js so the
      // sidebar / crumb reflect the new name.
      try { window.dispatchEvent(new Event('lr_auth_change')); } catch {}
    } catch (e) {
      setErr(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const openDelete = () => {
    setConfirmText('');
    setDeleteErr('');
    setConfirmOpen(true);
  };

  const deleteWorkspace = async () => {
    if (!account?.id) return;
    setDeleting(true); setDeleteErr('');
    try {
      // Count remaining memberships BEFORE the delete (RPC will drop
      // this brand's membership row too). If the user has other brands
      // attached to this session, we route them back to the picker
      // instead of signing them out — preserving their session.
      const remainingMemberships = (auth?.memberships || [])
        .filter((m) => m?.account?.id && m.account.id !== account.id)
        .length;

      // Use the SECURITY DEFINER RPC — direct deletes hit RLS and silently
      // affect zero rows. The RPC enforces owner + brand-type guards and
      // cascades cleanup of every child row.
      const { error } = await supabase.rpc('delete_brand_account', { p_account_id: account.id });
      if (error) throw error;

      // Tell the auth layer to skip its first-time-user auto-create on the
      // next session refresh and show the brand picker instead. Cleared
      // when the user picks or creates a brand from the picker.
      try { localStorage.setItem('lr_brand_just_deleted', '1'); } catch {}

      if (remainingMemberships > 0) {
        // Other brands present — bounce to the picker, keep the session.
        // setActiveBrand(null) clears the per-user `lr_brand_<userId>`
        // localStorage key + rehydrates `_cachedAuth` via loadProfileFor.
        // With `lr_brand_just_deleted = '1'` set, hydrateProfile resolves
        // to `requiresBrandSelection = true` and App.jsx renders the
        // BrandSelectView automatically on next render.
        await setActiveBrand(null);
        // Hard reload anyway — per-brand state (tasks, RT subs, cached
        // post plans, etc.) lives across the whole component tree and is
        // simpler to drop wholesale than chase every useEffect cleanup.
        // The reload lands on '/' which the auth-hydrated requiresBrandSelection
        // gate (App.jsx ~line 1107) intercepts and renders BrandSelectView.
        window.location.assign('/');
      } else {
        // Last brand gone — there's nothing left to operate on, so the
        // session has no useful context. Sign the user out fully (matches
        // pre-change behaviour).
        await signOut();
        window.location.reload();
      }
    } catch (e) {
      setDeleteErr(e.message || 'Delete failed.');
      setDeleting(false);
    }
  };

  if (!account) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Settings</h1>
          <div className="sub">Sign in to manage your workspace.</div>
        </div></div>
      </div></div>
    );
  }

  return (
    <div className="view"><div className="view-inner" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>Workspace</div>
          <h1>Settings</h1>
          <div className="sub">Rename your workspace or permanently delete it.</div>
        </div>
      </div>

      {/* Workspace */}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Workspace</div>
            <div className="card-sub">
              {isAdminWorkspace
                ? 'The agency workspace name is fixed as "Linkrunner Media".'
                : 'Rename your brand workspace. Changes show up on every brief and delivery.'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="auth-field" style={{ margin: 0 }}>
            <span>Workspace name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isAdminWorkspace}
            />
          </label>
          {err && <div style={{ color: 'var(--accent-ink)', fontSize: 13 }}>{err}</div>}
          {flash && <div style={{ color: 'var(--good)', fontSize: 13 }}>{flash}</div>}
          {!isAdminWorkspace && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save workspace name'}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Notifications — brand-only. Agency users don't get the daily
          digest in v1; a separate agency-side notification flow is on the
          roadmap (REFERENCE.md §14). */}
      {!isAdminWorkspace && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Notifications</div>
              <div className="card-sub">
                Email everyone in this brand the night before about tomorrow's scheduled posts.
              </div>
            </div>
          </div>
          <div className="pf-list">
            <div className="pf-row pf-toggle-row">
              <div>
                <div className="pf-row-t">Daily 6pm IST reminder</div>
                <div className="pf-row-s">
                  When ON, we email every member of this brand at 6pm IST with tomorrow's posts —
                  what still needs your approval and what's ready to ship. We skip days with nothing scheduled.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={reminderEnabled}
                onClick={() => toggleReminder(!reminderEnabled)}
                disabled={reminderSaving}
                title={reminderEnabled ? 'Turn off daily reminder' : 'Turn on daily reminder'}
                style={{
                  position: 'relative',
                  width: 44,
                  height: 24,
                  borderRadius: 99,
                  border: 0,
                  background: reminderEnabled ? 'var(--good)' : 'var(--ink-5)',
                  cursor: reminderSaving ? 'wait' : 'pointer',
                  transition: 'background 150ms',
                  flexShrink: 0,
                  padding: 0,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: reminderEnabled ? 22 : 2,
                    width: 20,
                    height: 20,
                    borderRadius: 99,
                    background: '#fff',
                    transition: 'left 150ms',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </div>
          </div>
          {reminderErr && (
            <div style={{ padding: '0 16px 12px', fontSize: 12.5, color: 'var(--accent-ink)' }}>
              {reminderErr}
            </div>
          )}
        </section>
      )}

      {/* Danger zone — brand-only */}
      {!isAdminWorkspace && (
        <section className="card danger-card">
          <div className="card-head">
            <div>
              <div className="card-title" style={{ color: 'var(--danger)' }}>Danger zone</div>
              <div className="card-sub">Permanent actions. There is no undo.</div>
            </div>
          </div>
          <div className="pf-list">
            <div className="pf-row pf-toggle-row">
              <div>
                <div className="pf-row-t">Delete workspace</div>
                <div className="pf-row-s">
                  Permanently removes this brand workspace, its tasks, assets, and brand intelligence.
                </div>
              </div>
              <button
                className="btn btn-sm"
                style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                onClick={openDelete}
              >
                Delete…
              </button>
            </div>
          </div>
        </section>
      )}

      {confirmOpen && (
        <Modal onClose={() => (deleting ? null : setConfirmOpen(false))}>
          <div style={{ padding: 24, maxWidth: 480 }}>
            <h3 style={{ margin: 0, fontSize: 20 }}>Delete workspace?</h3>
            <p style={{ color: 'var(--ink-3)', fontSize: 13, lineHeight: 1.55, marginTop: 8 }}>
              This will permanently delete <strong>{account.name}</strong>, including every task,
              message, and uploaded asset. This cannot be undone.
            </p>
            <label className="auth-field" style={{ marginTop: 12 }}>
              <span>Type <strong>{account.name}</strong> to confirm</span>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoFocus
                disabled={deleting}
              />
            </label>
            {deleteErr && <div style={{ color: 'var(--accent-ink)', fontSize: 13, marginTop: 10 }}>{deleteErr}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setConfirmOpen(false)} disabled={deleting}>Cancel</button>
              <button
                className="btn"
                style={{ background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
                onClick={deleteWorkspace}
                disabled={deleting || confirmText !== account.name}
              >
                {deleting ? 'Deleting…' : 'Permanently delete'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div></div>
  );
};

export { SettingsView };
