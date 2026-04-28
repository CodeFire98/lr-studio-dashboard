/* eslint-disable */
/* Brand Kit — knowledge base for the current brand workspace.
   Loads from Supabase (brand_kits table). Supports inline edit of text +
   list fields. Procedural Art remains the visual fallback for palette-only
   gallery items (photography, inspiration, past_creatives). */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Art } from './primitives.jsx';
import { useLightbox } from './Lightbox.jsx';
import { readAuth } from '../lib/auth.js';
import {
  loadBrandKit,
  updateBrandKit,
  uploadBrandLogo,
  uploadBrandAsset,
  listBrandAssets,
  deleteBrandAsset,
  addBrandLogoVariant,
  removeBrandLogoVariant,
  updateBrandLogoVariant,
  triggerBrandKitEnrichment,
} from '../lib/db.js';
import { confirm as confirmDialog } from './ConfirmDialog.jsx';

// System / pre-installed faces we never need to fetch from Google Fonts.
// Anything not on this list gets a <link> appended so e.g. "Karla" actually
// renders as Karla on the typography card. Brand-only faces ("Söhne",
// "Reckless") fail silently and fall through to the role-appropriate
// stack — which is the right behaviour for a kit screen anyway.
const SYSTEM_FONT_NAMES = new Set([
  'Arial', 'Helvetica', 'Helvetica Neue', 'Times', 'Times New Roman',
  'Courier', 'Courier New', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Geist', 'Geist Mono', 'Instrument Serif', 'system-ui',
  'sans-serif', 'serif', 'monospace',
]);

function useGoogleFonts(families) {
  const key = (families || []).filter(Boolean).join('|');
  useEffect(() => {
    const need = (families || [])
      .filter((f) => f && !SYSTEM_FONT_NAMES.has(f.trim()))
      .map((f) => f.trim());
    if (need.length === 0) return;
    const id = 'gf_' + need.map((f) => f.replace(/\s+/g, '_')).join('+');
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    const fams = need.map((f) => `family=${encodeURIComponent(f)}:ital,wght@0,400;0,500;0,600;1,400`).join('&');
    link.href = `https://fonts.googleapis.com/css2?${fams}&display=swap`;
    document.head.appendChild(link);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// ---- Inline-edit primitives ---------------------------------------------

const EditToggle = ({ editing, onEdit }) => (
  <button
    className="btn btn-sm btn-ghost"
    title={editing ? 'Editing…' : 'Edit'}
    onClick={onEdit}
    style={{ color: 'var(--ink-4)' }}
  >
    <Icon name="refresh" size={12}/>{editing ? 'Editing' : 'Edit'}
  </button>
);

const InlineText = ({ field, value, multiline, display, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setDraft(value || ''); }, [value]);

  const commit = async () => {
    setSaving(true); setErr('');
    try {
      await onSave(field, draft);
      setEditing(false);
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>{display ? display(value) : <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55 }}>{value || <span style={{ color: 'var(--ink-4)' }}>—</span>}</div>}</div>
        <EditToggle editing={false} onEdit={() => setEditing(true)}/>
      </div>
    );
  }

  return (
    <div>
      {multiline ? (
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: 14, fontFamily: 'inherit', outline: 'none', resize: 'vertical' }}
        />
      ) : (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: 14, outline: 'none' }}
        />
      )}
      {err && <div style={{ color: 'var(--accent-ink)', fontSize: 12, marginTop: 6 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-ghost" disabled={saving} onClick={() => { setDraft(value || ''); setEditing(false); setErr(''); }}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={commit}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
};

// `hideDisplay` skips the bulleted list when the list is already presented
// upstream (e.g. voice tags shown as pills) — just leaves the Edit button.
const InlineList = ({ field, value, onSave, hideDisplay = false }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(Array.isArray(value) ? value : []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setDraft(Array.isArray(value) ? value : []); }, [value]);

  const commit = async () => {
    setSaving(true); setErr('');
    try {
      const clean = draft.map((s) => s.trim()).filter(Boolean);
      await onSave(field, clean);
      setEditing(false);
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div>
        {!hideDisplay && (
          Array.isArray(value) && value.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {value.map((d, i) => (
                <li key={i} style={{ fontSize: 14, color: 'var(--ink-2)' }}>— {d}</li>
              ))}
            </ul>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No items yet.</div>
          )
        )}
        <div style={{ marginTop: hideDisplay ? 0 : 10 }}>
          <EditToggle editing={false} onEdit={() => setEditing(true)}/>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {draft.map((v, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={v}
              onChange={(e) => {
                const next = draft.slice();
                next[i] = e.target.value;
                setDraft(next);
              }}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: 13, outline: 'none' }}
            />
            <button className="btn btn-sm btn-ghost" title="Remove" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
              <Icon name="x" size={12}/>
            </button>
          </div>
        ))}
      </div>
      <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setDraft([...draft, ''])}>
        <Icon name="plus" size={12}/>Add
      </button>
      {err && <div style={{ color: 'var(--accent-ink)', fontSize: 12, marginTop: 6 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-ghost" disabled={saving} onClick={() => { setDraft(Array.isArray(value) ? value : []); setEditing(false); setErr(''); }}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={commit}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
};

// ---- Social-links inline editor ----------------------------------------
// Edits brand_kits.social_links (jsonb { instagram, tiktok, linkedin }).
// Keeps the same edit/cancel/save UX as InlineText for consistency.
const SOCIAL_SLOTS = [
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/yourbrand' },
  { key: 'tiktok',    label: 'TikTok',    placeholder: 'https://tiktok.com/@yourbrand' },
  { key: 'linkedin',  label: 'LinkedIn',  placeholder: 'https://linkedin.com/company/yourbrand' },
];

const InlineSocials = ({ value, onSave }) => {
  const initial = () => ({
    instagram: value?.instagram || '',
    tiktok:    value?.tiktok    || '',
    linkedin:  value?.linkedin  || '',
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setDraft(initial()); }, [value?.instagram, value?.tiktok, value?.linkedin]);

  const commit = async () => {
    setSaving(true); setErr('');
    try {
      const cleaned = Object.fromEntries(
        Object.entries(draft)
          .map(([k, v]) => [k, (v || '').trim()])
          .filter(([, v]) => v.length > 0)
      );
      await onSave('social_links', cleaned);
      setEditing(false);
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    const filled = SOCIAL_SLOTS.filter((s) => (value?.[s.key] || '').trim());
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          {filled.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No social links yet.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {filled.map((s) => (
                <li key={s.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                  <span style={{ minWidth: 70, color: 'var(--ink-3)', fontWeight: 500 }}>{s.label}</span>
                  <a
                    href={value[s.key]}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--ink-2)', textDecoration: 'none', wordBreak: 'break-all' }}
                  >
                    {value[s.key]}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <EditToggle editing={false} onEdit={() => setEditing(true)}/>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {SOCIAL_SLOTS.map((s) => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ minWidth: 70, fontSize: 12, color: 'var(--ink-3)', fontWeight: 500 }}>{s.label}</span>
            <input
              type="url"
              value={draft[s.key]}
              onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
              placeholder={s.placeholder}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: 13, outline: 'none' }}
            />
          </div>
        ))}
      </div>
      {err && <div style={{ color: 'var(--accent-ink)', fontSize: 12, marginTop: 6 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-ghost" disabled={saving} onClick={() => { setDraft(initial()); setEditing(false); setErr(''); }}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={commit}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
};

// Read-only display helper for a URL: clickable, truncated when long.
const renderUrl = (v) => {
  if (!v) return <span style={{ color: 'var(--ink-4)', fontSize: 14 }}>—</span>;
  const display = v.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <a
      href={v.startsWith('http') ? v : `https://${v}`}
      target="_blank"
      rel="noreferrer"
      style={{ fontSize: 14, color: 'var(--ink-2)', textDecoration: 'none', wordBreak: 'break-all' }}
    >
      {display}
    </a>
  );
};

// ---- Brand logo upload card --------------------------------------------
// Uploads to the public 'brand-logos' bucket and persists the resulting
// URL to brand_kits.logo_url. Single primary logo per brand for now;
// secondary/mono variants will land when we expose the multi-logo array.
// LogoMarksCard — primary brand mark + multiple variants (mono, reverse,
// wordmark, icon-only, etc.). Each variant has a free-form label so the
// designer can call it whatever makes sense ("Wordmark on dark", "Icon for
// favicons", "Black mono"). Click any variant → full-size lightbox with
// Download. Stored in brand_kits.logos JSONB; primary logo stays in
// brand_kits.logo_url so the rest of the app keeps working.
const LogoMarksCard = ({ accountId, logoUrl, variants, onSave, onVariantsChange, backgroundHint }) => {
  const primaryFileRef = useRef(null);
  const variantFileRef = useRef(null);
  const [uploadingPrimary, setUploadingPrimary] = useState(false);
  const [uploadingVariant, setUploadingVariant] = useState(false);
  const [err, setErr] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draftLabel, setDraftLabel] = useState('');
  const lightbox = useLightbox();

  const handlePrimaryFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setErr('Logo must be under 4MB.'); return; }
    setErr(''); setUploadingPrimary(true);
    try {
      const { url } = await uploadBrandLogo({ accountId, file });
      await onSave('logo_url', url);
    } catch (ex) {
      setErr(ex?.message || 'Logo upload failed.');
    } finally {
      setUploadingPrimary(false);
      if (primaryFileRef.current) primaryFileRef.current.value = '';
    }
  };

  const removePrimary = async () => {
    setErr('');
    try { await onSave('logo_url', null); }
    catch (ex) { setErr(ex?.message || 'Could not remove the logo.'); }
  };

  const handleVariantFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setErr('Logo variant must be under 4MB.'); return; }
    const label = window.prompt('Label this variant (e.g. "Wordmark on dark", "Mono icon", "Reverse")', '');
    if (label === null) {
      if (variantFileRef.current) variantFileRef.current.value = '';
      return;
    }
    setErr(''); setUploadingVariant(true);
    try {
      const next = await addBrandLogoVariant({ accountId, file, label: label || 'Logo variant' });
      onVariantsChange(next);
    } catch (ex) {
      setErr(ex?.message || 'Variant upload failed.');
    } finally {
      setUploadingVariant(false);
      if (variantFileRef.current) variantFileRef.current.value = '';
    }
  };

  const removeVariant = async (variantId) => {
    setErr('');
    try {
      const next = await removeBrandLogoVariant({ accountId, variantId });
      onVariantsChange(next);
    } catch (ex) {
      setErr(ex?.message || 'Could not remove variant.');
    }
  };

  const saveLabel = async (variantId) => {
    setErr('');
    try {
      const next = await updateBrandLogoVariant({ accountId, variantId, label: draftLabel });
      onVariantsChange(next);
      setEditingId(null);
    } catch (ex) {
      setErr(ex?.message || 'Could not rename variant.');
    }
  };

  const openInLightbox = (url, label) => {
    lightbox.open({
      src: url,
      mimeType: 'image/*',
      name: label || 'Logo',
      alt: label || 'Logo',
      downloadUrl: url,
    });
  };

  // Pick a tile background that contrasts: when the brand has a dark
  // background we render variants on light, and vice-versa, so transparent
  // marks remain visible on hover.
  const isDark = (typeof backgroundHint === 'string' && /^#0|^#1|^#2/.test(backgroundHint)) || backgroundHint === 'dark';
  const tileBg = isDark ? 'var(--surface)' : 'var(--surface-2)';

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Logo &amp; marks</div>
          <div className="card-sub">Click any mark to view full size and download</div>
        </div>
      </div>

      {/* Primary logo */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', paddingBottom: 16, borderBottom: '1px solid var(--line-2)' }}>
        <button
          type="button"
          onClick={() => logoUrl && openInLightbox(logoUrl, `${''} Primary logo`)}
          style={{
            width: 120, height: 120,
            borderRadius: 14,
            border: '1px solid var(--line)',
            background: logoUrl
              ? `center / contain no-repeat url(${JSON.stringify(logoUrl)}), ${tileBg}`
              : tileBg,
            display: 'grid', placeItems: 'center',
            color: 'var(--ink-4)',
            flexShrink: 0,
            cursor: logoUrl ? 'zoom-in' : 'default',
            padding: 0,
          }}
        >
          {!logoUrl && <Icon name="image" size={28}/>}
        </button>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="tiny">Primary mark</div>
          <input
            ref={primaryFileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            style={{ display: 'none' }}
            onChange={handlePrimaryFile}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => primaryFileRef.current?.click()}
              disabled={uploadingPrimary}
            >
              <Icon name="upload" size={12}/>
              {uploadingPrimary ? 'Uploading…' : logoUrl ? 'Replace' : 'Upload logo'}
            </button>
            {logoUrl && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={removePrimary}
                disabled={uploadingPrimary}
              >Remove</button>
            )}
          </div>
        </div>
      </div>

      {/* Variants */}
      <div style={{ paddingTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="tiny">Variants{Array.isArray(variants) && variants.length > 0 ? ` · ${variants.length}` : ''}</div>
          <input
            ref={variantFileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            style={{ display: 'none' }}
            onChange={handleVariantFile}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => variantFileRef.current?.click()}
            disabled={uploadingVariant}
          >
            <Icon name="plus" size={12}/>
            {uploadingVariant ? 'Uploading…' : 'Add variant'}
          </button>
        </div>
        {(!Array.isArray(variants) || variants.length === 0) ? (
          <div style={{ fontSize: 13, color: 'var(--ink-4)', padding: '8px 0' }}>
            Add wordmark, mono, reverse, or icon-only versions so designers can grab the right mark for any context.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {variants.map((v) => (
              <div
                key={v.id || v.url}
                style={{
                  border: '1px solid var(--line-2)',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: tileBg,
                  position: 'relative',
                }}
              >
                <button
                  type="button"
                  onClick={() => openInLightbox(v.url, v.label)}
                  style={{
                    display: 'block', width: '100%',
                    aspectRatio: '1/1',
                    border: 0, padding: 16,
                    background: `center / contain no-repeat url(${JSON.stringify(v.url)}), transparent`,
                    cursor: 'zoom-in',
                  }}
                  aria-label={`Open ${v.label || 'logo variant'} full size`}
                />
                <div style={{
                  padding: '8px 10px', borderTop: '1px solid var(--line-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'var(--surface)',
                }}>
                  {editingId === v.id ? (
                    <>
                      <input
                        type="text"
                        autoFocus
                        value={draftLabel}
                        onChange={(e) => setDraftLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(v.id); if (e.key === 'Escape') setEditingId(null); }}
                        onBlur={() => saveLabel(v.id)}
                        style={{ flex: 1, padding: '2px 6px', border: '1px solid var(--line)', borderRadius: 4, fontSize: 12 }}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setEditingId(v.id); setDraftLabel(v.label || ''); }}
                      title="Rename"
                      style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 0, padding: 0, fontSize: 12, color: 'var(--ink-2)', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >{v.label || 'Untitled'}</button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeVariant(v.id)}
                    title="Remove"
                    style={{ background: 'transparent', border: 0, color: 'var(--ink-4)', cursor: 'pointer', padding: 4 }}
                  ><Icon name="x" size={11}/></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {err && <div style={{ color: 'var(--accent-ink)', fontSize: 12, marginTop: 12 }}>{err}</div>}
    </div>
  );
};

// ---- Export kit ---------------------------------------------------------
// Bundles every editable kit field + asset URLs into a single JSON file and
// triggers a browser download. Reference + logo URLs are public bucket URLs
// so the recipient can fetch the actual images by pasting the URL — no
// signed-URL gymnastics, no zip dependency. We can layer real ZIP+image
// bundling on top later if asked.
async function exportBrandKit(kit) {
  if (!kit) return;
  const refs = await listBrandAssets(kit.accountId).catch(() => []);
  const payload = {
    brand:       kit.name,
    accountId:   kit.accountId,
    exportedAt:  new Date().toISOString(),
    summary:     kit.aiSummary || '',
    tagline:     kit.tagline || '',
    mission:     kit.mission || '',
    audience:    kit.audience || '',
    toneVoice:   kit.toneVoice || '',
    voiceTags:   kit.voiceTags || [],
    dos:         kit.dos || [],
    donts:       kit.donts || [],
    primaryColor: kit.primaryColor || null,
    secondaryColor: kit.secondaryColor || null,
    palette:     kit.palette || [],
    fonts:       kit.fonts || [],
    websiteUrl:  kit.websiteUrl || '',
    socialLinks: kit.socialLinks || {},
    logoUrl:     kit.logoUrl || null,
    references:  refs.map((r) => ({ name: r.name, url: r.url, sizeBytes: r.sizeBytes, mimeType: r.mimeType })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = (kit.name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}-brand-kit.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---- References / brand assets gallery ---------------------------------
// Generic visual library the brand uploads for the agency to draw from:
// past creatives, mood images, packaging shots, etc. Stored in the public
// 'brand-assets' bucket under the account UUID prefix.
const ReferencesCard = ({ accountId }) => {
  const fileInputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const lightbox = useLightbox();
  const openItem = (item) => lightbox.open({
    src: item.url,
    mimeType: item.mimeType,
    name: item.name,
    alt: item.name,
    downloadUrl: item.url,
  });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    listBrandAssets(accountId)
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Could not load references.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setErr(''); setUploading(true);
    try {
      const next = [...items];
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) {
          setErr(`${f.name} skipped — over 10MB.`);
          continue;
        }
        const uploaded = await uploadBrandAsset({ accountId, file: f });
        next.unshift({
          path: uploaded.path,
          name: f.name,
          url: uploaded.url,
          sizeBytes: f.size,
          mimeType: f.type,
          createdAt: new Date().toISOString(),
        });
      }
      setItems(next);
    } catch (ex) {
      setErr(ex?.message || 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (item) => {
    const ok = await confirmDialog({
      title: `Delete ${item.name}?`,
      body: 'This removes it from your reference library for this brand.',
      confirmText: 'Delete',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteBrandAsset(item.path);
      setItems((prev) => prev.filter((x) => x.path !== item.path));
    } catch (ex) {
      alert(ex?.message || 'Delete failed.');
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">References &amp; assets</div>
          <div className="card-sub">Drop in past creatives, mood images, packaging shots — anything the team should see.</div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          style={{ display: 'none' }}
          onChange={handleUpload}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || !accountId}
        >
          <Icon name="plus" size={14}/>{uploading ? 'Uploading…' : 'Add asset'}
        </button>
      </div>
      {err && <div style={{ padding: '0 16px 8px', color: 'var(--accent-ink)', fontSize: 12 }}>{err}</div>}
      {loading ? (
        <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--ink-4)' }}>Loading references…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: '20px', fontSize: 13, color: 'var(--ink-4)' }}>
          No references yet. Use <strong>Add asset</strong> to upload images or PDFs.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, padding: '4px 16px 16px' }}>
          {items.map((item) => {
            const isImage = (item.mimeType || '').startsWith('image/');
            return (
              <div
                key={item.path}
                style={{
                  position: 'relative',
                  aspectRatio: '1/1',
                  borderRadius: 10,
                  overflow: 'hidden',
                  border: '1px solid var(--line-2)',
                  background: 'var(--surface-2)',
                }}
              >
                {isImage ? (
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    style={{ display: 'block', height: '100%', width: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in' }}
                  >
                    <img src={item.url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      width: '100%', height: '100%', padding: 12, gap: 8,
                      color: 'var(--ink-2)', textDecoration: 'none',
                      border: 0, background: 'transparent', cursor: 'pointer',
                    }}
                  >
                    <Icon name="folder" size={28}/>
                    <span style={{ fontSize: 12, textAlign: 'center', wordBreak: 'break-word', lineHeight: 1.3 }}>
                      {item.name}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(item)}
                  title="Delete"
                  style={{
                    position: 'absolute',
                    top: 6, right: 6,
                    width: 24, height: 24,
                    borderRadius: 6,
                    border: 0,
                    background: 'rgba(0,0,0,0.55)',
                    color: '#fff',
                    display: 'grid', placeItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="x" size={11}/>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---- Display helpers ----------------------------------------------------

const LogoBlock = ({ logo }) => {
  const isMono = logo?.variant === 'mono';
  const bg = logo?.bg || '#FBF6ED';
  const ink = logo?.ink || '#1B1F1C';
  return (
    <div style={{
      aspectRatio: '4/3',
      background: bg,
      border: '1px solid var(--line)',
      borderRadius: 'var(--radius-md)',
      display: 'grid',
      placeItems: 'center',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {isMono ? (
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 72, color: ink,
          letterSpacing: '-0.03em', lineHeight: 1, fontStyle: 'italic',
        }}>L</div>
      ) : (
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 46, color: ink,
          letterSpacing: '-0.03em', lineHeight: 1,
        }}>
          brand<span style={{ color: '#C88A3F' }}>.</span>
        </div>
      )}
      {logo?.label && (
        <div style={{
          position: 'absolute', bottom: 10, left: 12,
          fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: `color-mix(in oklab, ${ink} 55%, transparent)`, fontWeight: 500,
        }}>{logo.label}</div>
      )}
    </div>
  );
};

// ---- Firecrawl-enriched display cards ---------------------------------
// Each of these renders nothing when its data is absent so unenriched
// brands (Luma seed, freshly-created accounts) don't show empty cards.

const Chip = ({ children, accent }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center',
    padding: '5px 10px', borderRadius: 999,
    background: accent ? 'var(--accent-tint)' : 'var(--surface-2)',
    color: accent ? 'var(--accent-ink)' : 'var(--ink-2)',
    border: '1px solid var(--line)',
    fontSize: 12, fontWeight: 500,
  }}>{children}</span>
);

const PositioningCard = ({ kit }) => {
  const has = (
    kit.positioningStatement ||
    kit.industry ||
    (Array.isArray(kit.brandPillars) && kit.brandPillars.length) ||
    (Array.isArray(kit.valueProps) && kit.valueProps.length) ||
    (Array.isArray(kit.keyDifferentiators) && kit.keyDifferentiators.length) ||
    (Array.isArray(kit.productCategories) && kit.productCategories.length) ||
    (kit.personality && Object.keys(kit.personality).length)
  );
  if (!has) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Positioning &amp; strategy</div>
          <div className="card-sub">How the brand frames itself in the market</div>
        </div>
        {kit.industry && (
          <span style={{
            padding: '4px 10px', borderRadius: 999,
            background: 'var(--surface-2)', color: 'var(--ink-2)',
            border: '1px solid var(--line)',
            fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
          }}>{kit.industry}</span>
        )}
      </div>
      {kit.positioningStatement && (
        <div style={{
          fontSize: 16, lineHeight: 1.5, color: 'var(--ink)',
          fontFamily: 'var(--font-serif)',
          padding: '0 0 16px',
          borderBottom: '1px solid var(--line-2)',
          marginBottom: 16,
        }}>“{kit.positioningStatement}”</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {Array.isArray(kit.brandPillars) && kit.brandPillars.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Brand pillars</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {kit.brandPillars.map((p, i) => <Chip key={i} accent>{p}</Chip>)}
            </div>
          </div>
        )}
        {Array.isArray(kit.productCategories) && kit.productCategories.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Product categories</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {kit.productCategories.map((p, i) => <Chip key={i}>{p}</Chip>)}
            </div>
          </div>
        )}
        {Array.isArray(kit.valueProps) && kit.valueProps.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Value propositions</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {kit.valueProps.map((v, i) => (
                <li key={i} style={{ fontSize: 13, color: 'var(--ink-2)' }}>— {v}</li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(kit.keyDifferentiators) && kit.keyDifferentiators.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Key differentiators</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {kit.keyDifferentiators.map((v, i) => (
                <li key={i} style={{ fontSize: 13, color: 'var(--ink-2)' }}>— {v}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {kit.personality && Object.keys(kit.personality).length > 0 && (
        <div style={{
          marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line-2)',
          display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, color: 'var(--ink-3)',
        }}>
          {kit.personality.tone && <span><strong style={{ color: 'var(--ink-2)' }}>Tone:</strong> {kit.personality.tone}</span>}
          {kit.personality.energy && <span><strong style={{ color: 'var(--ink-2)' }}>Energy:</strong> {kit.personality.energy}</span>}
          {kit.personality.targetAudience && <span><strong style={{ color: 'var(--ink-2)' }}>Audience:</strong> {kit.personality.targetAudience}</span>}
        </div>
      )}
    </div>
  );
};

const PaletteCard = ({ kit, palette }) => {
  // Compose the displayed swatches: use the palette array first (already
  // ordered by role), then add any extra named colors that didn't land in
  // the palette (e.g. text_secondary), and finally the semantic group as a
  // separate row so primary brand colors still read first.
  const seen = new Set((palette || []).map((c) => (c.hex || '').toLowerCase()));
  const extras = [];
  for (const [key, hex] of [
    ['accent', kit.accentColor],
    ['background', kit.backgroundColor],
    ['text', kit.textPrimaryColor],
    ['text-2', kit.textSecondaryColor],
  ]) {
    if (hex && !seen.has(hex.toLowerCase())) {
      extras.push({ hex, role: key });
      seen.add(hex.toLowerCase());
    }
  }
  const allSwatches = [...(palette || []), ...extras];
  const semantic = kit.semanticColors || {};
  const semanticEntries = Object.entries(semantic).filter(([, v]) => typeof v === 'string');
  return (
    <div className="card">
      <div className="card-head">
        <div><div className="card-title">Palette</div><div className="card-sub">{allSwatches.length} colors{kit.colorScheme ? ` · ${kit.colorScheme} scheme` : ''}</div></div>
      </div>
      {allSwatches.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No palette colors set. Upload a guidelines PDF and we'll extract them.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {allSwatches.map((c, i) => {
              const dark = ['#1B1F1C', '#5E6A52', '#000000', '#151515'].includes((c.hex || '').toUpperCase());
              return (
                <div key={`${c.hex}_${i}`} style={{
                  position: 'relative',
                  background: c.hex,
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  padding: '44px 14px 14px',
                  color: dark ? '#FBF6ED' : '#1B1F1C',
                }}>
                  <div style={{ fontFamily: 'var(--font-serif)', fontSize: 18, letterSpacing: '-0.01em' }}>{c.name || c.role || ''}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, opacity: 0.7, marginTop: 2 }}>{c.hex}</div>
                  {c.role && <div style={{ position: 'absolute', top: 10, left: 14, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55, fontWeight: 500 }}>{c.role}</div>}
                </div>
              );
            })}
          </div>
          {semanticEntries.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-2)' }}>
              <div className="tiny" style={{ marginBottom: 8 }}>Semantic</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {semanticEntries.map(([role, hex]) => (
                  <div key={role} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px 4px 6px', borderRadius: 999,
                    background: 'var(--surface-2)', border: '1px solid var(--line)',
                    fontSize: 11, color: 'var(--ink-2)',
                  }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: hex, border: '1px solid rgba(0,0,0,0.15)' }}/>
                    <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{role}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.7 }}>{hex}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const DesignTokensCard = ({ kit }) => {
  const ts = kit.typeScale || {};
  const sp = kit.spacingTokens || {};
  const ui = kit.uiComponents || {};
  const fontSizes = ts.fontSizes || {};
  const fontWeights = ts.fontWeights || {};
  const stacks = kit.fontStacks || {};
  const has = (
    Object.keys(fontSizes).length ||
    Object.keys(fontWeights).length ||
    Object.keys(sp).length ||
    Object.keys(ui).length ||
    Object.keys(stacks).length
  );
  if (!has) return null;
  const renderButton = (def, label) => {
    if (!def) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="tiny">{label}</div>
        <div style={{
          display: 'inline-flex', alignSelf: 'flex-start',
          padding: '10px 18px',
          background: def.background || 'transparent',
          color: def.textColor || 'var(--ink)',
          borderRadius: def.borderRadius || 8,
          border: def.borderColor ? `1px solid ${def.borderColor}` : '1px solid transparent',
          boxShadow: def.shadow && def.shadow !== 'none' ? def.shadow : undefined,
          fontSize: 13, fontWeight: 500,
        }}>Sample button</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>
          radius {def.borderRadius || '—'} · bg {def.background || '—'} · fg {def.textColor || '—'}
        </div>
      </div>
    );
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Design tokens</div>
          <div className="card-sub">Type scale, spacing, and component recipes from the live site</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {Object.keys(fontSizes).length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Type scale</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {Object.entries(fontSizes).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontSize: 11, color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 0', width: 60 }}>{k}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-2)', padding: '4px 0' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Object.keys(fontWeights).length > 0 && (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-4)' }}>
                Weights: {Object.entries(fontWeights).map(([k, v]) => `${k} ${v}`).join(' · ')}
              </div>
            )}
          </div>
        )}
        {Object.keys(stacks).length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Font stacks</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Object.entries(stacks).map(([role, fams]) => (
                <div key={role} style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                  <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, color: 'var(--ink-4)', marginRight: 6, fontWeight: 600 }}>{role}</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{(Array.isArray(fams) ? fams : []).join(', ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {Object.keys(sp).length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Spacing</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {Object.entries(sp).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontSize: 11, color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 0', width: 110 }}>{k}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-2)', padding: '4px 0' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(ui.buttonPrimary || ui.buttonSecondary) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="tiny">Button recipes</div>
            {renderButton(ui.buttonPrimary, 'Primary')}
            {renderButton(ui.buttonSecondary, 'Secondary')}
          </div>
        )}
      </div>
    </div>
  );
};

const MarketingSnapshotCard = ({ kit }) => {
  const has = kit.metaTitle || kit.metaDescription || kit.ogTitle || kit.ogDescription || (kit.twitterCard && Object.keys(kit.twitterCard).length);
  if (!has) return null;
  const tw = kit.twitterCard || {};
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Marketing snapshot</div>
          <div className="card-sub">How the brand presents itself in search and on social</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {(kit.metaTitle || kit.metaDescription) && (
          <div>
            <div className="tiny" style={{ marginBottom: 6 }}>Search engines see</div>
            {kit.metaTitle && <div style={{ fontSize: 14, color: '#1A0DAB', marginBottom: 4 }}>{kit.metaTitle}</div>}
            {kit.metaDescription && <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>{kit.metaDescription}</div>}
          </div>
        )}
        {(kit.ogTitle || kit.ogDescription) && (
          <div>
            <div className="tiny" style={{ marginBottom: 6 }}>OpenGraph (Facebook, LinkedIn)</div>
            {kit.ogImageUrl && (
              <div style={{ marginBottom: 6, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line-2)', maxHeight: 90 }}>
                <img src={kit.ogImageUrl} alt="OG preview" style={{ width: '100%', height: 90, objectFit: 'cover' }}/>
              </div>
            )}
            {kit.ogTitle && <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 2 }}>{kit.ogTitle}</div>}
            {kit.ogDescription && <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>{kit.ogDescription}</div>}
          </div>
        )}
        {(tw.title || tw.description) && (
          <div>
            <div className="tiny" style={{ marginBottom: 6 }}>Twitter card{tw.card ? ` · ${tw.card}` : ''}</div>
            {tw.title && <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 2 }}>{tw.title}</div>}
            {tw.description && <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>{tw.description}</div>}
          </div>
        )}
        {kit.language && (
          <div>
            <div className="tiny" style={{ marginBottom: 6 }}>Language</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{kit.language}</div>
          </div>
        )}
      </div>
    </div>
  );
};

const EnrichmentSummaryFooter = ({ kit, onReenrich }) => {
  if (!kit.enrichedAt && kit.enrichmentStatus === 'never') {
    // Brand never enriched — show the action even before any provenance.
    if (!kit.websiteUrl) return null;
    return (
      <div style={{
        marginTop: 32, marginBottom: 24, padding: '14px 16px',
        border: '1px dashed var(--line)', borderRadius: 8,
        background: 'var(--surface)',
        fontSize: 12, color: 'var(--ink-3)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <span>This brand has never been enriched. We can scan {kit.websiteUrl} to populate the kit.</span>
        <button className="btn btn-sm btn-primary" onClick={onReenrich} disabled={kit._reenriching}>
          <Icon name="refresh" size={12}/> {kit._reenriching ? 'Reading site…' : 'Enrich from website'}
        </button>
      </div>
    );
  }
  const conf = kit.confidenceScores || {};
  const overall = typeof conf.overall === 'number' ? Math.round(conf.overall * 100) : null;
  const ds = kit.designSystem || {};
  return (
    <div style={{
      marginTop: 32, marginBottom: 24, padding: '14px 16px',
      border: '1px dashed var(--line)', borderRadius: 8,
      background: 'var(--surface)',
      fontSize: 11, color: 'var(--ink-4)',
      display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', justifyContent: 'space-between',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
        <span><strong style={{ color: 'var(--ink-3)' }}>Last enriched:</strong> {kit.enrichedAt ? new Date(kit.enrichedAt).toLocaleString() : '—'}</span>
        {kit.enrichmentUrl && <span><strong style={{ color: 'var(--ink-3)' }}>From:</strong> {kit.enrichmentUrl}</span>}
        {overall !== null && <span><strong style={{ color: 'var(--ink-3)' }}>Confidence:</strong> {overall}%</span>}
        {ds.framework && ds.framework !== 'custom' && (
          <span><strong style={{ color: 'var(--ink-3)' }}>Stack:</strong> {ds.framework}{ds.componentLibrary ? ` / ${ds.componentLibrary}` : ''}</span>
        )}
      </div>
      {(kit.websiteUrl || kit.enrichmentUrl) && (
        <button
          className="btn btn-sm"
          onClick={onReenrich}
          disabled={kit._reenriching}
          title="Re-scan the website and refresh enrichment fields"
        >
          <Icon name="refresh" size={12}/> {kit._reenriching ? 'Re-enriching…' : 'Re-enrich'}
        </button>
      )}
    </div>
  );
};

// ---- Narrative section components -------------------------------------
// These compose the seven-section flow we landed on: Hero → Brand →
// Offering → Voice → Visual system → Presence → Library → footer.

// Deterministic 1–3 sentence brand summary built from the enriched fields.
// No LLM. Falls back to whatever subset is populated; returns null when
// nothing meaningful is available so the hero hides the summary block.
function composeBrandSummary(kit) {
  const bits = [];
  if (kit.positioningStatement) {
    bits.push(kit.positioningStatement.replace(/\.$/, '') + '.');
  } else if (kit.mission) {
    bits.push(kit.mission.split(/\.\s/)[0].replace(/\.$/, '') + '.');
  }
  if (kit.audience) {
    bits.push(`Made for ${kit.audience.replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\.$/, '')}.`);
  }
  if (kit.toneVoice) {
    bits.push(`Voice: ${kit.toneVoice.replace(/\.$/, '')}.`);
  }
  return bits.join(' ').trim() || null;
}

const HeroCard = ({ kit }) => {
  const lightbox = useLightbox();
  const summary = composeBrandSummary(kit);

  return (
    <div className="card" style={{ marginBottom: 24, padding: 28 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 28, alignItems: 'center' }}>
        {/* Logo */}
        <button
          type="button"
          onClick={() => kit.logoUrl && lightbox.open({ src: kit.logoUrl, mimeType: 'image/*', name: `${kit.name || 'Brand'} primary logo`, downloadUrl: kit.logoUrl })}
          style={{
            width: 180, height: 180,
            borderRadius: 18,
            border: '1px solid var(--line)',
            background: kit.logoUrl
              ? `center / 70% no-repeat url(${JSON.stringify(kit.logoUrl)}), var(--surface-2)`
              : 'var(--surface-2)',
            display: 'grid', placeItems: 'center',
            color: 'var(--ink-4)',
            cursor: kit.logoUrl ? 'zoom-in' : 'default',
            padding: 0,
          }}
        >
          {!kit.logoUrl && <Icon name="image" size={32}/>}
        </button>

        {/* Identity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, fontSize: 36, lineHeight: 1.05, letterSpacing: '-0.02em' }}>{kit.name || 'Untitled brand'}</h1>
            {kit.industry && (
              <span style={{
                padding: '4px 10px', borderRadius: 999,
                background: 'var(--surface-2)', color: 'var(--ink-2)',
                border: '1px solid var(--line)',
                fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
              }}>{kit.industry}</span>
            )}
            {kit.colorScheme && (
              <span style={{
                padding: '4px 10px', borderRadius: 999,
                background: 'var(--surface-2)', color: 'var(--ink-3)',
                border: '1px solid var(--line)',
                fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>{kit.colorScheme} scheme</span>
            )}
          </div>
          {kit.tagline && (
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontStyle: 'italic', color: 'var(--ink-2)', lineHeight: 1.3 }}>
              “{kit.tagline}”
            </div>
          )}
          {summary && (
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--ink-2)', maxWidth: 760 }}>
              {summary}
            </p>
          )}
        </div>
      </div>

    </div>
  );
};

const SectionHead = ({ title, sub, anchor }) => (
  <div id={anchor} style={{ marginTop: 32, marginBottom: 12, display: 'flex', alignItems: 'baseline', gap: 12 }}>
    <h2 style={{
      margin: 0, fontFamily: 'var(--font-serif)', fontSize: 22,
      letterSpacing: '-0.01em', color: 'var(--ink)',
    }}>{title}</h2>
    {sub && <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>{sub}</span>}
  </div>
);

const BrandStoryCard = ({ kit, saveField }) => {
  const has = kit.mission || kit.audience || (Array.isArray(kit.brandPillars) && kit.brandPillars.length);
  if (!has) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">The brand</div>
          <div className="card-sub">Why it exists, who it's for, what it stands for</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(kit.mission || saveField) && (
            <div>
              <div className="tiny" style={{ marginBottom: 6 }}>Mission</div>
              <InlineText field="mission" value={kit.mission} multiline onSave={saveField}/>
            </div>
          )}
          {(kit.audience || saveField) && (
            <div>
              <div className="tiny" style={{ marginBottom: 6 }}>Audience</div>
              <InlineText field="audience" value={kit.audience} multiline onSave={saveField}/>
            </div>
          )}
        </div>
        {Array.isArray(kit.brandPillars) && kit.brandPillars.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Brand pillars</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {kit.brandPillars.map((p, i) => (
                <div key={i} style={{
                  padding: '10px 14px',
                  background: 'var(--accent-tint)',
                  border: '1px solid var(--accent-soft)',
                  borderRadius: 10,
                  fontSize: 14, fontWeight: 500, color: 'var(--accent-ink)',
                }}>{p}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const OfferingCard = ({ kit }) => {
  const has = (
    (Array.isArray(kit.valueProps) && kit.valueProps.length) ||
    (Array.isArray(kit.keyDifferentiators) && kit.keyDifferentiators.length) ||
    (Array.isArray(kit.productCategories) && kit.productCategories.length)
  );
  if (!has) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">What they offer</div>
          <div className="card-sub">Hooks copywriters reach for when writing ads, captions, and scripts</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {Array.isArray(kit.valueProps) && kit.valueProps.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Value propositions</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {kit.valueProps.map((v, i) => (
                <li key={i} style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.5 }}>— {v}</li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(kit.keyDifferentiators) && kit.keyDifferentiators.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Key differentiators</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {kit.keyDifferentiators.map((v, i) => (
                <li key={i} style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.5 }}>— {v}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {Array.isArray(kit.productCategories) && kit.productCategories.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line-2)' }}>
          <div className="tiny" style={{ marginBottom: 8 }}>Product categories</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {kit.productCategories.map((p, i) => <Chip key={i}>{p}</Chip>)}
          </div>
        </div>
      )}
    </div>
  );
};

// VoiceCard — combined voice/messaging guide. Tone descriptor, voice tags,
// personality summary, do/don't, and "their actual words" samples (pulled
// from mission + meta_description — concrete, designer-ready copy).
const VoiceCard = ({ kit, saveField }) => {
  const samples = [];
  if (kit.mission) samples.push({ label: 'Mission', text: kit.mission });
  if (kit.metaDescription && kit.metaDescription !== kit.mission) {
    samples.push({ label: 'Site description', text: kit.metaDescription });
  }
  if (kit.ogDescription && kit.ogDescription !== kit.metaDescription) {
    samples.push({ label: 'Social description', text: kit.ogDescription });
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Voice &amp; messaging</div>
          <div className="card-sub">How the brand sounds — for copywriters, captions, scripts</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div className="tiny" style={{ marginBottom: 6 }}>Tone of voice</div>
            <InlineText field="tone_voice" value={kit.toneVoice} multiline onSave={saveField}/>
          </div>
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>Voice tags</div>
            {Array.isArray(kit.voiceTags) && kit.voiceTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {kit.voiceTags.map((v) => <Chip key={v}>{v}</Chip>)}
              </div>
            )}
            <InlineList field="voice_tags" value={kit.voiceTags} onSave={saveField} hideDisplay/>
          </div>
          {kit.personality && Object.keys(kit.personality).length > 0 && (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--line-2)', marginTop: 4 }}>
              <div className="tiny" style={{ marginBottom: 8 }}>Personality</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13, color: 'var(--ink-3)' }}>
                {kit.personality.tone && <span><strong style={{ color: 'var(--ink-2)' }}>Tone:</strong> {kit.personality.tone}</span>}
                {kit.personality.energy && <span><strong style={{ color: 'var(--ink-2)' }}>Energy:</strong> {kit.personality.energy}</span>}
                {kit.personality.targetAudience && <span><strong style={{ color: 'var(--ink-2)' }}>Audience:</strong> {kit.personality.targetAudience}</span>}
              </div>
            </div>
          )}
        </div>
        {samples.length > 0 && (
          <div>
            <div className="tiny" style={{ marginBottom: 8 }}>How they actually write</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {samples.map((s, i) => (
                <div key={i} style={{
                  padding: 14,
                  background: 'var(--surface-2)',
                  borderRadius: 10,
                  borderLeft: '3px solid var(--accent-soft)',
                }}>
                  <div className="tiny" style={{ marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)' }}>{s.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Do / Don't — full-width row at the bottom of the card */}
      <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--line-2)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--good-soft)', color: 'var(--good)', display: 'grid', placeItems: 'center' }}>
              <Icon name="check" size={12}/>
            </span>
            <div className="card-title" style={{ fontSize: 14, color: 'var(--good)' }}>Do say</div>
          </div>
          <InlineList field="dos" value={kit.dos} onSave={saveField}/>
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent-ink)', display: 'grid', placeItems: 'center' }}>
              <Icon name="x" size={12}/>
            </span>
            <div className="card-title" style={{ fontSize: 14, color: 'var(--accent-ink)' }}>Don't say</div>
          </div>
          <InlineList field="donts" value={kit.donts} onSave={saveField}/>
        </div>
      </div>
    </div>
  );
};

// TypographyCard — live type samples in the brand's actual fonts.
const TypographyCard = ({ kit }) => {
  const stacks = kit.fontStacks || {};
  const families = (kit.typeScale && kit.typeScale.fontFamilies) || {};
  const headingFamily = families.heading || stacks.heading?.[0] || families.primary || stacks.body?.[0];
  const bodyFamily = families.primary || stacks.body?.[0];
  const fonts = Array.isArray(kit.fonts) ? kit.fonts : [];
  if (!headingFamily && !bodyFamily && fonts.length === 0) return null;

  const heading = headingFamily ? `"${headingFamily}", Georgia, serif` : 'inherit';
  const body = bodyFamily ? `"${bodyFamily}", -apple-system, sans-serif` : 'inherit';

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Typography</div>
          <div className="card-sub">{[headingFamily, bodyFamily].filter(Boolean).join(' / ')}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {headingFamily && (
          <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--line-2)' }}>
            <div className="tiny" style={{ marginBottom: 6 }}>Headlines · {headingFamily}</div>
            <div style={{ fontFamily: heading, fontSize: 38, lineHeight: 1.1, letterSpacing: '-0.02em', color: 'var(--ink)' }}>
              {kit.tagline || 'The quick brown fox jumps over the lazy dog'}
            </div>
          </div>
        )}
        {bodyFamily && (
          <div>
            <div className="tiny" style={{ marginBottom: 6 }}>Body · {bodyFamily}</div>
            <div style={{ fontFamily: body, fontSize: 16, lineHeight: 1.55, color: 'var(--ink-2)' }}>
              {kit.metaDescription || kit.mission || 'Type a paragraph. The body face carries voice and rhythm — it should read effortlessly at length, not just at headline scale.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// CollapsibleEngineering — wraps DesignTokensCard so the engineering-grade
// detail (button recipes, spacing, font weights, font stacks) is one click
// away rather than always-open. Default closed for designers who don't
// need the spec view.
const CollapsibleEngineering = ({ kit }) => {
  const [open, setOpen] = useState(false);
  // Mirror the visibility check inside DesignTokensCard so we hide the
  // toggle when there's truly nothing to show.
  const ts = kit.typeScale || {};
  const sp = kit.spacingTokens || {};
  const ui = kit.uiComponents || {};
  const stacks = kit.fontStacks || {};
  const has = (
    Object.keys(ts.fontSizes || {}).length ||
    Object.keys(ts.fontWeights || {}).length ||
    Object.keys(sp).length ||
    Object.keys(ui).length ||
    Object.keys(stacks).length
  );
  if (!has) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', textAlign: 'left',
          padding: '12px 16px', borderRadius: 8,
          border: '1px solid var(--line)',
          background: open ? 'var(--surface)' : 'var(--surface-2)',
          cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 13, color: 'var(--ink-2)',
        }}
      >
        <span>
          <strong>Engineering reference</strong>
          <span style={{ color: 'var(--ink-4)', marginLeft: 8 }}>type scale, spacing, button recipes, font stacks</span>
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14}/>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <DesignTokensCard kit={kit} />
        </div>
      )}
    </div>
  );
};

// ---- Main ---------------------------------------------------------------

const BrandKitView = () => {
  const auth = readAuth() || {};
  // Impersonation: if an admin is shadowing a client, read that client's kit.
  let accountId = auth.account?.id || null;
  try {
    const impersonation = JSON.parse(sessionStorage.getItem('lr_impersonation'));
    if (impersonation?.client?.id) accountId = impersonation.client.id;
  } catch {}

  const [kit, setKit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [reenriching, setReenriching] = useState(false);
  const [reenrichErr, setReenrichErr] = useState('');

  useEffect(() => {
    if (!accountId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    loadBrandKit(accountId)
      .then((row) => { if (!cancelled) setKit(row); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load brand intelligence.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  // Pull in any non-system fonts from Google Fonts so the typography card
  // can actually render each family in its own face (otherwise "Karla"
  // would render in the page's default serif and tell us nothing). Call
  // this BEFORE any early returns below — Rules of Hooks.
  useGoogleFonts((kit?.fonts || []).map((f) => f.family).filter(Boolean));

  const saveField = async (field, value) => {
    const row = await updateBrandKit(accountId, { [field]: value });
    setKit(row);
  };

  const createKit = async () => {
    setCreating(true); setErr('');
    try {
      const row = await updateBrandKit(accountId, { tagline: '', mission: '' });
      setKit(row);
    } catch (e) {
      setErr(e.message || 'Could not create brand intelligence.');
    } finally {
      setCreating(false);
    }
  };

  const handleReenrich = async () => {
    if (!accountId) return;
    setReenrichErr('');
    // First-time fetch with no website on file (e.g. user skipped onboarding):
    // prompt for a URL, persist it, then enrich. Keeps the action discoverable
    // even before any data is captured.
    let url = kit?.websiteUrl?.trim();
    if (!url) {
      const entered = window.prompt(
        "What's your brand's website? We'll read it to populate the kit.",
        'https://'
      );
      if (!entered) return;
      url = entered.trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    }
    setReenriching(true);
    try {
      // Persist the URL on the kit before enrichment so the field is set
      // regardless of how the enrichment goes.
      if (!kit?.websiteUrl) {
        await updateBrandKit(accountId, { website_url: url });
      }
      await triggerBrandKitEnrichment({ accountId, websiteUrl: url });
      const row = await loadBrandKit(accountId);
      setKit(row);
    } catch (e) {
      setReenrichErr(e?.message || 'Re-enrichment failed.');
    } finally {
      setReenriching(false);
    }
  };

  if (!accountId) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Intelligence</h1>
          <div className="sub">Sign in with a brand workspace to see your brand intelligence.</div>
        </div></div>
      </div></div>
    );
  }

  if (loading) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Intelligence</h1>
          <div className="sub">Loading…</div>
        </div></div>
      </div></div>
    );
  }

  if (err) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Intelligence</h1>
          <div className="sub" style={{ color: 'var(--accent-ink)' }}>{err}</div>
        </div></div>
      </div></div>
    );
  }

  if (!kit) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Intelligence</h1>
          <div className="sub">Brand intelligence hasn't been set up yet.</div>
        </div></div>
        <div className="empty" style={{ padding: 32 }}>
          <div className="big">No brand intelligence yet</div>
          Brand intelligence is where L+R pulls your tagline, tone, palette, and references when we make work for you.
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" disabled={creating} onClick={createKit}>
              <Icon name="plus" size={14}/>{creating ? 'Creating…' : 'Create brand intelligence'}
            </button>
          </div>
        </div>
      </div></div>
    );
  }

  const brandName = kit.name || 'your brand';
  const palette = kit.palette || [];
  const fonts = kit.fonts || [];
  const logos = kit.logos || [];
  const photography = kit.photography || [];
  const inspiration = kit.inspiration || [];
  // Past creatives only render when at least one entry has a real image
  // URL. Caption-only entries (e.g. IG posts where we don't yet cache the
  // images) stay in the DB but are hidden until the social-asset pipeline
  // is wired up (see project_past_creatives_deferred memory).
  const pastCreativesAll = kit.pastCreatives || [];
  const pastCreatives = pastCreativesAll.filter((p) => p.imageUrl || p.image_url);

  return (
    <div className="view"><div className="view-inner" style={{ maxWidth: 1200 }}>
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>Knowledge base</div>
          <h1>Brand Intelligence</h1>
          <div className="sub">Everything L+R references when we make work for {brandName}. Built for the designer or copywriter who's about to make something.</div>
        </div>
        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={handleReenrich}
            disabled={reenriching}
            title={kit.websiteUrl
              ? (kit.enrichedAt ? 'Re-scan the website and refresh enrichment fields' : 'Read your website and populate the kit')
              : 'Add a website to populate the kit'}
            style={reenriching ? { animation: 'lr-button-pulse 1.4s ease-in-out infinite' } : undefined}
          >
            <Icon name="sparkles" size={14}/>{reenriching ? 'Fetching…' : 'Fetch Brand'}
          </button>
          <button className="btn" onClick={() => exportBrandKit(kit)}>
            <Icon name="download" size={14}/>Export
          </button>
        </div>
        {reenrichErr && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--accent-ink)' }}>{reenrichErr}</div>
        )}
      </div>

      {/* 1. HERO — logo + name + tagline + positioning + palette strip */}
      <HeroCard kit={kit} />

      {/* 2. THE BRAND — mission, audience, pillars */}
      {(kit.mission || kit.audience || (Array.isArray(kit.brandPillars) && kit.brandPillars.length)) ? (
        <>
          <SectionHead title="The brand" sub="why it exists, who it's for"/>
          <BrandStoryCard kit={kit} saveField={saveField} />
        </>
      ) : null}

      {/* 3. WHAT THEY OFFER — value props, differentiators, categories */}
      {(kit.valueProps?.length || kit.keyDifferentiators?.length || kit.productCategories?.length) ? (
        <>
          <SectionHead title="What they offer" sub="hooks for ads, captions, scripts"/>
          <OfferingCard kit={kit} />
        </>
      ) : null}

      {/* 4. VOICE & MESSAGING — tone, voice tags, samples, do/don't.
          Always renders because Do say / Don't say are useful interactive
          fields even before fetch — the user can write rules directly. */}
      {(kit.toneVoice || (kit.voiceTags?.length) || (kit.dos?.length) || (kit.donts?.length) || (kit.personality && Object.keys(kit.personality).length) || kit.mission || kit.metaDescription) ? (
        <>
          <SectionHead title="Voice &amp; messaging" sub="how the brand sounds"/>
          <VoiceCard kit={kit} saveField={saveField} />
        </>
      ) : null}

      {/* 5. VISUAL SYSTEM — palette + typography + logos + collapsible eng.
          Logo & marks always renders (entry point for upload), so the
          section always has at least one card. */}
      <SectionHead title="Visual system" sub="palette, type, marks, tokens"/>
      {((palette && palette.length) || (kit.fonts && kit.fonts.length)) ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {palette && palette.length > 0 && <PaletteCard kit={kit} palette={palette} />}
          {kit.fonts && kit.fonts.length > 0 && <TypographyCard kit={kit} />}
        </div>
      ) : null}
      <LogoMarksCard
        accountId={accountId}
        logoUrl={kit.logoUrl}
        variants={logos}
        onSave={saveField}
        onVariantsChange={(updated) => setKit(updated)}
        backgroundHint={kit.backgroundColor}
      />
      <CollapsibleEngineering kit={kit} />

      {/* 6. PRESENCE — website + socials + search/OG/Twitter previews */}
      {(kit.websiteUrl || (kit.socialLinks && Object.values(kit.socialLinks).some((v) => v))) ? (
        <>
          <SectionHead title="How they show up" sub="search, social, channels"/>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Online presence</div>
                <div className="card-sub">Website + social handles</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 24 }}>
              <div>
                <div className="tiny" style={{ marginBottom: 6 }}>Website</div>
                <InlineText
                  field="website_url"
                  value={kit.websiteUrl}
                  display={renderUrl}
                  onSave={saveField}
                />
              </div>
              <div>
                <div className="tiny" style={{ marginBottom: 6 }}>Social</div>
                <InlineSocials value={kit.socialLinks} onSave={saveField}/>
              </div>
            </div>
          </div>
          <MarketingSnapshotCard kit={kit} />
        </>
      ) : null}

      {/* 7. CREATIVE LIBRARY — references + photography (+ past creatives
          when ready). Header only renders when at least one inner block
          will appear; ReferencesCard handles its own empty state, so we
          treat it as always-present once we know we want this section. */}
      <SectionHead title="Creative library" sub="references designers grab from"/>
      <ReferencesCard accountId={accountId}/>

      {photography.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div><div className="card-title">Product photography</div><div className="card-sub">Approved library · {photography.length} shots · click to enlarge</div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
            {photography.map((p, i) => (
              <div key={p.id || i} style={{ aspectRatio: '1/1', position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line-2)' }}>
                <Art palette={p.palette} kicker={p.kicker} variant={(p.id || String(i)).length} imageUrl={p.imageUrl || p.image_url}/>
              </div>
            ))}
          </div>
        </div>
      )}

      {(inspiration.length > 0 || pastCreatives.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {inspiration.length > 0 && (
            <div className="card">
              <div className="card-head">
                <div><div className="card-title">Inspiration pinboard</div><div className="card-sub">References L+R keeps close</div></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {inspiration.map((p, i) => (
                  <div key={p.id || i} style={{ aspectRatio: '4/3', position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line-2)' }}>
                    <Art palette={p.palette} label={p.label} variant={(p.id || String(i)).length + 2} imageUrl={p.imageUrl || p.image_url}/>
                  </div>
                ))}
              </div>
            </div>
          )}
          {pastCreatives.length > 0 && (
            <div className="card">
              <div className="card-head">
                <div><div className="card-title">Past approved creatives</div><div className="card-sub">Reference baseline for new work</div></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {pastCreatives.map((p, i) => (
                  <div key={p.id || i} style={{ aspectRatio: '4/3', position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line-2)' }}>
                    <Art palette={p.palette} label={p.label} kicker="Approved" variant={(p.id || String(i)).length + 4} imageUrl={p.imageUrl || p.image_url}/>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {reenrichErr && (
        <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--accent-soft)', color: 'var(--accent-ink)', borderRadius: 8, fontSize: 12 }}>
          {reenrichErr}
        </div>
      )}

      {/* Footer — provenance + Re-enrich button */}
      <EnrichmentSummaryFooter kit={{ ...kit, _reenriching: reenriching }} onReenrich={handleReenrich} />
    </div></div>
  );
};

export { BrandKitView };
