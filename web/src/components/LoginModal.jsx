/* eslint-disable */
/* Login modal — compact centered dialog that opens over the Home screen
   when a guest tries to submit a brief (or clicks Log In in the sidebar).
   Backed by real Supabase Auth. */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import {
  signInWithPassword,
  signUpBrand,
  signUpForInvite,
  signInWithGoogle,
} from '../lib/auth.js';
import { previewInvitation } from '../lib/db.js';

const GoogleGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.5 1.2 8.9 3.2l6.6-6.6C35.5 2.3 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.7 6c1.9-5.6 7.2-9.8 13.7-9.8z"/>
    <path fill="#4285F4" d="M46.6 24.6c0-1.6-.2-3.1-.5-4.6H24v9.1h12.8c-.6 3-2.3 5.5-4.9 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17.5z"/>
    <path fill="#FBBC05" d="M10.3 28.7c-.5-1.4-.7-2.9-.7-4.7s.3-3.3.7-4.7l-7.7-6C.9 16.3 0 20 0 24s.9 7.7 2.6 10.7l7.7-6z"/>
    <path fill="#34A853" d="M24 48c6.1 0 11.2-2 15-5.5l-7.5-5.8c-2 1.4-4.7 2.3-7.5 2.3-6.5 0-12-4.3-13.9-10.2l-7.7 6C6.5 42.6 14.6 48 24 48z"/>
  </svg>
);
const AppleGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M17.6 12.6c0-2.3 1.9-3.5 2-3.6-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.9-3.6.9-.8 0-1.9-.9-3.1-.8-1.6 0-3.1.9-3.9 2.3-1.7 2.9-.4 7.2 1.2 9.6.8 1.2 1.7 2.5 3 2.5 1.2 0 1.6-.8 3.1-.8s1.8.8 3.1.8 2.1-1.2 2.9-2.4c.6-.9 1-1.8 1.3-2.7-1.3-.5-2.6-1.8-2.6-4zM14.8 4.8c.7-.8 1.2-1.9 1-3-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.8-1.1 2.9 1.1.1 2.2-.6 3-1.4z"/>
  </svg>
);

const LoginModal = ({ open, onClose, onSignedIn, initialMode = "signin", reason = null }) => {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [invitePreview, setInvitePreview] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (open) {
      setErr("");
      setInfo("");
      setLoading(false);
      setMode(initialMode);
    }
  }, [open, initialMode]);

  // If there's a pending invite in session, fetch its details and lock the UI to it.
  useEffect(() => {
    if (!open) return;
    const token = localStorage.getItem('lr_pending_invite');
    if (!token) { setInvitePreview(null); return; }
    let cancelled = false;
    previewInvitation(token)
      .then((preview) => {
        if (cancelled || !preview) return;
        setInvitePreview(preview);
        setEmail(preview.email);
        setMode('signup'); // new accepters almost always sign up; they can flip to sign-in if they have one
      })
      .catch(() => { /* invalid/expired token — ignore, backstop RPC will reject on accept */ });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    if (!email || !email.includes("@")) { setErr("Enter a valid email."); return; }
    if (!password || password.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (mode === "signup" && !name.trim()) { setErr("What should we call you?"); return; }
    if (mode === "signup" && !invitePreview && !brandName.trim()) { setErr("What's the brand name?"); return; }

    setLoading(true);
    try {
      let profile = null;
      if (mode === "signin") {
        profile = await signInWithPassword({ email, password });
        // No role toggle — every auth flow is identical. If the signed-in
        // user is on the agency via invite, auth.js detects that and sets
        // workspace='admin' automatically; same email-based invite auto-
        // accept runs here too, so pending invites redeem on this sign-in.
      } else if (invitePreview) {
        // Bare signup — accept_invitation (run by App.jsx on auth change)
        // adds them to the invited account; no create_brand_account call.
        const res = await signUpForInvite({ email, password, displayName: name });
        if (res.pendingConfirmation) {
          setInfo("Check your email to confirm your account, then sign in to accept the invite.");
          setLoading(false);
          return;
        }
        profile = res.profile;
      } else {
        // Fresh signup → creates a brand account. If this email has a
        // pending agency/brand invite waiting, auth.js will auto-accept it
        // after the session lands and promote them accordingly.
        const res = await signUpBrand({ email, password, displayName: name, brandName });
        if (res.pendingConfirmation) {
          setInfo("Check your email to confirm your account, then sign in to finish setup.");
          setLoading(false);
          return;
        }
        profile = res.profile;
      }
      setLoading(false);
      if (profile) {
        onSignedIn?.(profile);
        onClose?.();
      }
    } catch (caught) {
      setLoading(false);
      setErr(caught?.message || "Something went wrong. Try again.");
    }
  };

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="login-modal-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>

        <div className="login-modal-head">
          <div className="login-modal-brand">
            <span className="dot" />
            <span>L+R</span>
            <span className="wordmark-tail">Studio</span>
          </div>
          {reason && (
            <div className="login-modal-reason">
              <Icon name="sparkles" size={13} />
              <span>{reason}</span>
            </div>
          )}
          {invitePreview && (
            <div
              className="login-modal-reason"
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--accent-ink)',
                marginTop: reason ? 6 : 0,
              }}
            >
              <Icon name="team" size={13} />
              <span>
                Joining <strong>{invitePreview.accountName}</strong>
                {invitePreview.accountType === 'agency' ? ' · agency team' : ' · brand team'}
              </span>
            </div>
          )}
          <h2 id="login-modal-title" className="login-modal-title">
            {mode === "signin" ? (
              <>Sign in to <em>send your brief</em></>
            ) : (
              <>Create your <em>workspace</em></>
            )}
          </h2>
          <p className="login-modal-sub">
            {mode === "signin"
              ? "Your draft is saved — we'll pick right back up."
              : "Takes a minute. Your draft brief is waiting on the other side."}
          </p>
        </div>

        <div className="login-modal-body">
          <div className="login-modal-oauth">
            <button
              type="button"
              className="oauth-btn"
              onClick={async () => {
                setErr("");
                try { await signInWithGoogle(); }
                catch (ex) { setErr(ex.message || "Google sign-in failed — is it enabled in Supabase?"); }
              }}
            >
              <GoogleGlyph />
              <span>Continue with Google</span>
            </button>
          </div>

          <div className="auth-divider"><span>or with email</span></div>

          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === "signup" && (
              <label className="auth-field">
                <span>Your name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Maya Okafor"
                  autoFocus
                />
              </label>
            )}
            {mode === "signup" && !invitePreview && (
              <label className="auth-field">
                <span>Brand name</span>
                <input
                  type="text"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Luma"
                />
              </label>
            )}
            <label className="auth-field">
              <span>Work email{invitePreview ? ' · locked to invite' : ''}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus={mode === "signin"}
                readOnly={!!invitePreview}
                style={invitePreview ? {background: 'var(--surface-2)', cursor: 'not-allowed'} : undefined}
              />
            </label>
            <label className="auth-field">
              <span className="auth-field-row">
                Password
                {mode === "signin" && (
                  <a className="auth-link" onClick={(e) => e.preventDefault()}>Forgot?</a>
                )}
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </label>

            {err && <div className="auth-err">{err}</div>}
            {info && <div className="auth-err" style={{background: 'var(--good-soft, #E2F0E7)', color: 'var(--good, #2F7D53)'}}>{info}</div>}

            <button
              type="submit"
              className="btn btn-primary btn-lg auth-submit"
              disabled={loading}
            >
              {loading ? "One moment…" : mode === "signin" ? "Sign in & send brief" : "Create & send brief"}
              {!loading && <Icon name="arrow-right" size={14} />}
            </button>
          </form>
        </div>

        <div className="login-modal-foot">
          {mode === "signin" ? (
            <>New here? <button type="button" className="auth-link" onClick={() => setMode("signup")}>Create an account</button></>
          ) : (
            <>Have an account? <button type="button" className="auth-link" onClick={() => setMode("signin")}>Sign in instead</button></>
          )}
        </div>
      </div>
    </div>
  );
};

export { LoginModal };
