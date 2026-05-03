/* eslint-disable */
/* Sidebar — three modes:
   - Guest: a teaser nav + Log In button.
   - Brand owner: per-brand workflow nav scoped to their active brand.
   - Agency: same per-brand nav when working in a brand, OR Inbox + All-tasks
     when the brand picker is set to "All clients."

   The L+R Agency wordmark stays at the top regardless. The BrandPicker
   sits below it once signed in and drives every other surface's scope. */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import MOCK from '../lib/mockData.js';
import { BrandPicker } from './BrandPicker.jsx';

// -------- Nav configurations -------------------------------------------

// Brand-owner / agency-in-a-brand nav. Differences:
//   - "Request" hides for agency users
//   - "Tasks" is agency-only — the brand-side workflow doesn't currently use
//     the briefs/tasks surface, so we hide it from brand owners' sidebar.
//     The route still resolves if anyone deep-links to it; this is purely
//     a sidebar-visibility change. (Deleting the view is deferred.)
//   - Agency users see "Trends Radar" under Library and an "L+R Team" entry
//     below "Brand team" so the two team surfaces aren't confused.
const buildBrandNav = ({ taskCount, calendarUnreadCount, isAgency }) => {
  const primary = [
    { key: "calendar", label: "Social Calendar", icon: "calendar", badge: calendarUnreadCount || undefined },
    ...(isAgency
      ? [{ key: "tasks", label: "Tasks", icon: "folder", badge: taskCount || undefined }]
      : []),
    { key: "brand", label: "Brand Intelligence", icon: "brand" },
    { key: "library", label: "Library", icon: "library" },
  ];
  if (isAgency) {
    // Trends Radar is agency-only and sits directly under Library in the
    // primary nav — the agency uses it daily as part of their content
    // workflow, alongside Calendar / Tasks / Brand / Library.
    primary.push({ key: "trends", label: "Trends Radar", icon: "sparkles" });
  }
  if (!isAgency) {
    primary.push({ key: "home", label: "Request", icon: "send" });
  }
  const secondary = [
    { key: "performance", label: "Performance", icon: "chart" },
    { key: "team", label: "Brand team", icon: "team" },
  ];
  if (isAgency) {
    secondary.push({ key: "members", label: "L+R Team", icon: "team" });
  }
  return { primary, secondary };
};

// Agency "All clients" nav — only the cross-client surfaces.
const buildAllClientsNav = (taskCount) => ({
  primary: [
    { key: "home", label: "Inbox", icon: "home" },
    { key: "tasks", label: "All tasks", icon: "folder", badge: taskCount || undefined },
    // Trends Radar is also useful from All-clients mode (cross-brand
    // insight), so it shows up in both contexts. Primary block matches
    // the placement when an agency user is inside a brand.
    { key: "trends", label: "Trends Radar", icon: "sparkles" },
  ],
  secondary: [],
});

const GUEST_NAV = [
  { key: "calendar", label: "Social Calendar", icon: "calendar" },
  { key: "home", label: "Request", icon: "send" },
];

// -------- Component ----------------------------------------------------

const Sidebar = ({
  route, setRoute,
  mode, setMode,
  onSignOut, tweaks, setTweaks,
  auth, onRequestLogin,
  taskCount = 0,
  calendarUnreadCount = 0,
  // BrandPicker props
  activeAdminBrandId,
  brandAccounts,
  isAllClientsMode,
  onSelectBrand,
  onCreateBrand,
  onManageClients,
}) => {
  const isGuest = !auth;
  const isAgency = !!auth?.isAgency;

  // Pick the right nav config for the current context.
  const navConfig = (() => {
    if (isGuest) return { primary: GUEST_NAV, secondary: [] };
    if (isAgency && isAllClientsMode) return buildAllClientsNav(taskCount);
    return buildBrandNav({ taskCount, calendarUnreadCount, isAgency });
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
    ? "L+R Agency"
    : (auth?.account?.name || (auth?.email ? auth.email : ""));

  return (
    <aside className="sidebar" data-guest={isGuest ? "true" : "false"}>
      <div className="sidebar-brand">
        <span className="dot" />
        <span>L+R</span>
        <span className="wordmark-tail">Agency</span>
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
          onManageClients={onManageClients}
        />
      )}

      <nav className="nav">
        {primaryItems.map((n) => (
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
              onClick={() => setRoute({ view: n.key })}
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

              {/* Manage-clients lives in the BrandPicker dropdown; L+R
                  Team is in the sidebar nav for agency users. Profile
                  menu stays focused on personal account actions. */}
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
