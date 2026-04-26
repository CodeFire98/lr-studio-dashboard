/* eslint-disable */
/* Real Supabase-backed auth. Keeps the readAuth/writeAuth facade the UI was
   built against: components still see a synchronous cached "profile" object
   and subscribe to the `lr_auth_change` window event for updates. */

import { supabase } from './supabase';

const AUTH_KEY = 'lr_auth';

// ----- In-memory cache of the current session + profile ------------------
let _cachedAuth = null;        // the profile shape the UI expects, or null
let _authReady = false;        // becomes true once we've tried loading once
let _refreshLock = null;       // prevents concurrent refreshFromSession calls

function fireChange() {
  window.dispatchEvent(new Event('lr_auth_change'));
}

function initialsFrom(name, email) {
  const source = (name || email || '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).slice(0, 2);
  const out = parts.map((p) => p[0]?.toUpperCase() || '').join('');
  return out || source.slice(0, 2).toUpperCase();
}

function avatarColorFor(seed) {
  const palette = ['#E8553D','#6579BE','#3E8864','#C88A3F','#8B5CF6','#C4412C','#2B2B2E'];
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// Per-user localStorage key that remembers which brand the user picked last.
function activeBrandKey(userId) {
  return `lr_active_brand:${userId}`;
}

// Build the UI-facing profile from an auth session + DB rows.
// activeAccountId is the brand the user picked previously (or just picked). If
// it matches a current membership, that becomes the active account. Otherwise
// we fall back to the first membership (current behavior) when there's only
// one, or leave it null when there are multiple so App.jsx can show the picker.
function hydrateProfile(user, profileRow, membershipRows, activeAccountId) {
  const isAgency = !!profileRow?.is_agency;
  const memberships = (membershipRows || [])
    .filter((m) => m.accounts)
    .map((m) => ({
      role: m.role,
      account: {
        id: m.accounts.id,
        name: m.accounts.name,
        type: m.accounts.type,
        accentColor: m.accounts.accent_color || null,
      },
    }));

  // Brand users can belong to multiple brands and must pick one. Agency users
  // always resolve to their single agency membership (RLS shows them all brands).
  let activeMembership = null;
  if (isAgency) {
    activeMembership = memberships[0] || null;
  } else {
    if (activeAccountId) {
      activeMembership =
        memberships.find((m) => m.account.id === activeAccountId) || null;
    }
    // If exactly one membership, auto-select it — no picker needed.
    if (!activeMembership && memberships.length === 1) {
      activeMembership = memberships[0];
    }
  }

  const requiresBrandSelection =
    !isAgency && !activeMembership && memberships.length > 1;

  const account = activeMembership?.account || null;
  const activeRole = activeMembership?.role || null;
  const name = profileRow?.display_name || user.email || 'You';
  return {
    id: user.id,
    email: user.email,
    name,
    initials: profileRow?.initials || initialsFrom(name, user.email),
    role: isAgency
      ? (activeRole === 'owner' ? 'Agency Owner, L+R' : 'Agency Member')
      : (activeRole === 'owner' ? 'Brand Owner' : 'Brand Lead'),
    avatarColor: profileRow?.avatar_color || avatarColorFor(user.email || user.id),
    workspace: isAgency ? 'admin' : 'customer',
    account,
    memberships,
    requiresBrandSelection,
    isAgency,
    signedInAt: new Date().toISOString(),
  };
}

async function loadProfileFor(user) {
  if (!user) return null;
  // Fetch profile row + memberships + their accounts in one go.
  const [{ data: profileRow }, { data: memberships }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabase
      .from('account_members')
      .select('role, accounts(id, name, type, accent_color)')
      .eq('user_id', user.id),
  ]);

  // If the profile has no display_name (e.g. Google OAuth user whose trigger
  // ran before the fix), patch it from the auth metadata.
  if (profileRow && !profileRow.display_name) {
    const meta = user.user_metadata || {};
    const nameFromMeta = meta.display_name || meta.full_name || meta.name || '';
    if (nameFromMeta) {
      const initials = nameFromMeta.split(/\s+/).slice(0, 2).map(p => (p[0] || '').toUpperCase()).join('');
      await supabase.from('profiles').update({
        display_name: nameFromMeta,
        initials: initials || nameFromMeta.slice(0, 2).toUpperCase(),
      }).eq('id', user.id);
      profileRow.display_name = nameFromMeta;
      profileRow.initials = initials || nameFromMeta.slice(0, 2).toUpperCase();
    }
  }

  let activeAccountId = null;
  try {
    activeAccountId = localStorage.getItem(activeBrandKey(user.id)) || null;
  } catch {}

  return hydrateProfile(user, profileRow, memberships || [], activeAccountId);
}

async function refreshFromSession() {
  // Prevent concurrent calls — onAuthStateChange fires multiple events
  // (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED) and each would race.
  if (_refreshLock) return _refreshLock;
  _refreshLock = _doRefresh();
  try { await _refreshLock; } finally { _refreshLock = null; }
}

async function _doRefresh() {
  const { data: { session } } = await supabase.auth.getSession();
  _cachedAuth = session?.user ? await loadProfileFor(session.user) : null;

  // Auto-accept any invitations matching this user's email. Works for both
  // email/password and Google OAuth sign-ins — no token URL required. This
  // runs BEFORE the auto-create-brand guard so a newly-joined brand member
  // doesn't trigger an unwanted throwaway brand.
  if (_cachedAuth) {
    try {
      const joined = await supabase.rpc('auto_accept_pending_invitations');
      const newAccountIds = Array.isArray(joined?.data) ? joined.data : [];
      if (newAccountIds.length > 0) {
        // Re-hydrate so the new memberships + possibly-flipped is_agency show up.
        _cachedAuth = await loadProfileFor(session.user);
        // Expose the newly-joined IDs so App.jsx can show a welcome banner.
        _cachedAuth.newlyJoinedAccountIds = newAccountIds;
      }
    } catch (e) {
      // Non-fatal — token-link flow still works if this RPC is missing.
      console.warn('auto_accept_pending_invitations failed', e);
    }
  }

  // If a brand user has no account yet (e.g. signed up with email confirmation,
  // or signed up via Google OAuth), create their brand workspace now.
  // BUT skip this if there's a pending invite — the invite flow (accept_invitation)
  // handles account assignment on its own.
  const hasPendingInvite = !!localStorage.getItem('lr_pending_invite');
  // Auto-create only for first-time brand users with NO memberships at all.
  // A user with 2+ memberships pending a brand pick will also have no active
  // account, but they already own brands — we must not create another one.
  const hasAnyMembership = (_cachedAuth?.memberships || []).length > 0;
  if (_cachedAuth && !_cachedAuth.isAgency && !hasAnyMembership && !hasPendingInvite) {
    const pendingName = localStorage.getItem('lr_pending_brand_name');
    const brandName = pendingName || _cachedAuth.name || _cachedAuth.email?.split('@')[0] || 'My Brand';
    try {
      await supabase.rpc('create_brand_account', { p_name: brandName });
      localStorage.removeItem('lr_pending_brand_name');
      _cachedAuth = await loadProfileFor(session.user);
    } catch (e) {
      // If it fails because account already exists (race condition), just reload.
      _cachedAuth = await loadProfileFor(session.user);
      if (!_cachedAuth?.account) {
        console.error('auto create_brand_account failed', e);
      }
    }
  }

  if (_cachedAuth) {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(_cachedAuth)); } catch {}
  } else {
    try { localStorage.removeItem(AUTH_KEY); } catch {}
  }
  _authReady = true;
  fireChange();
}

// Synchronous first paint: prime from localStorage until the real session loads.
try {
  const cached = JSON.parse(localStorage.getItem(AUTH_KEY));
  if (cached && typeof cached === 'object') _cachedAuth = cached;
} catch {}

// Kick off the real session load; react to any future changes.
refreshFromSession().catch(() => { _authReady = true; fireChange(); });
supabase.auth.onAuthStateChange(() => { refreshFromSession().catch(() => {}); });

// ----- Public API --------------------------------------------------------

// Legacy read: synchronous, returns last-known profile (or null).
function readAuth() {
  return _cachedAuth;
}

// Legacy write: only null (sign-out) is supported with real auth.
// Callers that used to writeAuth(profile) should call signInWithPassword instead.
async function writeAuth(value) {
  if (value === null || value === undefined) {
    await supabase.auth.signOut();
    _cachedAuth = null;
    try { localStorage.removeItem(AUTH_KEY); } catch {}
    fireChange();
    return;
  }
  // Non-null writeAuth is now a no-op; real login goes through signInWithPassword.
  // We still update the in-memory cache so optimistic UI keeps working during the
  // async signin flow.
  _cachedAuth = value;
  fireChange();
}

async function signInWithPassword({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  await refreshFromSession();
  return _cachedAuth;
}

async function signUpBrand({ email, password, displayName, brandName }) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        display_name: displayName?.trim() || '',
        is_agency: false,
      },
    },
  });
  if (error) throw error;
  // If the project requires email confirmation, session will be null — we
  // need to surface that back to the UI so it can say "check your email".
  if (!data.session) {
    // Stash the brand name so we can create the account after email confirmation + sign-in.
    try { localStorage.setItem('lr_pending_brand_name', brandName?.trim() || displayName?.trim() || 'My Brand'); } catch {}
    return { pendingConfirmation: true, user: data.user };
  }
  // Brand-side first-time setup: create their brand account + owner row.
  const { data: accountId, error: rpcError } = await supabase.rpc(
    'create_brand_account',
    { p_name: brandName?.trim() || displayName?.trim() || 'My Brand' }
  );
  if (rpcError) throw rpcError;
  await refreshFromSession();
  return { pendingConfirmation: false, user: data.user, accountId, profile: _cachedAuth };
}

// Bare signup used when the user is accepting an invitation — no workspace
// creation here, because accept_invitation will add them to the invited
// account atomically after the auth row exists.
async function signUpForInvite({ email, password, displayName }) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { display_name: displayName?.trim() || '' },
    },
  });
  if (error) throw error;
  if (!data.session) return { pendingConfirmation: true, user: data.user };
  await refreshFromSession();
  return { pendingConfirmation: false, user: data.user, profile: _cachedAuth };
}

async function signOut() {
  return writeAuth(null);
}

// Pick which brand the current user is operating in. Persists per-user in
// localStorage so subsequent sessions restore the same selection on that
// browser. Pass null to clear and re-trigger the picker.
async function setActiveBrand(accountId) {
  if (!_cachedAuth) return null;
  const userId = _cachedAuth.id;
  try {
    if (accountId) localStorage.setItem(activeBrandKey(userId), accountId);
    else localStorage.removeItem(activeBrandKey(userId));
  } catch {}
  // Re-hydrate from the current session so `account`, `role`, and the
  // `requiresBrandSelection` flag reflect the new pick.
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    _cachedAuth = await loadProfileFor(session.user);
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(_cachedAuth)); } catch {}
  }
  fireChange();
  return _cachedAuth;
}

// Google OAuth — requires Google provider enabled in Supabase Dashboard →
// Authentication → Providers, and the client_id/secret configured. The
// redirect URL list there must include `${origin}/` (and the prod origin).
async function signInWithGoogle() {
  // Preserve any pending invite across the OAuth redirect by leaving
  // sessionStorage intact — Supabase keeps us on the same origin.
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.origin + '/#password-reset',
  });
  if (error) throw error;
}

// ----- Legacy agency-accounts helpers (superseded by lib/db.js) ----------
// These used to be localStorage-backed; the real admin flow now lives in
// lib/db.js (loadTeamForAccount, createInvitation, removeTeamMember, etc.)
// and is wired into AdminTeamView. These stubs remain only so any lingering
// imports don't crash the bundle.
function readAgencyAccounts() { return []; }
function writeAgencyAccounts(_list) {}
function findAgencyAccount(_email) { return null; }
function inviteAgencyAccount() {
  throw new Error('Use the Team admin page — invites are now wired through Supabase.');
}
function revokeAgencyAccount() {
  throw new Error('Use the Team admin page — removal is now wired through Supabase.');
}

// Devtools debug helper, preserved from the prototype.
window.__LR_AUTH__ = {
  readAuth,
  signInWithPassword,
  signUpBrand,
  signOut,
  supabase,
  AUTH_KEY,
};

export {
  AUTH_KEY,
  readAuth,
  writeAuth,
  signInWithPassword,
  signUpBrand,
  signUpForInvite,
  signInWithGoogle,
  signOut,
  setActiveBrand,
  requestPasswordReset,
  readAgencyAccounts,
  writeAgencyAccounts,
  findAgencyAccount,
  inviteAgencyAccount,
  revokeAgencyAccount,
};
