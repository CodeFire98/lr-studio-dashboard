/* eslint-disable */
/* Auth — Login / Signup gate shown before the app when lr_auth is absent. */
import React, { useState } from 'react';
import { Icon } from './Icon.jsx';
import {
  readAgencyAccounts,
  writeAgencyAccounts,
  findAgencyAccount,
  writeAuth,
} from '../lib/auth.js';

const LoginScreen = ({ onSignedIn, defaultMode = "signin" }) => {
  const [mode, setMode] = useState(defaultMode); // "signin" | "signup"
  const [email, setEmail] = useState("maya@luma.co");
  const [password, setPassword] = useState("••••••••••");
  const [name, setName] = useState("");
  const [role, setRole] = useState("customer"); // "customer" | "admin"
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    setErr("");
    if (!email || !email.includes("@")) { setErr("Enter a valid email."); return; }
    if (!password || password.length < 4) { setErr("Password too short."); return; }
    if (mode === "signup" && !name.trim()) { setErr("What should we call you?"); return; }

    setLoading(true);
    // Simulated auth — pick the right persona based on role + email
    setTimeout(() => {
      let profile;
      // Exclusive workspaces: brand and agency accounts don't overlap.
      if (role === "admin") {
        // Validate against the agency registry when signing in.
        if (mode === "signin") {
          const acct = findAgencyAccount(email);
          if (!acct || acct.password !== password) {
            setLoading(false);
            setErr("That email + password isn't on the agency roster. Ask your owner for an invite.");
            return;
          }
          profile = {
            id: "u_" + acct.email.replace(/[^a-z0-9]/gi, "_"),
            name: acct.name,
            initials: initialsFrom(acct.name),
            role: acct.role,
            email: acct.email,
            avatarColor: acct.avatarColor || "#2B2B2E",
            workspace: "admin",
          };
        } else {
          // Signup as agency: only the owner seat can self-create; others must be invited.
          const existing = findAgencyAccount(email);
          if (!existing) {
            setLoading(false);
            setErr("New agency workspaces are invite-only. Ask your owner to send an invite.");
            return;
          }
          if (existing.password !== password) {
            // Accept first-login password setting for invited users.
            const list = readAgencyAccounts().map((u) =>
              u.email.toLowerCase() === existing.email.toLowerCase()
                ? { ...u, password, name: name.trim() || u.name, status: "active" }
                : u
            );
            writeAgencyAccounts(list);
          }
          const acct = findAgencyAccount(email);
          profile = {
            id: "u_" + acct.email.replace(/[^a-z0-9]/gi, "_"),
            name: name.trim() || acct.name,
            initials: initialsFrom(name.trim() || acct.name),
            role: acct.role,
            email: acct.email,
            avatarColor: acct.avatarColor || "#2B2B2E",
            workspace: "admin",
          };
        }
      } else {
        profile = {
          id: "u_maya",
          name: mode === "signup" ? name.trim() : "Maya Okafor",
          initials: initialsFrom(mode === "signup" ? name.trim() : "Maya Okafor"),
          role: mode === "signup" ? "Brand Lead" : "Brand Lead, Luma",
          email,
          avatarColor: "#E8553D",
          workspace: "customer",
        };
      }
      profile.signedInAt = new Date().toISOString();
      profile.remember = remember;
      writeAuth(profile);
      // Align app mode to role
      localStorage.setItem("lr_mode", profile.workspace);
      setLoading(false);
      onSignedIn?.(profile);
    }, 650);
  };

  return (
    <div className="auth-shell">
      {/* Left: marketing panel */}
      <aside className="auth-aside">
        <div className="auth-brand">
          <span className="dot" />
          <span>L+R</span>
          <span className="wordmark-tail">Studio</span>
        </div>

        <div className="auth-quote">
          <div className="auth-kicker">Welcome back</div>
          <h1>
            A <em>quieter</em> way<br/>to make the work.
          </h1>
          <p>
            Brief. Review. Deliver. Your agency and your brand,
            in one calm room.
          </p>

          <div className="auth-marks">
            {[
              { k: "Luma", c: "#E8553D" },
              { k: "North Loop", c: "#6579BE" },
              { k: "Aster", c: "#3E8864" },
              { k: "Farrow", c: "#C88A3F" },
              { k: "Oya", c: "#8B5CF6" },
            ].map((b) => (
              <span key={b.k} className="auth-mark">
                <span className="auth-mark-dot" style={{background: b.c}} />
                {b.k}
              </span>
            ))}
          </div>
        </div>

        <div className="auth-foot">
          <span>© 2026 L+R Studio</span>
          <span className="dot-sep">·</span>
          <a>Privacy</a>
          <a>Terms</a>
          <a>Status</a>
        </div>
      </aside>

      {/* Right: form */}
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-seg">
            <button
              className={mode === "signin" ? "on" : ""}
              onClick={() => { setMode("signin"); setErr(""); }}
              type="button"
            >Sign in</button>
            <button
              className={mode === "signup" ? "on" : ""}
              onClick={() => { setMode("signup"); setErr(""); }}
              type="button"
            >Create account</button>
          </div>

          <h2 className="auth-title">
            {mode === "signin" ? "Sign in to your workspace" : "Make a new workspace"}
          </h2>
          <p className="auth-sub">
            {mode === "signin"
              ? "Pick up where you left off."
              : "You can invite your team once you're in."}
          </p>

          <div className="auth-oauth">
            <button type="button" className="oauth-btn" onClick={handleSubmit}>
              <GoogleGlyph />
              <span>Continue with Google</span>
            </button>
            <button type="button" className="oauth-btn" onClick={handleSubmit}>
              <AppleGlyph />
              <span>Continue with Apple</span>
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

            <label className="auth-field">
              <span>Work email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </label>

            <label className="auth-field">
              <span className="auth-field-row">
                Password
                {mode === "signin" && (
                  <a className="auth-link" onClick={(e) => { e.preventDefault(); }}>
                    Forgot?
                  </a>
                )}
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 8 characters" : ""}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </label>

            <div className="auth-field">
                <span>{mode === "signup" ? "I'm joining as" : "I'm signing in as"}</span>
                <div className="auth-role">
                  <button
                    type="button"
                    className={role === "customer" ? "on" : ""}
                    onClick={() => setRole("customer")}
                  >
                    <Icon name="brand" size={14}/>
                    <div>
                      <div className="auth-role-t">A brand</div>
                      <div className="auth-role-s">Brief your agency, review work</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={role === "admin" ? "on" : ""}
                    onClick={() => setRole("admin")}
                  >
                    <Icon name="sparkles" size={14}/>
                    <div>
                      <div className="auth-role-t">An agency</div>
                      <div className="auth-role-s">Deliver creative, manage clients</div>
                    </div>
                  </button>
                </div>
              </div>

            <div className="auth-row-between">
              <label className="auth-check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>Keep me signed in</span>
              </label>
              {mode === "signin" && (
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => setMode("signup")}
                >
                  No account yet?
                </button>
              )}
            </div>

            {err && <div className="auth-err">{err}</div>}

            <button
              type="submit"
              className="btn btn-primary btn-lg auth-submit"
              disabled={loading}
            >
              {loading
                ? "One moment…"
                : mode === "signin" ? "Sign in" : "Create workspace"}
              {!loading && <Icon name="arrow-right" size={14}/>}
            </button>

            <p className="auth-fineprint">
              By continuing you agree to our <a>Terms</a> and <a>Privacy&nbsp;Policy</a>.
              This is a prototype — no real account is created.
            </p>
          </form>
        </div>
      </main>
    </div>
  );
};

function initialsFrom(n) {
  if (!n) return "?";
  const parts = n.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

/* Small inline brand glyphs so we don't pull logos from third parties. */
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

export { LoginScreen };
