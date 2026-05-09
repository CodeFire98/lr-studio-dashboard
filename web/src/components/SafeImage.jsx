/* eslint-disable */
/* SafeImage — drop-in replacement for `<img>` that swaps to a friendly
   fallback tile when the browser can't render the image.

   The most common reason for failure on this dashboard is users
   uploading 32k×22k pixel PNGs (e.g. iPhone Pro RAW exports or AI-
   upscaled reference shots) that the browser refuses to decode despite
   the file itself being only a few megabytes. Without a fallback, the
   `<img>` renders as the browser's default broken-image-with-alt-text
   placeholder, which looks broken rather than informative.

   This component:
     - Renders <img> normally on first paint
     - Listens for the `error` event
     - Swaps to a fallback tile with an icon + filename + small caption
       explaining the cause when load fails

   The upload path now rejects oversize images proactively (see
   imageValidation.js), but we keep this fallback because:
     1. Files uploaded BEFORE the validator was added are still in
        storage and will keep rendering as broken without it.
     2. Other transient render failures (network blips, expired signed
        URLs) deserve a graceful fallback regardless.

   Pass any extra `<img>` props through `imgProps` if you need them
   (e.g. `loading="lazy"`, custom `style`). The fallback inherits the
   parent's box dimensions via `width:100%; height:100%`, so wrap it
   in a sized container the same way you would any thumbnail. */
import React, { useState, useEffect } from 'react';
import { Icon } from './Icon.jsx';

const SafeImage = ({
  src,
  alt = '',
  filename,        // optional — shown in fallback if the alt is empty
  caption,         // optional — short hint shown in fallback (e.g. "Preview unavailable")
  fallbackIcon = 'image',
  // Any other props (style, loading, onClick, etc.) get forwarded.
  ...imgProps
}) => {
  const [failed, setFailed] = useState(false);

  // Reset error state when the src changes — otherwise a row that
  // re-uses the same component instance with a new url stays stuck on
  // the fallback.
  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) {
    const label = caption || (failed ? 'Preview unavailable' : 'No image');
    const name = filename || alt || '';
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: 8,
          background: 'var(--surface-2)',
          color: 'var(--ink-3)',
          textAlign: 'center',
          // Don't let long filenames break the layout — they're already
          // shown in full below the tile in most surfaces, this is
          // belt-and-suspenders.
          overflow: 'hidden',
        }}
        title={name ? `${label} — ${name}` : label}
      >
        <Icon name={fallbackIcon} size={20} />
        <span style={{ fontSize: 11, lineHeight: 1.3, color: 'var(--ink-3)' }}>
          {label}
        </span>
        {name && (
          <span
            style={{
              fontSize: 10,
              lineHeight: 1.3,
              color: 'var(--ink-4)',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </span>
        )}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      {...imgProps}
    />
  );
};

export { SafeImage };
