/* eslint-disable */
/* BrandOnboardingModal — one-time welcome flow shown to a brand OWNER on
   their first visit to a brand they own. Single scrollable page with the
   six questions agreed in the brief: name, tagline, online presence,
   audience, voice, visual identity. All but the brand name are optional.
   "Skip for now" still flips the completion marker so we don't re-prompt. */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import {
  completeBrandOnboarding,
  skipBrandOnboarding,
  uploadBrandLogo,
  triggerBrandKitEnrichment,
  loadBrandKit,
} from '../lib/db.js';

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

const BrandOnboardingModal = ({ open, kit, accountId, accountName, onComplete, onSkip }) => {
  const dialogRef = useRef(null);
  const fileInputRef = useRef(null);

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
  const [customVoice, setCustomVoice] = useState('');
  const [primaryColor, setPrimaryColor] = useState(kit?.primaryColor || '');
  const [accentColor, setAccentColor] = useState(() => {
    const p = kit?.palette?.[0];
    return (p && typeof p === 'object' ? p.hex : p) || '';
  });
  const [logoUrl, setLogoUrl] = useState(kit?.logoUrl || '');
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [err, setErr] = useState('');
  // Fetch-brand state. The modal can call the deployed enrich-brand-kit
  // edge function to auto-populate every field from the brand's website +
  // socials, then we re-load the kit and seed the form. Multi-stage
  // progress ticker keeps the user oriented during the ~15-25s call.
  const [fetching, setFetching] = useState(false);
  const [fetchStage, setFetchStage] = useState(0);
  const [fetchSuccess, setFetchSuccess] = useState(false);

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
    setCustomVoice('');
    setPrimaryColor(kit?.primaryColor || '');
    {
      const p = kit?.palette?.[0];
      setAccentColor((p && typeof p === 'object' ? p.hex : p) || '');
    }
    setLogoUrl(kit?.logoUrl || '');
    setErr('');
  }, [open, kit?.id, accountName]);

  // Cycle the progress ticker every ~3.5s while fetching. Defined here
  // BEFORE the early `!open` return so the hook order stays stable across
  // open/close transitions.
  useEffect(() => {
    if (!fetching) return;
    const t = setInterval(() => {
      setFetchStage((s) => Math.min(s + 1, 4));
    }, 3500);
    return () => clearInterval(t);
  }, [fetching]);

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
      const finalVoiceTags = customVoice.trim()
        ? [...voiceTags, customVoice.trim()]
        : voiceTags;
      const patch = {
        tagline: tagline.trim() || null,
        website_url: websiteUrl.trim() || null,
        social_links: cleanedSocials,
        audience: audience.trim() || null,
        voice_tags: finalVoiceTags,
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

  const FETCH_STAGES = [
    'Reading your website…',
    'Extracting palette and typography…',
    'Finding voice and positioning…',
    'Pulling product photography…',
    'Composing your brand book…',
  ];

  const handleFetchBrand = async () => {
    if (!accountId) { setErr('Brand account is missing — try reopening the modal.'); return; }
    if (!websiteUrl.trim()) { setErr('Add a website URL to fetch from.'); return; }
    setErr(''); setFetchSuccess(false); setFetchStage(0); setFetching(true);
    try {
      // Persist any social links the user typed so the enrichment merges
      // them into social_links instead of overwriting on the server side.
      // The edge function already preserves existing values.
      await triggerBrandKitEnrichment({ accountId, websiteUrl: websiteUrl.trim() });
      const fresh = await loadBrandKit(accountId);
      // Seed every modal field from the freshly-enriched kit. Existing
      // user input wins where present so we don't blow away anything they
      // typed before clicking Fetch brand.
      if (fresh) {
        if (!tagline.trim() && fresh.tagline) setTagline(fresh.tagline);
        if (!audience.trim() && fresh.audience) setAudience(fresh.audience);
        if (!primaryColor.trim() && fresh.primaryColor) setPrimaryColor(fresh.primaryColor);
        const fetchedAccent = fresh.accentColor
          || (Array.isArray(fresh.palette) && fresh.palette[1] && fresh.palette[1].hex)
          || (Array.isArray(fresh.palette) && fresh.palette[0] && fresh.palette[0].hex);
        if (!accentColor.trim() && fetchedAccent) setAccentColor(fetchedAccent);
        if (!logoUrl.trim() && fresh.logoUrl) setLogoUrl(fresh.logoUrl);
        // Voice tags: take up to 3 from fetched if user hasn't picked any.
        if (voiceTags.length === 0 && Array.isArray(fresh.voiceTags) && fresh.voiceTags.length) {
          // Map fetched lowercase tags to the chip vocabulary where possible
          // (otherwise drop into customVoice).
          const wanted = fresh.voiceTags.slice(0, 3).map((t) => String(t).toLowerCase());
          const matched = VOICE_TAGS.filter((vt) => wanted.includes(vt.toLowerCase())).slice(0, 3);
          if (matched.length > 0) setVoiceTags(matched);
          // Anything not matched goes into the freeform "Other" line so
          // the user can see what was extracted.
          const unmatched = fresh.voiceTags
            .filter((t) => !VOICE_TAGS.some((vt) => vt.toLowerCase() === String(t).toLowerCase()))
            .slice(0, 2)
            .join(', ');
          if (unmatched && !customVoice.trim()) setCustomVoice(unmatched);
        }
        // Merge socials (don't overwrite anything the user typed).
        if (fresh.socialLinks && typeof fresh.socialLinks === 'object') {
          setSocialLinks((prev) => ({
            instagram: prev.instagram?.trim() ? prev.instagram : (fresh.socialLinks.instagram || ''),
            tiktok:    prev.tiktok?.trim()    ? prev.tiktok    : (fresh.socialLinks.tiktok    || ''),
            linkedin:  prev.linkedin?.trim()  ? prev.linkedin  : (fresh.socialLinks.linkedin  || ''),
          }));
        }
      }
      setFetchSuccess(true);
    } catch (ex) {
      setErr(ex?.message || 'Could not fetch brand info from the website.');
    } finally {
      setFetching(false);
      setFetchStage(0);
    }
  };

  const handleLogoFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!accountId) { setErr('Brand account is missing — try reopening the modal.'); return; }
    if (file.size > 4 * 1024 * 1024) { setErr('Logo must be under 4MB.'); return; }
    setErr(''); setUploadingLogo(true);
    try {
      const { url } = await uploadBrandLogo({ accountId, file });
      setLogoUrl(url);
    } catch (ex) {
      setErr(ex?.message || 'Logo upload failed.');
    } finally {
      setUploadingLogo(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const busy = submitting || skipping || uploadingLogo;

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
            A few quick questions. Drop your website and we'll fill in the rest —
            then refine anything in <strong>Brand Intelligence</strong>.
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

          {/* 2. Website */}
          <label className="auth-field">
            <span>2 · What's your website?</span>
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://yourbrand.com"
            />
          </label>

          {/* Auto-fill banner — magic moment. Sits between website and the
              fields it pre-populates so the cause→effect is obvious. */}
          <div style={{
            padding: '18px 18px',
            borderRadius: 14,
            background: 'linear-gradient(135deg, var(--accent-tint), var(--surface))',
            border: '1.5px solid var(--accent)',
            boxShadow: '0 4px 18px -8px rgba(232, 85, 61, 0.35)',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 240 }}>
                <strong style={{ fontSize: 15, color: 'var(--ink)' }}>Skip the typing — let us fill the rest</strong>
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  We'll read your website, find your socials, palette, voice, and logo. Powered by L+R Brand Intelligence.
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleFetchBrand}
                disabled={busy || fetching || !websiteUrl.trim()}
                style={{
                  minWidth: 150,
                  ...(fetching ? { animation: 'lr-button-pulse 1.4s ease-in-out infinite' } : null),
                }}
              >
                {fetching
                  ? <><Icon name="refresh" size={13}/> Fetching…</>
                  : fetchSuccess
                    ? <><Icon name="check" size={13}/> Fetched</>
                    : <><Icon name="sparkles" size={13}/> Fetch brand</>}
              </button>
            </div>
            {fetching && (
              <div style={{
                fontSize: 12, color: 'var(--ink-2)',
                padding: '4px 0',
              }}>
                {FETCH_STAGES[fetchStage]}
              </div>
            )}
            {fetchSuccess && !fetching && (
              <div style={{ fontSize: 12, color: 'var(--good)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="check" size={11}/>
                Pre-filled what we found. Review and tweak below.
              </div>
            )}
          </div>

          {/* 3. Socials — auto-fill drops these in if Fetch found them. */}
          <div className="auth-field">
            <span>3 · Your other channels</span>
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

          {/* 4. Tagline */}
          <label className="auth-field">
            <span>4 · In one line, what do you do?</span>
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Plant-based protein bars for endurance athletes"
              maxLength={120}
            />
            <span className="onboarding-hint">{120 - tagline.length} characters left</span>
          </label>

          {/* 5. Audience */}
          <label className="auth-field">
            <span>5 · Who are you talking to?</span>
            <textarea
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="Women 28–45 who shop at Whole Foods and follow wellness creators"
              rows={2}
              maxLength={240}
            />
          </label>

          {/* 6. Voice */}
          <div className="auth-field">
            <span>
              6 · How should you sound?
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
            <input
              type="text"
              value={customVoice}
              onChange={(e) => setCustomVoice(e.target.value)}
              placeholder="Other — describe your tone"
              maxLength={40}
              style={{ marginTop: 8 }}
            />
          </div>

          {/* 7. Logo. Colors are still captured by Fetch brand and saved on
              submit, but we don't ask the user to type hex codes — most
              people don't have them memorized. */}
          <div className="auth-field">
            <span>7 · Logo</span>
            <div className="onboarding-logo-row">
              <div
                className="onboarding-logo-preview"
                style={logoUrl ? { background: `center / contain no-repeat url(${JSON.stringify(logoUrl)})` } : undefined}
              >
                {!logoUrl && <Icon name="image" size={20} />}
              </div>
              <div className="onboarding-logo-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  style={{ display: 'none' }}
                  onChange={handleLogoFile}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  <Icon name="upload" size={12} />
                  {uploadingLogo ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                </button>
                {logoUrl && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setLogoUrl('')}
                    disabled={busy}
                  >
                    Remove
                  </button>
                )}
                <span className="onboarding-hint">PNG, JPG, SVG · up to 4MB</span>
              </div>
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

export { BrandOnboardingModal };
