/* eslint-disable */
/* BrandOnboardingModal — one-time welcome flow shown to a brand OWNER on
   their first visit to a brand they own. Single scrollable page with the
   six questions agreed in the brief: name, tagline, online presence,
   audience, voice, visual identity. All but the brand name are optional.
   "Skip for now" still flips the completion marker so we don't re-prompt. */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { completeBrandOnboarding, skipBrandOnboarding } from '../lib/db.js';

const VOICE_TAGS = [
  'Playful', 'Premium', 'Bold', 'Warm', 'Editorial',
  'Technical', 'Irreverent', 'Calm', 'Authoritative',
];
const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/yourbrand' },
  { key: 'tiktok',    label: 'TikTok',    placeholder: 'https://tiktok.com/@yourbrand' },
  { key: 'linkedin',  label: 'LinkedIn',  placeholder: 'https://linkedin.com/company/yourbrand' },
];
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normaliseHex(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return null;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

const BrandOnboardingModal = ({ open, kit, accountName, onComplete, onSkip }) => {
  const dialogRef = useRef(null);

  const [brandName, setBrandName] = useState(accountName || '');
  const [tagline, setTagline] = useState(kit?.tagline || '');
  const [websiteUrl, setWebsiteUrl] = useState(kit?.websiteUrl || '');
  const [socialLinks, setSocialLinks] = useState(() => ({
    instagram: kit?.socialLinks?.instagram || '',
    tiktok:    kit?.socialLinks?.tiktok    || '',
    linkedin:  kit?.socialLinks?.linkedin  || '',
  }));
  const [audience, setAudience] = useState(kit?.audience || '');
  const [voiceTags, setVoiceTags] = useState(() =>
    Array.isArray(kit?.voiceTags) ? kit.voiceTags.slice(0, 3) : []
  );
  const [primaryColor, setPrimaryColor] = useState(kit?.primaryColor || '');
  const [accentColor, setAccentColor] = useState(kit?.palette?.[0] || '');
  const [logoUrl, setLogoUrl] = useState(kit?.logoUrl || '');

  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [err, setErr] = useState('');

  // Re-seed local state if the modal is reopened against a different brand.
  useEffect(() => {
    if (!open) return;
    setBrandName(accountName || '');
    setTagline(kit?.tagline || '');
    setWebsiteUrl(kit?.websiteUrl || '');
    setSocialLinks({
      instagram: kit?.socialLinks?.instagram || '',
      tiktok:    kit?.socialLinks?.tiktok    || '',
      linkedin:  kit?.socialLinks?.linkedin  || '',
    });
    setAudience(kit?.audience || '');
    setVoiceTags(Array.isArray(kit?.voiceTags) ? kit.voiceTags.slice(0, 3) : []);
    setPrimaryColor(kit?.primaryColor || '');
    setAccentColor(kit?.palette?.[0] || '');
    setLogoUrl(kit?.logoUrl || '');
    setErr('');
  }, [open, kit?.id, accountName]);

  if (!open) return null;

  const toggleVoice = (tag) => {
    setVoiceTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= 3) return prev; // cap at 3
      return [...prev, tag];
    });
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!brandName.trim()) { setErr('A brand name is required.'); return; }
    setErr(''); setSubmitting(true);
    try {
      const primaryHex = normaliseHex(primaryColor);
      const accentHex  = normaliseHex(accentColor);
      const cleanedSocials = Object.fromEntries(
        Object.entries(socialLinks)
          .map(([k, v]) => [k, (v || '').trim()])
          .filter(([, v]) => v.length > 0)
      );
      const patch = {
        tagline: tagline.trim() || null,
        website_url: websiteUrl.trim() || null,
        social_links: cleanedSocials,
        audience: audience.trim() || null,
        voice_tags: voiceTags,
        primary_color: primaryHex,
        palette: accentHex ? [accentHex] : [],
        logo_url: logoUrl.trim() || null,
      };
      await onComplete?.({ brandName: brandName.trim(), patch });
    } catch (ex) {
      setErr(ex?.message || 'Could not save. Try again.');
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    setSkipping(true);
    try { await onSkip?.(); }
    catch (ex) { setErr(ex?.message || 'Could not skip.'); setSkipping(false); }
  };

  const busy = submitting || skipping;

  return (
    <div className="login-modal-backdrop" onMouseDown={(e) => e.preventDefault()}>
      <div
        className="login-modal onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head">
          <div className="login-modal-brand">
            <span className="dot" />
            <span>L+R</span>
            <span className="wordmark-tail">Studio</span>
          </div>
          <div className="login-modal-reason">
            <Icon name="sparkles" size={13} />
            <span>Welcome — let's set up your brand</span>
          </div>
          <h2 id="onboarding-title" className="login-modal-title">
            Tell us about <em>your brand</em>
          </h2>
          <p className="login-modal-sub">
            Six quick questions. Everything except the name is optional — you can refine
            anything later in <strong>Brand Kit</strong>.
          </p>
        </div>

        <form className="login-modal-body onboarding-body" onSubmit={handleSubmit}>
          {/* 1. Brand name */}
          <label className="auth-field">
            <span>1 · What's the brand called?</span>
            <input
              type="text"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="Luma"
              maxLength={80}
              autoFocus
              required
            />
          </label>

          {/* 2. Tagline */}
          <label className="auth-field">
            <span>2 · In one line, what do you do?</span>
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Plant-based protein bars for endurance athletes"
              maxLength={120}
            />
            <span className="onboarding-hint">{120 - tagline.length} characters left</span>
          </label>

          {/* 3. Online presence */}
          <div className="auth-field">
            <span>3 · Where can we see you online?</span>
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://yourbrand.com"
              style={{ marginBottom: 8 }}
            />
            <div className="onboarding-socials">
              {SOCIAL_PLATFORMS.map((p) => (
                <input
                  key={p.key}
                  type="url"
                  value={socialLinks[p.key]}
                  onChange={(e) => setSocialLinks((s) => ({ ...s, [p.key]: e.target.value }))}
                  placeholder={p.placeholder}
                  aria-label={p.label}
                />
              ))}
            </div>
          </div>

          {/* 4. Audience */}
          <label className="auth-field">
            <span>4 · Who are you talking to?</span>
            <textarea
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="Women 28–45 who shop at Whole Foods and follow wellness creators"
              rows={2}
              maxLength={240}
            />
          </label>

          {/* 5. Voice */}
          <div className="auth-field">
            <span>
              5 · How should you sound?
              <span className="onboarding-hint" style={{ marginLeft: 8 }}>
                Pick up to 3 ({voiceTags.length}/3)
              </span>
            </span>
            <div className="onboarding-chips">
              {VOICE_TAGS.map((tag) => {
                const on = voiceTags.includes(tag);
                const disabled = !on && voiceTags.length >= 3;
                return (
                  <button
                    type="button"
                    key={tag}
                    onClick={() => toggleVoice(tag)}
                    className={'onboarding-chip' + (on ? ' on' : '')}
                    disabled={disabled}
                  >
                    {on && <Icon name="check" size={11} />}
                    <span>{tag}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 6. Visual identity */}
          <div className="auth-field">
            <span>6 · Logo &amp; brand colors</span>
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="Logo URL (paste a link, or add later in Brand Kit)"
              style={{ marginBottom: 8 }}
            />
            <div className="onboarding-colors">
              <ColorField
                label="Primary"
                value={primaryColor}
                onChange={setPrimaryColor}
              />
              <ColorField
                label="Accent"
                value={accentColor}
                onChange={setAccentColor}
              />
            </div>
          </div>

          {err && <div className="auth-err">{err}</div>}

          <div className="onboarding-actions">
            <button
              type="button"
              className="auth-link onboarding-skip"
              onClick={handleSkip}
              disabled={busy}
            >
              {skipping ? 'Skipping…' : 'Skip for now'}
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={busy || !brandName.trim()}
            >
              {submitting ? 'Saving…' : "Save & continue"}
              {!submitting && <Icon name="arrow-right" size={14} />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const ColorField = ({ label, value, onChange }) => {
  const isValid = !value || HEX_RE.test(value.trim());
  const swatch = isValid && value ? (value.startsWith('#') ? value : `#${value}`) : '#E8E8E8';
  return (
    <label className="onboarding-color">
      <span className="onboarding-color-label">{label}</span>
      <span className="onboarding-color-row">
        <span className="onboarding-color-swatch" style={{ background: swatch }} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#FF6A3D"
          maxLength={7}
          spellCheck={false}
        />
      </span>
    </label>
  );
};

export { BrandOnboardingModal };
