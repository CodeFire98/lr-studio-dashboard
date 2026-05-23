/* eslint-disable */
/* Data access layer — all Supabase queries live here.
   Returns tasks in the UI shape the views already consume (MOCK.tasks-compatible),
   so components don't need restructuring as real data replaces mock data. */

import { supabase } from './supabase';
import MOCK from './mockData.js';
import { validateImageDimensions } from './imageValidation.js';
import { isVideoFile, extractVideoThumbnail, thumbnailBlobToFile } from './videoThumbnail.js';

// Sidecar naming convention for video thumbnails. We upload a JPEG frame
// of every video alongside the original at this suffix so the UI can
// render a real preview instead of a generic play icon.
const VIDEO_THUMBNAIL_SUFFIX = '.thumb.jpg';
const isVideoMime = (m) => typeof m === 'string' && m.toLowerCase().startsWith('video/');

// Upload a video's thumbnail sidecar to the same bucket + path scheme.
// Safe to call for non-videos (returns null) and on failure (logs and
// returns null — never fails the parent upload). Returns the sidecar
// storage_path on success.
async function uploadVideoThumbnailSidecar({ bucket, storagePath, file }) {
  if (!isVideoFile(file)) return null;
  try {
    const blob = await extractVideoThumbnail(file);
    if (!blob) return null;
    const thumbFile = thumbnailBlobToFile(blob, file.name || 'thumb');
    if (!thumbFile) return null;
    const thumbPath = `${storagePath}${VIDEO_THUMBNAIL_SUFFIX}`;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(thumbPath, thumbFile, {
        cacheControl: '3600',
        upsert: true,
        contentType: 'image/jpeg',
      });
    if (error) {
      console.warn('video thumbnail upload failed', error);
      return null;
    }
    return thumbPath;
  } catch (e) {
    console.warn('video thumbnail extraction failed', e);
    return null;
  }
}

// Resolve a video attachment's thumbnail public URL by appending the
// sidecar suffix to the storage path. Returns null for non-videos or
// missing paths. The URL is built unconditionally — if the thumbnail
// upload failed at write time, the browser will fall back to the
// onError path in <SafeImage>.
function resolveVideoThumbnailUrl({ bucket, storagePath, mimeType }) {
  if (!storagePath || !isVideoMime(mimeType)) return null;
  const { data } = supabase.storage
    .from(bucket)
    .getPublicUrl(`${storagePath}${VIDEO_THUMBNAIL_SUFFIX}`);
  return data?.publicUrl || null;
}

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
      initials: 'LM',
      role: 'Linkrunner Media',
      avatarColor: '#2B2B2E',
    };
  }
  return {
    id: p.id,
    name: p.display_name || 'Linkrunner Team',
    initials: p.initials || 'LM',
    role: p.is_agency ? 'Linkrunner Media' : 'Brand',
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
      task:tasks(id, title, platform, deadline, created_at, account:accounts(id, name))
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
      // Tasks don't have a "scheduled to post" date; closest analog is
      // their deadline. Fall through to the task's created_at if no
      // deadline. Used by Library grouping for sort + header display.
      parentDate: row.task?.deadline || row.task?.created_at || row.created_at,
      parentDateLabel: row.task?.deadline ? 'Deadline' : 'Created',
      accountId: row.task?.account?.id || null,
      accountName: row.task?.account?.name || null,
    };
  });
  return accountId ? rows.filter((r) => r.accountId === accountId) : rows;
}

// Library (post-plan side): attachments uploaded against a post plan.
// Pass `kind: 'final'` for delivered creatives or `kind: 'reference'`
// for inspiration files the brand has dropped on plans. Both render in
// the same grid shape — LibraryView toggles between them.
//
// Returns the same shape as loadLibraryAssets entries with
// `source: 'post_plan'` so LibraryView can render them with the same
// per-tile component.
export async function loadLibraryPostPlanAttachments({ accountId = null, kind = 'final' } = {}) {
  const { data, error } = await supabase
    .from('post_plan_attachments')
    .select(`
      *,
      uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency),
      post_plan:post_plans(id, concept, platforms, scheduled_at, status, account:accounts(id, name))
    `)
    .eq('kind', kind)
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
      // The user's "date when to upload" — what the Library groups by.
      // Fall through to upload date if a plan somehow has no scheduled_at.
      parentDate: row.post_plan?.scheduled_at || row.created_at,
      parentDateLabel: 'Scheduled',
      parentStatus: row.post_plan?.status || null,
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
  // Reject browser-unrenderable images. See imageValidation.js. Even
  // though the legacy task UI is sunset, the function is still wired
  // through admin upload paths and any oversize image here would render
  // broken everywhere it surfaces (Library, etc.).
  await validateImageDimensions(file);

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
  // Reject browser-unrenderable images — see imageValidation.js.
  await validateImageDimensions(file);
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
  // Reject browser-unrenderable images — see imageValidation.js.
  await validateImageDimensions(file);
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
  // Sidecar thumbnail for videos so the references grid shows a real
  // preview instead of a generic play icon.
  await uploadVideoThumbnailSidecar({ bucket: 'brand-assets', storagePath: path, file });
  const { data } = supabase.storage.from('brand-assets').getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type || null,
    thumbnailUrl: resolveVideoThumbnailUrl({ bucket: 'brand-assets', storagePath: path, mimeType: file.type }),
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
    // Hide the sidecar JPEG thumbnails from the gallery — they're shown
    // implicitly as the preview for the matching video, not as their
    // own tile.
    .filter((o) => !o.name.endsWith(VIDEO_THUMBNAIL_SUFFIX))
    .map((o) => {
      const path = `${accountId}/${o.name}`;
      const { data: pub } = supabase.storage.from('brand-assets').getPublicUrl(path);
      const mimeType = o.metadata?.mimetype || '';
      return {
        path,
        name: o.name.replace(/^\d+_/, ''), // strip the timestamp prefix
        url: pub.publicUrl,
        sizeBytes: o.metadata?.size || 0,
        mimeType,
        createdAt: o.created_at,
        thumbnailUrl: resolveVideoThumbnailUrl({ bucket: 'brand-assets', storagePath: path, mimeType }),
      };
    });
}

export async function deleteBrandAsset(path) {
  if (!path) throw new Error('deleteBrandAsset: path is required');
  // Best-effort sidecar cleanup. Storage remove() ignores missing keys
  // silently, so we can include both unconditionally without checking
  // the original mime type.
  const { error } = await supabase.storage.from('brand-assets').remove([path, `${path}${VIDEO_THUMBNAIL_SUFFIX}`]);
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

// Per-brand toggle for the 6pm-IST daily-digest email. Defaults to true
// at the DB level (migration 0037). Settings page flips it via this helper;
// the Vercel cron route at /api/daily-digest reads it on every run.
export async function loadDailyReminderEnabled(accountId) {
  if (!accountId) return true; // Sensible default — same as the column default.
  const { data, error } = await supabase
    .from('accounts')
    .select('daily_reminder_enabled')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data?.daily_reminder_enabled !== false;
}

export async function updateDailyReminderEnabled(accountId, enabled) {
  if (!accountId) throw new Error('updateDailyReminderEnabled: accountId is required');
  const { error } = await supabase
    .from('accounts')
    .update({ daily_reminder_enabled: !!enabled })
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
    aiGenerated: row.ai_generated === true,
    aiDraftPayload: row.ai_draft_payload && typeof row.ai_draft_payload === 'object'
      ? row.ai_draft_payload
      : {},
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
    status: status || 'drafting',
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
 * Commit a post plan that the LinkAI PROPOSED in chat (via the
 * create_post_plan_draft tool). Unlike `createPostPlan` (human-initiated
 * "Plan a new post" path), this one stamps `ai_generated=true` + saves
 * the original AI proposal under `ai_draft_payload` so we can compare
 * what the model said vs what the admin shipped later if we ever care.
 *
 * Called from LinkAIPanel's ToolCard when the admin clicks "Open plan"
 * on a proposed-draft tile. The proposed draft lives only in chat-UI
 * state until this is invoked, so until the click happens the calendar
 * is untouched.
 */
export async function commitAiDraftPlan({ accountId, userId, draft }) {
  if (!accountId) throw new Error('commitAiDraftPlan: accountId is required');
  if (!draft || typeof draft !== 'object') {
    throw new Error('commitAiDraftPlan: draft payload is required');
  }
  if (!draft.scheduled_at) {
    throw new Error('commitAiDraftPlan: draft.scheduled_at is required');
  }
  // Respect the status the server-side tool put on the draft. Agency
  // callers get 'drafting'; brand callers get 'brand_draft' (so the
  // resulting plan lands in the private brand-edit state, matching
  // the calendar "+ Propose plan" flow). Default to 'drafting' if the
  // draft didn't include a status, for safety with legacy tool history.
  const status = draft.status === 'brand_draft' ? 'brand_draft' : 'drafting';
  const payload = {
    account_id: accountId,
    scheduled_at: draft.scheduled_at,
    platforms: Array.isArray(draft.platforms) ? draft.platforms : [],
    concept: draft.concept || '',
    copy_variants: draft.copy_variants && typeof draft.copy_variants === 'object' ? draft.copy_variants : {},
    status,
    created_by: userId ?? null,
    ai_generated: true,
    ai_draft_payload: draft,
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
 * Each duplicate gets status 'drafting' and scheduled_at at 09:00 local.
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
        status: 'drafting',
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

// =====================================================================
// Plan proposals — brand-side write power through an approval gate
// =====================================================================
// Three proposal kinds:
//   new_plan    — brand created a whole post. The parent post_plan row
//                 lives in status='proposed'; payload may be empty
//                 (the plan itself holds the proposed values).
//   date_change — { scheduled_at: <ISO> }
//   copy_change — { copy_variants: { instagram?, linkedin?, x? } }
//
// Migration 0047 owns the table, RLS, and the triggers that emit
// system messages into the brand conversation thread on
// insert + resolution. These helpers are thin wrappers over the
// PostgREST endpoint — no business logic.

const PROPOSAL_SELECT = `
  id,
  post_plan_id,
  account_id,
  proposed_by,
  kind,
  payload,
  status,
  note,
  agency_response,
  created_at,
  resolved_at,
  resolved_by,
  acknowledged_at
`;

function mapProposalRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    postPlanId: row.post_plan_id,
    accountId: row.account_id,
    proposedBy: row.proposed_by,
    kind: row.kind,
    payload: row.payload || {},
    status: row.status,
    note: row.note,
    agencyResponse: row.agency_response,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    acknowledgedAt: row.acknowledged_at,
  };
}

export async function loadProposalsForPlan(planId) {
  if (!planId) return [];
  const { data, error } = await supabase
    .from('plan_proposals')
    .select(PROPOSAL_SELECT)
    .eq('post_plan_id', planId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapProposalRow);
}

export async function loadPendingProposalsForAccount(accountId) {
  if (!accountId) return [];
  const { data, error } = await supabase
    .from('plan_proposals')
    .select(PROPOSAL_SELECT)
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapProposalRow);
}

// Agency-only — RLS naturally filters to the caller's accessible
// accounts, so a brand user gets back only their own (which is the
// same as loadPendingProposalsForAccount for them).
export async function loadAllPendingProposals() {
  const { data, error } = await supabase
    .from('plan_proposals')
    .select(PROPOSAL_SELECT)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapProposalRow);
}

export async function createProposal({
  planId,
  accountId,
  kind,
  payload,
  note,
  userId,
}) {
  if (!planId) throw new Error('createProposal: planId is required');
  if (!accountId) throw new Error('createProposal: accountId is required');
  if (!kind) throw new Error('createProposal: kind is required');
  if (!userId) throw new Error('createProposal: userId is required');
  if (kind !== 'new_plan' && kind !== 'date_change' && kind !== 'copy_change') {
    throw new Error(`createProposal: unknown kind '${kind}'`);
  }
  const insertRow = {
    post_plan_id: planId,
    account_id: accountId,
    proposed_by: userId,
    kind,
    payload: payload && typeof payload === 'object' ? payload : {},
    note: note || null,
    status: 'pending',
  };
  const { data, error } = await supabase
    .from('plan_proposals')
    .insert(insertRow)
    .select(PROPOSAL_SELECT)
    .single();
  if (error) throw error;
  return mapProposalRow(data);
}

export async function resolveProposal({ proposalId, status, agencyResponse }) {
  if (!proposalId) throw new Error('resolveProposal: proposalId is required');
  if (status !== 'approved' && status !== 'rejected') {
    throw new Error(`resolveProposal: status must be 'approved' or 'rejected'`);
  }
  const patch = { status };
  if (agencyResponse !== undefined) patch.agency_response = agencyResponse;
  const { data, error } = await supabase
    .from('plan_proposals')
    .update(patch)
    .eq('id', proposalId)
    .select(PROPOSAL_SELECT)
    .single();
  if (error) throw error;
  return mapProposalRow(data);
}

// Proposer-only: recall (withdraw) a pending proposal. Distinct from
// resolveProposal — different RLS path (proposer instead of agency),
// different conversations-log verb ("withdrew" vs "rejected"). Added
// 2026-05-22 in migration 0056 to close the gap left by 0047's
// "brand can't undo a proposal" v1 limitation, which became user-
// facing the moment the inline Edit pill (PR B) let brand misclick a
// proposal into existence.
export async function withdrawProposal({ proposalId }) {
  if (!proposalId) throw new Error('withdrawProposal: proposalId is required');
  const { data, error } = await supabase
    .from('plan_proposals')
    .update({ status: 'withdrawn' })
    .eq('id', proposalId)
    .select(PROPOSAL_SELECT)
    .single();
  if (error) throw error;
  return mapProposalRow(data);
}

export async function acknowledgeProposal(proposalId) {
  if (!proposalId) throw new Error('acknowledgeProposal: proposalId is required');
  const { data, error } = await supabase
    .from('plan_proposals')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('id', proposalId)
    .select(PROPOSAL_SELECT)
    .single();
  if (error) throw error;
  return mapProposalRow(data);
}

// =====================================================================
// LinkAI — dynamic suggestion chips (templated fallback)
// =====================================================================
// The PRIMARY path for LinkAI welcome-screen chips is streaming AI
// generation via `experimental_useObject` against `/api/ai/suggestions`
// (mounted directly in LinkAIPanel.jsx) — that gives the admin a
// Refresh button with progressive chip rendering as the model streams
// JSON deltas back.
//
// THIS helper is the fallback path — called by LinkAIPanel ONLY when
// the useObject hook errors (offline, auth, allowlist, brand-kit
// missing). It builds chips deterministically from Supabase data:
// recent approved plans + brand-kit product categories + a date-aware
// brainstorm starter. No AI, no streaming, no cost — just a graceful
// degradation so the welcome state isn't empty.
//
// Always returns 4 strings (or the LINKAI_GENERIC_SUGGESTIONS hardcoded
// set if even Supabase is unreachable).
// =====================================================================
export async function buildTemplatedLinkAISuggestions({ accountId } = {}) {
  if (!accountId) return LINKAI_GENERIC_SUGGESTIONS.slice();

  // Pull the last few approved plans + the brand-kit product_categories
  // in parallel. Tight column lists — we don't need the full POST_PLAN_SELECT.
  const [plansResult, kitResult] = await Promise.all([
    supabase
      .from('post_plans')
      .select('concept, platforms, scheduled_at, status')
      .eq('account_id', accountId)
      .eq('status', 'approved')
      .order('scheduled_at', { ascending: false })
      .limit(3),
    supabase
      .from('brand_kits')
      .select('product_categories')
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);

  const plans = Array.isArray(plansResult.data) ? plansResult.data : [];
  const categories = Array.isArray(kitResult.data?.product_categories)
    ? kitResult.data.product_categories.filter((c) => typeof c === 'string' && c.trim())
    : [];

  const suggestions = [];

  // 1. Follow-up to the most recent approved post.
  const latest = plans[0];
  if (latest?.concept && latest.concept.trim().length > 0) {
    const conceptSnippet = truncateConcept(latest.concept);
    const nextWeekday = formatNextWeekdayPhrase();
    suggestions.push(`Draft a follow-up to "${conceptSnippet}" for ${nextWeekday} at 10am`);
  }

  // 2. Plan-the-week starter — platform-aware.
  const recentPlatforms = pickRecentPlatformsLabel(plans);
  suggestions.push(`Plan three posts for next week across ${recentPlatforms}`);

  // 3. Campaign around a specific product/category if available.
  if (categories.length > 0) {
    suggestions.push(`Plan a campaign featuring our ${categories[0]} for next month`);
  }

  // 4. Date-aware brainstorm starter.
  suggestions.push(`Brainstorm a campaign concept for ${formatBrainstormSeasonPhrase()}`);

  const deduped = [];
  for (const s of suggestions) {
    if (!deduped.includes(s)) deduped.push(s);
    if (deduped.length >= 4) break;
  }
  return deduped.length > 0 ? deduped : LINKAI_GENERIC_SUGGESTIONS.slice();
}

// Fallback set — matches v1's EMPTY_SUGGESTIONS exactly so brand-new
// brands (zero plans, no product_categories) see the same chips they
// saw pre-Phase-3.
const LINKAI_GENERIC_SUGGESTIONS = [
  'Draft an Instagram post about our newest product for next Tuesday at 10am',
  'Plan three posts for next week across IG and LinkedIn',
  'Brainstorm a campaign concept for the holiday season',
];

function truncateConcept(concept) {
  // Concepts are usually a single sentence. Cap at ~60 chars so the
  // chip stays tappable and the quote'd snippet doesn't dominate.
  const trimmed = concept.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57).trimEnd() + '…';
}

function formatNextWeekdayPhrase() {
  // Pick the next occurrence of Tuesday OR Thursday — these tend to be
  // good "draft and schedule" days for IG/LinkedIn. Avoids "Sunday" /
  // "Saturday" which feel low-priority. Always future, never today.
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun..6=Sat
  // 2=Tue, 4=Thu. Pick the closer of the two that's in the future.
  const candidates = [2, 4];
  let best = null;
  for (const target of candidates) {
    let delta = target - dayOfWeek;
    if (delta <= 0) delta += 7;
    if (best === null || delta < best.delta) best = { target, delta };
  }
  return best.target === 2 ? 'next Tuesday' : 'next Thursday';
}

function pickRecentPlatformsLabel(plans) {
  const seen = new Set();
  for (const p of plans) {
    if (Array.isArray(p.platforms)) {
      for (const platform of p.platforms) {
        if (typeof platform === 'string') seen.add(platform);
      }
    }
  }
  const ordered = ['instagram', 'linkedin', 'x'].filter((p) => seen.has(p));
  if (ordered.length === 0) return 'IG and LinkedIn'; // fallback
  if (ordered.length === 1) return labelForPlatform(ordered[0]);
  if (ordered.length === 2) {
    return `${labelForPlatform(ordered[0])} and ${labelForPlatform(ordered[1])}`;
  }
  return `${labelForPlatform(ordered[0])}, ${labelForPlatform(ordered[1])}, and ${labelForPlatform(ordered[2])}`;
}

function labelForPlatform(platform) {
  if (platform === 'instagram') return 'IG';
  if (platform === 'linkedin') return 'LinkedIn';
  if (platform === 'x') return 'X';
  return platform;
}

function formatBrainstormSeasonPhrase() {
  // Use next month's name. Always future-looking. Wraps "December" →
  // "the new year" so the brainstorm chip in late December doesn't
  // suggest January twice.
  const now = new Date();
  const monthIdx = now.getMonth();
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  if (monthIdx === 11) return 'the new year';
  const nextMonth = monthNames[(monthIdx + 1) % 12];
  return `next ${nextMonth}`;
}

export function subscribeToPostPlans(onChange, { accountId } = {}) {
  // Channel names MUST be unique per subscription. supabase-realtime-js
  // tracks subscribed topics globally; two channels with the same name
  // mounting in the same tab (e.g. App-level + a detail view both
  // listening for the active brand's plans) trip a "cannot add
  // `postgres_changes` callbacks ... after `subscribe()`" error on the
  // second .on(). Suffixing with a per-call random id avoids that.
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channelName = accountId
    ? `lr_post_plans_${accountId}_${suffix}`
    : `lr_post_plans_stream_${suffix}`;
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

// Bulk loader for the calendar List view: comment counts + ALL
// attachments (references + deliverables/finals) per plan, in two
// parallel queries. Returns
//   { commentsByPlan: Map<id, count>,
//     attachmentsByPlan: Map<id, [{ id, kind, filename, mimeType, url }, …]> }
// `attachmentsByPlan` is what backs the hover-paperclip thumbnail
// popover; we cap at 6 per plan client-side so a hugely-attached plan
// doesn't dump dozens of items into the DOM. Deliverables (kind='final')
// rank above references (kind='reference') in the cap so the user sees
// the work product first when both are present.
//
// `referencesByPlan` is kept as a back-compat alias on the return so
// any older caller still mounted in the same session keeps working.
export async function loadPostPlanListRollups({ postPlanIds }) {
  if (!Array.isArray(postPlanIds) || postPlanIds.length === 0) {
    const empty = new Map();
    return { commentsByPlan: new Map(), attachmentsByPlan: empty, referencesByPlan: empty };
  }
  const [commentsRes, attachmentsRes] = await Promise.all([
    // Counts top-level messages tagged to each plan (replies excluded so
    // the badge matches what a user sees in the per-plan Discussion
    // panel). Repointed off post_plan_comments in migration 0042 — that
    // table is preserved for rollback but no longer written to.
    supabase
      .from('conversation_messages')
      .select('tagged_post_plan_id')
      .in('tagged_post_plan_id', postPlanIds)
      .is('parent_message_id', null)
      .is('deleted_at', null),
    supabase
      .from('post_plan_attachments')
      .select('id, post_plan_id, kind, storage_path, filename, mime_type, created_at')
      .in('post_plan_id', postPlanIds)
      .order('created_at', { ascending: false }),
  ]);
  if (commentsRes.error) throw commentsRes.error;
  if (attachmentsRes.error) throw attachmentsRes.error;

  const commentsByPlan = new Map();
  for (const r of commentsRes.data || []) {
    const id = r.tagged_post_plan_id;
    if (!id) continue;
    commentsByPlan.set(id, (commentsByPlan.get(id) || 0) + 1);
  }

  // Group all attachments first, then sort each group so deliverables
  // surface ahead of references at the per-plan cap. Within a kind we
  // already get newest-first from the SQL ORDER BY.
  const grouped = new Map();
  for (const a of attachmentsRes.data || []) {
    const list = grouped.get(a.post_plan_id) || [];
    list.push(a);
    grouped.set(a.post_plan_id, list);
  }
  const ATTACHMENT_KIND_RANK = { final: 1, reference: 2 };
  const attachmentsByPlan = new Map();
  for (const [planId, list] of grouped.entries()) {
    list.sort((x, y) => {
      const dr = (ATTACHMENT_KIND_RANK[x.kind] ?? 99) - (ATTACHMENT_KIND_RANK[y.kind] ?? 99);
      if (dr !== 0) return dr;
      return (y.created_at || '').localeCompare(x.created_at || '');
    });
    const capped = list.slice(0, 6).map((a) => {
      const { data: pub } = supabase.storage
        .from(POST_PLAN_ATTACHMENT_BUCKET)
        .getPublicUrl(a.storage_path);
      return {
        id: a.id,
        kind: a.kind,
        filename: a.filename,
        mimeType: a.mime_type,
        url: pub?.publicUrl,
        thumbnailUrl: resolveVideoThumbnailUrl({
          bucket: POST_PLAN_ATTACHMENT_BUCKET,
          storagePath: a.storage_path,
          mimeType: a.mime_type,
        }),
      };
    });
    attachmentsByPlan.set(planId, capped);
  }

  return { commentsByPlan, attachmentsByPlan, referencesByPlan: attachmentsByPlan };
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
    caption: row.caption || '',
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    uploader: personFromProfile(row.uploader),
    createdAt: row.created_at,
    url: pub?.publicUrl,
    thumbnailUrl: resolveVideoThumbnailUrl({
      bucket: POST_PLAN_ATTACHMENT_BUCKET,
      storagePath: row.storage_path,
      mimeType: row.mime_type,
    }),
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

  // Reject images the browser can't render before we ship them to
  // storage — see imageValidation.js. Non-image files (PDFs, etc.) skip
  // the check. Throws a friendly Error with the filename + dimensions
  // if the image is too big; the caller surfaces it to the user.
  await validateImageDimensions(file);

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

  // Fire-and-forget thumbnail upload for videos. We deliberately await
  // the sidecar before inserting the DB row so the thumbnail URL exists
  // by the time the realtime INSERT lands in other clients.
  await uploadVideoThumbnailSidecar({ bucket: POST_PLAN_ATTACHMENT_BUCKET, storagePath: path, file });

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
    await supabase.storage.from(POST_PLAN_ATTACHMENT_BUCKET).remove([path, `${path}${VIDEO_THUMBNAIL_SUFFIX}`]).catch(() => {});
    throw error;
  }
  return mapPostPlanAttachmentRow(data);
}

/**
 * Patch the editable metadata on a post-plan attachment row. Currently
 * limited to `caption` — the human-readable label users can edit
 * post-upload (the filename + storage path are immutable; renaming
 * those would invalidate the underlying file). Returns the refreshed
 * mapped row so the caller can swap it into local state.
 *
 * RLS on `post_plan_attachments` already gates writes to agency staff
 * + post-plan owners, so no extra auth here.
 */
export async function updatePostPlanAttachment(attachmentId, patch) {
  if (!attachmentId) throw new Error('updatePostPlanAttachment: attachmentId is required');
  if (!patch || typeof patch !== 'object') {
    throw new Error('updatePostPlanAttachment: patch is required');
  }
  const dbPatch = {};
  if ('caption' in patch) {
    // Normalize: empty string -> null so list views can fall back to
    // filename uniformly without a defined-vs-empty edge case.
    const c = typeof patch.caption === 'string' ? patch.caption.trim() : '';
    dbPatch.caption = c ? c.slice(0, 280) : null;
  }
  if (Object.keys(dbPatch).length === 0) {
    throw new Error('updatePostPlanAttachment: no editable fields in patch');
  }
  const { data, error } = await supabase
    .from('post_plan_attachments')
    .update(dbPatch)
    .eq('id', attachmentId)
    .select(POST_PLAN_ATTACHMENT_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanAttachmentRow(data);
}

export async function deletePostPlanAttachment(attachment) {
  if (!attachment?.id) throw new Error('deletePostPlanAttachment: attachment is required');
  // Storage first — if the DB row stays but the file is already gone we'd
  // render a broken thumbnail; if the file stays but the row is gone the
  // user would never see it again. The DB delete is the user-visible bit,
  // so do storage first and let the row delete decide success.
  if (attachment.storagePath) {
    const paths = [attachment.storagePath];
    if (isVideoMime(attachment.mimeType)) {
      paths.push(`${attachment.storagePath}${VIDEO_THUMBNAIL_SUFFIX}`);
    }
    await supabase.storage
      .from(POST_PLAN_ATTACHMENT_BUCKET)
      .remove(paths)
      .catch(() => {});
  }
  const { error } = await supabase
    .from('post_plan_attachments')
    .delete()
    .eq('id', attachment.id);
  if (error) throw error;
}

// =====================================================================
// Post-plan publications (the "Posted" terminal state)
// =====================================================================
// A publication row records that a plan went live on a given platform,
// optionally with a URL to the live post. The "Posted" pill in the UI is
// derived: a plan is shown as Posted when status='approved' AND it has
// at least one publications row. The status enum stays at 3 values.
// One row per (plan, platform); upsert on the unique constraint.

const POST_PLAN_PUBLICATION_SELECT = `
  *,
  publisher:profiles!published_by(id, display_name, initials, avatar_color, is_agency)
`;

export function mapPostPlanPublicationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    postPlanId: row.post_plan_id,
    platform: row.platform,
    liveUrl: row.live_url || '',
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    publisher: personFromProfile(row.publisher),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// All publication-list reads default to filtering soft-deleted rows
// (`deleted_at IS NULL`) — added 2026-05-22 alongside the Live Posts
// "Remove post" feature. Engagement-aggregation paths that need
// historical snapshot context for soft-deleted publications pass
// `{ includeDeleted: true }` to opt back in.
export async function loadPostPlanPublications(postPlanId, { includeDeleted = false } = {}) {
  if (!postPlanId) return [];
  let q = supabase
    .from('post_plan_publications')
    .select(POST_PLAN_PUBLICATION_SELECT)
    .eq('post_plan_id', postPlanId)
    .order('published_at', { ascending: false });
  if (!includeDeleted) q = q.is('deleted_at', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(mapPostPlanPublicationRow);
}

// Bulk loader — returns Map<postPlanId, publications[]> for the calendar
// chip rendering (so each chip can derive its display status). One query
// for all plan ids, grouped client-side.
export async function loadPublicationsForPlanIds(postPlanIds, { includeDeleted = false } = {}) {
  if (!Array.isArray(postPlanIds) || postPlanIds.length === 0) return new Map();
  let q = supabase
    .from('post_plan_publications')
    .select(POST_PLAN_PUBLICATION_SELECT)
    .in('post_plan_id', postPlanIds)
    .order('published_at', { ascending: false });
  if (!includeDeleted) q = q.is('deleted_at', null);
  const { data, error } = await q;
  if (error) throw error;
  const grouped = new Map();
  for (const r of data || []) {
    const mapped = mapPostPlanPublicationRow(r);
    const list = grouped.get(mapped.postPlanId) || [];
    list.push(mapped);
    grouped.set(mapped.postPlanId, list);
  }
  return grouped;
}

// Joined loader for the brand-wide Live Posts repository view. Each row
// carries enough plan context (concept, scheduled_at, platforms) so the
// repository tile can render without a follow-up plan fetch.
//
// `includeDeleted: true` keeps soft-deleted rows in the result — used by
// loadEngagementSummaryForBrand so historical aggregates don't drop the
// moment a user clicks "Remove post". The Live Posts grid pass the
// default (false) so removed cards disappear from the UI immediately.
export async function loadBrandPublications(accountId, { includeDeleted = false } = {}) {
  if (!accountId) return [];
  let q = supabase
    .from('post_plan_publications')
    .select(`
      *,
      publisher:profiles!published_by(id, display_name, initials, avatar_color, is_agency),
      post_plan:post_plans!post_plan_id(
        id, account_id, scheduled_at, platforms, concept, status, account:accounts(id, name)
      )
    `)
    .order('published_at', { ascending: false });
  if (!includeDeleted) q = q.is('deleted_at', null);
  const { data, error } = await q;
  if (error) throw error;
  // Filter client-side by accountId via the joined post_plan; doing it as
  // a Postgres filter on a joined column requires a foreign-table syntax
  // that's clunkier than just dropping non-matches here.
  return (data || [])
    .filter((r) => r.post_plan?.account_id === accountId)
    .map((r) => ({
      ...mapPostPlanPublicationRow(r),
      plan: r.post_plan
        ? {
            id: r.post_plan.id,
            accountId: r.post_plan.account_id,
            accountName: r.post_plan.account?.name || null,
            scheduledAt: r.post_plan.scheduled_at,
            platforms: Array.isArray(r.post_plan.platforms) ? r.post_plan.platforms : [],
            concept: r.post_plan.concept || '',
            status: r.post_plan.status,
          }
        : null,
    }));
}

// Insert-or-update a publication row. The DB has a unique constraint on
// (post_plan_id, platform), so re-marking the same platform updates the
// existing row's URL/timestamp instead of stacking a duplicate.
//
// On upsert the payload explicitly sets `deleted_at: null` so a previously
// soft-deleted row (user unchecked then re-checked the same platform)
// reactivates cleanly — without this the ON CONFLICT path would leave
// deleted_at set and the row would stay invisible to the Live Posts grid.
export async function upsertPostPlanPublication({ postPlanId, platform, liveUrl, publishedBy }) {
  if (!postPlanId) throw new Error('upsertPostPlanPublication: postPlanId is required');
  if (!platform)   throw new Error('upsertPostPlanPublication: platform is required');
  if (!publishedBy) throw new Error('upsertPostPlanPublication: publishedBy is required');
  const trimmed = (liveUrl || '').trim();
  const payload = {
    post_plan_id: postPlanId,
    platform,
    live_url: trimmed || null,
    published_by: publishedBy,
    deleted_at: null, // see comment above — reactivates soft-deleted row
    // Stamp published_at on the way in so the row's "live moment" is the
    // marking moment, not a default-only created_at. On conflict we leave
    // the original published_at alone (the user is editing the URL, not
    // re-publishing) by sending it only when null.
  };
  const { data, error } = await supabase
    .from('post_plan_publications')
    .upsert(payload, { onConflict: 'post_plan_id,platform' })
    .select(POST_PLAN_PUBLICATION_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanPublicationRow(data);
}

// SOFT-delete (was hard-delete before 2026-05-22). Function name kept
// for backward compat — every existing caller (MarkAsPostedModal's
// uncheck-platform path, the new Live Posts "Remove post" path) gets
// the safer semantics for free. Engagement snapshots stay intact (the
// CASCADE on post_engagement_snapshots fires only on real DELETEs).
// Reactivation happens automatically via upsertPostPlanPublication's
// `deleted_at: null` payload if the user re-marks the same platform.
export async function deletePostPlanPublication(id) {
  if (!id) throw new Error('deletePostPlanPublication: id is required');
  const { error } = await supabase
    .from('post_plan_publications')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export function subscribeToPostPlanPublications(postPlanId, onChange) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channel = supabase
    .channel(`lr_post_plan_publications_${postPlanId}_${suffix}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'post_plan_publications', filter: `post_plan_id=eq.${postPlanId}` },
      async (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            onChange({ type: 'DELETE', id: payload.old.id });
            return;
          }
          const { data } = await supabase
            .from('post_plan_publications')
            .select(POST_PLAN_PUBLICATION_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: payload.eventType, publication: mapPostPlanPublicationRow(data) });
        } catch (e) {
          console.warn('post_plan_publications realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Stream every publication change in the project — used by surfaces
// that show many plans at once (CalendarView, LivePostsView). Callers
// re-filter by their own plan id set; a full-table channel is cheaper
// than juggling per-plan channels for dozens of rows.
export function subscribeToAllPostPlanPublications(onChange) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channel = supabase
    .channel(`lr_post_plan_publications_stream_${suffix}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'post_plan_publications' },
      async (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            onChange({ type: 'DELETE', id: payload.old.id, postPlanId: payload.old.post_plan_id });
            return;
          }
          const { data } = await supabase
            .from('post_plan_publications')
            .select(POST_PLAN_PUBLICATION_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) {
            onChange({ type: payload.eventType, publication: mapPostPlanPublicationRow(data) });
          }
        } catch (e) {
          console.warn('post_plan_publications stream realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// =====================================================================
// Post-plan engagement: snapshots + embed cache
// =====================================================================
// `post_engagement_snapshots` is append-only — one row per Apify scrape.
// We only read the LATEST per publication for the tile. Historical rows
// power the future monthly-reports feature.
//
// `post_embed_cache` is 1:1 with publications. Holds the visible
// content (author, caption, hero image) for the static embed card.
//
// Writes happen exclusively via /api/engagement/refresh (service-role)
// — there's no client INSERT path. The db.js exports here are read-only
// plus a tiny POST helper that calls the route.

export function mapEngagementSnapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicationId: row.publication_id,
    fetchedAt: row.fetched_at,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    shareCount: row.share_count,
    saveCount: row.save_count,
    viewCount: row.view_count,
    bookmarkCount: row.bookmark_count,
    quoteCount: row.quote_count,
    reactionCount: row.reaction_count,
    engagementRate: row.engagement_rate,
    availabilityNotes: row.availability_notes,
    actorId: row.actor_id,
    actorRunId: row.actor_run_id,
    scrapeStatus: row.scrape_status, // 'ok' | 'partial' | 'failed' | 'blocked'
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export function mapEmbedCacheRow(row) {
  if (!row) return null;
  return {
    publicationId: row.publication_id,
    authorHandle: row.author_handle,
    authorDisplayName: row.author_display_name,
    authorAvatarUrl: row.author_avatar_url,
    caption: row.caption,
    mediaType: row.media_type, // 'image' | 'video' | 'carousel' | 'text' | 'unknown'
    mediaUrl: row.media_url,
    mediaUrls: Array.isArray(row.media_urls) ? row.media_urls : null,
    mediaAspectRatio: row.media_aspect_ratio,
    postedAt: row.posted_at,
    oembedHtml: row.oembed_html,
    lastRefreshedAt: row.last_refreshed_at,
    refreshStatus: row.refresh_status, // 'ok' | 'failed' | 'stale'
  };
}

// Bulk loader — returns Map<publicationId, latestSnapshot>. The
// schema indexes (publication_id, fetched_at desc) so the
// distinct-on emulation here is cheap: fetch in order, keep first
// hit per publication_id.
export async function loadLatestEngagementSnapshots(publicationIds) {
  if (!Array.isArray(publicationIds) || publicationIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('post_engagement_snapshots')
    .select('*')
    .in('publication_id', publicationIds)
    .order('fetched_at', { ascending: false });
  if (error) throw error;
  const out = new Map();
  for (const row of data || []) {
    if (!out.has(row.publication_id)) {
      out.set(row.publication_id, mapEngagementSnapshotRow(row));
    }
  }
  return out;
}

export async function loadEmbedCacheForPublications(publicationIds) {
  if (!Array.isArray(publicationIds) || publicationIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('post_embed_cache')
    .select('*')
    .in('publication_id', publicationIds);
  if (error) throw error;
  const out = new Map();
  for (const row of data || []) {
    out.set(row.publication_id, mapEmbedCacheRow(row));
  }
  return out;
}

// Subscribe to ALL engagement-snapshot changes project-wide. LivePostsView
// re-filters by the publication ids it knows about. Mirrors the
// subscribeToAllPostPlanPublications pattern — cheaper than per-publication
// channels at this row count.
export function subscribeToAllEngagementSnapshots(onChange) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channel = supabase
    .channel(`lr_post_engagement_snapshots_stream_${suffix}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'post_engagement_snapshots' },
      async (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            onChange({ type: 'DELETE', id: payload.old.id, publicationId: payload.old.publication_id });
            return;
          }
          // Fetch the full row — payload.new strips some columns under RLS.
          const { data } = await supabase
            .from('post_engagement_snapshots')
            .select('*')
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) {
            onChange({ type: payload.eventType, snapshot: mapEngagementSnapshotRow(data) });
          }
        } catch (e) {
          console.warn('post_engagement_snapshots realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export function subscribeToAllEmbedCache(onChange) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channel = supabase
    .channel(`lr_post_embed_cache_stream_${suffix}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'post_embed_cache' },
      async (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            onChange({ type: 'DELETE', publicationId: payload.old.publication_id });
            return;
          }
          const { data } = await supabase
            .from('post_embed_cache')
            .select('*')
            .eq('publication_id', payload.new.publication_id)
            .maybeSingle();
          if (data) {
            onChange({ type: payload.eventType, embed: mapEmbedCacheRow(data) });
          }
        } catch (e) {
          console.warn('post_embed_cache realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Fires the production /api/engagement/refresh route for a single
// publication. Agency users can call freely; brand users get a one-shot
// first scrape per publication, then the server returns
// `{ ok: true, skipped: 'already_scraped' }` (still 2xx) — see the auth
// model comment in web/api/engagement/refresh.ts. This client helper
// just forwards the JWT and reads the response.
//
// Returns the parsed JSON body on 2xx. Throws an Error with a useful
// message on non-2xx (e.g. 403 if a brand user calls for a publication
// in a brand they don't belong to).
export async function refreshEngagement(publicationId) {
  if (!publicationId) throw new Error('refreshEngagement: publicationId is required');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  const res = await fetch('/api/engagement/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ publicationId }),
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!res.ok) {
    const msg = payload?.error || `Engagement refresh failed: HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

// =====================================================================
// Monthly-report data hook (PR 8 of the engagement series)
// =====================================================================
// Single read-only helper that consumes snapshots from the cron-driven
// `post_engagement_snapshots` table to produce per-publication deltas
// over an arbitrary date range. The future monthly-report builder
// (calendar export, agency-side performance dashboard, brand-side
// monthly recap email, etc.) consumes this without any further DB
// plumbing.
//
// Output shape — one entry per publication in the brand:
//   {
//     publication,           // mapped post_plan_publications row
//     plan,                  // post_plans context (concept, scheduledAt, platforms)
//     firstSnapshot,         // earliest snapshot WITHIN the range, or null
//     lastSnapshot,          // latest snapshot WITHIN the range, or null
//     snapshotCount,         // how many snapshots fell in the range
//     delta,                 // { likeDelta, commentDelta, ... } or null
//     note,                  // 'no_snapshots_in_range' | 'single_snapshot_only' | null
//   }
//
// Delta semantics:
//   - delta = last - first for each metric, when both snapshots exist
//     AND they're not the same row (snapshotCount > 1).
//   - delta is null when either bound is missing OR when there's only
//     one snapshot in range (a single sample tells us the value at
//     that instant but not the change across the window).
//   - Per-metric deltas can be negative (LinkedIn unliked, IG removed
//     by user, etc.) — caller decides whether to clamp to 0 for display.
//
// "First/last in range" semantic (not "closest to bound"):
//   - For monthly reports the standard interpretation is "what was the
//     state at the start of the period vs. the end". The earliest
//     snapshot with fetched_at >= fromISO and the latest with
//     fetched_at <= toISO match that intuition.
//   - Snapshots taken OUTSIDE the range are deliberately ignored —
//     they'd give a misleadingly long curve. If a publication has
//     zero snapshots in the range (e.g. it was first scraped after
//     the period ended), we surface that as
//     note='no_snapshots_in_range' so the caller can render an
//     "insufficient data" cell.
//
// Cost: two queries (one for publications, one for snapshots in range).
// At full rollout (~1000 publications × ~30 snapshots/month = ~30k
// rows per query) the snapshots table read is the heavier of the two,
// but indexed on (publication_id, fetched_at desc) so the filter is
// cheap. Returns all rows to the client; the future report UI can
// paginate if it ever needs to.

/**
 * Compute first/last/delta engagement for every publication of a brand
 * within a date range. Designed for the monthly-reports surface.
 *
 * @param {string} accountId - brand account id
 * @param {string} fromISO   - lower bound (inclusive), ISO timestamp
 * @param {string} toISO     - upper bound (inclusive), ISO timestamp
 * @returns {Promise<Array<{
 *   publication: object,
 *   plan: object|null,
 *   firstSnapshot: object|null,
 *   lastSnapshot: object|null,
 *   snapshotCount: number,
 *   delta: {
 *     likeDelta: number|null,
 *     commentDelta: number|null,
 *     shareDelta: number|null,
 *     saveDelta: number|null,
 *     viewDelta: number|null,
 *     bookmarkDelta: number|null,
 *     reactionDelta: number|null,
 *     totalEngagementDelta: number|null,
 *   }|null,
 *   note: 'no_snapshots_in_range'|'single_snapshot_only'|null,
 * }>>}
 */
export async function loadEngagementForBrandRange(accountId, fromISO, toISO) {
  if (!accountId) return [];
  if (!fromISO || !toISO) throw new Error('loadEngagementForBrandRange: fromISO and toISO are required');

  // Step 1 — load the brand's publications, including soft-deleted ones.
  // The monthly-report needs historical numbers for posts that have since
  // been removed from the Live Posts grid; the engagement snapshots they
  // accumulated before deletion are still part of the brand's truth.
  // See `loadEngagementSummaryForBrand` for the same rationale.
  const publications = await loadBrandPublications(accountId, { includeDeleted: true });
  if (publications.length === 0) return [];

  // Step 2 — bulk-load snapshots in range for those publications.
  // Single query, ordered ascending so the first row per pub is the
  // earliest in range and the last row per pub is the latest.
  const pubIds = publications.map((p) => p.id);
  const { data, error } = await supabase
    .from('post_engagement_snapshots')
    .select('*')
    .in('publication_id', pubIds)
    .gte('fetched_at', fromISO)
    .lte('fetched_at', toISO)
    .order('fetched_at', { ascending: true });
  if (error) throw error;

  // Step 3 — group by publication, keeping the asc order so [0] is
  // earliest and [length-1] is latest.
  const byPubId = new Map();
  for (const row of data || []) {
    const mapped = mapEngagementSnapshotRow(row);
    const list = byPubId.get(mapped.publicationId) || [];
    list.push(mapped);
    byPubId.set(mapped.publicationId, list);
  }

  // Step 4 — build the per-publication result.
  return publications.map((pub) => {
    const snaps = byPubId.get(pub.id) || [];
    const firstSnapshot = snaps[0] || null;
    const lastSnapshot = snaps.length > 0 ? snaps[snaps.length - 1] : null;

    let delta = null;
    let note = null;
    if (snaps.length === 0) {
      note = 'no_snapshots_in_range';
    } else if (snaps.length === 1) {
      note = 'single_snapshot_only';
      // delta stays null — one sample tells us a value, not a change.
    } else {
      delta = {
        likeDelta:       numDelta(firstSnapshot.likeCount,      lastSnapshot.likeCount),
        commentDelta:    numDelta(firstSnapshot.commentCount,   lastSnapshot.commentCount),
        shareDelta:      numDelta(firstSnapshot.shareCount,     lastSnapshot.shareCount),
        saveDelta:       numDelta(firstSnapshot.saveCount,      lastSnapshot.saveCount),
        viewDelta:       numDelta(firstSnapshot.viewCount,      lastSnapshot.viewCount),
        bookmarkDelta:   numDelta(firstSnapshot.bookmarkCount,  lastSnapshot.bookmarkCount),
        reactionDelta:   numDelta(firstSnapshot.reactionCount,  lastSnapshot.reactionCount),
        // Sum of the "loud" engagement metrics: likes + comments + shares.
        // Views/saves/bookmarks deliberately excluded — they're
        // visibility signals, not engagement actions, and the same
        // headline number that the LivePostsView tile sums.
        totalEngagementDelta: sumDeltas(
          numDelta(firstSnapshot.likeCount,    lastSnapshot.likeCount),
          numDelta(firstSnapshot.commentCount, lastSnapshot.commentCount),
          numDelta(firstSnapshot.shareCount,   lastSnapshot.shareCount),
        ),
      };
    }

    return {
      publication: pub,        // mapped publication row (id, platform, liveUrl, publishedAt, publisher)
      plan: pub.plan ?? null,  // plan context (concept, scheduledAt, platforms, accountName)
      firstSnapshot,
      lastSnapshot,
      snapshotCount: snaps.length,
      delta,
      note,
    };
  });
}

// Subtract two possibly-null counts. Returns null if either side is
// null/undefined (we don't know the value at that bound, so we can't
// compute a delta — be honest about it).
function numDelta(first, last) {
  if (first === null || first === undefined) return null;
  if (last === null || last === undefined) return null;
  return last - first;
}

// Sum that propagates "we don't know" (null) through. Used for the
// totalEngagementDelta — if ANY of the contributing deltas is null,
// we can't trust the sum, so the total is also null. The report can
// fall back to the per-metric deltas it does have.
function sumDeltas(...vals) {
  if (vals.some((v) => v === null || v === undefined)) return null;
  return vals.reduce((acc, v) => acc + v, 0);
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
    // Repointed off post_plan_comments in migration 0042 — comments now
    // live as top-level rows in conversation_messages with
    // tagged_post_plan_id set. Replies (parent_message_id NOT NULL) are
    // excluded; thread unread for the per-plan dot lands once the new
    // chat UI ships in PR 2.
    supabase
      .from('conversation_messages')
      .select('tagged_post_plan_id, author_id, created_at')
      .in('tagged_post_plan_id', ids)
      .is('parent_message_id', null)
      .is('deleted_at', null)
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
    const planId = c.tagged_post_plan_id;
    if (!planId) continue;
    const seen = views.get(planId);
    if (!seen || c.created_at > seen) bump(planId);
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
      // Comments now live in `conversation_messages` (migration 0042).
      // Filtered to tagged-to-a-plan rows so general chat (PR 2+)
      // doesn't re-tick per-plan unread.
      { event: '*', schema: 'public', table: 'conversation_messages' },
      (payload) => {
        const tagged = payload.new?.tagged_post_plan_id || payload.old?.tagged_post_plan_id;
        if (!tagged) return;
        onChange?.();
      }
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
// Conversations — unified per-brand chat (migration 0042)
// =====================================================================
// One conversation per brand account. Replaces the per-plan
// post_plan_comments thread; the existing PostPlanDetailView tab is
// repointed at this table via loadMessagesForPostPlan / addMessage…
// helpers that filter by tagged_post_plan_id. The new /conversations
// surface (PR 2) reads the same rows unfiltered.
//
// Read-row shape mirrors the legacy comment shape so the existing
// detail-view UI doesn't need to know we swapped tables under it.

// Named with the table prefix so it doesn't collide with the legacy
// MESSAGE_SELECT / mapMessageRow above (which target the original
// public.messages task-chat table from migration 0001 — still on disk
// while the tasks-table cleanup is pending in REFERENCE.md §14).
//
// `attachments` is a nested embed of message_attachments — saves a
// separate query per message. Newly-inserted attachments arrive via
// realtime on the message_attachments table and the client merges
// them into the existing message row.
const CONVERSATION_MESSAGE_SELECT = `
  *,
  author:profiles!author_id(id, display_name, initials, avatar_color, is_agency),
  attachments:message_attachments(*)
`;

const CONVERSATION_ATTACHMENTS_BUCKET = 'post-plan-attachments';

export function mapMessageAttachmentRow(row) {
  if (!row) return null;
  let url = row.url || null;
  let thumbnailUrl = null;
  if (row.storage_path) {
    const { data: pub } = supabase.storage
      .from(CONVERSATION_ATTACHMENTS_BUCKET)
      .getPublicUrl(row.storage_path);
    url = pub?.publicUrl || null;
    thumbnailUrl = resolveVideoThumbnailUrl({
      bucket: CONVERSATION_ATTACHMENTS_BUCKET,
      storagePath: row.storage_path,
      mimeType: row.mime_type,
    });
  }
  return {
    id: row.id,
    messageId: row.message_id,
    kind: row.kind,
    storagePath: row.storage_path || null,
    url,
    thumbnailUrl,
    filename: row.filename || null,
    mimeType: row.mime_type || null,
    sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    width: row.width != null ? Number(row.width) : null,
    height: row.height != null ? Number(row.height) : null,
    uploadedBy: row.uploaded_by || null,
    createdAt: row.created_at,
  };
}

export function mapConversationMessageRow(row, viewerUserId) {
  if (!row) return null;
  const author = personFromProfile(row.author);
  const mine = viewerUserId && row.author_id === viewerUserId;
  const attachments = Array.isArray(row.attachments)
    ? row.attachments
        .map(mapMessageAttachmentRow)
        .filter(Boolean)
        // Stable order: original upload order (oldest-first inside a single bubble).
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    : [];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentMessageId: row.parent_message_id || null,
    taggedPostPlanId: row.tagged_post_plan_id || null,
    authorId: row.author_id,
    from: mine ? 'me' : 'them',
    who: author,
    body: row.body || '',
    kind: row.kind || 'user',  // 'user' (default) or 'system' — system events
                               // emitted by the lifecycle triggers (migration 0047/0050).
    time: formatRelative(row.created_at),
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
    attachments,
    // Legacy alias so existing UI that reads `postPlanId` keeps working
    // when this row was returned by loadMessagesForPostPlan.
    postPlanId: row.tagged_post_plan_id || null,
  };
}

// Fetches (or returns null if missing — fall through to backfill on the
// server side) the single conversation row for a brand account.
export async function loadConversationForAccount(accountId) {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from('conversations')
    .select('id, account_id, created_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, accountId: data.account_id, createdAt: data.created_at };
}

// Drop-in replacement for loadPostPlanComments. Reads messages tagged
// to this plan from the brand's conversation, in chronological order.
// Filters out deleted_at = non-null (PR 2 will add a tombstone row UI;
// for the legacy detail-view tab in PR 1 we just hide them).
export async function loadMessagesForPostPlan(postPlanId, viewerUserId) {
  if (!postPlanId) return [];
  const { data, error } = await supabase
    .from('conversation_messages')
    .select(CONVERSATION_MESSAGE_SELECT)
    .eq('tagged_post_plan_id', postPlanId)
    .is('parent_message_id', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => mapConversationMessageRow(r, viewerUserId));
}

// Drop-in replacement for addPostPlanComment. Looks up the brand's
// conversation, inserts a top-level message tagged to the plan.
export async function addMessageForPostPlan({ postPlanId, accountId, body, authorId }) {
  if (!postPlanId || !accountId || !authorId) {
    throw new Error('addMessageForPostPlan: postPlanId, accountId, authorId required');
  }
  const conv = await loadConversationForAccount(accountId);
  if (!conv) {
    // Brand has no conversation row — should never happen post-migration
    // (the trigger from 0042 auto-creates one on brand insert), but the
    // defensive path keeps the UI from silently swallowing the failure.
    throw new Error(`No conversation found for account ${accountId}`);
  }
  const { data, error } = await supabase
    .from('conversation_messages')
    .insert({
      conversation_id: conv.id,
      tagged_post_plan_id: postPlanId,
      author_id: authorId,
      body,
    })
    .select(CONVERSATION_MESSAGE_SELECT)
    .single();
  if (error) throw error;
  return mapConversationMessageRow(data, authorId);
}

// Drop-in replacement for subscribeToPostPlanComments. Listens for new
// messages tagged to this plan; existing detail-view callers receive
// the same { type: 'INSERT', comment } payload they expect.
export function subscribeToMessagesForPostPlan(postPlanId, viewerUserId, onChange) {
  const channel = supabase
    .channel(`lr_conv_messages_for_plan_${postPlanId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'conversation_messages', filter: `tagged_post_plan_id=eq.${postPlanId}` },
      async (payload) => {
        try {
          // Only surface top-level messages here — replies are scoped
          // to the unified Conversations view's thread drawer.
          if (payload.new?.parent_message_id) return;
          const { data } = await supabase
            .from('conversation_messages')
            .select(CONVERSATION_MESSAGE_SELECT)
            .eq('id', payload.new.id)
            .maybeSingle();
          if (data) onChange({ type: 'INSERT', comment: mapConversationMessageRow(data, viewerUserId) });
        } catch (e) {
          console.warn('conversation_messages realtime failed', e);
        }
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Sidebar Conversations badge — count of top-level messages in the
// brand's conversation that the user hasn't seen yet (created after
// their last_seen_at, by someone else). Cheap: one view-row read +
// one count query, both narrow to a single conversation. Replies
// (parent_message_id IS NOT NULL) are excluded from the badge for v1
// — once the thread drawer ships in PR 2 we can revisit per-thread
// unread tracking.
export async function loadConversationUnreadCount({ userId, accountId }) {
  if (!userId || !accountId) return 0;
  const conv = await loadConversationForAccount(accountId);
  if (!conv) return 0;
  const { data: viewRow } = await supabase
    .from('conversation_views')
    .select('last_seen_at')
    .eq('user_id', userId)
    .eq('conversation_id', conv.id)
    .maybeSingle();
  const lastSeen = viewRow?.last_seen_at || null;
  // Counts BOTH top-level messages AND thread replies — a reply
  // posted by another user is still "unread activity" the badge
  // should surface, even if the user has the channel open but the
  // thread drawer closed. Excludes soft-deleted rows and own writes.
  let q = supabase
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conv.id)
    .is('deleted_at', null)
    .neq('author_id', userId);
  if (lastSeen) q = q.gt('created_at', lastSeen);
  const { count, error } = await q;
  if (error) {
    console.warn('loadConversationUnreadCount failed', error);
    return 0;
  }
  return count || 0;
}

// Stamp the brand's conversation as fully seen for this user. Called
// when the user opens the unified Conversations view (PR 2) or — once
// we want plan-detail reads to clear the badge too — when a plan-tab
// loads. For PR 1 only the placeholder ConversationsView calls this,
// so opening a single plan tab does NOT clear the brand-wide badge.
export async function markConversationSeen({ userId, accountId }) {
  if (!userId || !accountId) return;
  const conv = await loadConversationForAccount(accountId);
  if (!conv) return;
  const { error } = await supabase
    .from('conversation_views')
    .upsert(
      { user_id: userId, conversation_id: conv.id, last_seen_at: new Date().toISOString() },
      { onConflict: 'user_id,conversation_id' }
    );
  if (error) console.warn('markConversationSeen failed', error);
}

// Realtime: any message INSERT in the brand's conversation re-ticks
// the unread badge. Volume per-brand is small so we don't bother
// filtering on the conversation_id at the realtime level — the caller
// re-queries the count and the noise is negligible.
export function subscribeToConversationActivity({ accountId }, onChange) {
  const channel = supabase
    .channel(`lr_conversation_activity_${accountId || 'all'}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversation_messages' },
      () => { onChange?.(); }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- Conversation chat feed (PR 2) -----------------------------------

// Loads every top-level message for a conversation, ascending so the
// caller can render oldest-at-top and scroll to the bottom on mount.
// **Includes tombstones (deleted_at NOT NULL).** WhatsApp-style: a
// deleted message stays visible as a "Message deleted" placeholder so
// users can see the conversation flow had a message there. Replies
// (parent_message_id NOT NULL) are excluded — the thread drawer
// fetches those on demand via loadThreadReplies.
export async function loadConversationMessages(conversationId, viewerUserId) {
  if (!conversationId) return [];
  const { data, error } = await supabase
    .from('conversation_messages')
    .select(CONVERSATION_MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .is('parent_message_id', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => mapConversationMessageRow(r, viewerUserId));
}

// For a list of top-level message ids, return a Map<id, replyCount>.
// Counts INCLUDE soft-deleted replies — those still take a slot in
// the thread drawer as "Message deleted" tombstones, so the parent's
// "↳ N replies" link should match what the user sees when they open
// the drawer.
export async function loadThreadReplyCountsForMessages(parentIds) {
  if (!Array.isArray(parentIds) || parentIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('parent_message_id')
    .in('parent_message_id', parentIds);
  if (error) throw error;
  const counts = new Map();
  for (const r of data || []) {
    const id = r.parent_message_id;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// Replies for a given thread. Ascending so the drawer renders oldest
// at top under the pinned parent. **Includes tombstones** so deleted
// replies stay visible as "Message deleted" placeholders — same
// WhatsApp-style behaviour as the top-level feed.
export async function loadThreadReplies(parentMessageId, viewerUserId) {
  if (!parentMessageId) return [];
  const { data, error } = await supabase
    .from('conversation_messages')
    .select(CONVERSATION_MESSAGE_SELECT)
    .eq('parent_message_id', parentMessageId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => mapConversationMessageRow(r, viewerUserId));
}

// Generic message insert for the unified chat. Supports both top-level
// messages (parentMessageId omitted) and thread replies (parentMessage
// Id set). Optional taggedPostPlanId renders the plan-chip card.
export async function addConversationMessage({ conversationId, body, authorId, taggedPostPlanId, parentMessageId }) {
  if (!conversationId || !authorId || !body) {
    throw new Error('addConversationMessage: conversationId, authorId, body required');
  }
  const { data, error } = await supabase
    .from('conversation_messages')
    .insert({
      conversation_id: conversationId,
      author_id: authorId,
      body,
      tagged_post_plan_id: taggedPostPlanId || null,
      parent_message_id: parentMessageId || null,
    })
    .select(CONVERSATION_MESSAGE_SELECT)
    .single();
  if (error) throw error;
  return mapConversationMessageRow(data, authorId);
}

// Subscribe to INSERT + UPDATE in a conversation (top-level + replies)
// AND any new message_attachments rows landing on its messages. The
// caller routes events to the right pane based on payload type +
// message.parentMessageId (null → feed, non-null → thread drawer).
// Volume per-conversation is small; full-row hydrate keeps callers
// ergonomic. UPDATE events cover soft-deletes (deleted_at flip) and
// future edited_at edits — both render as in-place re-renders.
export function subscribeToConversationMessages(conversationId, viewerUserId, onChange) {
  if (!conversationId) return () => {};
  const hydrate = async (id, type) => {
    try {
      const { data } = await supabase
        .from('conversation_messages')
        .select(CONVERSATION_MESSAGE_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (data) onChange?.({ type, message: mapConversationMessageRow(data, viewerUserId) });
    } catch (e) {
      console.warn('conversation_messages realtime hydrate failed', e);
    }
  };
  const channel = supabase
    .channel(`lr_conv_msgs_${conversationId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'conversation_messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => { hydrate(payload.new.id, 'INSERT'); }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'conversation_messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => { hydrate(payload.new.id, 'UPDATE'); }
    )
    // message_attachments have no conversation_id, so we listen broadly
    // and let the caller filter by whether the message_id is in our
    // visible set. Per-conversation volume is tiny — fine to over-subscribe.
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'message_attachments' },
      (payload) => {
        const att = mapMessageAttachmentRow(payload.new);
        if (att) onChange?.({ type: 'ATTACHMENT_INSERT', attachment: att });
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Soft-delete: stamps `deleted_at` so the bubble renders as a
// WhatsApp-style "Message deleted" tombstone for everyone. RLS already
// limits UPDATE to own messages or agency. We avoid hard-delete so the
// tombstone preserves the conversation flow + reply parent.
export async function softDeleteMessage(messageId) {
  if (!messageId) return;
  const { error } = await supabase
    .from('conversation_messages')
    .update({ deleted_at: new Date().toISOString(), body: '' })
    .eq('id', messageId);
  if (error) throw error;
}

// Upload one file + insert one row into message_attachments. Reuses
// the existing post-plan-attachments bucket — its RLS only checks the
// first path segment is the caller's accountId, so the new path
// scheme `<accountId>/messages/<messageId>/<filename>` slots in
// cleanly without a new bucket + new policy block.
//
// Returns the mapped attachment row.
export async function addMessageAttachment({ accountId, messageId, file, uploaderId }) {
  if (!accountId || !messageId || !file) {
    throw new Error('addMessageAttachment: accountId, messageId, file required');
  }
  const safeName = (file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${accountId}/messages/${messageId}/${Date.now()}_${safeName}`;
  const { error: upErr } = await supabase.storage
    .from(CONVERSATION_ATTACHMENTS_BUCKET)
    .upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) throw upErr;
  const mt = file.type || '';
  let kind = 'file';
  if (mt.startsWith('image/')) kind = 'image';
  else if (mt.startsWith('video/')) kind = 'video';
  const { data, error } = await supabase
    .from('message_attachments')
    .insert({
      message_id: messageId,
      kind,
      storage_path: path,
      filename: file.name || null,
      mime_type: mt || null,
      size_bytes: file.size != null ? file.size : null,
      uploaded_by: uploaderId || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapMessageAttachmentRow(data);
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
    // raw_payload carries source-specific extras the UI uses for richer
    // rendering (e.g. IG audio rows store competitor + aggregator handle
    // lists here so cards can show "@glossier, @drunkelephant" inline
    // without re-querying). Pass it through as-is — it's already small
    // jsonb, no need to project specific fields client-side.
    rawPayload: row.raw_payload || null,
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

// =====================================================================
// Post-plan ideas — brand "Got ideas?" + agency "Inbox"
// =====================================================================
// A post_plan_idea is a brand-submitted content suggestion that the
// agency reviews and converts into a real post_plans row. Inbox is
// the agency's queue; Got ideas? is the brand's composer + history.

const POST_PLAN_IDEA_SELECT = `
  *,
  account:accounts(id, name, type, accent_color),
  submitter:profiles!submitted_by(id, display_name, initials, avatar_color, is_agency)
`;

function mapPostPlanIdeaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account?.name || null,
    title: row.title || '',
    details: row.details || '',
    desiredDate: row.desired_date || null,
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    status: row.status,
    submittedBy: row.submitted_by,
    submitter: personFromProfile(row.submitter),
    convertedPostPlanId: row.converted_post_plan_id || null,
    convertedAt: row.converted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadPostPlanIdeas({ accountId, statuses } = {}) {
  let query = supabase
    .from('post_plan_ideas')
    .select(POST_PLAN_IDEA_SELECT)
    .order('created_at', { ascending: false });
  if (accountId) query = query.eq('account_id', accountId);
  if (Array.isArray(statuses) && statuses.length) query = query.in('status', statuses);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(mapPostPlanIdeaRow);
}

export async function loadPostPlanIdeaById(id) {
  const { data, error } = await supabase
    .from('post_plan_ideas')
    .select(POST_PLAN_IDEA_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapPostPlanIdeaRow(data) : null;
}

export async function createPostPlanIdea({
  accountId,
  title,
  details,
  desiredDate,
  platforms,
  userId,
}) {
  if (!accountId) throw new Error('createPostPlanIdea: accountId is required');
  if (!title || !title.trim()) throw new Error('createPostPlanIdea: title is required');
  const payload = {
    account_id: accountId,
    title: title.trim(),
    details: details || '',
    desired_date: desiredDate || null,
    platforms: Array.isArray(platforms) ? platforms : [],
    status: 'submitted',
    submitted_by: userId ?? null,
  };
  const { data, error } = await supabase
    .from('post_plan_ideas')
    .insert(payload)
    .select(POST_PLAN_IDEA_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanIdeaRow(data);
}

function postPlanIdeaPatchToColumns(patch) {
  const out = {};
  if (patch == null) return out;
  if (patch.title !== undefined)        out.title = patch.title;
  if (patch.details !== undefined)      out.details = patch.details;
  if (patch.desiredDate !== undefined)  out.desired_date = patch.desiredDate || null;
  if (patch.platforms !== undefined)    out.platforms = patch.platforms;
  if (patch.status !== undefined)       out.status = patch.status;
  if (patch.convertedPostPlanId !== undefined) out.converted_post_plan_id = patch.convertedPostPlanId;
  if (patch.convertedAt !== undefined)  out.converted_at = patch.convertedAt;
  return out;
}

export async function updatePostPlanIdea(id, patch) {
  const cols = postPlanIdeaPatchToColumns(patch);
  if (Object.keys(cols).length === 0) return loadPostPlanIdeaById(id);
  const { data, error } = await supabase
    .from('post_plan_ideas')
    .update(cols)
    .eq('id', id)
    .select(POST_PLAN_IDEA_SELECT)
    .single();
  if (error) throw error;
  return mapPostPlanIdeaRow(data);
}

export async function deletePostPlanIdea(id) {
  const { error } = await supabase.from('post_plan_ideas').delete().eq('id', id);
  if (error) throw error;
}

// ----- Idea attachments (reuses the post-plan-attachments bucket) ----
// Path scheme: <accountId>/ideas/<ideaId>/<ts>_<filename> — the bucket's
// storage RLS extracts accountId via split_part(name, '/', 1) so this
// path layout works without policy changes.

const POST_PLAN_IDEA_ATTACHMENT_SELECT = `
  *,
  uploader:profiles!uploaded_by(id, display_name, initials, avatar_color, is_agency)
`;

function mapPostPlanIdeaAttachmentRow(row) {
  if (!row) return null;
  const { data: pub } = supabase.storage
    .from(POST_PLAN_ATTACHMENT_BUCKET)
    .getPublicUrl(row.storage_path);
  return {
    id: row.id,
    ideaId: row.idea_id,
    storagePath: row.storage_path,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    uploader: personFromProfile(row.uploader),
    createdAt: row.created_at,
    url: pub?.publicUrl,
    thumbnailUrl: resolveVideoThumbnailUrl({
      bucket: POST_PLAN_ATTACHMENT_BUCKET,
      storagePath: row.storage_path,
      mimeType: row.mime_type,
    }),
  };
}

export async function loadPostPlanIdeaAttachments(ideaId) {
  if (!ideaId) return [];
  const { data, error } = await supabase
    .from('post_plan_idea_attachments')
    .select(POST_PLAN_IDEA_ATTACHMENT_SELECT)
    .eq('idea_id', ideaId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapPostPlanIdeaAttachmentRow);
}

export async function addPostPlanIdeaAttachment({
  ideaId,
  accountId,
  file,
  uploadedBy,
}) {
  if (!ideaId)     throw new Error('addPostPlanIdeaAttachment: ideaId is required');
  if (!accountId)  throw new Error('addPostPlanIdeaAttachment: accountId is required');
  if (!file)       throw new Error('addPostPlanIdeaAttachment: file is required');
  if (!uploadedBy) throw new Error('addPostPlanIdeaAttachment: uploadedBy is required');

  // Reject browser-unrenderable images. See addPostPlanAttachment +
  // imageValidation.js for the rationale.
  await validateImageDimensions(file);

  const safeName = (file.name || 'asset').replace(/[^\w.\-]+/g, '_');
  const path = `${accountId}/ideas/${ideaId}/${Date.now()}_${safeName}`;
  const { error: upErr } = await supabase.storage
    .from(POST_PLAN_ATTACHMENT_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
  if (upErr) throw upErr;

  await uploadVideoThumbnailSidecar({ bucket: POST_PLAN_ATTACHMENT_BUCKET, storagePath: path, file });

  const { data, error } = await supabase
    .from('post_plan_idea_attachments')
    .insert({
      idea_id: ideaId,
      storage_path: path,
      filename: file.name || safeName,
      mime_type: file.type || null,
      size_bytes: file.size || null,
      uploaded_by: uploadedBy,
    })
    .select(POST_PLAN_IDEA_ATTACHMENT_SELECT)
    .single();
  if (error) {
    await supabase.storage.from(POST_PLAN_ATTACHMENT_BUCKET).remove([path, `${path}${VIDEO_THUMBNAIL_SUFFIX}`]).catch(() => {});
    throw error;
  }
  return mapPostPlanIdeaAttachmentRow(data);
}

export async function deletePostPlanIdeaAttachment(attachment) {
  if (!attachment?.id) throw new Error('deletePostPlanIdeaAttachment: attachment is required');
  if (attachment.storagePath) {
    const paths = [attachment.storagePath];
    if (isVideoMime(attachment.mimeType)) {
      paths.push(`${attachment.storagePath}${VIDEO_THUMBNAIL_SUFFIX}`);
    }
    await supabase.storage
      .from(POST_PLAN_ATTACHMENT_BUCKET)
      .remove(paths)
      .catch(() => {});
  }
  const { error } = await supabase
    .from('post_plan_idea_attachments')
    .delete()
    .eq('id', attachment.id);
  if (error) throw error;
}

// Convert an idea into a post_plan. Creates the post_plans row, then
// flips the idea to status='converted' with a back-pointer to the new
// plan. Returns { plan, idea } so the caller can navigate to the plan.
export async function convertIdeaToPostPlan({
  idea,
  scheduledAt,
  platforms,
  concept,
  copyVariants,
  userId,
}) {
  if (!idea?.id || !idea?.accountId) {
    throw new Error('convertIdeaToPostPlan: idea with id + accountId is required');
  }
  if (!scheduledAt) throw new Error('convertIdeaToPostPlan: scheduledAt is required');

  const plan = await createPostPlan({
    accountId: idea.accountId,
    scheduledAt,
    platforms,
    concept,
    copyVariants,
    status: 'drafting',
    userId,
  });

  const updatedIdea = await updatePostPlanIdea(idea.id, {
    status: 'converted',
    convertedPostPlanId: plan.id,
    convertedAt: new Date().toISOString(),
  });

  return { plan, idea: updatedIdea };
}

export function subscribeToPostPlanIdeas(onChange, { accountId } = {}) {
  // Per-subscription unique suffix so multiple subscribers (e.g. the
  // App-level idea-queue-badge useEffect and the IdeateInboxView)
  // don't share a channel name and trip the supabase-realtime-js
  // "cannot add postgres_changes callbacks after subscribe()" error.
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channelName = accountId
    ? `lr_post_plan_ideas_${accountId}_${suffix}`
    : `lr_post_plan_ideas_stream_${suffix}`;
  const filter = accountId
    ? { event: '*', schema: 'public', table: 'post_plan_ideas', filter: `account_id=eq.${accountId}` }
    : { event: '*', schema: 'public', table: 'post_plan_ideas' };
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', filter, async (payload) => {
      try {
        if (payload.eventType === 'DELETE') {
          onChange({ type: 'DELETE', id: payload.old.id });
          return;
        }
        const { data } = await supabase
          .from('post_plan_ideas')
          .select(POST_PLAN_IDEA_SELECT)
          .eq('id', payload.new.id)
          .maybeSingle();
        onChange({ type: payload.eventType, idea: data ? mapPostPlanIdeaRow(data) : null });
      } catch (e) {
        console.warn('post_plan_ideas realtime failed', e);
      }
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ============================================================
// Brand-kit notes (free-form admin "memory" the LinkAI reads
// on every call, written either by the BrandKit UI or by the AI's
// write_brand_note tool when the admin says "remember that…").
// ============================================================

const BRAND_KIT_NOTE_SELECT =
  'id, account_id, body, is_pinned, created_by, created_at, updated_at';

function mapBrandKitNoteRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    body: row.body || '',
    isPinned: row.is_pinned === true,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadBrandKitNotes(accountId) {
  if (!accountId) return [];
  const { data, error } = await supabase
    .from('brand_kit_notes')
    .select(BRAND_KIT_NOTE_SELECT)
    .eq('account_id', accountId)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapBrandKitNoteRow);
}

export async function createBrandKitNote({ accountId, body, isPinned, userId }) {
  if (!accountId) throw new Error('createBrandKitNote: accountId is required');
  const trimmed = (body || '').trim();
  if (!trimmed) throw new Error('createBrandKitNote: body is required');
  if (trimmed.length > 1000) {
    throw new Error('createBrandKitNote: body must be <= 1000 chars');
  }
  const { data, error } = await supabase
    .from('brand_kit_notes')
    .insert({
      account_id: accountId,
      body: trimmed,
      is_pinned: isPinned === true,
      created_by: userId ?? null,
    })
    .select(BRAND_KIT_NOTE_SELECT)
    .single();
  if (error) throw error;
  return mapBrandKitNoteRow(data);
}

export async function updateBrandKitNote(id, patch) {
  const cols = {};
  if (patch?.body !== undefined) cols.body = String(patch.body).trim();
  if (patch?.isPinned !== undefined) cols.is_pinned = patch.isPinned === true;
  if (Object.keys(cols).length === 0) {
    const { data } = await supabase
      .from('brand_kit_notes')
      .select(BRAND_KIT_NOTE_SELECT)
      .eq('id', id)
      .maybeSingle();
    return data ? mapBrandKitNoteRow(data) : null;
  }
  const { data, error } = await supabase
    .from('brand_kit_notes')
    .update(cols)
    .eq('id', id)
    .select(BRAND_KIT_NOTE_SELECT)
    .single();
  if (error) throw error;
  return mapBrandKitNoteRow(data);
}

export async function deleteBrandKitNote(id) {
  const { error } = await supabase.from('brand_kit_notes').delete().eq('id', id);
  if (error) throw error;
}

export function subscribeToBrandKitNotes(onChange, { accountId } = {}) {
  // Mirrors the post_plan_ideas subscription pattern from above — unique
  // suffix per call so multiple subscribers don't share a channel and
  // trip supabase-realtime-js's "cannot add callbacks after subscribe()"
  // error. accountId-filtered when present.
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channelName = accountId
    ? `lr_brand_kit_notes_${accountId}_${suffix}`
    : `lr_brand_kit_notes_stream_${suffix}`;
  const filter = accountId
    ? { event: '*', schema: 'public', table: 'brand_kit_notes', filter: `account_id=eq.${accountId}` }
    : { event: '*', schema: 'public', table: 'brand_kit_notes' };
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', filter, async (payload) => {
      try {
        if (payload.eventType === 'DELETE') {
          onChange({ type: 'DELETE', id: payload.old.id });
          return;
        }
        const { data } = await supabase
          .from('brand_kit_notes')
          .select(BRAND_KIT_NOTE_SELECT)
          .eq('id', payload.new.id)
          .maybeSingle();
        onChange({ type: payload.eventType, note: data ? mapBrandKitNoteRow(data) : null });
      } catch (e) {
        console.warn('brand_kit_notes realtime failed', e);
      }
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// =====================================================================
// Live Posts engagement summary — cumulative-snapshot model
// =====================================================================
// Powers the summary strip on `/c/:slug/posts` (LivePostsSummary.jsx).
//
// **Model:** "as-of-now" cumulative totals, not within-window deltas.
//   - Each publication has a SERIES of snapshots; each snapshot is the
//     cumulative count of likes/comments/shares/etc. at scrape time.
//   - "Engagement now" = sum across pubs of (latest snapshot's
//     engagement total). A post with 8 likes contributes 8, regardless
//     of when it was first scraped or when the period selector starts.
//   - "Engagement N days ago" = sum across pubs of (latest snapshot
//     fetched <= N-days-ago's engagement total). Pubs published AFTER
//     that point don't contribute — avoids phantom "infinite growth"
//     deltas for brand-new posts.
//
// **Period selector** scopes WHICH POSTS to include, not the math
// window. "Last 30 days" = posts with published_at in last 30d.
// "All time" = every post.
//
// **Sparklines**: each tile gets its OWN data series — engagement
// cumulative line, rate over time, post count over time.

const SUMMARY_DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_LOAD_WINDOW_DAYS = 60;
const SUMMARY_SPARKLINE_MAX_DAYS = 90;

function sumPositiveSummary(...nums) {
  let total = 0;
  for (const n of nums) if (typeof n === 'number' && n > 0) total += n;
  return total;
}

// Universal cross-platform engagement: likes + comments + shares + saves.
// Excludes reaction_count (LinkedIn duplicates likes), view_count (reach
// not engagement), bookmark_count (X-private), quote_count (X already
// maps retweets → share_count).
function summaryEngagementTotal(snap) {
  if (!snap) return 0;
  return sumPositiveSummary(snap.likeCount, snap.commentCount, snap.shareCount, snap.saveCount);
}

function istDateKey(d) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

function lastNIstDateKeysSummary(n, today = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * SUMMARY_DAY_MS);
    out.push(istDateKey(d));
  }
  return out;
}

function istDayKeyToEndOfDayMs(key) {
  return new Date(`${key}T23:59:59.999+05:30`).getTime();
}

// Find latest snapshot in a pub's sorted (asc) snapshot list with
// fetched_at <= asOfMs. Returns null if no snapshot qualifies.
function latestSnapshotAtOrBefore(snaps, asOfMs) {
  if (!snaps || snaps.length === 0) return null;
  let latest = null;
  for (const s of snaps) {
    const t = new Date(s.fetchedAt).getTime();
    if (t > asOfMs) break;
    latest = s;
  }
  return latest;
}

// Aggregate cumulative engagement / views / posts across publications,
// as-of `asOfMs`. Publications not yet published at that moment are
// excluded so the historical baseline doesn't get phantom contributions
// from brand-new posts.
function aggregateAtTime(publications, snapsByPub, asOfMs, platformFilter = null) {
  let engagement = 0;
  let views = 0;
  let postsCount = 0;
  let anyReportedViews = false;
  let anyMissingViews = false;

  for (const pub of publications) {
    if (platformFilter && pub.platform !== platformFilter) continue;
    if (!pub.publishedAt) continue;
    const pubMs = new Date(pub.publishedAt).getTime();
    if (pubMs > asOfMs) continue;
    postsCount += 1;

    const snaps = snapsByPub.get(pub.id) || [];
    const snap = latestSnapshotAtOrBefore(snaps, asOfMs);
    if (!snap) continue;

    engagement += summaryEngagementTotal(snap);
    if (typeof snap.viewCount === 'number' && snap.viewCount >= 0) {
      views += snap.viewCount;
      anyReportedViews = true;
    } else {
      anyMissingViews = true;
    }
  }

  const rate = views > 0 ? (engagement / views) * 100 : null;
  const rateBasis =
    anyReportedViews && anyMissingViews ? 'partial' :
    anyReportedViews ? 'all' :
    null;
  return { engagement, views, rate, rateBasis, postsCount };
}

// Per-metric cumulative count at-or-before asOfMs. Returns null when
// no in-scope publication on the platform reports this metric in any
// snapshot — UI hides the chip rather than rendering "—".
function aggregatePerMetricAtTime(publications, snapsByPub, asOfMs, platform, metricKey) {
  let total = 0;
  let anyReported = false;
  for (const pub of publications) {
    if (pub.platform !== platform) continue;
    if (!pub.publishedAt) continue;
    if (new Date(pub.publishedAt).getTime() > asOfMs) continue;
    const snaps = snapsByPub.get(pub.id) || [];
    const snap = latestSnapshotAtOrBefore(snaps, asOfMs);
    if (!snap) continue;
    const v = snap[metricKey];
    if (typeof v !== 'number') continue;
    anyReported = true;
    if (v > 0) total += v;
  }
  return anyReported ? total : null;
}

function pctChangeSummary(current, baseline) {
  if (baseline === 0) {
    if (current === 0) return 0;
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}

function ratePointDiff(a, b) {
  if (a === null || a === undefined) return null;
  if (b === null || b === undefined) return null;
  return a - b;
}

/**
 * Load + aggregate engagement summary for a brand's Live Posts page.
 *
 * @param {string} accountId  - brand account id
 * @param {number|'all'} [periodDays=30] - 7/30/90 filters posts to those
 *                                          published within that window;
 *                                          'all' includes every published post.
 */
export async function loadEngagementSummaryForBrand(accountId, periodDays = 30) {
  if (!accountId) return null;

  // Include soft-deleted publications so historical totals don't drop
  // the moment a user clicks "Remove post" in the Live Posts grid.
  // Per-user spec (2026-05-22): "historic engagement data for that
  // post till date will still be there, but future engagement data
  // will not continue to be captured." The scraper-side filter
  // (engagement-refresh Edge Function) handles the "stop capturing"
  // half; this `includeDeleted: true` handles the "keep showing
  // historical numbers in summary" half.
  const publications = await loadBrandPublications(accountId, { includeDeleted: true });
  if (publications.length === 0) {
    return { isEmpty: true, publications: [] };
  }

  const now = new Date();
  const nowMs = now.getTime();
  const loadStartMs = nowMs - SUMMARY_LOAD_WINDOW_DAYS * SUMMARY_DAY_MS;
  const pubIds = publications.map((p) => p.id);

  // Two reads: 60-day window (for sparkline + D/W/M baselines) + the
  // absolute latest snapshot per pub (so pubs not scraped in 60+ days
  // still show their last-known counts). Deduped by snapshot id.
  const { data: windowData, error: windowErr } = await supabase
    .from('post_engagement_snapshots')
    .select('*')
    .in('publication_id', pubIds)
    .gte('fetched_at', new Date(loadStartMs).toISOString())
    .order('fetched_at', { ascending: true });
  if (windowErr) throw windowErr;

  const latestByPub = await loadLatestEngagementSnapshots(pubIds);

  const snapsByPub = new Map();
  for (const row of windowData || []) {
    const mapped = mapEngagementSnapshotRow(row);
    const list = snapsByPub.get(mapped.publicationId) || [];
    list.push(mapped);
    snapsByPub.set(mapped.publicationId, list);
  }
  for (const [pubId, latest] of latestByPub.entries()) {
    if (!latest) continue;
    const list = snapsByPub.get(pubId) || [];
    if (!list.some((s) => s.id === latest.id)) {
      list.push(latest);
      list.sort((a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime());
    }
    snapsByPub.set(pubId, list);
  }

  // Period scope — which publications appear at all.
  const periodLabel = periodDays === 'all' ? 'all' : `${periodDays}d`;
  const periodCutoffMs = periodDays === 'all' ? null : nowMs - periodDays * SUMMARY_DAY_MS;
  const pubsInScope = publications.filter((pub) => {
    if (!pub.publishedAt) return false;
    if (periodCutoffMs === null) return true;
    return new Date(pub.publishedAt).getTime() >= periodCutoffMs;
  });

  // Current + historical baselines.
  const yesterdayMs = nowMs - 1 * SUMMARY_DAY_MS;
  const weekAgoMs   = nowMs - 7 * SUMMARY_DAY_MS;
  const monthAgoMs  = nowMs - 30 * SUMMARY_DAY_MS;

  const current   = aggregateAtTime(pubsInScope, snapsByPub, nowMs);
  const yesterday = aggregateAtTime(pubsInScope, snapsByPub, yesterdayMs);
  const lastWeek  = aggregateAtTime(pubsInScope, snapsByPub, weekAgoMs);
  const lastMonth = aggregateAtTime(pubsInScope, snapsByPub, monthAgoMs);

  const deltas = {
    vsYesterday: {
      engagement: pctChangeSummary(current.engagement, yesterday.engagement),
      ratePoints: ratePointDiff(current.rate, yesterday.rate),
      postsCount: current.postsCount - yesterday.postsCount,
    },
    vsLastWeek: {
      engagement: pctChangeSummary(current.engagement, lastWeek.engagement),
      ratePoints: ratePointDiff(current.rate, lastWeek.rate),
      postsCount: current.postsCount - lastWeek.postsCount,
    },
    vsLastMonth: {
      engagement: pctChangeSummary(current.engagement, lastMonth.engagement),
      ratePoints: ratePointDiff(current.rate, lastMonth.rate),
      postsCount: current.postsCount - lastMonth.postsCount,
    },
  };

  // Sparklines — each tile gets its own series.
  const sparklineDayCount =
    periodDays === 'all' ? SUMMARY_LOAD_WINDOW_DAYS :
    Math.min(periodDays, SUMMARY_SPARKLINE_MAX_DAYS);
  const sparklineKeys = lastNIstDateKeysSummary(sparklineDayCount, now);

  const sparklines = {
    engagement: sparklineKeys.map((dateKey) => {
      const endMs = istDayKeyToEndOfDayMs(dateKey);
      const agg = aggregateAtTime(pubsInScope, snapsByPub, endMs);
      return { date: dateKey, value: agg.engagement };
    }),
    rate: sparklineKeys.map((dateKey) => {
      const endMs = istDayKeyToEndOfDayMs(dateKey);
      const agg = aggregateAtTime(pubsInScope, snapsByPub, endMs);
      return { date: dateKey, value: agg.rate };
    }),
    posts: sparklineKeys.map((dateKey) => {
      const endMs = istDayKeyToEndOfDayMs(dateKey);
      const agg = aggregateAtTime(pubsInScope, snapsByPub, endMs);
      return { date: dateKey, value: agg.postsCount };
    }),
  };

  // Per-platform breakdown.
  const platformCounts = { instagram: 0, linkedin: 0, x: 0 };
  for (const pub of pubsInScope) {
    if (platformCounts[pub.platform] !== undefined) platformCounts[pub.platform] += 1;
  }

  const byPlatform = {};
  for (const platform of ['instagram', 'linkedin', 'x']) {
    if (platformCounts[platform] === 0) continue;
    const currentP = aggregateAtTime(pubsInScope, snapsByPub, nowMs, platform);
    const weekAgoP = aggregateAtTime(pubsInScope, snapsByPub, weekAgoMs, platform);
    const metrics = {
      likes:     aggregatePerMetricAtTime(pubsInScope, snapsByPub, nowMs, platform, 'likeCount'),
      comments:  aggregatePerMetricAtTime(pubsInScope, snapsByPub, nowMs, platform, 'commentCount'),
      shares:    aggregatePerMetricAtTime(pubsInScope, snapsByPub, nowMs, platform, 'shareCount'),
      saves:     aggregatePerMetricAtTime(pubsInScope, snapsByPub, nowMs, platform, 'saveCount'),
      views:     aggregatePerMetricAtTime(pubsInScope, snapsByPub, nowMs, platform, 'viewCount'),
      bookmarks: aggregatePerMetricAtTime(pubsInScope, snapsByPub, nowMs, platform, 'bookmarkCount'),
    };
    const sparklineDaily = sparklineKeys.map((dateKey) => {
      const endMs = istDayKeyToEndOfDayMs(dateKey);
      const agg = aggregateAtTime(pubsInScope, snapsByPub, endMs, platform);
      return { date: dateKey, value: agg.engagement };
    });
    byPlatform[platform] = {
      posts: platformCounts[platform],
      engagement: currentP.engagement,
      views: currentP.views,
      rate: currentP.rate,
      rateBasis: currentP.rateBasis,
      metrics,
      sparklineDaily,
      deltaWeek: pctChangeSummary(currentP.engagement, weekAgoP.engagement),
    };
  }

  return {
    isEmpty: false,
    periodLabel,
    period: {
      engagement: current.engagement,
      views: current.views,
      rate: current.rate,
      rateBasis: current.rateBasis,
      postsCount: current.postsCount,
    },
    deltas,
    sparklines,
    byPlatform,
  };
}

