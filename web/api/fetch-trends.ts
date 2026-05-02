// Minimal handler — temporarily simplified to isolate why -3kkp's build
// was failing on this branch. Once the deploy goes through cleanly, we
// restore the full TikTok Creative Center scraper that was here on commit
// 842ba9f5.
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  return res.status(200).json({
    ok: true,
    note: "fetch-trends placeholder — full handler will be restored once deploy is green",
    method: req.method,
  });
}
