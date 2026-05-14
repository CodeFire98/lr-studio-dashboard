// =====================================================================
// /api/engagement/refresh — Vercel serverless function (on-demand path)
//
// Scrapes live engagement metrics + post content for a SINGLE
// `post_plan_publications` row and writes the results to
// `post_engagement_snapshots` + `post_embed_cache`.
//
// PR 2 added the IG path. PR 6 added LinkedIn. X is skipped (no viable
// Apify actor as of 2026-05-12 — see §13). PR 7 extracted the scraper
// + persistence logic into `_shared.ts` so the new cron route can
// reuse it; this file is now just auth + dispatch + write.
//
// Auth: JWT → `profiles.is_agency = true`. Brand users 403 — they can
// still see metrics via SELECT RLS but can't trigger Apify scrapes.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  dispatchScrape,
  persistScrapeResult,
  type Platform,
} from "./scraper-lib.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const ANON_KEY     = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

type RequestBody = {
  publicationId?: string;
};

type PublicationRow = {
  id: string;
  post_plan_id: string;
  platform: Platform;
  live_url: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) {
    return res.status(500).json({ error: "Supabase env not fully configured." });
  }
  if (!APIFY_API_TOKEN) {
    return res.status(500).json({
      error: "APIFY_API_TOKEN not configured. Add it under Vercel Project Settings → Environment Variables.",
    });
  }

  let body: RequestBody;
  if (typeof req.body === "string") {
    try { body = JSON.parse(req.body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  } else {
    body = (req.body ?? {}) as RequestBody;
  }
  const publicationId = body?.publicationId?.trim();
  if (!publicationId) {
    return res.status(400).json({ error: "publicationId is required" });
  }

  // -------- AUTH: JWT → is_agency → 403 if brand

  const authHeader =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["Authorization"] as string | undefined) ??
    "";
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const userClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("is_agency")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_agency) {
    return res.status(403).json({ error: "Engagement refresh is agency-only for now." });
  }

  // -------- LOAD the publication row

  const { data: pub, error: pubErr } = await serviceClient
    .from("post_plan_publications")
    .select("id, post_plan_id, platform, live_url")
    .eq("id", publicationId)
    .maybeSingle<PublicationRow>();
  if (pubErr || !pub) {
    return res.status(404).json({ error: "Publication not found" });
  }
  if (!pub.live_url) {
    return res.status(400).json({
      error: "Publication has no live_url — paste the live post URL on the plan first.",
    });
  }

  // -------- PLATFORM dispatch
  //
  // IG / LinkedIn / X all go through `dispatchScrape` in `_shared.ts`.
  // The 501 branch below stays as a safety net for any future platform
  // we add to `post_plan_publications.platform` without wiring a
  // scraper — the route returns a stable error instead of crashing.
  // (X was re-enabled 2026-05-14 via scrape.badger; the original
  //  "X has no viable actor" 501 path is gone.)

  const result = await dispatchScrape(pub.platform, pub.live_url);
  if (!result) {
    return res.status(501).json({
      error: `Engagement refresh is not supported for ${pub.platform}.`,
      platform: pub.platform,
    });
  }

  // -------- WRITE the snapshot + upsert the embed cache

  let persisted;
  try {
    persisted = await persistScrapeResult(serviceClient, pub.id, result);
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
      scrape_status: result.status,
      scrape_error: result.errorMessage,
    });
  }

  return res.status(200).json({
    ok: result.ok,
    publication_id: pub.id,
    snapshot: persisted.snapshot,
    embed: persisted.embed,
    scrape_status: result.status,
    scrape_error: result.errorMessage,
  });
}
