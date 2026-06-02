// =====================================================================
// imageDownscale — client-side image shrink for AI vision attachments
// =====================================================================
//
// Why: image attachments are sent to our Vercel AI routes as base64 data
// URLs INSIDE the JSON request body. A single 5 MB phone photo becomes
// ~6.7 MB of base64; two of them blow past Vercel's ~4.5 MB serverless
// request-body limit and the request is rejected with a 413 at the edge
// BEFORE the function runs — which surfaces to the user as a chat bubble
// that says "thinking…" then silently vanishes (no function log, the AI
// SDK rolls back the streamed message on the failed fetch).
//
// Claude's vision pipeline downsamples images to ~1568px on the long edge
// anyway, so shrinking to that bound loses no useful detail while taking
// each image from multiple MB down to ~150-400 KB. That keeps even four
// attachments + the message history comfortably under the body limit.
//
// Used by the LinkAI chat composer (LinkAIPanel) and the post-plan image
// prompt panel (AIImagePromptPanel) so both share one implementation.

const DEFAULT_MAX_EDGE = 1568; // Claude vision's long-edge downsample bound
const DEFAULT_QUALITY = 0.85;

// Downscale + re-encode an image File/Blob to a compact JPEG data URL.
// Resolves to a `data:image/jpeg;base64,…` string. Rejects if the file
// can't be decoded or the canvas API is unavailable.
//
// Notes:
//   - Output is always JPEG, so callers must send mediaType 'image/jpeg'.
//   - Transparent PNGs are flattened onto a white matte (JPEG has no
//     alpha) so they don't render as black.
//   - Animated GIFs collapse to their first frame — fine for a reference
//     still; we're feeding Claude a description target, not playback.
export function downscaleImageToDataUrl(file, { maxEdge = DEFAULT_MAX_EDGE, quality = DEFAULT_QUALITY } = {}) {
  return new Promise((resolve, reject) => {
    let objectUrl;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('Could not read image.'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const w0 = img.naturalWidth || img.width || 1;
      const h0 = img.naturalHeight || img.height || 1;
      const scale = Math.min(1, maxEdge / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas is not supported in this browser.'));
        return;
      }
      // White matte so transparent PNGs don't flatten to black on JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Could not encode image.'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Could not read "${file?.name || 'image'}".`));
    };
    img.src = objectUrl;
  });
}
