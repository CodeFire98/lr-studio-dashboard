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
      role: 'L+R Agency',
      avatarColor: '#2B2B2E',
    };
  }
  return {
    id: p.id,
    name: p.display_name || 'L+R Team',
    initials: p.initials || 'L+',
    role: p.is_agency ? 'L+R Agency' : 'Brand',
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
    : null;

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
    deliveredAtISO: row.delivered_at || null,
    assignedLeadId: row.assigned_lead_id || null,
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

// List variant: embeds assets so the grid can render image previews without
// an N+1. We don't need the creator profile here (only the lead is shown on
// the card), so keep the projection narrower than the detail-view select.
const TASKS_LIST_SELECT = `
  *,
  account:accounts(id, name, type, accent_color),
  assigned_lead:profiles!assigned_lead_id(id, display_name, initials, avatar_color, is_agency),
  assets(id, kind, version, storage_path, mime_type, created_at)
`;

// ---- Queries -------------------------------------------------------------

// Pick which assets feed the card preview, tiered by status:
//   delivered → most-recent deliverable as a hero
//   review/in-progress → up to 4 latest WIPs/deliverables for a collage
//   brief received    → first reference image (mood, not work)
const KIND_RANK = { deliverable: 3, wip: 2, reference: 1 };

function pickPreviewAssetRows(taskRow) {
  const all = (taskRow.assets || []).filter((a) =>
    (a.mime_type || '').startsWith('image/')
  );
  if (!all.length) return { kind: 'empty', rows: [] };
  all.sort((a, b) => {
    const dr = (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0);
    if (dr !== 0) return dr;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
  if (taskRow.status === 'delivered') {
    const hero = all.find((a) => a.kind === 'deliverable') || all[0];
    return { kind: 'hero', rows: [hero] };
  }
  const work = all.filter((a) => a.kind === 'wip' || a.kind === 'deliverable');
  if (work.length >= 2) return { kind: 'collage', rows: work.slice(0, 4) };
  if (work.length === 1) return { kind: 'hero', rows: [work[0]] };
  return { kind: 'reference', rows: [all[0]] };
}

// Bulk-sign preview asset URLs in a single Storage call so the grid doesn't
// fan out one signed-URL request per card. Mutates the mapped tasks in place
// to attach `previewAssets`.
async function attachPreviewAssets(mappedTasks, rawRows) {
  const byId = new Map(rawRows.map((r) => [r.id, r]));
  const allPaths = [];
  const planByTask = new Map();
  for (const r of rawRows) {
    const pick = pickPreviewAssetRows(r);
    planByTask.set(r.id, pick);
    for (const row of pick.rows) {
      if (row?.storage_path) allPaths.push(row.storage_path);
    }
  }

  const urlMap = new Map();
  if (allPaths.length > 0) {
    try {
      const { data, error } = await supabase.storage
        .from('assets')
        .createSignedUrls(allPaths, 60 * 60 * 6); // 6h TTL — outlives a typical session
      if (!error && Array.isArray(data)) {
        for (const item of data) {
          if (item?.path && item?.signedUrl) urlMap.set(item.path, item.signedUrl);
        }
      }
    } catch (e) {
      console.warn('preview asset signing failed', e);
    }
  }

  for (const t of mappedTasks) {
    const plan = planByTask.get(t.id);
    if (!plan || plan.kind === 'empty') {
      t.previewAssets = { kind: 'empty', items: [] };
      continue;
    }
    const items = plan.rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        version: r.version,
        url: urlMap.get(r.storage_path),
      }))
      .filter((it) => it.url);
    t.previewAssets = { kind: items.length ? plan.kind : 'empty', items };
  }
}

export async function loadTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASKS_LIST_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const mapped = rows.map(mapTaskRow);
  await attachPreviewAssets(mapped, rows);
  return mapped;
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

// Format a Date as a YYYY-MM-DD string using local-time components, so a date
// the user picked in their timezone isn't shifted by toISOString()'s UTC conversion.
function toLocalIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Convert a "M D" style chip deadline back to an ISO date (guessing the year).
function chipDeadlineToIso(chip) {
  if (!chip) return null;
  if (chip.iso) return chip.iso;
  if (!chip.value) return null;
  const raw = chip.value.replace(/^due\s*/i, '').trim();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Handle relative presets
  const lower = raw.toLowerCase();
  if (lower.includes('asap') || lower.includes('24') || lower.includes('48')) {
    const d = new Date(today); d.setDate(d.getDate() + 2);
    return toLocalIsoDate(d);
  }
  if (lower === 'this week') {
    const d = new Date(today); d.setDate(d.getDate() + (7 - d.getDay()));
    return toLocalIsoDate(d);
  }
  if (lower === 'next week') {
    const d = new Date(today); d.setDate(d.getDate() + (14 - d.getDay()));
    return toLocalIsoDate(d);
  }
  if (lower === 'in 2 weeks') {
    const d = new Date(today); d.setDate(d.getDate() + 14);
    return toLocalIsoDate(d);
  }
  if (lower === 'in 1 month') {
    const d = new Date(today); d.setMonth(d.getMonth() + 1);
    return toLocalIsoDate(d);
  }

  // Try parsing as an absolute date like "May 15"
  const parsed = new Date(`${raw} ${now.getFullYear()}`);
  if (isNaN(parsed.getTime())) return null;
  if (parsed.getTime() + 30 * 86400000 < now.getTime()) {
    parsed.setFullYear(now.getFullYear() + 1);
  }
  return toLocalIsoDate(parsed);
}

export async function submitTask({ accountId, userId, text, chips, titleHint }) {
  const count = chips?.count?.value ?? null;
  const format = chips?.format?.value ?? null;
  const platform = chips?.platform?.value ?? null;
  const campaign = chips?.campaign?.value ?? null;

  let title = titleHint;
  if (!title) {
    const parts = [];
    if (count) parts.push(String(count));
    if (format) parts.push(format.toLowerCase());
    if (platform) parts.push(`for ${platform}`);
    if (campaign) parts.push(`— ${campaign}`);
    title = parts.length ? parts.join(' ') : 'New creative brief';
  }
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

// Map chip keys to DB column names.
const CHIP_TO_COLUMN = {
  count: 'creatives_count',
  deadline: 'deadline',
  format: 'format',
  platform: 'platform',
  objective: 'objective',
};

export async function updateTaskField({ taskId, chipKey, oldValue, newValue, actorId }) {
  const col = CHIP_TO_COLUMN[chipKey];
  if (!col) throw new Error(`Unknown chip key: ${chipKey}`);

  const dbValue = chipKey === 'deadline' ? chipDeadlineToIso({ value: newValue }) : newValue;
  const patch = { [col]: dbValue || null };

  // Update the task row. The log_task_activity trigger emits a 'field_edited'
  // activity row for every changed chip column (count / deadline / format /
  // platform / objective), so no client-side activity write is needed.
  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('id', taskId)
    .select(TASK_SELECT)
    .single();
  if (error) throw error;

  return mapTaskRow(data);
}

// Reassign a task's creative lead. Pass `userId = null` to unassign. The
// existing log_task_activity trigger records an 'assigned' activity row
// whenever assigned_lead_id changes, so no client-side activity write is
// needed.
export async function assignTaskLead({ taskId, userId }) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ assigned_lead_id: userId })
    .eq('id', taskId)
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
  else if (row.action === 'field_edited') label = `${actor.name} changed ${payload.field || 'a field'} from "${payload.from || '—'}" to "${payload.to || '—'}"`;
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
// When `accountId` is supplied, results are scoped to that brand client-
// side — necessary for agency users (whose RLS gives them every brand).
// Brand users get the same filter applied on top of RLS, which is a no-op
// since RLS already limits them to their accessible accounts.
export async function loadLibraryAssets({ kind = 'deliverable', accountId = null } = {}) {
  const { data, error } = await supabase
    .from('assets')
    .select(`
      *,
      uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency),
      task:tasks(id, title, platform, account:accounts(id, name))
    `)
    .eq('kind', kind)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (data || []).map((row) => {
    const mapped = mapAssetRow(row);
    return {
      ...mapped,
      source: 'task',
      taskId: row.task_id,
      taskTitle: row.task?.title || 'Untitled task',
      parentTitle: row.task?.title || 'Untitled task',
      parentId: row.task_id,
      // Platform is a free-text comma-separated field on tasks (e.g.
      // "Instagram, LinkedIn"). The Library filter normalises it client-side.
      taskPlatform: row.task?.platform || '',
      accountId: row.task?.account?.id || null,
      accountName: row.task?.account?.name || null,
    };
  });
  return accountId ? rows.filter((r) => r.accountId === accountId) : rows;
}

// Library (post-plan side): every "final" attachment uploaded against a
// post plan. These also count as delivered creatives — the brand wants
// to see them in Library alongside task deliverables. Scoping mirrors
// loadLibraryAssets: optional client-side filter by accountId.
//
// Returns the same shape as loadLibraryAssets entries with `source: 'post_plan'`
// so LibraryView can render them in one merged grid.
export async function loadLibraryPostPlanFinals({ accountId = null } = {}) {
  const { data, error } = await supabase
    .from('post_plan_attachments')
    .select(`
      *,
      uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency),
      post_plan:post_plans(id, concept, platforms, account:accounts(id, name))
    `)
    .eq('kind', 'final')
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (data || []).map((row) => {
    const att = mapPostPlanAttachmentRow(row);
    const planConcept = row.post_plan?.concept?.trim() || 'Post plan';
    // Post plans store `platforms` as a text[] array (instagram/linkedin/x);
    // join to a comma-separated string so the existing Library platform
    // filter (which matches free-text on tasks) works the same way.
    const platforms = Array.isArray(row.post_plan?.platforms)
      ? row.post_plan.platforms.join(', ')
      : '';
    return {
      ...att,
      source: 'post_plan',
      // Match the shape consumers (LibraryView) already destructure.
      isImage: (row.mime_type || '').startsWith('image/'),
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      storagePath: row.storage_path,
      createdAt: row.created_at,
      taskId: null,
      taskTitle: planConcept,
      parentTitle: planConcept,
      parentId: row.post_plan_id,
      taskPlatform: platforms,
      accountId: row.post_plan?.account?.id || null,
      accountName: row.post_plan?.account?.name || null,
    };
  });
  return accountId ? rows.filter((r) => r.accountId === accountId) : rows;
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
  // Goes through the `account_members_with_email` SECURITY DEFINER RPC
  // (migration 0027) so we can join `auth.users.email` into the response.
  // The anon-key SPA client can't read auth.users directly; the RPC adds
  // the email column and authz-checks the caller (member of the account
  // OR agency staff).
  const { data, error } = await supabase.rpc('account_members_with_email', {
    p_account_id: accountId,
  });
  if (error) throw error;
  return (data || []).map((m) => ({
    id: m.member_id,
    role: m.role,
    person: personFromProfile({
      id: m.user_id,
      display_name: m.display_name,
      initials: m.initials,
      avatar_color: m.avatar_color,
      is_agency: m.is_agency,
      email: m.email,
    }),
    joinedAt: m.joined_at,
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
    accountId: inv.account_id,
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
    accountId: data.account_id,
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

// Resend = revoke the existing pending invite + create a fresh one with the
// same email/role. Cleaner than mutating the existing row because each
// invitation row owns its token and expiry, and a fresh row resets both.
export async function resendInvitation(existing, { invitedBy } = {}) {
  if (!existing?.id || !existing?.accountId || !existing?.email) {
    throw new Error('resendInvitation: invitation is missing fields');
  }
  await revokeInvitation(existing.id);
  return createInvitation({
    accountId: existing.accountId,
    email: existing.email,
    role: existing.role,
    invitedBy: invitedBy || null,
  });
}

export async function acceptInvitation(token) {
  const { data, error } = await supabase.rpc('accept_invitation', { p_token: token });
  if (error) throw error;
  return data; // account_id
}

// Trigger the `send-email` edge function to deliver a team-invite email for
// a freshly created or revived invitation row. Returns the Resend message id
// on success. Throws on any failure — callers should wrap so the invite row
// (and Copy-link fallback) survive a delivery failure.
export async function sendInviteEmail(invitationId) {
  if (!invitationId) throw new Error('sendInviteEmail: invitationId is required');
  const { data, error } = await supabase.functions.invoke('send-email', {
    body: { template: 'team-invite', invitationId },
  });
  if (error) throw error;
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

// Agency-only: send a free-form summary message to all members of a brand
// workspace. The edge function authz-checks that the caller is agency staff
// (is_agency = true on profiles) — so this call from a non-agency client
// will return a 403. Returns { ok, sent, ids, failed } on success.
export async function sendAgencyUpdateEmail({ accountId, message, subject } = {}) {
  if (!accountId) throw new Error('sendAgencyUpdateEmail: accountId is required');
  if (!message || !message.trim()) throw new Error('sendAgencyUpdateEmail: message is required');
  const { data, error } = await supabase.functions.invoke('send-email', {
    body: {
      template: 'agency-update',
      accountId,
      message: message.trim(),
      ...(subject ? { subject: subject.trim() } : {}),
    },
  });
  if (error) throw error;
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

// Check whether this email has any pending invitations waiting. Used to warn
// a user who signed in with the "wrong" email that invites exist elsewhere.
// Anon-safe — policy allows reading rows by email (case-insensitive).
export async function countPendingInvitationsForEmail(email) {
  if (!email) return 0;
  const { count, error } = await supabase
    .from('invitations')
    .select('id', { count: 'exact', head: true })
    .ilike('email', email.trim())
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString());
  if (error) return 0;
  return count || 0;
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
    websiteUrl: row.website_url || '',
    socialLinks: row.social_links && typeof row.social_links === 'object' ? row.social_links : {},
    palette: Array.isArray(row.palette) ? row.palette : [],
    fonts: Array.isArray(row.fonts) ? row.fonts : [],
    voiceTags: Array.isArray(row.voice_tags) ? row.voice_tags : [],
    trendHashtags: Array.isArray(row.trend_hashtags) ? row.trend_hashtags : [],
    // New richer competitors model (migration 0033). Each entry: {name, handle, url}.
    // Names show in the BrandKit UI; handles drive the IG fetch; url is for
    // direct linking. Auto-populated by enrich-brand-kit's Fetch Brand action.
    competitors: Array.isArray(row.competitors) ? row.competitors : [],
    // Legacy single-string handles (migration 0032). Kept for one cycle so
    // older rows don't disappear from the IG competitors fetch path.
    competitorHandles: Array.isArray(row.competitor_handles) ? row.competitor_handles : [],
    dos: Array.isArray(row.dos) ? row.dos : [],
    donts: Array.isArray(row.donts) ? row.donts : [],
    photography: Array.isArray(row.photography) ? row.photography : [],
    inspiration: Array.isArray(row.inspiration) ? row.inspiration : [],
    pastCreatives: Array.isArray(row.past_creatives) ? row.past_creatives : [],
    logos: Array.isArray(row.logos) ? row.logos : [],
    references: Array.isArray(row.references) ? row.references : [],
    onboardingCompletedAt: row.onboarding_completed_at || null,
    updatedAt: row.updated_at,
    // ---- Firecrawl-enriched fields (migrations 0017 + 0018) -----------
    accentColor: row.accent_color || null,
    backgroundColor: row.background_color || null,
    textPrimaryColor: row.text_primary_color || null,
    textSecondaryColor: row.text_secondary_color || null,
    colorScheme: row.color_scheme || null,
    faviconUrl: row.favicon_url || null,
    ogImageUrl: row.og_image_url || null,
    semanticColors: row.semantic_colors && typeof row.semantic_colors === 'object' ? row.semantic_colors : {},
    typeScale: row.type_scale && typeof row.type_scale === 'object' ? row.type_scale : {},
    spacingTokens: row.spacing_tokens && typeof row.spacing_tokens === 'object' ? row.spacing_tokens : {},
    uiComponents: row.ui_components && typeof row.ui_components === 'object' ? row.ui_components : {},
    positioningStatement: row.positioning_statement || '',
    industry: row.industry || '',
    personality: row.personality && typeof row.personality === 'object' ? row.personality : {},
    valueProps: Array.isArray(row.value_props) ? row.value_props : [],
    brandPillars: Array.isArray(row.brand_pillars) ? row.brand_pillars : [],
    keyDifferentiators: Array.isArray(row.key_differentiators) ? row.key_differentiators : [],
    productCategories: Array.isArray(row.product_categories) ? row.product_categories : [],
    metaTitle: row.meta_title || '',
    metaDescription: row.meta_description || '',
    ogTitle: row.og_title || '',
    ogDescription: row.og_description || '',
    twitterCard: row.twitter_card && typeof row.twitter_card === 'object' ? row.twitter_card : {},
    language: row.language || '',
    fontStacks: row.font_stacks && typeof row.font_stacks === 'object' ? row.font_stacks : {},
    confidenceScores: row.confidence_scores && typeof row.confidence_scores === 'object' ? row.confidence_scores : {},
    designSystem: row.design_system && typeof row.design_system === 'object' ? row.design_system : {},
    llmReasoning: row.llm_reasoning && typeof row.llm_reasoning === 'object' ? row.llm_reasoning : {},
    enrichmentStatus: row.enrichment_status || 'never',
    enrichmentError: row.enrichment_error || '',
    enrichmentUrl: row.enrichment_url || '',
    enrichedAt: row.enriched_at || null,
    enrichmentCreditsUsed: row.enrichment_credits_used || null,
    enrichmentScrapeId: row.enrichment_scrape_id || '',
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

// ---- Brand logo upload ---------------------------------------------------

// Public bucket: 'brand-logos'. Path scheme '<accountId>/<ts>_<filename>'.
// Returns the public URL of the uploaded asset; the caller is responsible
// for persisting it to brand_kits.logo_url.
export async function uploadBrandLogo({ accountId, file }) {
  if (!accountId) throw new Error('uploadBrandLogo: accountId is required');
  if (!file)      throw new Error('uploadBrandLogo: file is required');
  const safeName = (file.name || 'logo').replace(/[^\w.\-]+/g, '_');
  const path = `${accountId}/${Date.now()}_${safeName}`;
  const { error: uploadError } = await supabase.storage
    .from('brand-logos')
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from('brand-logos').getPublicUrl(path);
  return { url: data.publicUrl, path };
}

// ---- Logo variants (brand_kits.logos JSONB array) -----------------------
// Each entry is { id, url, label, path }. Designers grab variants for
// specific contexts (mono on dark, wordmark only, icon-only, etc.).
// Uploads use the same brand-logos bucket; we just don't promote the
// variant to logo_url so the primary logo stays untouched.

export async function addBrandLogoVariant({ accountId, file, label }) {
  if (!accountId) throw new Error('addBrandLogoVariant: accountId required');
  if (!file)      throw new Error('addBrandLogoVariant: file required');
  const { url, path } = await uploadBrandLogo({ accountId, file });
  // Read current logos, append, write back. Server-side merge would be
  // safer but we don't have an RPC for jsonb array append yet.
  const { data: row, error: readErr } = await supabase
    .from('brand_kits')
    .select('logos')
    .eq('account_id', accountId)
    .single();
  if (readErr) throw readErr;
  const current = Array.isArray(row?.logos) ? row.logos : [];
  const next = [
    ...current,
    {
      id: `lv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      url,
      path,
      label: (label || 'Logo variant').trim(),
    },
  ];
  const { data: updated, error: writeErr } = await supabase
    .from('brand_kits')
    .update({ logos: next })
    .eq('account_id', accountId)
    .select(BRAND_KIT_SELECT)
    .single();
  if (writeErr) throw writeErr;
  return mapBrandKitRow(updated);
}

export async function removeBrandLogoVariant({ accountId, variantId }) {
  if (!accountId) throw new Error('removeBrandLogoVariant: accountId required');
  if (!variantId) throw new Error('removeBrandLogoVariant: variantId required');
  const { data: row, error: readErr } = await supabase
    .from('brand_kits')
    .select('logos')
    .eq('account_id', accountId)
    .single();
  if (readErr) throw readErr;
  const current = Array.isArray(row?.logos) ? row.logos : [];
  const target = current.find((l) => l.id === variantId);
  const next = current.filter((l) => l.id !== variantId);
  const { data: updated, error: writeErr } = await supabase
    .from('brand_kits')
    .update({ logos: next })
    .eq('account_id', accountId)
    .select(BRAND_KIT_SELECT)
    .single();
  if (writeErr) throw writeErr;
  // Best-effort delete the storage file too. Failure is non-fatal — we'd
  // rather leave a stray blob than block the UI.
  if (target?.path) {
    try { await supabase.storage.from('brand-logos').remove([target.path]); } catch (_) {}
  }
  return mapBrandKitRow(updated);
}

export async function updateBrandLogoVariant({ accountId, variantId, label }) {
  if (!accountId) throw new Error('updateBrandLogoVariant: accountId required');
  if (!variantId) throw new Error('updateBrandLogoVariant: variantId required');
  const { data: row, error: readErr } = await supabase
    .from('brand_kits')
    .select('logos')
    .eq('account_id', accountId)
    .single();
  if (readErr) throw readErr;
  const current = Array.isArray(row?.logos) ? row.logos : [];
  const next = current.map((l) => (l.id === variantId ? { ...l, label: (label || '').trim() || l.label } : l));
  const { data: updated, error: writeErr } = await supabase
    .from('brand_kits')
    .update({ logos: next })
    .eq('account_id', accountId)
    .select(BRAND_KIT_SELECT)
    .single();
  if (writeErr) throw writeErr;
  return mapBrandKitRow(updated);
}

// ---- Re-enrich brand kit (calls the deployed enrich-brand-kit edge fn) -

export async function triggerBrandKitEnrichment({ accountId, websiteUrl }) {
  if (!accountId) throw new Error('triggerBrandKitEnrichment: accountId required');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('You must be signed in');
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/functions/v1/enrich-brand-kit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      brand_id: accountId,
      ...(websiteUrl ? { website_url: websiteUrl } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Enrichment failed (HTTP ${res.status})`);
  return body;
}

// Find 3-6 competitor brands for the given account by scraping the
// brand's website with Firecrawl and asking it to identify peers in
// the category. Writes to brand_kits.competitors (jsonb). Best-effort:
// returns { ok, written, competitors } on success or throws on hard
// failure. The caller (BrandKit Fetch Brand action) runs this in
// PARALLEL with triggerBrandKitEnrichment so they don't block each other.
//
// Lives on Vercel (web/api/find-competitors.ts) rather than as a
// Supabase edge function because the Supabase deploy path is currently
// blocked for our PAT — Vercel co-deploys with the SPA cleanly.
export async function findCompetitorsForBrand({ accountId, websiteUrl } = {}) {
  if (!accountId) throw new Error('findCompetitorsForBrand: accountId is required');
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('findCompetitorsForBrand: not signed in');

  const res = await fetch('/api/find-competitors', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      accountId,
      ...(websiteUrl ? { websiteUrl } : {}),
    }),
  });
  let payload;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    throw new Error((payload && payload.error) || `find-competitors failed (HTTP ${res.status})`);
  }
  return payload;
}

// ---- Brand reference assets ---------------------------------------------
// Public 'brand-assets' bucket — anything the brand uploads as visual
// reference for the agency (mood images, past creatives, packaging shots,
// etc.). Path scheme '<accountId>/<ts>_<filename>'.

export async function uploadBrandAsset({ accountId, file }) {
  if (!accountId) throw new Error('uploadBrandAsset: accountId is required');
  if (!file)      throw new Error('uploadBrandAsset: file is required');
  const safeName = (file.name || 'asset').replace(/[^\w.\-]+/g, '_');
  const path = `${accountId}/${Date.now()}_${safeName}`;
  const { error } = await supabase.storage
    .from('brand-assets')
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
  if (error) throw error;
  const { data } = supabase.storage.from('brand-assets').getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type || null,
  };
}

export async function listBrandAssets(accountId) {
  if (!accountId) return [];
  const { data, error } = await supabase.storage
    .from('brand-assets')
    .list(accountId, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw error;
  return (data || [])
    .filter((o) => o.name && !o.name.endsWith('/'))
    .map((o) => {
      const path = `${accountId}/${o.name}`;
      const { data: pub } = supabase.storage.from('brand-assets').getPublicUrl(path);
      return {
        path,
        name: o.name.replace(/^\d+_/, ''), // strip the timestamp prefix
        url: pub.publicUrl,
        sizeBytes: o.metadata?.size || 0,
        mimeType: o.metadata?.mimetype || '',
        createdAt: o.created_at,
      };
    });
}

export async function deleteBrandAsset(path) {
  if (!path) throw new Error('deleteBrandAsset: path is required');
  const { error } = await supabase.storage.from('brand-assets').remove([path]);
  if (error) throw error;
}

// ---- Brand onboarding ----------------------------------------------------

// Cheap query: does the active brand still need to run through the welcome
// modal? Returns { needsOnboarding, kit } so the caller can both gate the
// modal and pre-fill any partial answers.
export async function loadBrandOnboardingStatus(accountId) {
  if (!accountId) return { needsOnboarding: false, kit: null };
  const kit = await loadBrandKit(accountId);
  return {
    needsOnboarding: !!kit && !kit.onboardingCompletedAt,
    kit,
  };
}

// Single-shot save for the onboarding modal. Updates the brand's display
// name (in case the auto-derived one was wrong), patches brand_kits with
// every field the user filled in, and flips the completion marker so the
// modal never re-fires for this brand.
export async function completeBrandOnboarding({ accountId, brandName, patch }) {
  if (!accountId) throw new Error('completeBrandOnboarding: accountId is required');
  if (brandName && brandName.trim()) {
    await updateAccountName(accountId, brandName.trim());
  }
  const fullPatch = { ...patch, onboarding_completed_at: new Date().toISOString() };
  return updateBrandKit(accountId, fullPatch);
}

// Skip path — same completion marker, no field updates. Used when the
// owner dismisses the modal but we don't want to re-prompt them every login.
export async function skipBrandOnboarding(accountId) {
  if (!accountId) throw new Error('skipBrandOnboarding: accountId is required');
  return updateBrandKit(accountId, { onboarding_completed_at: new Date().toISOString() });
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

// =====================================================================
// Social Calendar — post_plans
// =====================================================================
// One row per content concept the agency plans for a brand. May target
// multiple platforms (instagram / linkedin / x) with copy variants per
// platform. The brand reviews and approves via the two-way "needs
// feedback" status split.

const POST_PLAN_SELECT = `
  *,
  account:accounts(id, name, type, accent_color),
  creator:profiles!created_by(id, display_name, initials, avatar_color, is_agency)
`;

export function mapPostPlanRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account?.name || null,
    scheduledAt: row.scheduled_at,
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    concept: row.concept || '',
    copyVariants: row.copy_variants && typeof row.copy_variants === 'object' ? row.copy_variants : {},
    status: row.status,
    createdBy: row.created_by,
    creator: personFromProfile(row.creator),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    postedAt: row.posted_at,
  };
}

export async function loadPostPlans({ accountId } = {}) {
  let query = supabase
    .from('post_plans')
    .select(POST_PLAN_SELECT)
    .order('scheduled_at', { ascending: true });
  if (accountId) query = query.eq('account_id', accountId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(mapPostPlanRow);
}

export async function loadPostPlanById(id) {
  const { data, error } = await supabase
    .from('post_plans')
    .select(POST_PLAN_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapPostPlanRow(data) : null;
}

export async function createPostPlan({
  accountId,
  scheduledAt,
  platforms,
  concept,
  copyVariants,
  status,
  userId,
}) {
  if (!accountId) throw new Error('createPostPlan: accountId is required');
  if (!scheduledAt) throw new Error('createPostPlan: scheduledAt is required');
  const payload = {
    account_id: accountId,
    scheduled_at: scheduledAt,
    platforms: Array.isArray(platforms) ? platforms : [],
    concept: concept || '',
    copy_variants: copyVariants && typeof copyVariants === 'object' ? copyVariants : {},
    status: status || 'not_started',
    created_by: userId ?? null,
  };
  const { data, error } = await supabase
    .from('post_plans')
    .insert(payload)
    .select(POST_PLAN_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanRow(data);
}

/**
 * Duplicate a post plan to one or more target dates.
 * Copies platforms, concept, and copyVariants from the source plan.
 * Each duplicate gets status 'not_started' and scheduled_at at 09:00 local.
 */
export async function duplicatePostPlan({ sourcePlan, targetDates, userId }) {
  const created = [];
  const errors = [];
  for (const date of targetDates) {
    try {
      const scheduledAt = new Date(
        date.getFullYear(), date.getMonth(), date.getDate(),
        9, 0, 0, 0
      ).toISOString();
      const plan = await createPostPlan({
        accountId: sourcePlan.accountId,
        scheduledAt,
        platforms: sourcePlan.platforms,
        concept: sourcePlan.concept,
        copyVariants: sourcePlan.copyVariants,
        status: 'not_started',
        userId,
      });
      created.push(plan);
    } catch (e) {
      errors.push(e);
    }
  }
  return { created, errors };
}

// Map UI-shape patches to DB columns. Accepts a partial; ignores keys we
// don't know about so callers can pass `{ status: '...' }` or full
// edit-modal patches without ceremony.
function postPlanPatchToColumns(patch) {
  const out = {};
  if (patch == null) return out;
  if (patch.scheduledAt !== undefined)  out.scheduled_at = patch.scheduledAt;
  if (patch.platforms !== undefined)    out.platforms = patch.platforms;
  if (patch.concept !== undefined)      out.concept = patch.concept;
  if (patch.copyVariants !== undefined) out.copy_variants = patch.copyVariants;
  if (patch.status !== undefined)       out.status = patch.status;
  return out;
}

export async function updatePostPlan(id, patch) {
  const cols = postPlanPatchToColumns(patch);
  if (Object.keys(cols).length === 0) {
    return loadPostPlanById(id);
  }
  const { data, error } = await supabase
    .from('post_plans')
    .update(cols)
    .eq('id', id)
    .select(POST_PLAN_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanRow(data);
}

export async function updatePostPlanStatus(id, status) {
  return updatePostPlan(id, { status });
}

export async function deletePostPlan(id) {
  const { error } = await supabase.from('post_plans').delete().eq('id', id);
  if (error) throw error;
}

export function subscribeToPostPlans(onChange, { accountId } = {}) {
  const channelName = accountId
    ? `lr_post_plans_${accountId}`
    : 'lr_post_plans_stream';
  // Filter at the realtime layer when scoping to a single brand — saves
  // the client a round-trip + refetch for events outside its scope.
  const filter = accountId
    ? { event: '*', schema: 'public', table: 'post_plans', filter: `account_id=eq.${accountId}` }
    : { event: '*', schema: 'public', table: 'post_plans' };
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', filter, async (payload) => {
      try {
        if (payload.eventType === 'DELETE') {
          onChange({ type: 'DELETE', id: payload.old.id });
          return;
        }
        const { data } = await supabase
          .from('post_plans')
          .select(POST_PLAN_SELECT)
          .eq('id', payload.new.id)
          .maybeSingle();
        if (data) onChange({ type: payload.eventType, postPlan: mapPostPlanRow(data) });
      } catch (e) {
        console.warn('post_plans realtime failed', e);
      }
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- Status log ----
//
// Every post_plans status change is auto-logged into post_plan_status_log
// via an AFTER UPDATE trigger. The Activity tab reads this so the user
// can see "Brand approved", "Agency requested changes", etc.

const POST_PLAN_STATUS_LOG_SELECT = `
  *,
  actor:profiles!actor_id(id, display_name, initials, avatar_color, is_agency)
`;

export function mapPostPlanStatusLogRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    postPlanId: row.post_plan_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorId: row.actor_id,
    actor: personFromProfile(row.actor),
    createdAt: row.created_at,
  };
}

export async function loadPostPlanStatusLog(postPlanId) {
  if (!postPlanId) return [];
  const { data, error } = await supabase
    .from('post_plan_status_log')
    .select(POST_PLAN_STATUS_LOG_SELECT)
    .eq('post_plan_id', postPlanId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapPostPlanStatusLogRow);
}

// ---- Comments ----

const POST_PLAN_COMMENT_SELECT = `
  *,
  author:profiles!author_id(id, display_name, initials, avatar_color, is_agency)
`;

export function mapPostPlanCommentRow(row, viewerUserId) {
  if (!row) return null;
  const author = personFromProfile(row.author);
  const mine = viewerUserId && row.author_id === viewerUserId;
  return {
    id: row.id,
    postPlanId: row.post_plan_id,
    authorId: row.author_id,
    from: mine ? 'me' : 'them',
    who: author,
    body: row.body,
    time: formatRelative(row.created_at),
    createdAt: row.created_at,
  };
}

export async function loadPostPlanComments(postPlanId, viewerUserId) {
  const { data, error } = await supabase
    .from('post_plan_comments')
    .select(POST_PLAN_COMMENT_SELECT)
    .eq('post_plan_id', postPlanId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => mapPostPlanCommentRow(r, viewerUserId));
}

export async function addPostPlanComment({ postPlanId, body, authorId }) {
  const { data, error } = await supabase
    .from('post_plan_comments')
    .insert({ post_plan_id: postPlanId, body, author_id: authorId })
    .select(POST_PLAN_COMMENT_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanCommentRow(data, authorId);
}

export function subscribeToPostPlanComments(postPlanId, viewerUserId, onChange) {
  const channel = supabase
    .channel(`lr_post_plan_comments_${postPlanId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'post_plan_comments', filter: `post_plan_id=eq.${postPlanId}` },
      async (payload) => {
        try {
          const { data } = await supabase
            .from('post_plan_comments')
            .select(POST_PLAN_COMMENT_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: 'INSERT', comment: mapPostPlanCommentRow(data, viewerUserId) });
        } catch (e) {
          console.warn('post_plan_comments realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- Attachments ----

const POST_PLAN_ATTACHMENT_BUCKET = 'post-plan-attachments';

const POST_PLAN_ATTACHMENT_SELECT = `
  *,
  uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency)
`;

export function mapPostPlanAttachmentRow(row) {
  if (!row) return null;
  const { data: pub } = supabase.storage
    .from(POST_PLAN_ATTACHMENT_BUCKET)
    .getPublicUrl(row.storage_path);
  return {
    id: row.id,
    postPlanId: row.post_plan_id,
    kind: row.kind,
    version: row.version,
    storagePath: row.storage_path,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    uploader: personFromProfile(row.uploader),
    createdAt: row.created_at,
    url: pub?.publicUrl,
  };
}

export async function loadPostPlanAttachments(postPlanId) {
  if (!postPlanId) return [];
  const { data, error } = await supabase
    .from('post_plan_attachments')
    .select(POST_PLAN_ATTACHMENT_SELECT)
    .eq('post_plan_id', postPlanId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapPostPlanAttachmentRow);
}

export async function addPostPlanAttachment({
  postPlanId,
  accountId,
  kind,           // 'reference' | 'final'
  file,
  uploadedBy,
}) {
  if (!postPlanId) throw new Error('addPostPlanAttachment: postPlanId is required');
  if (!accountId)  throw new Error('addPostPlanAttachment: accountId is required');
  if (!kind)       throw new Error('addPostPlanAttachment: kind is required');
  if (!file)       throw new Error('addPostPlanAttachment: file is required');
  if (!uploadedBy) throw new Error('addPostPlanAttachment: uploadedBy is required');

  const safeName = (file.name || 'asset').replace(/[^\w.\-]+/g, '_');
  const path = `${accountId}/${postPlanId}/${Date.now()}_${safeName}`;
  const { error: upErr } = await supabase.storage
    .from(POST_PLAN_ATTACHMENT_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
  if (upErr) throw upErr;

  const { data, error } = await supabase
    .from('post_plan_attachments')
    .insert({
      post_plan_id: postPlanId,
      kind,
      storage_path: path,
      filename: file.name || safeName,
      mime_type: file.type || null,
      size_bytes: file.size || null,
      uploaded_by: uploadedBy,
    })
    .select(POST_PLAN_ATTACHMENT_SELECT)
    .single();
  if (error) {
    // Roll the storage object back so we don't orphan a file the row
    // never got. Best-effort — surface the original DB error either way.
    await supabase.storage.from(POST_PLAN_ATTACHMENT_BUCKET).remove([path]).catch(() => {});
    throw error;
  }
  return mapPostPlanAttachmentRow(data);
}

export async function deletePostPlanAttachment(attachment) {
  if (!attachment?.id) throw new Error('deletePostPlanAttachment: attachment is required');
  // Storage first — if the DB row stays but the file is already gone we'd
  // render a broken thumbnail; if the file stays but the row is gone the
  // user would never see it again. The DB delete is the user-visible bit,
  // so do storage first and let the row delete decide success.
  if (attachment.storagePath) {
    await supabase.storage
      .from(POST_PLAN_ATTACHMENT_BUCKET)
      .remove([attachment.storagePath])
      .catch(() => {});
  }
  const { error } = await supabase
    .from('post_plan_attachments')
    .delete()
    .eq('id', attachment.id);
  if (error) throw error;
}

// =====================================================================
// Post-plan unread tracking (post_plan_views)
// =====================================================================
// A comment counts as "unread" for user U if either there's no view row
// for (U, plan), or the latest comment's created_at > view.last_seen_at.
// We compute this client-side — the server returns view stamps + comment
// timestamps and we diff them. This is the cheapest path for an MVP and
// stays accurate as long as the realtime channel stays connected.

export async function loadPostPlanViews(userId) {
  if (!userId) return new Map();
  const { data, error } = await supabase
    .from('post_plan_views')
    .select('post_plan_id, last_seen_at')
    .eq('user_id', userId);
  if (error) throw error;
  const map = new Map();
  for (const r of data || []) map.set(r.post_plan_id, r.last_seen_at);
  return map;
}

// For a list of post plans visible to the user, compute "unread activity"
// counts — anything that happened on the plan since the user last opened
// it AND was done by someone else. Three sources:
//   1. New comments (author != viewer)
//   2. New attachments (uploader != viewer)
//   3. Plan-level edits (post_plans.updated_at advanced) when the plan
//      wasn't created by the viewer — credits one item for status flips,
//      copy edits, schedule changes, etc.
//
// Returns Map<postPlanId, count>. The calendar uses count > 0 to show a
// red dot; the sidebar adds counts up for its badge.
export async function loadPostPlanUnreadCounts({ userId, postPlans }) {
  if (!userId) return new Map();
  if (!Array.isArray(postPlans) || postPlans.length === 0) return new Map();
  const ids = postPlans.map((p) => p.id);
  const [views, comments, attachments] = await Promise.all([
    loadPostPlanViews(userId),
    supabase
      .from('post_plan_comments')
      .select('post_plan_id, author_id, created_at')
      .in('post_plan_id', ids)
      .neq('author_id', userId)
      .then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      }),
    supabase
      .from('post_plan_attachments')
      .select('post_plan_id, uploaded_by, created_at')
      .in('post_plan_id', ids)
      .neq('uploaded_by', userId)
      .then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      }),
  ]);
  const counts = new Map();
  const bump = (id) => counts.set(id, (counts.get(id) || 0) + 1);
  for (const c of comments) {
    const seen = views.get(c.post_plan_id);
    if (!seen || c.created_at > seen) bump(c.post_plan_id);
  }
  for (const a of attachments) {
    const seen = views.get(a.post_plan_id);
    if (!seen || a.created_at > seen) bump(a.post_plan_id);
  }
  for (const p of postPlans) {
    // No createdBy skip here — markPostPlanSeen runs on every persist
    // (including status changes), so the viewer's own edits won't
    // surface as unread for themselves. But edits by other people on
    // plans the viewer created (e.g. a brand approving an agency-
    // authored plan) MUST surface, which the old skip prevented.
    const seen = views.get(p.id);
    if (!seen || (p.updatedAt && p.updatedAt > seen)) bump(p.id);
  }
  return counts;
}

export async function markPostPlanSeen(postPlanId, userId) {
  if (!postPlanId || !userId) return;
  const { error } = await supabase
    .from('post_plan_views')
    .upsert(
      { post_plan_id: postPlanId, user_id: userId, last_seen_at: new Date().toISOString() },
      { onConflict: 'user_id,post_plan_id' }
    );
  if (error) console.warn('markPostPlanSeen failed', error);
}

// Realtime: any activity on a post plan (comment, attachment, or plan
// edit) re-ticks the unread count. We listen broadly for the active
// brand and let the caller refetch — volume is small per-brand.
export function subscribeToPostPlanActivity({ accountId }, onChange) {
  const channel = supabase
    .channel(`lr_post_plan_activity_${accountId || 'all'}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'post_plan_comments' },
      () => { onChange?.(); }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'post_plan_attachments' },
      () => { onChange?.(); }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'post_plans' },
      () => { onChange?.(); }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// =====================================================================
// Trends Radar — agency-only read of public.trend_signals + edge function
// trigger to refetch from external sources. Compartmentalized away from
// every other surface so the feature can evolve in isolation.
// =====================================================================

function mapTrendSignalRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    region: row.region,
    category: row.category || null,
    title: row.title,
    subtitle: row.subtitle || null,
    url: row.url || null,
    thumbnailUrl: row.thumbnail_url || null,
    metricValue: row.metric_value != null ? Number(row.metric_value) : null,
    metricLabel: row.metric_label || null,
    rank: row.rank != null ? Number(row.rank) : null,
    trendWindow: row.trend_window,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    accountId: row.account_id || null,
  };
}

// Read the current trend pool. RLS is agency-only on this table, so a
// non-agency caller will just get an empty array.
export async function loadTrendSignals({ platform, region, kind, accountId, limit = 200 } = {}) {
  let q = supabase
    .from('trend_signals')
    .select('*')
    .order('platform', { ascending: true })
    .order('region', { ascending: true })
    .order('rank', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (platform) q = q.eq('platform', platform);
  if (region)   q = q.eq('region', region);
  if (kind)     q = q.eq('kind', kind);
  // Per-brand sources (Instagram) write rows with account_id set; global
  // sources (TikTok / Twitter) leave it null. We always filter explicitly
  // so an "agency in All-clients" view doesn't accidentally bleed every
  // brand's Instagram trends together.
  if (accountId === null)             q = q.is('account_id', null);
  else if (accountId !== undefined)   q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) {
    console.warn('loadTrendSignals failed', error);
    return [];
  }
  return (data || []).map(mapTrendSignalRow).filter(Boolean);
}

// Trigger the fetch-trends Vercel serverless function for the given source.
// Agency-only on the server — non-agency callers get a 403 even if they
// bypass UI gating. Lives at /api/fetch-trends in the same Vercel deploy
// as the SPA, so it's a relative URL and CORS isn't a concern.
export async function refreshTrends({ source, regions, window: trendWindow, accountId, mode } = {}) {
  if (!source) throw new Error('refreshTrends: source is required');
  const body = { source };
  if (regions && regions.length > 0) body.regions = regions;
  if (trendWindow) body.window = trendWindow;
  if (accountId)   body.accountId = accountId;
  if (mode)        body.mode = mode;

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('refreshTrends: not signed in');

  let res;
  try {
    res = await fetch('/api/fetch-trends', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (ex) {
    throw new Error(`Could not reach trends API: ${ex?.message || ex}`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const msg = (payload && payload.error) || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new Error(String(payload.error));
  }
  return payload;
}

