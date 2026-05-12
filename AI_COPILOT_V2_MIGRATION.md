# AI Co-pilot v2 migration — tracking doc

> Single source of truth for the AI Co-pilot rebuild on **Vercel AI SDK + AI Elements**.
> Last updated: 2026-05-12 (Phase 2c)
> Owner: Lakshith Dinesh (decisions) + Claude (implementation)
> Worktree branch: `claude/eloquent-austin-f6dbf7`
> Production Vercel project: `lr-studio-dashboard-3kkp` (agency.linkrunner.io)

## Recent changes log

- **2026-05-12** (Phase 3 — suggestion chips, streaming + Haiku): second iteration of the chips. User feedback on the generateObject + Sonnet version: "refresh is taking too long, stuck in this state". Pivoted to **streamObject + claude-haiku-4-5** so chips render PROGRESSIVELY (each chip appears as soon as its title resolves in the partial JSON) and the model itself is ~2× faster. Client switched from fetch+JSON to `experimental_useObject` (same hook the image-ideas panel uses). Refresh button stays. Cost drops to ~$0.001-0.003 per cached refresh (Haiku is cheaper than Sonnet too).
- **2026-05-12** (Phase 3 — suggestion chips, AI-backed + Refresh): pivoted from the same-day template-only approach to **AI-generated suggestions** via a new `/api/ai/suggestions` route (`generateObject` + Zod, temperature 0.9). Adds a **Refresh button** on the welcome screen so the admin gets different angles each click. Templated logic retained in `db.js` as a graceful fallback when the AI route errors. Cost: ~$0.005-0.010 first call, ~$0.001-0.003 cached refresh. Cache reuses the existing brand-context pool.
- **2026-05-12** (Phase 2c): `AIImagePromptPanel.jsx` rewritten around `experimental_useObject` (ideas) + `useCompletion` (prompt); `/api/ai/image.ts` switched from manual SSE event translation to `streamObject(...).pipeTextStreamToResponse(res)` + `streamText(...).pipeTextStreamToResponse(res)`. Request body shape change on prompt mode (`details` → `prompt`). Ideas cards now render PROGRESSIVELY as the JSON streams in. Inline usage meter dropped — cache observability logs to `[image] usage …` in Vercel Function Logs (same pattern as `[copy] usage …`).
- **2026-05-12** (cleanup PR): All three AI routes (`chat.ts`, `copy.ts`, `image.ts`) moved their two cached system blocks from `streamText({ messages: [system, system, user, ...] })` into `streamText({ system: [...], messages: [user, ...] })`. Silences the AI SDK's prompt-injection warning ("System messages in the prompt or messages fields can be a security risk"). Behavior unchanged — `system` accepts `Array<SystemModelMessage>` so both cache breakpoints + `providerOptions.anthropic.cacheControl` survive.
- **2026-05-12**: Phase 2b merged ([#70](https://github.com/CodeFire98/lr-studio-dashboard/pull/70)) — `AICopyPreview.jsx` rewritten around `useCompletion`; `/api/ai/copy.ts` switched from manual SSE translator to `pipeTextStreamToResponse`. Request body shape changes (`instruction` → `prompt`). Inline token-usage meter intentionally dropped — useCompletion's text-stream protocol doesn't surface usage; cache observability moves to server logs.
- **2026-05-11**: PoC + Phase 0 + Hotfix + Phase 1a + Phase 1b + Phase 1c + Polish + Phase 2a all merged.

This doc is the runbook for the full migration. Every PR in this effort links back here. When something breaks, **start here, not in the code.**

---

## What we're building

We're replacing the bespoke AI Co-pilot plumbing — manual Anthropic SDK calls, hand-rolled SSE event types, manual `MAX_TURNS=8` agentic loop, lenient JSON parsers, hand-written stream parsers — with two well-maintained libraries:

- **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/react`): server-side `streamText` / `generateText` / `streamObject` primitives, client-side `useChat` / `useObject` / `useCompletion` hooks, automatic tool-use loops, structured output via Zod schemas, native Anthropic prompt-cache support.
- **AI Elements**: shadcn-style copy-paste React components for chat surfaces (Conversation, Message, PromptInput, Tool, Reasoning, Sources, Suggestion, Persona, etc.). Built on Tailwind + shadcn/ui.

**What stays the same**: auth pipeline (JWT → `is_agency` → allowlist), brand-context compiler (`web/src/lib/brandContext.js`), 5-min prompt-cache strategy, `MAX_TURNS=8` semantics, `post_plans` / `brand_kit_notes` schemas, localStorage persistence (until/unless we move to DB in Phase 4), allowlist scope (Bamboo Bear only).

**What changes**: server route bodies, client component implementations, message-shape on the wire (custom SSE events → AI SDK's data-stream protocol with `UIMessage.parts`).

---

## Rollout scope

**Bamboo Bear ONLY through every phase.** Same `AI_COPILOT_BRAND_IDS` / `VITE_AI_COPILOT_BRAND_IDS` env-var allowlist as today. No other brands are touched.

To open up to more brands later (post-migration, after observing prod for ~1 week with no regressions):
1. Decision made by Lakshith.
2. Add brand UUIDs to both env vars in Vercel Project Settings → Environment Variables.
3. Redeploy (or wait for the next deploy — env-var changes don't auto-redeploy).
4. No code change required.

---

## Shipping model

- Every phase = its own PR to its own branch off `main`.
- Every PR gets a Vercel preview deploy.
- Manual QA on the preview before merging.
- `main` auto-deploys to prod on merge.
- **Even when merged to prod, only Bamboo Bear sees changes** because of the allowlist — blast radius stays tiny.
- Direct push to `main` is forbidden (project rule — see memory: "Always PR, never direct push to main").

---

## Manual setup required

**Nothing required upfront.** All needed env vars already exist on the Vercel project:

| Env var | Status | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ set | AI SDK Anthropic provider reads from this exact name. No change. |
| `AI_COPILOT_BRAND_IDS` | ✅ set | Server-side allowlist, unchanged. |
| `VITE_AI_COPILOT_BRAND_IDS` | ✅ set | Client-side allowlist mirror, unchanged. |
| `SUPABASE_URL` | ✅ set | Unchanged. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ set | Unchanged. |
| `SUPABASE_ANON_KEY` | ✅ set | Unchanged. |

**No new API keys, no new secrets, no Supabase migration** for Phases 0–3.

Optional manual touchpoint **only if we get to Phase 4 (DB-backed conversation persistence)**: one Supabase migration to add a `copilot_conversations` table. User runs it via the Supabase dashboard. Opt-in, not part of the core migration.

---

## Phases & status

Mark a phase complete only when its PR is merged AND the Vercel preview has been smoke-tested against Bamboo Bear.

| # | Phase | Status | PR |
|---|---|---|---|
| PoC | Cache verification PoC — confirmed `providerOptions.anthropic.cacheControl` produces the same Anthropic cache hits as the raw SDK. ~99.6% cache-hit rate on call 2 (3515 / 3529 input tokens). | ✅ merged | [#60](https://github.com/CodeFire98/lr-studio-dashboard/pull/60) |
| 0 | Foundation — Tailwind v3.4 + shadcn primitives + AI SDK deps. Content scoped to `ai-elements/`, preflight disabled. JS byte-identical, CSS +3.7 KB raw. | ✅ merged | [#61](https://github.com/CodeFire98/lr-studio-dashboard/pull/61) |
| HOTFIX | Scope shadcn `--accent` (and other tokens) under `.ai-elements` instead of `:root` — was clobbering app.css's coral `--accent: #E8553D` in prod. Moved rules OUTSIDE `@layer base` so Tailwind content-purging can't drop them. | ✅ merged | [#63](https://github.com/CodeFire98/lr-studio-dashboard/pull/63) |
| 1a | Server: `/api/ai/chat` → `streamText` + AI SDK `tool({ inputSchema (Zod), execute })` + `stopWhen: stepCountIs(8)`. Wire protocol preserved (legacy SSE event names). 464 → 391 LoC. Smoke-tested on Bamboo Bear. | ✅ merged | [#62](https://github.com/CodeFire98/lr-studio-dashboard/pull/62) |
| 1b | Server: `/api/ai/copy` → `streamText` (no tools). Wire protocol preserved. 292 → 277 LoC. | ✅ merged | [#64](https://github.com/CodeFire98/lr-studio-dashboard/pull/64) |
| 1c | Server: `/api/ai/image` → `streamObject` (ideas mode, Zod schema replaces lenient JSON parser) + `streamText` (prompt mode). Also DELETES `web/api/ai/cache-poc.ts` (PoC retired). | ✅ merged | [#65](https://github.com/CodeFire98/lr-studio-dashboard/pull/65) |
| Polish | Cross-platform context inside a post plan: platform requirements at top of user message ("MUST FOLLOW STRICTLY"); `/api/ai/copy` includes OTHER platforms' copy; `/api/ai/image` includes ALL platforms' copy. Pre-existing issues surfaced during smoke testing — not v2 regressions. | ✅ merged | [#66](https://github.com/CodeFire98/lr-studio-dashboard/pull/66) |
| 2a | Client: `CopilotPanel.jsx` → `useChat` + AI Elements `MessageResponse` (Streamdown markdown). Wire protocol switched to AI SDK UIMessage stream (`/api/ai/chat` now uses `pipeUIMessageStreamToResponse`). Panel lazy-loaded via `React.lazy()` so heavy markdown deps don't ship in eager bundle. Conversation/Message components from AI Elements intentionally dropped — scroll-overflow conflict + shadcn-gray bubbles. Custom tool cards retained. Path-alias foundation `@/*` added. **Two smoke-test regressions fixed in-flight**: (a) `--accent` collision — tight-scoped `.ai-elements` to wrap only MessageResponse, not the whole scroll surface; (b) Streamdown table fullscreen modal broken in panel layout — disabled via `controls.table.fullscreen: false`. | ✅ merged | [#68](https://github.com/CodeFire98/lr-studio-dashboard/pull/68) |
| 2b | Client: `AICopyPreview.jsx` → `useCompletion` + AI SDK text-stream protocol. Server `/api/ai/copy` switched from manual `fullStream`-to-SSE translator to `result.pipeTextStreamToResponse(res)`. Request body shape changes (`instruction` → `prompt`). 292 → 260 LoC on the client, ~35 lines of manual stream-translation deleted from the server. Inline usage meter dropped — useCompletion text-protocol doesn't surface metadata; cache hits now logged server-side via `streamText({ onFinish })` and greppable as `[copy] usage …` in Vercel Function Logs. | ✅ merged | [#70](https://github.com/CodeFire98/lr-studio-dashboard/pull/70) |
| 2c | Client: `AIImagePromptPanel.jsx` → `experimental_useObject` (ideas, with Zod schema mirrored from server) + `useCompletion` (prompt, text-stream protocol). Server `/api/ai/image` switched from manual SSE writers (`writeSseEvent` / `emitUsageEvent`) to `streamObject(...).pipeTextStreamToResponse(res)` + `streamText(...).pipeTextStreamToResponse(res)` — text-stream protocol for both modes. Body shape change on prompt mode: `details` → `prompt`. Idea cards now render PROGRESSIVELY as the JSON streams (each card fills in title → description → keywords as the partial JSON resolves). 7-phase explicit state machine + `parseSse` generator + lenient `parseIdeasJson` parser all retired. Cache observability logs to `[image] usage …` in Vercel Function Logs. | ✅ merged | [#72](https://github.com/CodeFire98/lr-studio-dashboard/pull/72) |
| 3 | Net-new (first slice): **dynamic suggestion chips + Refresh button, streaming + Haiku**. New `/api/ai/suggestions` route uses `streamObject` + Zod schema + temperature 0.9 on `claude-haiku-4-5` (~2× faster than Sonnet for this size). CopilotPanel mounts `experimental_useObject` and renders chips PROGRESSIVELY as each one's title resolves in partial JSON. Refresh button re-fires submit(). Templated logic stays in db.js as graceful fallback when the AI hook errors. Reuses the cached brand-context blob — ~$0.001-0.003 per cached refresh on Haiku. Other Phase 3 options (Reasoning surfacing, image attachments, per-message cost) remain as future picks. | 🟡 open | [#74](https://github.com/CodeFire98/lr-studio-dashboard/pull/74) |
| 4 | Optional: DB-backed conversation persistence (Supabase `copilot_conversations` table). Only if a user asks. | 🚫 not scheduled | — |

**Update history**: PoC + Phase 0 + Hotfix + Phase 1a all merged 2026-05-11. Phase 1b through Phase 2c all merged 2026-05-12 (one PR per phase, smoke-tested on Vercel preview before merge). The bespoke `parseSse` async generator is now fully retired across the codebase — every AI client surface uses the AI SDK's native hooks. Track A is **complete**; Phase 3 (net-new feature pick) + Phase 4 (DB persistence) are on-demand from here.

---

## Cost model

**The migration itself is free.** All new dependencies are open source (MIT or similar): `ai`, `@ai-sdk/anthropic`, `@ai-sdk/react`, `zod`, `tailwindcss`, AI Elements components, Rive (for the Persona component).

**Anthropic costs stay flat by default** — same model (`claude-sonnet-4-6`), same `max_tokens`, same caching strategy. The PoC confirms this.

**Three ways costs could drift up (each is opt-in)**:

| Feature | Cost impact | Where it's opt-in |
|---|---|---|
| Extended thinking on chat | +1-5K reasoning tokens per call | `providerOptions.anthropic.thinking = { type: 'adaptive' }` — only added if we explicitly turn it on in Phase 3 |
| Image attachments | ~1500 tokens per ~1MP image | Only triggered when admin actually attaches an image |
| Cache breakage (regression risk) | 4-10× input-token cost | Mitigated by PoC + monitoring `cache_read_input_tokens` in every response |

**Per-brand monthly Anthropic spend at moderate use today**: $3-5. Expected to remain in the same range post-migration unless we deliberately enable thinking / attachments.

---

## Rollback plan, per phase

| Phase | Rollback method | Recovery time |
|---|---|---|
| PoC | Delete `/api/ai/cache-poc.ts` route. Revert package.json deps. | <5 min |
| 0 | Revert PR. Tailwind/shadcn config files are isolated to new directories — removing them doesn't affect existing CSS. | <10 min |
| 1a / 1b / 1c | Revert PR (per-route). Each server route is independent — Phase 1a can revert without touching 1b/1c. Existing client code keeps working against the rolled-back routes since the wire protocol was unchanged in Phase 1. | <10 min |
| 2a / 2b / 2c | Revert PR. Client component swap is per-component; reverting just restores the old `.jsx` file. Server routes (Phase 1) keep working because the AI SDK's stream protocol is consumed by both old and new clients via adapter. | <10 min |
| 3 | Per-feature flag — each Phase 3 feature ships behind its own boolean and can be flipped off without revert. | instant |
| 4 | Revert PR + drop the `copilot_conversations` table via Supabase dashboard. | <15 min |

**Universal escape hatch**: remove the brand UUID from `AI_COPILOT_BRAND_IDS` + `VITE_AI_COPILOT_BRAND_IDS` env vars. The Co-pilot UI hides itself for that brand, server rejects calls. Takes ~30 seconds via Vercel dashboard.

---

## 🚨 "Things that could break later" checklist

**Read this first when something goes sideways.** Each item is a specific failure mode + what to check + how to fix.

### Cost / caching

- [ ] **Cache stops landing** — costs spike 4-10×. Check `cache_read_input_tokens` in `result.providerMetadata.anthropic` on every chat turn. Should be > 0 for every call after the first within a 5-min window for the same brand.
  - Common cause: cache breakpoint placement changed; provider version bump; system prompt mutated mid-call.
  - Fix: confirm `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` is set on both system blocks. Re-run the PoC.
  - **For /api/ai/copy specifically** (Phase 2b+): no client-side meter. Grep Vercel Function Logs for `[copy] usage` — every completion logs `input=… cache_read=… cache_write=… output=…`. If `cache_read=0` repeatedly across consecutive calls to the same brand within 5 min, cache is broken. Same fix path.
- [ ] **Wrong model silently being used** — sudden cost or quality change. Check `result.response.modelId` in the response. Should match `claude-sonnet-4-6`.
  - Common cause: AI SDK alias changed under a provider version bump.
  - Fix: pin provider to exact version in package.json.
- [ ] **Extended thinking accidentally on** — unexpected ~2x cost on chat. Check whether `providerOptions.anthropic.thinking` is set anywhere. Should be `undefined` unless Phase 3 explicitly enabled it.
  - Fix: search code for `thinking` in any route.
- [ ] **`max_tokens` regression** — model returns truncated responses. Check route file's `streamText({ maxOutputTokens: … })`. Should be 1500 for chat, 700 for copy, 1200 (ideas) / 1000 (prompt) for image.

### Streaming protocol

- [ ] **Client renders blank** — stream lands but UI doesn't paint. Check Network tab for `/api/ai/chat` — should see `data:` chunks. Check `useChat({ onError })` console output.
  - Common cause: server returning JSON instead of `result.toUIMessageStreamResponse()`.
  - Fix: confirm route ends with `return result.toUIMessageStreamResponse()` not `res.json(...)`.
- [ ] **Stream hangs / never completes** — `status === 'streaming'` forever. Check server logs for unhandled errors after the last `data:` event.
  - Common cause: tool execute threw outside the SDK's catch; stream never sent finish event.
  - Fix: wrap tool `execute:` in try/catch and return `{ ok: false, error }`.
- [ ] **Abort doesn't cancel** — clicking Stop costs full tokens. Server log shows the call completed despite `stop()`. Confirm `streamText` is given the `abortSignal: req.signal` if the Vercel handler exposes it.
- [ ] **/api/ai/copy returns JSON, not text** (Phase 2b regression). Symptom: `useCompletion({ streamProtocol: 'text' })` errors with "Unexpected token" or completion stays empty. Check Network tab — response Content-Type must be `text/plain; charset=utf-8`, not `application/json`.
  - Common cause: someone replaced `result.pipeTextStreamToResponse(res)` with `res.json(...)` or the legacy SSE writer.
  - Fix: confirm route ends with `result.pipeTextStreamToResponse(res)`. The SDK sets the Content-Type itself; don't `res.setHeader('Content-Type', ...)` before calling it.
- [ ] **/api/ai/copy ignores the admin's instruction** (Phase 2b body-shape regression). Symptom: every draft comes out identical, ignoring what the admin typed. Check the POST body the browser sends — should have `prompt: '<instruction>'` (NOT `instruction: '<instruction>'`).
  - Common cause: client reverted to pre-2b body shape, or server reads `body.instruction` instead of `body.prompt`.
  - Fix: `useCompletion` always sends `prompt` as the primary field; the v1 `instruction` key is gone. Server reads from `body.prompt`.
- [ ] **/api/ai/image ideas cards don't render** (Phase 2c regression). Symptom: streaming dots forever, never transition to picker. Check Network tab — response Content-Type must be `text/plain; charset=utf-8` (NOT `text/event-stream`). Check `ideasHook.object` in React DevTools — should be `{ ideas: [...] }` progressively populating.
  - Common cause: server reverted to SSE event writers (`writeSseEvent`), or `useObject` schema doesn't match what the server emits.
  - Fix: confirm route ends with `result.pipeTextStreamToResponse(res)` and the client `IDEAS_SCHEMA` matches the server's exactly (modulo `.describe()` / `.min()` decorations).
- [ ] **/api/ai/image prompt mode body shape** (Phase 2c regression). Symptom: prompt mode generates ignoring the admin's "additional details" textarea. Check the POST body — should have `prompt: '<details>'` (NOT `details: '<details>'`).
  - Common cause: same as the copy.ts case — server reads the wrong field.
  - Fix: server reads from `body.prompt` on prompt mode; useCompletion always sends `prompt` as primary.
- [ ] **Idea cards click before they're ready** (Phase 2c progressive-rendering edge case). Symptom: clicking a half-streamed card sends an incomplete idea to the prompt phase. The picker should disable click when `!idea.title || !idea.description || ideasHook.isLoading`.
  - Fix: confirm the `<button disabled={...}>` guard is still in place on the idea cards.

### Tool-use loop

- [ ] **Tool loop runs forever or until 20 steps** — model keeps tool-calling. Server logs show >8 steps in one conversation turn.
  - Common cause: `stopWhen` not passed → SDK defaults to `stepCountIs(20)`.
  - Fix: confirm `stopWhen: stepCountIs(8)` in every route that has tools.
- [ ] **Tool result doesn't reach the model** — model says "I'll create that" but no plan appears. Check `result.steps` in `onFinish` — should contain `tool-result` entries paired to each `tool-call`.
  - Common cause: tool `execute` returned `undefined` or threw silently.
  - Fix: every tool must `return` a serializable object (or `{ ok: false, error: '...' }`).
- [ ] **Tool name mismatch** — client renders unknown `parts[].type`. Compare server tool names in `streamText({ tools: { ... } })` keys vs client renderer's switch cases.

### Tailwind / shadcn / Elements

- [ ] **Existing CSS visually regresses** — hand-written `app.css` styles look wrong after deploy. Check Tailwind config — `corePlugins: { preflight: false }` must be set, OR scope Tailwind via `important: '.ai-elements'` selector.
  - Fix: re-scope Tailwind, redeploy. Existing `app.css` selectors must take precedence.
- [ ] **Orange / accent buttons go invisible after a CSS change** — caused by shadcn defining a same-named CSS variable (`--accent`) under `:root`, overriding `app.css`'s `--accent: #E8553D`. Verified failure mode on 2026-05-11 after Phase 0 shipped — Co-pilot pill, "Open plan" button, message bubbles, login submit all went white. Fixed by scoping ALL shadcn tokens under `.ai-elements` (not `:root`) and putting them OUTSIDE `@layer base` so Tailwind's content-scan purging can't drop them when no AI Elements files exist yet.
  - Verification: `grep -oE ':root\{[^}]+\}' dist/assets/index-*.css | grep -oE '\-\-accent: [^;]+'` must return `--accent: #E8553D` (coral). `grep -c "\.ai-elements{" dist/assets/index-*.css` must return `1`.
  - Token-name collisions to watch out for in any future shadcn extension: `--accent` (only one that currently collides — but `--input`, `--border`, `--ring`, `--background`, `--foreground` are all generic-enough names someone could add to `app.css` later, so keep them scoped).
- [ ] **AI Elements components don't render** — blank slots where messages should be. Check `tailwind.config.js` content array — must include `./src/components/ai-elements/**/*.{js,ts,jsx,tsx}`.
  - Fix: add the path, restart dev server.
- [ ] **shadcn CLI fails on Vite** — `npx shadcn@latest init` errors out because of missing Next.js conventions. Walk through with a `--vite` flag if available, OR manually create `components.json`, `lib/utils.ts` (the cn() helper), and copy CSS variables to a new entry.
- [ ] **Dark mode breaks** — colors look off because shadcn ships dark CSS vars. Check whether the existing dashboard has dark mode (it doesn't — confirm with `grep -r 'dark:' web/src/`). If no, remove shadcn's `:root.dark { ... }` block from the entry CSS.

### Message shape / persistence

- [ ] **Old localStorage conversations crash on load** — opening the panel throws. Check whether `lr_copilot_conv_<userId>_<accountId>` is the v1 shape vs new v2 `UIMessage[]` shape.
  - Mitigation built in: Phase 2a uses key `lr_copilot_conv_v2_<userId>_<accountId>`. Old v1 entries are orphaned (admin starts fresh on first load) — fine, no data loss because conversations are ephemeral by design.
  - Fix: confirm v2 key in `CopilotPanel.jsx`.
- [ ] **localStorage quota exceeded** — `setMessages` throws. Check messages array length — should be trimmed to last 60 (current cap).
  - Fix: keep `MAX_PERSISTED_MESSAGES = 60` and the trim logic.
- [ ] **Tool-call card doesn't show "Open plan →"** — message renders text-only after a draft. Check that the client's `parts` renderer maps `tool-result` parts AND looks at `part.toolName === 'create_post_plan_draft'` (lowercase, matches server).

### Auth / allowlist

- [ ] **Co-pilot button vanishes for Bamboo Bear** — UI gate failed. Check `VITE_AI_COPILOT_BRAND_IDS` includes Bamboo Bear's UUID in the current Vercel deploy environment.
  - Fix: re-add the UUID, redeploy.
- [ ] **API returns 403 for whitelisted brand** — server gate disagrees with client. Check `AI_COPILOT_BRAND_IDS` server-side env var matches `VITE_AI_COPILOT_BRAND_IDS` exactly (same UUIDs, same case, same commas).
  - Fix: copy the value across both env vars.
- [ ] **Non-agency user sees Co-pilot** — gating regression. Check `profile.is_agency` lookup in every `/api/ai/*` route.

### Provider / SDK upgrades

- [ ] **`@ai-sdk/anthropic` major bump breaks cache behavior** — costs change unexpectedly. Pin version in package.json. Re-run PoC after any provider upgrade.
- [ ] **`ai` major bump renames `streamText` options** — TypeScript compile breaks. Check release notes; AI SDK has had renames between v5 → v6 (e.g. `maxTokens` → `maxOutputTokens`). 
  - Fix: read changelog, update call sites.
- [ ] **AI Elements component breaks after re-install** — already in repo, no auto-update, so this only happens if someone manually runs `npx ai-elements@latest add <name>` again.
  - Fix: review the diff carefully before merging the re-install.

### Vercel / deploy

- [ ] **API route returns the SPA `index.html` (status 200, HTML body)** — happens when Vercel doesn't register the file as a function and falls through to the `/(.*)` SPA rewrite. Most common cause: **filename starts with `_`**. Vercel treats `api/_*.ts` as private/internal helpers and ignores them as routes. Confirmed during the PoC for this migration — `_cache-poc.ts` returned `<!DOCTYPE html>` on a 200 even though the file existed; renaming to `cache-poc.ts` fixed it. Other possible causes: file isn't `.ts`/`.js`/`.mjs`, default export missing, route under a directory Vercel doesn't scan.
  - Fix: rename to remove the underscore prefix. Confirm with `curl <preview-url>/api/<route>` — should NOT return HTML.
- [ ] **Function timeout** — `/api/ai/chat` takes >10s and Vercel kills it. Free / Hobby tier has 10s default. Pro has 60s. We're on Pro (the `fetch-trends.ts` route already has `maxDuration: 300`).
  - Fix: if a chat route needs more time, add to `vercel.json` functions config: `"api/ai/chat.ts": { "maxDuration": 60 }`.
- [ ] **CORS regression** — local dev hits 403 from `/api/ai/*`. Each route must keep its `Access-Control-Allow-Origin: *` headers.
- [ ] **Vite bundle blows up** — main bundle >2MB. Check whether AI SDK leaked to client (it shouldn't — only `@ai-sdk/react` should be client-side).
  - Fix: confirm `ai` and `@ai-sdk/anthropic` are only imported from `web/api/**/*.ts`, never from `web/src/**`.

### Schema / data

- [ ] **`create_post_plan_draft` insert fails** — admin sees red tool card with "insert failed". Check `post_plans` schema hasn't changed since the tool was written.
  - Common cause: someone added a NOT NULL column without a default.
  - Fix: update the tool's `insertRow` to include the new column.
- [ ] **`write_brand_note` insert fails** — similar to above for `brand_kit_notes` table.
- [ ] **Brand context blob empty** — model gives generic advice instead of brand-aware. Check `loadAndCompileBrandContext` returns >0 chars for the active brand.
  - Common cause: `brand_kits` row missing for the account.

---

## Decisions log

Add a one-line entry every time we make a "we tried X, chose Y" call during the migration.

- **2026-05-11**: Go full path (SDK + Elements) over SDK-only. Reason: AI Elements unlocks ~10 net-new capabilities (Reasoning, attachments, suggestions, etc.) for ~1.5 extra days of work. — Lakshith
- **2026-05-11**: PoC first before Phase 0. Reason: cache survival is the entire cost premise; 20-min verification de-risks the next 5 days. — Lakshith
- **2026-05-11**: Stay on Bamboo Bear allowlist through all phases. Reason: blast radius minimization while changing the stack. — Lakshith
- **2026-05-11**: System prompt stays brand-agnostic; all brand-specific tuning flows through `brand_kit_notes` per brand. Reason: every new brand inherits universal platform best-practices automatically without code changes. Brand specifics accumulate via the memory tool over time. — Lakshith
- **2026-05-12** (Phase 2b): Use `streamProtocol: 'text'` + `pipeTextStreamToResponse` for /api/ai/copy instead of the data-stream protocol. Reason: copy generation is a single-shot text completion with no tools, no reasoning parts, no metadata-driven UI. `useCompletion` data-protocol consumers ignore `messageMetadata` anyway. Text protocol = simpler server, simpler client, same UX. — Claude
- **2026-05-12** (Phase 2b): Drop the inline "X in (Y cached) · Z out" usage meter. Reason: useCompletion exposes no usage event to consumers; adding a side-channel (custom fetch + response header) just for an inline debug indicator wasn't worth the complexity. Cache observability shifts to server logs — `streamText({ onFinish })` logs `[copy] usage account=… cache_read=…` per call. Same monitoring story as the breakage-checklist already prescribes (Vercel Function Logs). — Claude
- **2026-05-12** (Phase 2c): Use text-stream protocol on BOTH ideas + prompt modes of `/api/ai/image`, via `pipeTextStreamToResponse`. Reason: `experimental_useObject` consumes raw JSON-as-text deltas (parsed by `parsePartialJson` client-side), and `useCompletion` already uses text-stream from Phase 2b. Symmetric across both modes simplifies the server. — Claude
- **2026-05-12** (Phase 2c): Render idea cards PROGRESSIVELY as the JSON streams in rather than waiting for stream completion + lenient-parse-on-done. Reason: this is the whole point of `useObject` — it surfaces `DeepPartial<RESULT>` updates as each field lands. Cards show title-then-description-then-keywords as the partial JSON resolves; click is gated until `isLoading` flips false AND the card has both title + description. v1's "wait then show all" model was a side-effect of the SSE-then-parse architecture; we're not preserving it. — Claude
- **2026-05-12** (Phase 2c): Single endpoint `/api/ai/image` keeps serving both modes. Reason: they share auth, brand-context load, and platform validation. The two hooks send different body shapes (useObject posts the input verbatim; useCompletion always sends `{ prompt, ...body }`) but the server differentiates on `body.mode` and reads `body.prompt` only on prompt mode. Splitting into two endpoints would duplicate ~150 LoC of validation/load logic. — Claude

## Deferred / roadmap (out of the v2 migration but tracked here)

These items came up during the v2 work but are scoped to separate PRs after migration completes (or in parallel if priority shifts).

- **Brand notes restructure** — three sub-pieces, one PR when picked up:
  1. RLS migration on `brand_kit_notes` tightening from "agency staff OR account members" → **agency staff only** on SELECT/INSERT/UPDATE/DELETE.
  2. Frontend gating in [BrandNotesSection.jsx](web/src/components/BrandNotesSection.jsx) so non-agency users never see the card.
  3. Move the Brand notes UI out of [BrandKitView.jsx](web/src/components/BrandKitView.jsx) into its own top-level view (e.g. `/c/:slug/brand-notes`) with an agency-only sidebar entry positioned below "Trends Radar".
  - **Rationale**: notes are a thinking-out-loud surface for the agency. Brand users shouldn't see the raw memory dump, and the notes deserve a dedicated workspace rather than being buried inside BrandKit.
  - **Migration touchpoint**: the user runs the SQL via Supabase dashboard (per project pattern).
  - **Status**: scoped, not started.

- **System prompt platform-quality improvements (universal)** — small standalone PR adding platform-specific copywriting guidance to the SYSTEM_PROMPT in [chat.ts](web/api/ai/chat.ts). Applies to all brands. **Note**: deliberately NOT pre-baking any brand-specific guidance (e.g. Bamboo Bear quirks) into the system prompt — that work lives in `brand_kit_notes`.
  - **Status**: deferred until Track A (v2 migration) is fully in.

---

## PoC results

> Filled in after the PoC route is deployed and hit.

### What the PoC tests

Two sequential `generateText` calls within 5 minutes, identical cached system blocks via `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`. Expected:

- Call 1: `cacheCreationInputTokens > 0`, `cacheReadInputTokens === 0`
- Call 2: `cacheCreationInputTokens === 0`, `cacheReadInputTokens > 0` (matching the cached blob size)

### How to run the PoC

After this PR's Vercel preview deploys:

1. Sign in to the dashboard preview URL as an agency user (any account in `AI_COPILOT_BRAND_IDS`).
2. Open browser devtools → Console.
3. Run: `fetch('/api/ai/cache-poc', { headers: { Authorization: 'Bearer ' + (await window.__LR_AUTH__.supabase.auth.getSession()).data.session.access_token }}).then(r => r.json()).then(console.log)`
4. Read the two rows. Cache landed = ✅ proceed to Phase 0. Cache didn't land = 🛑 dig into provider options.

### Results — 2026-05-11

Run against Vercel preview for PR #60 with model `claude-sonnet-4-6` and a deterministic ~3500-token cached system prompt.

| | Call 1 | Call 2 |
|---|---|---|
| `inputTokens` (total) | 3529 | 3529 |
| `outputTokens` | 5 | 5 |
| `cache_creation_input_tokens` (raw Anthropic) | 11 | 11 |
| `cache_read_input_tokens` (raw Anthropic) | **3515** | **3515** |
| `inputTokenDetails.cacheReadTokens` (SDK normalized) | **3515** | **3515** |
| `inputTokenDetails.cacheWriteTokens` (SDK normalized) | 11 | 11 |

**Verdict**: ✅ **PASS**

- 3515 of 3529 input tokens served from cache → ~99.6% cache-hit rate.
- The constant 11 tokens of `cache_creation_input_tokens` is Anthropic's normal per-call alignment overhead, not a cost concern.
- Both call 1 and call 2 hit cache because the 5-min TTL was still warm from prior PoC runs — exactly the behavior we expect for back-to-back chat turns in the real Co-pilot.
- Confirmed via two paths:
  1. SDK-normalized: `result.usage.inputTokenDetails.cacheReadTokens` ✓
  2. Raw provider: `result.providerMetadata.anthropic.usage.cache_read_input_tokens` ✓
- Bonus: `cache_creation.ephemeral_5m_input_tokens: 11` confirms we're getting the 5-min ephemeral cache (not the 1h variant, which we don't want).

**Implication for the migration**: `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` on AI SDK system messages produces identical Anthropic cache behavior to the raw SDK's `cache_control: { type: 'ephemeral' }` blocks. Safe to proceed to Phase 0.

### Gotchas surfaced by the PoC (added to the breakage checklist)

1. **Vercel ignores `api/_*.ts` files.** Adding `_cache-poc.ts` returned `index.html` with status 200 because Vercel treats underscore-prefixed files as private helpers. Always name route files without leading underscores.
2. **AI SDK v6 cache token paths.** `providerMetadata.anthropic` exposes only `cacheCreationInputTokens` as a flat camelCase field — there's **no** flat `cacheReadInputTokens`. Use either the SDK-normalized `result.usage.inputTokenDetails.cacheReadTokens` or the raw `result.providerMetadata.anthropic.usage.cache_read_input_tokens`. Plan to use the SDK-normalized path in production routes for provider portability.

---

## File-level inventory (what changes, what stays)

### Server (changes per phase)

| File | Today | After Phase 1 |
|---|---|---|
| `web/api/ai/chat.ts` | 464 LoC, raw Anthropic SDK, manual MAX_TURNS loop, manual SSE events | ~150 LoC, `streamText` with `tool()` definitions, `stopWhen: stepCountIs(8)`, `toUIMessageStreamResponse()` |
| `web/api/ai/copy.ts` | 292 LoC, raw Anthropic SDK | ~100 LoC, `streamText` |
| `web/api/ai/image.ts` | 306 LoC, lenient JSON parser for ideas | ~150 LoC, `streamObject` (ideas) + `streamText` (prompt) |
| `web/api/ai/cache-poc.ts` | does not exist | NEW: 60 LoC PoC route (delete after Phase 0 lands) |

### Client (changes per phase)

| File | Today | After Phase 2 |
|---|---|---|
| `web/src/components/CopilotPanel.jsx` | 474 LoC, manual SSE parser, hand-rolled message rendering, in-house ToolCard | ~200 LoC, `useChat()` + AI Elements components |
| `web/src/components/AICopyPreview.jsx` | 292 LoC, state machine + manual SSE parser | 260 LoC, `useCompletion({ streamProtocol: 'text' })`. Header comments expanded vs. v1, so raw line count under-states the logic shrink — `parseSse` generator + 'compose'\|'streaming'\|'done'\|'error' state + AbortController + usage state all collapse to derived booleans. |
| `web/src/components/AIImagePromptPanel.jsx` | 592 LoC, 7-phase state machine + manual JSON parser + parseSse | 625 LoC (header comments expanded vs v1 — actual logic shrank significantly: parseSse + parseIdeasJson + 7-phase setter chains + AbortController + usage state all replaced with `experimental_useObject` + `useCompletion` + a derived sub-phase). Idea cards stream in progressively. |

### Untouched / minimal changes

- `web/src/lib/brandContext.js` — pure compiler, ZERO changes needed
- `web/src/lib/db.js` — AI helpers (loadBrandKitNotes, subscribeToBrandKitNotes, aiGenerated/aiDraftPayload mappers) unchanged
- `web/api/daily-digest.ts` / `web/api/fetch-trends.ts` / `web/api/find-competitors.ts` — completely untouched
- All Supabase schemas, RLS, RPCs — completely untouched

### New (added during migration)

- `web/tailwind.config.js` — scoped Tailwind config (Phase 0)
- `web/postcss.config.js` — Tailwind / autoprefixer pipeline (Phase 0)
- `web/components.json` — shadcn config (Phase 0)
- `web/src/lib/utils.ts` — shadcn `cn()` helper (Phase 0)
- `web/src/styles/elements.css` — Tailwind directives + CSS variables (Phase 0)
- `web/src/components/ai-elements/**` — copy-pasted AI Elements components (Phase 2)
