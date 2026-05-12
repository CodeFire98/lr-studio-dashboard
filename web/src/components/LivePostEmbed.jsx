/* eslint-disable */
/* LivePostEmbed — static embed card for a live post.
 *
 * v1 ships static cards across all three platforms (IG / LinkedIn / X)
 * built from the `post_embed_cache` row that /api/engagement/refresh
 * populated. We deliberately don't render the platforms' own iframes:
 *
 *   - X has an official oEmbed but its widget.js mutates the page and
 *     drags in their tracking scripts; a static card looks more
 *     consistent next to the other two and respects user privacy.
 *   - Meta's IG oEmbed requires an approved Meta app; the
 *     blockquote+embed.js fallback is fragile and breaks silently when
 *     Meta tightens it. A static card from the Apify-scraped fields
 *     gives us full control.
 *   - LinkedIn has no public oEmbed; static is the only option anyway.
 *
 * Visual contract — one shape regardless of platform:
 *
 *   [avatar]  @author_handle · 2d ago         [platform chip]
 *   [   media block (image | video poster | text-only fallback)   ]
 *   "caption truncated to 4 lines…"
 *
 * Loading / failure states are owned by the parent <LiveTile> — this
 * component renders nothing graceful when `embed` is null. The tile
 * shows a "Fetching metrics…" or "Refresh failed" surface instead. */

import React from 'react';
import { PlatformChip } from './postPlanShared.jsx';

const formatRelative = (iso) => {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = Date.now() - then;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
};

const truncate = (text, n = 220) => {
  if (!text) return '';
  if (text.length <= n) return text;
  return text.slice(0, n).trimEnd() + '…';
};

// Route IG / Facebook CDN URLs through the same-origin image proxy so
// the browser doesn't trip on Meta's Cross-Origin-Resource-Policy.
// Non-Meta hosts (eg. user-pasted X media URLs) pass through unchanged.
const proxiedUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const needsProxy =
      host.endsWith('.cdninstagram.com') ||
      host.endsWith('.fbcdn.net') ||
      host === 'cdninstagram.com';
    if (!needsProxy) return raw;
    return `/api/engagement/image-proxy?u=${encodeURIComponent(raw)}`;
  } catch {
    return raw;
  }
};

const Avatar = ({ url, name }) => {
  // No avatar in the cache (IG actor doesn't surface it) → render a
  // monogram tile so the row still aligns visually.
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  if (url) {
    return (
      <img
        src={url}
        alt={name || 'author'}
        width={28}
        height={28}
        style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: 'var(--surface-2, #2a2a2a)',
        color: 'var(--ink-3)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
};

const MediaBlock = ({ embed, liveUrl }) => {
  const url = embed?.mediaUrl;
  const mediaType = embed?.mediaType || 'unknown';

  // Text-only post (X tweet with no image, LinkedIn text post). Skip the
  // media slab entirely so the card collapses to caption-only.
  if (!url || mediaType === 'text') return null;

  // Reserve aspect-ratio if we know it; otherwise default to 1:1 so the
  // tile doesn't jump as the image loads.
  const ratio = embed?.mediaAspectRatio && embed.mediaAspectRatio > 0
    ? embed.mediaAspectRatio
    : 1;

  return (
    <a
      href={liveUrl || url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'block',
        position: 'relative',
        width: '100%',
        aspectRatio: ratio,
        maxHeight: 360,
        background: 'var(--surface-2, #1a1a1a)',
        borderRadius: 8,
        overflow: 'hidden',
        textDecoration: 'none',
      }}
      aria-label="Open live post in a new tab"
    >
      <img
        // Route IG CDN URLs through our /api/engagement/image-proxy.
        // Meta sends Cross-Origin-Resource-Policy: same-origin (or
        // same-site) on scontent-*.cdninstagram.com responses, so any
        // direct <img src=...cdninstagram.com> is blocked by the
        // browser with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin regardless
        // of crossorigin / referrerpolicy. Proxying server-side strips
        // that CORP header (CORP is browser-side only, server-to-server
        // fetches ignore it). Non-IG URLs pass through untouched.
        src={proxiedUrl(url)}
        alt={embed?.caption?.slice(0, 80) || 'Live post media'}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
        }}
        loading="lazy"
        onError={(e) => {
          // IG CDN URLs expire after ~24h. If the image fails to load,
          // show a soft fallback so the card doesn't render a broken
          // image icon. The metrics row still shows correct counts; the
          // next refresh will update the URL.
          e.currentTarget.style.display = 'none';
          const parent = e.currentTarget.parentElement;
          if (parent) {
            parent.style.background = 'var(--surface-2, #1a1a1a)';
            parent.dataset.fallback = '1';
          }
        }}
      />
      {mediaType === 'video' && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.55)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 18,
            }}
          >
            ▶
          </div>
        </div>
      )}
      {mediaType === 'carousel' && Array.isArray(embed?.mediaUrls) && embed.mediaUrls.length > 1 && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.55)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          ◧ {embed.mediaUrls.length}
        </div>
      )}
    </a>
  );
};

const LivePostEmbed = ({ embed, platform, liveUrl }) => {
  if (!embed) return null;

  const handle = embed.authorHandle ? `@${embed.authorHandle}` : (embed.authorDisplayName || '');
  const postedAgo = formatRelative(embed.postedAt);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--surface-1, var(--surface))',
      }}
    >
      {/* Author row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Avatar url={embed.authorAvatarUrl} name={embed.authorDisplayName || embed.authorHandle} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--ink-1)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {handle || 'Unknown author'}
          </span>
          {postedAgo && (
            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{postedAgo}</span>
          )}
        </div>
        <PlatformChip platform={platform} size="sm" />
      </div>

      {/* Media */}
      <MediaBlock embed={embed} liveUrl={liveUrl} />

      {/* Caption */}
      {embed.caption && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: 1.45,
            color: 'var(--ink-2)',
            whiteSpace: 'pre-wrap',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
          title={embed.caption}
        >
          {truncate(embed.caption, 320)}
        </p>
      )}
    </div>
  );
};

export { LivePostEmbed };
