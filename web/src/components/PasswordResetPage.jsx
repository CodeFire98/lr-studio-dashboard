/* eslint-disable */
/* Landing page for Supabase's password-recovery email links.
   Supabase puts the recovery token in the URL hash; the client picks it up
   automatically (detectSessionInUrl: true). We just need to surface a form
   that calls supabase.auth.updateUser({ password }). */
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const PasswordResetPage = () => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [err, setErr] = useState('');

  // When Supabase redirects here with a recovery token, the auth client fires
  // PASSWORD_RECOVERY — at that point we know the session is primed.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setReady(true);
    });
    // If user lands here directly with an existing session, treat it as ready too.
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) setReady(true);
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (password.length < 6) { setErr('Pick a password that is at least 6 characters.'); return; }
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setStatus('loading');
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStatus('done');
    } catch (ex) {
      setStatus('error');
      setErr(ex.message || 'Could not update password.');
    }
  };

  const backToApp = () => {
    window.location.hash = '';
    window.location.search = '';
    window.location.pathname = '/';
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: 'var(--bg)',
      padding: 32,
    }}>
      <div style={{
        maxWidth: 440,
        width: '100%',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 16,
        padding: 32,
        boxShadow: 'var(--shadow-md)',
      }}>
        <div style={{fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-ink)', marginBottom: 8}}>
          L+R Studio
        </div>
        <h1 style={{
          fontFamily: 'var(--font-serif)', fontSize: 36, lineHeight: 1.1, margin: '0 0 10px',
        }}>
          Set a new password
        </h1>
        <p style={{fontSize: 13.5, color: 'var(--ink-3)', marginBottom: 20}}>
          {ready
            ? "You're signed in via the recovery link. Pick a new password below."
            : "Waiting for the reset link to authenticate… If this hangs, request a new link."}
        </p>

        {status === 'done' ? (
          <div>
            <div style={{
              padding: 14, borderRadius: 10,
              background: 'var(--good-soft)', color: 'var(--good)',
              fontSize: 13, marginBottom: 16,
            }}>
              Password updated. You can now head back into the app.
            </div>
            <button onClick={backToApp} className="btn btn-primary btn-lg auth-submit">
              Go to L+R Studio
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label className="auth-field">
              <span>New password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={!ready || status === 'loading'}
                autoFocus
              />
            </label>
            <label className="auth-field">
              <span>Confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={!ready || status === 'loading'}
              />
            </label>
            {err && <div className="auth-err">{err}</div>}
            <button
              type="submit"
              className="btn btn-primary btn-lg auth-submit"
              disabled={!ready || status === 'loading'}
              style={{marginTop: 12}}
            >
              {status === 'loading' ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export { PasswordResetPage };
