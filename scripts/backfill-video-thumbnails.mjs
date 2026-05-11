#!/usr/bin/env node
/**
 * Backfill video thumbnail sidecars for pre-2026-05-11 uploads.
 *
 * The dashboard's client-side video-thumbnail extractor (web/src/lib/
 * videoThumbnail.js) only kicks in for NEW uploads. Anything uploaded
 * before that PR shipped has no `<storage_path>.thumb.jpg` sidecar, so
 * the gallery falls back to a clean play-icon tile (looks intentional
 * but not as informative as a real frame). This one-shot script walks
 * the two video-carrying buckets, finds the missing sidecars, extracts
 * a frame with bundled ffmpeg, and uploads the JPEG.
 *
 * Usage:
 *   SUPABASE_URL=https://YOUR-REF.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=sb_secret_... \
 *   npm run backfill:video-thumbnails
 *
 * Optional flags (via env):
 *   DRY_RUN=1            Only report what would be uploaded.
 *   ONLY_BUCKET=brand-assets|post-plan-attachments   Skip the other bucket.
 *   LIMIT=10             Stop after N successful uploads (for testing).
 *
 * Idempotent — re-running is safe. Files that already have a sidecar are
 * skipped. Files that fail extraction or upload are logged with the
 * reason but don't abort the run.
 *
 * ffmpeg ships as a vendored binary via @ffmpeg-installer/ffmpeg — no
 * system install required.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ["1", "true", "yes"].includes(String(process.env.DRY_RUN ?? "").toLowerCase());
const ONLY_BUCKET = process.env.ONLY_BUCKET || "";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

const BUCKETS = [
  { name: "post-plan-attachments", description: "post-plan finals + references + idea attachments" },
  { name: "brand-assets", description: "brand-kit reference library" },
];

const THUMB_SUFFIX = ".thumb.jpg";
const SEEK_SECONDS = 1.0;
const MAX_LONGEST_SIDE = 640;
const JPEG_QUALITY = 4; // ffmpeg JPEG quality 2 (best) – 31 (worst). 4 ≈ q≈0.82.
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv", ".ogg", ".ogv"]);

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    "Missing env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.",
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ---- helpers ------------------------------------------------------------

function isVideoObject(obj) {
  const mime = String(obj?.metadata?.mimetype || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  // Fall back to extension — pre-2025 uploads sometimes have empty mime.
  const name = String(obj?.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return VIDEO_EXTENSIONS.has(name.slice(dot));
}

function isSidecarName(name) {
  return String(name).toLowerCase().endsWith(THUMB_SUFFIX);
}

// Recursively list every file (not folder) under `prefix` in `bucket`.
// Storage list() returns one level at a time; entries with non-null `id`
// are files, entries with null `id` are folders. We walk depth-first
// with a 200-page size which matches the dashboard's existing list calls.
async function listAllFiles(bucket, prefix = "") {
  const out = [];
  const queue = [prefix];
  while (queue.length) {
    const p = queue.shift();
    let offset = 0;
    const pageSize = 200;
    while (true) {
      const { data, error } = await sb.storage
        .from(bucket)
        .list(p, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`list(${bucket}, "${p}") failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const item of data) {
        if (!item?.name) continue;
        const fullPath = p ? `${p}/${item.name}` : item.name;
        if (item.id) {
          // File.
          out.push({ path: fullPath, name: item.name, metadata: item.metadata, createdAt: item.created_at });
        } else {
          // Folder. (Supabase storage uses null id for folders.)
          queue.push(fullPath);
        }
      }
      if (data.length < pageSize) break;
      offset += pageSize;
    }
  }
  return out;
}

// Run ffmpeg via the vendored binary. Returns Promise<{stdout, stderr}>
// resolved on exit code 0, rejected with the stderr on non-zero.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegInstaller.path, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`));
    });
  });
}

async function extractThumbnailWithFfmpeg(videoBuffer, srcExt) {
  const dir = await mkdtemp(join(tmpdir(), "lr-thumb-"));
  const inPath = join(dir, `in${srcExt || ".mp4"}`);
  const outPath = join(dir, "out.jpg");
  try {
    await writeFile(inPath, videoBuffer);
    // -ss before -i = fast seek to keyframe near 1s (way faster than -ss after -i for trims this short).
    // -frames:v 1 = single frame. scale filter caps longest side at MAX_LONGEST_SIDE while preserving aspect.
    // force_original_aspect_ratio=decrease keeps both dimensions within the cap.
    await runFfmpeg([
      "-y", "-loglevel", "error",
      "-ss", String(SEEK_SECONDS),
      "-i", inPath,
      "-frames:v", "1",
      "-vf", `scale='min(${MAX_LONGEST_SIDE},iw)':-2`,
      "-q:v", String(JPEG_QUALITY),
      outPath,
    ]).catch(async (firstErr) => {
      // Some short videos die at -ss=1 because there's no keyframe past
      // the start. Retry seeking to 0.1s before bailing.
      await runFfmpeg([
        "-y", "-loglevel", "error",
        "-ss", "0.1",
        "-i", inPath,
        "-frames:v", "1",
        "-vf", `scale='min(${MAX_LONGEST_SIDE},iw)':-2`,
        "-q:v", String(JPEG_QUALITY),
        outPath,
      ]).catch(() => { throw firstErr; });
    });
    const jpeg = await readFile(outPath);
    return jpeg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extOf(name) {
  const i = String(name).toLowerCase().lastIndexOf(".");
  return i === -1 ? "" : name.slice(i);
}

// ---- main ---------------------------------------------------------------

async function processBucket(bucket) {
  console.log(`\n── bucket: ${bucket.name} (${bucket.description})`);
  const allFiles = await listAllFiles(bucket.name);
  const sidecars = new Set(
    allFiles.filter((f) => isSidecarName(f.name)).map((f) => f.path),
  );
  const videos = allFiles.filter((f) => !isSidecarName(f.name) && isVideoObject(f));
  console.log(`  found ${allFiles.length} objects total · ${videos.length} videos · ${sidecars.size} existing sidecars`);

  let processed = 0;
  let skipped = 0;
  let succeeded = 0;
  let failed = 0;

  for (const v of videos) {
    if (processed + succeeded - skipped >= LIMIT) {
      console.log(`  hit LIMIT=${LIMIT} — stopping early`);
      break;
    }
    const sidecarPath = `${v.path}${THUMB_SUFFIX}`;
    if (sidecars.has(sidecarPath)) {
      skipped++;
      continue;
    }
    processed++;
    const tag = `[${bucket.name}] ${v.path}`;
    if (DRY_RUN) {
      console.log(`  dry-run · would extract → ${sidecarPath}`);
      succeeded++;
      continue;
    }
    try {
      const { data: dl, error: dlErr } = await sb.storage.from(bucket.name).download(v.path);
      if (dlErr) throw new Error(`download: ${dlErr.message}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const jpeg = await extractThumbnailWithFfmpeg(buf, extOf(v.name));
      const { error: upErr } = await sb.storage.from(bucket.name).upload(sidecarPath, jpeg, {
        cacheControl: "3600",
        upsert: true,
        contentType: "image/jpeg",
      });
      if (upErr) throw new Error(`upload: ${upErr.message}`);
      succeeded++;
      console.log(`  ✓ ${tag} (${jpeg.length.toLocaleString()} bytes)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${tag} — ${e?.message || e}`);
    }
  }

  console.log(`  done · attempted ${processed} · ok ${succeeded} · failed ${failed} · skipped (already had sidecar) ${skipped}`);
  return { attempted: processed, succeeded, failed, skipped };
}

async function main() {
  console.log(`Backfilling video thumbnails${DRY_RUN ? " (DRY RUN — no uploads)" : ""}`);
  console.log(`  ffmpeg: ${ffmpegInstaller.path} (v${ffmpegInstaller.version})`);
  console.log(`  supabase: ${SUPABASE_URL}`);
  if (ONLY_BUCKET) console.log(`  only bucket: ${ONLY_BUCKET}`);

  const targets = ONLY_BUCKET
    ? BUCKETS.filter((b) => b.name === ONLY_BUCKET)
    : BUCKETS;
  if (targets.length === 0) {
    console.error(`Unknown ONLY_BUCKET=${ONLY_BUCKET}. Valid: ${BUCKETS.map((b) => b.name).join(", ")}`);
    process.exit(1);
  }

  const summary = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  for (const bucket of targets) {
    const r = await processBucket(bucket);
    summary.attempted += r.attempted;
    summary.succeeded += r.succeeded;
    summary.failed += r.failed;
    summary.skipped += r.skipped;
  }

  console.log(`\nAll done. Total: attempted ${summary.attempted} · ok ${summary.succeeded} · failed ${summary.failed} · skipped ${summary.skipped}`);
  if (summary.failed > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("Fatal:", e?.stack || e?.message || e);
  process.exit(1);
});
