/* eslint-disable */
/* Data access layer — all Supabase queries live here.
   Returns tasks in the UI shape the views already consume (MOCK.tasks-compatible),
   so components don't need restructuring as real data replaces mock data. */

import { supabase } from './supabase';
import MOCK from './mockData.js';

const palettes = MOCK.palettes;

// ---- Formatting helpers --------------------------------------------------

function paletteFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

function formatShortDate(iso) {
  if (!iso) return 'TBD';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'TBD';
  }
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return formatShortDate(iso);
}

function personFromProfile(p) {
  if (!p) {
    return {
      id: 'u_unassigned',
      name: 'Unassigned',
      initials: 'L+',
      role: 'L+R Studio',
      avatarColor: '#2B2B2E',
    };
  }
  return {
    id: p.id,
    name: p.display_name || 'L+R Team',
    initials: p.initials || 'L+',
    role: p.is_agency ? 'L+R Studio' : 'Brand',
    avatarColor: p.avatar_color || '#2B2B2E',
    email: p.email,
  };
}

// ---- Task mapper ---------------------------------------------------------

export function mapTaskRow(row) {
  if (!row) return null;
  const lead = personFromProfile(row.assigned_lead);
  const creator = personFromProfile(row.creator);
  const chips = {};
  if (row.creatives_count != null) chips.count = { value: row.creatives_count, unit: 'creatives' };
  if (row.deadline) chips.deadline = { value: formatShortDate(row.deadline), iso: row.deadline };
  if (row.format) chips.format = { value: row.format };
  if (row.platform) chips.platform = { value: row.platform };
  if (row.objective) chips.objective = { value: row.objective };

  const artLabel = row.status === 'delivered' && row.delivered_at
    ? `Delivered ${formatShortDate(row.delivered_at)}`
    : (row.title?.slice(0, 40) || 'Brief');

  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    tag: row.account?.name || 'Brief',
    status: row.status,
    deadline: row.deadline ? formatShortDate(row.deadline) : 'TBD',
    deadlineDate: row.deadline,
    createdAt: formatRelative(row.created_at),
    createdAtISO: row.created_at,
    creativeLead: lead,
    creator,
    collaborators: [lead],
    palette: paletteFor(row.id),
    artKicker: row.title?.split(/\s+/)[0] || 'Brief',
    artLabel,
    brief: { message: row.brief_text || '', chips },
    deliverables: [],
    thread: [],
    accountName: row.account?.name,
  };
}

// ---- Select shape (joined columns) --------------------------------------
// PostgREST FK hint: `!column_name` disambiguates when two FKs point to the
// same table (assigned_lead_id + created_by both → profiles).
const TASK_SELECT = `
  *,
  account:accounts(id, name, type, accent_color),
  assigned_lead:profiles!assigned_lead_id(id, display_name, initials, avatar_color, is_agency),
  creator:profiles!created_by(id, display_name, initials, avatar_color, is_agency)
`;

// ---- Queries -------------------------------------------------------------

export async function loadTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapTaskRow);
}

export async function loadTaskById(id) {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapTaskRow(data) : null;
}

// Convert a "M D" style chip deadline back to an ISO date (guessing the year).
function chipDeadlineToIso(chip) {
  if (!chip) return null;
  if (chip.iso) return chip.iso;
  if (!chip.value) return null;
  const now = new Date();
  const parsed = new Date(`${chip.value} ${now.getFullYear()}`);
  if (isNaN(parsed.getTime())) return null;
  // If the parsed date is already past today by more than a month, bump to next year.
  if (parsed.getTime() + 30 * 86400000 < now.getTime()) {
    parsed.setFullYear(now.getFullYear() + 1);
  }
  return parsed.toISOString().slice(0, 10);
}

export async function submitTask({ accountId, userId, text, chips, titleHint }) {
  const count = chips?.count?.value ?? null;
  const title =
    titleHint ||
    (count ? `${count} ${chips.count.unit || 'creatives'}` : 'New creative brief') +
    (chips?.campaign?.value ? ` — ${chips.campaign.value}` : '');
  const payload = {
    account_id: accountId,
    title,
    brief_text: text || '',
    status: 'brief',
    creatives_count: count,
    deadline: chipDeadlineToIso(chips?.deadline),
    format: chips?.format?.value ?? null,
    platform: chips?.platform?.value ?? null,
    objective: chips?.objective?.value ?? null,
    created_by: userId ?? null,
  };
  const { data, error } = await supabase
    .from('tasks')
    .insert(payload)
    .select(TASK_SELECT)
    .single();
  if (error) throw error;
  return mapTaskRow(data);
}

export async function updateTaskStatus(id, status) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ status })
    .eq('id', id)
    .select(TASK_SELECT)
    .single();
  if (error) throw error;
  return mapTaskRow(data);
}

// ---- Realtime ------------------------------------------------------------

// ---- Messages ------------------------------------------------------------

const MESSAGE_SELECT = `
  *,
  author:profiles!author_id(id, display_name, initials, avatar_color, is_agency)
`;

function formatMessageTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${time}`;
}

export function mapMessageRow(row, viewerUserId) {
  if (!row) return null;
  const author = personFromProfile(row.author);
  const mine = viewerUserId && row.author_id === viewerUserId;
  return {
    id: row.id,
    taskId: row.task_id,
    authorId: row.author_id,
    from: mine ? 'me' : 'them',
    who: author,
    time: formatMessageTime(row.created_at),
    text: row.body,
    createdAt: row.created_at,
  };
}

export async function loadMessagesForTask(taskId, viewerUserId) {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => mapMessageRow(r, viewerUserId));
}

export async function sendMessage({ taskId, body, authorId }) {
  const { data, error } = await supabase
    .from('messages')
    .insert({ task_id: taskId, body, author_id: authorId })
    .select(MESSAGE_SELECT)
    .single();
  if (error) throw error;
  return mapMessageRow(data, authorId);
}

export function subscribeToMessagesForTask(taskId, viewerUserId, onChange) {
  const channel = supabase
    .channel(`lr_messages_${taskId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `task_id=eq.${taskId}` },
      async (payload) => {
        try {
          const { data } = await supabase
            .from('messages')
            .select(MESSAGE_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: 'INSERT', message: mapMessageRow(data, viewerUserId) });
        } catch (e) {
          console.warn('messages realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- Activity feed -------------------------------------------------------

const ACTIVITY_SELECT = `
  *,
  actor:profiles!actor_id(id, display_name, initials, avatar_color, is_agency)
`;

export function mapActivityRow(row) {
  if (!row) return null;
  const actor = personFromProfile(row.actor);
  let label = row.action;
  const payload = row.payload || {};
  if (row.action === 'created') label = `${actor.name} created this task`;
  else if (row.action === 'status_changed') label = `${actor.name} moved status from "${payload.from}" to "${payload.to}"`;
  else if (row.action === 'assigned') label = `${actor.name} updated the assignment`;
  else if (row.action === 'comment_posted') label = `${actor.name} posted a comment`;
  else if (row.action === 'asset_uploaded') label = `${actor.name} uploaded ${payload.filename || 'a file'}`;
  return {
    id: row.id,
    taskId: row.task_id,
    actor,
    action: row.action,
    payload,
    label,
    time: formatRelative(row.created_at),
    createdAt: row.created_at,
  };
}

export async function loadActivityForTask(taskId) {
  const { data, error } = await supabase
    .from('activity')
    .select(ACTIVITY_SELECT)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapActivityRow);
}

export function subscribeToActivityForTask(taskId, onChange) {
  const channel = supabase
    .channel(`lr_activity_${taskId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'activity', filter: `task_id=eq.${taskId}` },
      async (payload) => {
        try {
          const { data } = await supabase
            .from('activity')
            .select(ACTIVITY_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: 'INSERT', activity: mapActivityRow(data) });
        } catch (e) {
          console.warn('activity realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- Assets --------------------------------------------------------------

const ASSET_SELECT = `
  *,
  uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency)
`;

export function mapAssetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    version: row.version,
    storagePath: row.storage_path,
    filename: row.filename,
    mimeType: row.mime_type || '',
    sizeBytes: row.size_bytes || 0,
    thumbnailUrl: row.thumbnail_url,
    uploader: personFromProfile(row.uploader),
    isImage: (row.mime_type || '').startsWith('image/'),
    createdAt: row.created_at,
    time: formatRelative(row.created_at),
  };
}

// Library: every deliverable asset across tasks the viewer can see.
// RLS filters by account for brand viewers; agency sees everything.
export async function loadLibraryAssets({ kind = 'deliverable' } = {}) {
  const { data, error } = await supabase
    .from('assets')
    .select(`
      *,
      uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency),
      task:tasks(id, title, account:accounts(id, name))
    `)
    .eq('kind', kind)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => {
    const mapped = mapAssetRow(row);
    return {
      ...mapped,
      taskId: row.task_id,
      taskTitle: row.task?.title || 'Untitled task',
      accountName: row.task?.account?.name || null,
    };
  });
}

export async function loadAssetsForTask(taskId) {
  const { data, error } = await supabase
    .from('assets')
    .select(ASSET_SELECT)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapAssetRow);
}

// Upload a File to Storage + insert a row into `assets`. Returns the mapped asset.
export async function uploadAsset({ taskId, file, kind, uploaderId, onProgress }) {
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${taskId}/${Date.now()}_${safeName}`;

  // Version auto-bump: if this exact filename already exists on the task,
  // use max(version) + 1 so the history shows v1/v2/v3 naturally.
  const { data: existing } = await supabase
    .from('assets')
    .select('version')
    .eq('task_id', taskId)
    .eq('filename', file.name)
    .order('version', { ascending: false })
    .limit(1);
  const nextVersion = (existing?.[0]?.version || 0) + 1;

  // Supabase Storage's JS SDK doesn't surface XHR progress natively. Report
  // a coarse three-step progress (0 → 50 → 100) so the UI feels responsive
  // on small files and less dead on big ones.
  onProgress?.(5);
  const { error: uploadError } = await supabase.storage
    .from('assets')
    .upload(storagePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
  if (uploadError) throw uploadError;
  onProgress?.(75);

  const { data, error } = await supabase
    .from('assets')
    .insert({
      task_id: taskId,
      uploaded_by: uploaderId,
      kind,
      version: nextVersion,
      storage_path: storagePath,
      filename: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
    })
    .select(ASSET_SELECT)
    .single();
  if (error) {
    // best-effort cleanup if DB insert failed but storage write succeeded
    supabase.storage.from('assets').remove([storagePath]).catch(() => {});
    throw error;
  }
  onProgress?.(100);
  return mapAssetRow(data);
}

// Private bucket: return a short-lived signed URL for download/display.
export async function assetSignedUrl(storagePath, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from('assets')
    .createSignedUrl(storagePath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteAsset(asset) {
  if (asset.storagePath) {
    await supabase.storage.from('assets').remove([asset.storagePath]).catch(() => {});
  }
  const { error } = await supabase.from('assets').delete().eq('id', asset.id);
  if (error) throw error;
}

export function subscribeToAssetsForTask(taskId, onChange) {
  const channel = supabase
    .channel(`lr_assets_${taskId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'assets', filter: `task_id=eq.${taskId}` },
      async (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            onChange({ type: 'DELETE', id: payload.old.id });
            return;
          }
          const { data } = await supabase
            .from('assets')
            .select(ASSET_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: payload.eventType, asset: mapAssetRow(data) });
        } catch (e) {
          console.warn('assets realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- Team + Invitations --------------------------------------------------

export async function loadAgencyAccountId() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id')
    .eq('type', 'agency')
    .maybeSingle();
  if (error) throw error;
  return data?.id || null;
}

export async function loadTeamForAccount(accountId) {
  const { data, error } = await supabase
    .from('account_members')
    .select('id, role, created_at, user:profiles!user_id(id, display_name, initials, avatar_color, is_agency)')
    .eq('account_id', accountId);
  if (error) throw error;
  return (data || []).map((m) => ({
    id: m.id,
    role: m.role,
    person: personFromProfile(m.user),
    joinedAt: m.created_at,
    status: 'active',
  }));
}

export async function loadInvitationsForAccount(accountId) {
  const { data, error } = await supabase
    .from('invitations')
    .select('*')
    .eq('account_id', accountId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    token: inv.token,
    expiresAt: inv.expires_at,
    createdAt: inv.created_at,
    inviteUrl: buildInviteUrl(inv.token),
    status: 'pending',
  }));
}

function buildInviteUrl(token) {
  if (typeof window === 'undefined') return `?invite=${token}`;
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?invite=${token}`;
}

export async function createInvitation({ accountId, email, role, invitedBy }) {
  const payload = {
    account_id: accountId,
    email: email.trim().toLowerCase(),
    role: role || 'member',
    invited_by: invitedBy || null,
  };
  const { data, error } = await supabase
    .from('invitations')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    email: data.email,
    role: data.role,
    token: data.token,
    expiresAt: data.expires_at,
    createdAt: data.created_at,
    inviteUrl: buildInviteUrl(data.token),
    status: 'pending',
  };
}

export async function revokeInvitation(id) {
  const { error } = await supabase.from('invitations').delete().eq('id', id);
  if (error) throw error;
}

export async function acceptInvitation(token) {
  const { data, error } = await supabase.rpc('accept_invitation', { p_token: token });
  if (error) throw error;
  return data; // account_id
}

// Anon-safe: preview the invitation so the login UI can pre-fill + lock email.
export async function previewInvitation(token) {
  const { data, error } = await supabase.rpc('preview_invitation', { p_token: token });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    email: row.email,
    role: row.role,
    accountName: row.account_name,
    accountType: row.account_type, // 'brand' | 'agency'
  };
}

export async function removeTeamMember({ userId, accountId }) {
  const { error } = await supabase.rpc('remove_team_member', {
    p_user_id: userId,
    p_account_id: accountId,
  });
  if (error) throw error;
}

export async function changeMemberRole({ userId, accountId, newRole }) {
  const { error } = await supabase.rpc('change_member_role', {
    p_user_id: userId,
    p_account_id: accountId,
    p_new_role: newRole,
  });
  if (error) throw error;
}

// ---- Cross-task message summary (for admin inbox "awaiting reply") ------
// Returns a map of taskId → { lastMessage, unreadFromBrand: bool }
export async function loadLatestMessagePerTask(viewerIsAgency) {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const out = new Map();
  for (const row of data || []) {
    if (out.has(row.task_id)) continue;
    out.set(row.task_id, {
      lastMessage: mapMessageRow(row, null),
      awaitingAgencyReply: viewerIsAgency && !row.author?.is_agency,
      awaitingBrandReply: !viewerIsAgency && row.author?.is_agency,
    });
  }
  return out;
}

// ---- Brand kits ----------------------------------------------------------

function mapBrandKitRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.account?.name || null,
    tagline: row.tagline || '',
    mission: row.mission || '',
    audience: row.audience || '',
    toneVoice: row.tone_voice || '',
    aiSummary: row.ai_summary || '',
    primaryColor: row.primary_color || null,
    secondaryColor: row.secondary_color || null,
    logoUrl: row.logo_url || null,
    palette: Array.isArray(row.palette) ? row.palette : [],
    fonts: Array.isArray(row.fonts) ? row.fonts : [],
    voiceTags: Array.isArray(row.voice_tags) ? row.voice_tags : [],
    dos: Array.isArray(row.dos) ? row.dos : [],
    donts: Array.isArray(row.donts) ? row.donts : [],
    photography: Array.isArray(row.photography) ? row.photography : [],
    inspiration: Array.isArray(row.inspiration) ? row.inspiration : [],
    pastCreatives: Array.isArray(row.past_creatives) ? row.past_creatives : [],
    logos: Array.isArray(row.logos) ? row.logos : [],
    references: Array.isArray(row.references) ? row.references : [],
    updatedAt: row.updated_at,
  };
}

const BRAND_KIT_SELECT = `*, account:accounts(id, name, type, accent_color)`;

export async function loadBrandKit(accountId) {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from('brand_kits')
    .select(BRAND_KIT_SELECT)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return mapBrandKitRow(data);
}

export async function updateBrandKit(accountId, patch) {
  if (!accountId) throw new Error('updateBrandKit: accountId is required');
  // Try to update first.
  const { data, error } = await supabase
    .from('brand_kits')
    .update(patch)
    .eq('account_id', accountId)
    .select(BRAND_KIT_SELECT)
    .maybeSingle();
  if (error) throw error;
  if (data) return mapBrandKitRow(data);
  // Fallback: no row existed, insert one.
  const insertPayload = { account_id: accountId, ...patch };
  const { data: inserted, error: insertError } = await supabase
    .from('brand_kits')
    .insert(insertPayload)
    .select(BRAND_KIT_SELECT)
    .single();
  if (insertError) throw insertError;
  return mapBrandKitRow(inserted);
}

// ---- Brand accounts (admin clients view) --------------------------------

function monthKey(iso) {
  if (!iso) return null;
  return String(iso).slice(0, 7); // YYYY-MM
}

export async function loadBrandAccounts() {
  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('id, name, slug, logo_url, accent_color, created_at, type')
    .eq('type', 'brand')
    .order('created_at', { ascending: false });
  if (error) throw error;
  const accountRows = accounts || [];
  const ids = accountRows.map((a) => a.id);
  let byAccount = new Map();
  if (ids.length > 0) {
    const { data: taskRows, error: taskErr } = await supabase
      .from('tasks')
      .select('account_id, status, delivered_at, created_at')
      .in('account_id', ids);
    if (taskErr) throw taskErr;
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    for (const t of taskRows || []) {
      const bucket = byAccount.get(t.account_id) || {
        taskCount: 0,
        deliveredThisMonth: 0,
        lastActivityAt: null,
      };
      bucket.taskCount += 1;
      if (t.status === 'delivered' && monthKey(t.delivered_at) === currentMonthKey) {
        bucket.deliveredThisMonth += 1;
      }
      const candidate = t.delivered_at || t.created_at;
      if (candidate && (!bucket.lastActivityAt || candidate > bucket.lastActivityAt)) {
        bucket.lastActivityAt = candidate;
      }
      byAccount.set(t.account_id, bucket);
    }
  }
  return accountRows.map((a) => {
    const stats = byAccount.get(a.id) || { taskCount: 0, deliveredThisMonth: 0, lastActivityAt: null };
    return {
      id: a.id,
      name: a.name,
      slug: a.slug,
      logoUrl: a.logo_url,
      accentColor: a.accent_color,
      createdAt: a.created_at,
      taskCount: stats.taskCount,
      deliveredThisMonth: stats.deliveredThisMonth,
      lastActivityAt: stats.lastActivityAt,
    };
  });
}

export async function loadBrandAccountById(accountId) {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from('accounts')
    .select('id, name, slug, logo_url, accent_color, created_at, type')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    logoUrl: data.logo_url,
    accentColor: data.accent_color,
    createdAt: data.created_at,
  };
}

// ---- Profiles ------------------------------------------------------------

function mapProfileRow(row, email) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name || '',
    initials: row.initials || '',
    avatarUrl: row.avatar_url || null,
    avatarColor: row.avatar_color || '#2B2B2E',
    isAgency: !!row.is_agency,
    createdAt: row.created_at,
    email: email || undefined,
  };
}

export async function loadProfile(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let email;
  try {
    const { data: userRes } = await supabase.auth.getUser();
    if (userRes?.user?.id === userId) email = userRes.user.email;
  } catch {
    // ignore — email is best-effort
  }
  return mapProfileRow(data, email);
}

export async function updateProfile(userId, patch) {
  if (!userId) throw new Error('updateProfile: userId is required');
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select('*')
    .single();
  if (error) throw error;
  let email;
  try {
    const { data: userRes } = await supabase.auth.getUser();
    if (userRes?.user?.id === userId) email = userRes.user.email;
  } catch {}
  // Let auth.js refresh its cached snapshot so the sidebar avatar picks
  // up the new initials/colour.
  try { window.dispatchEvent(new Event('lr_auth_change')); } catch {}
  return mapProfileRow(data, email);
}

// ---- Accounts ------------------------------------------------------------

export async function updateAccountName(accountId, name) {
  if (!accountId) throw new Error('updateAccountName: accountId is required');
  const { error } = await supabase
    .from('accounts')
    .update({ name })
    .eq('id', accountId);
  if (error) throw error;
}

export function subscribeToTasks(onChange) {
  const channel = supabase
    .channel('lr_tasks_stream')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tasks' },
      async (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            onChange({ type: 'DELETE', id: payload.old.id });
            return;
          }
          // Refetch with joins so the UI has the right shape.
          const { data } = await supabase
            .from('tasks')
            .select(TASK_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: payload.eventType, task: mapTaskRow(data) });
        } catch (e) {
          console.warn('realtime handler failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
