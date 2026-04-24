/* eslint-disable */
/* Brand Kit — knowledge base for the current brand workspace.
   Loads from Supabase (brand_kits table). Supports inline edit of text +
   list fields. Procedural Art remains the visual fallback for palette-only
   gallery items (photography, inspiration, past_creatives). */
import React, { useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';
import { Art } from './primitives.jsx';
import { readAuth } from '../lib/auth.js';
import { loadBrandKit, updateBrandKit } from '../lib/db.js';

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
          <button className="btn" title="Export coming soon" disabled><Icon name="download" size={14}/>Export kit</button>
          <button className="btn btn-primary" title="Coming in Phase 6b" disabled><Icon name="plus" size={14}/>Add asset</button>
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

        <div className="card">
          <div className="card-head">
            <div><div className="card-title">Logos</div><div className="card-sub">Primary, secondary, mono</div></div>
          </div>
          {logos.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>No logos uploaded.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {logos.map((l, i) => (
                <div key={l.id || i} style={i === 0 ? { gridColumn: '1 / -1' } : {}}>
                  <LogoBlock logo={l}/>
                </div>
              ))}
            </div>
          )}
        </div>
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
