/* eslint-disable */
/* App shell — routing, theme, tweaks protocol.
   NOTE: No longer gates on auth. Guests can freely use the Home screen;
   the Submit action in HomeView triggers a login modal when signed-out.
   Other views (Tasks, Brand Kit, etc.) also prompt login if a guest
   navigates to them — but the sidebar hides those routes for guests. */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
import { NotFoundView } from './components/NotFoundView.jsx';
import { TrendsView } from './components/TrendsView.jsx';
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

// ---------- URL ↔ route mapping (Phase 2 routing layer) ------------------
// We keep the legacy `route = {view, id}` shape across the codebase so the
// 55-ish `setRoute(...)` callsites in child components don't have to change.
// This file is the only place that bridges the URL to that shape.
//
// Path scheme (Phase 2 — per-brand segment):
//   /                              → calendar (universal landing; redirects to /c/:slug/calendar when brand known)
//   /c/:brandSlug/calendar         → calendar scoped to brand
//   /c/:brandSlug/calendar/:id     → post plan detail (lives under calendar — its parent surface)
//   /c/:brandSlug/tasks            → tasks list scoped to brand
//   /c/:brandSlug/tasks/:id        → task detail
//   /c/:brandSlug/home             → home (Request page for brand owners)
//   /c/:brandSlug/library          → library
//   /c/:brandSlug/brand            → brand intelligence
//   /c/:brandSlug/team             → brand team
//   /c/:brandSlug/performance      → performance
//   /c/:brandSlug/settings         → settings
//   /home                          → agency inbox (All-clients mode)
//   /tasks                         → agency all-tasks (All-clients mode)
//   /clients /members /profile     → agency-only / user-level (no brand segment)
//
// Phase 1 bare paths (/calendar, /tasks/:id, etc.) still resolve for
// backward compat — they just won't carry a brand slug.

const SIMPLE_VIEWS = new Set([
  'calendar', 'tasks', 'library', 'brand', 'team',
  'performance', 'home', 'profile', 'settings', 'clients', 'members',
]);

function parsePathToRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';

  // --- Phase 2: /c/:brandSlug/... ---
  let m = path.match(/^\/c\/([^/]+)\/tasks\/([^/]+)$/);
  if (m) return { view: 'tasks', id: m[2], brandSlug: m[1] };
  m = path.match(/^\/c\/([^/]+)\/calendar\/([^/]+)$/);
  if (m) return { view: 'plan', id: m[2], brandSlug: m[1] };
  m = path.match(/^\/c\/([^/]+)\/([^/]+)$/);
  if (m && SIMPLE_VIEWS.has(m[2])) return { view: m[2], brandSlug: m[1] };
  // /c/:slug with no trailing view → calendar
  m = path.match(/^\/c\/([^/]+)$/);
  if (m) return { view: 'calendar', brandSlug: m[1] };

  // --- Phase 1 bare paths (backward compat, no brand slug) ---
  m = path.match(/^\/tasks\/([^/]+)$/);
  if (m) return { view: 'tasks', id: m[1] };
  m = path.match(/^\/calendar\/([^/]+)$/);
  if (m) return { view: 'plan', id: m[1] };
  if (path === '/' || path === '/calendar') return { view: 'calendar' };
  if (path === '/tasks') return { view: 'tasks' };
  if (path === '/library') return { view: 'library' };
  if (path === '/brand') return { view: 'brand' };
  if (path === '/team') return { view: 'team' };
  if (path === '/performance') return { view: 'performance' };
  if (path === '/clients') return { view: 'clients' };
  if (path === '/members') return { view: 'members' };
  if (path === '/trends')  return { view: 'trends' };
  if (path === '/home') return { view: 'home' };
  if (path === '/profile') return { view: 'profile' };
  if (path === '/settings') return { view: 'settings' };
  // Unknown path → render the 404 view. We carry the bad pathname so the
  // NotFoundView can show "we couldn't find anything at <path>".
  return { view: 'not_found', path };
}

// Render UUIDs in URLs as their first 8 hex chars (git-short-SHA style):
//   /calendar/a3f9c2d8   instead of   /calendar/a3f9c2d8-7e21-4b3a-9c01-1234567890ab
// Same rule for tasks. Non-UUID values (already short, or future slugs) pass
// through untouched, so the URL is short for new rows automatically.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function shortenId(id) {
  if (!id) return id;
  return UUID_RE.test(id) ? id.slice(0, 8) : id;
}

// Inverse: given a URL prefix (e.g. "a3f9c2d8") and the loaded items list,
// return the full UUID. Falls through unchanged if it's already a full
// UUID (old deep links keep working) or if we can't find a match (the
// detail view will render its "not found" state).
function findFullId(prefix, items) {
  if (!prefix) return prefix;
  if (prefix.length >= 36) return prefix; // full UUID already
  const match = items?.find?.((i) => i?.id && i.id.startsWith(prefix));
  return match?.id || prefix;
}

// Views that live under /c/:brandSlug/ — everything that's brand-scoped.
// Views NOT in this set (profile, clients, members) stay at the root.
const BRAND_SCOPED_VIEWS = new Set([
  'calendar', 'tasks', 'plan', 'home', 'library', 'brand',
  'team', 'performance', 'settings',
]);

function viewToPath(next, brandSlug) {
  if (!next || !next.view) return brandSlug ? `/c/${brandSlug}/calendar` : '/calendar';
  const { view, id } = next;
  const prefix = brandSlug && BRAND_SCOPED_VIEWS.has(view) ? `/c/${brandSlug}` : '';
  if (view === 'tasks' && id) return `${prefix}/tasks/${shortenId(id)}`;
  if (view === 'plan' && id) return `${prefix}/calendar/${shortenId(id)}`;
  if (view === 'calendar') return `${prefix}/calendar`;
  if (prefix) return `${prefix}/${view}`;
  return `/${view}`;
}

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
  // Phase 2: the brand slug in the URL is now the source of truth for which
  // brand is active. localStorage is kept as a fallback for bare-path URLs.
  const [activeAdminBrandId, setActiveAdminBrandIdState] = useState(() => {
    try { return localStorage.getItem("lr_admin_active_brand") || ALL_CLIENTS; }
    catch { return ALL_CLIENTS; }
  });
  // List of brand accounts for the picker dropdown (agency only).
  const [brandAccounts, setBrandAccounts] = useState([]);
  // ----- URL-driven routing (Phase 2) ---------------------------------
  // `route` is derived from the URL on every render, now including an
  // optional `brandSlug`. `setRoute` keeps its legacy `{view, id}` signature
  // so child components don't have to change — it resolves the current
  // brand slug automatically and generates the right URL.
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parsePathToRoute(location.pathname), [location.pathname]);

  // Resolve the current brand slug for URL generation. Priority:
  // 1. The slug already in the URL (route.brandSlug)
  // 2. For agency: the slug of the activeAdminBrandId
  // 3. For brand owners: auth.account.slug
  const currentBrandSlug = useMemo(() => {
    if (route.brandSlug) return route.brandSlug;
    if (auth?.isAgency) {
      if (activeAdminBrandId && activeAdminBrandId !== ALL_CLIENTS) {
        const match = brandAccounts.find((b) => b.id === activeAdminBrandId);
        return match?.slug || null;
      }
      return null;
    }
    return auth?.account?.slug || null;
  }, [route.brandSlug, auth?.isAgency, auth?.account?.slug, activeAdminBrandId, brandAccounts]);

  const setRoute = useCallback((next) => {
    navigate(viewToPath(next, currentBrandSlug));
  }, [navigate, currentBrandSlug]);

  // One-time migration: pre-Phase-1 users had their last view in
  // `localStorage.lr_route`. On first load post-deploy, if they're sitting
  // on `/` we hop them over to the saved view, then drop the key. After
  // this has shipped and baked, the migration block can be deleted.
  useEffect(() => {
    if (location.pathname !== '/') {
      // They navigated/refreshed on a real path — clear the legacy key
      // since the URL is now authoritative.
      try { localStorage.removeItem('lr_route'); } catch {}
      return;
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('lr_route')); } catch {}
    try { localStorage.removeItem('lr_route'); } catch {}
    if (saved && saved.view && saved.view !== 'calendar') {
      navigate(viewToPath(saved, currentBrandSlug), { replace: true });
    }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 2: sync activeAdminBrandId from the URL slug.
  // When an agency user lands on /c/:brandSlug/..., resolve the slug to
  // an account ID and set it as the active brand. This makes the URL the
  // source of truth instead of localStorage.
  useEffect(() => {
    if (!auth?.isAgency) return;
    if (!route.brandSlug) {
      // Bare path (no slug) — agency is in All-clients mode.
      // Only reset if they're not already on a brand-scoped view.
      return;
    }
    const match = brandAccounts.find(
      (b) => b.slug === route.brandSlug
    );
    if (match && match.id !== activeAdminBrandId) {
      setActiveAdminBrandIdState(match.id);
      try { localStorage.setItem("lr_admin_active_brand", match.id); } catch {}
    }
  }, [auth?.isAgency, route.brandSlug, brandAccounts, activeAdminBrandId]);

  // Phase 2 (brand-side): sync the active brand from the URL slug for
  // brand users. When a brand member with multiple memberships lands on
  // /c/:brandSlug/... (e.g. via an agency-update email link pointing at a
  // specific brand), switch to that brand if it matches one of their
  // memberships. Without this, brand users would always land on whichever
  // brand was last picked from localStorage — making per-brand deep links
  // unreliable.
  useEffect(() => {
    if (!auth) return;
    if (auth.isAgency) return; // handled by the agency-only effect above
    if (!route.brandSlug) return;
    if (auth.account?.slug === route.brandSlug) return; // already active
    const match = (auth.memberships || []).find(
      (m) => m?.account?.slug === route.brandSlug
    );
    if (match?.account?.id) {
      // Fire-and-forget; setActiveBrand re-hydrates and dispatches an
      // lr_auth_change event that re-renders downstream consumers.
      setActiveBrand(match.account.id).catch(() => {});
    }
  }, [auth?.id, auth?.isAgency, auth?.account?.slug, route.brandSlug, (auth?.memberships || []).map((m) => m?.account?.slug).join(',')]);

  // Phase 2: redirect bare paths to brand-scoped paths.
  // When a signed-in user lands on a bare path like /calendar (no slug),
  // redirect them to /c/:slug/calendar so the URL always carries context.
  // Skip for agency in All-clients mode (those views are intentionally bare).
  // Skip for views that don't belong under a brand (profile, clients, members).
  useEffect(() => {
    // Don't redirect until we know who the user is.
    if (!auth) return;
    // Don't redirect if the URL already has a slug.
    if (route.brandSlug) return;
    // Don't redirect non-brand-scoped views.
    if (!BRAND_SCOPED_VIEWS.has(route.view)) return;
    // Agency in All-clients mode: bare /home and /tasks are correct.
    if (auth.isAgency && (activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId)) return;

    const slug = (() => {
      if (auth.isAgency) {
        const match = brandAccounts.find((b) => b.id === activeAdminBrandId);
        return match?.slug || null;
      }
      return auth.account?.slug || null;
    })();

    if (slug) {
      navigate(viewToPath(route, slug), { replace: true });
    }
  }, [auth?.id, auth?.isAgency, auth?.account?.slug, route.view, route.brandSlug, activeAdminBrandId, brandAccounts]);
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
  // Phase 2: also navigate to the brand's slug URL.
  const setActiveAdminBrandId = (next) => {
    setActiveAdminBrandIdState(next);
    try {
      if (next && next !== ALL_CLIENTS) localStorage.setItem("lr_admin_active_brand", next);
      else localStorage.setItem("lr_admin_active_brand", ALL_CLIENTS);
    } catch {}
  };

  // (Removed: localStorage.lr_route write — URL is now the source of truth.)

  // Guest sandbox: only the empty Social Calendar and the Request page are
  // accessible without an account. Anything else (Tasks, Library, etc.)
  // snaps the guest back to the calendar so locked surfaces never render
  // half-broken to a signed-out user.
  // Phase 2: stash the intended path so we can bounce back after sign-in.
  useEffect(() => {
    if (auth) return;
    const GUEST_ALLOWED = new Set(["calendar", "home", "not_found"]);
    if (!GUEST_ALLOWED.has(route.view)) {
      // Stash the deep-link path so handleSignedIn can restore it.
      try { sessionStorage.setItem('lr_bounce_path', location.pathname); } catch {}
      navigate('/calendar', { replace: true });
    }
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

  // (Removed 2026-05-02: the email-match auto-accept welcome banner that
  // surfaced when auto_accept_pending_invitations() granted membership
  // silently. Now that auto-accept is gone, the only redemption path is the
  // token-based flow above, which already shows its own "Invite accepted"
  // banner. This effect was unreachable and stripped for clarity.)

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
    // Phase 2: use slug URL.
    const freshAuth = readAuth();
    const slug = freshAuth?.account?.slug;
    if (slug) {
      navigate(`/c/${slug}/brand`);
    } else {
      setRoute({ view: "brand" });
    }
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
  // Display name for the active brand — used by surfaces (e.g. CalendarView's
  // "Send update" modal) that want to label the brand they're acting on.
  const calendarAccountName = (() => {
    if (!calendarAccountId) return null;
    if (auth?.isAgency) {
      return brandAccounts.find((b) => b.id === calendarAccountId)?.name || null;
    }
    return auth?.account?.name || null;
  })();

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
    const allClientsRoutes = new Set(['home', 'tasks', 'profile', 'settings', 'clients', 'members', 'trends', 'not_found']);
    const inBrandRoutes    = new Set(['calendar', 'plan', 'tasks', 'brand', 'library', 'performance', 'team', 'profile', 'settings', 'clients', 'members', 'trends', 'not_found']);
    if (isAllClientsMode) {
      if (!allClientsRoutes.has(r)) navigate('/home');
    } else {
      if (!inBrandRoutes.has(r)) {
        const slug = brandAccounts.find((b) => b.id === activeAdminBrandId)?.slug;
        navigate(slug ? `/c/${slug}/calendar` : '/calendar');
      }
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
    // Land on the Social Calendar after sign-out — bare path since
    // there's no brand context for a guest.
    navigate('/calendar');
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
      // Check for a stashed deep-link path from the guest bounce.
      let bouncePath = null;
      try {
        bouncePath = sessionStorage.getItem('lr_bounce_path');
        sessionStorage.removeItem('lr_bounce_path');
      } catch {}
      if (bouncePath) {
        navigate(bouncePath);
      } else {
        // No pending action — drop a fresh sign-in onto the Social Calendar.
        // Phase 2: use the brand slug URL.
        const slug = profile?.account?.slug;
        if (slug) {
          navigate(`/c/${slug}/calendar`);
        } else {
          navigate('/calendar');
        }
      }
    }
  };

  // ----- Brand-picker handlers -----
  // Brand owners switch via auth.setActiveBrand (rehydrates auth profile).
  // Agency switches via local state — `auth.account` stays on the agency
  // workspace; only `activeAdminBrandId` moves.
  // Phase 2: both paths now navigate to the brand's slug URL.
  const handleSelectBrand = async (id) => {
    if (!id) return;
    if (auth?.isAgency) {
      setActiveAdminBrandId(id);
      // Navigate to the brand's slug URL (or bare path for All-clients).
      if (id === ALL_CLIENTS) {
        navigate('/home');
      } else {
        const match = brandAccounts.find((b) => b.id === id);
        if (match?.slug) {
          navigate(`/c/${match.slug}/calendar`);
        }
      }
    } else {
      try {
        await setActiveBrand(id);
        // After switching, the auth object will have the new slug.
        // Read it fresh and navigate.
        const freshAuth = readAuth();
        if (freshAuth?.account?.slug) {
          navigate(`/c/${freshAuth.account.slug}/calendar`);
        }
      }
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
    if (route.view === "not_found") return <><strong>Not found</strong></>;
    if (route.view === "calendar") return <><strong>Social Calendar</strong></>;
    if (route.view === "plan") {
      const fullPlanId = findFullId(route.id, postPlans);
      const p = postPlans.find((x) => x.id === fullPlanId);
      return <><a onClick={() => setRoute({view: "calendar"})} style={{cursor: "pointer"}}>Social Calendar</a><span className="crumb-sep">/</span><strong>{p?.concept || "Post plan"}</strong></>;
    }
    if (route.view === "home") {
      if (inAllClients) return <><strong>Inbox</strong></>;
      return <><span>{auth ? (auth.account?.name || "Workspace") : "Welcome"}</span><span className="crumb-sep">/</span><strong>Request</strong></>;
    }
    if (route.view === "tasks" && route.id) {
      const fullTaskId = findFullId(route.id, tasks);
      const p = tasks.find((x) => x.id === fullTaskId);
      return <><a onClick={() => setRoute({view: "tasks"})} style={{cursor: "pointer"}}>Tasks</a><span className="crumb-sep">/</span><strong>{p?.title || "Task"}</strong></>;
    }
    if (route.view === "tasks") return <><strong>{inAllClients ? "All tasks" : "Tasks"}</strong></>;
    if (route.view === "library") return <><strong>Library</strong></>;
    if (route.view === "clients") return <><strong>Clients</strong></>;
    if (route.view === "members") return <><strong>L+R Team</strong></>;
    if (route.view === "trends")  return <><strong>Trends Radar</strong></>;
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
    // 404 takes priority over every other branch. parsePathToRoute sets
    // this for any URL that doesn't match a known view; it's also legal
    // for guests and for both agency contexts (see snap-effect sets above).
    if (route.view === "not_found") {
      return <NotFoundView setRoute={setRoute} pathname={route.path} />;
    }

    if (route.view === "profile") {
      if (!auth) return <HomeView setRoute={setRoute} pushTask={pushTask} requireAuth={requireAuth} auth={auth}/>;
      return <ProfileView setRoute={setRoute} mode={mode} onSignOut={handleSignOut}/>;
    }

    // Agency-only management surfaces — reachable from the picker / profile menu.
    if (auth?.isAgency && route.view === "clients") {
      return <AdminClientsView onOpenClient={(c) => handleSelectBrand(c.id)}/>;
    }
    if (auth?.isAgency && route.view === "trends") {
      return (
        <TrendsView
          brandAccounts={brandAccounts}
          defaultAccountId={isAllClientsMode ? null : activeAdminBrandId}
          userId={auth?.id}
          navigateToPlan={(planId, brandSlug) => {
            // The plan may belong to a brand other than the agency's
            // currently-active one (Trends Radar is agency-level + lets
            // them pick the destination brand at create-time). So we
            // construct the URL with the plan's actual brand slug
            // instead of relying on setRoute's currentBrandSlug.
            navigate(viewToPath({ view: 'plan', id: planId }, brandSlug || null));
          }}
        />
      );
    }
    if (auth?.isAgency && route.view === "members") {
      return <AdminTeamView auth={auth}/>;
    }

    // Cross-client "All clients" mode — only Inbox + Tasks make sense here.
    if (auth?.isAgency && isAllClientsMode) {
      if (route.view === "tasks" && route.id) return <TaskDetailView taskId={findFullId(route.id, tasks)} tasks={tasks} updateTask={updateTask} setRoute={setRoute} mode={mode}/>;
      if (route.view === "tasks") return <TasksView setRoute={setRoute} tasks={tasks} mode={mode}/>;
      // Default for All-clients: AdminHome (the cross-client inbox).
      return <AdminHome tasks={tasks} setRoute={setRoute}/>;
    }

    // Calendar — visible to both signed-in users and guests (empty state).
    if (route.view === "calendar") return (
      <CalendarView
        postPlans={auth ? postPlans : []}
        accountId={auth ? calendarAccountId : null}
        accountName={auth ? calendarAccountName : null}
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
        postPlanId={findFullId(route.id, postPlans)}
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
        calendarUnreadCount={unreadByPlan.size}
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
