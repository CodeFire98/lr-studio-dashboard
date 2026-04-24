/* eslint-disable */
/* Sidebar — slim, icon + label, logo top, user bottom.
   Has TWO modes:
   - Guest (auth=null): shows ONLY the Home nav item, and a "Log In" button
     in the bottom-left (where the user pill normally lives).
   - Signed-in: full navigation + user popover w/ profile, theme, sign out. */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import MOCK from '../lib/mockData.js';

const buildNav = (taskCount) => [
  { key: "home", label: "Home", icon: "home" },
  { key: "tasks", label: "Tasks", icon: "folder", badge: taskCount || undefined },
  { key: "brand", label: "Brand Kit", icon: "brand" },
  { key: "library", label: "Library", icon: "library" },
  { key: "calendar", label: "Calendar", icon: "calendar" },
  { key: "performance", label: "Performance", icon: "chart" },
  { key: "team", label: "Team", icon: "team" },
  { key: "settings", label: "Settings", icon: "settings" },
];

const GUEST_NAV = [
  { key: "home", label: "Home", icon: "home" },
];

const buildAdminNav = (taskCount) => [
  { key: "home", label: "Inbox", icon: "home" },
  { key: "tasks", label: "All tasks", icon: "folder", badge: taskCount || undefined },
  { key: "team", label: "Clients", icon: "team" },
  { key: "members", label: "Team", icon: "team" },
];

const Sidebar = ({ route, setRoute, mode, setMode, onSignOut, tweaks, setTweaks, auth, onRequestLogin, taskCount = 0 }) => {
  const isGuest = !auth;
  const items = isGuest ? GUEST_NAV : (mode === "admin" ? buildAdminNav(taskCount) : buildNav(taskCount));
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Resolve displayed user (only used when signed in)
  const persona = mode === "admin" ? MOCK.people.admin : MOCK.people.you;
  const user = !auth ? null : {
    id: auth.id || persona.id,
    name: auth.name || persona.name,
    initials: auth.initials || persona.initials,
    avatarColor: auth.avatarColor || persona.avatarColor,
    email: auth.email || persona.email,
    role: auth.title || auth.role || persona.role,
  };
  const planLine = mode === "admin" ? "L+R Studio · Admin" : "Pro plan · 14 credits";

  return (
    <aside className="sidebar" data-guest={isGuest ? "true" : "false"}>
      <div className="sidebar-brand">
        <span className="dot" />
        <span>L+R</span>
        <span className="wordmark-tail">Studio</span>
      </div>

      <div className="nav-section-label">
        {isGuest ? "Welcome" : mode === "admin" ? "Studio" : "Workspace"}
      </div>
      <nav className="nav">
        {items.map((n) => (
          <button
            key={n.key}
            className={"nav-item " + (route.view === n.key ? "active" : "")}
            onClick={() => setRoute({ view: n.key })}
          >
            <Icon name={n.icon} size={16} />
            <span>{n.label}</span>
            {n.badge && <span className="badge-count">{n.badge}</span>}
          </button>
        ))}
      </nav>

      {/* Guest teaser — features locked behind login */}
      {isGuest && (
        <div className="sidebar-guest-teaser">
          <div className="teaser-label">With an account</div>
          <ul>
            <li><Icon name="folder" size={12}/><span>Track every task</span></li>
            <li><Icon name="brand" size={12}/><span>Save your brand kit</span></li>
            <li><Icon name="chart" size={12}/><span>See performance</span></li>
          </ul>
        </div>
      )}

      <div className="sidebar-spacer" />

      {/* Bottom slot: Log In button (guest) or user popover (signed-in) */}
      {isGuest ? (
        <button
          className="sidebar-login-btn"
          onClick={onRequestLogin}
          aria-label="Log in"
        >
          <span className="sidebar-login-icon"><Icon name="login" size={16}/></span>
          <span className="sidebar-login-label">Log In</span>
          <span className="sidebar-login-sub">or create account</span>
        </button>
      ) : (
        <div className="sidebar-user-wrap" ref={wrapRef}>
          <button
            className={"sidebar-user as-button " + (menuOpen ? "open" : "")}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Avatar person={user} />
            <div className="who">
              <div className="name">{user.name}</div>
              <div className="plan">{planLine}</div>
            </div>
            <Icon name="chevron-up" size={14} />
          </button>

          {menuOpen && (
            <div className="user-menu" role="menu">
              <div className="user-menu-head">
                <Avatar person={user} size="lg" />
                <div>
                  <div className="user-menu-name">{user.name}</div>
                  <div className="user-menu-sub">{user.email}</div>
                  <div className="user-menu-role">{user.role}</div>
                </div>
              </div>

              <div className="user-menu-group">
                <button
                  className="user-menu-item"
                  onClick={() => { setMenuOpen(false); setRoute({view: "profile"}); }}
                >
                  <Icon name="team" size={14}/>
                  <span>View profile</span>
                </button>
                <button
                  className="user-menu-item"
                  onClick={() => { setMenuOpen(false); setRoute({view: "settings"}); }}
                >
                  <Icon name="settings" size={14}/>
                  <span>Account settings</span>
                </button>
                <button
                  className="user-menu-item"
                  onClick={() => { setTweaks?.({...tweaks, dark: !tweaks?.dark}); }}
                >
                  <Icon name={tweaks?.dark ? "sun" : "moon"} size={14}/>
                  <span>{tweaks?.dark ? "Light theme" : "Dark theme"}</span>
                  <span className="kbd-hint">⌘⇧L</span>
                </button>
              </div>

              <div className="user-menu-sep"/>

              <div className="user-menu-group">
                <button className="user-menu-item danger" onClick={onSignOut}>
                  <Icon name="logout" size={14}/>
                  <span>Sign out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
};

export { Sidebar };
