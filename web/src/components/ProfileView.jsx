/* eslint-disable */
/* Profile — user settings page. Reads the current profile row from Supabase
   and persists edits through updateProfile(). The localStorage-only path is
   gone; what we render is always what the DB will tell us on reload. */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import { readAuth, requestPasswordReset } from '../lib/auth.js';
import { loadProfile, updateProfile } from '../lib/db.js';

const AVATAR_COLORS = ['#E8553D', '#C4412C', '#C88A3F', '#3E8864', '#6579BE', '#8B5CF6', '#2B2B2E'];

function initialsFromName(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

function formatJoinDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

const ProfileView = ({ setRoute, mode, onSignOut }) => {
  const auth = readAuth() || {};
  const userId = auth.id;

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // Editable form state
  const [displayName, setDisplayName] = useState('');
  const [initials, setInitials] = useState('');
  const [initialsTouched, setInitialsTouched] = useState(false);
  const [avatarColor, setAvatarColor] = useState('#E8553D');

  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');
  const [resetStatus, setResetStatus] = useState(''); // '', 'sending', 'sent', 'error:<msg>'

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    loadProfile(userId)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setDisplayName(p?.displayName || auth.name || '');
        setInitials(p?.initials || initialsFromName(p?.displayName || auth.name || ''));
        setAvatarColor(p?.avatarColor || auth.avatarColor || '#E8553D');
      })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load profile.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  // Keep initials in lock-step with display name unless the user has
  // explicitly edited the initials field.
  useEffect(() => {
    if (initialsTouched) return;
    setInitials(initialsFromName(displayName));
  }, [displayName, initialsTouched]);

  const dirty = useMemo(() => {
    if (!profile) return false;
    return (
      (displayName || '') !== (profile.displayName || '') ||
      (initials || '') !== (profile.initials || '') ||
      (avatarColor || '') !== (profile.avatarColor || '')
    );
  }, [profile, displayName, initials, avatarColor]);

  const save = async () => {
    if (!userId) return;
    setSaving(true); setFlash(''); setErr('');
    try {
      const updated = await updateProfile(userId, {
        display_name: displayName,
        initials,
        avatar_color: avatarColor,
      });
      setProfile(updated);
      setInitialsTouched(false);
      setFlash('Profile saved.');
      setTimeout(() => setFlash(''), 1800);
    } catch (e) {
      setErr(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    if (!profile) return;
    setDisplayName(profile.displayName || '');
    setInitials(profile.initials || initialsFromName(profile.displayName || ''));
    setAvatarColor(profile.avatarColor || '#E8553D');
    setInitialsTouched(false);
  };

  const handleResetPassword = async () => {
    const email = auth.email;
    if (!email) { setResetStatus('error:No email on file.'); return; }
    setResetStatus('sending');
    try {
      await requestPasswordReset(email);
      setResetStatus('sent');
    } catch (e) {
      setResetStatus('error:' + (e.message || 'Request failed.'));
    }
  };

  const handleSignOut = () => {
    if (onSignOut) onSignOut();
    else setRoute?.({ view: 'home' });
  };

  if (!userId) {
    return (
      <div className="view"><div className="view-inner profile-view">
        <div className="page-head"><div className="titles"><h1>Profile</h1>
          <div className="sub">Sign in to view your profile.</div>
        </div></div>
      </div></div>
    );
  }

  if (loading) {
    return (
      <div className="view"><div className="view-inner profile-view">
        <div className="page-head"><div className="titles"><h1>Profile</h1>
          <div className="sub">Loading…</div>
        </div></div>
      </div></div>
    );
  }

  const avatarPerson = {
    initials: initials || '?',
    name: displayName || 'You',
    avatarColor,
  };

  const workspaceLine = auth.isAgency
    ? 'L+R Studio'
    : `Brand · ${auth.account?.name || 'Workspace'}`;

  return (
    <div className="view">
      <div className="view-inner profile-view">
        {/* Header */}
        <div className="profile-head">
          <div className="profile-head-left">
            <Avatar person={avatarPerson} size="lg"/>
            <div>
              <div className="profile-head-name">
                {displayName || 'Unnamed'}
              </div>
              <div className="profile-head-sub">
                {auth.email || '—'}
                <span className="dot-sep"> · </span>
                <span>{workspaceLine}</span>
              </div>
              <div className="profile-head-meta">
                <span className="pill">{auth.role || (auth.isAgency ? 'Agency' : 'Brand')}</span>
                <span className="pill">Member since {formatJoinDate(profile?.createdAt)}</span>
              </div>
            </div>
          </div>
          <div className="profile-head-right">
            <button className="btn btn-ghost" onClick={() => setRoute?.({ view: 'home' })}>
              <Icon name="arrow-left" size={13}/> Back
            </button>
            <button className="btn btn-ghost" onClick={handleSignOut}>
              <Icon name="x" size={13}/> Sign out
            </button>
          </div>
        </div>

        {err && (
          <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent-soft)' }}>
            <div style={{ color: 'var(--accent-ink)', fontSize: 13 }}>{err}</div>
          </div>
        )}

        {/* Identity card */}
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Identity</div>
              <div className="card-sub">How you show up across briefs, comments, and deliveries.</div>
            </div>
          </div>
          <div className="profile-form">
            <div className="pf-row two">
              <label className="pf-field">
                <span>Display name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </label>
              <label className="pf-field">
                <span>Initials</span>
                <input
                  type="text"
                  maxLength={3}
                  value={initials}
                  onChange={(e) => { setInitials(e.target.value.toUpperCase().slice(0, 3)); setInitialsTouched(true); }}
                />
              </label>
            </div>
            <div className="pf-field">
              <span>Avatar color</span>
              <div className="pf-swatches">
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={'pf-swatch ' + (avatarColor === c ? 'on' : '')}
                    style={{ background: c }}
                    onClick={() => setAvatarColor(c)}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Security card */}
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Security</div>
              <div className="card-sub">Reset your password via email.</div>
            </div>
          </div>
          <div className="pf-list">
            <div className="pf-row pf-toggle-row">
              <div>
                <div className="pf-row-t">Password</div>
                <div className="pf-row-s">
                  {resetStatus === 'sent'
                    ? 'Check your email for a reset link.'
                    : resetStatus.startsWith('error:')
                    ? resetStatus.slice(6)
                    : `We'll email a one-time reset link to ${auth.email}.`}
                </div>
              </div>
              <button
                className="btn btn-sm"
                disabled={resetStatus === 'sending'}
                onClick={handleResetPassword}
              >
                {resetStatus === 'sending' ? 'Sending…' : resetStatus === 'sent' ? 'Resend' : 'Reset password'}
              </button>
            </div>
          </div>
        </section>

        {/* Save bar */}
        <div className={'save-bar ' + (dirty || flash ? 'show' : '')}>
          <div className="save-bar-inner">
            {flash ? (
              <>
                <Icon name="check" size={14}/>
                <span>{flash}</span>
              </>
            ) : (
              <>
                <Icon name="sparkles" size={13}/>
                <span>Unsaved changes</span>
                <span className="spacer"/>
                <button className="btn btn-sm btn-ghost" onClick={revert} disabled={saving}>Discard</button>
                <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export { ProfileView };
