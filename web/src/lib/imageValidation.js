/* Image dimension validation — gate uploads that browsers can't render.
   Browsers cap rendered images at ~16k pixels in any dimension and at
   ~256MP total (Chrome) / 64MP (Safari). Beyond that the decode fails
   silently and `<img>` falls back to broken-image rendering. We've seen
   real uploads at 32768×21846 (~716MP) — a 3.7MB PNG that decodes to
   ~3GB of RGBA pixel data, which no browser will allocate.

   The conservative limits below pass everything we'd realistically want
   to display (large social-post deliverables typically max around
   4096×4096 / 16MP) while rejecting the pathological cases that look
   broken to every viewer regardless of their hardware.

   We use the browser's own Image() decoder for validation rather than
   parsing PNG/JPEG headers manually — it's accurate, handles every
   format the browser can display, and surfaces "this format isn't
   supported either" cases naturally. Trade-off: needs an
   `URL.createObjectURL` round-trip, but that's negligible vs. the
   network upload it precedes. */

// 8192px in any dimension is comfortable for every modern browser.
// 33MP total guards against absurd aspect ratios that fit under 8192
// individually but blow memory on decode (e.g. 8000×6000 = 48MP).
export const IMAGE_MAX_DIMENSION = 8192;
export const IMAGE_MAX_PIXELS = 33 * 1024 * 1024;

// Friendly versions of the limits for use in error messages.
const MAX_DIM_LABEL = `${IMAGE_MAX_DIMENSION.toLocaleString()}px`;
const MAX_MP_LABEL = `${Math.floor(IMAGE_MAX_PIXELS / 1_000_000)} megapixels`;

// Validate an image File. Resolves with `{width, height}` for valid
// images, throws a friendly Error otherwise. Non-image files pass
// through unchecked — they're handled by other code paths (PDFs etc.
// don't have this rendering problem).
export async function validateImageDimensions(file) {
  if (!file || typeof file !== 'object') return null;
  const mime = String(file.type || '').toLowerCase();
  if (!mime.startsWith('image/')) return null;
  // SVGs don't have a "decoded pixel" cost in the way raster formats do,
  // and naturalWidth/Height aren't meaningful. Skip the check.
  if (mime === 'image/svg+xml') return null;

  return new Promise((resolve, reject) => {
    let url = '';
    let img = null;
    const cleanup = () => {
      try { if (url) URL.revokeObjectURL(url); } catch { /* ignore */ }
      if (img) { img.onload = null; img.onerror = null; }
    };
    try {
      url = URL.createObjectURL(file);
    } catch (e) {
      return reject(new Error(`Could not read ${file.name || 'image'}: ${e?.message || e}`));
    }
    img = new Image();
    img.onload = () => {
      const w = img.naturalWidth | 0;
      const h = img.naturalHeight | 0;
      cleanup();
      if (!w || !h) {
        return reject(new Error(
          `${file.name || 'Image'} couldn't be read (no dimensions). It may be corrupted — try re-exporting and uploading again.`
        ));
      }
      if (w > IMAGE_MAX_DIMENSION || h > IMAGE_MAX_DIMENSION) {
        return reject(new Error(
          `${file.name || 'Image'} is ${w.toLocaleString()}×${h.toLocaleString()}px — too large to display in browsers (max ${MAX_DIM_LABEL} on any side). Resize it first and re-upload.`
        ));
      }
      if (w * h > IMAGE_MAX_PIXELS) {
        return reject(new Error(
          `${file.name || 'Image'} is ${w.toLocaleString()}×${h.toLocaleString()}px (${(w * h / 1_000_000).toFixed(1)} MP) — too many pixels for browsers to render reliably (max ${MAX_MP_LABEL}). Resize and re-upload.`
        ));
      }
      resolve({ width: w, height: h });
    };
    img.onerror = () => {
      cleanup();
      // The browser couldn't decode the image at all. Most common cause
      // is that the file is bigger than the browser will load (so our
      // explicit dimension check above never gets to run). Same advice.
      reject(new Error(
        `${file.name || 'Image'} couldn't be decoded — likely too large for browsers to render (max ${MAX_DIM_LABEL} on any side, ${MAX_MP_LABEL} total). Resize and re-upload.`
      ));
    };
    img.src = url;
  });
}

// Convenience helper for the upload paths: validate every image in a
// list of files. Throws on the FIRST oversize image so the user gets a
// specific filename in the error rather than a generic "some image was
// too big" — most upload UIs let the user pick multiple files at once.
export async function validateImagesInList(files) {
  for (const f of files || []) {
    await validateImageDimensions(f);
  }
}
