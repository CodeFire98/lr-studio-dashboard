/* eslint-disable */
/* Brand Kit — knowledge base for the current brand workspace.
   Loads from Supabase (brand_kits table). Supports inline edit of text +
   list fields. Procedural Art remains the visual fallback for palette-only
   gallery items (photography, inspiration, past_creatives). */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Art } from './primitives.jsx';
import { readAuth } from '../lib/auth.js';
import {
  loadBrandKit,
  updateBrandKit,
  uploadBrandLogo,
  uploadBrandAsset,
  listBrandAssets,
  deleteBrandAsset,
} from '../lib/db.js';
import { confirm as confirmDialog } from './ConfirmDialog.jsx';

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

const InlineList = ({ field, value, onSave }) => {
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
        {Array.isArray(value) && value.length > 0 ? (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {value.map((d, i) => (
              <li key={i} style={{ fontSize: 14, color: 'var(--ink-2)' }}>— {d}</li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No items yet.</div>
        )}
        <div style={{ marginTop: 10 }}>
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
const BrandLogoCard = ({ accountId, logoUrl, onSave }) => {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setErr('Logo must be under 4MB.'); return; }
    setErr(''); setUploading(true);
    try {
      const { url } = await uploadBrandLogo({ accountId, file });
      await onSave('logo_url', url);
    } catch (ex) {
      setErr(ex?.message || 'Logo upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const remove = async () => {
    setErr('');
    try { await onSave('logo_url', null); }
    catch (ex) { setErr(ex?.message || 'Could not remove the logo.'); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div><div className="card-title">Logo</div><div className="card-sub">Primary brand mark</div></div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div
          style={{
            width: 120, height: 120,
            borderRadius: 14,
            border: '1px solid var(--line)',
            background: logoUrl
              ? `center / contain no-repeat url(${JSON.stringify(logoUrl)}), var(--surface-2)`
              : 'var(--surface-2)',
            display: 'grid', placeItems: 'center',
            color: 'var(--ink-4)',
            flexShrink: 0,
          }}
        >
          {!logoUrl && <Icon name="image" size={28}/>}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            style={{ display: 'none' }}
            onChange={handleFile}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <Icon name="upload" size={12}/>
              {uploading ? 'Uploading…' : logoUrl ? 'Replace' : 'Upload logo'}
            </button>
            {logoUrl && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={remove}
                disabled={uploading}
              >
                Remove
              </button>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            PNG, JPG, SVG, or WebP · up to 4MB. Stored in a public bucket so it loads anywhere.
          </div>
          {err && <div style={{ color: 'var(--accent-ink)', fontSize: 12 }}>{err}</div>}
        </div>
      </div>
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
                  <a href={item.url} target="_blank" rel="noreferrer" style={{ display: 'block', height: '100%' }}>
                    <img src={item.url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                  </a>
                ) : (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      height: '100%', padding: 12, gap: 8,
                      color: 'var(--ink-2)', textDecoration: 'none',
                    }}
                  >
                    <Icon name="folder" size={28}/>
                    <span style={{ fontSize: 12, textAlign: 'center', wordBreak: 'break-word', lineHeight: 1.3 }}>
                      {item.name}
                    </span>
                  </a>
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

  useEffect(() => {
    if (!accountId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    loadBrandKit(accountId)
      .then((row) => { if (!cancelled) setKit(row); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load brand kit.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

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
      setErr(e.message || 'Could not create brand kit.');
    } finally {
      setCreating(false);
    }
  };

  if (!accountId) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Kit</h1>
          <div className="sub">Sign in with a brand workspace to see your brand kit.</div>
        </div></div>
      </div></div>
    );
  }

  if (loading) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Kit</h1>
          <div className="sub">Loading…</div>
        </div></div>
      </div></div>
    );
  }

  if (err) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Kit</h1>
          <div className="sub" style={{ color: 'var(--accent-ink)' }}>{err}</div>
        </div></div>
      </div></div>
    );
  }

  if (!kit) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand Kit</h1>
          <div className="sub">Brand kit hasn't been set up yet.</div>
        </div></div>
        <div className="empty" style={{ padding: 32 }}>
          <div className="big">No brand kit yet</div>
          A brand kit is where L+R pulls your tagline, tone, palette, and references when we make work for you.
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" disabled={creating} onClick={createKit}>
              <Icon name="plus" size={14}/>{creating ? 'Creating…' : 'Create brand kit'}
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
  const pastCreatives = kit.pastCreatives || [];

  return (
    <div className="view"><div className="view-inner" style={{ maxWidth: 1200 }}>
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>Knowledge base</div>
          <h1>Brand Kit</h1>
          <div className="sub">Everything L+R references when we make work for {brandName}. Keep this fresh — it's the first place we look.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => exportBrandKit(kit)}>
            <Icon name="download" size={14}/>Export kit
          </button>
        </div>
      </div>

      {/* AI summary */}
      <div className="card" style={{ marginBottom: 32, background: 'linear-gradient(135deg, var(--accent-tint), var(--surface))', borderColor: 'var(--accent-soft)' }}>
        <div className="card-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
              background: 'var(--accent)', color: 'var(--accent-contrast)',
            }}><Icon name="sparkles" size={14}/></span>
            <div>
              <div className="card-title" style={{ fontSize: 22 }}>How L+R understands your brand</div>
              <div className="card-sub">Inferred from your kit, past briefs, and delivered work</div>
            </div>
          </div>
        </div>
        <InlineText
          field="ai_summary"
          value={kit.aiSummary}
          multiline
          display={(v) => (
            <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--ink-2)', margin: 0, maxWidth: 760 }}>
              {v || <span style={{ color: 'var(--ink-4)' }}>Add a short summary of what L+R should remember about your brand.</span>}
            </p>
          )}
          onSave={saveField}
        />
      </div>

      {/* Online presence — website + socials. First place the agency looks. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Online presence</div>
            <div className="card-sub">Where the team can see how your brand shows up today</div>
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

      {/* Identity + palette */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div><div className="card-title">Identity</div><div className="card-sub">Mission, audience, and what you stand for</div></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <div className="tiny" style={{ marginBottom: 6 }}>Tagline</div>
              <InlineText
                field="tagline"
                value={kit.tagline}
                display={(v) => (
                  <div style={{ fontFamily: 'var(--font-serif)', fontSize: 26, letterSpacing: '-0.01em', lineHeight: 1.15, fontStyle: 'italic' }}>
                    {v ? `"${v}"` : <span style={{ color: 'var(--ink-4)', fontStyle: 'normal', fontSize: 14 }}>No tagline yet.</span>}
                  </div>
                )}
                onSave={saveField}
              />
            </div>
            <div>
              <div className="tiny" style={{ marginBottom: 6 }}>Mission</div>
              <InlineText field="mission" value={kit.mission} multiline onSave={saveField}/>
            </div>
            <div>
              <div className="tiny" style={{ marginBottom: 6 }}>Audience</div>
              <InlineText field="audience" value={kit.audience} multiline onSave={saveField}/>
            </div>
            <div>
              <div className="tiny" style={{ marginBottom: 6 }}>Tone of voice</div>
              <InlineText field="tone_voice" value={kit.toneVoice} multiline onSave={saveField}/>
            </div>
            <div>
              <div className="tiny" style={{ marginBottom: 8 }}>Voice tags</div>
              {Array.isArray(kit.voiceTags) && kit.voiceTags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {kit.voiceTags.map((v) => (
                    <span key={v} style={{
                      padding: '5px 10px', borderRadius: 999,
                      background: 'var(--surface-2)', color: 'var(--ink-2)',
                      border: '1px solid var(--line)',
                      fontSize: 12, fontWeight: 500,
                    }}>{v}</span>
                  ))}
                </div>
              )}
              <InlineList field="voice_tags" value={kit.voiceTags} onSave={saveField}/>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div><div className="card-title">Palette</div><div className="card-sub">{palette.length} colors</div></div>
          </div>
          {palette.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No palette colors set. Upload a guidelines PDF and we'll extract them.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {palette.map((c, i) => {
                const dark = ['#1B1F1C', '#5E6A52', '#000000'].includes(c.hex);
                return (
                  <div key={`${c.hex}_${i}`} style={{
                    position: 'relative',
                    background: c.hex,
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    padding: '44px 14px 14px',
                    color: dark ? '#FBF6ED' : '#1B1F1C',
                  }}>
                    <div style={{ fontFamily: 'var(--font-serif)', fontSize: 18, letterSpacing: '-0.01em' }}>{c.name}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, opacity: 0.7, marginTop: 2 }}>{c.hex}</div>
                    {c.role && <div style={{ position: 'absolute', top: 10, left: 14, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55, fontWeight: 500 }}>{c.role}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Typography + Logos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div><div className="card-title">Typography</div><div className="card-sub">Display + UI pairing</div></div>
          </div>
          {fonts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No fonts set.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {fonts.map((f, i) => (
                <div key={`${f.family}_${i}`} style={{ padding: '14px 0', borderTop: i === 0 ? 'none' : '1px solid var(--line-2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                    <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, letterSpacing: '-0.01em' }}>{f.family}</div>
                    <div className="tiny">{f.role}</div>
                  </div>
                  <div style={{
                    fontFamily: f.role?.includes('Display') ? 'var(--font-serif)' : 'var(--font-sans)',
                    fontSize: f.role?.includes('Display') ? 36 : 18,
                    lineHeight: 1.15,
                    letterSpacing: f.role?.includes('Display') ? '-0.02em' : '0',
                    fontStyle: f.role?.includes('Display') ? 'italic' : 'normal',
                    color: 'var(--ink)',
                  }}>
                    {f.sample}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <BrandLogoCard
          accountId={accountId}
          logoUrl={kit.logoUrl}
          onSave={saveField}
        />
      </div>

      {/* Do / Don't */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div><div className="card-title" style={{ color: 'var(--good)' }}>Do</div></div>
            <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--good-soft)', color: 'var(--good)', display: 'grid', placeItems: 'center' }}>
              <Icon name="check" size={14}/>
            </span>
          </div>
          <InlineList field="dos" value={kit.dos} onSave={saveField}/>
        </div>
        <div className="card">
          <div className="card-head">
            <div><div className="card-title" style={{ color: 'var(--accent-ink)' }}>Don't</div></div>
            <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent-ink)', display: 'grid', placeItems: 'center' }}>
              <Icon name="x" size={14}/>
            </span>
          </div>
          <InlineList field="donts" value={kit.donts} onSave={saveField}/>
        </div>
      </div>

      {/* References & assets — brand-uploaded visual library */}
      <ReferencesCard accountId={accountId}/>

      {/* Photography */}
      {photography.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div><div className="card-title">Product photography</div><div className="card-sub">Approved library · {photography.length} shots</div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
            {photography.map((p, i) => (
              <div key={p.id || i} style={{ aspectRatio: '1/1', position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line-2)' }}>
                <Art palette={p.palette} kicker={p.kicker} variant={(p.id || String(i)).length}/>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inspiration + Past creatives */}
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
                    <Art palette={p.palette} label={p.label} variant={(p.id || String(i)).length + 2}/>
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
                    <Art palette={p.palette} label={p.label} kicker="Approved" variant={(p.id || String(i)).length + 4}/>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div></div>
  );
};

export { BrandKitView };
