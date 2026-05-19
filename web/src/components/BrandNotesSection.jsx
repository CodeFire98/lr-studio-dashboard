// =====================================================================
// BrandNotesSection — agency "memory" notes about the brand
// =====================================================================
//
// Renders on its own page at /c/:slug/notes (mounted via BrandNotesView).
// Previously lived inside BrandKitView; promoted to a top-level surface
// on 2026-05-12 as part of the brand-notes restructure — notes are an
// agency-internal thinking-out-loud surface and deserved a real
// workspace rather than being buried inside BrandKit.
//
// AGENCY-ONLY. The component early-returns null for non-agency callers
// as defense-in-depth — the real enforcement is RLS on `brand_kit_notes`
// (see supabase/migrations/0040_brand_kit_notes_agency_only_rls.sql).
// A brand-user JWT would get 0 rows from PostgREST anyway; the frontend
// gate just prevents the empty-state UI from rendering / the loading
// state from spinning.
//
// The notes here are the same `brand_kit_notes` rows the AI Co-pilot
// reads as part of its brand context on every call. Two ways notes
// land in the table:
//   1) Admin types into this UI's composer and clicks Save
//   2) Admin tells the chat Co-pilot "remember that…" and the model calls
//      the `write_brand_note` tool
//
// Both paths surface the same way here — pinned notes always at the top,
// then chronological. Pinned notes ride along on every AI call regardless
// of recency; non-pinned notes are time-bound and decay out of the
// brand-context window once we hit the ~20-most-recent cap inside
// brandContext.js.
//
// Realtime: subscribed via subscribeToBrandKitNotes so a tool-call from
// the Co-pilot panel shows up in this section without a refresh, and
// vice-versa.
// =====================================================================

/* eslint-disable */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import {
  loadBrandKitNotes,
  createBrandKitNote,
  updateBrandKitNote,
  deleteBrandKitNote,
  subscribeToBrandKitNotes,
} from '../lib/db.js';

function formatRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

// Public component — open to BOTH agency and brand teammates as of
// migration 0052 (was agency-only via 0040 → "Phase 3 brand-notes
// restructure"). Brand can read AND write notes for their own brand;
// the AI Co-pilot pulls the same notes into its context regardless
// of who wrote them. The agency/brand distinction is preserved in
// `isAgency` for downstream UI nuance (none today, but the prop is
// still threaded for future per-role bits).
const BrandNotesSection = ({ accountId, isAgency, userId }) => {
  return <BrandNotesSectionInner accountId={accountId} isAgency={isAgency} userId={userId} />;
};

const BrandNotesSectionInner = ({ accountId, isAgency, userId }) => {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [draftPinned, setDraftPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingBody, setEditingBody] = useState('');
  const composeTextareaRef = useRef(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    setErr('');
    loadBrandKitNotes(accountId)
      .then((rows) => { if (!cancelled) setNotes(rows); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Failed to load notes'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    const unsub = subscribeToBrandKitNotes((evt) => {
      if (evt.type === 'DELETE') {
        setNotes((prev) => prev.filter((n) => n.id !== evt.id));
        return;
      }
      if (!evt.note) return;
      setNotes((prev) => {
        const next = prev.filter((n) => n.id !== evt.note.id);
        next.unshift(evt.note);
        next.sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return String(b.createdAt).localeCompare(String(a.createdAt));
        });
        return next;
      });
    }, { accountId });
    return unsub;
  }, [accountId]);

  useEffect(() => {
    if (composeOpen) composeTextareaRef.current?.focus();
  }, [composeOpen]);

  const handleSaveNew = async () => {
    const body = draftBody.trim();
    if (!body || saving) return;
    setSaving(true);
    setErr('');
    try {
      // Realtime will insert it; do an optimistic upsert too so the UI
      // updates instantly without waiting for the realtime roundtrip.
      const created = await createBrandKitNote({
        accountId,
        body,
        isPinned: draftPinned,
        userId,
      });
      setNotes((prev) => {
        if (prev.some((n) => n.id === created.id)) return prev;
        const next = [created, ...prev];
        next.sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return String(b.createdAt).localeCompare(String(a.createdAt));
        });
        return next;
      });
      setDraftBody('');
      setDraftPinned(false);
      setComposeOpen(false);
    } catch (e) {
      setErr(e.message || 'Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePin = async (note) => {
    setErr('');
    // Optimistic flip; revert on failure.
    setNotes((prev) => prev.map((n) =>
      n.id === note.id ? { ...n, isPinned: !n.isPinned } : n,
    ).sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    }));
    try {
      await updateBrandKitNote(note.id, { isPinned: !note.isPinned });
    } catch (e) {
      setErr(e.message || 'Failed to update note');
      // Revert optimistic flip
      setNotes((prev) => prev.map((n) =>
        n.id === note.id ? { ...n, isPinned: note.isPinned } : n,
      ).sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      }));
    }
  };

  const handleSaveEdit = async (note) => {
    const body = editingBody.trim();
    if (!body || saving) return;
    if (body === note.body) {
      setEditingId(null);
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await updateBrandKitNote(note.id, { body });
      setNotes((prev) => prev.map((n) =>
        n.id === note.id ? { ...n, body } : n,
      ));
      setEditingId(null);
    } catch (e) {
      setErr(e.message || 'Failed to update note');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (note) => {
    if (!window.confirm(`Delete this note?\n\n"${note.body.slice(0, 200)}${note.body.length > 200 ? '…' : ''}"`)) return;
    setErr('');
    // Optimistic remove; on failure, reload to recover state.
    setNotes((prev) => prev.filter((n) => n.id !== note.id));
    try {
      await deleteBrandKitNote(note.id);
    } catch (e) {
      setErr(e.message || 'Failed to delete note');
      loadBrandKitNotes(accountId).then(setNotes).catch(() => {});
    }
  };

  const pinned = notes.filter((n) => n.isPinned);
  const recent = notes.filter((n) => !n.isPinned);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">
            Brand notes
            <span className="brand-notes-count">{notes.length}</span>
          </div>
          <div className="card-sub">
            Free-form facts the AI Co-pilot remembers about this brand — written here or saved automatically when the admin tells chat "remember that…". Pinned notes ride along on every AI call.
          </div>
        </div>
        {isAgency && !composeOpen && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setComposeOpen(true)}
          >
            <Icon name="send" size={12} style={{ marginRight: 4 }}/>
            Add note
          </button>
        )}
      </div>

      {err && (
        <div className="brand-notes-error">
          <Icon name="alert" size={12}/> {err}
        </div>
      )}

      {isAgency && composeOpen && (
        <div className="brand-notes-composer">
          <textarea
            ref={composeTextareaRef}
            rows={3}
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            placeholder="e.g. 'Always tag @sarahbamboo on milestone posts' — write declaratively so the AI can act on it."
            maxLength={1000}
            disabled={saving}
          />
          <div className="brand-notes-composer-row">
            <label className="brand-notes-pin-label">
              <input
                type="checkbox"
                checked={draftPinned}
                onChange={(e) => setDraftPinned(e.target.checked)}
                disabled={saving}
              />
              <Icon name="check" size={12}/>
              Pin (always-true fact — rides on every AI call)
            </label>
            <span style={{ flex: 1 }}/>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => { setComposeOpen(false); setDraftBody(''); setDraftPinned(false); }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleSaveNew}
              disabled={saving || !draftBody.trim()}
            >
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="brand-notes-empty">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="brand-notes-empty">
          <p>No notes yet.</p>
          <p style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            Notes accumulate over time — either added here or saved automatically when you tell the Co-pilot chat "remember that…". The more notes you have, the more the AI knows this brand.
          </p>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <div className="brand-notes-group">
              <div className="brand-notes-group-label">
                <Icon name="check" size={10}/> Pinned · always-true facts
              </div>
              {pinned.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  isAgency={isAgency}
                  isEditing={editingId === n.id}
                  editingBody={editingBody}
                  saving={saving}
                  onStartEdit={() => { setEditingId(n.id); setEditingBody(n.body); }}
                  onCancelEdit={() => setEditingId(null)}
                  onEditChange={setEditingBody}
                  onSaveEdit={() => handleSaveEdit(n)}
                  onTogglePin={() => handleTogglePin(n)}
                  onDelete={() => handleDelete(n)}
                />
              ))}
            </div>
          )}

          {recent.length > 0 && (
            <div className="brand-notes-group">
              {pinned.length > 0 && (
                <div className="brand-notes-group-label">Recent context</div>
              )}
              {recent.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  isAgency={isAgency}
                  isEditing={editingId === n.id}
                  editingBody={editingBody}
                  saving={saving}
                  onStartEdit={() => { setEditingId(n.id); setEditingBody(n.body); }}
                  onCancelEdit={() => setEditingId(null)}
                  onEditChange={setEditingBody}
                  onSaveEdit={() => handleSaveEdit(n)}
                  onTogglePin={() => handleTogglePin(n)}
                  onDelete={() => handleDelete(n)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const NoteRow = ({
  note,
  isAgency,
  isEditing,
  editingBody,
  saving,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onSaveEdit,
  onTogglePin,
  onDelete,
}) => {
  if (isEditing) {
    return (
      <div className="brand-note-row brand-note-editing">
        <textarea
          rows={3}
          value={editingBody}
          onChange={(e) => onEditChange(e.target.value)}
          maxLength={1000}
          autoFocus
          disabled={saving}
        />
        <div className="brand-note-actions">
          <span style={{ flex: 1 }}/>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onCancelEdit}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onSaveEdit}
            disabled={saving || !editingBody.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="brand-note-row">
      <div className="brand-note-body">{note.body}</div>
      <div className="brand-note-meta">
        <span className="brand-note-time">{formatRelative(note.createdAt)}</span>
        {isAgency && (
          <>
            <button
              type="button"
              className="brand-note-action"
              onClick={onTogglePin}
              title={note.isPinned ? 'Unpin (drop off the always-on list)' : 'Pin (always-true fact)'}
            >
              {note.isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              className="brand-note-action"
              onClick={onStartEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="brand-note-action brand-note-delete"
              onClick={onDelete}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export { BrandNotesSection };
