/* Client-side video → JPEG thumbnail extractor.

   Browsers don't render a poster frame for `<img>`-wrapped videos, so a
   video attachment shown in a thumbnail grid would otherwise be a generic
   "play" icon with no visual context. We pull one frame out of the file
   right before upload and store it as a sidecar object alongside the
   video — `<storage_path>.thumb.jpg`. The mapper layer (`db.js`) then
   surfaces a `thumbnailUrl` on every video attachment so the UI tiles
   look the same as images.

   Trade-offs:
   - Uses the browser's own decoder. Whatever the user's browser can
     play, we can thumbnail; anything else falls back to no thumbnail
     (which keeps the upload working — non-fatal).
   - Captures a frame ~1 second in. First frame is often black/letterbox
     on real recordings; one second lands inside the action for most
     content.
   - Cap longest side at 640px. Bigger thumbnails just waste bandwidth
     for a grid tile.
   - Returns null silently on any failure (CORS, codec, hung load).
     Caller treats a missing thumbnail as "fine, render the video icon
     fallback" rather than failing the upload. */

const THUMBNAIL_MAX_SIDE = 640;
const THUMBNAIL_QUALITY = 0.82;
const THUMBNAIL_SEEK_SECONDS = 1.0;
const THUMBNAIL_TIMEOUT_MS = 15000;

export function isVideoFile(file) {
  return !!file && typeof file === 'object' && String(file.type || '').toLowerCase().startsWith('video/');
}

// Extract a JPEG thumbnail from a video File. Resolves with a Blob on
// success or null on any failure (so the caller can just `await` and
// upload-if-present without try/catch around every call site).
export async function extractVideoThumbnail(file) {
  if (!isVideoFile(file)) return null;

  return new Promise((resolve) => {
    let url = '';
    let video = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { if (url) URL.revokeObjectURL(url); } catch { /* ignore */ }
      if (video) {
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        video.src = '';
        try { video.remove(); } catch { /* ignore */ }
      }
      resolve(result);
    };

    const timeoutId = setTimeout(() => done(null), THUMBNAIL_TIMEOUT_MS);
    const finishWith = (result) => { clearTimeout(timeoutId); done(result); };

    try {
      url = URL.createObjectURL(file);
    } catch {
      return finishWith(null);
    }

    video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // Offscreen so it doesn't paint into the DOM. Keep it attached so
    // some browsers (older Safari) actually decode the frame on seek.
    video.style.position = 'fixed';
    video.style.left = '-10000px';
    video.style.top = '-10000px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    video.onerror = () => finishWith(null);
    video.onloadedmetadata = () => {
      // Seek to ~1s, or 25% in for very short clips. duration may be
      // Infinity for live streams or unsupported containers — bail.
      const d = Number(video.duration);
      if (!Number.isFinite(d) || d <= 0) return finishWith(null);
      const seek = Math.min(THUMBNAIL_SEEK_SECONDS, Math.max(0.05, d * 0.25));
      try {
        video.currentTime = seek;
      } catch {
        return finishWith(null);
      }
    };

    video.onseeked = () => {
      try {
        const vw = video.videoWidth | 0;
        const vh = video.videoHeight | 0;
        if (!vw || !vh) return finishWith(null);
        const longest = Math.max(vw, vh);
        const scale = longest > THUMBNAIL_MAX_SIDE ? THUMBNAIL_MAX_SIDE / longest : 1;
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return finishWith(null);
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob((blob) => finishWith(blob || null), 'image/jpeg', THUMBNAIL_QUALITY);
      } catch {
        finishWith(null);
      }
    };

    video.src = url;
    // Some browsers need an explicit load() after src assignment.
    try { video.load(); } catch { /* ignore */ }
  });
}

// Helper: turn the extracted Blob into a File so it can flow through the
// same Supabase upload code path. Returns null if no blob.
export function thumbnailBlobToFile(blob, originalFilename = 'thumb') {
  if (!blob) return null;
  const baseName = String(originalFilename || 'thumb').replace(/\.[^.]+$/, '');
  return new File([blob], `${baseName}.thumb.jpg`, { type: 'image/jpeg' });
}
