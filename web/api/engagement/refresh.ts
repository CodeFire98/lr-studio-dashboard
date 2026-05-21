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
// Auth model (revised 2026-05-21):
//   - Agency users (profiles.is_agency = true) can call this freely —
//     the agency "Refresh now" button uses this for on-demand
//     re-scrapes.
//   - Brand users can also call this, but only for publications in a
//     brand they're a member of, AND only when no successful
//     snapshot already exists for that publication. This lets the
//     mark-posted auto-refresh fire the FIRST scrape so the Live Posts
//     tile populates immediately on a brand-user-driven post — without
//     opening a brand-user spam vector for repeated Apify-cost spend.
//     Subsequent updates come from the daily pg_cron at 06:00 IST.
// =====================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  dispatchScrape,
  persistScrapeResult,
  type Platform,
} from "./scraper-lib.js";
import { logServiceUsage, estimateApifyCostUsd } from "../_shared/usage.js";

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
  // Joined from post_plans so we can attribute the scrape's cost
  // to the right brand in `service_usage_log`. PostgREST returns
  // either an object or an array depending on FK generics; we handle
  // both shapes below.
  post_plans?: { account_id: string | null } | { account_id: string | null }[] | null;
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

  // -------- AUTH: JWT → user → load profile + publication

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
  const isAgency = !!profile?.is_agency;

  // -------- LOAD the publication row

  const { data: pub, error: pubErr } = await serviceClient
    .from("post_plan_publications")
    .select("id, post_plan_id, platform, live_url, post_plans(account_id)")
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

  const planAccount = Array.isArray(pub.post_plans) ? pub.post_plans[0] : pub.post_plans;
  const brandAccountId = planAccount?.account_id ?? null;

  // -------- BRAND-USER guardrails
  //
  // Agency callers skip both checks below and scrape on demand. Brand
  // callers must:
  //   1. Be a member of the publication's brand account.
  //   2. Not have a usable snapshot for this publication yet (the
  //      "one-shot first scrape" rule — see auth-model comment at the
  //      top of this file). `ok` / `partial` count as usable; `failed`
  //      / `blocked` don't, so a brand user can retry after the FIRST
  //      scrape errored out (e.g. Apify quota was out for a moment).

  if (!isAgency) {
    if (!brandAccountId) {
      return res.status(404).json({ error: "Publication is missing brand context." });
    }
    const { data: membership } = await serviceClient
      .from("account_members")
      .select("user_id")
      .eq("account_id", brandAccountId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return res.status(403).json({
        error: "Not a member of this publication's brand.",
      });
    }
    const { data: existing } = await serviceClient
      .from("post_engagement_snapshots")
      .select("id")
      .eq("publication_id", pub.id)
      .in("scrape_status", ["ok", "partial"])
      .limit(1)
      .maybeSingle();
    if (existing) {
      // Already have a usable snapshot — let the daily pg_cron handle
      // updates from here. Return 200 so the client's "refreshing…"
      // state resolves cleanly (no error toast).
      return res.status(200).json({
        ok: true,
        publication_id: pub.id,
        skipped: "already_scraped",
      });
    }
  }

  // -------- PLATFORM dispatch
  //
  // IG / LinkedIn / X all go through `dispatchScrape` in `_shared.ts`.
  // The 501 branch below stays as a safety net for any future platform
  // we add to `post_plan_publications.platform` without wiring a
  // scraper — the route returns a stable error instead of crashing.
  // (X was re-enabled 2026-05-14 via scrape.badger; the original
  //  "X has no viable actor" 501 path is gone.)

  const scrapeStartedAt = Date.now();
  const result = await dispatchScrape(pub.platform, pub.live_url);
  if (!result) {
    return res.status(501).json({
      error: `Engagement refresh is not supported for ${pub.platform}.`,
      platform: pub.platform,
    });
  }

  // Log the Apify call to service_usage_log. Fire-and-forget — the
  // helper swallows errors, the route can't be blocked by telemetry.
  // `partial` is collapsed to `ok` for the log enum (we still got
  // metrics, just not 100% of fields).
  const apifyStatus =
    result.status === "blocked" ? "blocked"
    : result.status === "failed" ? "failed"
    : "ok";
  void logServiceUsage({
    service: "apify",
    route: "/api/engagement/refresh",
    accountId: brandAccountId,
    userId: user.id,
    costUsd: estimateApifyCostUsd(result.actorId, 1),
    latencyMs: Date.now() - scrapeStartedAt,
    status: apifyStatus,
    error: result.errorMessage ?? null,
    meta: {
      actor_id: result.actorId,
      actor_run_id: result.actorRunId,
      platform: pub.platform,
      scrape_status: result.status,
      publication_id: pub.id,
    },
  });

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
