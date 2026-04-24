/* eslint-disable */
/* App shell — routing, theme, tweaks protocol.
   NOTE: No longer gates on auth. Guests can freely use the Home screen;
   the Submit action in HomeView triggers a login modal when signed-out.
   Other views (Tasks, Brand Kit, etc.) also prompt login if a guest
   navigates to them — but the sidebar hides those routes for guests. */
import React, { useState, useEffect } from 'react';
import { Icon } from './components/Icon.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { TweaksPanel } from './components/TweaksPanel.jsx';
import { LoginModal } from './components/LoginModal.jsx';
import { HomeView } from './components/HomeView.jsx';
import { TasksView } from './components/TasksView.jsx';
import { TaskDetailView } from './components/TaskDetailView.jsx';
import { LibraryView } from './components/LibraryView.jsx';
import { PerformanceView } from './components/PerformanceView.jsx';
import { TeamView } from './components/TeamView.jsx';
import { BrandKitView } from './components/BrandKitView.jsx';
import { ProfileView } from './components/ProfileView.jsx';
import { CalendarView } from './components/CalendarView.jsx';
import { SettingsView } from './components/SettingsView.jsx';
import {
  AdminHome,
  AdminUploadView,
  AdminClientsView,
  AdminTeamView,
} from './components/admin.jsx';
import MOCK from './lib/mockData.js';
import { readAuth, writeAuth } from './lib/auth.js';
import { loadTasks, subscribeToTasks, updateTaskStatus, acceptInvitation } from './lib/db.js';
import { supabase } from './lib/supabase';

function useTweaks() {
  const [tweaks, setTweaks] = useState(window.LR_TWEAKS || {
    accent: "coral", density: "airy", dark: false, font: "geist-instrument", showBriefAssist: true, heroVariant: "gradient",
  });
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = tweaks.accent;
    root.dataset.density = tweaks.density;
    root.dataset.theme = tweaks.dark ? "dark" : "light";
    root.dataset.font = tweaks.font;
    try {
      window.parent.postMessage({ type: "__edit_mode_set_keys", edits: tweaks }, "*");
    } catch (e) {}
  }, [tweaks]);
  return [tweaks, setTweaks];
}

const App = () => {
  const [tweaks, setTweaks] = useTweaks();
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [auth, setAuth] = useState(() => readAuth());
  const [mode, setMode] = useState(() => localStorage.getItem("lr_mode") || "customer");
  // When an admin opens a client's workspace, we stash the admin identity here
  // and flip `mode` to "customer". Clicking "Return to L+R" restores it.
  const [impersonation, setImpersonation] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("lr_impersonation")) || null; } catch { return null; }
  });
  const [route, setRoute] = useState(() => {
    try { return JSON.parse(localStorage.getItem("lr_route")) || { view: "home" }; } catch { return { view: "home" }; }
  });
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  // Login modal state — opened whenever a guest tries a gated action.
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginReason, setLoginReason] = useState(null);
  const [inviteBanner, setInviteBanner] = useState(null); // { status: 'pending' | 'done' | 'error', text }
  // If the user was in the middle of something (like submitting a brief), stash
  // a callback to run after a successful sign-in.
  const [pendingAction, setPendingAction] = useState(null); // fn or null

  useEffect(() => { localStorage.setItem("lr_mode", mode); }, [mode]);
  useEffect(() => {
    if (impersonation) sessionStorage.setItem("lr_impersonation", JSON.stringify(impersonation));
    else sessionStorage.removeItem("lr_impersonation");
  }, [impersonation]);

  // Admin enters a client's workspace (read-only brand view).
  const enterClientView = (client) => {
    setImpersonation({
      adminAuth: auth,
      adminMode: "admin",
      client: { id: client.id, name: client.name },
    });
    setMode("customer");
    setRoute({ view: "home" });
  };
  const exitClientView = () => {
    if (!impersonation) return;
    setMode(impersonation.adminMode || "admin");
    setImpersonation(null);
    setRoute({ view: "team" });
  };
  useEffect(() => { localStorage.setItem("lr_route", JSON.stringify(route)); }, [route]);

  // If a guest's persisted route is not "home", snap them back.
  useEffect(() => {
    if (!auth && route.view !== "home") setRoute({ view: "home" });
  }, [auth]); // eslint-disable-line

  // React to auth changes fired from any file
  useEffect(() => {
    const onAuth = () => setAuth(readAuth());
    window.addEventListener("lr_auth_change", onAuth);
    return () => window.removeEventListener("lr_auth_change", onAuth);
  }, []);

  // Keep `mode` in sync with the authoritative `auth.workspace` whenever it
  // changes — critical for invitees, whose workspace flips from 'customer'
  // to 'admin' *after* sign-in when accept_invitation promotes their profile.
  // Impersonation intentionally diverges mode from auth.workspace, so we
  // respect that branch.
  useEffect(() => {
    if (impersonation) return;
    if (!auth?.workspace) return;
    if (auth.workspace !== mode) setMode(auth.workspace);
  }, [auth?.id, auth?.workspace, impersonation]);

  // Invite acceptance: if the URL has ?invite=<token>, stash it and prompt sign-in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('invite');
    if (!token) return;
    sessionStorage.setItem('lr_pending_invite', token);
    setInviteBanner({ status: 'pending', text: "You've been invited. Sign in (or create an account) with the email the invite was sent to." });
    // Strip ?invite from the URL so a reload doesn't re-trigger this branch.
    params.delete('invite');
    const next = window.location.pathname + (params.toString() ? `?${params.toString()}` : '') + window.location.hash;
    window.history.replaceState({}, '', next);
    if (!auth) {
      setLoginReason("Accept your invite to join the workspace.");
      setLoginOpen(true);
    }
  }, []); // eslint-disable-line

  // Once we have an auth session AND a pending invite token, redeem it.
  useEffect(() => {
    if (!auth) return;
    const token = sessionStorage.getItem('lr_pending_invite');
    if (!token) return;
    (async () => {
      try {
        await acceptInvitation(token);
        sessionStorage.removeItem('lr_pending_invite');
        setInviteBanner({ status: 'done', text: 'Invite accepted — welcome to the workspace.' });
        // Re-sync auth so the new workspace membership shows up in the UI.
        await supabase.auth.refreshSession();
        window.dispatchEvent(new Event('lr_auth_change'));
        setTimeout(() => setInviteBanner(null), 3500);
      } catch (e) {
        sessionStorage.removeItem('lr_pending_invite');
        setInviteBanner({ status: 'error', text: `Couldn't accept invite: ${e.message || e}` });
      }
    })();
  }, [auth?.id]);

  // Tweaks toolbar protocol
  useEffect(() => {
    const handler = (ev) => {
      if (ev.data?.type === "__activate_edit_mode") setTweaksOpen(true);
      if (ev.data?.type === "__deactivate_edit_mode") setTweaksOpen(false);
    };
    window.addEventListener("message", handler);
    try { window.parent.postMessage({ type: "__edit_mode_available" }, "*"); } catch (e) {}
    return () => window.removeEventListener("message", handler);
  }, []);

  // Load tasks from Supabase whenever we have an auth session; clear on sign-out.
  useEffect(() => {
    if (!auth) { setTasks([]); return; }
    let cancelled = false;
    setTasksLoading(true);
    loadTasks()
      .then((rows) => { if (!cancelled) setTasks(rows); })
      .catch((e) => { console.error('loadTasks failed', e); })
      .finally(() => { if (!cancelled) setTasksLoading(false); });
    return () => { cancelled = true; };
  }, [auth?.id]);

  // Realtime: stream inserts/updates/deletes into local state.
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = subscribeToTasks((evt) => {
      if (evt.type === 'INSERT') {
        setTasks((prev) => prev.some((t) => t.id === evt.task.id) ? prev : [evt.task, ...prev]);
      } else if (evt.type === 'UPDATE') {
        setTasks((prev) => prev.map((t) => (t.id === evt.task.id ? evt.task : t)));
      } else if (evt.type === 'DELETE') {
        setTasks((prev) => prev.filter((t) => t.id !== evt.id));
      }
    });
    return unsubscribe;
  }, [auth?.id]);

  // Optimistic local push used after a successful INSERT in HomeView.
  const pushTask = (p) =>
    setTasks((prev) => (prev.some((t) => t.id === p.id) ? prev : [p, ...prev]));

  // Status changes persist to DB; other patches stay local (threads, etc. — Phase 4).
  const updateTask = (id, patch) => {
    setTasks((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    if (patch?.status) {
      updateTaskStatus(id, patch.status).catch((e) => console.error('status update failed', e));
    }
  };

  const handleSignOut = () => {
    writeAuth(null);
    setAuth(null);
    setMode("customer");
    setRoute({view: "home"});
  };

  // Unified entry for any "this action needs an account" moment.
  const requireAuth = (reason, afterSignIn) => {
    if (auth) { afterSignIn?.(auth); return; }
    setLoginReason(reason || null);
    setPendingAction(() => afterSignIn || null);
    setLoginOpen(true);
  };

  const handleSignedIn = (profile) => {
    setAuth(profile);
    setMode(profile.workspace || "customer");
    setLoginOpen(false);
    // Run the stashed action (e.g. finish submitting the brief).
    const action = pendingAction;
    setPendingAction(null);
    if (typeof action === "function") {
      // Defer so state has settled.
      setTimeout(() => action(profile), 0);
    }
  };

  // ----- Breadcrumb for topbar -----
  const crumb = (() => {
    if (route.view === "profile") {
      return <><a onClick={() => setRoute({view: "home"})} style={{cursor: "pointer"}}>Home</a><span className="crumb-sep">/</span><strong>Profile</strong></>;
    }
    if (mode === "admin") {
      if (route.view === "home") return <><strong>Inbox</strong></>;
      if (route.view === "tasks" && route.id) {
        const p = tasks.find((x) => x.id === route.id);
        return <><span>Tasks</span><span className="crumb-sep">/</span><strong>{p?.title || "Task"}</strong></>;
      }
      if (route.view === "tasks") return <><strong>All tasks</strong></>;
      if (route.view === "library") return <><strong>Upload creatives</strong></>;
      if (route.view === "team") return <><strong>Clients</strong></>;
      if (route.view === "members") return <><strong>Team</strong></>;
      return <strong>{route.view}</strong>;
    }
    if (route.view === "home") return <><span>{auth ? "Luma" : "Welcome"}</span><span className="crumb-sep">/</span><strong>Home</strong></>;
    if (route.view === "tasks" && route.id) {
      const p = tasks.find((x) => x.id === route.id);
      return <><a onClick={() => setRoute({view: "tasks"})} style={{cursor: "pointer"}}>Tasks</a><span className="crumb-sep">/</span><strong>{p?.title || "Task"}</strong></>;
    }
    return <><strong>{(route.view).replace(/^./, (c) => c.toUpperCase())}</strong></>;
  })();

  // ----- Render view -----
  const renderView = () => {
    if (route.view === "profile") {
      if (!auth) return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
      return <ProfileView setRoute={setRoute} mode={mode} onSignOut={handleSignOut}/>;
    }
    if (auth && mode === "admin") {
      if (route.view === "home") return <AdminHome tasks={tasks} setRoute={setRoute}/>;
      if (route.view === "tasks" && route.id) return <TaskDetailView taskId={route.id} tasks={tasks} updateTask={updateTask} setRoute={setRoute} mode={mode}/>;
      if (route.view === "tasks") return <TasksView setRoute={setRoute} tasks={tasks} mode={mode}/>;
      if (route.view === "library") return <AdminUploadView tasks={tasks}/>;
      if (route.view === "team") return <AdminClientsView onOpenClient={enterClientView}/>;
      if (route.view === "members") return <AdminTeamView auth={auth}/>;
    }
    // Customer + guest views:
    if (route.view === "home") return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
    // Everything below here is auth-only — guests get snapped back to home by the effect above.
    if (!auth) return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
    if (route.view === "tasks" && route.id) return <TaskDetailView taskId={route.id} tasks={tasks} updateTask={updateTask} setRoute={setRoute} mode={mode}/>;
    if (route.view === "tasks") return <TasksView setRoute={setRoute} tasks={tasks} mode={mode}/>;
    if (route.view === "library") return <LibraryView/>;
    if (route.view === "performance") return <PerformanceView/>;
    if (route.view === "team") return <TeamView/>;
    if (route.view === "brand") return <BrandKitView/>;
    if (route.view === "calendar") return <CalendarView tasks={tasks} setRoute={setRoute}/>;
    if (route.view === "settings") return <SettingsView auth={auth} mode={mode}/>;
    return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
  };

  const onHome = route.view === "home" && mode !== "admin";
  const isGuest = !auth;

  return (
    <div
      className="app"
      data-screen-label={(isGuest ? "Guest/" : mode === "admin" ? "Admin/" : "Customer/") + route.view}
      data-guest={isGuest ? "true" : "false"}
    >
      <Sidebar
        route={route}
        setRoute={setRoute}
        mode={mode}
        setMode={setMode}
        onSignOut={handleSignOut}
        tweaks={tweaks}
        setTweaks={setTweaks}
        auth={auth}
        onRequestLogin={() => requireAuth(null, null)}
        taskCount={tasks.length}
      />
      <div className="main">
        {inviteBanner && (
          <div
            className="admin-banner"
            style={{
              background: inviteBanner.status === 'error' ? 'var(--accent-soft)' : 'var(--good-soft)',
              color: inviteBanner.status === 'error' ? 'var(--accent-ink)' : 'var(--good)',
            }}
          >
            <span className="dot"/>{inviteBanner.text}
          </div>
        )}
        {auth && mode === "admin" && (
          <div className="admin-banner">
            <span className="dot"/>Admin · L+R Studio view
            <span className="muted">· You're replying as {auth.name || MOCK.people.admin.name}</span>
          </div>
        )}
        {impersonation && mode !== "admin" && (
          <div className="admin-banner impersonation">
            <span className="dot"/>Viewing <strong style={{margin: "0 4px"}}>{impersonation.client.name}</strong> as L+R Studio
            <span className="muted">· Shadowing the client workspace</span>
            <span className="spacer"/>
            <button className="btn btn-sm" onClick={exitClientView}>
              <Icon name="chevron-left" size={12}/>Return to L+R
            </button>
          </div>
        )}
        {!onHome && (
          <div className="topbar">
            <div className="crumb">{crumb}</div>
            <div className="topbar-right">
              <div className="topbar-search" onClick={() => document.querySelector(".topbar-search input")?.focus()}>
                <Icon name="search" size={14}/>
                <input placeholder="Search tasks, briefs, creatives" style={{border: 0, background: "transparent", outline: "none", width: 180, fontSize: 13}}/>
                <kbd>⌘K</kbd>
              </div>
              <button className="btn btn-ghost" title="Theme" onClick={() => setTweaks({...tweaks, dark: !tweaks.dark})}>
                <Icon name={tweaks.dark ? "sun" : "moon"} size={15}/>
              </button>
              <button className="btn btn-ghost" title="Tweaks" onClick={() => setTweaksOpen((v) => !v)}>
                <Icon name="sliders" size={15}/>
              </button>
              {auth && mode !== "admin" && (
                <button className="btn btn-primary btn-sm" onClick={() => setRoute({view: "home"})}>
                  <Icon name="plus" size={13}/>New brief
                </button>
              )}
            </div>
          </div>
        )}
        {onHome && (
          <div style={{position: "absolute", top: 18, right: 24, zIndex: 5, display: "flex", gap: 8}}>
            {isGuest && (
              <button className="btn btn-primary btn-sm" onClick={() => requireAuth(null, null)}>
                <Icon name="login" size={13}/>Log In
              </button>
            )}
            <button className="btn btn-ghost" title="Theme" onClick={() => setTweaks({...tweaks, dark: !tweaks.dark})}>
              <Icon name={tweaks.dark ? "sun" : "moon"} size={15}/>
            </button>
            <button className="btn btn-ghost" title="Tweaks" onClick={() => setTweaksOpen((v) => !v)}>
              <Icon name="sliders" size={15}/>
            </button>
          </div>
        )}
        {renderView()}
      </div>
      {tweaksOpen && <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} onClose={() => setTweaksOpen(false)}/>}
      <LoginModal
        open={loginOpen}
        onClose={() => { setLoginOpen(false); setPendingAction(null); }}
        onSignedIn={handleSignedIn}
        reason={loginReason}
      />
    </div>
  );
};

// Brand and agency workspaces are exclusive — no swap hotkey.

export { App };
