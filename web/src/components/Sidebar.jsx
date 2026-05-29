/* eslint-disable */
/* Sidebar — three modes:
   - Guest: a teaser nav + Log In button.
   - Brand owner: per-brand workflow nav scoped to their active brand.
   - Agency: same per-brand nav when working in a brand. In All-clients
     mode the sidebar nav is empty — every workflow lives inside a brand
     (Trends Radar moved to /c/:slug/trends), so the BrandPicker is the
     only meaningful affordance.

   The Linkrunner Media wordmark stays at the top regardless. The BrandPicker
   sits below it once signed in and drives every other surface's scope. */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import MOCK from '../lib/mockData.js';
import { BrandPicker } from './BrandPicker.jsx';

// -------- Nav configurations -------------------------------------------

// Brand-owner / agency-in-a-brand nav.
// Layout (re-ordered 2026-05-21 — LinkAI surfaced + active-work group on top):
//   Active surfaces (high-frequency daily use):
//     - Social Calendar
//     - LinkAI                  ← new full-page AI surface (also still
//                                  reachable via the topbar "✨ LinkAI"
//                                  trigger as a right-side panel)
//     - Conversations
//     - Live posts
//   ─── separator ────────────────────────────────────────────────────
//   Reference / setup (lower-frequency):
//     - Brand Intelligence
//     - Library
//     - Trends Radar             ← agency only
//     - Brand notes              ← long-term memory the AI reads on every
//                                  call; opened to brand in migration 0052
//     - Idea dump (Inbox for agency)
//
// Sentinel items with `sep: true` render as a thin divider in the loop.
// Tasks is gone from the sidebar — the product moved fully onto post plans.
const buildBrandNav = ({ ideaQueueCount, calendarUnreadCount, conversationsUnreadCount, isAgency }) => {
  const primary = [
    { key: "calendar", label: "Social Calendar", icon: "calendar", badge: calendarUnreadCount || undefined },
    { key: "linkai", label: "LinkAI", icon: "sparkles" },
    // One unified chat per brand — replaces the per-plan Conversation
    // tab. Brand sees a single thread with their agency; agency staff
    // see the same thread, scoped via BrandPicker.
    { key: "conversations", label: "Conversations", icon: "chat", badge: conversationsUnreadCount || undefined },
    { key: "posts", label: "Live posts", icon: "link" },
    { key: "sep_active", sep: true },
    { key: "brand", label: "Brand Intelligence", icon: "brand" },
    { key: "library", label: "Library", icon: "library" },
  ];
  if (isAgency) {
    // Agency-only entry — Trends Radar surfaces external signals
    // (added 2026-05-06). Stays agency-only for now.
    primary.push({ key: "trends", label: "Trends Radar", icon: "sparkles" });
  }
  primary.push({ key: "notes",  label: "Brand notes",  icon: "comment"  });
  primary.push(
    isAgency
      ? { key: "ideate", label: "Inbox", icon: "home", badge: ideaQueueCount || undefined }
      : { key: "ideate", label: "Idea dump", icon: "send" }
  );
  const secondary = [
    { key: "performance", label: "Performance", icon: "chart" },
    { key: "billing", label: "Billing", icon: "receipt" },
    { key: "team", label: isAgency ? "Brand team" : "Team", icon: "team" },
  ];
  if (isAgency) {
    secondary.push({ key: "members", label: "Linkrunner Team", icon: "team" });
  }
  return { primary, secondary };
};

// Agency "All clients" nav — empty. Every workflow is brand-scoped now,
// including Trends Radar (which moved to /c/:slug/trends on 2026-05-06).
// The empty sidebar pushes the agency to pick a brand to do anything
// meaningful. Selecting "All clients" in the BrandPicker navigates
// directly to /clients (AdminClientsView).
const buildAllClientsNav = () => ({
  primary: [],
  secondary: [],
});

const GUEST_NAV = [
  { key: "calendar", label: "Social Calendar", icon: "calendar" },
];

// -------- Component ----------------------------------------------------

const Sidebar = ({
  route, setRoute,
  mode, setMode,
  onSignOut, tweaks, setTweaks,
  auth, onRequestLogin,
  ideaQueueCount = 0,
  calendarUnreadCount = 0,
  conversationsUnreadCount = 0,
  // BrandPicker props
  activeAdminBrandId,
  brandAccounts,
  isAllClientsMode,
  onSelectBrand,
  onCreateBrand,
  // Mobile drawer props — default to behavior-preserving values so any
  // call site that doesn't pass them renders exactly as before. The
  // off-canvas pattern only kicks in at the 980px breakpoint where the
  // sidebar gets `transform: translateX(-100%)` by default; `.is-open`
  // flips it back. On desktop the transform is unset, so isOpen is
  // a no-op visually.
  isOpen = false,
  onClose,
}) => {
  const isGuest = !auth;
  const isAgency = !!auth?.isAgency;

  // Escape closes the drawer on mobile. No-op on desktop because the
  // sidebar isn't transformable there. We only mount the handler when
  // open so we don't fight any other escape consumers (modals, etc.).
  useEffect(() => {
    if (!isOpen || !onClose) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Wrap any nav-item click on mobile with onClose so the drawer auto-
  // dismisses after a tap. setRoute already navigates; we just chain
  // close. This is the smaller, more localized version of the
  // "auto-close on route change" effect inside App.jsx — that effect
  // is the authoritative one, this just adds snappy feedback so the
  // drawer slides shut the instant a nav-item is tapped instead of
  // after the next render.
  const handleNavClick = (key) => {
    setRoute({ view: key });
    if (onClose) onClose();
  };

  // Pick the right nav config for the current context.
  const navConfig = (() => {
    if (isGuest) return { primary: GUEST_NAV, secondary: [] };
    if (isAgency && isAllClientsMode) return buildAllClientsNav();
    return buildBrandNav({ ideaQueueCount, calendarUnreadCount, conversationsUnreadCount, isAgency });
  })();
  const primaryItems = navConfig.primary;
  const secondaryItems = navConfig.secondary;

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
  const persona = isAgency ? MOCK.people.admin : MOCK.people.you;
  const user = !auth ? null : {
    id: auth.id || persona.id,
    name: auth.name || persona.name,
    initials: auth.initials || persona.initials,
    avatarColor: auth.avatarColor || persona.avatarColor,
    email: auth.email || persona.email,
    role: auth.title || auth.role || persona.role,
  };

  // Subtitle line under the user pill — different for agency vs brand.
  const planLine = isAgency
    ? "Linkrunner Media"
    : (auth?.account?.name || (auth?.email ? auth.email : ""));

  return (
    <>
      {/* Scrim sits as a sibling of the sidebar so a tap outside the
          drawer dismisses it. Only visible at mobile breakpoints when
          isOpen is true — CSS controls visibility via `.is-open`. */}
      <div
        className={'sidebar-scrim' + (isOpen ? ' is-open' : '')}
        onClick={onClose}
        aria-hidden="true"
      />
    <aside
      className={'sidebar' + (isOpen ? ' is-open' : '')}
      data-guest={isGuest ? "true" : "false"}
      aria-hidden={isOpen ? undefined : undefined /* purely visual on desktop */}
    >
      {/* Close button shown only in the mobile drawer — desktop hides it
          via CSS. Gives a tappable affordance inside the drawer so users
          aren't reliant on the scrim or the hamburger to dismiss. */}
      {onClose && (
        <button
          type="button"
          className="sidebar-drawer-close"
          onClick={onClose}
          aria-label="Close menu"
        >
          <Icon name="x" size={18} />
        </button>
      )}
      <div className="sidebar-brand">
        <span className="dot" />
        <span>Linkrunner</span>
        <span className="wordmark-tail">Media</span>
      </div>

      {/* Brand picker — drives the scope of every surface below. Only
          visible when signed in; guests don't have brand context. */}
      {!isGuest && (
        <BrandPicker
          isAgency={isAgency}
          activeAdminBrandId={activeAdminBrandId}
          brandAccounts={brandAccounts}
          auth={auth}
          onSelectBrand={onSelectBrand}
          onCreateBrand={onCreateBrand}
        />
      )}

      <nav className="nav">
        {primaryItems.map((n) =>
          n.sep ? (
            <div key={n.key} className="nav-sep" aria-hidden />
          ) : (
            <button
              key={n.key}
              className={"nav-item " + (route.view === n.key ? "active" : "")}
              onClick={() => handleNavClick(n.key)}
            >
              <Icon name={n.icon} size={16} />
              <span>{n.label}</span>
              {n.badge && <span className="badge-count">{n.badge}</span>}
            </button>
          )
        )}
      </nav>

      {/* Guest teaser — features locked behind login */}
      {isGuest && (
        <div className="sidebar-guest-teaser">
          <div className="teaser-label">With an account</div>
          <ul>
            <li><Icon name="send" size={12}/><span>Drop ideas to your agency</span></li>
            <li><Icon name="brand" size={12}/><span>Build your brand intelligence</span></li>
            <li><Icon name="chart" size={12}/><span>See performance</span></li>
          </ul>
        </div>
      )}

      <div className="sidebar-spacer" />

      {/* Bottom-pinned secondary nav (Performance, Team). Hidden in
          All-clients mode — those surfaces are per-brand. */}
      {secondaryItems.length > 0 && (
        <nav className="nav nav-secondary">
          {secondaryItems.map((n) => (
            <button
              key={n.key}
              className={"nav-item " + (route.view === n.key ? "active" : "")}
              onClick={() => handleNavClick(n.key)}
            >
              <Icon name={n.icon} size={16} />
              <span>{n.label}</span>
              {n.badge && <span className="badge-count">{n.badge}</span>}
            </button>
          ))}
        </nav>
      )}

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

              {/* L+R Team is in the sidebar nav for agency users. The
                  cross-client clients view is reachable by selecting
                  "All clients" in the BrandPicker (navigates directly
                  to /clients). Profile menu stays focused on personal
                  account actions. */}
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
    </>
  );
};

export { Sidebar };
