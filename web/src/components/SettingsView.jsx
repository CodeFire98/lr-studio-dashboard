/* eslint-disable */
/* Settings — workspace-level controls.
   Workspace section: rename the current workspace (brand side only — the
     agency name is fixed as "L+R Studio").
   Danger zone: delete workspace (brand-only). Requires typing the workspace
     name to confirm. On success, sign out and reload the app. */
import React, { useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Modal } from './primitives.jsx';
import { updateAccountName } from '../lib/db.js';
import { supabase } from '../lib/supabase';
import { signOut } from '../lib/auth.js';

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

  useEffect(() => { setName(account?.name || ''); }, [account?.name]);

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
      const { error } = await supabase.from('accounts').delete().eq('id', account.id);
      if (error) throw error;
      await signOut();
      // Hard reload so nothing stale (tasks, cached auth, routes) hangs around.
      window.location.reload();
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
                ? 'The agency workspace name is fixed as "L+R Studio".'
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
                  Permanently removes this brand workspace, its tasks, assets, and brand kit.
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
