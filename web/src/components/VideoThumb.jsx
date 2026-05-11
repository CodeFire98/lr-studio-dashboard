/* VideoThumb — uniform tile renderer for video attachments.

   Three states it must handle gracefully:

   1. Brand-new uploads with a sidecar thumbnail → render the JPEG and
      overlay a ▶ play badge. The happy path; matches what photos look
      like in the same grid.
   2. Brand-new uploads where the thumbnail extraction silently failed
      (rare — see videoThumbnail.js) → no thumbnailUrl on the row,
      render a clean play-icon tile.
   3. PRE-existing uploads from before the sidecar feature shipped
      (2026-05-11) → the mapper builds a thumbnailUrl pointing at a
      file that doesn't exist in storage, so the <img> 404s. The
      onError handler swaps to the same play-icon tile from case 2 —
      indistinguishable from "intentional design choice" rather than
      "looks broken."

   Reusing this component across PostPlanDetailView, BrandKitView,
   CalendarView, LibraryView, and IdeateInboxView keeps the visual
   language identical everywhere. */
import React, { useEffect, useState } from 'react';

const PlayIconTile = ({ size = 40, badgeSize, neutralBg = true }) => {
  const bs = badgeSize ?? Math.round(size * 0.9);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: neutralBg ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: bs,
          height: bs,
          borderRadius: 99,
          background: 'rgba(0,0,0,0.55)',
          color: '#fff',
          fontSize: Math.round(bs * 0.42),
          lineHeight: 1,
          paddingLeft: Math.max(2, Math.round(bs * 0.08)),
        }}
      >▶</span>
    </div>
  );
};

const PlayOverlay = ({ size = 40 }) => (
  <span
    aria-hidden
    style={{
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size,
      height: size,
      borderRadius: 99,
      background: 'rgba(0,0,0,0.6)',
      color: '#fff',
      fontSize: Math.round(size * 0.4),
      lineHeight: 1,
      paddingLeft: Math.max(2, Math.round(size * 0.08)),
      pointerEvents: 'none',
    }}
  >▶</span>
);

const VideoThumb = ({
  thumbnailUrl,
  alt = '',
  badgeSize = 40,
  style,
  imgStyle = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  loading = 'lazy',
}) => {
  const [failed, setFailed] = useState(false);
  // Reset error state when the URL changes — otherwise re-using the
  // same component instance with a new src stays stuck on the fallback.
  useEffect(() => { setFailed(false); }, [thumbnailUrl]);

  if (!thumbnailUrl || failed) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
        <PlayIconTile badgeSize={badgeSize} />
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      <img
        src={thumbnailUrl}
        alt={alt}
        loading={loading}
        onError={() => setFailed(true)}
        style={imgStyle}
      />
      <PlayOverlay size={badgeSize} />
    </div>
  );
};

export { VideoThumb };
