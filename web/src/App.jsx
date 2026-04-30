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
import { PostPlanDetailView } from './components/PostPlanDetailView.jsx';
import { SettingsView } from './components/SettingsView.jsx';
import {
  AdminHome,
  AdminUploadView,
  AdminClientsView,
  AdminTeamView,
} from './components/admin.jsx';
import { BrandSelectView } from './components/BrandSelectView.jsx';
import { BrandOnboardingModal } from './components/BrandOnboardingModal.jsx';
import { ConfirmHost } from './components/ConfirmDialog.jsx';
import { CreateBrandHost } from './components/CreateBrandModal.jsx';
import MOCK from './lib/mockData.js';
import { readAuth, writeAuth, setActiveBrand } from './lib/auth.js';
import {
  loadTasks,
  subscribeToTasks,
  updateTaskStatus,
  acceptInvitation,
  loadBrandOnboardingStatus,
  completeBrandOnboarding,
  skipBrandOnboarding,
  loadPostPlans,
  subscribeToPostPlans,
  loadBrandAccounts,
  loadPostPlanUnreadCounts,
  subscribeToPostPlanActivity,
} from './lib/db.js';
import { supabase } from './lib/supabase';
import { ALL_CLIENTS } from './components/BrandPicker.jsx';
import { promptCreateBrand } from './components/CreateBrandModal.jsx';

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
  // Agency users navigate via a brand picker that scopes every surface to
  // one client (or the "All clients" pseudo-brand for cross-client views).
  // Persisted across reloads so users return to the brand they were on.
  const [activeAdminBrandId, setActiveAdminBrandIdState] = useState(() => {
    try { return localStorage.getItem("lr_admin_active_brand") || ALL_CLIENTS; }
    catch { return ALL_CLIENTS; }
  });
  // List of brand accounts for the picker dropdown (agency only).
  const [brandAccounts, setBrandAccounts] = useState([]);
  const [route, setRoute] = useState(() => {
    // Social Calendar is the universal landing surface — strangers loading
    // the page cold, customers signing in, and admins alike all start here.
    // Returning users with a saved route continue where they left off.
    try {
      const saved = JSON.parse(localStorage.getItem("lr_route"));
      if (saved && saved.view) return saved;
    } catch {}
    return { view: "calendar" };
  });
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  // Social Calendar — separate state so the brand can switch and we
  // refetch a single brand's plans without disturbing the (cross-brand)
  // task list that powers Tasks/Library.
  const [postPlans, setPostPlans] = useState([]);
  // Map<postPlanId, unreadCount> — drives the calendar red-dots and the
  // sidebar Social-Calendar badge total.
  const [unreadByPlan, setUnreadByPlan] = useState(() => new Map());

  // Login modal state — opened whenever a guest tries a gated action.
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginReason, setLoginReason] = useState(null);
  const [inviteBanner, setInviteBanner] = useState(null); // { status: 'pending' | 'done' | 'error', text }
  // If the user was in the middle of something (like submitting a brief), stash
  // a callback to run after a successful sign-in.
  const [pendingAction, setPendingAction] = useState(null); // fn or null

  // Brand onboarding modal: shown once per brand to its OWNER. Tracked by
  // brand_kits.onboarding_completed_at, so switching brands re-checks per brand.
  const [onboarding, setOnboarding] = useState({ open: false, kit: null, accountId: null });

  useEffect(() => { localStorage.setItem("lr_mode", mode); }, [mode]);

  // Persist active brand whenever the agency picker changes it.
  const setActiveAdminBrandId = (next) => {
    setActiveAdminBrandIdState(next);
    try {
      if (next && next !== ALL_CLIENTS) localStorage.setItem("lr_admin_active_brand", next);
      else localStorage.setItem("lr_admin_active_brand", ALL_CLIENTS);
    } catch {}
  };

  useEffect(() => { localStorage.setItem("lr_route", JSON.stringify(route)); }, [route]);

  // Guest sandbox: only the empty Social Calendar and the Request page are
  // accessible without an account. Anything else (Tasks, Library, etc.)
  // snaps the guest back to the calendar so locked surfaces never render
  // half-broken to a signed-out user.
  useEffect(() => {
    if (auth) return;
    const GUEST_ALLOWED = new Set(["calendar", "home"]);
    if (!GUEST_ALLOWED.has(route.view)) setRoute({ view: "calendar" });
  }, [auth, route.view]);

  // React to auth changes fired from any file
  useEffect(() => {
    const onAuth = () => setAuth(readAuth());
    window.addEventListener("lr_auth_change", onAuth);
    return () => window.removeEventListener("lr_auth_change", onAuth);
  }, []);

  // Keep `mode` in sync with the authoritative `auth.workspace`. The
  // routing layer no longer branches on `mode` (it uses `auth.isAgency` +
  // active-brand instead), but a few legacy components still read it.
  useEffect(() => {
    if (!auth?.workspace) return;
    if (auth.workspace !== mode) setMode(auth.workspace);
  }, [auth?.id, auth?.workspace]);

  // Invite acceptance: if the URL has ?invite=<token>, stash it and prompt sign-in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('invite');
    if (!token) return;
    localStorage.setItem('lr_pending_invite', token);
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
    const token = localStorage.getItem('lr_pending_invite');
    if (!token) return;
    (async () => {
      try {
        const newAccountId = await acceptInvitation(token);
        localStorage.removeItem('lr_pending_invite');
        setInviteBanner({ status: 'done', text: 'Invite accepted — welcome to the workspace.' });
        // Re-sync auth so the new workspace membership shows up in the UI.
        await supabase.auth.refreshSession();
        // Auto-switch to the brand they just joined — feels natural since they
        // clicked the invite link *for this brand*, not any other.
        if (newAccountId) {
          await setActiveBrand(newAccountId);
        } else {
          window.dispatchEvent(new Event('lr_auth_change'));
        }
        setTimeout(() => setInviteBanner(null), 3500);
      } catch (e) {
        localStorage.removeItem('lr_pending_invite');
        setInviteBanner({ status: 'error', text: `Couldn't accept invite: ${e.message || e}` });
      }
    })();
  }, [auth?.id]);

  // Email-based auto-accept: when auto_accept_pending_invitations() ran in
  // auth.js and redeemed any invites, `newlyJoinedAccountIds` is present on
  // the fresh auth profile. Show a welcome banner + switch to the first one.
  useEffect(() => {
    const ids = auth?.newlyJoinedAccountIds;
    if (!ids || ids.length === 0) return;
    const count = ids.length;
    const text = count === 1
      ? "Welcome — you've been added to a new workspace."
      : `Welcome — you've been added to ${count} new workspaces.`;
    setInviteBanner({ status: 'done', text });
    (async () => {
      try { await setActiveBrand(ids[0]); } catch {}
    })();
    // Clear the flag so this effect doesn't re-fire on future auth changes.
    try {
      const raw = localStorage.getItem('lr_auth');
      if (raw) {
        const parsed = JSON.parse(raw);
        delete parsed.newlyJoinedAccountIds;
        localStorage.setItem('lr_auth', JSON.stringify(parsed));
      }
    } catch {}
    setTimeout(() => setInviteBanner(null), 4000);
  }, [auth?.id, auth?.newlyJoinedAccountIds?.length]);

  // Brand-onboarding gate: when a brand owner lands on a brand they've
  // never set up, show the welcome modal once. Skip for agency users
  // (they manage clients, not their own brand) and for invitees (members).
  useEffect(() => {
    if (!auth) { setOnboarding({ open: false, kit: null, accountId: null }); return; }
    if (auth.isAgency) return;
    if (auth.requiresBrandSelection) return;
    const accountId = auth.account?.id;
    if (!accountId) return;
    if (auth.activeRole !== 'owner') return;
    let cancelled = false;
    loadBrandOnboardingStatus(accountId)
      .then(({ needsOnboarding, kit }) => {
        if (cancelled) return;
        if (needsOnboarding) setOnboarding({ open: true, kit, accountId });
        else setOnboarding({ open: false, kit: null, accountId: null });
      })
      .catch((e) => console.warn('onboarding status check failed', e));
    return () => { cancelled = true; };
  }, [auth?.id, auth?.account?.id, auth?.activeRole, auth?.isAgency, auth?.requiresBrandSelection]);

  const handleOnboardingComplete = async ({ brandName, patch }) => {
    await completeBrandOnboarding({ accountId: onboarding.accountId, brandName, patch });
    setOnboarding({ open: false, kit: null, accountId: null });
    // Brand name may have changed — re-hydrate auth so the sidebar/picker reflect it.
    try { await setActiveBrand(onboarding.accountId); } catch {}
    // Drop the user into Brand Intelligence so they can see everything we
    // captured during onboarding (esp. the Fetch-brand auto-fill output).
    setRoute({ view: "brand" });
    setInviteBanner({ status: 'done', text: 'Brand setup saved — your team has the context they need.' });
    setTimeout(() => setInviteBanner(null), 3500);
  };

  const handleOnboardingSkip = async () => {
    await skipBrandOnboarding(onboarding.accountId);
    setOnboarding({ open: false, kit: null, accountId: null });
  };

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

  // ----- Active brand resolution ---------------------------------------
  // For agency users, the active brand comes from the picker (or the
  // "All clients" sentinel). For brand users, it's the brand they're
  // signed into. `scopeAccountId` is null only for agency in All-clients
  // mode — in every other case it's the brand whose calendar/tasks/etc
  // we should be showing.
  const isAllClientsMode = !!auth?.isAgency && (activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId);
  const scopeAccountId = (() => {
    if (auth?.isAgency) {
      return isAllClientsMode ? null : activeAdminBrandId;
    }
    return auth?.account?.id || null;
  })();
  const calendarAccountId = scopeAccountId; // alias preserved for readability downstream
  const calendarRoleIsAdmin = !!auth?.isAgency;

  // Load tasks from Supabase whenever we have an auth session; clear on sign-out.
  // Filter by `scopeAccountId` — agency in All-clients mode sees everything;
  // agency in a brand sees that brand's tasks; brand owners see their brand.
  useEffect(() => {
    if (!auth) { setTasks([]); return; }
    // If a brand user hasn't picked a brand yet, don't load anything.
    if (auth.requiresBrandSelection) { setTasks([]); return; }
    let cancelled = false;
    setTasksLoading(true);
    loadTasks()
      .then((rows) => {
        if (cancelled) return;
        const scoped = scopeAccountId
          ? rows.filter((t) => t.accountId === scopeAccountId)
          : rows;
        setTasks(scoped);
      })
      .catch((e) => { console.error('loadTasks failed', e); })
      .finally(() => { if (!cancelled) setTasksLoading(false); });
    return () => { cancelled = true; };
  }, [auth?.id, scopeAccountId, auth?.requiresBrandSelection]);

  // Realtime: stream inserts/updates/deletes into local state.
  useEffect(() => {
    if (!auth) return;
    if (auth.requiresBrandSelection) return;
    const unsubscribe = subscribeToTasks((evt) => {
      const isRelevant = (task) => !scopeAccountId || task.accountId === scopeAccountId;
      if (evt.type === 'INSERT') {
        if (!isRelevant(evt.task)) return;
        setTasks((prev) => prev.some((t) => t.id === evt.task.id) ? prev : [evt.task, ...prev]);
      } else if (evt.type === 'UPDATE') {
        if (!isRelevant(evt.task)) return;
        setTasks((prev) => prev.map((t) => (t.id === evt.task.id ? evt.task : t)));
      } else if (evt.type === 'DELETE') {
        setTasks((prev) => prev.filter((t) => t.id !== evt.id));
      }
    });
    return unsubscribe;
  }, [auth?.id, scopeAccountId, auth?.requiresBrandSelection]);

  // Load the picker's brand list once per signed-in agency session.
  useEffect(() => {
    if (!auth?.isAgency) { setBrandAccounts([]); return; }
    let cancelled = false;
    loadBrandAccounts()
      .then((rows) => { if (!cancelled) setBrandAccounts(rows); })
      .catch((e) => console.warn('loadBrandAccounts failed', e));
    return () => { cancelled = true; };
  }, [auth?.id, auth?.isAgency]);

  // Snap the route when the picker switches contexts so the user never
  // sits on a route hidden in the new context. Routes legal in each:
  //   All clients (agency) — home (Inbox), tasks, profile, settings, clients, members
  //   In a brand          — calendar, tasks, brand, library, performance, team,
  //                          profile, settings, clients (still reachable for agency)
  useEffect(() => {
    if (!auth?.isAgency) return;
    const r = route.view;
    const allClientsRoutes = new Set(['home', 'tasks', 'profile', 'settings', 'clients', 'members']);
    const inBrandRoutes    = new Set(['calendar', 'plan', 'tasks', 'brand', 'library', 'performance', 'team', 'profile', 'settings', 'clients', 'members']);
    if (isAllClientsMode) {
      if (!allClientsRoutes.has(r)) setRoute({ view: 'home' });
    } else {
      if (!inBrandRoutes.has(r)) setRoute({ view: 'calendar' });
    }
  }, [auth?.isAgency, isAllClientsMode, route.view]);

  useEffect(() => {
    if (!auth || !calendarAccountId) { setPostPlans([]); return; }
    let cancelled = false;
    loadPostPlans({ accountId: calendarAccountId })
      .then((rows) => { if (!cancelled) setPostPlans(rows); })
      .catch((e) => { console.error('loadPostPlans failed', e); });
    return () => { cancelled = true; };
  }, [auth?.id, calendarAccountId]);

  useEffect(() => {
    if (!auth || !calendarAccountId) return;
    const unsubscribe = subscribeToPostPlans((evt) => {
      if (evt.type === 'DELETE') {
        setPostPlans((prev) => prev.filter((p) => p.id !== evt.id));
        return;
      }
      const next = evt.postPlan;
      if (!next) return;
      setPostPlans((prev) => {
        const idx = prev.findIndex((p) => p.id === next.id);
        if (idx === -1) return [...prev, next];
        const out = prev.slice();
        out[idx] = next;
        return out;
      });
    }, { accountId: calendarAccountId });
    return unsubscribe;
  }, [auth?.id, calendarAccountId]);

  // Recompute "unread activity" counts whenever the post plan list
  // changes, and re-tick on any new comment / attachment / plan edit via
  // realtime. Counts unread comments + attachments + plan edits made by
  // people other than the viewer since they last opened the plan.
  useEffect(() => {
    if (!auth?.id || postPlans.length === 0) {
      setUnreadByPlan(new Map());
      return;
    }
    let cancelled = false;
    const refresh = () => {
      loadPostPlanUnreadCounts({ userId: auth.id, postPlans })
        .then((counts) => { if (!cancelled) setUnreadByPlan(counts); })
        .catch((e) => console.warn('loadPostPlanUnreadCounts failed', e));
    };
    refresh();
    const unsub = subscribeToPostPlanActivity({ accountId: calendarAccountId }, refresh);
    return () => { cancelled = true; unsub?.(); };
  }, [auth?.id, calendarAccountId, postPlans.map((p) => `${p.id}:${p.updatedAt}`).join(',')]);

  // Optimistic local push used after a successful INSERT in HomeView.
  const pushTask = (p) =>
    setTasks((prev) => (prev.some((t) => t.id === p.id) ? prev : [p, ...prev]));

  // Post-plan optimistic mutators. Realtime (subscribeToPostPlans /
  // subscribeToPostPlanActivity) covers cross-tab sync, but same-tab
  // edits inside PostPlanDetailView shouldn't have to wait for the
  // round-trip — these update App-level state immediately so the
  // calendar reflects the change as soon as the user navigates back.
  const upsertPostPlan = (next) => {
    if (!next?.id) return;
    setPostPlans((prev) => {
      const idx = prev.findIndex((p) => p.id === next.id);
      if (idx === -1) return [...prev, next];
      const out = prev.slice();
      out[idx] = next;
      return out;
    });
  };
  const removePostPlanLocal = (planId) => {
    if (!planId) return;
    setPostPlans((prev) => prev.filter((p) => p.id !== planId));
    setUnreadByPlan((prev) => {
      if (!prev.has(planId)) return prev;
      const next = new Map(prev);
      next.delete(planId);
      return next;
    });
  };
  const clearUnreadForPlan = (planId) => {
    if (!planId) return;
    setUnreadByPlan((prev) => {
      if (!prev.has(planId)) return prev;
      const next = new Map(prev);
      next.delete(planId);
      return next;
    });
  };

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
    // Land on the Social Calendar after sign-out — it's the public-facing
    // surface guests can preview, and matches the universal landing rule.
    setRoute({view: "calendar"});
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
    // If the user has 2+ brand memberships and hasn't picked one yet, the
    // BrandSelectView is about to take over the screen — running a pending
    // submit now would fail with a null account.id and surface a misleading
    // "no brand workspace" alert. Drop the pending action and re-prompt
    // after they pick a brand (handled by the effect below).
    if (profile?.requiresBrandSelection) {
      setInviteBanner({ status: 'pending', text: 'Choose a brand workspace below, then resend your brief.' });
      setPendingAction(null);
      return;
    }
    const action = pendingAction;
    setPendingAction(null);
    if (typeof action === "function") {
      // Defer so state has settled. The action owns its own navigation
      // (e.g. submitting a brief opens the task detail), so don't force
      // calendar here.
      setTimeout(() => action(profile), 0);
    } else {
      // No pending action — drop a fresh sign-in onto the Social Calendar
      // so the universal landing rule holds whether you're a customer or
      // an admin. Returning users with a saved route already restored it
      // before this fires; we only override on an explicit sign-in event.
      setRoute({ view: "calendar" });
    }
  };

  // ----- Brand-picker handlers -----
  // Brand owners switch via auth.setActiveBrand (rehydrates auth profile).
  // Agency switches via local state — `auth.account` stays on the agency
  // workspace; only `activeAdminBrandId` moves.
  const handleSelectBrand = async (id) => {
    if (!id) return;
    if (auth?.isAgency) {
      setActiveAdminBrandId(id);
    } else {
      try { await setActiveBrand(id); }
      catch (e) { console.error('switch brand failed', e); }
    }
  };

  const handleCreateBrand = async () => {
    try {
      const newId = await promptCreateBrand();
      if (!newId) return null;
      // Agency: refresh the picker list so the new brand shows up.
      if (auth?.isAgency) {
        try {
          const rows = await loadBrandAccounts();
          setBrandAccounts(rows);
        } catch (e) { console.warn('refresh brand list failed', e); }
      }
      return newId;
    } catch (e) {
      console.error('create brand failed', e);
      return null;
    }
  };

  const handleManageClients = () => setRoute({ view: 'clients' });

  // ----- Breadcrumb for topbar -----
  const inAllClients = isAllClientsMode;
  const homeRoute = inAllClients ? "home" : "calendar";
  const homeLabel = inAllClients ? "Inbox" : "Social Calendar";
  const crumb = (() => {
    if (route.view === "profile") {
      return <><a onClick={() => setRoute({view: homeRoute})} style={{cursor: "pointer"}}>{homeLabel}</a><span className="crumb-sep">/</span><strong>Profile</strong></>;
    }
    if (route.view === "calendar") return <><strong>Social Calendar</strong></>;
    if (route.view === "plan") {
      const p = postPlans.find((x) => x.id === route.id);
      return <><a onClick={() => setRoute({view: "calendar"})} style={{cursor: "pointer"}}>Social Calendar</a><span className="crumb-sep">/</span><strong>{p?.concept || "Post plan"}</strong></>;
    }
    if (route.view === "home") {
      if (inAllClients) return <><strong>Inbox</strong></>;
      return <><span>{auth ? (auth.account?.name || "Workspace") : "Welcome"}</span><span className="crumb-sep">/</span><strong>Request</strong></>;
    }
    if (route.view === "tasks" && route.id) {
      const p = tasks.find((x) => x.id === route.id);
      return <><a onClick={() => setRoute({view: "tasks"})} style={{cursor: "pointer"}}>Tasks</a><span className="crumb-sep">/</span><strong>{p?.title || "Task"}</strong></>;
    }
    if (route.view === "tasks") return <><strong>{inAllClients ? "All tasks" : "Tasks"}</strong></>;
    if (route.view === "library") return <><strong>Library</strong></>;
    if (route.view === "clients") return <><strong>Clients</strong></>;
    if (route.view === "members") return <><strong>L+R Team</strong></>;
    if (route.view === "team") return <><strong>Team</strong></>;
    if (route.view === "brand") return <><strong>Brand Intelligence</strong></>;
    if (route.view === "settings") return <><strong>Settings</strong></>;
    if (route.view === "performance") return <><strong>Performance</strong></>;
    return <><strong>{(route.view).replace(/^./, (c) => c.toUpperCase())}</strong></>;
  })();

  // ----- Render view -----
  // Routing now branches on `auth.isAgency` + active-brand context, not
  // the legacy `mode` flag. There's no separate "admin workspace" anymore;
  // agency users either sit in "All clients" (Inbox + cross-client Tasks)
  // or in a specific brand (the same surfaces a brand owner sees).
  const renderView = () => {
    if (route.view === "profile") {
      if (!auth) return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
      return <ProfileView setRoute={setRoute} mode={mode} onSignOut={handleSignOut}/>;
    }

    // Agency-only management surfaces — reachable from the picker / profile menu.
    if (auth?.isAgency && route.view === "clients") {
      return <AdminClientsView onOpenClient={(c) => handleSelectBrand(c.id)}/>;
    }
    if (auth?.isAgency && route.view === "members") {
      return <AdminTeamView auth={auth}/>;
    }

    // Cross-client "All clients" mode — only Inbox + Tasks make sense here.
    if (auth?.isAgency && isAllClientsMode) {
      if (route.view === "tasks" && route.id) return <TaskDetailView taskId={route.id} tasks={tasks} updateTask={updateTask} setRoute={setRoute} mode={mode}/>;
      if (route.view === "tasks") return <TasksView setRoute={setRoute} tasks={tasks} mode={mode}/>;
      // Default for All-clients: AdminHome (the cross-client inbox).
      return <AdminHome tasks={tasks} setRoute={setRoute}/>;
    }

    // Calendar — visible to both signed-in users and guests (empty state).
    if (route.view === "calendar") return (
      <CalendarView
        postPlans={auth ? postPlans : []}
        accountId={auth ? calendarAccountId : null}
        userId={auth?.id}
        mode={calendarRoleIsAdmin ? 'admin' : 'customer'}
        setRoute={setRoute}
        unreadByPlan={unreadByPlan}
        onPlanCreated={upsertPostPlan}
      />
    );

    // Single post plan — full-page detail (replaces the old modal).
    if (auth && route.view === "plan" && route.id) return (
      <PostPlanDetailView
        postPlanId={route.id}
        postPlans={postPlans}
        userId={auth?.id}
        role={calendarRoleIsAdmin ? 'admin' : 'brand'}
        setRoute={setRoute}
        onPlanChanged={upsertPostPlan}
        onPlanDeleted={removePostPlanLocal}
        onPlanSeen={clearUnreadForPlan}
      />
    );

    // Guest fallback: empty calendar.
    if (!auth) return (
      <CalendarView
        postPlans={[]}
        accountId={null}
        userId={null}
        mode="customer"
        setRoute={setRoute}
      />
    );

    // In-a-brand surfaces — same code path for agency-shadowing-a-brand
    // and brand-owner-in-their-own-brand.
    if (route.view === "home") return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
    if (route.view === "tasks" && route.id) return <TaskDetailView taskId={route.id} tasks={tasks} updateTask={updateTask} setRoute={setRoute} mode={mode}/>;
    if (route.view === "tasks") return <TasksView setRoute={setRoute} tasks={tasks} mode={mode}/>;
    if (route.view === "library") return <LibraryView auth={auth} accountId={calendarAccountId}/>;
    if (route.view === "performance") return <PerformanceView accountId={calendarAccountId}/>;
    if (route.view === "team") return <TeamView overrideAccountId={auth?.isAgency ? calendarAccountId : null} />;
    if (route.view === "brand") return <BrandKitView accountId={calendarAccountId}/>;
    if (route.view === "settings") return <SettingsView auth={auth} mode={mode}/>;
    return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
  };

  // The legacy "Home" surface is the brand-owner Request page. Agency users
  // never see it (we hide Request from their nav and AllClients sends them
  // to Inbox instead) so this only ever fires for guests + brand owners.
  const onHome = route.view === "home" && !(auth?.isAgency && isAllClientsMode);
  const isGuest = !auth;

  // Brand-selection gate: show picker when a signed-in brand user belongs to
  // 2+ brands and hasn't picked one yet. Skip for agency and guests.
  // Note: rendered WITHOUT the `.app` wrapper — that's a grid with a sidebar
  // column that would squish the picker into a narrow strip.
  if (auth?.requiresBrandSelection) {
    return (
      <>
        <BrandSelectView auth={auth} onSelected={() => setAuth(readAuth())} />
        <CreateBrandHost />
      </>
    );
  }

  // Agency banner copy. In a brand: "Working in X · L+R Agency". In the
  // cross-client view: "All clients · L+R Agency". Brand owners never see it.
  const agencyBanner = (() => {
    if (!auth?.isAgency) return null;
    if (isAllClientsMode) return { label: 'All clients' };
    const brandName = (brandAccounts.find((b) => b.id === activeAdminBrandId)?.name) || 'Brand';
    return { label: `Working in ${brandName}` };
  })();

  // Brand-owner "New brief" CTA. Hidden for agency (they don't submit briefs)
  // and on the brand-owner Home view itself (the form lives there).
  const showNewBriefCta = !!auth && !auth.isAgency && route.view !== "home";

  return (
    <div
      className="app"
      data-screen-label={(isGuest ? "Guest/" : auth.isAgency ? "Agency/" : "Brand/") + route.view}
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
        calendarUnreadCount={Array.from(unreadByPlan.values()).reduce((a, b) => a + b, 0)}
        activeAdminBrandId={activeAdminBrandId}
        brandAccounts={brandAccounts}
        isAllClientsMode={isAllClientsMode}
        onSelectBrand={handleSelectBrand}
        onCreateBrand={handleCreateBrand}
        onManageClients={handleManageClients}
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
        {agencyBanner && (
          <div className="admin-banner">
            <span className="dot"/>{agencyBanner.label}
            <span className="muted">· L+R Agency</span>
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
              {showNewBriefCta && (
                <button className="btn btn-primary btn-sm" onClick={() => setRoute({view: "home"})}>
                  <Icon name="plus" size={13}/>New brief
                </button>
              )}
            </div>
          </div>
        )}
        {onHome && isGuest && (
          <div style={{position: "absolute", top: 18, right: 24, zIndex: 5, display: "flex", gap: 8}}>
            <button className="btn btn-primary btn-sm" onClick={() => requireAuth(null, null)}>
              <Icon name="login" size={13}/>Log In
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
      <BrandOnboardingModal
        open={onboarding.open}
        kit={onboarding.kit}
        accountId={onboarding.accountId}
        accountName={auth?.account?.name || ''}
        onComplete={handleOnboardingComplete}
        onSkip={handleOnboardingSkip}
      />
      <ConfirmHost />
      <CreateBrandHost />
    </div>
  );
};

// Brand and agency workspaces are exclusive — no swap hotkey.

export { App };
