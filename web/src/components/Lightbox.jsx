/* eslint-disable */
/* Media lightbox + provider.

   Any component can call `useLightbox().open({ src, mimeType, name, alt, downloadUrl })`
   to display a full-size image, video, PDF, or generic file in a modal overlay
   on the current screen. ESC and scrim-click both close.

   - image/* → <img> (object-fit: contain so portrait + landscape both fit)
   - video/* → <video controls autoplay>
   - application/pdf → <iframe> embed
   - anything else / unknown → filename + size + download button

   Designed to share a single root-mounted instance; mount <LightboxProvider>
   once near the app root and everything below it gets `useLightbox()`. */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const LightboxContext = createContext({ open: () => {}, close: () => {} });

function classifyMime(mimeType, src) {
  const m = (mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  // Best-effort fallback: inspect URL extension when MIME is missing.
  if (!m && typeof src === 'string') {
    const ext = src.split(/[?#]/)[0].split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
  }
  return 'other';
}

const MediaLightbox = ({ media, onClose }) => {
  const { src, mimeType, name, alt, downloadUrl } = media;
  const kind = classifyMime(mimeType, src);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    // Lock body scroll while the lightbox is open so the page underneath
    // doesn't scroll when the user uses arrow keys / scroll wheel.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(8, 8, 10, 0.86)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '40px 24px',
      }}
    >
      {/* Top bar — filename + actions + close */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', top: 16, left: 24, right: 24,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          color: 'rgba(255,255,255,0.92)', fontSize: 13,
          pointerEvents: 'none',
        }}
      >
        <div style={{ pointerEvents: 'auto', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name || alt || ''}
        </div>
        <div style={{ pointerEvents: 'auto', display: 'flex', gap: 8 }}>
          {(downloadUrl || src) && (
            <a
              href={downloadUrl || src}
              download={name || ''}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 6,
                background: 'rgba(255,255,255,0.12)', color: '#fff',
                textDecoration: 'none', fontSize: 13,
                border: '1px solid rgba(255,255,255,0.18)',
              }}
            >Download</a>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              padding: '6px 12px', borderRadius: 6,
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.18)', cursor: 'pointer',
              fontSize: 13,
            }}
          >Close ✕</button>
        </div>
      </div>

      {/* Media body */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 'min(96vw, 1600px)', maxHeight: '88vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {kind === 'image' && (
          <img
            src={src}
            alt={alt || name || ''}
            style={{ maxWidth: '100%', maxHeight: '88vh', objectFit: 'contain', borderRadius: 4, boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}
          />
        )}
        {kind === 'video' && (
          <video
            src={src}
            controls
            autoPlay
            style={{ maxWidth: '100%', maxHeight: '88vh', borderRadius: 4, background: '#000', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}
          />
        )}
        {kind === 'pdf' && (
          <iframe
            src={src}
            title={name || 'PDF'}
            style={{ width: 'min(94vw, 1200px)', height: '88vh', border: 0, borderRadius: 4, background: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}
          />
        )}
        {kind === 'other' && (
          <div style={{
            background: '#fff', color: '#1B1F1C', padding: 24, borderRadius: 8, minWidth: 320, maxWidth: 480,
            boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{name || 'File'}</div>
            <div style={{ color: '#555', fontSize: 13, marginBottom: 16 }}>
              {mimeType || 'Unknown type'} — preview not available in browser.
            </div>
            <a
              href={downloadUrl || src}
              download={name || ''}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block', padding: '8px 16px', borderRadius: 6,
                background: '#1B1F1C', color: '#fff', textDecoration: 'none', fontSize: 13,
              }}
            >Download to view</a>
          </div>
        )}
      </div>
    </div>
  );
};

const LightboxProvider = ({ children }) => {
  const [media, setMedia] = useState(null);

  const open = useCallback((m) => {
    if (!m || !m.src) return;
    setMedia(m);
  }, []);
  const close = useCallback(() => setMedia(null), []);

  return (
    <LightboxContext.Provider value={{ open, close }}>
      {children}
      {media && <MediaLightbox media={media} onClose={close} />}
    </LightboxContext.Provider>
  );
};

const useLightbox = () => useContext(LightboxContext);

export { LightboxProvider, useLightbox };
