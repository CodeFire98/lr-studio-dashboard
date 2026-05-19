# Linkrunner Media Dashboard — Reference

> Single source of truth for what this thing is, how it's built, and how the
> pieces fit together. Updated as the codebase evolves.

**Last updated:** 2026-05-19 (**Brand-side AI Phase 2 — Co-pilot chat opens to brand + brand notes RLS reopened.** Phase 2 of the brand-side AI rollout. The ✨ Co-pilot button in the topbar is no longer agency-gated — brand teammates on the Bamboo Bear allowlist can open the chat sidebar and use it exactly like the agency does. The system prompt branches on caller role: agency callers get the existing "you're working alongside the agency team on a client brand" framing; brand callers get a brand-POV framing that explicitly tells the model the resulting plans land in 'brand_draft' and the brand still has to click "Propose plan" in the detail view to submit. The role block is a short third cache breakpoint between the static SYSTEM_PROMPT and the brand context, so agency and brand sessions don't share that cache slice but the larger blocks still hit per-role. The `create_post_plan_draft` tool now returns `status: 'brand_draft'` when the caller is brand (was hardcoded to 'drafting'); `commitAiDraftPlan` in db.js respects whatever status the draft carries so the post_plans row lands in the right state on the client-side INSERT. The `/api/ai/chat` route swaps its inline `is_agency + WHITELIST.includes` block for the shared `authorizeAiCall` + `checkAndRecordAiUsage` helpers from Phase 1, so chat calls also count toward the unified 50/day brand quota. New migration `0052_brand_kit_notes_open_to_brand.sql` reverts 0040's agency-only tighten — brand teammates can now SELECT / INSERT / UPDATE / DELETE notes for their own brand (user explicitly opted to surface brand notes to brand: "we can open up brand notes to brand-view as well; this opens up a lot of constraints"). `BrandNotesView` drops its agency-only "not available" branch; `BrandNotesSection` drops the early `if (!isAgency) return null` so brand callers see the full editor; `Sidebar` shows the Brand notes nav entry for everyone with a brand context. `CopilotPanel` takes a new `isAgency` prop and ships role-specific fallback suggestion chips (`FALLBACK_SUGGESTIONS_AGENCY` / `FALLBACK_SUGGESTIONS_BRAND`) — the streaming AI chips remain a single endpoint that branches on the prompt's role section. `web/src/App.jsx` flips `copilotEligible` to require auth + allowlist only (drops `isAgency`), then aliases `aiInlineEligible` to `copilotEligible` — Phase 1 already opened inline AI separately and the two flags now have the same eligibility surface. No new env vars; same `AI_COPILOT_BRAND_IDS` / `VITE_AI_COPILOT_BRAND_IDS` allowlists.)

**Previous (2026-05-19):** **Brand-side AI Phase 1 — inline AI opens to brand + per-brand daily quota.** Brand users on Bamboo Bear (the lone allowlisted brand for now) now see the same ✨ "AI draft / AI redraft" button on the copy editor and the ✨ AI image-prompt panel that the agency has had since the Co-pilot v2 ship — but only on plans they can actually edit (`isEditor`, i.e. own brand_draft). Co-pilot chat sidebar is NOT opened in this PR; that ships in Phase 2. (1) New `web/api/ai/auth-lib.ts` consolidates the JWT → role → allowlist check that was duplicated across all four AI routes; same module also owns the per-brand AI quota. `authorizeAiCall({authHeader, accountId, allowlist})` returns `{ok, caller}` or `{ok:false, status, error}`; brand callers now go through an additional `account_members` membership check before the allowlist gate. (2) `checkAndRecordAiUsage({caller, accountId, kind})` enforces a hard cap of **50 AI calls / day / brand** across all four surfaces (chat / copy / image / suggestions) — agency callers are uncapped but their calls are still recorded for telemetry. The day boundary is **midnight IST** (Asia/Kolkata), computed in JS via `new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })` for the date part, then `new Date(\`${date}T00:00:00+05:30\`)` for the UTC instant. (3) `quotaExceededResponse(result)` returns a 429 with the friendly user-facing string under the `error` field (matches what the Vercel AI SDK renders) and a programmatic `code: 'ai_quota_exceeded'` alongside. (4) New migration `0051_ai_usage.sql` creates the tiny tracking table (`id, account_id, user_id, caller_is_agency, kind, created_at`) with a partial index on `(account_id, created_at desc) where caller_is_agency = false` for the hot read path. RLS denies all client access; service role bypasses for inserts + counts. (5) Three route files (`copy.ts` / `image.ts` / `suggestions.ts`) replaced their inline auth block with `authorizeAiCall` + `checkAndRecordAiUsage`; chat.ts is untouched (still agency-only via its own pre-existing check — Phase 2 will migrate it). (6) `web/src/App.jsx` now computes two flags: `copilotEligible` (unchanged: agency + allowlist + brand-selected — drives the ✨ Co-pilot button; stays agency-only in Phase 1), and the new `aiInlineEligible` (drops the agency requirement — drives the inline AI affordances). (7) `PostPlanDetailView.jsx` accepts the new `aiInlineEligible` prop; three render gates flip from `copilotEligible` → `aiInlineEligible`. The AI image-prompt panel gate also flips its `isAdmin` half to `isEditor` so brand-on-own-brand_draft sees it too. (8) Concurrency note: the usage row is INSERTed BEFORE the LLM call so a burst of concurrent brand requests can't all read 49 and proceed past the cap; failure to insert fails open (don't deny on infra bobbles).)

**Previous (2026-05-19):** **Brand proposals — copy-change proposals + word diff + red-dot indicator (PR 5 of 6).** Closes the brand → agency loop for copy edits. Brand on `needs_review` or `approved` plans sees a new **"Propose changes"** button (ghost style) in the status-action row, alongside their existing Approve button. Clicking it opens a `ProposeCopyChangesModal`: per-platform tabs (only the plan's targeted platforms), textarea pre-filled with the current copy, a live word-level diff preview that updates as the brand types, an optional note field, and Send. On Send, a `plan_proposals` row of `kind='copy_change'` is created with `payload: { copy_variants: { <only changed platforms> } }`; PR 1's `plan_proposals_emit_created_message` trigger emits "proposed copy changes for this plan." into the brand conversation thread as a subtle system message. Agency-side: PostPlanDetailView surfaces a new `PendingCopyProposalCard` above the status pill (alongside the date-change card from PR 4) — coral-tinted block with the brand's note in italic, per-platform diff blocks (one per platform that changed, with platform chip + label + word-level diff inline using red strikethrough for removed text + green underline for added text), and Accept / Reject buttons. Accept merges `payload.copy_variants` into the plan's `copyVariants` (only the keys the brand touched) + marks the proposal `'approved'`; PR 1's trigger emits "accepted the proposed copy changes." Reject just marks the proposal `'rejected'` and emits the matching message. Brand-side sees the same diff block with "Awaiting agency review" instead of action buttons. New tiny `web/src/lib/wordDiff.js` helper — LCS-based word-level diff for prose (~80 lines, no new dependency); preserves whitespace as separate tokens so re-joining is lossless; coalesces adjacent same-type runs to keep the rendered DOM light; complexity O(n*m) which is fine for caption-length prose (<500 words). `DiffView` component in PostPlanDetailView renders the token array with the inline color treatment. **Red-dot indicator on calendar chips** — agency view only, signals "brand has a pending unresolved proposal on this plan." Coral 8px dot sits next to the chip's existing unread-message dot. Computed from `loadAllPendingProposals()` filtered to `!acknowledged_at`, kept fresh via a `plan_proposals` realtime subscription on the CalendarView. Acknowledgment auto-fires when an agency user opens a plan with unacknowledged proposals — `acknowledgeProposal(id)` is called for each in a single useEffect, which clears the dot on the calendar without requiring an explicit "mark read." Brand v1 doesn't render the dot (they made the proposal, they know it's pending). New imports: `createProposal`, `acknowledgeProposal` from db.js in PostPlanDetailView; `loadAllPendingProposals`, `supabase` in CalendarView; `diffWords` from the new helper. New components: `DiffView`, `PendingCopyProposalCard`, `ProposeCopyChangesModal` all live in PostPlanDetailView.jsx alongside their date counterparts from PR 4. Modal escape-key + backdrop-click close, busy-state lockout during the network round-trip, change-detection that prevents "Send proposal" without an actual diff. No new migration — PR 1's `plan_proposals` table, RLS, and triggers cover the entire flow end-to-end.)

**Previous (2026-05-19):** **Brand proposals — drag-to-propose date changes (PR 4 of 6).** Brand can now drag any of their account's needs_review / approved post-plan cards on the calendar to a new day. Instead of writing the move directly, a "Propose a new date" modal opens: from→to dates side-by-side (time of day preserved, drag is date-only), optional brand note, Cancel / Send proposal. On Send, a `plan_proposals` row with `kind='date_change'` and payload `{ scheduled_at: <new ISO> }` is created. PR 1's `plan_proposals_emit_created_message` trigger emits "proposed a new date for this plan." into the brand conversation as a subtle system message. The plan stays at its original date until the agency resolves. Agency-side: PostPlanDetailView now loads pending proposals for the plan and renders a coral notification block above the status row when there's a pending `date_change` proposal. Block shows "Brand proposed a new date", from→to timestamps, the optional brand note, and **Accept** (green) / **Reject** (ghost) buttons. Accept applies the proposed `scheduled_at` to the plan AND marks the proposal `'approved'`; PR 1's `plan_proposals_emit_resolved_message` trigger emits "accepted the proposed date change." Reject just marks the proposal `'rejected'` and emits "rejected the proposed date change." Brand-side sees the same block with "Awaiting agency review" instead of action buttons. Drag handling now branches on a new `dragMode` field on `decoratedPostPlans`: agency on anything-not-posted gets `'free'` (existing behaviour), brand on own brand_draft gets `'free'`, brand on needs_review/approved gets `'propose'` (opens the modal), everything else is non-draggable. Drop-target cell handlers are no longer gated on `isAdmin`. New `ProposeNewDateModal` component lives at the top of `CalendarView.jsx`; new `PendingDateProposalCard` component lives at the top of `PostPlanDetailView.jsx`. No new migration — the plan_proposals table, RLS, and triggers from PR 1 already cover this flow end-to-end.)

**Previous (2026-05-19):** **Brand proposals — brand creates new plans, explicit submit step, subtle system messages (PR 3 of 6).** Brand users get their first-ever write action with a two-step create → submit flow: (1) Brand clicks "+ Propose plan" on the calendar — stub row lands in a private `'brand_draft'` state, no system message fires yet. (2) Brand fills in concept/copy/date/platforms inline (new `isEditor` boolean lets the creator edit while in brand_draft). (3) Brand clicks "Propose plan" on the detail view — status flips brand_draft → proposed, the status-change trigger emits "proposed a new post plan." into the brand's conversation thread. (4) Agency sees the proposed plan with **Accept** / **Reject** buttons (Accept → drafting via existing PR 1 trigger emitting "accepted the proposed plan."; Reject → `handleDelete()` with confirmation). System messages in the conversation thread now render compact, italic, no-avatar, low-contrast so the lifecycle log doesn't compete with real DMs — new `.conv-msg-system` CSS class, `MessageBubble` branches on `message.kind === 'system'`. New CSS treatment: single-line text "<strong>Name</strong> <italic>verb-phrase</italic> · <muted>time</muted>" plus the auto-tagged plan chip if any. Migration `0049_brand_proposes_new_plan_message.sql`: AFTER INSERT trigger on post_plans emitting "proposed a new post plan." when status='proposed' on insert (safety net for direct inserts that bypass the brand_draft path). Migration `0050_brand_draft_status.sql`: extends `post_plans.status` check to a 5th value `'brand_draft'`; adds a `brand_draft → proposed` case to `emit_post_plan_status_message`; tightens `guard_post_plan_status_transitions` to allow brand `brand_draft → proposed` and forbid agency from setting `status='brand_draft'`. `STATUS_CONFIG` adds `brand_draft` with label "Draft (not yet proposed)" (muted). `CalendarView.createStubAndOpen` passes `status: isAdmin ? 'drafting' : 'brand_draft'`; `STATUS_GROUPS` gets a new `brand_draft` filter group; `STATUS_ORDER` adds the new value alongside drafting. `PostPlanDetailView.statusBucket` learns the 5th value. `statusActions`: brand-only "Propose plan" button on `brand_draft` (gated to the creator), agency Accept/Reject on `proposed`. `isEditor` = `isAdmin || (status === 'brand_draft' && createdBy === userId)` — once brand submits, plan becomes read-only for them until agency resolves. Field-edit gates throughout PostPlanDetailView (title, copy, date, platforms, delete) gate on `isEditor`; role-only features (status workflow buttons, auto-title sparkle, Duplicate, AI Co-pilot, References/Deliverables uploads) stay on `isAdmin`. `mapConversationMessageRow` in db.js exposes the `kind` column. No new JS helpers; existing `createPostPlan` already accepts a `status` parameter.)

**Previous (2026-05-19):** **Brand proposals — agency buttons + brand approval (PR 2 of 6).** Removes the agency status dropdown (which let admins accidentally set `'approved'` themselves) and replaces it with explicit workflow buttons that match the new policy: only the brand can ever approve a plan. Agency's terminal forward action is now "Submit for review" (`drafting → needs_review`); we also add a "Recall to drafting" button on `needs_review` so agency can pull a plan back without a dropdown. Brand still sees "Approve" on `needs_review` (unchanged). Hard floor at the DB: new migration `0048_brand_proposals_status_guard.sql` installs a `BEFORE UPDATE of status` trigger that (a) refuses any agency UPDATE that sets `status='approved'` and (b) refuses any brand UPDATE except `needs_review → approved`. Service-role / SECURITY DEFINER contexts (cron, edge functions, migrations) bypass the guard via `if auth.uid() is null then return new;`. UI status-pill labels updated to communicate ownership: `proposed` → "Awaiting agency review" (coral tint #C44A2C), `needs_review` → "Awaiting brand approval" (mustard #A16207, was "Needs review"). Legacy aliases `needs_brand_feedback` / `needs_admin_revision` follow the new label too. `STATUS_GROUPS` on the calendar gets a new `proposed` filter group (label "Proposed") so brand-originated plans (shipping in PR 3) can be filtered. `transitionStatus` + `confirmPendingTransition` in `PostPlanDetailView.jsx` rewritten to await `updatePostPlan` and revert local state on failure, so the new guard's `raise exception` doesn't leave the UI in a phantom-approved state. `statusBucket` learns a 4th value `'proposed'` so a brand-originated plan renders distinctly from drafting.)

**Previous (2026-05-19):** **Brand proposals — foundation (PR 1 of 6).** Schema-only migration that lays the rails for brand users to write to the calendar through an agency-approval gate. (1) `post_plans.status` check constraint extended to a fourth value `'proposed'` — used when a brand creates a new plan that the agency hasn't accepted yet. The plan row itself sits in this status; on accept, agency flips it to `'drafting'`. (2) New `plan_proposals` table for edit-proposals on already-existing plans: `kind in ('new_plan' | 'date_change' | 'copy_change')`, `payload` jsonb holds the proposed values, `status in ('pending' | 'approved' | 'rejected')`, plus `note` / `agency_response` / `acknowledged_at` fields for the agency review surface. RLS: agency or account members can SELECT; any auth user with account access can INSERT their own proposals (`proposed_by = auth.uid()`); UPDATE + DELETE agency-only. A `BEFORE INSERT/UPDATE` trigger asserts that `plan_proposals.account_id` matches the parent plan's account (denormalized for RLS speed, but kept honest). (3) `conversation_messages` grows a `kind` column (`'user'` default, `'system'` for lifecycle events) so the agency / brand can see the plan's full history — "Lakshith sent this plan for brand review.", "Shruti proposed copy changes.", "Lakshith accepted the date change." — inline in the brand conversation thread. Client INSERT RLS is tightened to `kind = 'user'` so a malicious client can't impersonate system events; the three triggers below run as `SECURITY DEFINER` and bypass that. (4) Three triggers emit system messages: `post_plans_emit_status_message` on every `post_plans.status` change, `plan_proposals_emit_created_message` on proposal insert, `plan_proposals_emit_resolved_message` on proposal `pending → approved/rejected`. Trigger bodies build verb-phrased text ("sent this plan for brand review.") so the UI can render `<author name> <body>` and it reads naturally regardless of who triggered it. All three go through one shared `emit_plan_system_message(account_id, plan_id, actor_id, body)` helper that looks up the brand's conversation row by `account_id`, inserts a `kind='system'` message with the plan auto-tagged. (5) A companion `stamp_plan_proposal_resolution` `BEFORE UPDATE` trigger auto-fills `resolved_at` / `resolved_by` on the pending→resolved transition so callers don't need to set them. (6) `plan_proposals` is added to `supabase_realtime` for live reactivity in the upcoming review surface. New JS helpers in `web/src/lib/db.js`: `loadProposalsForPlan` / `loadPendingProposalsForAccount` / `loadAllPendingProposals` / `createProposal` / `resolveProposal` / `acknowledgeProposal`. No UI consumes any of this yet — PRs 2-6 in the brand-proposals series wire up the agency status-button cleanup, brand-side "Propose plan" CTA, drag-to-propose date changes, copy-change diff UI, red-dot unread indicators on plan cards, top-nav pending-proposals drawer, and Resend email notifications.)

**Previous (2026-05-15):** **Post-plan attachments: editable captions.** New `caption` column on `post_plan_attachments` — optional, nullable, user-editable label distinct from `filename`. Empty caption renders the filename as the primary label; clicking the label (or the pencil-on-hover) opens an inline input pre-filled with the filename, which the agency can keep, tweak, or replace entirely. Saving the same string as the filename is normalized to null on the client so we don't store redundant copies. Lightbox header uses the caption when present; the Download button always uses filename so the file lands with its real name. Brand users see captions read-only. Optimistic write with revert-on-failure. Migration `0046_post_plan_attachment_caption.sql` also adds the missing UPDATE RLS policy on `post_plan_attachments` (existing migration 0021 had SELECT/INSERT/DELETE policies but no UPDATE — caption saves were silently failing with PostgREST's "Cannot coerce the result to a single JSON object" until this gap was closed). New `updatePostPlanAttachment(id, { caption })` helper in `web/src/lib/db.js`. Lives in `web/src/components/PostPlanDetailView.jsx`.)

**Previous (2026-05-15):** **AI Co-pilot: two QoL fixes — refresh produces fresh suggestions, scroll detaches during streaming.** (1) The welcome-screen Refresh button was producing near-identical suggestions every click — temp 0.9 + identical (within-day) prompts let the model converge on the same output. The route now accepts a `previousSuggestions` array, the client accumulates every suggestion it's shown into a session-local ref capped at 16, and the server prompt explicitly names them with "DO NOT repeat or paraphrase". A 6-char nonce is also injected per-call so even the first refresh produces byte-different input. While the refresh is in flight, the old chips are hidden so the admin gets immediate "new ones coming" feedback. (2) During streaming the user was being pulled to the bottom on every token, making it impossible to read earlier messages mid-generation. Added stick-to-bottom logic: a scroll listener on the message container maintains a `stickToBottomRef`; the auto-scroll only fires when the user is within 64px of the bottom. Scrolling up detaches; scrolling back to the bottom re-engages. When detached during streaming, a "New tokens below" pill surfaces above the composer to jump back to the latest. Both changes live in `web/src/components/CopilotPanel.jsx` + `web/api/ai/suggestions.ts` + a small CSS rule for the jump-pill.

**Previous (2026-05-15):** **AI Co-pilot: commit-on-click for proposed post plans.** The `create_post_plan_draft` tool no longer inserts into `post_plans` when the model calls it — the tool now just echoes the proposed payload back as `{ proposed: true, … }` and the inline ToolCard renders an "Open plan →" CTA. The DB INSERT happens on the client when the admin clicks "Open plan", via a new `commitAiDraftPlan` helper in `web/src/lib/db.js`. Rationale: if the model produces five plans in a thread and the admin only engages with two, only those two should land on the calendar — un-reviewed AI output shouldn't pollute the planning surface. ToolCard tracks per-card `committedId` + `committing` state so a second click is idempotent (just navigates). Tool description + system-prompt bullet rewritten so the model frames its replies as proposals ("I've drafted a plan for you to open"), not fait accompli. After commit, the headline flips from "Drafted a post plan — open to add" to "Added to the calendar". No schema change, no migration. Legacy tool history that returned a real `id` is still respected as already-committed.

**Previous (2026-05-15):** **Reset scroll to top on SPA route changes.** Opening a post plan from the calendar used to land mid-page (near the Copy card) because React Router does client-side route changes and the browser doesn't auto-reset scroll on those — the scroll-y from the calendar carried into the detail view. Fixed with a single `useEffect` in `App.jsx` that calls `window.scrollTo(0, 0)` on `location.pathname` change. Gated on `navigationType !== 'POP'` so back/forward browser nav still restores the previous scroll position (the browser's own `history.scrollRestoration: 'auto'` is left alone for that). Applies to every route in the SPA, not just post-plan opens.

**Previous (2026-05-15):** **Calendar / post-plan QoL pass — three bundled UX wins.** (1) Month + Week calendar views accept HTML5 drag of post chips to a different day cell; only the date portion of `scheduled_at` changes (time-of-day preserved); same-day drops are no-ops; posted plans are non-draggable; optimistic write with revert-on-failure. (2) When an admin saves the first piece of copy on a still-untitled post plan, the `concept` is auto-filled from the first non-empty line of that copy (emoji/punctuation stripped, sentence-first preferred, truncated at word boundary) — fires exactly once per plan, surfaces a dismissible sparkles callout with Undo. (3) Both auto-generation paths for the post-plan `concept` now target **5-10 words** instead of full sentences: the `create_post_plan_draft` zod field demands a HEADLINE not a sentence (with concrete examples + `.min(3).max(80)` hard cap), and the auto-title cap drops from 60 → 50 chars.

**Previous (2026-05-15):** **"L+R Agency" → "Linkrunner Media" rebrand sweep finished off.** The original rebrand on 2026-05-11 swapped the Sidebar wordmark and the `<title>` but missed two pre-auth surfaces: the LoginModal head ("L+R / Agency") and the BrandOnboardingModal head (same wordmark on first-run). Both flipped to "Linkrunner / Media" using the same `wordmark-tail` split the Sidebar uses. Also swept the few remaining "L+R" short-form mentions: TaskDetailView's conversation card subtitle ("messages between X and L+R" → "… and Linkrunner Media") and reply placeholder ("Reply as L+R…" → "Reply as Linkrunner Media…"), and the agency-owner role label in auth.js ("Agency Owner, L+R" → "Agency Owner, Linkrunner Media") which shows in the profile pill. The send-email Edge Function and live email subjects ALREADY say "Linkrunner Media" in code (default for `EMAIL_FROM_NAME`) — but the deployed Supabase secret was still set to "L+R Agency", overriding the code default, which is why outbound emails were still going out branded "L+R Agency". The secret got updated to "Linkrunner Media" in this pass. REFERENCE.md doc-drift cleaned up: five lines that documented the old default / old subject lines were rewritten. Historical mentions in the 2026-05-11 rebrand changelog entry (lines 513/514/522) preserved as-is — those describe what the rebrand did and should keep their before-state.

**Previous (2026-05-15):** **Engagement refresh cron moved off Vercel onto Supabase pg_cron + Edge Function.** Vercel Hobby capped us at one cron-fire/day × 60s function timeout × 5 scrapes per fire = 5 publications/day max, which doesn't scale past the first brand. Moved the orchestrator to a new Supabase Edge Function `engagement-refresh` (Deno port of `web/api/engagement/refresh-cron.ts`'s logic, same tier cadence + priority sort, but with `Promise.allSettled` chunks of 3 and a per-run cap of 20). Trigger is now a pg_cron job inside Postgres calling the function via `pg_net.http_post()` — `CRON_SECRET` + project URL stored in Supabase Vault so the job statement doesn't hardcode them. New `cron_run_log` table (one row per fire, success or fail, with eligible/due/processed/failed/blocked counts + per-publication detail jsonb) means "did the cron run?" is a one-line SELECT instead of a log-spelunk. Schedule tightened to `30 0 * * *` UTC = 6:00 AM IST (was effectively ~6:30+ before). Vercel cron route + the `0 1 * * *` entry both removed; on-paste auto-refresh route (`/api/engagement/refresh`) stays — it's user-triggered, not cron. New SQL migration `0045_engagement_refresh_cron.sql`. Email alerts on failed/blocked deferred — the cron_run_log row carries enough detail for now, will wire a `send-email` template later.

**Previous (2026-05-14):** **Live Posts engagement — X re-enabled** via `scrape.badger/twitter-tweets-scraper`. Second-pass actor shootout found a viable tweet-by-ID Apify actor at $0.0002/result (cheapest in the X scraper market — `apidojo/tweet-scraper` and friends only do profile/search input, `kaitoeasyapi` charges for empty results, `pratikdani/twitter-posts-scraper` works but is 100× the cost). New `scrapeX(liveUrl)` in `web/api/engagement/scraper-lib.ts` extracts the tweet ID from `/status/<id>`, calls the actor with `{ id }` input, normalizes `favorite_count` → `like_count`, `retweet_count` → `share_count`, view/reply/bookmark counts via field-name probing (only `favorite_count`/`retweet_count` are confirmed in the actor's visible 20-key dump; the rest may exist past key 20 — `availability_notes` reports which ones came back null). Dispatch, cron eligible platforms, on-paste auto-refresh allowlist, and LivePostsView X-tile UI all flipped: X tiles now render the standard metrics row + "Refresh now" button instead of the "X engagement not tracked" badge. §13 X-skip decision reversed.

**Previous (2026-05-14):** **AI Co-pilot web search + daily trend snapshots — PR 3 of N**. New migration `0044_brand_trend_snapshots` (append-only Firecrawl /search cache). New `/api/trends/refresh-cron` Vercel Cron fires daily at 06:00 IST per AI_COPILOT_BRAND_IDS allowlisted brand — 2 Firecrawl /search queries per brand (industry trends + hashtag pulse), writes top 5 deduped results per query. ~60 credits/month per brand. Brand-context compiler grows a `## Industry signals (recent trend articles)` section that surfaces the latest cached signals (max 7 days old) into the chat system prompt — model leads proactively with what's in the news, no per-call Firecrawl spend. New `web_search` tool on `/api/ai/chat` for on-demand drill-down beyond the cached signals — Firecrawl /search, top 5 results, costs credits per call. System prompt updated with a "Use Industry signals before searching" rule and a more concrete proactive-opening rule that names the new section. CopilotPanel ToolCard + CopilotStatus learn friendly labels: "Searching the web for 'sustainable fashion India trends'…" → "Read 5 results from the web". Needs `FIRECRAWL_API_KEY` in Vercel env (already set per prior PRs).)

**Previous (2026-05-14):** **AI Co-pilot marketing skills — PR 2 of N (skill registry + load_skill tools + inline-copy guidance)**. 7 marketing playbooks copied from the [marketingskills](https://github.com/coreyhaines31/marketingskills) repo into `web/src/data/skills/` — social-content, content-strategy, copywriting, copy-editing, marketing-psychology, marketing-ideas, launch-strategy. ~3,800 lines of playbook material total. New `web/src/lib/skillRegistry.js` exposes `loadSkill(slug)`, `loadSkillReference(slug, ref)`, and `compileCopyGuidance(platform)`. **Chat panel** (`/api/ai/chat`) gets two new tools — `load_skill` and `load_skill_reference` — for on-demand playbook access. **Inline "✨ AI draft" / "Redraft"** (`/api/ai/copy`) gets a platform-targeted guidance block injected up front as a third cached system breakpoint — pulls the matching platform section from social-content's references and the full copywriting SKILL.md frameworks (~2K cached tokens per platform). CopilotPanel `ToolCard` learned friendly headlines for `load_skill` ("Consulting the launch-strategy playbook…" → "Loaded the launch-strategy playbook") and `load_skill_reference`. vercel.json `functions["api/ai/chat.ts"]` AND `functions["api/ai/copy.ts"]` both ship the .md files via `includeFiles: "src/data/skills/**"`.)

**Previous (2026-05-14):** **AI Co-pilot calendar awareness — PR 1 of N (confidence flip + calendar context)**. Chat system prompt flipped from "ask before guessing" to defaults-first ("decide and ship the draft, drafts are reversible"). `compileBrandContext` extended with five new sections — `## Today` (date, day, week-of-year, brand timezone, next-30-day moments from a curated marketing calendar), `## Upcoming calendar` (next-7-day-detail / 8-30-day-compact), `## Cadence (last 30 days)` with gap detection, `## Top performers` ranked by engagement, `## Voice anchors` (opening lines from top-performing posts). New `getBrandLocale(brandKit, account)` helper defaults to IN / Asia/Kolkata until country/timezone columns are added. New `marketingMoments.js` curated list of 2026-2027 Indian + global moments (date-holidays was insufficient for IN — only 6 public holidays, no Diwali/Holi/Eid). Calendar sections are **opt-in** via `loadAndCompileBrandContext(client, id, { includeCalendar: true })` so inline copy/image/suggestions routes don't pay for context they can't act on; chat opts in, others don't. Also bundled: silent repair for malformed tool inputs via `experimental_repairToolCall` + a `sanitizeBrokenToolCalls` history pre-processor + UI suppression of tool-error tiles in CopilotPanel — the model recovers from JSON slips invisibly, poisoned conversations self-heal on the next message, no red plumbing tiles surface to the admin.

**Previous (2026-05-14):** **Conversations PR 2 polish pass** — sticky header + sticky composer (wrap is the scroll container now, not the inner feed); textarea capped at ~5 lines and scrolls internally past that instead of pushing the composer offscreen; composer split into a **paperclip = file attach** + **calendar = plan tag** button pair; plan-tag dropdown rows now show scheduled date/time and sort newest-scheduled-first (cap 60); **file/image/video attachments live everywhere** the composer is, including inside thread drawers — reuses the existing `post-plan-attachments` bucket with path `<accountId>/messages/<messageId>/<filename>` so no new RLS needed; sidebar Conversations badge now counts thread replies as well as top-level messages; **right-click any of your own messages → soft-delete** (WhatsApp-style "Message deleted" tombstone, agency can also delete others'); **migration 0043** drops the FK on `conversation_messages.tagged_post_plan_id` so a deleted plan leaves an orphaned id on the message → renders a greyed-out "Plan deleted" chip in the bubble instead of silently disappearing. Realtime extended to handle UPDATE events (for soft-delete tombstones flipping across tabs) and new attachment INSERTs (other party's uploads appear live).

**Previous (2026-05-14):** Conversations PR 2 of 2 — chat UI shipped. Replaced the PR 1 placeholder with the real Slack-style chat at `/c/:slug/conversations`: stacked feed, composer with tag-a-plan dropdown, "Reply in thread" → right-side drawer, plan-chip cards inline in bubbles. The per-plan Conversation tab was removed from `PostPlanDetailView`; replaced by a "💬 Discuss this plan" button that deep-links into the chat with the plan pre-tagged. Status-transition flows that demand a reason use an inline expanding panel instead.

**Previous (2026-05-14):** Conversations PR 1 of 2 — data layer + sidebar plumbing. New per-brand chat schema (`conversations` + `conversation_messages` + `message_attachments` + `conversation_views`) with RLS + realtime + a trigger that auto-provisions a conversation row when a brand account is created. Migration 0042 backfills one conversation per existing brand and copies every `post_plan_comments` row into `conversation_messages` with the plan auto-tagged.

**Previous (2026-05-12):** Live Posts engagement feature — series complete (PRs #78, #79, #80, #81, #82, + docs wrap). End-to-end engagement tracking + embed cards for IG and LinkedIn, intentional X-skip. Daily cron-driven snapshot history feeds a `loadEngagementForBrandRange` helper ready for the future monthly-reports surface. New §9 subsection "Live Posts engagement (how it all fits together)" stitches all 5 PRs into one readable end-to-end flow.

**Previous (2026-05-12):** PR 8 of 9 — monthly-report data hook. New `loadEngagementForBrandRange(accountId, fromISO, toISO)` in db.js — single read-only helper that returns one entry per brand publication with `firstSnapshot` / `lastSnapshot` / `snapshotCount` / per-metric `delta` (like / comment / share / save / view / bookmark / reaction + `totalEngagementDelta` sum) / `note` (no-snapshots-in-range or single-snapshot-only). Pure consumer of the cron-driven snapshot history; no new UI, no new schema, no new routes. Future monthly-report builder consumes this directly.)

**Previous (2026-05-12):** PR 7 of 9 — scheduled refresh cron + sort affordances. New `/api/engagement/refresh-cron` (Vercel Cron, `0 */6 * * *`) reads eligible publications, computes tiered cadence (6h / daily / 3d / weekly by publication age + auto-demote-to-weekly after 3 consecutive failures), scrapes up to 5 due rows per fire, writes snapshots through the shared persistence helper. Scraper functions extracted from `refresh.ts` into a new `scraper-lib.ts` so both the on-demand and the cron routes use the same dispatch + normalizer + DB write. LivePostsView grows a Sort dropdown (Recently posted / Most likes / Most engagement) — non-"recent" modes render a flat leaderboard instead of the month-grouped chronology.)

**Previous (2026-05-12):** PRs 5+6 — LinkedIn wire-up via `supreme_coder/linkedin-post` (6.4M runs, 13k users, "No cookies · $1 per 1k"), X intentionally not supported in MVP (3-actor preflight found no viable actor without hostile pricing). Image-proxy allowlist extended to `*.licdn.com`. LinkedIn auto-refresh fires on mark-posted alongside IG.

**Previous (2026-05-12):** PR 4 — on-paste auto-refresh. PostPlanDetailView's `handleMarkPostedSubmit` fires `/api/engagement/refresh` for every newly-marked-posted IG publication with a URL. Fire-and-forget, doesn't block the modal close.

**Previous (2026-05-12):** PR 3 of 9 — UI integration for the engagement snapshots + embed cache shipped in PRs 1+2. New `LivePostEmbed.jsx` renders a static card; `LiveTile` grows a metrics row and agency-only "Refresh now" button. Two new db.js loaders + two realtime subscriptions; `refreshEngagement(publicationId)` calls the route. App.jsx passes `isAgency` down.

**Previous (2026-05-12):** Live Posts engagement — PR 2 of 9 — new Vercel API route [web/api/engagement/refresh.ts](web/api/engagement/refresh.ts). POST `{ publicationId }` → loads the publication via service-role, dispatches to `apify/instagram-scraper` (IG only in PR 2; X and LinkedIn return 501 until PRs 5/6), normalizes the response, INSERTs a snapshot row, UPSERTs the embed cache. Auth: JWT → `profiles.is_agency = true` → 403 if brand. Hardened against the Apify monthly-cap 403 by stamping `scrape_status='blocked'` on the snapshot row so the UI can distinguish quota exhaustion from a genuine scrape failure. `vercel.json` gets a per-function `maxDuration: 60`.

**Previous (2026-05-12):** Live Posts engagement — PR 1 of 9 — new migration `0041_post_engagement.sql` adding `post_engagement_snapshots` (append-only) + `post_embed_cache` (1:1 with publications). Reads open to agency + brand; writes service-role-only. New dry-run script `scripts/scrape-engagement-dry-run.mjs` validates the three Apify actors — `apify/instagram-scraper`, `apidojo/tweet-scraper`, `apify/linkedin-post-scraper` — before the production route is wired.

**Previous (2026-05-12):** AI Co-pilot session wrap-up — Track A (v2 migration) is fully complete; three post-Track-A items also shipped — Phase 3a suggestion chips + Refresh button ([#74](https://github.com/CodeFire98/lr-studio-dashboard/pull/74)), brand notes restructure with RLS tighten + dedicated `/c/:slug/notes` view ([#75](https://github.com/CodeFire98/lr-studio-dashboard/pull/75)), chat system prompt platform-craft section ([#76](https://github.com/CodeFire98/lr-studio-dashboard/pull/76)). Supabase migration `0040_brand_kit_notes_agency_only_rls.sql` applied. **Parked**: Phase 3b image attachments in chat, Phase 3c per-message cost meter, Phase 4 DB-backed conversation persistence. See [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md).

**Previous (2026-05-12):** Brand notes restructure — `brand_kit_notes` RLS tightened to agency-staff-only on all four operations. BrandNotesSection promoted from a card inside BrandKitView to a top-level view at `/c/:slug/notes`. New agency-only sidebar entry below "Trends Radar". Frontend-gated as defense-in-depth.

**Previous (2026-05-12, same day):** Chat system prompt — platform craft. Universal Instagram / LinkedIn / X copywriting conventions + cross-platform adaptation rule added to the `/api/ai/chat` SYSTEM_PROMPT. Defers to brand voice on tension. ~400 cached tokens; no measurable per-call cost increase.

**Previous (2026-05-12):** AI Co-pilot Phase 3 — dynamic suggestion chips + Refresh button via new `/api/ai/suggestions` route (`streamObject` + Haiku 4.5 + Zod schema + temperature 0.9). Chips render progressively via `experimental_useObject`. Template fallback retained in db.js.

**Previous (2026-05-12):** AI Co-pilot v2 Phase 2c — `AIImagePromptPanel.jsx` rewritten around `experimental_useObject` (ideas) + `useCompletion` (prompt). `/api/ai/image` switched to text-stream protocol on both modes. Body shape change on prompt mode (`details` → `prompt`). Idea cards now render PROGRESSIVELY as the JSON streams. **Track A complete** — all client-side AI surfaces on AI SDK native hooks; bespoke `parseSse` fully retired.

**Previous (2026-05-12):** AI Co-pilot v2 Phase 2b — `AICopyPreview.jsx` rewritten around `useCompletion`; `/api/ai/copy` switched to text-stream protocol. Body shape change `instruction` → `prompt`. Also a cleanup PR moving the two cached system blocks across all three routes from `messages` into the dedicated `system` parameter (silences AI SDK prompt-injection warning).

**Earlier (2026-05-12):** Phase 2a — `CopilotPanel.jsx` rewritten around `useChat` + AI Elements `MessageResponse`; `/api/ai/chat` switched to AI SDK UIMessage stream protocol; panel code-split via `React.lazy()`. Path-alias `@/*` added.

**Earlier (2026-05-11):** AI Co-pilot v2 migration kickoff — PoC, Phase 0 (Tailwind + shadcn foundation), Phase 0 hotfix (`--accent` collision), Phase 1a (`/api/ai/chat`), Phase 1b (`/api/ai/copy`), Phase 1c (`/api/ai/image` + PoC retirement), Phase 1 polish (cross-platform context). All server-side migration complete; wire protocol preserved through Phase 1 so existing client kept working untouched until Phase 2a/2b swap. Earlier same-day: Rebrand to **Linkrunner Media** + UX polish pass; daily-digest idempotency check added. Tracked end-to-end in [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md).

---

## Recent changes log

### 2026-05-19 — Brand proposals: copy-change proposals + word diff + red-dot indicator (PR 5 of 6)

Closes the brand → agency loop for copy edits, and lights up the agency's calendar with a red-dot indicator when any plan has a pending brand proposal awaiting review.

**Brand "Propose changes" flow:**
- New ghost-style **"Propose changes"** button in the status-action row when brand is viewing a `needs_review` or `approved` plan. Only renders if there isn't already a pending copy proposal on the plan.
- Click opens `ProposeCopyChangesModal`:
  - Per-platform tabs limited to the plan's targeted platforms.
  - Textarea per platform pre-filled with current copy; live word-diff preview block underneath the textarea, updates as the brand types.
  - Optional note textarea for the agency.
  - **Send proposal** button disabled until at least one platform's copy actually differs from the current.
- On Send → `createProposal({ kind: 'copy_change', payload: { copy_variants: { /* only changed platforms */ } }, note, userId })`. PR 1's `plan_proposals_emit_created_message` trigger emits "proposed copy changes for this plan." into the brand conversation as a subtle system message.

**Agency review surface:**
- `PendingCopyProposalCard` renders above the status pill row (alongside the date-change card from PR 4) — coral-tinted block with:
  - "Brand proposed copy changes" header + brand's optional note in italic.
  - Per-platform diff blocks, one per platform that changed. Each block has the platform chip + label + the word-level diff inline (red strikethrough for removed, green underline for added).
  - **Accept** (green) → merges `payload.copy_variants` into the plan's `copyVariants` (only the keys the brand touched; untouched platforms stay as agency had them) + marks proposal `'approved'`. PR 1's resolution trigger emits "accepted the proposed copy changes."
  - **Reject** (ghost) → just marks the proposal `'rejected'`; plan copy untouched. Trigger emits "rejected the proposed copy changes."
- Brand-side sees the same diff block but with "Awaiting agency review" instead of action buttons.

**Word-diff helper** (`web/src/lib/wordDiff.js`, new):
- `diffWords(oldText, newText)` returns a flat array of `{ type, text }` tokens (`'unchanged' | 'added' | 'removed'`).
- LCS-based, O(n*m). Whitespace is preserved as separate tokens so re-joining is lossless. Adjacent same-type tokens coalesce to keep the rendered DOM small.
- ~80 lines, no new dependency. If a future use-case needs longer inputs we can swap in jsdiff with the same return shape.
- `DiffView` component in `PostPlanDetailView.jsx` consumes the token array with the inline color treatment.

**Red-dot indicator on calendar chips:**
- Agency view only. Coral 8px dot sits next to the chip's existing unread-message dot (so a chip can show one, the other, or both — they don't collide).
- `unackedPlanIds: Set<planId>` state on `CalendarView`, computed from `loadAllPendingProposals()` filtered to `!acknowledgedAt`.
- Kept fresh via a `plan_proposals` Supabase realtime channel subscription scoped to the calendar lifetime.
- Threaded down to MonthGrid → PostChip via new prop `hasPendingProposal`. WeekPostCard / ListRow don't render the dot in v1 (month-view-only for now).
- Auto-acknowledge: when an agency user opens `PostPlanDetailView`, a useEffect calls `acknowledgeProposal(id)` for every unacknowledged pending proposal on the plan. The dot clears on the next calendar load / realtime tick.
- Brand v1 doesn't render the dot — they made the proposal, they know it's pending.

**No new migration** — PR 1's `plan_proposals` table, RLS policies (agency-only UPDATE/DELETE), and INSERT/UPDATE triggers cover the entire flow.

**Test plan:**
- Brand opens a `needs_review` or `approved` plan → sees "Propose changes" button alongside Approve.
- Click → modal opens with per-platform textareas pre-filled; type edits → live diff preview updates; Send proposal.
- Conversation thread gets a subtle italic "<brand> proposed copy changes for this plan." entry.
- Calendar chip for that plan now shows a coral dot on the agency's view.
- Agency opens the plan → coral notification card with per-platform word-diff + Accept/Reject + brand's note.
- Accept → plan copy updates with the brand's changes for the platforms they touched; conversation gets "<agency> accepted the proposed copy changes."; chip dot clears.
- Reject → plan copy untouched; "<agency> rejected the proposed copy changes." lands; chip dot clears.
- "Propose changes" button hides while a pending copy proposal exists (only one active at a time).
- Brand on their own pending copy proposal sees the same diff block with "Awaiting agency review" instead of buttons.

**Next:** PR 6 (final) — Resend email notifications on proposal arrival / resolution + a top-nav "X pending proposals" chip + drawer for agency to triage across brands.

### 2026-05-19 — Brand proposals: drag-to-propose date changes (PR 4 of 6)

Brand can drag any of their needs_review or approved post-plan cards on the calendar to a new day; instead of moving the plan directly, a "Propose a new date" modal opens. On send, a `plan_proposals` row of `kind='date_change'` lands; the agency sees an in-card Accept / Reject block on the plan detail view. Time of day is preserved — drag is date-only.

**Calendar (`CalendarView.jsx`):**
- New `dragMode` field on `decoratedPostPlans` per plan:
  - Agency on anything-not-posted → `'free'` (existing behaviour).
  - Brand on own `brand_draft` → `'free'`.
  - Brand on `needs_review` or `approved` → `'propose'` (opens the modal on drop).
  - Brand on own `proposed` / anything else → not draggable.
- Chip `draggable` prop now uses `p.canDrag` (the precomputed boolean) instead of `isAdmin && p.displayStatus !== 'posted'`.
- Drop-target cell handlers (`onDragOver` / `onDragLeave` / `onDrop`) and the drop-highlight `isDropTarget` flag no longer gate on `isAdmin` — drop is allowed wherever any chip is being dragged; the chip's own `canDrag` and the drop handler's `dragMode` branch decide what happens.
- `handleCellDrop` branches on `dragMode`: `'free'` does the existing optimistic `updatePostPlan({ scheduledAt })`; `'propose'` opens the modal with `{ plan, fromIso, toIso }` set.
- New `ProposeNewDateModal` component (top of CalendarView.jsx): from→to timestamps side-by-side, optional brand note textarea, Cancel / Send proposal buttons. Calls `createProposal({ planId, accountId, kind: 'date_change', payload: { scheduled_at }, note, userId })`. Escape / backdrop click cancels.

**Plan detail (`PostPlanDetailView.jsx`):**
- New `loadProposalsForPlan` + `resolveProposal` imports from db.js.
- Loads pending proposals on mount via `refreshProposals()` (also called after Accept / Reject to refresh local state).
- `pendingDateProposal = proposals.find(p => p.status === 'pending' && p.kind === 'date_change')` (newest first via load order).
- New `PendingDateProposalCard` component renders above the status pill row when `pendingDateProposal` is set:
  - Both sides see: "Brand proposed a new date" header, `<plan.scheduledAt> → <payload.scheduled_at>` timestamps, optional `proposal.note` in italic.
  - Agency sees Accept (green) + Reject (ghost) buttons.
  - Brand sees "Awaiting agency review" label.
- Agency Accept: `updatePostPlan(plan.id, { scheduledAt: payload.scheduled_at })` then `resolveProposal({ proposalId, status: 'approved' })`. PR 1's trigger emits "accepted the proposed date change." into the conversation.
- Agency Reject: just `resolveProposal({ proposalId, status: 'rejected' })`. Trigger emits "rejected the proposed date change."; plan stays at its original date.
- `busy` flag (`resolvingProposalId`) disables the buttons during the round-trip.

**Migration:** none. PR 1's `plan_proposals` table + RLS + INSERT trigger + UPDATE trigger already cover the entire flow.

**Test plan:**
- Brand opens calendar → drags an approved or needs_review plan to a different day → modal opens with from→to timestamps + note field.
- Send proposal → modal closes; plan card stays at original date (UI optimistically reverted); brand conversation gets a subtle italic "<brand> proposed a new date for this plan." entry.
- Agency opens that plan → coral notification block above status row with Accept + Reject + the brand's note.
- Accept → plan moves to the new date on both calendars; italic "<agency> accepted the proposed date change." lands in conversation; notification block disappears.
- Reject → plan stays put; italic "<agency> rejected the proposed date change." lands; notification block disappears.
- Same drag from the brand on an own `brand_draft` → free reschedule, no modal (matches the brand-owns-their-draft mental model).
- Brand drag on own `proposed` plan → blocked (chip non-draggable, already submitted).

**Next:** PR 5 — copy-change proposals + diff view + red-dot unread indicators on plan cards. (PR 6 is notifications + agency drawer.)

### 2026-05-19 — Brand proposals: brand creates new plans, explicit submit, subtle system messages (PR 3 of 6)

Brand users get their first-ever write action: a two-step **create → submit** flow on the calendar, with agency Accept/Reject on the resulting proposed plan. System messages in the brand conversation thread render in a compact, italic, low-contrast style so the lifecycle log doesn't visually compete with real DMs.

**Calendar (`CalendarView.jsx`):**
- `+ Propose plan` button replaces the agency-only `+ New post plan` button when `mode === 'customer'`.
- Per-day `+` button is now visible to brand too. Title attr varies by role: "Plan a new post on this day" (agency) vs "Propose a new post on this day" (brand).
- Week-view day header is now clickable for brand too. Title attr varies.
- Empty-list state CTA: "+ Propose a post now" for brand, "+ Plan a post now" for agency.
- `createStubAndOpen` passes `status: isAdmin ? 'drafting' : 'brand_draft'` to `createPostPlan`. Brand-side stubs land in a private editing state — no system message fires at stub create.
- `STATUS_GROUPS` gets a new `brand_draft` filter group (label "Draft"). `STATUS_ORDER` slots brand_draft alongside drafting.
- Sub-copy under "Social Calendar" updated for brand: "Click the + on any day to propose a new post — your agency will review."

**Plan detail (`PostPlanDetailView.jsx`):**
- New `isEditor = isAdmin || (status === 'brand_draft' && plan.createdBy === userId)` boolean. While in brand_draft (private state), the brand creator can edit title / copy / date / platforms / delete inline. Once they click "Propose plan" and status flips to 'proposed', the plan becomes read-only for them until the agency resolves.
- Field-edit gates throughout (title editing, date input, platforms toggle, copy textareas, click-to-edit preview, Delete plan button) gate on `isEditor`.
- Role-only features explicitly kept on `isAdmin`: status workflow buttons matrix, auto-title sparkle banner, Duplicate plan, AI Co-pilot AICopyPreview + AIImagePromptPanel, References / Deliverables subtitle / emptyText / upload / caption-edit gates.
- `statusBucket` learns a 5th value `'brand_draft'`.
- New status-action entries:
  - Brand on `brand_draft` (creator only) → **"Propose plan"** → `transitionStatus('proposed')`. This click flips status to 'proposed' and emits "proposed a new post plan." into the conversation (via migration 0050's status-change trigger).
  - Agency on `proposed` → **Accept** (→ drafting; existing trigger emits "accepted the proposed plan.") and **Reject** (`handleDelete()` with confirmation).
- Button click handler dispatches on `a.action === 'delete'` (Reject) vs `transitionStatus(a.next)` (everything else).

**Conversation thread system messages (`ConversationsView.jsx` + db.js + app.css):**
- `mapConversationMessageRow` exposes the `kind` column (was unmapped — `'user'` default or `'system'` for lifecycle events).
- `MessageBubble` branches on `message.kind === 'system'` to render the new compact variant: single line, italic, no avatar, no bubble chrome. Format: `<strong>Name</strong> verb-phrase. · time` plus the optional plan chip inline.
- New CSS class `.conv-msg-system` — `display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 4px 0; color: var(--ink-3); font-size: 12px; font-style: italic;`.

**Migrations:**
- `0049_brand_proposes_new_plan_message.sql`: AFTER INSERT trigger on `post_plans` that emits "proposed a new post plan." when `status='proposed'` on direct insert. Stays in place as a safety net for any code path that bypasses brand_draft.
- `0050_brand_draft_status.sql`: extends `post_plans.status` CHECK with `'brand_draft'`; adds `brand_draft → proposed` case to `emit_post_plan_status_message`; tightens `guard_post_plan_status_transitions` to allow brand `brand_draft → proposed` and refuse agency from setting `status='brand_draft'` (brand-only state).

**Test plan:**
- Brand opens calendar → sees `+ Propose plan` button, per-day `+`, empty-state CTA.
- Brand clicks any of them → stub created with `status='brand_draft'`, navigated to detail view. **No system message yet.** Status pill reads "Draft (not yet proposed)".
- Brand edits title, copy, date, platforms inline → all saves succeed.
- Brand clicks **"Propose plan"** → status flips to 'proposed', pill changes to "Awaiting agency review", system message "<brand> proposed a new post plan." appears in the conversation thread as a subtle italic event.
- Agency opens the proposed plan → sees Accept + Reject buttons.
- Agency clicks Accept → plan moves to drafting; subtle system message "<agency> accepted the proposed plan." appears.
- Agency clicks Reject → confirmation dialog → plan deletes; the original "proposed" system message stays as audit trail.

**Next:** PR 4 — drag-to-propose date changes on the calendar (brand drags an existing approved/needs-review plan → "Propose new date" popover → `plan_proposals` row with `kind='date_change'`).

### 2026-05-19 — Brand proposals: agency buttons + brand approval (PR 2 of 6)

Tightens the workflow surface so the new "only the brand can approve" policy lands end-to-end. Pure status/button cleanup — the proposal table from PR 1 is still dormant; PR 3 starts wiring it up.

**UI:**
- Remove the agency status dropdown in `PostPlanDetailView.jsx`. The old `<select>` with "Set: Drafting / Needs review / Approved" was the path agency used to accidentally set `'approved'` themselves; that path is gone.
- New `statusActions` matrix:
  - Agency on `drafting` → "Submit for review" (`→ needs_review`)
  - Agency on `needs_review` → "Recall to drafting" (`→ drafting`) — new, gives a way to pull back without a dropdown
  - Agency on `approved` → "Back to draft" (`→ drafting`) — unchanged
  - Brand on `needs_review` → "Approve" (`→ approved`) — unchanged
- `statusBucket` learns a 4th value `'proposed'` so a brand-originated plan (shipping in PR 3) renders distinctly from drafting.
- `transitionStatus` and `confirmPendingTransition` rewritten to await `updatePostPlan` directly and revert local state on failure, so the new DB guard's `raise exception` doesn't leave the UI showing a phantom transitioned state.

**Status pill labels** (`postPlanShared.jsx STATUS_CONFIG`):
- New `proposed` entry — label "Awaiting agency review", coral tint `#C44A2C`.
- `needs_review` relabeled from "Needs review" → "Awaiting brand approval", same mustard tint.
- Legacy aliases (`needs_brand_feedback`, `needs_admin_revision`) follow the same new label so any cached row that slips through stays consistent.

**Calendar filter** (`CalendarView.jsx STATUS_GROUPS`): added a `proposed` filter group (label "Proposed", maps to `displayStatuses: ['proposed']`) so the agency can filter to brand-originated plans once PR 3 lands.

**Migration `0048_brand_proposals_status_guard.sql`:**
- New `guard_post_plan_status_transitions()` function + `BEFORE UPDATE of status` trigger on `post_plans`.
- Rules:
  - Agency cannot set `status='approved'` (approval is brand-exclusive). Raises `POST_PLAN_AGENCY_CANNOT_APPROVE`.
  - Brand can only set `status='approved'`, and only when the row is currently in `needs_review`. Raises `POST_PLAN_BRAND_FORBIDDEN_STATUS` or `POST_PLAN_BRAND_APPROVE_FROM_NEEDS_REVIEW`.
- Service-role / SECURITY DEFINER contexts (cron, edge functions, migrations) bypass the guard via `if auth.uid() is null then return new;` so server-side automation isn't constrained.
- Non-status UPDATEs (concept, copy, scheduled_at, platforms) are unaffected — the trigger early-returns when status hasn't changed.

**Test plan:**
- As agency, click "Submit for review" on a drafting plan → moves to needs_review, system message lands in conversation thread.
- As agency, click "Recall to drafting" on a needs_review plan → moves back to drafting, system message lands.
- As agency, try to UPDATE `post_plans.status = 'approved'` via PostgREST → 400/error from the trigger.
- As brand, click "Approve" on a needs_review plan → moves to approved, system message lands.
- As brand, try to UPDATE to anything other than approved → trigger refuses.
- Existing approved plans render with green "Approved" pill (unchanged).
- Existing `needs_review` rows now show "Awaiting brand approval" instead of "Needs review".

**Next:** PR 3 wires up brand-side "Propose plan" CTA on the calendar, agency-side accept/reject modal for new-plan proposals, and updates the AI Co-pilot brand-side button label from "Submit for review" to "Propose plan".

### 2026-05-19 — Brand proposals: foundation (PR 1 of 6)

Schema-only migration. Lays the rails for brand users to write to the calendar through an agency-approval gate.

**Schema:**
- `post_plans.status` check constraint extended: now `('drafting', 'needs_review', 'approved', 'proposed')`. The new `'proposed'` value is used when a brand creates a whole new plan; the agency reviewer flips it to `'drafting'` (accept) or deletes the row (reject).
- New `plan_proposals` table for edit-proposals against existing plans. Columns: `id`, `post_plan_id` (FK), `account_id` (FK, denormalized for RLS speed), `proposed_by` (FK profiles), `kind in ('new_plan' | 'date_change' | 'copy_change')`, `payload jsonb`, `status in ('pending' | 'approved' | 'rejected')`, `note`, `agency_response`, `created_at`, `resolved_at`, `resolved_by`, `acknowledged_at`. Indexes on `(post_plan_id, created_at desc)` and partial `(account_id, created_at desc) where status = 'pending'`.
- `conversation_messages` grows a `kind` column (`'user'` default, `'system'` for lifecycle events). Client INSERT policy tightened to `kind = 'user'`; SECURITY DEFINER triggers below bypass that to emit system rows.

**RLS:**
- `plan_proposals_select`: agency staff OR account members of `account_id`.
- `plan_proposals_insert`: any auth user with account access, must self-author (`proposed_by = auth.uid()`).
- `plan_proposals_update_agency` / `plan_proposals_delete_agency`: agency-only.

**Triggers:**
- `check_plan_proposal_account_match` (BEFORE INSERT/UPDATE) — asserts `plan_proposals.account_id` equals the parent plan's `account_id`; raises otherwise.
- `emit_post_plan_status_message` (AFTER UPDATE of status) — emits a `kind='system'` row in the brand's conversation thread with verb-phrased text per transition ("sent this plan for brand review.", "approved this plan.", etc.).
- `emit_plan_proposal_created_message` (AFTER INSERT) — emits "proposed a new post plan." / "proposed a new date for this plan." / "proposed copy changes for this plan." into the conversation thread.
- `emit_plan_proposal_resolved_message` (AFTER UPDATE of status) — only fires on `pending → approved/rejected`; emits the matching accept/reject message.
- `stamp_plan_proposal_resolution` (BEFORE UPDATE of status) — auto-fills `resolved_at` / `resolved_by` on pending → resolved.
- Shared helper `emit_plan_system_message(p_account_id, p_plan_id, p_actor_id, p_body)` looks up the brand's conversation row by `account_id`, inserts a `kind='system'` message with the plan auto-tagged via `tagged_post_plan_id`.

**Realtime:** `plan_proposals` added to the `supabase_realtime` publication.

**JS helpers** (`web/src/lib/db.js`): `loadProposalsForPlan`, `loadPendingProposalsForAccount`, `loadAllPendingProposals`, `createProposal`, `resolveProposal`, `acknowledgeProposal`. Thin wrappers over PostgREST; no business logic — triggers do the lifting.

**Migration:** `0047_brand_proposals_foundation.sql`. Idempotent on the `kind` column add (`if not exists`) and the policy recreate (`drop policy if exists`). Existing data unaffected: no backfill, no row touches, no system messages emitted for historical status changes (triggers only fire on new UPDATEs).

**Next:** PR 2 in this series replaces the agency status dropdown with explicit "Send for review" / "Recall" buttons, adds the brand-side "Approve" / "Propose changes" buttons on `needs_review` plans, and tightens RLS so agency can no longer self-approve (`approved` becomes brand-exclusive). PRs 3-6 build the proposal UX on top of this foundation.

### 2026-05-15 — Post-plan attachments: editable captions
Small but high-value UX add on the attachments grid. Files have always had a `filename` (the original upload name, used for downloads), but agency teams want a human-readable label they can edit *after* upload — so a grid of references reads as *"Hero close-up"* / *"Maya's testimonial frame"* / *"Backup B-roll"* instead of *"IMG_2384.jpg"* / *"FINAL_v3_REAL.mov"*.

**Schema:** migration `0046_post_plan_attachment_caption.sql` does two things:
- Adds a nullable `caption text` column on `post_plan_attachments`. No data migration — existing rows stay null and the UI falls back to filename.
- **Fills an RLS gap discovered during initial testing:** migration 0021 had defined SELECT/INSERT/DELETE policies on `post_plan_attachments` but no UPDATE policy. With RLS enabled, the default for missing policies is deny — caption saves were failing silently with PostgREST's *"Cannot coerce the result to a single JSON object"* error (the UPDATE matched 0 rows, the chained `.select().single()` then errored). New `post_plan_attachments_update_own_or_agency` policy mirrors the existing DELETE policy: uploader OR agency. Migration is idempotent (`add column if not exists`, `drop policy if exists` before create) so it's safe to re-run if a partial version is already in place.

**Tile UI (`PostPlanDetailView.jsx` -> `AttachmentTile`):**
- **Primary label**: caption when set, **otherwise the filename itself** (no italic placeholder, no "Add a caption..." prompt -- the filename IS the default caption visually). Click the label to edit.
- **Secondary line**: when caption is set, this becomes `<filename> | uploader | size` (compact). When caption is empty (filename is the primary), it's `<uploader> | <size>`.
- **Edit affordance**: agency-only. Hover reveals a small pencil icon next to the label. Click the label OR the pencil flips to an inline `<input>` (autofocus, `maxLength=280`, Enter blurs/saves, Escape reverts, blur saves). The input is **pre-filled with the current displayed label** (caption if set, filename if not) so the agency can tweak rather than re-type from scratch.
- **No-op on identity save**: if the user saves the input without changing it from the filename, the client normalizes to `null` so we don't store a redundant copy of the filename as the caption.
- **Brand users**: see captions read-only. The label is whatever the agency set (or the filename if nothing was set), and the pencil never appears.

**Lightbox:** header uses caption when present (falls back to filename otherwise). The Download button always uses `filename` regardless -- captions don't have extensions, and a downloaded file with no extension breaks downstream tooling.

**Save path:**
- Client: new `updatePostPlanAttachment(id, { caption })` helper in `web/src/lib/db.js`. Empty/whitespace-only input is normalized to `null` server-side so list views can fall back to filename uniformly without an empty-string edge case. Caps caption length at 280 chars defensively.
- UI: optimistic -- the tile updates immediately on save, then persists. On failure the previous value is restored and the error is alerted.

**Touched files:**
- [supabase/migrations/0046_post_plan_attachment_caption.sql](supabase/migrations/0046_post_plan_attachment_caption.sql) -- new column + missing UPDATE policy.
- [web/src/lib/db.js](web/src/lib/db.js) -- `caption` in the row mapper; new `updatePostPlanAttachment` helper.
- [web/src/components/PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) -- `AttachmentTile` caption editor; `handleAttachmentCaptionEdit` optimistic-update handler; threading `onCaptionEdit` through `AttachmentsCard`.

**Operator action required (the user does this, not Claude):**
- Apply migration `0046_post_plan_attachment_caption.sql` via the Supabase Dashboard's SQL editor (or `supabase db push` if the CLI is available). It's an `ALTER TABLE ADD COLUMN` plus a `CREATE POLICY`; both are idempotent (safe to re-run if a partial version was applied earlier).

- **Sections touched:** Recent changes log; `Last updated`; §6 Migrations (new `0046_post_plan_attachment_caption.sql` row — full §6 sweep deferred); §6 Data model (post_plan_attachments gained `caption text` — covered in this entry's body).

### 2026-05-15 — AI Co-pilot: refresh produces fresh suggestions + scroll detaches during streaming
Two small but visible UX wins on the Co-pilot panel, bundled.

**(1) Refresh button was returning the same suggestions.** Temp 0.9 alone isn't enough — Anthropic models converge on near-identical output for identical (within-day) prompts. The route now takes a `previousSuggestions: string[]` argument, the client accumulates every suggestion the admin has been shown into a session-local ref (`seenSuggestionsRef`, capped at 16 entries, deduped case-insensitively), and the prompt explicitly names them with a "DO NOT repeat or paraphrase any of these — pick genuinely different angles" block. A 6-char nonce is also injected on every call so even the first refresh in a session lands a byte-different user message. Brand switch clears the accumulator (would over-constrain the new brand otherwise). While the refresh is in flight, the previously-rendered chips are hidden via a `refreshingSuggestions` flag so the admin sees a clear "new ones coming" beat instead of the stale chips lingering ~500ms until the new stream produces output.

**(2) Scroll was being pulled down on every streamed token.** Made it impossible to read earlier messages mid-generation. Added stick-to-bottom logic with a `SCROLL_SLOP = 64` tolerance: a `stickToBottomRef` flag is maintained by a single scroll listener on the message container, updated to `(scrollHeight - scrollTop - clientHeight) <= SLOP`. The auto-scroll effect now bails out when the user is detached. Scrolling back within 64px of the bottom re-engages auto-follow. When the user is detached AND the model is mid-stream, a "New tokens below ↓" pill surfaces above the composer; clicking it scrolls to the bottom and the scroll listener picks that up to flip stickiness back to true. Slop of 64px is generous enough that a single streamed token (a few chars / pixels) never accidentally marks the user as detached between scroll-event firings.

**Touched files:**
- [web/api/ai/suggestions.ts](web/api/ai/suggestions.ts) — `previousSuggestions` request field; per-call nonce; user-message rewrite with explicit anti-repetition block.
- [web/src/components/CopilotPanel.jsx](web/src/components/CopilotPanel.jsx) — `seenSuggestionsRef` + `refreshingSuggestions` for fix #1; `stickToBottomRef` + scroll listener + `detached` state + jump-to-latest pill for fix #2.
- [web/src/styles/app.css](web/src/styles/app.css) — `.copilot-jump-latest` rule for the pill.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (suggestions input-schema doc — covered inline; no new route). No schema change, no migration.

### 2026-05-15 — AI Co-pilot: commit proposed post plans only when the admin opens them
Behaviour shift on the `create_post_plan_draft` tool. Previously, the model calling the tool inserted a row into `post_plans` immediately; the inline tile in the chat was just an "Open plan →" link to that already-created row. Result: when the model proposed five plans in one thread, all five landed on the calendar even if the admin only cared about two — five "✨ AI draft" tiles to triage later, easy to lose track of.

**The change:** the tool's `execute()` no longer writes to the DB. It returns the proposed payload (`{ proposed: true, scheduled_at, platforms, concept, copy_variants, status }`) and the chat history carries the proposal. The DB INSERT moves to the client, in a new `commitAiDraftPlan({ accountId, userId, draft })` helper in `web/src/lib/db.js`, fired by the ToolCard's "Open plan" click handler. Only proposals the admin actually clicks become rows.

**Card UI states:**
- **Running** → "Drafting a post plan…" (unchanged).
- **Output ready, not yet committed** → "Drafted a post plan — open to add" + the "Open plan →" CTA is now a commit-and-navigate action.
- **Committing** → button disabled with "Adding to calendar…".
- **Committed** → "Added to the calendar" + subsequent clicks of "Open plan" just navigate (idempotent via local `committedId` state on the ToolCard).
- **Commit error** → inline error string, button re-enabled so the admin can retry.

**Idempotency / refresh handling:**
- Within a single session, repeat clicks on the same card after a successful commit don't double-insert — the ToolCard remembers the new `planId` in local state.
- Across page refreshes, since chat history is currently in-memory (DB-backed conversation persistence is parked), the proposal disappears with the chat. The admin would need to ask again to re-propose. Acceptable: the explicit user-affirmation model is the whole point of the change.

**Tool description + system prompt** were rewritten to match. The model's narrative for the post-tool-call reply now frames the post as a proposal ("I've drafted a plan for X — open it to add to the calendar") rather than as something already on the calendar. Misalignment between what the model says and what the calendar shows would be very confusing otherwise.

**Backwards compatibility:** if any older chat history still has a tool result with a real `id` (pre-change shape), the ToolCard treats it as already-committed and the click goes straight to navigate — no double-insert.

**Touched files:**
- [web/api/ai/chat.ts](web/api/ai/chat.ts) — tool execute() body + tool description + system-prompt bullet for `create_post_plan_draft`.
- [web/src/lib/db.js](web/src/lib/db.js) — new `commitAiDraftPlan({ accountId, userId, draft })` helper.
- [web/src/components/CopilotPanel.jsx](web/src/components/CopilotPanel.jsx) — ToolCard takes an `onCommitDraft` prop; tracks per-card `committedId` / `committing` / `commitError`; headline flips between "Drafted a post plan — open to add" and "Added to the calendar".
- [web/src/App.jsx](web/src/App.jsx) — wires the `onCommitDraft` handler that calls `commitAiDraftPlan` and seeds App-level state via `upsertPostPlan` so the calendar reflects the new row immediately.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (tool-side behaviour of `create_post_plan_draft` — documented in this entry's body; full §10 sweep deferred).

### 2026-05-15 — Reset window scroll on forward SPA navigation
Tiny but visible UX bug: opening a post plan from the calendar landed the user mid-page (typically near the Copy card) instead of at the top. Root cause was React Router doing client-side route changes — the browser preserves the previous page's scroll-y on those, so the y-pixel position from the calendar carried straight into the detail view. With both pages having similar vertical extent, this consistently put the user near the middle of the new page.

**Fix:** one `useEffect` in [App.jsx](web/src/App.jsx) keyed on `location.pathname`, calling `window.scrollTo(0, 0)` on every PUSH / REPLACE navigation. Gated on `useNavigationType() !== 'POP'` so back/forward browser navigation still restores the previous scroll position — the browser's default `history.scrollRestoration: 'auto'` handles that case correctly and we don't want to override it ("take me back to where I was in the calendar" should still work).

Applies globally to every route in the SPA, not just post-plan opens. No per-route override needed — every forward nav resets to top, every back/forward restores.

- **Sections touched:** Recent changes log; `Last updated`. No data model, route, or integration changes.

### 2026-05-15 — Shorter post-plan headlines (concept field)
Tightens both auto-generation paths for the post plan `concept` field so calendar chips and detail-view headlines fit in **5-10 words**, not the 15-20 word sentences we were seeing. Two surgical changes:
- **AI Co-pilot path** (`create_post_plan_draft` tool in `web/api/ai/chat.ts`): the zod field description was *"Short (1-2 sentence) concept for the post — what it's about, what angle"*, which led the model to write full descriptive sentences. Rewritten to demand a *"Very short HEADLINE… TARGET 5-10 words, single phrase, NOT a full sentence"* with concrete GOOD examples (*'Spring drop teaser'*, *'Customer story: Maya'*, *'Holi limited-edition launch'*, etc.) and one BAD example (the kind of full-sentence concept we don't want). Hard cap added: `.min(3).max(80)` — if the model overshoots, zod fails the tool call and the SDK's existing `experimental_repairToolCall` flow re-prompts with the validation error attached.
- **Auto-title path** (`AUTO_TITLE_MAX_LEN` in `web/src/components/PostPlanDetailView.jsx`): dropped from 60 → 50 chars. 50 covers ~5-10 words in English (avg ~5 chars/word + spaces). The first-sentence-preference logic still keeps short complete sentences intact; long opening lines truncate at the last word boundary with an ellipsis. Verified across the existing test set — all sample inputs now land in the 5-10 word target band.

No schema change, no migration, no behaviour change beyond the cap and prompt tightening. Pre-existing post plans keep their existing concepts.

- **Sections touched:** Recent changes log; `Last updated`. §10 Edge functions / API routes (`create_post_plan_draft` schema doc inline) — no new route, just description tightening.

### 2026-05-15 — Calendar: drag post chips to reschedule (date-only)
Month + Week views now let agency users drag a post chip from one day cell to another to reschedule it. Time-of-day is preserved (the drop only changes the date portion of `scheduled_at`); same-day drops are no-ops. **Posted plans are non-draggable** — they show in the calendar but the dragging affordance is suppressed since the post is already live. Brand users see no drag affordance at all. HTML5 drag-and-drop, no new dep. Dragging marks the source chip at 40% opacity (cursor flips to `grabbing`); the hover cell gets a dashed accent outline + tinted background. Drop fires `updatePostPlan(id, { scheduledAt })`; updates are **optimistic** — the chip jumps to the new cell immediately, then the server write happens in the background. On failure the optimistic move is reverted and the error is alerted. Drag payload uses a custom MIME (`application/x-lr-plan-id`) so OS file drags / foreign image drags don't trip the drop handler. Drag state lives on `CalendarView` (not the grids) so both views stay consistent. New `onPlanChanged` prop on `CalendarView` wired to `upsertPostPlan` in `App.jsx` (same upsert that powers `PostPlanDetailView` writes). Pure UX; no schema change, no new route, no new dep.

- **Sections touched:** Recent changes log; `Last updated`. No data model, route, or integration changes.

### 2026-05-15 — Post plan: auto-fill title from first saved copy
Tiny UX win on `PostPlanDetailView`. When an admin saves the FIRST piece of copy on a still-untitled post plan, the `concept` field is now slotted with a derived title in the same write — so the calendar and lists stop showing "Untitled post" as soon as there's real content. Pure client-side string transform (no AI call): grabs the first non-empty line, strips leading emoji/punctuation (via `\p{Extended_Pictographic}` + `\p{P}`), prefers a complete short sentence if one exists, truncates at the last word boundary to 60 chars with a `…` suffix. **Fires exactly once per plan** — guarded by `!plan.concept` AND "no saved copy on any platform yet" (read from `plan.copyVariants`), so a cleared title won't re-fill on the next copy save. A dismissible callout (sparkles icon + "Titled this post from your copy" + Undo) renders below the title to surface what happened; Undo restores empty and clears the notice. Pure-emoji and whitespace-only first lines correctly fall through without setting a title. Lives entirely in `web/src/components/PostPlanDetailView.jsx`; no schema change, no new route, no new dep.

- **Sections touched:** Recent changes log; `Last updated`. No data model, route, or integration changes.

### 2026-05-15 — "L+R Agency" → "Linkrunner Media" rebrand sweep
Cleanup pass on the rebrand that originally shipped 2026-05-11. The Sidebar wordmark + the `<title>` swapped then, but a handful of secondary surfaces and the deployed Supabase secret got missed.

**Surfaces flipped (user-facing):**
- [LoginModal.jsx:185-186](web/src/components/LoginModal.jsx:185) — wordmark `<span>L+R</span><span className="wordmark-tail">Agency</span>` → `<span>Linkrunner</span><span className="wordmark-tail">Media</span>`. This is the modal anyone sees pre-sign-in.
- [BrandOnboardingModal.jsx:248-249](web/src/components/BrandOnboardingModal.jsx:248) — same wordmark on the first-run brand-onboarding modal.
- [TaskDetailView.jsx:631](web/src/components/TaskDetailView.jsx:631) — conversation card subtitle: "messages between {brand} and L+R" → "… and Linkrunner Media".
- [TaskDetailView.jsx:656](web/src/components/TaskDetailView.jsx:656) — admin-mode reply placeholder: "Reply as L+R…" → "Reply as Linkrunner Media…".
- [auth.js:96](web/src/lib/auth.js:96) — agency-owner role label: "Agency Owner, L+R" → "Agency Owner, Linkrunner Media". Shows in the profile pill / user menu.

**Deployed Supabase secret:**
- The `EMAIL_FROM_NAME` Supabase Edge Function secret was still set to `"L+R Agency"`, overriding the code default of `"Linkrunner Media"`. **That's why outbound Resend emails were still showing "L+R Agency" in the `From` header even though the code had been changed.** Updated the secret to `"Linkrunner Media"` (or removed it entirely so it falls back to the code default — either works). User did this via Dashboard → Project Settings → Edge Functions → Secrets. No redeploy needed.

**Doc-drift in REFERENCE.md fixed (5 lines):**
- `EMAIL_FROM_NAME` default in §10 secrets list rewritten from `L+R Agency` → `Linkrunner Media`.
- team-invite subject documentation: `"X invited you to {workspace} on L+R Agency"` → `"… on Linkrunner Media"` (matches what's been in the code since the 2026-05-11 rebrand).
- agency-update default subject: `"Update on {brand} from L+R Agency"` → `"… from Linkrunner Media"`.
- The EMAIL_FROM_NAME column in the env-var table.
- The example `supabase secrets set` command in §10.
- The "what the recipient should see" prose in the Reply-To design-note (§13).

**Preserved as-is** (intentionally):
- The three 2026-05-11 changelog entries describing the rebrand itself (REFERENCE.md lines 513/514/522). Those are historical and need to keep the old name to make sense.
- `web/src/components/Sidebar.jsx:262` — a code comment mentioning "L+R". Not user-facing.
- `web/src/lib/mockData.js:23, 152` — seed/mock data only; never reaches production.

**Sections touched:** Recent changes log; `Last updated`; §10 Edge functions (`send-email` template subject docs + `EMAIL_FROM_NAME` env table + `supabase secrets set` example); §13 Known decisions (Reply-To note).

### 2026-05-15 — Engagement refresh cron: moved to Supabase pg_cron + Edge Function
Vercel Hobby was capping engagement throughput at 5 scrapes/day (1 cron-fire × 60s timeout × ~10s/scrape). Today only 5 of 7 eligible Bamboo Bear + Epigamia publications were getting refreshed daily; the rest rotated in over multiple days. Once we onboard more brands, that math breaks badly. Moved the cron orchestrator off Vercel onto Supabase.

**The move:**
- New Edge Function `supabase/functions/engagement-refresh/index.ts` — Deno port of the old Vercel route. Same tier cadence (daily / 3-day / weekly based on publication age) and same "oldest-snapshot-first" priority sort, with two upgrades enabled by the bigger budget: `Promise.allSettled` chunks of 3 + per-run cap of 20 (was serial + 5).
- Scraper logic (IG / LinkedIn / X dispatchers) is inlined into the Edge Function rather than shared from `scraper-lib.ts`. Different runtime (Deno vs Node), so a clean inline copy beats fragile cross-runtime imports. The Vercel route `/api/engagement/refresh` (on-paste auto-refresh, user-triggered) still imports from `scraper-lib.ts` and is unchanged.
- Trigger is a pg_cron job inside Postgres that calls the Edge Function via `pg_net.http_post()`. `CRON_SECRET` + project URL are stored in Supabase Vault so the cron statement doesn't hardcode them.
- Schedule tightened to `30 0 * * *` UTC = **6:00 AM IST** (the old Vercel cron was `0 1 * * *` = 6:30 AM IST; the user expected 6:00, and pg_cron has no platform-side scheduling drift so it actually fires on-the-minute now).
- Per-run cap is 20 publications today. At Pro-Supabase 400s wall-clock × `Promise.allSettled` of 3, we have ~80-100s of headroom; bump the cap as scale grows. To re-cadence (e.g. hourly), `SELECT cron.unschedule(...)` + `SELECT cron.schedule(...)` with a new cron expression — no code change, no redeploy.

**Observability:**
- New table `public.cron_run_log` (append-only, agency-read RLS) — every fire writes one row with `started_at`, `finished_at`, `duration_ms`, `status`, `pubs_eligible`, `pubs_due`, `pubs_processed`, `pubs_failed`, `pubs_blocked`, `error_message`, and a `details` jsonb of per-publication scrape outcomes. Single SELECT answers "did the cron run today and what did it do?". Replaces hunting through edge function logs.
- pg_net's `net._http_response` table holds the raw HTTP response from the cron call (the pg_net call is fire-and-forget from cron.job's perspective).
- Email alerts on failure are intentionally deferred. The cron_run_log row already carries enough detail to debug; pushing them via Resend needs a new `send-email` template, which is a follow-up.

**What was removed:**
- `web/api/engagement/refresh-cron.ts` — deleted.
- `vercel.json` — removed the `/api/engagement/refresh-cron` cron entry and the `api/engagement/refresh-cron.ts` functions entry. Brings the project back from 3 Vercel crons (over Hobby's 2-cron limit) down to 2: `/api/daily-digest` + `/api/trends/refresh-cron`.

**Operator action required (the user does these, not Claude):**
1. **Apply the migration** `supabase/migrations/0045_engagement_refresh_cron.sql` via the Supabase Dashboard's SQL editor or `supabase db push`. This installs `pg_cron` + `pg_net`, creates `cron_run_log`, seeds two placeholder Vault rows, and registers the `engagement-refresh-daily` cron job.
2. **Set the two Vault secrets** in Supabase Dashboard → Project Settings → Vault:
   - `engagement_cron_secret` ← the same value as Vercel's `CRON_SECRET` env var.
   - `engagement_project_url` ← `https://<project-ref>.supabase.co`.
   These start as `REPLACE_ME` placeholders so the migration applies cleanly; the cron won't actually authenticate until the operator overwrites them.
3. **Deploy the Edge Function** — `supabase functions deploy engagement-refresh` (or paste into the Supabase Dashboard if the local PAT is still 403'ing on multipart).
4. **Set the function's `CRON_SECRET` secret** — `supabase secrets set CRON_SECRET=<same-value-as-Vercel>` (or via Dashboard → Edge Functions → engagement-refresh → Secrets). The function reads `Deno.env.get("CRON_SECRET")` to validate the bearer.

**Verify after applying** (queries in the migration's footer comment, also reproduced here):
```sql
-- Schedule exists?
select jobname, schedule, command from cron.job where jobname = 'engagement-refresh-daily';
-- Vault populated?
select name, decrypted_secret from vault.decrypted_secrets where name in ('engagement_cron_secret','engagement_project_url');
-- Manually trigger (skip the wait for next 6 AM IST):
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_project_url')
         || '/functions/v1/engagement-refresh',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')),
  body := '{}'::jsonb
);
-- What did the run do?
select * from cron_run_log order by started_at desc limit 5;
```

**Sections touched**: Recent changes log; `Last updated`; §6 Migrations (new `0045_engagement_refresh_cron.sql` row); §10 Edge functions / API routes (new `engagement-refresh` Supabase Edge Function — covered in this entry's body for now, full §10 sweep deferred); §13 Known decisions (new entry: "engagement cron on Supabase pg_cron + Edge Function over Vercel cron, to lift Hobby's 1-cron-fire/day × 60s × 5-scrape ceiling without paying for Vercel Pro").

### 2026-05-14 — Live Posts engagement: X re-enabled via scrape.badger
Reverses the 2026-05-12 "X intentionally skipped" decision after a second-pass actor shootout found a viable tweet-by-ID Apify actor.

**Why it works now (and why it didn't before):** the first preflight burned credit on Apify's headline X scrapers (`apidojo/tweet-scraper`, `kaitoeasyapi/...`, etc.) — all of which take `startUrls` for profile/search/list URLs, NOT individual tweet URLs. They returned demo data or 10-row default-sort tweets for any tweet URL we threw at them. The external option (TwitterAPI.io) was a clean fit on paper but their Google OAuth signup is locked in Testing mode, blocking new accounts. The second pass dug deeper into Apify Store and found:

- **`scrape.badger/twitter-tweets-scraper`** — $0.0002/result ($0.20/1K, comparable to LinkedIn at $0.001), 700k runs, 1.2k users. Takes `{ id: "<numeric tweet id>" }` — confirmed by real-data run against a Bamboo Bear tweet (returned `views: 82`, `favorite_count: 0`, `retweet_count: 0`, full text + author + avatar). **Primary candidate, shipped.**
- `pratikdani/twitter-posts-scraper` — works with `{ url }` input but priced at $0.02/result ($20/1K, 100× the badger actor). Documented in the preflight as a fallback only.

**What ships:**
- `web/api/engagement/scraper-lib.ts` — new `scrapeX(liveUrl)` mirrors `scrapeInstagram` / `scrapeLinkedIn`. Extracts tweet id from `/status/<id>`, POSTs `{ id }` to scrape.badger via `run-sync-get-dataset-items`. Normalizes `favorite_count` → `like_count`, `retweet_count` → `share_count`, probes several candidate field names for view/reply/bookmark/quote counts (`view_count` / `views` / `viewCount` / `impression_count`, etc.) since those weren't in the visible-20-key snapshot. `availability_notes` reports which probes came back null so the UI can render `—` honestly.
- `dispatchScrape(platform, liveUrl)` now handles `x`. The route's 501 branch stays as a safety net for any future platform we add to the DB enum without a scraper.
- `web/api/engagement/refresh-cron.ts` — eligible platforms list grows: `["instagram", "linkedin", "x"]`.
- `web/src/components/PostPlanDetailView.jsx` — `AUTO_REFRESH_PLATFORMS` Set grows to include `'x'`. On-paste auto-refresh fires for X publications alongside IG/LinkedIn.
- `web/src/components/LivePostsView.jsx` `LiveTile` — the dashed "X engagement not tracked" badge is gone; X tiles now render the standard "Refresh now" button + metrics row, same shape as IG/LinkedIn tiles.

**Cost impact:** at 5 X posts × ~30 scrapes/month per the daily cron, X adds ~3¢/month at Bamboo Bear scale. Full 10-brand rollout at 5 X posts each → ~$0.30/month for X across the agency. Still comfortably inside Apify free-tier credits.

**Open follow-up:** scrape.badger's full output schema beyond the first 20 keys is untested for reply/bookmark/quote counts. After the first cron run lands in production, look at one snapshot's `raw_payload` in Supabase Studio to see what fields actually exist — if reply_count or bookmark_count are there under different names than the normalizer probes, add them. Until then the metrics row shows `—` honestly for missing fields.

### 2026-05-14 — AI Co-pilot web search + daily trend snapshots (PR 3 of N)
Third PR in the AI Co-pilot upgrade series. Closes the "model doesn't know what's trending right now" gap with a hybrid: a cheap daily-refreshed cache (always-on, proactive) plus an on-demand web-search tool (responsive). Layered on top of PR 2's skills work.

- **Migration `0044_brand_trend_snapshots`** — new append-only table `brand_trend_snapshots` (id, account_id FK, fetched_at, query, source_url, title, summary, published_at, raw_payload jsonb, source, scrape_status, error_message). One row per (brand × query × URL × day). Indexes on `(account_id, fetched_at desc)` and `(account_id, source_url)`. RLS mirrors `post_engagement_snapshots`: agency staff + brand members SELECT; service-role-only writes. Added to `supabase_realtime`.
- **New `/api/trends/refresh-cron`** — Vercel Cron, daily at `30 0 * * *` (06:00 IST). For each brand in `AI_COPILOT_BRAND_IDS`, fires 2 Firecrawl `/search` queries:
  1. Industry trends — `"${industry} trends ${year}"`
  2. Hashtag pulse — first 3 tracked hashtags joined with the industry
  Top 5 results per query, deduped by URL across queries, written into `brand_trend_snapshots`. Failed calls write a single error row so the brand-context loader can decide whether to surface stale data. ~2 Firecrawl credits per brand per day, scoped to allowlisted brands only.
- **Brand-context compiler grows `## Industry signals (recent trend articles)`** — pulled by `loadAndCompileBrandContext({ includeCalendar: true })` (chat route only). Latest snapshots per brand, max 7 days old, deduped by URL, capped at 8 entries. Each entry: age tag ("today" / "yesterday" / "N days ago"), title, summary, source URL. ~1-2K cached tokens when present. Empty section drops out cleanly when no data.
- **New `web_search(query)` tool on `/api/ai/chat`** — Firecrawl `/search`, top 5 results returned as `{ query, result_count, results: [{ url, title, summary, published_at? }] }`. Costs ~1 Firecrawl credit per call. The system prompt instructs the model to lean on the cached `## Industry signals` first and only fire `web_search` for information not already there (specific recent events, competitor announcements, niche topics, fresh data for "today" / "this week" framings).
- **System prompt updates** — proactive-opening rule now names `## Industry signals` as one of the things to lead with. New "Use Industry signals before searching" rule prevents speculative web_search calls.
- **CopilotPanel polish** — ToolCard + CopilotStatus learn `web_search` headlines:
  - Running: `Searching the web for "sustainable fashion India trends"…` (or `Searching the web…` if no query yet)
  - Done: `Read 5 results from the web` / `Searched the web`
- **vercel.json** — new function entry `api/trends/refresh-cron.ts` (maxDuration 60), new cron schedule `30 0 * * *` for `/api/trends/refresh-cron`.
- **Operator action required after deploy**:
  1. Apply migration `0044_brand_trend_snapshots.sql` via Supabase dashboard or CLI before the cron lands its first batch.
  2. Verify `FIRECRAWL_API_KEY` is set in Vercel project env across all 3 environments (already set per prior PRs — `find-competitors.ts` uses it too).
- **Sections touched**: Recent changes log; `Last updated`. §6 Data model (new `brand_trend_snapshots` table — will sweep in a follow-up doc pass). §10 Edge functions (new cron route + new chat tool — covered in this entry's body for now).

### 2026-05-14 — AI Co-pilot marketing skills (PR 2 of N)
Second PR in the AI Co-pilot upgrade series. Gives the model deep marketing playbooks it can pull on demand, instead of relying purely on its general training. Layered on top of PR 1's calendar/context work.

- **7 playbooks bundled** at [web/src/data/skills/](web/src/data/skills/) — each is a directory with a `SKILL.md` top-level playbook and an optional `references/` subdirectory for deep-dive material:
  - **social-content** (7,940 chars + 3 references) — platform conventions, content pillars, hook formulas, repurposing system
  - **content-strategy** (11,199 chars) — content pillar framework, calendar planning
  - **copywriting** (6,756 chars + 2 references) — AIDA / PAS / Before-After-Bridge frameworks, hook patterns
  - **copy-editing** (12,876 chars + 1 reference) — plain-English swaps, weak-word removal, sentence variation
  - **marketing-psychology** (21,132 chars — biggest) — social proof, scarcity, curiosity gaps, anchoring, loss aversion
  - **marketing-ideas** (4,460 chars + 140-idea catalogue reference) — idea prompts categorised by goal
  - **launch-strategy** (12,168 chars) — pre-launch / launch-day / post-launch playbook
- **Why these 7 and not the other 24**: the source [marketingskills](https://github.com/coreyhaines31/marketingskills) repo has 31 skills covering CRO, SEO, RevOps, paid ads, etc. Those are off-topic for a social-content creative agency. The 7 picks are the directly-relevant subset.
- **New file [web/src/lib/skillRegistry.js](web/src/lib/skillRegistry.js)** — exports `SKILL_MENU` (the static metadata: slug, title, when-to-load description, available references), `loadSkill(slug)`, `loadSkillReference(slug, refName)`, and `compileSkillMenu()` (renders the menu block injected into the system prompt). Frontmatter is stripped at load time so the model sees just the body. Multi-candidate path resolution (`import.meta.url`-relative + `process.cwd()`-relative + a couple more) handles Vercel's ESM bundler placing modules in non-standard locations.
- **Two new tools on `/api/ai/chat`**:
  - `load_skill(slug)` — returns the parent playbook body + `available_references`. Loaded body stays in the conversation history for subsequent steps.
  - `load_skill_reference(slug, reference_name)` — fetches a deep-dive reference doc. Two-tier depth: SKILL.md gives the framework, references give the deep material (e.g. 140-idea catalogue, copy frameworks, post templates).
- **System prompt addition** — ~650 cached tokens. The skill menu lists all 7 slugs with one-line "use when…" descriptions so the model can route to the right skill without loading every body. Also adds two bullets to "Available tools" describing the new tools and a "load on demand" rule.
- **Inline copy surface gets skill-grounded craft too**: `/api/ai/copy` is single-shot (not agentic — can't call `load_skill` mid-generation), so we inject `compileCopyGuidance(platform)` up front as a third cached system breakpoint. It returns the matching platform section from `social-content/references/platforms.md` PLUS the full `copywriting/SKILL.md` (AIDA / PAS / Before-After-Bridge frameworks + hook patterns). ~2-3K cached tokens added per inline draft, cache-hits across back-to-back drafts within the 5-min TTL. The hardcoded `PLATFORM_GUIDANCE` block in copy.ts stays in place as a TERSE "MUST FOLLOW STRICTLY" recap at the top of the user message — it ensures the platform requirements ride the user-message-prominence path while the heavy craft sits in the cached system block.
- **Two surfaces, two integration patterns**:
  - **Chat (agentic):** model calls `load_skill(slug)` only when a request matches; bodies stream in as tool results and ride conversation context for subsequent steps.
  - **Inline copy (single-shot):** platform-relevant guidance is always-on for that platform's drafts — model can't pull on-demand, so we inject up front. Less situational, but the inline surface benefits from baseline framework-level guidance on every draft.
- **CopilotPanel ToolCard polish**: friendly headlines for the two new tools — "Consulting the launch-strategy playbook…" → "Loaded the launch-strategy playbook" on load_skill, and `"Pulling "ideas-by-category" from the marketing-ideas playbook…"` shape on load_skill_reference. Skill slug → human title mapping baked into `CopilotPanel.jsx`. Without this, the tiles would say "Running load_skill…" / "Ran load_skill" which is low-signal.
- **vercel.json** — added `functions["api/ai/chat.ts"].includeFiles` AND `functions["api/ai/copy.ts"].includeFiles` (both `"src/data/skills/**"`) so the .md files ship with both serverless bundles. Without this, `fs.readFileSync` calls at runtime would 404 (Vercel only bundles JS files reachable via `import` by default).
- **Cost shape**:
  - Chat: skill menu adds ~650 cached tokens (~$0.0002 read). Each loaded skill body is 1,500-5,000 tokens of tool-result content. ~+$0.01-0.04 per "smart" conversation that loads 1-2 skills; $0 for simple turns.
  - Inline copy: copy-guidance block adds ~2-3K cached tokens per platform (~$0.0008 read). Pays once on first draft of a session, cache-hits within 5-min TTL. Lifts inline-copy cost by maybe $0.001-0.002 per draft. Negligible vs the per-draft output cost.
  - Per user's directive, no per-conversation skill cap — quality over cost for now.
- **Sections touched**: Recent changes log; `Last updated`. Glossary updates deferred to a subsequent sweep to keep this PR focused.

### 2026-05-14 — Conversations PR 2 polish pass

Round of UX feedback after the chat UI shipped earlier today. All on the same `claude/friendly-blackburn-6c189f` branch / PR #84.

- **Sticky header + composer.** Restructured the layout so `.conv-wrap` is the scrolling container itself; `.conv-head` and `.conv-composer-wrap` use `position: sticky` (top/bottom). The inner `.conv-feed` no longer scrolls — it's just a vertical stack between them. Scroll-to-bottom now writes to `wrapRef.current.scrollTop` instead of the old `feedRef`.
- **Textarea growth capped + bounded.** Max-height down to 132px (~5 lines) + an explicit 40px min-height. After 5 lines the textarea scrolls internally instead of pushing the composer-wrap taller and (visually) off the bottom of the viewport — the screenshot scenario the user reported.
- **Composer split into two icon buttons.** 📎 paperclip is now **file attach** (image / video / file). 🗓 calendar is **tag a plan**. Both sit between the textarea and the Send button. Hidden native file input + `multiple` accept. Files pile up as removable preview chips above the textarea before send; chip shows filename + size.
- **Plan-tag dropdown rows show scheduled date/time** and sort newest-scheduled-first (cap 60 results). Two-line layout per row: concept on top, "Mar 12, 6:00 PM"-style time underneath, status pill on the right.
- **File attachments wired end-to-end.** New `addMessageAttachment({ accountId, messageId, file, uploaderId })` helper uploads to the existing `post-plan-attachments` bucket with path `<accountId>/messages/<messageId>/<ts>_<filename>`. The bucket's RLS only checks the first path segment against `accessible_account_ids()` so no new policies needed. `kind` is sniffed from `file.type` (image/video/file). Send sequence: insert message → upload each file → insert `message_attachments` rows. Bubble renders images with `<a><img/></a>` (click opens full size), videos with native `<video controls>`, everything else as a file chip with filename + size + click-to-open. Attachments work in the thread drawer composer too.
- **Realtime now handles three event types.** `subscribeToConversationMessages` was INSERT-only; extended to:
  - **UPDATE** on `conversation_messages` (covers soft-delete tombstones flipping across tabs and future `edited_at` changes — both render as in-place replacements).
  - **INSERT** on `message_attachments` (no `conversation_id` to filter, so we listen broadly and the client merges by `messageId` against the visible set — per-conversation volume is tiny).
- **Sidebar Conversations badge counts replies too.** `loadConversationUnreadCount` dropped the `parent_message_id IS NULL` filter — a reply you haven't seen is still unread activity. Per-thread last-seen remains deferred.
- **Soft-delete messages via right-click.** New `softDeleteMessage(messageId)` stamps `deleted_at` (and clears `body` for privacy). Bubble renders as a muted italic "Message deleted" tombstone (WhatsApp pattern). RLS already gates UPDATE to own-messages-or-agency; v1 UI only exposes the menu on own messages but the agency-clears-anything path works server-side. Right-click context menu component is inline + clamps to viewport edges. Realtime UPDATE handler propagates the tombstone to other tabs.
- **"Plan deleted" tombstone chip.** Migration `0043_conversation_messages_tagged_plan_decouple.sql` drops the FK on `tagged_post_plan_id` so deleting a plan no longer nulls the column — the orphaned id lingers. The bubble checks `taggedPostPlanId && !plansById.get(taggedPostPlanId)` and renders a greyed-out "Plan deleted" chip with strikethrough text instead of vanishing the context.
- **Sections touched:** Recent changes log; `Last updated`; Glossary (Conversations entry expanded with attachments / soft-delete / plan-deleted behaviour); §6 Data model (Conversations subsection notes the dropped FK on `tagged_post_plan_id` after 0043); §6 Migrations (new 0043 row); §13 Known decisions (attachments-bucket-reuse, soft-delete-over-hard, drop-FK-for-tombstone-detection); §14 Pending work (retired plan-deleted + soft-delete + attachments items; bumped per-thread unread to next).

### 2026-05-14 — Conversations: chat UI shipped (PR 2 of 2)

The unified per-brand chat is live at `/c/:slug/conversations`. Brand sees one ongoing thread with their agency; agency sees the same thread, scoped via BrandPicker. Schema is unchanged from PR 1 — this is pure frontend.

- **Five new db.js helpers** ([web/src/lib/db.js](web/src/lib/db.js)) layered on top of the PR-1 plumbing: `loadConversationMessages(conversationId, viewerUserId)` (top-level feed, ascending), `loadThreadReplies(parentMessageId, viewerUserId)`, `loadThreadReplyCountsForMessages(parentIds) → Map<id, count>` (one query for the whole feed page), `addConversationMessage({conversationId, body, authorId, taggedPostPlanId, parentMessageId})` (single insert path for both top-level and replies), `subscribeToConversationMessages(conversationId, viewerUserId, onChange)` (full-conversation INSERT subscription; caller routes to feed vs thread drawer based on `parentMessageId`).
- **`ConversationsView` rewritten** ([web/src/components/ConversationsView.jsx](web/src/components/ConversationsView.jsx)) — now ~430 lines. Layout: full-pane vertical flex with header at top, scrolling feed in the middle, composer pinned at the bottom. Sub-components inlined for cohesion: `PlanChip` (clickable card inside bubbles, removable variant for the composer tag), `PlanTagDropdown` (search + scrollable list of brand's plans, anchored above the composer), `MessageBubble` (avatar + name/time + body + plan-chip + reply affordance), `Composer` (auto-grow textarea, ⌘↩ to send, optional tag-a-plan icon button), `ThreadDrawer` (right-side ~420px panel with scrim, parent pinned at top, replies stacked, own composer; full-screen overlay below 640px). Realtime INSERTs are routed by `parentMessageId`: top-level → append to feed (auto-scrolls only if user is near bottom, tracked via `stuckToBottomRef`), reply → bump the parent's reply-count + append to the open thread drawer if it matches.
- **Deep-linking** — `?plan=<uuid|short-prefix>` on the URL pre-fills the composer's tag chip. Mirrors the App.jsx `findFullId` short-UUID convention so links from `PostPlanDetailView` survive the URL shortener.
- **`PostPlanDetailView` — Conversation tab removed** ([web/src/components/PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx)). The tab + its JSX block + its draft / hint / input-ref state are gone. The `comments` state stays (still feeds the Activity tab's "X commented" entries via `loadMessagesForPostPlan`). New "💬 Discuss this plan" button sits in the actions row alongside Mark-as-posted / Duplicate / status-override; clicking it navigates to `/c/${brandSlug}/conversations?plan=${shortPlanId}`. Brand slug derived from `useLocation().pathname` matching `/c/:slug/...` so we don't have to thread a new prop.
- **Requires-comment status flow preserved inline.** When the agency clicks a status transition that demands a reason (e.g. → needs revision), the old code force-switched to the Conversation tab + focused the input. With the tab gone, we now open an inline expanding panel right below the actions row: textarea + "Send & change status" / "Cancel" buttons. On submit: posts the message into the brand's conversation (auto-tagged to this plan, so it shows up in `/conversations` filtered by this plan via the existing data path) AND flips the status. Same workflow guarantee — agency can't ship a "needs revision" status without saying *what* needs to change — but the friction lives where the action is, not in a separate tab.
- **CSS additions** ([web/src/styles/app.css](web/src/styles/app.css)) — new `.conv-*` namespace covering the wrap/feed/bubble layout, plan-chip card (clickable + removable variants), composer with auto-grow textarea, plan-tag dropdown popover (anchored above the composer), thread drawer with scrim + slide-in animation + mobile full-screen variant. New `.discuss-plan-btn` style for the deep-link button on `PostPlanDetailView`. `.main:has(.conv-wrap)` overrides the page-level `display: block` so the chat surface can use `flex` for its sticky-composer-with-scrolling-feed layout.
- **Behavior worth knowing**:
  - Composer: ⌘/Ctrl+Enter sends; plain Enter inserts a newline (chat-style). Send button disabled when draft is empty or while `sending`.
  - Plan-tag dropdown: search by concept, max 40 results, sorted newest-scheduled first, click anywhere outside or hit Esc to close. Picking a plan inserts a removable chip above the textarea; tag persists across multiple messages until cleared (so you can rapid-fire several messages about the same plan without re-tagging).
  - Auto-scroll: feed sticks to bottom on first load and after sending; if the user has scrolled up to read history, new realtime messages don't yank them away (`stuckToBottomRef` gate).
  - Mark-as-seen: stamps `conversation_views.last_seen_at` on mount + on every realtime INSERT for this conversation, so the sidebar Conversations badge stays cleared while the user is actively in the chat.
  - Thread drawer Esc + click-on-scrim both close. Replies stack chronologically; auto-scrolls to the bottom on every new reply.
- **Sections touched:** Recent changes log; `Last updated`; Glossary (Conversations entry expanded with PR 2 behaviour); §13 Known decisions (entries: composer ⌘↩ over plain Enter so multi-line is the default; auto-scroll only when stuck-to-bottom; plan tag persists across messages; require-comment-status moved inline rather than into the chat surface itself); §14 Pending work (PR 2 retired, attachments + @mentions promoted to next-in-queue).

### 2026-05-14 — Conversations: data layer + sidebar plumbing (PR 1 of 2)

Phase 1 of the unified Conversations feature. The brand sees one ongoing chat per account ("you ↔ your agency"); the agency sees the same chat scoped via BrandPicker. PR 1 only ships the data model + sidebar entry — the chat UI (Slack-style threads, composer, plan-tagging, attachments) lands in PR 2. The existing per-plan Conversation tab inside `PostPlanDetailView` keeps working with no UX change because it's silently repointed at the new tables.

- **Migration `0042_conversations`** — four new tables:
  - `conversations` — one per brand account, enforced via `unique(account_id)`. No DMs / no multi-channel — that's the whole "channels list", there is no list.
  - `conversation_messages` — top-level messages + Slack-style thread replies via self-FK `parent_message_id`. Optional `tagged_post_plan_id` foreign key renders as a clickable plan preview card inline with the message. `body` + `created_at` + `edited_at` + `deleted_at` for tombstone-on-delete (UI lands in PR 2). Three partial indexes: top-level feed (`where parent_message_id is null`), thread reads (`where parent_message_id is not null`), tagged-plan filter (`where tagged_post_plan_id is not null`). **Named `conversation_messages` rather than `messages` because `public.messages` is already taken by the legacy tasks-chat table from migration 0001 — the table-cleanup follow-up that drops it can rename us back if it wants.**
  - `message_attachments` — `kind ∈ ('image','video','file','link')` with `storage_path` for the first three and `url` for `link` (pasted-URL preview cards). Wired up in PR 2/3; included now so the next migration doesn't need to add it.
  - `conversation_views(user_id, conversation_id, last_seen_at)` — mirror of `post_plan_views` from 0022, powering the sidebar Conversations badge.
- **RLS shape** — agency OR account-member can SELECT conversations + messages + attachments. INSERT requires `author_id = auth.uid()` (or `uploaded_by = auth.uid()` for attachments). UPDATE/DELETE limited to own messages or agency. We deliberately don't cross-check that `parent_message_id` lives in the same conversation as the reply — the safety gain isn't worth the RLS-recursion risk; a mis-pointed reply just orphans itself in the rendering layer rather than leaking.
- **Backfill** — one conversation per existing `accounts.type='brand'` row, then every `post_plan_comments` row copied into `conversation_messages` with `tagged_post_plan_id` set to the source plan. `created_at` preserved so chronological ordering survives the move. The legacy `post_plan_comments` table is **not dropped** — left in place for one bake cycle as a rollback escape hatch, then deleted in a follow-up.
- **Auto-provision trigger** — `accounts_ensure_brand_conversation` fires AFTER INSERT on `accounts` and inserts a `conversations` row whenever `type='brand'`. Idempotent via the `unique(account_id)` constraint. Means newly-created brands don't need an app-level call to provision their chat — it's there as soon as the account row exists.
- **Realtime** — `conversations`, `conversation_messages`, and `message_attachments` all added to the `supabase_realtime` publication.
- **db.js helpers** ([web/src/lib/db.js](web/src/lib/db.js)) — `loadConversationForAccount(accountId)`, `mapConversationMessageRow(row, viewerUserId)`, `loadMessagesForPostPlan(postPlanId, viewerUserId)`, `addMessageForPostPlan({postPlanId, accountId, body, authorId})`, `subscribeToMessagesForPostPlan(postPlanId, viewerUserId, onChange)`, `loadConversationUnreadCount({userId, accountId})`, `markConversationSeen({userId, accountId})`, `subscribeToConversationActivity({accountId}, onChange)`. The `loadMessagesForPostPlan` / `addMessageForPostPlan` / `subscribeToMessagesForPostPlan` trio is a **drop-in replacement for the old `loadPostPlanComments` / `addPostPlanComment` / `subscribeToPostPlanComments` API** — same input shape, same output shape — so the per-plan tab's UI didn't have to change.
- **Repointed read sites** — three places in db.js that used to query `post_plan_comments` now query `conversation_messages` with `tagged_post_plan_id` set: `loadPostPlanListRollups` (the calendar List/Week comment-count badge), `loadPostPlanUnreadCounts` (the per-plan unread dot), and `subscribeToPostPlanActivity` (the realtime tick that re-runs the unread query). All filter `parent_message_id IS NULL` so thread replies don't pollute the per-plan counts.
- **Sidebar entry** ([web/src/components/Sidebar.jsx](web/src/components/Sidebar.jsx)) — new "Conversations" item in the brand workflow nav, sitting between "Idea dump"/"Inbox" and "Brand Intelligence". New `chat` icon (two stacked speech bubbles) added to [Icon.jsx](web/src/components/Icon.jsx) so it doesn't collide visually with the single-bubble `comment` icon used by Brand notes. Badge count comes from `loadConversationUnreadCount` for the active brand; it auto-recomputes on any `conversation_messages` change via `subscribeToConversationActivity`.
- **Placeholder `/conversations` route** — `BRAND_SCOPED_VIEWS` set extended; `parsePathToRoute` handles `/conversations` and `/c/:slug/conversations`; `viewToPath` writes the brand-scoped form by default. The placeholder view ([web/src/components/ConversationsView.jsx](web/src/components/ConversationsView.jsx)) is intentionally minimal — explains what's coming, marks the brand's conversation seen on mount via `markConversationSeen` so the sidebar badge clears, then sits empty until PR 2 replaces it with the real chat UI.
- **Critical deploy ordering** — PR 1's code reads from `conversation_messages` and `conversations`. **The migration MUST be applied to the target Supabase project before the merged PR ships to production.** If Vercel deploys the new code against a database without these tables, every per-plan Conversation tab will silently render empty (the catch handler in `loadMessagesForPostPlan` warns to console and returns `[]`) and posting a comment will fail. Migration is on disk; user applies via the supabase CLI / dashboard before merging.
- **Sections touched:** Recent changes log; `Last updated`; Glossary (Conversations + Conversations badge entries); §6 Data model (new "Conversations tables (added 2026-05-14)" subsection); §6 Migrations (new 0042 row); §6 RLS helpers (no new helpers, all existing ones reused); §13 Known decisions (new entry: `conversation_messages` vs `messages` naming + the rollback-safety choice to keep `post_plan_comments` alive for a bake cycle); §14 Pending work (Conversations PR 2 — chat UI — promoted to next-in-queue).

Newest at top. Each entry: date, what changed, and which sections of this
doc were updated. When you make material changes, add a new dated entry.

### 2026-05-14 — AI Co-pilot calendar awareness: confidence flip + context expansion (PR 1 of N)
Fixes the longstanding "the Co-pilot asks me 4 questions before it'll draft anything" complaint. Two-layer change to `/api/ai/chat`'s system prompt and the shared `brandContext.js` compiler.

- **System prompt flip in [web/api/ai/chat.ts](web/api/ai/chat.ts)** — replaced the "If you don't have enough information (e.g. no date, no platform), ask a clarifying question instead of guessing" rule with a **defaults-first** stance: *"Pick a sensible default and CREATE the draft. Drafts are cheap and reversible (status='drafting', AI-draft pill, one-click delete). Only ask if the request is genuinely ambiguous."* New section "Default ladder for missing info" spells out fallbacks for date (next cadence gap or anchored to an Upcoming moment within 14 days), time (09:00 in brand timezone), platforms (brand's primaries or inferred from Top performers), concept (upcoming moments + brand pillars + cadence gaps). Also added a "Be proactive" rule: when the conversation opens or the admin asks open-endedly, lead with what's most relevant right now (holidays / gaps / top-performer patterns / time-bound notes) and offer 2-3 concrete next moves. Tool schema description on `create_post_plan_draft.scheduled_at` updated to match — explicitly says "Don't ask the admin for a date; pick one and ship the draft."
- **`compileBrandContext` extended with five "right-now" sections** in [web/src/lib/brandContext.js](web/src/lib/brandContext.js), all gated behind a new opt-in option `{ includeCalendar: true }`:
  1. **`## Today`** — date, day-of-week, brand timezone, ISO week of year, plus up to 30 days of upcoming holidays/festivals/observances filtered to the brand's market. Always present (even without `includeCalendar` — it's cheap).
  2. **`## Upcoming calendar`** — next 7 days as full detail (`DD MMM HH:mm · platforms · status · concept`), days 8-30 grouped by ISO week with platform counts. Empty calendar surfaces as an explicit "high-priority gap" signal so the model proposes filling it instead of analysing it.
  3. **`## Cadence (last 30 days)`** — per-platform post count + "last posted N days ago" with ⚠ GAP markers for ≥7-day silences.
  4. **`## Top performers`** — last ~20 publications ranked by weighted engagement (likes + 3·comments + 4·shares + 4·saves + reactions). Top 3 surfaced with their copy preview so the model can pattern-match what's working.
  5. **`## Voice anchors`** — first lines (hooks) of the top 5 highest-engagement recent posts. The strongest voice signal the brand has — outranks the existing "Recent approved posts" style refs when both are present.
- **New `getBrandLocale(brandKit, account)` helper** — returns `{ country, timezone }`. Looks at `brandKit.primary_market` / `brandKit.country` / `account.country` then `brandKit.timezone` / `account.timezone`, defaulting to `IN` / `Asia/Kolkata`. None of those columns exist yet — the helper is shaped so adding either is a no-op. **Deferred decision**: when we add a second brand in a different market, add either `accounts.country/timezone` or `brand_kits.primary_market/timezone` columns and the helper picks them up automatically. Until then, defaults match L+R Studio's actual market.
- **New file [web/src/lib/marketingMoments.js](web/src/lib/marketingMoments.js)** — curated list of ~30 entries per year for 2026-2027 covering Indian public holidays (Republic Day, Independence Day, Gandhi Jayanti, Ambedkar Jayanti), Indian cultural festivals (Diwali, Holi, Eid al-Fitr/Adha, Raksha Bandhan, Ganesh Chaturthi, Janmashtami, Onam, Pongal, Karwa Chauth, Guru Nanak Jayanti, Children's Day), and global marketing moments (Valentine's, Women's Day, Mother's/Father's Day, Earth Day, Pride Month, Halloween, Black Friday, Cyber Monday, Christmas, NYE). Each entry has `{date, name, country: 'IN'|'GLOBAL', tags}`. Tags are free-form (`festive`, `religious-hindu`, `religious-muslim`, `national`, `consumer`, `awareness`, `sustainability`, `pride`, `regional-south`, etc.) so the model can reason about brand-fit. Function `getUpcomingMoments({ from, days, country })` returns matches in window with `daysAway` computed. **Lunar holidays (Diwali, Holi, Eid) drift year-to-year — refresh annually** when 2027 is half-elapsed; there's a marker comment in the file.
- **Why a curated list instead of `date-holidays`**: tried the npm package; its `IN` dataset only ships 6 public holidays and misses every culturally-marketed moment (Diwali, Holi, Eid, Rakshabandhan, etc.). Subdivision codes don't help — the package's IN data is sparse at every level. The agency cares about marketing moments, not bank holidays.
- **Opt-in design**: `loadAndCompileBrandContext(client, id)` with no options skips the extra calendar/publication/snapshot queries — only the chat route opts in via `{ includeCalendar: true }`. Inline copy/image/suggestions routes get the cheap base context (3 queries) unchanged; chat gets the full picture (5 queries). Keeps inline-route token cost flat.
- **Cache behaviour**: brand-context blob still rides the 5-min prompt cache. The static brand-kit/voice/strategy/notes sections stay byte-stable. `## Today` rolls over at midnight brand-local (one cache miss per day, expected). Calendar sections invalidate when the admin creates a new draft mid-conversation (also expected — the model needs to see the new draft so it doesn't propose duplicates on the next turn). Static SYSTEM_PROMPT breakpoint and per-brand context breakpoint are both still distinct ephemeral blocks on the `system: [...]` array — no cache-architecture changes.
- **Token cost**: empty-state brand context (no upcoming plans, no engagement) adds ~30 lines / ~300 tokens for the `## Today` block alone. Fully-populated brand context (Bamboo Bear with ~15 upcoming drafts and last 30 days of engagement data) adds ~80-150 lines / ~1.5-3K tokens. Well within the 8-15K-token cached-prefix sweet spot.
- **Sections touched**: Recent changes log; `Last updated`; Glossary (Brand context (compiled) row rewritten; new entries: Brand locale, Marketing moments). §6 Data model and §10 Edge functions unchanged (no schema change, no new routes).

### 2026-05-12 — Live Posts engagement: monthly-report data hook (PR 8 of 9)
Read-only db.js helper that consumes the snapshot history the PR 7 cron is now building up. No UI, no schema, no new routes — just a single function the future monthly-report builder consumes.

- **[`loadEngagementForBrandRange(accountId, fromISO, toISO)`](web/src/lib/db.js)** — returns one entry per brand publication:
  - `publication` (mapped row, same shape `LivePostsView` consumes)
  - `plan` (concept, scheduledAt, platforms, accountName)
  - `firstSnapshot` — earliest snapshot with `fetched_at` in range, or `null`
  - `lastSnapshot` — latest snapshot in range, or `null`
  - `snapshotCount` — how many snapshots fell in the range
  - `delta` — `{ likeDelta, commentDelta, shareDelta, saveDelta, viewDelta, bookmarkDelta, reactionDelta, totalEngagementDelta }`, or `null` if only 0-1 snapshots fell in the range
  - `note` — `'no_snapshots_in_range'` / `'single_snapshot_only'` / `null`
- **"First/last in range" semantic**: earliest with `fetched_at >= fromISO` and latest with `fetched_at <= toISO`. Snapshots outside the range are ignored — they'd give a misleadingly long curve. If a publication has zero snapshots in the period (e.g. first scraped after period end), we surface that as `note: 'no_snapshots_in_range'` so the report can render an "insufficient data" cell.
- **Delta semantics**: `last - first` per metric. Can be negative (LinkedIn unliked, IG removed by user). `totalEngagementDelta` sums the "loud" engagement metrics (likes + comments + shares) — views/saves/bookmarks deliberately excluded; they're visibility signals, not engagement actions. If ANY contributing delta is null (because a count wasn't exposed at one of the bounds), `totalEngagementDelta` is null — the consumer falls back to per-metric deltas it does have. Singular snapshots return `delta=null` because one sample tells us a value, not a change.
- **Cost**: 2 queries (publications + snapshots in range). Snapshots query is indexed on `(publication_id, fetched_at desc)` so the range filter is cheap. At full rollout (~30k snapshots/month across 1000 publications) the snapshot query is still well under a second.

No tests — the repo has no test runner; helper is small + heavily commented. The monthly-report UI (separate workstream, not part of this 9-PR series) will exercise it.

### 2026-05-12 — Live Posts engagement: scheduled refresh + sort affordances (PR 7 of 9)
Adds the cron leg of the engagement feature so engagement curves grow over time (not just the one snapshot from mark-posted + the occasional manual Refresh-now). Also a small UI polish for browsing live posts by leaderboard.

**Refactor first.** `web/api/engagement/refresh.ts` was already a hairy file with scrapers + normalizers + DB writes inline. Moved the reusable pieces (types, `scrapeInstagram`, `scrapeLinkedIn`, `dispatchScrape`, `persistScrapeResult`, helpers) into a new [`web/api/engagement/scraper-lib.ts`](web/api/engagement/scraper-lib.ts). Leading underscore tells Vercel "this isn't a route" (see [feedback_vercel_underscore_prefix.md](.claude/projects/.../feedback_vercel_underscore_prefix.md)) — file is importable from sibling routes in the same bundle but never deploys as `/api/engagement/scraper-lib`. `refresh.ts` is now a slim handler (auth → dispatch → persist).

**New cron route — [`web/api/engagement/refresh-cron.ts`](web/api/engagement/refresh-cron.ts).** Vercel Cron `0 1 * * *` (daily at 1am UTC). **Original schedule was `0 */6 * * *` (every 6h) but Vercel Hobby caps cron jobs at "once per day max" — the build rejected the schedule and the entire deployment failed.** Daily fires give us a multi-day curve which is what monthly reports need; sub-daily resolution would require Pro ($20/mo). Auth via `Authorization: Bearer ${CRON_SECRET}` — same pattern as `daily-digest`. Algorithm:
1. Load all eligible publications (`platform IN ('instagram','linkedin')` AND `live_url IS NOT NULL`).
2. Bulk-load the latest snapshot per publication + the last 3 statuses (used for the failure-demotion rule).
3. Compute "due" set in JS: tier the publication by **time-since-publication** (NOT time-since-last-scrape, so a stale publication catches up to its current tier instead of being stuck at the most-frequent cadence). Tiers: <14d→daily, <60d→3d, else weekly. (Original plan had a <2d→6h tier for new-post curves but the cron itself only fires daily on Hobby, so sub-daily tiers were pointless. When/if we upgrade to Pro and run the cron every 4-6h, the sub-day tier comes back.) If the last 3 statuses are all `failed`/`blocked`, demote to weekly regardless. Never-scraped rows are always due.
4. Sort by oldest-latest-snapshot first (most-stale tiles attacked first).
5. Scrape the first 5 (`MAX_SCRAPES_PER_RUN`) serially. Stays well inside Vercel's 60s function budget (IG ~7-12s, LinkedIn ~7-10s × 5 + DB writes ≈ 40-55s headroom).
6. Persist each result via `persistScrapeResult` from `scraper-lib.ts` — same logic the on-demand route uses, so cron-written rows are identical in shape to user-triggered ones.
7. Response includes `total_eligible`, `due`, `processed`, `backlog`, per-row results — useful for debugging via curl.

**Why batch=5.** At full rollout (10 brands × 100 posts = 1000 publications), back-of-envelope: ~150 publications/day at steady-state cadence × 4 cron fires/day = ~38 scrapes/run needed. 5/run × 4/day = 20/day, *short of the need at full scale*. **Documented inline in the route as a TODO**: when scale demands, switch to a queue model (qstash / supabase-queues / round-robin column). 5 is intentional MVP simplicity — at Bamboo Bear-only scale it's already overkill.

**Failure demotion rule.** Last 3 statuses all `failed`/`blocked` → weekly. Stops the cron from burning Apify credit on permanently-broken URLs (deleted IG posts, login-walled LinkedIn posts, etc.). Doesn't apply to `partial` (which still counts as a successful refresh — the actor returned counts even if media is missing).

**`vercel.json`** — adds the cron entry + `api/engagement/refresh-cron.ts` to functions with `maxDuration: 60`.

**Sort affordances — [`LivePostsView.jsx`](web/src/components/LivePostsView.jsx).** New `<select>` between the platform filter pills and the search input. Three options: **Recently posted** (default — unchanged month-grouped chronology), **Most likes** (sort by latest snapshot's `like_count` desc), **Most engagement** (sort by `like_count + comment_count + share_count` desc). Non-"recent" modes render a single flat leaderboard section instead of the month groups — intercalating sort + month-group reads strangely. Sort is purely client-side; relies on already-loaded `snapshotsByPubId` Map.

### 2026-05-12 — Live Posts engagement: LinkedIn wired, X intentionally skipped (PRs 5+6 of 9, combined)
Closes the platform matrix for Live Posts engagement. Combined into one merge unit because PR 5 (X) is a 5-line "show a permanent label" change and PR 6 (LinkedIn) is the actual scraper wire-up — splitting them would be more ceremony than they're worth.

**Why X is skipped (PR 5 outcome).** Two preflight rounds against real public tweet URLs found no viable Apify actor:
- `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`: returned 15 mock_tweet items with the explicit fine-print disclosure *"to ensure we cover our costs, we have a minimum charge of \$X per API call, even if the response contains no results. Thus, we returned N pieces of mock data."* — i.e., charges money for failed lookups. Disqualified.
- `apidojo/twitter-scraper-lite` + `apidojo/tweet-scraper`: returned `{demo:true}` × 10 regardless of input shape. Either demo-tier gate or actors are broken for arbitrary tweet URLs.
- `tugkan/twitter-tweet-scraper-pay-per-result`: actor doesn't exist.
The official X API (\$200/mo Basic tier) wasn't worth the spend for one platform's stats in MVP. Decision: ship X as a permanent "not tracked" state. Users can mark plans posted to X (the publication record still exists) and the tile renders with the post URL + concept + author but no embed card or metrics. **Permanent badge: "X engagement not tracked"** (replaces the temporary "coming soon" copy from PR 3).

**Why supreme_coder/linkedin-post won for LinkedIn (PR 6 outcome).** Real-data shootout against `https://www.linkedin.com/posts/theshrutimishra_a-few-days-back-i-was-invited-toatomic-activity-7457341282663944192-r2GN`:
- `supreme_coder/linkedin-post`: returned `numLikes: 33`, `numComments: 2`, `numShares: 1`, `text`, `images[]` (LinkedIn CDN URLs at `media.licdn.com`), `type`, `url`, `urn`, `timeSincePosted`. Full engagement set including **share count** (which IG doesn't expose, so LinkedIn tiles end up richer than IG ones).
- `harvestapi/linkedin-post-reactions`: returned 0 items across multiple input shapes. Not viable.

The `supreme_coder/linkedin-post` actor is listed on Apify Store as "No cookies · \$1 per 1k" (so \$0.001 per scrape, well under our cost projection) and has 6.4M runs / 13k users so it's the unambiguous incumbent for LinkedIn-post-by-URL scraping.

**What landed:**
- **[web/api/engagement/refresh.ts](web/api/engagement/refresh.ts)** — new `scrapeLinkedIn(liveUrl)` function mirroring `scrapeInstagram`'s shape. Normalizes `numLikes` into BOTH `like_count` AND `reaction_count` (LinkedIn rolls reactions into one bucket for public scrapes; we populate both so future UIs can read either field). `share_count` populated from `numShares`. `view_count` stays null with an `availability_notes` saying so. `posted_at` stays null because LinkedIn returns a relative time string (`timeSincePosted`) not an ISO timestamp — `published_at` on `post_plan_publications` remains the agency-marked "went live" moment. Author info extracted from either top-level `actor` or nested `rootShare.actor` (re-shares have the post under a different path).
- **Dispatch** in the same route: IG → `apify/instagram-scraper`, LinkedIn → `supreme_coder/linkedin-post`, X → 501 with the stable message "Engagement refresh is not supported for x. (X has no viable Apify actor as of 2026-05-12.)". `actor_id` on the snapshot row is now derived from the dispatch instead of hardcoded so the audit trail accurately attributes which scraper produced each row.
- **[web/api/engagement/image-proxy.ts](web/api/engagement/image-proxy.ts)** — `*.licdn.com` added to the host allowlist alongside `*.cdninstagram.com` / `*.fbcdn.net`. LinkedIn's CDN behaves similarly enough to Meta's that routing through the proxy is the right default.
- **[web/src/components/LivePostEmbed.jsx](web/src/components/LivePostEmbed.jsx)** — `proxiedUrl()` helper extended to rewrite `*.licdn.com` URLs through `/api/engagement/image-proxy`.
- **[web/src/components/LivePostsView.jsx](web/src/components/LivePostsView.jsx)** `LiveTile`:
  - "Refresh now" button now shows for `instagram` **and** `linkedin`.
  - X tile shows a permanent dashed badge "X engagement not tracked" (was "coming soon" before). Title attribute explains the rationale to anyone hovering.
- **[web/src/components/PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx)** `handleMarkPostedSubmit` — auto-refresh filter now uses a `Set(['instagram','linkedin'])`; X publications skip auto-refresh (route 501s them anyway).

**Cost model after these PRs:** ~\$0.0023 per IG scrape + ~\$0.001 per LinkedIn scrape, X = \$0. Bamboo Bear MVP (~30 posts) ≈ \$0.50/month total. 10-brand full rollout ≈ \$15/month — even cheaper than the \$22/mo plan-time projection because LinkedIn is cheaper than X would have been AND we're not paying for X at all.

### 2026-05-12 — Live Posts engagement: on-paste auto-refresh (PR 4 of 9)
With PRs 1–3 deploying the engagement system, the agency still had to manually click "Refresh now" on every newly-marked-posted plan to populate metrics. PR 4 closes that loop: the moment an agency user marks a plan as posted with a live URL, the dashboard fires `/api/engagement/refresh` in the background and the tile auto-populates ~6s later via realtime.

- **[web/src/components/PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx)** `handleMarkPostedSubmit` — after the upsert loop completes, iterates the newly-saved publications and fires `refreshEngagement(id)` for each one that is (a) `platform === 'instagram'` and (b) has a non-empty `liveUrl`. Fire-and-forget — the modal close is NOT blocked on the ~6s Apify scrape; realtime in LivePostsView picks up the snapshot + embed cache writes when they land. 403 (brand user) is swallowed silently because the server gate is authoritative; brand users get the data when an agency teammate clicks Refresh later. Other failures (Apify quota, actor down) end up in the snapshot row's `scrape_status` and surface honestly in the tile next time someone looks.
- **X / LinkedIn skip intentionally** — the client doesn't fire for those platforms (the route 501s them; firing would waste a server hop). PRs 5/6 will flip the gate when the actor selection lands.

### 2026-05-12 — Live Posts engagement: image proxy fix (PR 3 hotfix)
First end-to-end visual test on the Vercel preview surfaced that IG images weren't rendering. The first diagnosis (hotlink protection → `referrerpolicy="no-referrer"`) turned out wrong. Real cause:

**Meta's CDN sends `Cross-Origin-Resource-Policy: same-origin` (or `same-site`)** on `scontent-*.cdninstagram.com` responses. CORP is browser-side enforcement that blocks the response *regardless* of how the image is loaded — `referrerpolicy`, `crossorigin`, fetch mode `cors` / `no-cors`, none of them bypass it. Confirmed by injecting the real Bamboo Bear post's CDN URL into the local dev server: all variants fail with `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`.

The fix shipped:
- **[web/api/engagement/image-proxy.ts](web/api/engagement/image-proxy.ts)** — same-origin Vercel route that fetches the IG CDN URL server-to-server (where CORP doesn't apply — CORP is browser-only) and re-emits the bytes with permissive `Cross-Origin-Resource-Policy: cross-origin`. Host allowlist gates SSRF (`*.cdninstagram.com`, `*.fbcdn.net` only); HTTPS-only. 1-day edge cache via `Cache-Control: public, max-age=86400` because IG URLs are stable for ~10 days but identical requests within a day shouldn't burn bandwidth twice. Auth: deliberately unauthenticated — adding JWT would require signed image URLs (img tags can't send Authorization headers), too much machinery for v1's threat model.
- **[web/src/components/LivePostEmbed.jsx](web/src/components/LivePostEmbed.jsx)** — added a `proxiedUrl(raw)` helper that rewrites IG/FB CDN URLs to go through the proxy. Non-Meta hosts (eg. X CDN URLs from PR 5 onwards) pass through untouched.

The durable replacement is still the Supabase Storage cache from `project_past_creatives_deferred.md` — that survives the IG URL's expiry (the proxy doesn't, it just makes today's URL renderable). Plumb that in the same PR as the social asset pipeline.

§13 Known decisions gets a new entry on CORP-vs-hotlink and the "default to same-origin proxy for Meta CDN content forever" guidance.

### 2026-05-12 — Live Posts engagement: UI integration (PR 3 of 9)
First user-visible surface for the engagement system shipped in PRs 1+2. Reads the snapshots + embed cache; writes via the existing `/api/engagement/refresh` route.

- **[web/src/components/LivePostEmbed.jsx](web/src/components/LivePostEmbed.jsx)** — new static-card component. Author row (avatar + handle + relative timestamp + platform chip), media block (lazy-loaded image with aspect-ratio reservation, video poster with play overlay, carousel badge), 4-line caption with `-webkit-line-clamp`. Clickable through to the live URL. IG CDN URL expiry handled via an `onError` fallback that hides the broken image without breaking the tile.
- **[web/src/components/LivePostsView.jsx](web/src/components/LivePostsView.jsx)** — `LiveTile` extended with: the new embed card, a `MetricsRow` (♥ likes / 💬 comments / ↗ shares / 🔖 saves / 👁 views with `formatCount` for 1.2k/1.2M; `—` for null fields so "unexposed" reads differently from "really zero"), a refresh footer (`Refreshed 2h ago` / `Fetching…` / `Refresh failed: …` / `Metrics paused — Apify monthly quota exhausted`), and an agency-only "Refresh now" button on IG tiles. X/LinkedIn tiles show a dashed "Instagram support coming soon"-style badge until PRs 5/6 land. Parent component loads `loadLatestEngagementSnapshots` + `loadEmbedCacheForPublications` in bulk once publications resolve, and subscribes to project-wide realtime on both tables.
- **[web/src/lib/db.js](web/src/lib/db.js)** — five new exports: `mapEngagementSnapshotRow` / `mapEmbedCacheRow`, `loadLatestEngagementSnapshots(pubIds) → Map`, `loadEmbedCacheForPublications(pubIds) → Map`, `subscribeToAllEngagementSnapshots(onChange)`, `subscribeToAllEmbedCache(onChange)`, `refreshEngagement(publicationId)` (calls the API route with the current session's JWT). All read-only or HTTP — no client INSERT/UPDATE/DELETE paths (matches the RLS in 0041).
- **[web/src/App.jsx](web/src/App.jsx)** — passes `isAgency={!!auth?.isAgency}` to `<LivePostsView/>` so the tile knows whether to render the "Refresh now" button. Single-line change.
- **No CSS changes** — used inline styles + existing CSS vars (`--ink-1`/`--ink-4`, `--surface`, `--line`) to fit the file's existing style. No new tokens.
- **Verification**: `npm run build` clean; dev server boots; all modules (including new LivePostEmbed + the updated LivePostsView/db.js) load via Vite HMR without parse/import errors; no JS runtime errors in console. End-to-end visual verification with real engagement data happens on the Vercel preview deploy once a real Apify scrape lands (requires Apify quota to be restored).

### 2026-05-12 — Live Posts engagement: `/api/engagement/refresh` route — IG only (PR 2 of 9)
First production write path for the engagement snapshots + embed cache shipped in PR 1.

- **[web/api/engagement/refresh.ts](web/api/engagement/refresh.ts)** — POST `{ publicationId: "<uuid>" }`. Validates the caller's JWT, looks up `profiles.is_agency` via service-role, returns 403 for brand users (brand reads still work — they just can't trigger an Apify scrape). Loads the publication, requires a non-empty `live_url`, and dispatches by platform. Only `instagram` is handled in PR 2; `x` and `linkedin` return 501 with a clear message until PRs 5 and 6 land.
- **Instagram path** calls `apify/instagram-scraper` via `run-sync-get-dataset-items` (same pattern as fetch-trends). Normalizes the response into the schema columns (`like_count`, `comment_count`, `view_count` for video posts; `share_count` / `save_count` / `bookmark_count` stay null with an `availability_notes` explaining why). Embed fields (`author_handle`, `caption`, `media_url`, `media_urls` for carousel, `media_aspect_ratio` derived from dimensionsW/H) come from the same payload.
- **Snapshot is always written**, even on failure — the row's `scrape_status` (`ok` / `partial` / `failed` / `blocked`) + `error_message` are the audit trail. Important specifically for the blocked path: when Apify returns 403 with `usage-limit` / "Monthly usage hard limit", the route stamps `scrape_status='blocked'` so the UI in PR 3 can distinguish "quota out" from "actor returned no items" cleanly. (This is the exact case the user hit on 2026-05-12 while validating PR 1's dry-run — the free-tier $5 monthly credit was exhausted by Trends Radar's existing scrape volume.)
- **Embed cache only upserts on a successful scrape.** A failed refresh leaves the previous embed row intact so the tile keeps rendering the last-known card while the metrics row shows the freshness/error state.
- **`vercel.json`** — added `api/engagement/refresh.ts` to `functions` with `maxDuration: 60`. Single Apify scrape clocks ~10-20s; 60s is generous headroom but well under the fetch-trends 300s budget (which scrapes many handles in one call).
- Route deploys before its consumers (PR 3 UI, PR 4 on-paste auto-refresh) land — no client surface depends on it yet. Smoke test plan in the PR body uses curl + a real publication id.

### 2026-05-12 — Live Posts engagement: schema + Apify dry-run (PR 1 of 9)
Foundational work for adding live engagement metrics + post embeds to the Live Posts repository.

**1. Migration `0041_post_engagement.sql`** ([supabase/migrations/0041_post_engagement.sql](supabase/migrations/0041_post_engagement.sql)) — two new tables attached to `post_plan_publications`:
- `post_engagement_snapshots` — append-only history (one row per scrape). Holds `like_count`, `comment_count`, `share_count`, `save_count`, `view_count`, `bookmark_count`, `quote_count`, `reaction_count`, `engagement_rate`, plus the full `raw_payload` for schema-drift insurance and provenance (`actor_id`, `actor_run_id`, `scrape_status`). Indexed on `(publication_id, fetched_at desc)` for the hot read path. Powers the future monthly-reports feature via delta-between-snapshots.
- `post_embed_cache` — 1:1 with publications (PK = publication_id). Holds the visible content: `author_handle`, `author_display_name`, `author_avatar_url`, `caption`, `media_type`, `media_url`, `media_urls` (carousel), `media_aspect_ratio`, `posted_at`, optional `oembed_html` (X-only, for future), `last_refreshed_at`, `refresh_status`. Overwritten on each refresh.

**2. RLS shape — reads open, writes service-role-only.** Both tables: `is_agency_user() OR account-members-of-the-parent-plan` can SELECT. **No INSERT/UPDATE/DELETE policies for `authenticated`** — the only path that writes is the future `/api/engagement/refresh` route using the service-role key. This prevents Apify-cost abuse from brand users and any "refresh now" affordance is gated at the route, not RLS. Both added to `supabase_realtime` so LivePostsView re-renders on snapshot/embed changes.

**3. Dry-run script** ([scripts/scrape-engagement-dry-run.mjs](scripts/scrape-engagement-dry-run.mjs), `npm run scrape:engagement-dry-run`) — takes one or more public post URLs (IG / X / LinkedIn), routes each to the right Apify actor (`apify/instagram-scraper` / `apidojo/tweet-scraper` / `apify/linkedin-post-scraper`), prints normalized metrics + embed fields side-by-side with a sample of the raw payload. No DB writes. The point: confirm before PR 2 that the actors we picked actually return the fields the production route assumes. Reuses the same `APIFY_API_TOKEN` env var the Trends Radar route already uses; same `run-sync-get-dataset-items` invocation pattern.

**4. Migration applies via Supabase dashboard before PR 2 ships.** Standard pattern — no automated runner in this repo. Frontend is non-breaking until the route is up.

### 2026-05-12 — Brand notes restructure ([PR #75](https://github.com/CodeFire98/lr-studio-dashboard/pull/75))
Three coordinated changes promoting `brand_kit_notes` from an agency-or-member card buried inside Brand Intelligence to a top-level agency-only workspace.

**1. RLS tighten** ([supabase/migrations/0040_brand_kit_notes_agency_only_rls.sql](supabase/migrations/0040_brand_kit_notes_agency_only_rls.sql)) — was `is_agency_user() OR account_id IN (accessible_account_ids())` on SELECT/INSERT/UPDATE/DELETE; now `is_agency_user()` only on all four. **User-run via Supabase dashboard before the frontend ships** — there's no automated migration runner in this repo. The frontend won't crash for brand users if the migration lags (BrandNotesSection returns null for non-agency callers as defense-in-depth), but the data won't be hidden from PostgREST until the migration lands.

**2. Top-level view** — new [BrandNotesView.jsx](web/src/components/BrandNotesView.jsx) mounts the existing BrandNotesSection in a dedicated page. Route: `/c/:slug/notes`. Page chrome: title "Brand notes", sub copy explaining the AI-Co-pilot connection. Old `<BrandNotesSection/>` in BrandKitView is removed (line replaced with a placeholder comment pointing to the new view).

**3. Sidebar entry** — `Sidebar.jsx`'s agency branch adds `{ key: "notes", label: "Brand notes", icon: "comment" }` directly below "Trends Radar". Brand users never see it.

**Defense-in-depth gates**:
- Frontend: [BrandNotesSection.jsx](web/src/components/BrandNotesSection.jsx) splits into outer wrapper + inner — the outer returns `null` if `!isAgency`, so the hooks-heavy inner never mounts for brand users. Avoids the rules-of-hooks problem you'd get from an early `if (!isAgency) return null` before useState calls.
- Frontend: [BrandNotesView.jsx](web/src/components/BrandNotesView.jsx) renders an "internal-only" stub for a direct-URL bounce by a non-agency user — they shouldn't reach this route via the sidebar but it's a coherent landing if they paste the URL.
- Server: RLS migration above.

**No data migration needed** — existing rows remain accessible to agency users; the policy change just stops returning them to brand-user JWTs. Same code paths (`loadBrandKitNotes`, `subscribeToBrandKitNotes`, `createBrandKitNote`, etc. in db.js) all keep working unchanged.

- **Sections touched:** Recent changes log; `Last updated`; §6 Data model (brand_kit_notes RLS); §7 Routes (`/c/:slug/notes` added); §10 (no new route — the existing view-tree gains one mount point).

### 2026-05-12 — Chat system prompt: universal platform craft ([PR #76](https://github.com/CodeFire98/lr-studio-dashboard/pull/76))
Small standalone improvement to [`/api/ai/chat`](web/api/ai/chat.ts)'s `SYSTEM_PROMPT`. Adds a "Platform craft (applies to every brand)" section between "How to behave" and "Available tools" — universal copywriting conventions for Instagram / LinkedIn / X plus a cross-platform adaptation rule.

What's in the new section:
- **Instagram**: hook-in-first-line emphasis (above-the-fold visibility), sensory language, scannable line breaks, ~150-300 words sweet spot, CTA / non-generic question close, hashtags only-if-relevant on last line, emojis sparingly.
- **LinkedIn**: authority + warmth opening (banning "I'm excited to share…" type clichés), 1-2-sentence paragraphs for mobile collapse, ~150-300 words, forward-looking insight / substantive question close, no emojis unless brand voice permits, hashtags on final line if any.
- **X**: 280-char hard cap, ruthless trimming when over, hashtag/emoji guardrails, "only propose a thread if the admin asks".
- **Cross-platform**: match the angle, adapt the format. Don't copy-paste captions across surfaces. If a platform genuinely doesn't fit, say so and propose a different angle rather than forcing a bad fit.

Deliberately NOT pre-baking any brand-specific quirks (Bamboo Bear voice, Bamboo Bear hashtags, etc.) — those belong in `brand_kit_notes` so they're maintainable per brand without code changes. The system prompt is the universal baseline; the brand-context blob + notes is the per-brand layer; the brand voice wins when there's tension between them.

Cost impact: ~400 tokens added to the system prompt — cached as part of the existing system block (`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }`), so it only re-bills on cache miss. After the first call in a 5-min window for a brand, subsequent calls read the whole expanded prompt from cache at the cached rate. No measurable cost increase in practice.

This was deferred during Track A (the AI Co-pilot v2 migration) — it was intentional to ship the v2 plumbing first without mixing in prompt-quality changes. Now's the moment.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (`/api/ai/chat` SYSTEM_PROMPT documented).

### 2026-05-12 — AI Co-pilot Phase 3: dynamic suggestion chips + Refresh ([PR #74](https://github.com/CodeFire98/lr-studio-dashboard/pull/74))
First post-Track-A net-new improvement to the Co-pilot. Replaced [CopilotPanel.jsx](web/src/components/CopilotPanel.jsx)'s hardcoded `EMPTY_SUGGESTIONS` array (three generic prompt-starters that have shipped since the first Co-pilot PR) with **AI-generated brand-aware suggestion chips** + a **Refresh button** so the admin can get different angles when the current set isn't relevant.

**New server route**: [/api/ai/suggestions](web/api/ai/suggestions.ts). One-shot `generateObject` call with a Zod schema (`{ suggestions: z.array(z.string().min(8).max(150)).length(4) }`), temperature 0.9 for variety between calls. Reuses the cached brand-context blob (same cache pool as chat / copy / image — one 5-min TTL). Anthropic cost: ~$0.005-0.010 first call (cache miss), ~$0.001-0.003 cached. Refresh-heavy admin (10 clicks in a session) ≈ $0.01-0.03 total. Logs `[suggestions] usage account=… cache_read=…` for observability.

**Client wiring**: [db.js](web/src/lib/db.js)'s `loadCopilotSuggestions({ accountId })` now tries the AI route first, falls back to the **templated logic** (still in db.js) if the call errors. Templated fallback uses recent approved plans + brand-kit categories + date-aware brainstorm starter to build chips deterministically — preserves brand-awareness even when the AI route is unreachable.

**Refresh affordance**: CopilotPanel's welcome screen has a small "Refresh" pill above the chips. Clicking calls a fresh /api/ai/suggestions; spinner replaces the icon during the round-trip; suggestions fade slightly (`is-loading` class) until the new set lands. A `suggestionsTokenRef` cancels stale fetches if the admin double-clicks Refresh or switches brands mid-flight.

**Cache behavior**: brand-context blob is byte-stable per brand, so consecutive refreshes for the same brand hit the Anthropic 5-min cache reliably. The user-message-side carries a per-call entropy signal (the ISO date) so the model isn't strictly tempted to repeat itself — temperature 0.9 + entropy in the user message generates fresh angles each refresh.

**Behavior preserved**: clicking a chip drops its text into the textarea and focuses (same as v1). Only renders on `messages.length === 0`. Empty welcome state never flashes — chip state seeds with the v1 generic set, then upgrades in place once the AI route resolves.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (new `/api/ai/suggestions` subsection); §13 Known decisions (AI-generated suggestions over deterministic templates for refresh variety).

**Previous template-only approach (replaced same-day)**: an earlier version of this PR shipped client-side template logic only — same 4 chips for the same brand state, no variation per session. The user pointed out that without variation, "refresh me a fresh angle" wasn't possible. Pivoted to AI-generation while keeping the templates as graceful fallback. Templated suggestions:

1. **Follow-up to the latest approved plan** (if any) — cites the actual concept truncated to 60 chars, e.g. `Draft a follow-up to "Mother's Day spotlight on small-biz moms" for next Tuesday at 10am`. The weekday rotates between Tuesday and Thursday based on whichever is closer.
2. **Plan the week** — uses the platforms actually used recently if we have data (e.g. `Plan three posts for next week across IG and LinkedIn`), otherwise the canonical IG + LinkedIn pairing.
3. **Campaign around a category** (if `brand_kits.product_categories[0]` exists) — e.g. `Plan a campaign featuring our cotton onesies for next month`.
4. **Brainstorm starter** — date-aware: `Brainstorm a campaign concept for next June`. December rolls over to "the new year" instead of suggesting January twice.

**Architecture choice**: client-side template-driven, NOT AI-generated. Reasons (logged in db.js header): suggestions are affordances ("what CAN I ask?"), not recommendations, so templates are appropriate. Zero Anthropic cost. Zero loading state visible in UI — chips upgrade in place from the v1 generic set (still used as fallback during the Supabase round-trip and on lookup failure) to the brand-aware set once `loadCopilotSuggestions` resolves. Suggestions reload on accountId change so brand-switch keeps the chips in sync.

**Behavior preserved**: clicking a chip drops its text into the message textarea and focuses (same as v1). Only renders when `messages.length === 0` — empty welcome state. No surface area outside the welcome panel.

- **Sections touched:** Recent changes log; `Last updated`; §10 (no new route, but db.js gets a new helper documented inline).

### 2026-05-12 — AI Co-pilot v2 Phase 2c: AIImagePromptPanel rewrite around useObject + useCompletion ([PR #72](https://github.com/CodeFire98/lr-studio-dashboard/pull/72))
Client-side cutover for the two-step image-direction → image-prompt flow. Rewrote [AIImagePromptPanel.jsx](web/src/components/AIImagePromptPanel.jsx) around `experimental_useObject` (ideas mode, with a Zod schema mirrored from the server) + `useCompletion({ streamProtocol: 'text' })` (prompt mode). The v1's `parseSse` async generator, lenient `parseIdeasJson` (which stripped ```json fences and JSON.parsed on done), 7-phase explicit state machine (`'idle' → 'ideas_compose' → 'ideas_streaming' → 'ideas_picking' → 'prompt_compose' → 'prompt_streaming' → 'prompt_done'`), manual AbortController, and separate usage state all gone. Now: a `section` enum (`'idle' | 'ideas' | 'prompt'`) + sub-phase derived from each hook's `isLoading` / `error` / `object` / `completion`.

**Wire protocol switch**: [/api/ai/image](web/api/ai/image.ts) switched both modes from manual SSE event writers (`writeSseEvent('text', { delta })` / `writeSseEvent('usage', {...})` / etc.) to native `result.pipeTextStreamToResponse(res)`. The streamObject text-stream emits raw JSON-as-text deltas; `useObject` parses them progressively via `parsePartialJson` into `DeepPartial<IDEAS_SCHEMA>`. The streamText text-stream emits text deltas; useCompletion accumulates them. Both replace the legacy SSE events (`text` / `usage` / `done` / `error`) — last route on the v1 wire protocol is retired with this PR.

**Body shape change** (prompt mode only): `details` → `prompt`. Because `useCompletion` always sends the admin's free-form direction as `prompt` (the first arg to `complete()`), the server reads from `body.prompt` instead of `body.details`. Ideas mode body shape unchanged — `useObject.submit(input)` posts the input verbatim as JSON.

**Progressive idea cards**: the v1 model was "wait for full JSON, then parse, then render 3-5 cards at once". Phase 2c renders cards LIVE as the JSON streams in — each card fills in title → description → keywords as the partial JSON resolves. Cards are click-gated until they have BOTH title + description AND `ideasHook.isLoading` is false. This is the actual point of `useObject` (vs `useCompletion` for arbitrary JSON), so we lean into it.

**Inline usage meter dropped**: same tradeoff as Phase 2b's AICopyPreview — `useObject` / `useCompletion` don't surface usage to consumers. Cache observability moves to server logs — `streamObject({ onFinish })` + `streamText({ onFinish })` both log `[image] usage account=… plan=… platform=… mode=ideas|prompt input=… cache_read=… cache_write=… output=… finish=…` to Vercel Function Logs. Same monitoring path as `[copy] usage …` and `[chat]` (chat keeps its inline meter since `useChat`'s UIMessage protocol DOES surface usage via message metadata).

**Auth wiring**: per-request Supabase session token injected via a shared `fetchWithAuth` wrapper passed to both hooks — mirrors AICopyPreview (Phase 2b) and DefaultChatTransport.headers() (Phase 2a) patterns.

**Single endpoint preserved**: `/api/ai/image` keeps serving both modes from one route. They share auth (`is_agency` + allowlist), brand-context load, plan-load, and platform validation. Splitting into `/api/ai/image/ideas` and `/api/ai/image/prompt` would duplicate ~150 LoC of that pipeline for negligible benefit.

- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entries: text-stream-protocol-on-both-modes-of-image-route, progressive-idea-card-rendering-with-useObject, single-endpoint-for-both-image-modes). §10 Edge functions (`/api/ai/image` wire-protocol cutover; body shape change on prompt mode).

### 2026-05-12 — AI Co-pilot v2 cleanup: move system messages into streamText `system` param ([PR #71](https://github.com/CodeFire98/lr-studio-dashboard/pull/71))
Small standalone refactor across all three AI routes (`chat.ts`, `copy.ts`, `image.ts`). The AI SDK emits a security warning when role:'system' entries appear in `messages` arrays — that's in principle a prompt-injection risk vector. Our usage was safe (system content is 100% server-controlled — fixed SYSTEM_PROMPT constants + the brand-context blob), but the warning had been firing across all three routes since Phase 1a/1b/1c. Fix: move the two cached system blocks from `messages: [...]` into the dedicated `system: [...]` parameter. The AI SDK accepts `Array<SystemModelMessage>` for `system`, and each entry keeps `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` — so both cache breakpoints stay intact. No behavior change.

### 2026-05-12 — AI Co-pilot v2 Phase 2b: AICopyPreview rewrite around useCompletion ([PR #70](https://github.com/CodeFire98/lr-studio-dashboard/pull/70))
Client-side cutover for the inline AI draft / AI redraft surface. Rewrote [AICopyPreview.jsx](web/src/components/AICopyPreview.jsx) around the `useCompletion` hook from `@ai-sdk/react` — manual `parseSse` async generator, the explicit `compose` | `streaming` | `done` | `error` state machine, the separate AbortController, and the SSE `usage`-event extractor all gone. The wire protocol on [/api/ai/copy](web/api/ai/copy.ts) switched to the AI SDK's text-stream protocol via `result.pipeTextStreamToResponse(res)` — the legacy SSE event names (`text` / `usage` / `done` / `error`) are retired for this route.

**Body shape change**: `useCompletion` always posts `{ prompt, ...body }`, where `prompt` is the first arg to `complete()`. The admin's free-form instruction now rides as `prompt` instead of the v1 `instruction` field. Everything else (`accountId`, `plan_id`, `platform`, `mode`, `current_copy`) flows through the per-call `body` override.

**Inline usage meter dropped**: useCompletion's text-stream protocol doesn't surface usage to consumers, and adding a side-channel (custom fetch + response header trick) just for an inline debug indicator wasn't worth the complexity. Cache observability shifts to server logs — `streamText({ onFinish })` logs `[copy] usage account=… cache_read=… cache_write=… output=…` on every completion. Greppable in Vercel Function Logs. The breakage checklist in [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md) is updated with the new monitoring path.

**Auth wiring**: per-request Supabase session token injected via a custom `fetch` wrapper passed to `useCompletion` — mirrors the `DefaultChatTransport.headers()` async pattern from Phase 2a. No new env vars.

**Behavior preserved**: autofocus on instruction textarea, ⌘↩ to generate from the textarea, Stop mid-stream keeps partial text and lets the admin "Use this", Regenerate re-fires with the current instruction, mode=improve still passes the in-flight draft as `current_copy`.
- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entries: useCompletion-text-protocol-over-data-protocol-for-single-shot-completions, drop-inline-usage-meter-in-favor-of-server-log-observability). §10 Edge functions (`/api/ai/copy` wire-protocol cutover from custom-SSE to text-stream).

### 2026-05-12 — AI Co-pilot v2 Phase 2a: CopilotPanel rewrite around useChat + AI Elements ([PR pending])
Client-side cutover for the chat surface. Rewrote [CopilotPanel.jsx](web/src/components/CopilotPanel.jsx) around the `useChat` hook from `@ai-sdk/react` — manual `parseSse` async generator, manual messages state, manual abort controller, and the custom SSE event dispatcher all gone. The wire protocol on [/api/ai/chat](web/api/ai/chat.ts) switched to the AI SDK's native UIMessage data-stream protocol via `pipeUIMessageStreamToResponse` — the legacy custom SSE event names (`text` / `tool_call` / `tool_result` / `usage` / `done` / `error`) are retired for this route. The server's `messageMetadata` callback attaches per-message usage to UIMessage metadata; the client reads `message.metadata.usage` to power the token meter.

Assistant prose now uses **AI Elements `MessageResponse`** (Streamdown-backed) — proper Markdown: headers, lists, code blocks (with syntax highlighting), tables, etc. Replaces v1's tiny inline `renderProse` / `inlineMd` parser (which only handled `**bold**` and `` `code` ``). User bubbles keep the coral-on-white v1 styling via `.copilot-bubble` — explicitly NOT routed through AI Elements' Message component because shadcn's neutral `--secondary` token would gray out the bubble. Tool cards keep v1's compact visual (concept + platform pills + "Open plan →" CTA) but now read from the UIMessage `parts` model — each tool call is a `tool-{name}` part with state cycling through `input-streaming` → `input-available` → `output-available` | `output-error`.

**Bundle health**: AI Elements pulls in Streamdown + shiki language packs + mermaid (~1.7 MB total). The panel is **code-split via `React.lazy()`** in [App.jsx](web/src/App.jsx) so the eager bundle stays at the v1 baseline (735 KB main JS, gzip 202 KB — unchanged from pre-Phase-2a). The heavy AI Elements dependency tree only downloads when admin clicks the Co-pilot trigger.

**Path alias foundation**: `@/*` path alias added to [tsconfig.json](web/tsconfig.json) (TypeScript) + [vite.config.js](web/vite.config.js) (Vite resolver) so the standard shadcn-style imports (`@/components/ai-elements/*`, `@/lib/utils`) resolve. Phase 0's `components.json` was originally configured with raw `src/` prefixes; corrected to `@/` here so future `npx ai-elements add` calls produce standard imports.

**localStorage**: keyed under `lr_copilot_conv_v2_<userId>_<accountId>` (v2 prefix). v1 entries become orphaned — the v1 message shape (`{role, content, parts[]}` with custom tool-call objects) is incompatible with the new UIMessage shape (`{id, role, parts}` with SDK part discriminators). Admin starts fresh on first open after deploy; by design per AI_COPILOT_V2_MIGRATION.md's localStorage migration plan.
- **Sections touched:** Recent changes log; `Last updated`; §4 Tech stack (path alias note); §5 Repo layout (new `web/src/components/ai-elements/` directory); §13 Known decisions (entries: lazy-load-Copilot-to-protect-eager-bundle, wire-protocol-cutover-server+client-atomic, hybrid-rendering-user-bubble-coral-+-assistant-Streamdown, drop-AI-Elements-Conversation-conflicts-with-existing-scroll-overflow).

### 2026-05-11 — AI Co-pilot polish: cross-platform context inside a post plan ([PR #66](https://github.com/CodeFire98/lr-studio-dashboard/pull/66))
Three user-reported issues with how the AI routes use plan context, fixed together server-side. Pre-existing issues that surfaced clearly during v2 smoke testing — NOT v2 regressions.

1. **Inline AI copy drafts didn't reliably follow the active platform's format** — IG drafts sometimes came back LinkedIn-shaped. Root cause: platform requirements were buried at the bottom of a long user message in `/api/ai/copy`. Fix: platform requirements now sit at the TOP of the user message with "MUST FOLLOW STRICTLY — non-negotiable" framing, plus a closing reminder. Cache strategy unchanged (system prompt blocks still hold the brand context).

2. **AI copy didn't know about other platforms' captions on the same plan** — drafting IG then LinkedIn produced two unrelated angles instead of a coherent campaign across surfaces. Fix: `/api/ai/copy` now includes an `OTHER PLATFORMS' COPY ON THIS SAME PLAN` block in the user message when any sibling platforms have copy. Model is instructed to match the campaign angle/hook while adapting the format to the target platform.

3. **Image ideas + prompt only saw the active platform's caption** — visual direction lacked full campaign context. Fix: `/api/ai/image` now includes ALL platforms' captions on the plan (capped at 600 chars each), labelling the active one with "← THIS PLATFORM" so the model anchors aspect-ratio / format to it while staying tonally cohesive with sibling platforms.

- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entry: platform-requirements-at-top-of-user-message-for-strict-adherence; entry: pass-all-platforms-copy-as-cross-platform-context-on-AI-routes).

### 2026-05-11 — AI Co-pilot v2 Phase 1c: migrate `/api/ai/image` to Vercel AI SDK + retire PoC route ([PR #65](https://github.com/CodeFire98/lr-studio-dashboard/pull/65))
Final server-side migration PR. The image-ideation route now uses **`streamObject`** for `mode: 'ideas'` with a Zod schema for the `{ ideas: [{title, description, style_keywords[]}] }` output shape — replaces the v1 lenient JSON parser (strip ```json fences, retry-parse) hack. The model is now constrained by the schema at the SDK boundary AND the result is validated server-side. Schema enforces 3-5 ideas (min/max) so the model can't return 1 or 10. `mode: 'prompt'` uses `streamText` (same pattern as `/api/ai/copy`). Wire protocol unchanged on both modes — text deltas stream as `text` SSE events; the client's accumulate-then-parse-on-done flow keeps working untouched. Also DELETES the temporary `web/api/ai/cache-poc.ts` route — PoC retired now that all three production routes have migrated and the cache survival is end-to-end verified across `/api/ai/chat`, `/api/ai/copy`, and `/api/ai/image`.
- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (`/api/ai/cache-poc.ts` removed; `/api/ai/image.ts` now uses streamObject + streamText); §13 Known decisions (entry: streamObject-with-Zod-schema over raw JSON output for structured AI generations).

### 2026-05-11 — AI Co-pilot v2 Phase 1b: migrate `/api/ai/copy` to Vercel AI SDK ([PR #64](https://github.com/CodeFire98/lr-studio-dashboard/pull/64))
Server-only change to the inline AI draft / AI redraft route. Replaces raw `@anthropic-ai/sdk` + hand-rolled streaming with `streamText` from the Vercel AI SDK. Wire protocol unchanged (same SSE event names: `text` / `usage` / `done` / `error`) so [AICopyPreview.jsx](web/src/components/AICopyPreview.jsx) keeps working untouched until Phase 2b. Two cache breakpoints expressed via `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` — same caching behaviour as v1, verified by the PoC (PR #60). Bamboo Bear allowlist only.
- **Sections touched:** Recent changes log; `Last updated`.

### 2026-05-11 — AI Co-pilot v2 Phase 1a: migrate `/api/ai/chat` to Vercel AI SDK ([PR #62](https://github.com/CodeFire98/lr-studio-dashboard/pull/62))
The conversational chat route swap. Replaces the raw Anthropic SDK + manual `while (turn < MAX_TURNS)` tool-use loop with `streamText` + AI SDK `tool({ inputSchema (Zod), execute })` factories and `stopWhen: stepCountIs(8)`. The SDK now handles agentic looping + tool_use → tool_result message threading automatically. Wire protocol unchanged — [CopilotPanel.jsx](web/src/components/CopilotPanel.jsx) untouched. Tools `create_post_plan_draft` and `write_brand_note` re-expressed with Zod schemas; same side-effects on `post_plans` and `brand_kit_notes` tables. 464 LoC → 391 LoC net.
- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entries: SDK-managed agentic loop over manual MAX_TURNS while-loop; wire-protocol-preserved during server migration so client can swap in a separate phase). §10 Edge functions (`/api/ai/chat` implementation rewritten; behaviour identical).

### 2026-05-11 — Hotfix: scope shadcn CSS tokens under `.ai-elements` (restore coral `--accent`) ([PR #63](https://github.com/CodeFire98/lr-studio-dashboard/pull/63))
Production regression fix. Phase 0's `elements.css` had defined shadcn's neutral `--accent: 0 0% 96.1%` under `:root`, silently overriding `app.css`'s `--accent: #E8553D` (coral) because elements.css imports after app.css. Every button styled with `var(--accent)` lost its orange in prod (Co-pilot pill, "Open plan →" tool card button, user message bubbles, post-plan delete button, login modal submit). Two-piece fix: (1) scope the shadcn token block under `.ai-elements` selector instead of `:root`; (2) move it OUTSIDE `@layer base` so Tailwind v3.4's content-scan purging doesn't drop the block when no AI Elements files exist yet. AI Elements components in Phase 2+ MUST render inside `<div className="ai-elements">` to pick up the scoped tokens.
- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entry: scope-shadcn-tokens-under-`.ai-elements`-not-`:root`-to-avoid-clobbering-existing-design-tokens).

### 2026-05-11 — AI Co-pilot v2 Phase 0: Tailwind + shadcn foundation ([PR #61](https://github.com/CodeFire98/lr-studio-dashboard/pull/61))
Pipeline-only foundation. No live route or client component touched. Adds `tailwindcss@^3.4` (+ `postcss` + `autoprefixer`), `@ai-sdk/react`, `class-variance-authority`, `clsx`, `lucide-react`, `tailwind-merge`, `tailwindcss-animate`. New config files: `tailwind.config.js` (content glob scoped to `web/src/components/ai-elements/**` only; `corePlugins.preflight: false` to disable Tailwind's CSS reset), `postcss.config.js`, `components.json` (shadcn registry), `web/src/lib/utils.ts` (cn() helper). New `web/src/styles/elements.css` imported AFTER `app.css` in `main.jsx` so Tailwind utilities used inside ai-elements/* can override hand-written base styles per-component. JS bundle byte-identical. CSS bundle +3.7 KB raw / +0.65 KB gzipped (empty Tailwind base layer). Important: this PR's `:root`-scoped shadcn tokens caused a prod regression — fixed by the same-day hotfix PR #63 (now landed).
- **Sections touched:** Recent changes log; `Last updated`; §4 Tech stack (note: Tailwind v3.4 added, scoped to `ai-elements/` only — does not replace hand-written CSS); §13 Known decisions (entries: scope-Tailwind-via-content-glob-not-globally; disable-preflight-to-protect-hand-written-CSS; Tailwind-v3-over-v4 for shadcn-style compatibility).

### 2026-05-11 — AI Co-pilot v2: cache PoC + migration tracking doc ([PR #60](https://github.com/CodeFire98/lr-studio-dashboard/pull/60))
First commit of the AI Co-pilot v2 migration. Adds [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md) — the migration runbook with phase plan, rollback steps, cost model, and a "things that could break later" checklist. Adds a temporary verification route at `web/api/ai/cache-poc.ts` (agency-only) that runs two `generateText` calls 1.5s apart with identical `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` system messages and returns both calls' cache token counts. Confirmed: 3515 / 3529 input tokens served from cache (~99.6% hit rate) — the AI SDK provider produces identical Anthropic cache behaviour to the raw SDK. Migration is safe to proceed. Deps added: `ai@^6`, `@ai-sdk/anthropic@^3`, `zod@^4`. Live routes untouched.
- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (NEW: `/api/ai/cache-poc.ts` — TEMPORARY, scheduled for deletion after Phase 1c lands); §13 Known decisions (entries: AI-SDK-+-AI-Elements over SDK-only; PoC-before-Phase-0 to validate cache survival; preserve-wire-protocol during server migration; Bamboo-Bear-only allowlist scope through all v2 phases).

### 2026-05-11 — Rebrand to "Linkrunner Media" + dashboard polish (banner / search / brand-asset CTA / video thumbnails)

Five small but user-visible changes shipped together. The rebrand is a flat string swap; the rest are targeted UX improvements based on direct user feedback.

**1) Rebrand: "L+R Agency" → "Linkrunner Media" across all user-facing copy and docs.**
- Sidebar wordmark: "L+R Agency" → "Linkrunner Media" (split: word "Linkrunner" + accent tail "Media").
- All hero greetings, breadcrumbs, kicker labels, settings copy, password-reset page, error boundary, brand-onboarding subtitle, idea-inbox kicker, profile workspace line, ProfileView, admin queue, and the email-sender defaults (`EMAIL_FROM_NAME` fallback + invite/update/digest templates) updated.
- `index.html` `<title>` → "Linkrunner Media — Creative Agency".
- AI Co-pilot system prompt (`web/api/ai/chat.ts`) now identifies itself as "Linkrunner Media".
- `db.js` profile mapper: unassigned/agency role label flipped, initials "L+" → "LM".
- The team-nav entry "L+R Team" → "Linkrunner Team".
- Internal variable names (e.g. `window.LR_TWEAKS`, CSS class `lr-button-pulse`, storage keys `lr_copilot_conv_*`) deliberately left alone — they're identifiers, not brand-visible strings, and renaming would churn the codebase without any user benefit.

**2) Removed the agency banner ("Working in X · L+R Agency").** The banner sat directly above the topbar on every agency-side surface and was redundant — the BrandPicker in the sidebar already shows which brand is active, and the new wordmark already says "Linkrunner Media". Killed the `agencyBanner` derivation in [App.jsx](web/src/App.jsx) and the `<div className="admin-banner">` render branch. The `.admin-banner` CSS class stays — `inviteBanner` (membership-invite acceptance) still uses it.

**3) Removed the universal search bar from the topbar.** The "Search posts, ideas / ⌘K" input was non-functional — it had no submit handler, no suggestions, and no keyboard shortcut wired up. Shipping a placeholder UI for a feature that doesn't exist actively damaged trust ("the search doesn't work"). Removed the `<div className="topbar-search">` block from [App.jsx](web/src/App.jsx). The page-local search inputs in TasksView, LibraryView, LivePostsView, and BrandPicker are unaffected — those are scoped, functional inputs. Real cross-surface search is now an explicit roadmap item (see §14 Pending work).

**4) "Add brand asset" CTA promoted to the top of Brand Intelligence.** Previously the upload button lived inside `ReferencesCard` deep in the Creative Library section near the bottom of the page — most users never scrolled that far. Refactored:
- Extracted the asset state into a new `useBrandAssets(accountId)` hook (returns `{items, loading, uploading, err, uploadFiles, deleteItem}`). Lives in [BrandKitView.jsx](web/src/components/BrandKitView.jsx).
- New `<AddBrandAssetButton/>` primitive that wraps a hidden `<input type="file" multiple accept="image/*,video/*,application/pdf">` and shows an "Add brand asset" pill. Consumes the shared hook so the button's `uploading` state is wired without extra plumbing.
- `BrandKitView` calls `useBrandAssets()` once at the page level, mounts the button in the existing page-head `actions` row (alongside Fetch Brand + Export), and passes the hook result to `<ReferencesCard assets={assets}/>` at the bottom. The card kept its existing gallery + delete behaviour but no longer renders its own upload button.
- Empty state and card subtitle now point users to the top of the page ("Use **Add brand asset** at the top of the page to upload images, videos, or PDFs").
- File picker now also accepts `video/*` since (5) below makes video previews actually useful.

**5) Video upload thumbnails — client-side frame extraction, sidecar JPEG in the same bucket.** Until today, uploading a `.mp4` produced a grid tile with just a generic paperclip icon — no visual context, hard to scan a folder of reels. Now we pull a real frame out of the video right before upload and store it as a sidecar at `<storage_path>.thumb.jpg` in the same bucket. The mapper layer surfaces `thumbnailUrl` on every video attachment so UI tiles render a real preview with a "▶" play badge overlaid.

- **[web/src/lib/videoThumbnail.js](web/src/lib/videoThumbnail.js)** (new): `extractVideoThumbnail(file)` mounts a hidden `<video>` element, seeks to ~1s in (or 25% for very short clips — the first frame is often black/letterbox), draws the frame to a canvas, and returns a JPEG `Blob` at quality 0.82 with longest-side capped at 640px. 15-second timeout guard. Returns `null` on any failure (CORS, codec, hung load) so a failed thumbnail extraction never fails the parent upload. Also exports `isVideoFile(file)` and `thumbnailBlobToFile(blob, originalFilename)` helpers.
- **[web/src/lib/db.js](web/src/lib/db.js)** — three internal helpers + wired into every attachment upload + delete path:
  - `VIDEO_THUMBNAIL_SUFFIX = '.thumb.jpg'` — the sidecar naming convention. Storage `remove()` ignores missing keys silently, so we can always include the sidecar path in delete batches without checking the original mime first.
  - `uploadVideoThumbnailSidecar({bucket, storagePath, file})` — extracts + uploads the sidecar to the same bucket alongside the original, `upsert: true`. Awaited before the DB-row insert so the thumbnail URL exists by the time the realtime INSERT lands in other clients. Logs and returns `null` on failure rather than throwing.
  - `resolveVideoThumbnailUrl({bucket, storagePath, mimeType})` — returns the public URL of the sidecar if mime is `video/*`. Built unconditionally; if the sidecar upload failed at write time the browser falls back via `<SafeImage>` `onError`.
  - Wired into: `addPostPlanAttachment`, `addPostPlanIdeaAttachment`, `uploadBrandAsset` (extract + upload + roll-back-on-DB-error includes the sidecar path).
  - Mappers updated to surface `thumbnailUrl`: `mapPostPlanAttachmentRow`, `mapPostPlanIdeaAttachmentRow`, `listBrandAssets`, plus the rollup in `loadPostPlanListRollups` (calendar list-view popover).
  - Delete paths updated to remove the sidecar alongside the original: `deletePostPlanAttachment`, `deletePostPlanIdeaAttachment`, `deleteBrandAsset`.
  - `listBrandAssets` filters out the `.thumb.jpg` files from the gallery — they're shown implicitly as the preview for the matching video, not as their own tile.
- **UI consumers updated** to render the thumbnail when a video has one:
  - [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) — `AttachmentTile` now renders thumbnail + play-badge overlay for video uploads in both References and Final-assets cards.
  - [BrandKitView.jsx](web/src/components/BrandKitView.jsx) — `ReferencesCard` gallery tiles render video thumbnails with the same overlay pattern.
  - [CalendarView.jsx](web/src/components/CalendarView.jsx) — `AttachmentPopover` (paperclip-hover thumbnails in list view) shows the JPEG sidecar for video attachments.
  - [LibraryView.jsx](web/src/components/LibraryView.jsx) — asset-grid tiles render video thumbnails with the play overlay; existing image-thumb logic untouched.
  - [IdeateInboxView.jsx](web/src/components/IdeateInboxView.jsx) — idea-reference attachments now show video thumbnails inline.
- **[web/api/daily-digest.ts](web/api/daily-digest.ts)** — the cron's per-plan thumbnail picker now accepts video finals: previously it only set a thumbnail URL when `mime_type starts with image/`; now it also checks `video/` and builds the sidecar URL. So tomorrow's email digest will show real video frames when the brand's final asset is a reel instead of a generic platform-tile fallback.
- **No DB migration, no env vars, no storage policy changes.** The sidecar naming convention rides on the existing bucket RLS (the storage path's `accountId` prefix is the same as the parent video's), so the public read + agency/member write policies cover the thumbnail automatically.
- **Trade-offs deliberately not addressed**:
  - **No server-side thumbnail extraction**. Doing the extraction client-side means the user's browser pays the CPU cost (one frame decode + JPEG encode, ~50-200ms for typical files) but we don't need a video-processing pipeline anywhere on the server. The trade-off is that a user who closes the tab mid-upload uploads the video without a thumbnail; the UI shows the play-icon fallback in that case (acceptable).
  - **No backfill for existing videos**. Anything uploaded before today renders with the generic play-icon fallback. If/when this becomes a real issue we'd add a one-shot batch job that reads each video, extracts a thumbnail server-side, and uploads the sidecar. Defer until asked.
  - **One frame per video, no choice of timestamp**. The 1-second seek lands inside the action for most content (real recordings rarely have meaningful content in the literal first frame). If a brand asks for "thumbnail at this specific timestamp" we'd add a UI to pick — premature now.
- **Sections touched:** Recent changes log; `Last updated`; doc title (Linkrunner Media); §6 Storage buckets (sidecar naming convention note); §10 `daily-digest` route (video-thumbnail picker change); §13 Known decisions (client-side-thumbnail-extraction-over-server-pipeline; sidecar-naming-over-DB-column-for-thumbnail-path); §14 Pending work (added: universal search; removed: nothing).

### 2026-05-11 — Daily-digest idempotency (+ deploy-churn-vs-cron RCA)
Investigating "I didn't get the 6pm digest" on May 11. The `daily_digest_log` audit table showed zero rows from the 12:30 UTC scheduled fire — the route literally didn't run. Two other Claude session PRs (#56 at 12:29 UTC, #57 at 12:44 UTC) bracketed the cron's 12:30 UTC schedule on a busy merge day, putting Vercel into deploy churn through the entire flexible fire window (12:30–13:30 UTC on Hobby plan). The cron got silently skipped — known sharp edge of Vercel Hobby crons + busy deploy cadence.

No actual email was lost: an earlier manual "Run" at 07:36 UTC had already delivered the same digest to the same recipients (Linkrunner members got the May 12 digest with subject "Tomorrow's post needs your approval"). The 18:00 IST schedule would have sent the identical content; missing it cost nothing.

But the system shouldn't depend on humans noticing and clicking Run. Idempotency makes the route trivially safe to call from anywhere:

- **[web/api/daily-digest.ts](web/api/daily-digest.ts)** — top of `digestForBrand` now does `select id, run_at, sent from daily_digest_log where account_id = $1 and window_start_utc = $2 and sent > 0 limit 1`. On hit → `mkSkip(brand, "already_sent_today", "Found prior send for <label> at <run_at>")`. Cheap (~5ms), runs before any other DB query. Key is `(account_id, window_start_utc)` — `window_start_utc` is precise to IST tomorrow-midnight and robust across year wraparounds in a way the human label wouldn't be.
- **Recovery posture going forward.** If a future deploy churn (or Vercel hiccup, or anything else) causes the scheduled fire to miss, the admin clicks Run on the Vercel cron-jobs page. The route runs, sends to anyone who hasn't received the digest yet, skips anyone who has. Tomorrow's auto-fire then runs against tomorrow's `window_start_utc` and is unaffected. Multiple Run clicks within the same day → safe no-op.
- **The deeper reliability story is unfixed.** Vercel Hobby cron remains best-effort against deploy timing. Long-term hardening options worth considering: (a) move scheduling to Supabase `pg_cron` + `pg_net.http_post` (server-side, immune to Vercel deploy churn), (b) external cron service like cron-job.org pinging the route at 12:30 + 12:35 UTC (decoupled triggers), (c) upgrade to Vercel Pro (~5 min cron window instead of 1 hour). Idempotency makes all three of these safe to add later — they'd just trigger more often and the route would de-dupe.
- **Operational query** — after any suspected miss, check the audit log:
  ```sql
  -- Did the scheduled cron fire today? (rows = brand-count if yes, 0 if no)
  select count(*) from public.daily_digest_log
   where run_at >= date_trunc('day', now()) + interval '12 hours 25 minutes'
     and run_at <  date_trunc('day', now()) + interval '13 hours 35 minutes';
  ```
- **Sections touched:** Last updated; Recent changes; §13 Known decisions (idempotency-keyed-on-window-start-utc + Vercel-Hobby-cron-fragility note).

### 2026-05-11 — AI Co-pilot PR 7: image-prompt ideation (directions → detailed prompt)
The image-prompt surface the user asked for. Rather than a single random shot, the admin gets **3-5 image-direction ideas** to choose between first, then expands the chosen direction into a paste-ready prompt with any extra details. Sits above the Deliverables card on `PostPlanDetailView`. Agency-only, whitelisted-brands-only — same gate as the other AI surfaces.

**The two-step flow** (vs. one-shot generation):
1. Admin clicks "✨ Start image ideas" → optional brief textarea ("e.g. something playful for the holiday line") → Generate
2. AI returns 3-5 distinct directions as cards — different angles (studio product shot vs. in-context lifestyle vs. abstract vs. detail crop vs. behind-the-scenes), each with title + 1-2 sentence description + 3-6 style keywords
3. Admin clicks a card → optional "Additional details" textarea ("e.g. include hands holding the product, overcast morning light, shot on film") → Generate prompt
4. Detailed image-gen prompt streams in (100-250 words, covers subject / setting / composition / lighting / style / brand palette / texture)
5. Copy button → paste into Midjourney / DALL-E / Imagen / whatever
6. Navigate freely: "← Try another direction" goes back to the picker; "Regenerate" runs the same step again; "← Different brief" goes all the way back

- **`web/api/ai/image.ts` — new Vercel route**. Two modes:
  - **`mode: 'ideas'`** — system prompt instructs the model to output a JSON object matching `{ideas: [{title, description, style_keywords: []}]}`. Streams the JSON output as text; client accumulates and parses on stream-complete (lenient parser — strips stray ```json fences if the model ignores the "no markdown" instruction). Brand voice constraints from the cached context MUST inform every direction; if the brief is thin the model returns 3-4 distinct angles rather than padding with repeats.
  - **`mode: 'prompt'`** — given the chosen idea (title + description + keywords) + optional admin details, system prompt instructs the model to output a single detailed image-gen prompt covering subject + setting + composition + lighting + style + brand palette + texture, in 100-250 words. NO Midjourney `--ar` flags (admin adds tool-specific syntax themselves). Streams text deltas.
  - Same auth pipeline as `/api/ai/chat` (JWT → is_agency → `AI_COPILOT_BRAND_IDS`). Same prompt-cached system blocks (instructions + brand context blob) so cache reads across chat / copy / image surfaces within the 5-minute TTL — drafting copy and then generating image ideas for the same plan = cache hits on the brand context.
  - Pulls platform-specific copy from the plan as tonal context for both modes (caption tone informs visual direction); included in user message, capped at 800 chars per platform.
- **`web/src/components/AIImagePromptPanel.jsx` — new** state-machine component with 7 phases: `idle` → `ideas_compose` → `ideas_streaming` → `ideas_picking` → `prompt_compose` → `prompt_streaming` → `prompt_done`, plus `error`. Each phase renders only the relevant UI; back/forward navigation is explicit. Optional autofocus on the active textarea per phase. Abort-on-unmount cancels in-flight streams so closing the post plan mid-generation stops token billing immediately. Copy button uses `navigator.clipboard.writeText` with a `document.execCommand` fallback for old browsers; flips to a green "Copied" pill for 2 seconds.
- **`web/src/components/PostPlanDetailView.jsx`** — mounts `<AIImagePromptPanel/>` directly above the Deliverables card when `copilotEligible && isAdmin && plan?.id`. Passes the active copy-tab platform as the panel's `platform` prop (with fallback to first platform in the plan) so direction generation is tuned to the platform-specific aspect ratio / vocabulary.
- **`web/src/styles/app.css`** — new `.ai-image-*` block (~170 lines): card chrome with accent-tinted gradient, ideas grid (auto-fill columns, idea-card hover lift), chosen-direction summary block, prompt-output box with monospace-ish line spacing, "Copied" success state. Reuses `.copilot-dot` from the chat panel for the streaming indicators.
- **No new env vars, no migration** — reuses `ANTHROPIC_API_KEY` + `AI_COPILOT_BRAND_IDS` + `VITE_AI_COPILOT_BRAND_IDS` from PR 2. Vercel auto-deploys on merge.
- **What this changes about Bamboo Bear's image workflow today**: admin no longer types image prompts from scratch. They click "Start image ideas," skim 5 directions tuned to the brand voice, pick one, add any specifics, and paste a detailed prompt into their image-gen tool of choice. The brand-kit palette + photography style + voice tags + pinned brand notes all flow in via the cached context — so the directions match THIS brand, not generic stock advice.
- **Trade-offs deliberately not addressed**:
  - **No actual image generation**: this PR generates PROMPTS. Hooking up Midjourney / DALL-E / Imagen directly would lock us into one tool and burn meaningful compute for marginal value when the admin's image-gen workflow already exists elsewhere. The clipboard-paste flow keeps the admin's tool choice unconstrained.
  - **No multi-image generation in parallel**: the admin picks ONE direction → generates ONE prompt. If they want prompts for multiple directions, they Try Another Direction after copying the first. Cleaner than a side-by-side multi-prompt UI for v1.
  - **No history / saved prompts**: the prompt isn't persisted anywhere — copy and paste, done. If we hit a use case wanting prompt history (e.g. for re-shooting with the same direction later), we'd add a small `post_plan_image_prompts` table; defer until asked.
- **Sections touched**: Recent changes log; `Last updated`; Glossary (new entry: AI image direction); §10 Edge functions / API routes (new `/api/ai/image` subsection); §13 Known decisions (new entries: ideas-before-prompt UX over one-shot, prompt-generation-not-image-generation); §14 Pending work (PR 7 retired, queue continues with the Suggest concept slice and long-tail items).

### 2026-05-11 — AI Co-pilot PR 6: brand memory (write_brand_note + BrandKit notes UI)
The inflection point for the Co-pilot phase. Until today, every AI call started from the same baseline brand context — palette, voice tags, mission, the structured `brand_kits` columns. PR 6 turns on the **memory layer**: agency admin can tell the chat "remember that the founder hates the word authentic" and the AI persists it to the existing `brand_kit_notes` table (from PR 1). Every subsequent AI call — chat AND inline copy — automatically sees that fact as part of the brand context blob. Notes accumulate over time, so the month-3 Co-pilot for any brand knows things the month-1 Co-pilot didn't.

The `brand_kit_notes` table was scaffolded in PR 1 with empty contents waiting for this PR. The brand-context compiler in `brandContext.js` was already wired to read it (limit 20 most recent, pinned-first). So PR 6 is two pieces, both write-side:

- **New `write_brand_note` tool on `/api/ai/chat`** ([web/api/ai/chat.ts](web/api/ai/chat.ts)). Tool input: `{body: string, is_pinned?: boolean}`. Inserts a row into `brand_kit_notes` via service-role; `created_by = user.id`. System-prompt addition tells Claude when to call it (any "remember that…" / "make a note that…" / "from now on…" phrasing from the admin) and how to phrase the body ("declarative, action-oriented form, 1-3 sentences"). Pin guidance baked into the tool description: pin always-true facts; leave non-pinned for time-bound or campaign-specific context. Body length capped at 1000 chars server-side as a defensive guardrail.
- **BrandNotesSection card** ([web/src/components/BrandNotesSection.jsx](web/src/components/BrandNotesSection.jsx)) — new top-of-fold card in BrandKitView, sits just before the existing ReferencesCard. Header shows the note count next to the title. **Composer**: button reveals a textarea + "Pin (always-true fact)" checkbox + Save. **Note list**: pinned-first then chronological, each row shows the body + relative timestamp + Pin/Unpin + Edit + Delete actions (agency-only). Inline edit mode swaps the body for an autofocused textarea with Save/Cancel. Optimistic local mutations on every action; realtime subscription via `subscribeToBrandKitNotes` syncs cross-tab and cross-surface (a write from the chat tool-call appears here without refresh).
- **db.js helpers** ([web/src/lib/db.js](web/src/lib/db.js)) — five new functions: `mapBrandKitNoteRow`, `loadBrandKitNotes(accountId)`, `createBrandKitNote({accountId, body, isPinned, userId})`, `updateBrandKitNote(id, patch)`, `deleteBrandKitNote(id)`, `subscribeToBrandKitNotes(onChange, {accountId})`. Patch supports `body` and `isPinned`. The subscription mirrors the `post_plan_ideas` realtime pattern — unique channel-name suffix per subscriber to avoid the "cannot add callbacks after subscribe()" supabase-realtime-js trap.
- **CopilotPanel ToolCard update** ([web/src/components/CopilotPanel.jsx](web/src/components/CopilotPanel.jsx)) — renders a `write_brand_note` tool card with the note body in italics + a "Pinned" sub-label when `is_pinned=true`. So when the model saves a note mid-chat the admin sees exactly what got written, can verify, and can go to BrandKit view to edit/unpin if needed.
- **CSS** ([web/src/styles/app.css](web/src/styles/app.css)) — new `.brand-notes-*` block (composer, group label, note row, edit mode, delete-hover red, hover-reveal action row) and `.copilot-tool-note-*` for the chat-panel tool card.
- **No schema changes** — `brand_kit_notes` table + RLS shipped in PR 1's migration 0039. Nothing to apply.
- **No new env vars** — reuses `ANTHROPIC_API_KEY` + `AI_COPILOT_BRAND_IDS` + `VITE_AI_COPILOT_BRAND_IDS` from PR 2.
- **What this enables (the real story)**: brand-context compiler already reads up to 20 recent notes + all pinned ones, so notes flow into AI calls automatically — both the chat panel AND the inline copy preview. Tell the Co-pilot "remember that we always tag @sarahbamboo on milestone posts" — next time you click "AI draft" for an IG post on a milestone, the suggested copy already includes the tag. Without changing any other code.
- **Trade-offs deliberately not addressed**:
  - **No `delete_brand_note` / `update_brand_note` tools from chat**: notes are write-mostly via the AI. Curating (unpinning, editing wording, deleting outdated facts) happens in the BrandKit UI. Adding destructive tools to chat invites accidental data loss via misunderstood phrasing.
  - **No cross-brand global notes**: notes are scoped per-brand-account by design. The same agency can have different "facts" for different brands without bleed.
  - **No note categories / tags**: just freeform text + pinned/not flag. Adding categories complicates the UI without clear value while the corpus is small.
  - **No note search**: pinned + last 20 chronological is enough until note counts get unwieldy (>50/brand). Revisit then.
- **Sections touched**: Recent changes log; `Last updated`; Glossary (new entries: Brand note, Pinned note, write_brand_note tool); §6 Data model (no schema change — `brand_kit_notes` row stays, but added note about which surfaces write to it now); §10 Edge functions / API routes (`/api/ai/chat` tool list updated); §13 Known decisions (new entries: write-only memory from chat over destructive tools; brand-scoped notes over global); §14 Pending work (PR 6 retired; PR 7 = Suggest concept is next).

### 2026-05-11 — AI Co-pilot PR 5: instruction-driven AI draft / redraft
PR 4 shipped an inline "AI draft" button but the model had no specific direction — it just wrote whatever caption it thought made sense from the brand voice + concept, which was too random for production use. And "redraft" wasn't actually picking up the existing copy to improve. This PR rebuilds both flows around an **explicit instruction step** from the admin.

**New flow**:
1. Click "✨ AI draft" (empty textarea) or "✨ AI redraft" (textarea has content)
2. Preview block opens in **compose phase** — small textarea autofocused with a placeholder ("What should this post be about?" / "What should I change?")
3. Admin types their direction → ⌘↩ or click "Generate"
4. Switches to **streaming phase** — caption streams into the body below; Stop button to abort
5. **Done phase** — admin reviews. Instruction textarea is still visible so they can edit it and click **Regenerate** to iterate; or **Use this** / **Replace with this** to accept; or **Discard** to dismiss
6. For redraft: the in-flight draft (incl. unsaved edits in the textarea, not just the saved version) is sent as `current_copy`. The model treats it as the starting point and changes ONLY what the instruction asks — preserves the rest.

- **`web/api/ai/copy.ts`** — extended:
  - Body shape gains `instruction: string` (optional but strongly used) and `current_copy: string` (required for `mode: 'improve'`)
  - Two distinct system prompts: `SYSTEM_INSTRUCTIONS_DRAFT` and `SYSTEM_INSTRUCTIONS_IMPROVE`. Improve mode's prompt is critical — it tells the model to **preserve what works in the current caption and change ONLY what the admin asks**, NOT to rewrite from scratch ("Don't add changes they didn't ask for — match what they asked, no more, no less").
  - User message for `improve` includes the current copy verbatim (triple-quoted block) + the admin's instruction. For `draft`, the instruction (if any) is included as "ADMIN'S DIRECTION (the primary signal for what this post should be about)".
  - Empty instruction is allowed in both modes — in `draft` mode the model falls back to brand voice + concept (the PR 4 behaviour); in `improve` mode the model does a conservative single-pass polish.
  - The brand-context blob is unchanged → still hits the same prompt cache as `/api/ai/chat`, so back-to-back draft + redraft + chat operations within 5 min all cache against each other.
- **`web/src/components/AICopyPreview.jsx`** — rebuilt as a state machine: `compose` → `streaming` → `done` (or `error`). The instruction textarea stays mounted across all phases and remains editable after streaming completes, so the admin can iterate without closing the preview. ⌘↩ from the instruction input fires Generate. Stop button mid-stream keeps whatever's been received so far and moves to `done` (so the admin can use a partial result if it's already good enough). Regenerate re-fires with the current (possibly-edited) instruction; instruction remains editable between regenerations.
- **`web/src/components/PostPlanDetailView.jsx`** — passes `mode={draft.trim() ? 'improve' : 'draft'}` and `currentCopy={draft}` to `<AICopyPreview/>`. Note: `draft` is the in-flight `copyDrafts[platform]` state (controlled textarea), not the saved `copyVariants[platform]` — so any unsaved edits the admin made in the textarea are visible to the AI when they click redraft. Matches the user's intent — "improve what I have RIGHT NOW," not "improve what's saved on the server."
- **CSS** — `.ai-copy-preview-instruction` block (dashed-bottom-border separator, label, textarea, hint line showing ⌘↩ shortcut or "Edit instruction + Regenerate to iterate"). Visually distinct from the streamed-output area below so the admin's input is clearly separate from the AI's output.
- **What this PR replaces in the roadmap**:
  - **Generic "Improve" dropdown** (was PR 5 — "Shorter", "More playful", "Remove emojis", "Custom…"): **dropped permanently**. The free-form instruction textarea covers everything the dropdown would have, plus the long tail (anything the dropdown couldn't enumerate). Don't bring this back unless we hit a usage pattern that genuinely wants presets.
  - **A/B 3 variants** (was PR 6): **deferred to the long-tail backlog**. The instruction-driven loop covers the iterate case ("regenerate with a different instruction") natively, so A/B is less urgent. Revisit if multiple users explicitly ask for side-by-side comparison.
- **What's still queued**: PR 6 is now **brand memory** (was PR 7) — `write_brand_note` tool + BrandKit notes UI. PR 7+ same long-tail as before (Suggest concept, image prompt generator, trend → plan, performance feedback).
- **Sections touched**: Recent changes log; `Last updated`; §10 `/api/ai/copy` subsection (body shape, system prompts, behaviour); §13 Known decisions (new entry: instruction-as-required-input over generic-presets-or-no-direction); §14 Pending work (PR 5 retired and pre-existing PR-5 (generic Improve) deleted from the queue; PR-6 (A/B variants) moved to backlog; brand-memory promoted from PR 7 to PR 6).

### 2026-05-11 — AI Co-pilot PR 4: inline "AI draft" on the copy editor
First inline-AI surface inside `PostPlanDetailView`. Each platform's copy textarea now gets an "✨ AI draft" button in the EDIT-mode footer (only for agency users, only on Co-pilot-allowlisted brands). Clicking it streams a brand-voice caption suggestion into an inline preview below the textarea; admin reviews and applies / regenerates / discards. The chat panel from PR 2 is still the right tool for "plan a week" or brainstorming — the inline button is for the 50-times-a-day "draft the IG caption" workflow that's too small to context-switch into chat for.

- **`web/api/ai/copy.ts` — new Vercel serverless route**. Single-shot text generator. Body: `{accountId, plan_id, platform, mode: 'draft'}`. Same auth pipeline as `/api/ai/chat` (JWT → is_agency → `AI_COPILOT_BRAND_IDS` allowlist). Loads the target plan + brand context via service-role, sends Claude a tight system message ("output the caption text ONLY — no preamble, no quotes, no explanation") with the brand-context blob cached via `cache_control: ephemeral`, plus per-platform copy guidance (IG: hooks + line breaks + 150-300w; LinkedIn: authority + warmth + mobile breaks; X: 280 chars hard cap). Streams `text` / `usage` / `done` / `error` SSE events. **Deliberately no tool use** — this isn't an agentic loop, it's a "give me text" call. `max_tokens: 700`. Caches the system + brand-context blocks so back-to-back drafts (e.g. draft IG, then draft LinkedIn for the same plan) hit Anthropic's 5-min cache and cost ~$0.001-0.003 per call after the first.
- **`web/src/components/AICopyPreview.jsx` — new** inline preview component. Self-contained: owns its own SSE parser, abort controller, and stream lifecycle. Auto-starts on mount; aborts on unmount (closing the preview mid-stream stops token billing immediately). Renders a card with a header ("AI draft for {Platform}" + streaming indicator + token-usage meter), the streamed text in a `<pre>`-wrapped block (preserves whitespace, allows line breaks to render naturally), and three action buttons: **Use this / Replace with this** (calls `onAccept(text)` — parent updates the textarea via the existing `handleCopyChange` path so the user's normal Save/Done flow persists), **Regenerate** (aborts current stream, re-fires the request — useful when the first take isn't quite right), **Discard** (aborts + closes the preview).
- **`PostPlanDetailView.jsx`** — new state `aiPreviewPlatform` (which platform's preview is currently open, or null). Single-open-at-a-time semantics — opening on LinkedIn closes IG's preview. New button in the EDIT-mode footer:
  - Renders only when `copilotEligible` (prop from App.jsx) AND no preview is currently open for this platform AND admin role.
  - Label adapts: **"✨ AI draft"** when the textarea is empty; **"✨ AI redraft"** when there's existing copy (signals that accepting will replace what's there).
  - Preview renders inline below the textarea + footer. `onAccept` writes the generated text to the draft state via `handleCopyChange(activeCopyTab, generated)` — the existing draft → blur-save flow takes over from there, so the AI's output is treated identically to anything the user typed (editable, unsaved-changes indicator, can Cancel back to the saved version).
- **App.jsx** — passes `copilotEligible={copilotEligible}` to `<PostPlanDetailView/>`. The same flag that gates the topbar Co-pilot trigger gates the inline button: agency + brand-in-allowlist + not all-clients mode.
- **CSS** — `.ai-draft-btn` (accent-tinted gradient pill matching the topbar trigger), `.ai-copy-preview` + sub-classes for the inline preview card (head/body/actions sections, accent-tinted top border, fade-in animation, token-usage meta). The accent-tint colour family stays consistent across all AI-related surfaces — topbar trigger, sidebar panel, AI draft pill, inline preview — so the agency learns the visual language once.
- **Trade-offs deliberately not addressed**:
  - **No "Improve" mode yet** — only fresh drafts. Adding `mode: 'improve'` to `/api/ai/copy` + an "Improve" dropdown to the button is the next logical PR. Wanted to ship `draft` alone first to validate the basic pattern (preview UX, accept flow, stream stability) before layering on the conversation-style "tell me what to change" surface.
  - **No A/B variants** — generating 3 angles and showing them side-by-side is its own design surface (comparison UI, per-variant accept button). Separate PR.
  - **No "Suggest concept" yet** — that surface (calendar empty-day right-click, `ConvertIdeaModal` pre-fill) is a different shape from per-platform copy generation. Will land alongside the calendar / ideas integration.
- **Cost shape**: a single "AI draft" call costs ~$0.005-0.015 first-time (brand-context cache write), ~$0.001-0.003 on subsequent drafts within the same 5-min window. Drafting copy for IG + LinkedIn + X on the same plan = roughly one full-price call + two cached calls = ~$0.01-0.02 total. Agency drafting 30 plans/week ≈ $0.30-0.60/week per brand for inline drafts.
- **Sections touched**: Recent changes log; `Last updated`; §10 Edge functions / API routes (new `/api/ai/copy` row + full subsection); §13 Known decisions (new entry: separate `/api/ai/copy` endpoint over adding a tool to `/api/ai/chat`); §14 Pending work (PR 4 retired; PR 5 inline-improve queued).

### 2026-05-11 — AI Co-pilot PR 3: conversation persistence + Start new button
Lakshith's first real-use feedback after PR 2 went live: closing the Co-pilot panel destroyed the conversation. Fixed by persisting messages to localStorage on every change, keyed by `(userId, accountId)` so multi-staff browsers + multi-brand workflows each get their own thread. Closing the panel, refreshing the page, or switching brands no longer loses history.

- **[CopilotPanel.jsx](web/src/components/CopilotPanel.jsx)** —
  - `loadPersistedMessages(userId, accountId)` and `persistMessages(userId, accountId, messages)` helpers backed by `localStorage.lr_copilot_conv_<userId>_<accountId>`. Empty string / missing / corrupt JSON returns `[]` safely.
  - Initial `useState` reads from localStorage so the panel mounts with the previous conversation already visible.
  - On `accountId` change (brand switch via BrandPicker), swap to that brand's persisted conversation. Previously we cleared on every brand change.
  - On every messages-array mutation, save to localStorage. Trimmed to last 60 messages to keep growth bounded (oldest user-message-and-response pairs drop off). Each conversation maxes out around ~50KB of localStorage — well under the 5MB browser cap even with dozens of brands.
  - New `startNew()` action: aborts any in-flight stream, asks for confirmation if there's existing history, then clears state + removes the localStorage entry.
- **New header button** — when `messages.length > 0`, a small "Start new" pill renders next to the close button. Hidden when the conversation is empty (nothing to "reset").
- **App.jsx** — passes `userId={auth?.id}` to `<CopilotPanel/>` so the localStorage key namespaces by user. Otherwise two agency staff sharing the same browser would clobber each other's threads.
- **CSS** — `.copilot-header-actions` flex container; `.copilot-header-btn` for the "Start new" pill (line border, hover-shifts-to-accent — matches the existing pattern from sidebar nav).
- **Trade-offs intentionally not addressed**:
  - **Multiple named conversations per brand** (like ChatGPT history): scope creep for v1. One active conversation per brand is enough until users ask for more.
  - **Cross-device sync**: localStorage is browser-local. If the agency lead chats on their laptop, opens the dashboard on their phone, they won't see the same history. Solving this means a DB table — defer until someone asks.
  - **Stream-mid-close handling**: if you close the panel mid-stream, the partial response is saved as-is. Reopening shows the partial assistant message with no streaming indicator. The user can `Start new` or continue the conversation; we don't try to "resume" the in-flight call (the abort is final).
- **Sections touched**: Recent changes log; `Last updated`; LocalStorage keys (new `lr_copilot_conv_<userId>_<accountId>` row); §13 Known decisions (new entry: localStorage over DB for v1 chat persistence).

### 2026-05-11 — AI Co-pilot PR 2: chat route + sidebar panel + AI draft pill
First user-facing slice of the agency-side AI Co-pilot. Agency staff on a whitelisted brand can open a right-edge slide-in chat panel, ask the model to plan posts / draft copy / brainstorm, and receive real `post_plans` rows pre-filled and marked as "✨ AI draft" — they edit in the existing detail view and submit for review through the standard workflow. The "propose-first, in-the-post-plan-view, editable" UX the user spec'd in the design brainstorm.

- **`@anthropic-ai/sdk` dependency** added to [web/package.json](web/package.json). Server-side only — the SDK is imported by [web/api/ai/chat.ts](web/api/ai/chat.ts), not by any client code, so it doesn't land in the SPA bundle.
- **`web/api/ai/chat.ts` — new Vercel serverless route**. Streams Claude responses over Server-Sent Events. Auth mirrors `find-competitors.ts`: caller JWT verified by the anon-key Supabase client, agency-staff check via service-role lookup of `profiles.is_agency`, then a whitelist check against the `AI_COPILOT_BRAND_IDS` env-var allowlist (comma-separated UUIDs). Two cache breakpoints on the system prompt — fixed instructions + per-brand context blob — so back-to-back chat turns hit Anthropic's 5-min prompt cache. Default model `claude-sonnet-4-6`; `max_tokens: 1500` per turn; `MAX_TURNS = 8` cap on the agentic tool-use loop. Tools: **`create_post_plan_draft`** (only tool wired in this PR — inserts a real `post_plans` row via service-role with `status='drafting'`, `ai_generated=true`, `ai_draft_payload=<original tool args>`). SSE event types emitted to the panel: `text` (token deltas), `tool_call` (input args of an in-flight tool), `tool_result` (success/failure + payload), `usage` (input/output/cache token counts for the per-call meter), `done` (with the model's `stop_reason`), `error`.
- **`web/src/components/CopilotPanel.jsx` — new** slide-in right-edge drawer (420px wide, animates in over 220ms). Header shows brand name + close button; scroll area renders user bubbles, assistant prose, and tool-call cards interleaved; footer holds a textarea (⌘↩ to send) and a per-call token-usage meter. Empty state shows three example prompts the admin can click to populate. Streams via `fetch` + manual SSE parser (`parseSse` async generator) — no event-source library, since EventSource doesn't support POST bodies or auth headers. Tool-call cards render in three states (`running`/`ok`/`error`) and a successful `create_post_plan_draft` shows an "Open plan →" button that navigates to the new plan's detail view + closes the panel. Chat state is in-memory only — resets when the active brand changes or the panel unmounts. No persistence in PR 2; that's a follow-up if a user asks.
- **`web/src/App.jsx` — Co-pilot trigger + panel mount**. New "✨ Co-pilot" pill button in the topbar (right side, next to the Submit-idea CTA). Conditionally rendered when `copilotEligible` — i.e. `auth.isAgency` AND not in All-clients mode AND `scopeAccountId` is in the `VITE_AI_COPILOT_BRAND_IDS` allowlist (a `Set` built once at module load from the env var). Toggles a `copilotOpen` state; opening renders `<CopilotPanel/>` as a sibling of `<TweaksPanel/>`. Auto-closes when the user switches to a non-whitelisted brand via BrandPicker — `useEffect` watches `copilotEligible` and flips `copilotOpen=false` if it drops to `false` mid-session.
- **`web/src/lib/db.js`** — `mapPostPlanRow` now surfaces `aiGenerated: row.ai_generated === true` and `aiDraftPayload: row.ai_draft_payload || {}` so every consumer (CalendarView, PostPlanDetailView, etc.) gets the AI metadata for free. Trivial additive change.
- **`web/src/components/PostPlanDetailView.jsx`** — small "✨ AI draft" pill rendered next to the StatusPill in the page-head sub-row, only when `plan.aiGenerated === true`. Tooltipped: "Created by the AI Co-pilot. Edit, then submit for review through the normal workflow." Visually a soft accent-tinted capsule — distinct from the StatusPill (which is workflow-bucket coloured) but clearly secondary.
- **`web/src/styles/app.css`** — new `.copilot-*` section (~250 lines) for the panel + trigger button + tool cards + typing indicator + token meter, plus `.ai-draft-pill` for the PostPlanDetailView badge. Slide-in animation from the right edge.
- **Required env vars on the `lr-studio-dashboard-3kkp` Vercel project (all 3 environment toggles)**:
  - `ANTHROPIC_API_KEY` — `sk-ant-...` from https://console.anthropic.com/settings/keys. Server-only, never exposed to the SPA bundle.
  - `AI_COPILOT_BRAND_IDS` — comma-separated UUIDs of brands that get to use the Co-pilot. Empty = nobody can. The server enforces this allowlist regardless of what the client UI claims.
  - `VITE_AI_COPILOT_BRAND_IDS` — same value, exposed to the client so the SPA renders/hides the topbar button. The server is the real authz boundary; the client mirror is just for the conditional render.
- **No new migration** — PR 1 already shipped the `ai_generated` + `ai_draft_payload` columns and the `brand_kit_notes` table (none of which is wired into UI yet in PR 2 — that's PR 3+).
- **Cost shape (per the design brainstorm)**: with prompt caching, a typical chat turn for a warm brand context costs ~$0.005–0.02. A "plan-the-week" multi-tool agentic loop costs ~$0.05–0.10. Expected per-brand monthly spend at moderate use: $3–5. The token-usage meter in the panel footer surfaces input / output / cache-read counts so the agency can see the cache landing in real-time.
- **Sections touched**: Recent changes log; `Last updated`; §10 Edge functions / API routes (new `/api/ai/chat` row + full subsection); §12 External accounts & secrets (Anthropic key); §13 Known decisions (new entries: SSE-streaming pattern, whitelist-as-rollout-gate, separate-tool-per-action, allowlist enforced on both client and server); §14 Pending work (PR 2 line removed; new line for PR 3 inline-AI buttons).

### 2026-05-11 — Daily-digest cron auth: switched to CRON_SECRET shared bearer
First production miss of the daily-digest (Bamboo Bear May 10) was diagnosed today after the `daily_digest_log` audit table landed. Root cause: the cron route was sending `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}` from Vercel env, but that env now holds the new `sb_secret_…` opaque format rather than a legacy `eyJ…` JWT. The send-email function's platform `verify_jwt: true` requires a real Supabase-signed JWT and rejected the call with `UNAUTHORIZED_INVALID_JWT_FORMAT` before our dispatcher ran. The decode-and-check-role logic from PR #47 never executed.

Robust fix — eliminate the Supabase-key-format dependency entirely by using a shared opaque secret that both sides control:

- **[web/api/daily-digest.ts](web/api/daily-digest.ts)** — when calling send-email, send `Authorization: Bearer ${CRON_SECRET}` (same env var Vercel uses to authenticate its own cron calls *into* this route). One-line change.
- **[supabase/functions/send-email/index.ts](supabase/functions/send-email/index.ts)** — new `Deno.env.get("CRON_SECRET")` read. The daily-digest dispatcher branch now does a literal `token !== CRON_SECRET` compare. Dropped the JWT-decode helper that PR #47 added; no longer needed.
- **Edge function `verify_jwt: false`** — required to let `Bearer <random-hex>` bearers through the platform gate. Other templates (`team-invite`, `agency-update`) still require user-JWT auth, but that's enforced inside our code via `auth.getUser()` against ANON_KEY — equivalent security guarantee to the platform check, just done in our handler.
- **Supabase function secret** — `CRON_SECRET` set via `supabase secrets set CRON_SECRET=<same-value-as-Vercel>` so the edge function can read it. Same value on both sides; we don't generate a second secret.
- **Sections touched:** Recent changes; Last updated; §10 Edge functions (send-email auth model rewrite); §13 Known decisions (CRON_SECRET-as-shared-secret over JWT-comparison rationale).

### 2026-05-11 — AI Co-pilot scaffolding (PR 1 of the AI-native phase)
First slice of the agency-side AI Co-pilot. Pure additive foundation — schema lands now so PR 2 can wire the `/api/ai/chat` Vercel route and the sidebar Co-pilot panel without re-architecting. Nothing in the SPA reads any of this yet; whitelist gating ships with PR 2.

- **Migration `0039_ai_copilot_scaffolding`** (renumbered from 0038 during merge — main's `0038_daily_digest_log` landed first) — two pieces:
  - **`brand_kit_notes` table** (id, account_id FK → accounts, body text, `is_pinned` boolean, created_by FK → profiles ON DELETE SET NULL, created_at, updated_at). Free-form admin annotations that don't fit the structured `brand_kits` columns — "the founder hates the word 'authentic'", "no holiday content until Oct 15", "always tag @cofounder on milestone posts". Will be written by hand from the BrandKit UI (later PR) AND by the Co-pilot itself via a `write_brand_note` tool when the admin says "remember that …". RLS mirrors `post_plan_ideas`: agency staff OR members of the account can SELECT/INSERT/UPDATE/DELETE. `touch_updated_at` trigger; added to `supabase_realtime`. Composite index on `(account_id, is_pinned desc, created_at desc)` matches the load query (`is_pinned` first, then recency).
  - **`post_plans.ai_generated boolean default false`** + **`post_plans.ai_draft_payload jsonb default '{}'::jsonb`** — marks AI-proposed plans. The admin still owns the row — they edit it in `PostPlanDetailView` and submit through the existing workflow. `ai_draft_payload` stores the original Co-pilot tool-call arguments so we can diff "what AI proposed" vs "what shipped" (for acceptance-rate telemetry) and offer a "reset to AI draft" affordance if the admin over-edits. Partial index `post_plans_ai_generated_idx ON (account_id, created_at desc) WHERE ai_generated = true` for the eventual "show me AI drafts" query path — stays small since the vast majority of rows are `ai_generated = false`.
- **`web/src/lib/brandContext.js`** — brand-context compiler. Two exports:
  - **`compileBrandContext({ brandKit, notes, recentApprovedPlans })`** — pure function. Takes raw DB rows (snake_case columns from `.select('*')`) and returns the final string. Importable from browser SPA AND the future Vercel API route (PR 2) so server-side rendering uses the same blob shape. Output is a structured markdown-style string with these sections (rendered conditionally — empty sections drop out): Brand identity, Voice, Strategy, Visual identity, Competitors, Tracked hashtags, Notes from the agency admin (pinned first, then recent), Recent approved posts (last 6 as style references, truncated to 280 chars per platform).
  - **`loadAndCompileBrandContext(supabaseClient, accountId)`** — async wrapper. Three parallel queries (brand_kits + brand_kit_notes + approved post_plans) then calls the pure compiler. Works with both the publishable-key client (browser, RLS-scoped) and the service-role client (server, full access) — PR 2 will call this from the Vercel route with service-role.
- **Why a separate compiler module instead of inlining into the future route**: prompt caching is the entire cost story for this feature (Anthropic's 5-min cache TTL gives ~90% input-token discount). The compiled blob must be **stable per brand** for cache hits to land — recompiling the same brand's blob twice must produce byte-identical output. A pure, single-file compiler with no hidden state is the easiest way to guarantee that. Also lets us unit-test the blob shape in isolation later if needed.
- **Why notes live in a separate table, not as jsonb on `brand_kits`**: notes are append-mostly with their own lifecycle (created_by, is_pinned, individual delete), and the Co-pilot will write to this table frequently. A row-per-note shape gives us clean RLS, realtime subscriptions per note, and individual edit/delete without race conditions on a giant jsonb blob. Same pattern as the `brand_kits` ↔ `brand_kit_enrichments` split from migration 0017.
- **Sections touched**: Recent changes log; `Last updated`; Glossary (new entries: AI Co-pilot, brand_kit_notes, AI draft, brand context); §6 Data model (new `brand_kit_notes` table + new `post_plans` columns); §6 Migrations list (0039 row); §13 Known decisions (new entry: compiler-as-pure-function for cache stability; new entry: notes-as-table-not-jsonb); §14 Pending work (PR 2 scope: `/api/ai/chat` route + sidebar Co-pilot panel + brand-id whitelist).

### 2026-05-11 — `daily_digest_log` audit trail for the cron route
Investigating a missed daily-digest email for Bamboo Bear (2 plans qualified, no email arrived) hit a visibility wall: Vercel runtime logs retain ~24h on Hobby, the Observability invocations page filters to 12h, and the cron's only output was Vercel's logs. No DB trail. Fixing that gap so the next "did email X go out on day Y?" is one SQL query.

- **Migration `0038_daily_digest_log`** — new table `daily_digest_log` (id, run_at, account_id FK accounts ON DELETE SET NULL, brand_name, sent, failed, recipients, plans_needs_review, plans_approved, skip_reason, skip_details, window_start_utc, window_end_utc, tomorrow_ist_label). Two indexes — `(run_at desc)` and `(account_id, run_at desc)`. RLS: agency staff read; no INSERT/UPDATE/DELETE policy (service-role bypass is the only write path, matching `post_plan_status_log`'s shape).
- **`web/api/daily-digest.ts`** — after the per-brand loop finishes, bulk-insert one row per BrandResult into `daily_digest_log`. Failure to write the audit log is logged but doesn't fail the run (email send is the primary goal; the trail is a nice-to-have).
- **Sections touched:** Recent changes; Last updated; §6 Data model (new table row); §6 Migrations list (0038); §13 Known decisions (audit-as-table rather than read-from-logs).

### 2026-05-09 — Image render guard: validate uploads + graceful fallback for oversize files
Real bug surfaced after the daily-digest shipped: a Bamboo Bear plan's three reference PNGs rendered as broken-image icons in the dashboard. `curl` returned the bytes fine — turned out the PNGs were **32768×21846 pixels each (~716 megapixels)**. The on-disk file is only ~3.7 MB (PNGs compress well) but decoded it's ~3 GB of RGBA pixel data, which no browser will allocate. The browser's response was to fall back to its default broken-image-with-alt-text placeholder, which looked broken instead of informative.

Two fixes ship together:

- **`web/src/lib/imageValidation.js` — client-side dimension validator** that runs before any image upload. Uses the browser's own `Image()` decoder (resolves with `naturalWidth`/`Height` on load, rejects on error) so the check is accurate for every format the browser can display. Limits: **8,192 px in any dimension**, **~33 megapixels total** — comfortable for everything we'd realistically want to display while rejecting the pathological cases (e.g. iPhone Pro RAW exports, AI-upscaled reference shots) that look broken to every viewer regardless of their hardware. Throws a friendly `Error` with the filename + actual dimensions; non-image files (PDFs etc.) and SVGs skip the check.
- **Wired into every upload entry point in [web/src/lib/db.js](web/src/lib/db.js)** — `addPostPlanAttachment`, `addPostPlanIdeaAttachment`, `uploadAsset` (legacy task assets), `uploadBrandLogo`, `uploadBrandAsset`. Validator throws BEFORE the storage upload starts, so oversize files never hit the bucket. All callers already wrap in try/catch with user-facing error display (alert / inline banner), so the friendly error message ("Image is 32768×21846px — too large to display in browsers (max 8,192px on any side). Resize and re-upload.") surfaces verbatim.
- **`web/src/components/SafeImage.jsx` — drop-in `<img>` replacement** with an `onError` handler that swaps to a fallback tile when the browser can't render the image. Tile shows: icon + "Preview unavailable" caption + filename. Inherits the parent container's box dimensions so it slots into any thumbnail grid without layout shift. Resets failure state when `src` changes (prevents a stuck-on-fallback bug for re-used component instances).
- **Replaced 5 `<img>` tags with `<SafeImage>`** across all surfaces that render bucket assets:
  - [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) — AttachmentTile (the original screenshot's case)
  - [Lightbox.jsx](web/src/components/Lightbox.jsx) — full-size image preview, with caption pointing the user to the Download button when the image is too large to render
  - [LibraryView.jsx](web/src/components/LibraryView.jsx) — asset grid tiles
  - [CalendarView.jsx](web/src/components/CalendarView.jsx) — AttachmentPopover hover thumbnails
  - [IdeateInboxView.jsx](web/src/components/IdeateInboxView.jsx) — idea reference attachments
  - [BrandKitView.jsx](web/src/components/BrandKitView.jsx) — brand assets card + OG preview image
  - [TaskDetailView.jsx](web/src/components/TaskDetailView.jsx) — task asset thumbnails
  - [TasksView.jsx](web/src/components/TasksView.jsx) was left alone — it already has its own `onError → setFailed(true)` flow that swaps to a different layout kind, more bespoke than `<SafeImage>`'s generic fallback.
- **Existing oversize files in storage** are NOT migrated or deleted — they'll just keep rendering as the new "Preview unavailable" placeholder. The Lightbox download button still works on them, so users can save the original locally if needed.
- **Sections touched:** Recent changes log; `Last updated`; Glossary (new entry for SafeImage / image validator); §13 Known decisions (browser pixel limits + why we cap at 8192px / 33MP); §14 pending work (auto-resize on upload as a future-friendlier alternative to outright reject).

### 2026-05-08 — Daily 6pm-IST digest email of tomorrow's posts (brand-side)
Brand members now get an automated email every evening at 6pm IST listing tomorrow's scheduled posts, split into "Needs your approval" (`needs_review`) and "Ready to ship" (`approved`). Drafting plans are excluded — the brand can't act on them; that's an agency-side concern. Plans already posted (have a publication row) are also excluded. The email never fires for a brand with zero qualifying plans tomorrow.

Architecture: **Vercel Cron** at `30 12 * * *` (12:30 UTC = 18:00 IST) hits a new `/api/daily-digest` route (the orchestrator); the route queries every brand with `daily_reminder_enabled=true`, prepares per-brand payloads (plans, recipients via the existing `account_members_with_email` RPC, thumbnails from `post_plan_attachments` of `kind='final'`), and POSTs each one to the existing `send-email` edge function with a new `template: 'daily-digest'` case. The edge function renders the HTML and fans out to recipients via Resend's `/emails/batch` endpoint (one envelope per recipient, addresses don't leak between members).

- **Migration `0037_daily_reminder_settings`** — adds `accounts.daily_reminder_enabled boolean not null default true`. No timezone column for v1: every customer is in India today; expansion will add `accounts.timezone` and have the cron honour it. The 6pm-IST cron + IST tomorrow-window math is hardcoded in `web/api/daily-digest.ts` for now.
- **`web/api/daily-digest.ts` (Vercel API route)** — new orchestrator. Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel injects it for cron invocations; manual triggers must pass it). Computes the IST tomorrow window in UTC (`[next IST midnight, day-after IST midnight)`), iterates brands with the toggle on AND `type='brand'` (agency workspace excluded by design), and for each brand: queries plans in window matching `status IN ('needs_review','approved')`, drops any with publication rows, bulk-loads thumbnails (newest final asset per plan), resolves recipients, then POSTs the assembled payload to the edge function. Per-brand failures are logged and don't abort the run.
- **`send-email` edge function — new `daily-digest` case** ([supabase/functions/send-email/index.ts](supabase/functions/send-email/index.ts)) — bypasses the user-JWT auth path: caller must present the service-role bearer (the cron route holds it). Other templates always require user auth. The renderer uses inline-CSS table layout for email-client compatibility, hardcodes the same status pill colours as `postPlanShared.jsx` (mustard `#A16207` for needs_review, green `#15803D` for approved), and falls back to a styled platform-tile composition when a plan has no final-asset thumbnail. Subject-line variants per plan-count + status: e.g. `Tomorrow's posts · 2 need your approval` (mixed), `Tomorrow's 3 posts · all approved` (all approved), `Tomorrow's post needs your approval` (single needs_review), `Tomorrow you're posting on Instagram` (single approved). Plain-text fallback included for accessibility / image-blocking clients.
- **`vercel.json` — new `crons` array** ([web/vercel.json](web/vercel.json)) — single entry pointing `/api/daily-digest` at the `30 12 * * *` schedule. Vercel Cron auto-injects the bearer header.
- **`SettingsView.jsx` — new Notifications section** ([web/src/components/SettingsView.jsx](web/src/components/SettingsView.jsx)) — brand-only card between Workspace and Danger zone with a single toggle "Daily 6pm IST reminder" that hits `updateDailyReminderEnabled` in `db.js`. Optimistic flip with revert on failure; agency workspace doesn't see the section (the cron route ignores `type='agency'` regardless).
- **db.js helpers** ([web/src/lib/db.js](web/src/lib/db.js)) — `loadDailyReminderEnabled(accountId)` + `updateDailyReminderEnabled(accountId, enabled)`. Tiny — single-column reads/writes on `accounts`.
- **Required env vars on the Vercel deployment** — `CRON_SECRET` (any opaque string; Vercel injects this for cron auth), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (already in place for `fetch-trends`), `APP_URL` (default `https://agency.linkrunner.io`).
- **Sections touched:** Recent changes log; `Last updated`; Glossary (Daily reminder); §6 Data model (new column on `accounts`); §6 Migrations (0037 row); §10 Edge functions (send-email gains `daily-digest`); new §10 entry for `/api/daily-digest`; §13 Known decisions (cron-route-orchestrator + edge-function-renderer split, IST hardcoded for v1, drafting excluded from brand-side digest); §14 Pending work (manual-trigger affordance + agency-side notification flow added to roadmap).

### 2026-05-08 — Sidebar relabels + invite-redemption pre-flight email check
Two lightweight UI relabels and one not-so-lightweight bug fix.

- **Sidebar relabels** ([Sidebar.jsx](web/src/components/Sidebar.jsx)) —
  - Brand-side "Got ideas?" entry is now **"Idea dump"** (icon + route unchanged). Same rename in the IdeateView header (`<h1>Idea dump</h1>` in [IdeateView.jsx](web/src/components/IdeateView.jsx:202)) and the topbar crumb in [App.jsx:789](web/src/App.jsx:789). Agency-in-brand still says "Inbox" — different surface (queue + convert), different label.
  - Secondary "Team" entry: brand owners now see **"Team"**; agency-in-brand still sees **"Brand team"** (to disambiguate from the agency's own "L+R Team" entry that sits below it). One-line conditional: `label: isAgency ? "Brand team" : "Team"`.

- **Invite-redemption pre-flight email check** ([App.jsx](web/src/App.jsx) redemption useEffect) — fixes a silent-failure path where invitees who clicked an invite link while signed in as a different account got the membership row never created and no clear way to recover. Concrete repro that surfaced this: lakshithd98@gmail.com was invited as owner to the Linkrunner brand. He clicked the link, was redirected to the dashboard, but Linkrunner never appeared in his picker; the invitation row stayed `accepted_at IS NULL` and no `account_members` row was inserted.
  - **Old flow:** Effect read the token from localStorage, called `accept_invitation(token)`. If the SQL function threw the email-mismatch exception ("invitation is for X, but you are signed in as Y"), the catch handler nuked the token from localStorage and showed a transient banner. The user dismissed/missed the banner, and any retry was structurally impossible — token gone, no way to re-trigger except clicking the original email link again.
  - **New flow:** before calling `accept_invitation`, the Effect calls `previewInvitation(token)` (anon-safe RPC that returns `{email, role, accountName, accountType}`) and compares the invite email to `auth.email` case-insensitively. If they don't match: surface a sticky banner "This invite is for X. You're signed in as Y." with a **"Sign out & switch account"** button that calls `signOut()` + opens the LoginModal pre-pointed at the right email. **Crucially, the token stays in localStorage.** Once the user signs back in with the correct email, `auth.id` changes, the Effect re-fires, the email matches, and `accept_invitation` succeeds.
  - **Catch handler hardened too:** only clears the token when the error is a truly-dead invite (`/invalid or expired/i`-matching message). Any other error (transient network, an email-mismatch the pre-flight somehow missed) leaves the token alive so a reload or re-sign-in can recover.
  - **Banner UI** ([App.jsx](web/src/App.jsx)) — `inviteBanner` shape grew an optional `action: { label, onClick }` field; banner DOM renders an inline button when present.
  - **One-shot DB patch for the lakshithd98 / Linkrunner case:** since the original token is unrecoverable from his end (it was destroyed by the old catch handler before this fix landed), inserted the missing `account_members` row directly (account_id = `4f44d2fc-3243-4e05-b9a1-1277840f5f45`, user_id = `a9eee81a-37a2-49b2-b0d2-2907d40ff039`, role = owner) and stamped `invitations.accepted_at = now()` for invitation `c453be7b-c95a-49c2-9209-6b7c837ab28c`. Mirrors exactly what `accept_invitation` would have written had the redemption succeeded. Linkrunner now appears in his BrandPicker on next page load.

- **Sections touched:** Recent changes log; `Last updated`; Glossary (Got ideas? entry renamed to **Idea dump** with note about the rename); §8 Routes/Views (`ideate` row description updated); §9 Key feature flows (sidebar relabel note added to Brand-context flow); §13 Known decisions (invite redemption robustness — see new "Pre-flight email check vs. catch-and-clear" entry below).

### 2026-05-07 — Status colour: Needs review goes mustard yellow
The `needs_review` pill colour was previously `--status-review` (a blue, `#6579BE`) and clashed with the new violet `POSTED_TINT` (`#7C5CFF`) introduced in the `post_plan_publications` work — agency leads were misreading "posted" as "needs review" on dense calendars. Switched to a mustard yellow `#A16207` so the action-required signal stands apart from the shipped-and-done signal in the blue/purple family. Affects the legacy aliases `needs_brand_feedback` and `needs_admin_revision` too. No data change; visual only.

### 2026-05-07 — "Posted" terminal state + Live Posts repository (`post_plan_publications`)
Plans now have a "Posted" pill that lights up when they're approved AND have at least one publication row. Crucially, this is **not** a 4th status enum value — migration 0035 collapsed the workflow enum to 3 (drafting / needs_review / approved) on purpose, and re-adding `posted` would re-mix workflow with shipped-or-not. Instead a new `post_plan_publications` table records "this plan went live on this platform, here's the live URL" — one row per (plan, platform). The "Posted" display state is derived: `getDisplayStatus(plan, publications)` returns `'posted'` when the plan is approved and has at least one publication. Same `<StatusPill>` machinery; same calendar / list / detail surfaces.

- **Migration `0036_post_plan_publications`** — new table `post_plan_publications` (id, post_plan_id FK ON DELETE CASCADE, platform text CHECK in `'instagram'/'linkedin'/'x'`, live_url text nullable, published_at timestamptz default now, published_by FK profiles ON DELETE SET NULL, created_at, updated_at). Composite UNIQUE on (post_plan_id, platform) so re-marking a platform updates the existing row's URL via `ON CONFLICT DO UPDATE`. RLS mirrors `post_plan_attachments`: read by anyone with read access to the parent plan; insert requires `published_by = auth.uid()` and read access to the plan; update for plan-readers; delete by row-owner OR agency (cleanup latitude). `touch_updated_at` trigger; added to `supabase_realtime`.
- **`getDisplayStatus(plan, publications)`** ([postPlanShared.jsx](web/src/components/postPlanShared.jsx)) — single helper every status-rendering surface calls. Returns `'posted'` when the plan is approved (or legacy `scheduled`/`posted`) and has ≥1 publication row, else returns `plan.status`. Status enum on `post_plans` is unchanged.
- **`STATUS_CONFIG.posted`** — promoted from a legacy alias mapping to the Approved bucket into its own visual state with a violet tint (`#7C5CFF`). Reads as "shipped, complete" — distinct from approved-green so a calendar full of approved-but-not-yet-live plans visually separates from the actually-live ones. Legacy `scheduled` alias still maps to the Approved bucket.
- **`MarkAsPostedModal`** ([MarkAsPostedModal.jsx](web/src/components/MarkAsPostedModal.jsx)) — opens from `PostPlanDetailView` when status is approved. One row per platform on the plan, each with a checkbox ("posted on this platform?") + optional URL input. Pre-fills from existing publications so the same modal doubles as the edit surface. Submit fans out into per-platform `upsertPostPlanPublication` calls plus deletions for platforms unchecked-since-last-time. URL validation is light: must start with `https://` if non-empty so the brand can paste shortlinks (linkr.ee, bit.ly, branded short URLs).
- **`PostPlanDetailView` integration** — new "Mark as posted" / "Edit live posts" button in the page-head action group, available to **agency AND brand** when the plan is approved. New "Live posts" overview card lists each publication with platform chip, clickable URL, and publisher attribution. Activity feed gets a 5th source (post_plan_publications) — entries render as "Marked posted on Instagram — `<url>`". Timeline sidebar grows a 4th step ("Posted") that lights up off the earliest `published_at`.
- **Calendar Posted filter pill** ([CalendarView.jsx](web/src/components/CalendarView.jsx)) — `STATUS_GROUPS` adds a `posted` bucket. Filter logic switched from `p.status` to a derived `p.displayStatus`, computed once per render via `decoratedPostPlans`. The Approved bucket now excludes posted plans (`displayStatuses: ['approved', 'scheduled']`), so "Approved" becomes the actionable "approved-but-not-yet-live" pile. Bulk-fetched publications via new `loadPublicationsForPlanIds` and a project-wide realtime stream (`subscribeToAllPostPlanPublications`).
- **`/c/:slug/posts` Live posts view** ([LivePostsView.jsx](web/src/components/LivePostsView.jsx)) — new top-level brand-scoped route. Pulls from `loadBrandPublications(accountId)` (joined with `post_plans` for plan context). Tiles grouped by month, filter pills by platform, free-text search across concept / publisher / URL. Realtime: refetches on any publication event project-wide; cheap enough that we don't bother with merge bookkeeping. Sidebar entry "Live posts" with `link` icon sits below Library.
- **db.js helpers** ([web/src/lib/db.js](web/src/lib/db.js)) — `mapPostPlanPublicationRow`, `loadPostPlanPublications(planId)`, `loadPublicationsForPlanIds(ids)` (returns `Map<planId, publications[]>` for bulk surfaces), `loadBrandPublications(accountId)` (joined with plans for the repo view), `upsertPostPlanPublication({...})` (uses `ON CONFLICT (post_plan_id, platform) DO UPDATE`), `deletePostPlanPublication(id)`, `subscribeToPostPlanPublications(planId, cb)` (filtered by plan), `subscribeToAllPostPlanPublications(cb)` (project-wide stream for many-plan surfaces).
- **Sections touched:** Recent changes log; `Last updated`; Glossary (new entries: Publication, Posted as derived state, Live posts); §6 Data model (new table row + RLS notes); §6 Migrations list (0036 row); §8 Routes/Views (new `posts` row); §9 Key feature flows (Mark as posted flow); §13 Known decisions (publication-as-record vs 4th-enum-value); LocalStorage keys (none added — Live posts surface uses no persisted prefs).

### 2026-05-06 — Trends Radar IG: viral-audio leaderboard (hybrid pipeline)
The IG tab pivots from "list of competitor posts" to a viral-audio leaderboard ranked by global views/velocity (when available) and competitor adoption (always). Builds on Phase A brand-scoping below. The architecture went through several iterations before settling on the hybrid; the final shape is described here.

**What ships per Refresh** (one trend_signals row per unique audio, `kind='sound'`):

| Audio source | Signals on the card |
|---|---|
| Used by ≥1 competitor only | "{Artist} · Used by @h1, @h2 + N more". No views/velocity (intentional — better than a misleading scrape-sample count). |
| Featured by ≥1 aggregator only | "{Artist} · Featured by @creators · 1.2M views" + "+12K/day" velocity pill. |
| Both competitor AND aggregator | All of the above merged: "{Artist} · Used by @h1, @h2 · 1.2M views" + velocity pill + raw_payload contains aggregator handles for future use. |

Audios with audio-spy data (totalViews > 0) sort to the top by `viewsPerDay desc` (the actively-climbing signal). Audios with only competitor data sort below by competitor-count desc.

**Server side ([web/api/fetch-trends.ts](web/api/fetch-trends.ts)) — hybrid two-step pipeline in `handleInstagramAudios`:**
- **Step 1 — competitor reel scrape (~30s).** `apify/instagram-scraper` with brand's competitor handles (any count, no cap), `resultsLimit: 8` per handle. New helper `extractAudioFromPost` defensively parses three musicInfo shapes (`musicInfo`, `clipsMusicMetadata.music_info.music_asset_info`, `originalSoundInfo`) to recover `{audioId, songName, artistName}` from each reel. Reels are grouped by `audioId` into a shared `MergedAudio` map; the brand's competitor handle is added to `competitorsUsing: Set`.
- **Step 2 — aggregator views/velocity (~150-200s).** New helper `callApifyAudioSpy` calls `doodledaron/instagram-audio-spy` with the **3 aggregator handles only** (`creators`, `early.trending.audio`, `notsorrysocial` — `IG_AGGREGATOR_HANDLES` constant). Single chunk by design — actor caps at 5 usernames per call and adding more aggregators would push us into multi-chunk territory that we proved structurally won't fit. Returns `top_5_tracks` + `fastest_growing_by_competitor` with `totalViews`, `viewsPerDay`, `usedBy` per track. Each track gets merged into the same `MergedAudio` map by `audioId`: `totalViews` + `viewsPerDay` populated, aggregator handles added to `aggregatorsUsing: Set`.
- **Emit + sweep:** one `trend_signals` row per unique audio (`kind='sound'`, `platform='instagram'`, `region='global'`, `account_id=brand`). `sweepStaleTrends` scoped to `kind='sound'` so legacy `kind='post'` rows decay via the 14-day expiry instead of getting wiped.
- **The dispatcher** (`handleInstagram`) routes any `mode='competitors'` IG call to `handleInstagramAudios`. The legacy `handleInstagramRegion` (Top-in-region) and the original `handleInstagramCompetitors` (post-shaped output) are dead code retained for one cycle.

**Why hybrid (not pure audio-spy on everything):** Two structural constraints collide.
1. **Apify free-tier memory cap.** `audio-spy` internally launches `apify/instagram-reel-scraper` as a child run reserving 1024MB. Total concurrent Apify run memory on the free plan is 8GB. Two `audio-spy` parents in parallel both try to launch their children → second child fails with `"By launching this job you will exceed the memory limit of 8192MB"`. Sequential is safe but slow (~3 min per chunk).
2. **Vercel function timeout.** Pro plan caps `maxDuration` at 300s. 5-username `audio-spy` test ran in 317s alone (already over). Two sequential chunks at ~3 min each would burn 6+ min. Doesn't fit.

The hybrid sidesteps both: `instagram-scraper` doesn't have the audio-spy chunk cap and is fast; `audio-spy` runs only on the 3 fixed aggregator handles (single chunk, predictable runtime). Total ~210-240s, comfortably under 300s. Real virality numbers ship on the audios that matter most (aggregator-curated), and the brand-relevance signal (competitor adoption) covers the long tail.

**Client side ([web/src/components/TrendsView.jsx](web/src/components/TrendsView.jsx))** — `PLATFORM_KINDS.instagram = ['all', 'sound']` (was `['all', 'post']`). `DEFAULT_KIND_FOR_PLATFORM = { instagram: 'sound' }` lands the user on the audio leaderboard. `TrendCard` derives subtitle/metric from `rawPayload` (not the stored strings) so old DB rows render the new format without requiring a refresh. Three formatters mirror the server: `formatHandlesClient`, `formatTotalViewsClient`, `formatViewsPerDayClient`. Thumbnail rendering removed from the card — IG's CDN URLs on `displayUrl` are short-lived signed tokens that 403 in the browser; we'd need durable cover URLs from a different source. Missing-competitors banner pushes user into Brand Intelligence when the brand kit has no competitors.

**Vercel config ([web/vercel.json](web/vercel.json))** — `functions["api/fetch-trends.ts"].maxDuration: 300` (Pro plan max). Per-function so other routes keep their default. Set via vercel.json rather than `export const config` block to sidestep the documented "runtime literal silently breaks the build" trap.

**Cost** — ~$0.10-0.15 per refresh (instagram-scraper ~50 results × $2.30/1k ≈ $0.12 + audio-spy ~$0.005-0.02 PAY_PER_EVENT). $5 Apify budget = ~30-50 cold refreshes. No per-brand multiplier on the audio-spy cost since aggregators are fixed.

**Caveats / known limits:**
- **Concurrent refreshes break.** Two refreshes (different brands or different users) within the same ~3-4 min window will hit Apify's memory cap on the second one. Single-user / single-brand refreshes are fine. Paid Apify plan ($49/mo) eliminates this.
- **Adding aggregators past 5 won't fit.** Audio-spy's per-call cap is 5; current 3 leaves 2 of headroom. Adding 6+ aggregators requires a multi-chunk path that we proved doesn't fit Vercel's 300s with sequential calls.
- **Not every audio gets views/velocity.** Only audios that the 3 aggregators recently posted with surface in audio-spy's response. Competitor-only audios show "Used by @h" without the views chip — by design, since the alternative was a misleading scrape-sample count like "1 reel".
- **`audio-spy` is community-built**, not Apify-official. Response shape is observed-not-documented. If the actor goes down or changes shape, our parser breaks; we have a graceful-degradation path (skip the audio-spy step, ship competitor-only data).
- **`apify/instagram-scraper` does NOT support audio URLs as input** — verified by direct testing on 2026-05-06; returns `{error:"no_items"}` for `/reels/audio/{id}/` URLs. This eliminated an earlier "Phase C" plan to enrich audios via that actor.

**What's deferred:**
- **Aggregator admin UI** — `IG_AGGREGATOR_HANDLES` is still a hardcoded constant. Future: `trend_aggregator_accounts` table + agency-only settings page (with cap-of-5 enforcement).
- **Posts alongside sounds** — current refresh emits only `kind='sound'` rows. The competitor reel scrape from step 1 has per-reel data we could also emit as `kind='post'` rows at zero extra Apify cost.
- **Async polling architecture** — current 3-4 min wait per refresh is a UX wart. Proper fix: kick off Apify runs async, return immediately, poll for results. Defer until the manual-refresh UX becomes a real pain.
- **Audio licensing flag** — Meta's Sound Collection commercial-safe library isn't exposed via any API. UI should grow a "verify license before posting on a brand account" warning before opening this surface to non-agency users.

**Sections touched:** Recent changes log; §6 Data model (note: `trend_signals` IG rows now `kind='sound'`; raw_payload includes `audioId`, `totalViews`, `viewsPerDay`, `competitorHandles`, `aggregatorHandles`); §10 Edge functions / integrations (fetch-trends IG handler rewritten as hybrid); §13 Known decisions (new entry: hybrid pipeline rationale; new entry: `apify/instagram-scraper` doesn't accept audio URLs); §12 External accounts & secrets (Apify token rotation reminder).

### 2026-05-06 — Trends Radar brand-scoped (Phase A of viral-audio rework)
First slice of a multi-phase rework that converts the IG tab from "list of posts" into a velocity-tracked viral-audio leaderboard. Phase A is pure refactor — no scraper changes, no schema changes, just relocating the surface so subsequent phases can layer on cleanly.
- **Routing** — `'trends'` moves out of agency-only top-level into `BRAND_SCOPED_VIEWS` and `SIMPLE_VIEWS` in [App.jsx](web/src/App.jsx). Trends Radar now lives at `/c/:slug/trends`. The bare `/trends` path still parses (via `parsePathToRoute`) so old bookmarks redirect to the slugged variant via the redirect-to-slug effect, but it's no longer a valid all-clients destination. The snap-effect's `allClientsRoutes` set drops `'trends'`; `inBrandRoutes` adds it. Default landing for an all-clients agency on an invalid route flips from `/trends` → `/clients`.
- **Sidebar** — `buildAllClientsNav()` returns `{ primary: [], secondary: [] }` instead of a single Trends entry. The All-Clients sidebar is now empty by design (BrandPicker is the only meaningful affordance) — every workflow including Trends lives inside a brand. `buildBrandNav` already had Trends Radar for agency users so brand-scoped users see it where it belongs.
- **TrendsView** ([web/src/components/TrendsView.jsx](web/src/components/TrendsView.jsx)) — props change from `{ brandAccounts, defaultAccountId, … }` to `{ accountId, brandName, brandSlug, brandAccounts, … }`. Dropped the `igMode` state ("Top in region" / "Brand's competitors" toggle) and the brand `<select>` — IG is implicitly per-brand now via `PER_BRAND_PLATFORMS = new Set(['instagram'])`. Header subtitle gains `Viral signal for ${brandName}`. Region selector hides on the IG tab. The `refreshTrends` call for IG always passes `mode: 'competitors'` (kept as a backward-compat arg for the existing fetch-trends handler — Phase B/C will replace this whole call with the seed-pool + audio-velocity pipeline and `mode` can drop). The TurnIntoPostPlanModal still receives `brandAccounts` so the agency can re-target a plan to a sibling brand from the modal — only the Trends *view* itself is locked to one brand.
- **No data model changes yet.** Old IG `account_id IS NULL` regional rows in `trend_signals` simply stop appearing because the load query always passes `accountId` for IG. They'll age out of the table on the existing 14-day expiry. Phases B–E land the new tables (`trend_audio_seeds`, `trend_audio_snapshots`, `trend_aggregator_accounts`, `trend_seed_creators`) + the velocity-tracking pipeline.
- **Sections touched:** Recent changes log; §8 Routes/Views (`/trends` → `/c/:slug/trends`); §13 Known decisions (new entry: brand-scoping over agency-level for Trends Radar). Glossary unchanged in this slice.

### 2026-05-05 — Library: Deliverables / References toggle + clickable post-plan headings
The Library used to surface only deliverables (legacy task assets + post-plan finals). Now it's a per-brand asset repo with a toggle for the two relevant pools.

- **Toggle** (`Deliverables / References`) — segmented control in the filter bar. Active selection persisted to `localStorage.lr_library_kind`. Default = `Deliverables`.
- **References pool** — pulls `post_plan_attachments` where `kind = 'reference'` (brand-uploaded inspiration files on post plans). Same per-tile + per-section grouping as deliverables; no separate component.
- **Counts subhead** — `X deliverables · Y references` next to the page subhead. Both pools loaded eagerly on mount so the count stays accurate when the user flips the toggle.
- **Clickable post-plan section headings** — when a section's source is a post plan (vs. a legacy task), the section's `<h3>` becomes a button that navigates to the post plan detail view. Visual cue: small `↗` icon next to the title; hover shifts colour to the accent.
- **Loader generalised** — `loadLibraryPostPlanFinals` renamed to `loadLibraryPostPlanAttachments({ accountId, kind })` so the same query path serves both Deliverables (`kind: 'final'`) and References (`kind: 'reference'`).
- **Empty state copy** — kind-aware, so the message shifts between "as your agency delivers creatives…" (deliverables) and "as the brand drops reference files on post plans…" (references).
- **Out of scope (per design discussion):** brand kit assets as a third toggle, idea-attachment surfacing, asset deep-link URLs, CSV export, tags, folders, bulk download. Each is its own surface and was deliberately punted to keep this slice small.
- **Sections touched:** Recent changes log; §8 Routes/Views (Library description noted); §9 Key feature flows (Library scoping note updated); §13 Known decisions (new entry: Library = per-brand asset repo with kind toggle, not a free-form file lake); LocalStorage keys (new `lr_library_kind` row).

### 2026-05-05 — Calendar List view + retired density toggle
The `Comfortable / Compact` density toggle on month view was a half-measure — compact mode was visually almost identical to comfortable, and a real "see everything in chronological order" surface was missing. Replaced it with a third primary view mode: `Month / Week / List`.

- **New `ListView` ([CalendarView.jsx](web/src/components/CalendarView.jsx))** — full-width agenda, posts grouped by day with sticky day headers + week separators. Each row shows time, full platform icons (no abbreviations), full title (no truncation), status pill, comments count, references count (with hover thumbnail popover), lead avatar, and the existing unread red dot. Empty days are skipped entirely — no "Friday May 8 — no posts" rows.
- **Week separators** — small "Week of May 3 · 12 posts · 3 needing review" header above each week's days. First time the agency has a bird's-eye view of weekly volume + review backlog without flipping filters.
- **Sticky day headers** — `position: sticky` so the day label stays at the top of the viewport while scrolling through that day's posts.
- **"Now" line** — slim accent rule + `Now` label on today's day group, positioned between today's past posts and future posts. Lets the lead see at a glance what's behind/ahead of now without doing time math. Drawn at the very end if all of today's posts are past, at the start if all future.
- **Hover paperclip popover** — hovering the references count reveals up to 6 attachment thumbnails (images shown directly; non-image files render the paperclip-fallback tile). Quick reference preview without opening the plan.
- **Bulk-rollup loader (`loadPostPlanListRollups` in [db.js](web/src/lib/db.js))** — two parallel queries: total comments per visible plan + reference attachments per visible plan (capped at 6 per plan client-side). Re-runs whenever the visible plan set changes (month nav, filter narrow, etc.). One round-trip for the whole list view, not N.
- **Density toggle retired.** `Comfortable / Compact` segmented control gone; `LS_DENSITY` localStorage key no longer read or written (existing values sit harmlessly in users' browsers; they're ignored). The previous decision-log entry that justified the density toggle is superseded.
- **Month-scoped, not rolling-window.** List view shows posts in the current month (whatever the prev/next nav sets `viewDate` to), matching the Month view's mental model. A "next 30 days" rolling window was considered but rejected — the Month/Week/List toggle should anchor the same prev/next semantics across all three. Add a separate "Upcoming" surface later if rolling is wanted.
- **Polish skipped (per design discussion):** inline status flip on hover, click-platform-icon-to-filter. Both were on the table but scoped out.
- **Sections touched:** Recent changes log; §8 Routes/Views (List view noted under CalendarView); §9 Key feature flows (Calendar navigation block updated); §13 Known decisions (new entry: stacked-row list view over time-grid agenda; retire density-toggle decision); LocalStorage keys (`lr_calendar_density` deprecated row).

### 2026-05-05 — Post-plan status workflow collapsed to 3 values
The 8-value `post_plans.status` enum (`not_started`/`wip`/`needs_brand_feedback`/`needs_admin_revision`/`approved`/`scheduled`/`posted`/`delayed`) was more state machine than the agency-and-brand actually used. The new model is dead simple: **Drafting → Needs review → Approved**. Comments are how the brand says "needs changes" — there's no separate revision-request status flip; the row stays at `needs_review` until brand clicks Approve. Agency can flip Approved → Drafting as a manual reopen.

- **Migration `0035_post_plan_status_simplification`** — drops the 8-value CHECK constraint, remaps rows (`not_started`/`wip`/`delayed` → `drafting`; `needs_brand_feedback`/`needs_admin_revision` → `needs_review`; `approved`/`scheduled`/`posted` → `approved`), updates the column default to `drafting`, adds a tighter CHECK constraint with only the three new values, and trims the `touch_post_plan_status_stamps` trigger to drop the (now-impossible) `posted_at` branch. The `posted_at` column itself is left in place to preserve historical timestamps; nothing writes to it anymore.
- **`STATUS_CONFIG` ([postPlanShared.jsx](web/src/components/postPlanShared.jsx))** — three primary entries (Drafting / Needs review / Approved). Legacy enum keys are kept as fallback aliases that resolve to the equivalent new bucket, so any cached realtime payload or `post_plan_status_log` entry from before 0035 still renders with a sensible label and colour rather than the unknown-status fallback.
- **`STATUS_GROUPS` filter pills ([CalendarView.jsx](web/src/components/CalendarView.jsx))** — collapsed from `All / Drafting / Needs review / Approved / Posted` (5) to `All / Drafting / Needs review / Approved` (4). Each bucket's `statuses` array also includes the legacy enum values so a row that hasn't yet flowed through the migration still flows into the right bucket.
- **PostPlanDetailView workflow buttons** — replaced the matrix of `Submit for review` / `Approve` / `Request changes` / `Mark posted` / `Mark delayed` / `Set: <any of 8>` with the new minimal set:
  - **Drafting** state: agency sees `Submit for review` → `needs_review`
  - **Needs review** state: brand sees `Approve` → `approved`; agency sees no button (waits for brand; if comments come in, agency addresses them and the row stays at Needs review)
  - **Approved** state: agency sees `Back to draft` → `drafting`
  - The override `<select>` (admin-only) shrinks from 8 options to 3.
- **Activity feed** — `STATUS_VERB` map keeps the legacy keys for rendering historical `post_plan_status_log` rows in past tense ("requested changes", "marked as posted") but new transitions only emit the three new keys. Per the design discussion, **historical log rows are not rewritten** — they're an audit trail of what actually happened.
- **Default status on insert** — every place that creates a new `post_plans` row (`createPostPlan`, `duplicatePostPlan`, `convertIdeaToPostPlan`, `createStubAndOpen` in CalendarView, `TurnIntoPostPlanModal`) now writes `'drafting'` instead of `'not_started'`. With the tightened CHECK constraint, anything else would error.
- **Sections touched:** Recent changes log; §6 Data model (post_plans.status enum updated); §6 Migrations list (0035 row); §9 Key feature flows (Post-plan workflow rewritten); §13 Known decisions (new entry: workflow simplification rationale + comments-not-statuses).

### 2026-05-05 — Calendar: Week view (Trello-stack) + status-group filter pills + density toggle
The month grid was getting unreadable when posts targeted all three platforms — three platform icons + concept text + status tint per chip eat the cell on a busy day. Three additions tackle this from different angles:

- **Week view** ([CalendarView.jsx](web/src/components/CalendarView.jsx) — new `WeekGrid` + `WeekPostCard`). Trello-style 7 stacked columns (Sun → Sat), not a Google-Cal time grid. Each card shows time, full multi-line title, platform icons, status pill, unread dot. **Why stacked-column over time-grid:** for a content calendar the *day* matters far more than the *time*; a 5am→10pm time grid would leave 80% of the canvas empty since most posts cluster around morning. Stacked columns give every plan room to breathe.
- **Status-group filter pills** — replaced the per-status `<select>` (which was 8 enum-value options nobody thinks in) with five workflow buckets: `All`, `Drafting` (`not_started`/`wip`/`delayed`), `Needs review` (`needs_brand_feedback`/`needs_admin_revision`), `Approved` (`approved`/`scheduled`), `Posted`. Each pill carries a count badge so the lead sees "5 things needing my eyes" at a glance without flipping filters.
- **Density toggle (Comfortable / Compact)** — month view only. Comfortable = legacy chip with platform icons. Compact = thin one-line bar with status-coloured left border, no platform icons, raises per-cell cap from 3 → 6 chips. Kills the cluttered-cell problem without forcing a view switch.
- **Persistence** — view mode, density, and active filter all written to `localStorage` (`lr_calendar_view_mode` / `lr_calendar_density` / `lr_calendar_status_filter`) so an agency lead who lives in week+compact doesn't reset on every reload.
- **Navigation** — prev/next moves by 1 week in week view, 1 month in month view. Today snaps to the current week or month respectively. The view-mode toggle preserves the current `viewDate`, so flipping Month → Week shows the week containing the month's anchor day; flipping Week → Month shows the month containing the visible week.
- **Punted to follow-ups** (per design discussion): drag-to-reschedule, hover preview popover, time-grid week, swimlane grouping. Each is its own design surface.
- **Sections touched:** Recent changes log; §8 Routes/Views (CalendarView's view modes noted); §9 Key feature flows (Calendar navigation + filters block updated); §13 Known decisions (new entry: stacked-column over time-grid for content calendars; new entry: filter pills over per-status select); LocalStorage keys (three new entries).

### 2026-05-05 — "Got ideas?" (brand) + "Inbox" (agency) on a new `post_plan_ideas` table; tasks UI fully sunset
The product moves entirely off the briefs/tasks flow and onto post plans. Brand-side "Request" → "Got ideas?" composer that drops rows into a brand-new `post_plan_ideas` table; agency-side "Inbox" moves out of All-clients (where it was a queue of tasks) and becomes a per-brand surface listing those submitted ideas. Each idea opens to an editable detail panel with an **Add to Social Calendar** CTA that creates a real `post_plans` row and back-links the idea via `converted_post_plan_id`.

- **Migration `0034_post_plan_ideas`** — new tables `post_plan_ideas` (id, account_id, title, details, desired_date, platforms text[], status enum [`submitted`/`converted`/`archived`], submitted_by, converted_post_plan_id FK post_plans, converted_at, created_at, updated_at) and `post_plan_idea_attachments` (id, idea_id, storage_path, filename, mime_type, size_bytes, uploaded_by, created_at). RLS mirrors `post_plans`: agency staff or members of the account. `touch_updated_at` trigger; both tables added to `supabase_realtime`. Idea attachments reuse the existing `post-plan-attachments` storage bucket — path scheme is `<accountId>/ideas/<ideaId>/<ts>_<filename>`, which the bucket's storage RLS extracts via `split_part(name, '/', 1)` (set up in 0022) so no policy changes are needed.
- **`IdeateView.jsx`** (brand) — composer for title + details (paste URLs, they auto-link in the preview/inbox renderer), optional `desired_date`, multi-select platforms (IG/LinkedIn/X), paperclip uploader for reference files. Submit creates the idea row, then uploads any pending files against it. Below the composer: list of the brand's recent ideas with status pill (Submitted / On the calendar / Archived) and the brand can delete any of their own that haven't been touched.
- **`IdeateInboxView.jsx`** (agency-in-brand) — split view: status-filterable list on the left (`Queue` / `On calendar` / `Archived`; default `Queue` = `status='submitted'`), editable detail panel on the right. Detail panel shows submitter, edits to title/details/date/platforms (auto-linked preview rendered below details), reference file thumbnails (with delete), and the "Add to Social Calendar" CTA. Save changes pushes a partial UPDATE through `updatePostPlanIdea`. Archive flips to `archived` (recoverable from the Archived filter).
- **`ConvertIdeaModal.jsx`** — date + platforms + concept + copy seed pre-filled from the idea. Submit calls `convertIdeaToPostPlan` which (1) creates a `post_plans` row at 09:00 local on the chosen date, (2) updates the idea: `status='converted'`, `converted_post_plan_id=<new plan id>`, `converted_at=now()`. Parent navigates to the new plan's detail view. Once converted, the idea drops out of the default queue (default filter excludes converted/archived rows), so "remove from inbox by adding to calendar" works automatically with no extra delete step.
- **`db.js`** — additive only: `loadPostPlanIdeas({accountId, statuses?})`, `loadPostPlanIdeaById`, `createPostPlanIdea`, `updatePostPlanIdea`, `deletePostPlanIdea`, `loadPostPlanIdeaAttachments`, `addPostPlanIdeaAttachment`, `deletePostPlanIdeaAttachment`, `convertIdeaToPostPlan`, `subscribeToPostPlanIdeas`. Re-exports the linkifier `linkifyText` from `IdeateView.jsx` (used by the agency detail-panel preview as well).
- **Sidebar restructure (`Sidebar.jsx`)** — `buildBrandNav`: brand owners see **Got ideas?** (icon `send`, no badge), agency-in-brand see **Inbox** (icon `home`, badge = count of `submitted` ideas). The agency-only `Tasks` entry is gone in both modes. `buildAllClientsNav`: drops `Inbox` and `All tasks` — only **Trends Radar** is left in the cross-client nav. `GUEST_NAV`: drops the old "Request" entry; guests now see only Social Calendar.
- **App.jsx routing** — new `ideate` route at `/ideate` and `/c/:slug/ideate` (added to `BRAND_SCOPED_VIEWS` so it gets the slug prefix), removed `tasks` and `home` from `parsePathToRoute` / `viewToPath` / `SIMPLE_VIEWS`. The agency context-snap legal sets are now: All-clients = `['profile', 'settings', 'clients', 'members', 'trends', 'not_found']`; in-brand = adds `calendar`, `plan`, `ideate`, `brand`, `library`, `performance`, `team`. All-clients defaults to `/trends` instead of `/home`. Idea-queue badge wiring: App.jsx loads `loadPostPlanIdeas({accountId, statuses: ['submitted']})` for the active brand and subscribes via `subscribeToPostPlanIdeas` so the badge re-ticks on insert/update. The topbar "New brief" CTA was retired in favour of a brand-side "Submit idea" CTA that jumps to `/c/:slug/ideate`.
- **Tasks UI fully sunset.** Sidebar entries gone, route rendering gone, AdminHome/HomeView/TasksView/TaskDetailView no longer imported. Files (`HomeView.jsx`, `TasksView.jsx`, `TaskDetailView.jsx`, `admin.jsx`'s `AdminHome` + `AdminUploadView`) and the underlying `tasks` / `assets` / `messages` / `activity` tables are intentionally **left in place** for one PR cycle — strictly destructive cleanup (file delete + table drop migration) is a follow-up so we have a clean rollback path if anything depending on them surfaces.
- **Status enum is intentionally minimal.** `submitted` / `converted` / `archived` only. No `in_review` — premature; opening an idea doesn't auto-flip its status. The badge counts `submitted` only, so converting OR archiving an idea drops it off the Inbox queue with a single status flip.
- **Sections touched:** Recent changes log; Glossary (new entries: Idea, Got ideas?, Inbox 2.0, Convert to post plan); §6 Data model (two new tables + RLS + storage path notes); §6 Migrations list (0034 row); §8 Routes/Views (new `ideate` row, `tasks`/`home` removed, agency All-clients default updated); §9 Key feature flows (Submit idea + Convert idea); §13 Known decisions (separate table vs status on post_plans, status enum minimalism, tasks-UI sunset rationale); §14 Pending work (delete tasks files + drop tasks tables; idea-submitted email notifications via Resend Tier 2).

### 2026-05-02 — Trends Radar Phases 2 + 3 + 5 (Twitter, Instagram per-brand, Turn-into-post-plan)
Three more phases on top of the Phase 0+1 foundation. Same `trend_signals` table, same `/api/fetch-trends` Vercel route, same `TrendsView` shell — each phase drops in as additive code without restructuring anything that already shipped.

**Phase 2 — X / Twitter via Apify**
- New `handleTwitter` in [`/api/fetch-trends`](web/api/fetch-trends.ts). Calls Apify's `automation-lab/twitter-trends-scraper` actor via `run-sync-get-dataset-items` (one POST → all regions back). Default regions: US, IN, GB, CA, AU; we translate ISO-3166 alpha-2 to Apify's location codes at the API boundary (only `GB → UK` differs in practice).
- Items starting with `#` land as `kind: 'hashtag'` (title stripped + lowercased to match TikTok normalisation); everything else is `kind: 'topic'`. `trend_window` is `'now'` since X trends are real-time.
- `tweet_volume` (or any of the alternate spellings the various scrapers use — `tweetVolume`, `volume`) becomes `metric_value` with label `tweets`.
- Subtitle is the volume rendered as e.g. `1,234 tweets`. Defensive parser tolerates several known shapes; raw response stashed in `raw_payload` so we can re-derive fields without re-scraping if the actor's output changes.
- Requires `APIFY_API_TOKEN` env var on the `lr-studio-dashboard-3kkp` Vercel project (server-side, no `VITE_` prefix).
- UI: TrendsView's `PLATFORMS[]` flips Twitter from `available: false` to `available: true`. New `PLATFORM_KINDS` map drives the kind filter pills per platform — Twitter shows `All / Hashtags / Topics`, TikTok still shows `All / Hashtags / Sounds`. Switching platforms resets the active kind to `all` so the user doesn't land on an empty grid because the filter doesn't apply to the new source.

**Phase 3 — Instagram per-brand via Apify**
- New migration `0030_brand_trend_hashtags` adds `brand_kits.trend_hashtags text[] not null default '{}'`. Each brand declares 3-10 hashtags relevant to its category (e.g. for a coffee brand: `["specialtycoffee","coffeeshop","latteart"]`). RLS on `brand_kits` already covers reads + writes for this column — no policy changes.
- New `handleInstagram` in `/api/fetch-trends`. Required `accountId` in the request body. Reads the brand's `trend_hashtags` via the service-role client, calls Apify's `apify/instagram-hashtag-scraper` with the array, parses each post into a `trend_signals` row tagged with the same `account_id` — the unique dedupe index `(platform, kind, region, title, trend_window, account_id)` means a global TikTok `#foo` row and a brand-scoped IG `#foo` row peacefully coexist.
- Each post's title = caption snippet (first 140 chars), subtitle = `@username · #hashtag · 1,234 likes`, metric_value = likesCount or videoViewCount, region = `'global'` (IG posts aren't region-scoped per row).
- New `TrendHashtagsCard` in [BrandKitView](web/src/components/BrandKitView.jsx) — a small card after the Voice & messaging section. Chips for current hashtags + an InlineList editor for adding/removing. Save normalises (strip `#`, lowercase, dedupe, drop invalid chars, cap at 10).
- TrendsView IG tab: when active, the filter row swaps the Region <select> for a Brand <select>. `loadTrendSignals` and `refreshTrends` both gain an `accountId` param. Global sources explicitly pass `account_id IS NULL` so an "All-clients" view never bleeds brand-scoped IG rows next to Twitter trends.
- New EmptyState variants: TikTok / X / IG each get their own headline + body copy. Specific "Pick a brand to see Instagram trends" state for the per-brand-no-brand-picked case.

**Phase 5 — Turn this trend into a post plan (the agentic loop)**
- New [TurnIntoPostPlanModal](web/src/components/TurnIntoPostPlanModal.jsx). Each trend card grows a `+ Post plan` action pill (always visible on touch, hover-revealed on desktop). Click → modal pre-fills brand selector, schedule date, platforms, and concept; user adjusts the four things they actually need to choose; submit creates a `post_plans` row and lands them in the new plan's detail view.
- Defaults: brand = agency's currently-active brand if any (else first in `brandAccounts`); schedule = today + 3 days at 09:00 local (matches `duplicatePostPlan` convention); platforms inferred from the trend source (TikTok → IG since trends bleed to Reels; X → X; etc.); concept = `Use #<hashtag>` or `Use <topic>`.
- `copy_variants` is seeded per platform with the trend display name + source URL — gives the lead something concrete to anchor copy on instead of an empty textarea.
- Post-create navigation: TrendsView calls a new `navigateToPlan(planId, brandSlug)` prop from App.jsx that builds `/c/:slug/calendar/:id` with the **plan's actual brand slug** rather than `setRoute`'s `currentBrandSlug` (TrendsView is agency-level so the URL has no implicit brand context at click time).
- This is the moneymaker: spot trend → 2 clicks → live in the brand's calendar with concept + source + suggested platforms pre-filled. Compounds across every brand the agency runs.

**Sections touched:** Recent changes log; Glossary (Phase 5 entries — see Trend Radar / Post plan glue); §6 Data model (new `brand_kits.trend_hashtags` column note); §6 Migrations (0030 row); §10 Edge functions / integrations (handleTwitter + handleInstagram described in the existing fetch-trends section).

### 2026-05-02 — Trends Radar Phase 0+1 (trend_signals + Vercel /api/fetch-trends + TikTok scraper)
First slice of the Trends Radar feature. Compartmentalized so it can evolve in isolation from the rest of the dashboard — every new identifier is prefixed (`trend_signals`, `fetch-trends`, `TrendsView`, `.trends-*` CSS) and nothing existing was renamed or restructured.
- **Migration `0029_trend_signals`** — new platform-agnostic `trend_signals` table holding one row per trending hashtag/sound/topic/post/creator across (platform, kind, region, title, trend_window, account_id). RLS: agency-only read at v1; per-account read forward-compatible for Phase 3 (Instagram per-brand). Service-role only writes. Includes `prune_expired_trend_signals()` cleanup helper for the future cron. Unique dedupe index on the natural key so re-fetches upsert instead of stacking duplicates. **Applied to prod 2026-05-02** (we initially numbered this 0028 and applied it before main's `0028_remove_team_member_owner_can_remove` landed; on merge we renumbered the file to 0029 to avoid a numeric collision. The DB itself doesn't track migrations by number — both schema changes coexist cleanly on prod regardless of file naming).
- **Vercel serverless API `web/api/fetch-trends.ts`** — Node 20 runtime, dispatches by `source` in the body. Phase 1 ships `source: 'tiktok'` only; future sources (twitter via Apify, instagram via Apify/EnsembleData) land as sibling handlers without touching the dispatch shell. Authz double-gated: caller's JWT verified server-side via `supabase.auth.getUser()` AND `profiles.is_agency = true` checked via service-role client. Uses Firecrawl's `/v2/scrape` with the JSON extract format to pull trending hashtags + sounds from TikTok Creative Center (`https://ads.tiktok.com/business/creativecenter/inspiration/popular/{hashtag,music}/pc/en?countryCode=XX&period=7|30`). Default regions: US, IN, GB, CA, AU. `proxy: "auto"` mirrors enrich-brand-kit's pattern for soft-bot-wall handling. **No `export const config` block** — the initial `runtime: "nodejs20.x"` literal silently failed Vercel's bundler, default Node runtime is what we want.
  - **Why Vercel and not a Supabase Edge Function:** we initially built this as a Supabase Edge Function (matching `send-email` and `enrich-brand-kit`). The multipart deploy endpoint started returning 403 for our PAT (despite Owner role + MFA + freshly-minted full-scope tokens), and the legacy JSON deploy endpoint produces functions without compiled eszip artifacts (immediate BOOT_ERROR on invoke). After several iterations of trying to unblock the deploy mechanism, we pivoted: this kind of feature (third-party-API call + scheduled scrape, no per-user RLS coupling) is a more natural fit for Vercel anyway, and co-deploys with the SPA on every push to main. **Only this surface uses the Vercel route**; user-data CRUD continues to flow through Supabase clients with RLS.
- **TrendsView** (`web/src/components/TrendsView.jsx`) — agency-only sidebar entry "Trends Radar" (icon: sparkles), reachable at `/trends`. Both `buildBrandNav` (when an agency user is in a brand) and `buildAllClientsNav` (All-clients mode) include it in the secondary block — the surface is agency-level, not brand-scoped, so context-switching the BrandPicker leaves you on it. Tabs for TikTok / Twitter / Instagram / LinkedIn (only TikTok is `available: true` in v1; the rest show a `soon` chip). Region selector + kind filter (All / Hashtags / Sounds). Trend cards link out to the source URL, show rank, title, subtitle, and a formatted metric (M/K abbreviated). Empty state has a "Fetch trends now" CTA. Manual refresh button in the header for re-fetching.
- **db.js wrappers** (additive only) — `loadTrendSignals({platform, region, kind, limit})` reads via the agency-only RLS. `refreshTrends({source, regions, window})` POSTs to `/api/fetch-trends` with `Authorization: Bearer <user JWT>` (pulled from `supabase.auth.getSession()`).
- **Routing** — `/trends` added to `parsePathToRoute` (non-brand-scoped, sits at the root like `/clients` and `/members`). The agency context-snap effect's `allClientsRoutes` and `inBrandRoutes` sets both gain `'trends'` so picker switches don't bounce the user away. `web/vercel.json` keeps the standard SPA fallback `/(.*)` → `/index.html` — Vercel processes `/api/*` against serverless functions in `web/api/` *before* any rewrite, so the rewrite doesn't need to exclude `/api/`. (We initially tried a defensive `/((?!api/).*)` lookahead which broke ALL SPA routes — Vercel's path-to-regexp parser handles negative lookaheads inconsistently in `source` patterns. The takeaway: rely on Vercel's filesystem handler ordering, don't try to outsmart the rewrite engine.)
- **Vercel env vars** (set in Project Settings → Environment Variables on the `lr-studio-dashboard-3kkp` project, all 3 environment toggles ticked):
  - `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` — already present, used by the SPA bundle (Vite reads these at build time and bakes them into the bundle).
  - `FIRECRAWL_API_KEY` — same `fc-...` key already in use by `enrich-brand-kit` (server-side only, must NOT have a `VITE_` prefix).
  - `SUPABASE_URL` — same value as `VITE_SUPABASE_URL` but exposed to the API route at runtime (Vercel only injects non-`VITE_` vars into Node serverless functions).
  - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase Project Settings → API → "service_role" key (server-side only, never `VITE_` prefixed).
  - `SUPABASE_ANON_KEY` — same publishable key the SPA uses, for the API route's user-JWT verification step.
- **No existing schema/UI touched.** Goal was a checkpoint with zero blast radius — adding Trends Radar can't break Calendar, Tasks, Library, Brand Intelligence, etc., because nothing in those flows references the new table, route, or view.
- **Sections touched:** Recent changes log; Glossary (new entries); §6 Data model (new table + new RPC `prune_expired_trend_signals`); §6 Migrations (0029 row); §10 Edge functions / integrations (new Vercel route entry replacing the Supabase Edge Function plan); §13 Known decisions.

### 2026-05-02 — Invitee signup skips Supabase email confirmation (new `signup-for-invite` edge function)
- **Bug:** when an invitee clicked "Accept invite" in the email and signed up via the signup form (email + password), Supabase's standard `auth.signUp()` queued a confirmation email and the modal showed "Check your email to confirm your account, then sign in to accept the invite." That confirmation email was a redundant friction step — receiving the original invite at that address is already proof of email ownership — and on top of that the project's confirmation email wasn't reaching inboxes reliably, so the user was stuck.
- **Fix:** new edge function `signup-for-invite` ([signup-for-invite/index.ts](supabase/functions/signup-for-invite/index.ts)) — anon-callable (verify_jwt = false) since the invitee has no session yet. The invitation token IS the credential. The function reads the invitation server-side, validates it (unaccepted, unexpired), then calls `supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata })` to create the user with email already confirmed.
- `signUpForInvite()` in [auth.js](web/src/lib/auth.js) now invokes the edge function instead of `auth.signUp()`, then calls `signInWithPassword()` to establish the session. App.jsx's existing pending-invite useEffect redeems the token via `accept_invitation(p_token)` and lands the user in the workspace. The "Check your email" branch is removed from the LoginModal invitee flow — it's no longer reachable.
- **`user_exists` error code:** if the invitee tries to sign up with an email that already has an account, the edge function returns `{error, code: "user_exists"}` (HTTP 409). LoginModal catches that and pivots to sign-in mode with the message "You already have an account with this email. Sign in below to accept the invite."
- The email is sourced from the **invitation row**, never from the request body — so even if the client somehow sent a different email, the auth user can only be created under the address the invite was sent to. Substitution attacks aren't possible.
- **Brand-owner self-signup is unchanged.** That flow still goes through `signUpBrand()` → `auth.signUp()` and still asks for email confirmation. We only bypass confirmation when there's a valid invite token, since the invite is what proves email ownership in that case.
- Sections touched: Recent changes log; §10 Edge functions (new function table row); §13 new decision-log entry.

### 2026-05-02 — `remove_team_member` allows account owners (was agency-only)
- **Bug:** since the original `remove_team_member` in 0002, the gate has been `if not public.is_agency_user() then raise ...` — meaning ONLY agency staff could remove anyone from any team. A brand owner trying to remove a teammate from *their own brand* hit "only agency staff can remove team members" — even though the UI enabled the Remove button for owners. The 0026 patch fixed `is_agency` reset but didn't touch the gating.
- **Fix (migration 0028):** the rule now mirrors `change_member_role` — caller must be an `owner` of the account they're modifying. Naturally enforces all the rules without enumerating roles:
  - Brand owners can remove members + owners of their brand
  - Agency owners can remove members + owners of the agency
  - Members of either side can't remove anyone (not owners)
  - Brand owners can't touch the agency team (they're not owners there)
  - Agency owners can't touch a brand team (they're not owners there) — agency operates on brands via the brand owner, not directly
- The agency-flag-reset logic from 0026 stays intact (last agency removal still flips `profiles.is_agency = false`).
- Verified with 7/7 dynamic tests (real fixtures, transaction-rolled-back) covering each rule.
- Sections touched: Recent changes log; §6 Migrations list (new entry); §13 new decision-log entry.

### 2026-05-02 — agency-update fan-out fixes: Resend batch + brand-side URL routing
Two bugs surfaced when an agency staff member tested the Send-update flow on a brand with multiple members:
1. **Not all members received the email.** The previous implementation sent N emails sequentially via Resend's single-send endpoint (`POST /emails`), one per recipient. Resend's free tier rate-limits at ~2 requests/second; sends 3+ silently dropped. Fix: switched [`handleAgencyUpdate`](supabase/functions/send-email/index.ts) to Resend's `POST /emails/batch` endpoint — N envelopes in one API call, no rate-limit risk, same per-recipient privacy (each `to: [singleEmail]`). Function now also returns `total` (recipients identified) alongside `sent` so partial failures are visible. [UpdateBrandModal](web/src/components/UpdateBrandModal.jsx) now shows "Sent to X of Y member(s)" so a discrepancy is obvious.
2. **"Open Social Calendar" button in the email opened the wrong brand.** The URL `${APP_URL}/c/${slug}/calendar` was correct, but only agency users had a URL→active-brand sync useEffect in App.jsx. Brand users with multiple memberships always landed on whichever brand `localStorage.lr_active_brand_<userId>` remembered, regardless of the URL slug. Fix: added a parallel useEffect for non-agency users that calls `setActiveBrand(match.account.id)` when the URL slug matches one of their memberships and isn't already the active one. The agency effect was unchanged.
- Sections touched: Recent changes log; §10 Edge functions (Resend batch endpoint note); §13 new decision-log entries.

### 2026-05-02 — Agency "Send update" batch email + Duplicate post plan gated to agency-only
- New `agency-update` template on the `send-email` edge function. Agency staff click "Send update" in the calendar header → modal pops with subject + message → one email per brand member fans out via Resend (one Resend call per recipient so members don't see each other's addresses). Authz: caller must have `profiles.is_agency = true`. Recipients sourced from the existing `account_members_with_email` RPC.
- Edge function refactored from inline `team-invite`-only handler into a small dispatcher (`handleTeamInvite` / `handleAgencyUpdate`) so future templates land as siblings instead of branching the main handler.
- New component [UpdateBrandModal](web/src/components/UpdateBrandModal.jsx) — same modal shell as DuplicateDatePicker. Includes optional subject override, character counter, sending state, sent-confirmation screen with per-failure breakdown.
- New button next to "New post plan" in agency header of [CalendarView](web/src/components/CalendarView.jsx) — only visible when `isAdmin && accountId` (i.e., agency staff in a specific brand, not All-clients). New `accountName` prop plumbed through from App.jsx via `calendarAccountName`.
- **Duplicate post plan now agency-only.** Brand users could see and click both the right-click context-menu "Duplicate" on calendar chips and the "Duplicate" action button in the post-plan detail view, even though they don't have edit/create access — the operation would silently fail at RLS. Both surfaces are now gated:
  - [CalendarView.jsx](web/src/components/CalendarView.jsx) — `handleChipContextMenu` early-returns on non-admin, so right-click falls through to the browser default.
  - [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) — the Duplicate button is wrapped in `{isAdmin && ...}`, matching the status-control gating right next to it.
- **Local-secrets file pattern.** Added `.claude/local-secrets.env` template (gitignored). Only the Supabase Personal Access Token lives there; service-role / Firecrawl / Resend keys stay in Supabase Edge Function secrets and rotate via `supabase secrets set` without ever hitting disk in this repo.
- Sections touched: Recent changes log; §10 Edge functions (send-email template table + new agency-update row + decoupled handlers note); §12 Secret storage locations (new local-secrets.env entry); §13 new decision-log entries; §14 Pending work (Duplicate brand-side leak removed).

### 2026-05-02 — Member email surfaced in team views (new SECURITY DEFINER RPC)
- TeamView (brand) and AdminTeamView (agency) needed to show each member's email next to their display name so duplicate names are disambiguatable. The `email` field was already rendered in both views (`{m.person.email || m.person.role}`) — what was missing was the data path: `loadTeamForAccount` joined `account_members → profiles`, and `profiles` doesn't carry email (verified — columns are `id, display_name, initials, avatar_url, avatar_color, is_agency, created_at`). REFERENCE.md previously claimed `profiles.email` exists; corrected today.
- New migration `0027_account_members_with_email`: RPC `account_members_with_email(p_account_id uuid)` returns the member rows + email joined from `auth.users`. SECURITY DEFINER with explicit authz (caller is a member of the account OR is agency staff via `is_agency_user()`). Anon-key SPA client can't read `auth.users` directly; this is the canonical pattern for surfacing it.
- `loadTeamForAccount` in [db.js](web/src/lib/db.js) now calls the RPC instead of the direct `account_members` query. Same return shape — no UI changes needed; the existing `email || role` fallback in TeamView and AdminTeamView starts populating with real emails immediately.
- Sections touched: §6 RPCs list (new entry; profiles columns corrected), §13 new decision-log entry, Recent changes log.

### 2026-05-02 — Email-match auto-accept removed (invites require explicit redemption)
- The `auto_accept_pending_invitations()` RPC (migration 0010) was being called on every session refresh from [auth.js:162](web/src/lib/auth.js:162). It silently joined any signed-in user to every pending invite whose `email` field matched their auth email — so invitees never had to click the link in the email, *and* an existing-account user invited via that account's email would be silently granted access on their next sign-in.
- Three problems with that: (1) **silent grant for existing users** — invite an existing brand owner to the agency and they got agency access on their next normal sign-in with no acknowledgment; (2) **mistyped invite emails became dangerous** — typo `someone@gmail.con`, the wrong existing account silently inherits access; (3) **the email's "Accept invite" CTA was theater** — clicking it changed nothing.
- Fix: stop calling the RPC. The token-based redemption flow ([App.jsx:377](web/src/App.jsx:377) → `accept_invitation(token)`) is now the only redemption path. The SQL function is left in place defensively (in case any cached client still calls it; safe to drop in a follow-up migration once that risk is past).
- Also stripped: the dead `newlyJoinedAccountIds` welcome-banner useEffect in App.jsx that was reachable only via auto-accept; the unused `autoAcceptPendingInvitations()` export in db.js. The token redemption already shows its own "Invite accepted — welcome to the workspace." banner, so UX is unchanged for the canonical flow.
- Sections touched: §6 RPCs list (auto-accept marked deprecated), §7 Sign-in paths (auto-accept line removed), §13 new decision-log entry, Recent changes log.

### 2026-05-01 — Invitation redemption fixes (accept idempotency + is_agency reset)
Two pre-existing bugs surfaced during Tier 1 invitation testing. Both ship as migrations applied to prod via the Management API SQL endpoint.
- **Migration 0025 — `accept_invitation` is now idempotent.** Bug: when a user clicks an email invite link, signs in, and the session refresh fires, `auto_accept_pending_invitations()` (added in 0010) bulk-redeems the invite by email match BEFORE the URL-token redemption code in [App.jsx:377](web/src/App.jsx:377) gets to call `accept_invitation(token)`. The original RPC matched only `accepted_at is null`, so it raised "invitation invalid or expired" even though redemption had succeeded — the user was added to the workspace but saw "Couldn't accept invite" in the banner. Fix: look up the invitation regardless of accepted state. If already accepted AND the caller is a member of the target account, return success.
- **Migration 0026 — `remove_team_member` now resets `profiles.is_agency`.** Bug: `accept_invitation` sets `is_agency = true` when joining an agency account, but `remove_team_member` only deleted the membership row — `is_agency` stayed true. A user removed from the agency would keep landing in agency mode on future sessions even after joining a brand. Fix: when `remove_team_member` deletes an agency membership AND no other agency memberships remain, flip `is_agency = false`. Migration also includes a one-shot backfill for any rows currently in the broken state (verified: 0 stale rows remain after backfill).
- Sections touched: §6 Data model (RPCs — both updated); §13 Known decisions & gotchas (two new entries); Recent changes log.

### 2026-05-01 — Resend Tier 1 (invitation emails replace copy-link)
- New edge function [`send-email`](supabase/functions/send-email/index.ts) — Resend wrapper, dispatches by `template`. Currently supports the `team-invite` template only; future tiers (post-plan status, comments, etc.) will land additional `template` cases on the same function. Same auth model as `enrich-brand-kit`: caller's JWT is verified by the platform; we use a JWT-scoped client to read the target invitation through RLS (so the caller can only mail invites they have access to), then call Resend server-side with `RESEND_API_KEY`.
- Client wrapper `sendInviteEmail(invitationId)` in [db.js](web/src/lib/db.js) fires `supabase.functions.invoke('send-email', {body: {template: 'team-invite', invitationId}})`.
- [TeamView.jsx](web/src/components/TeamView.jsx) and [admin.jsx](web/src/components/admin.jsx) call `sendInviteEmail` immediately after `createInvitation` succeeds (and after `resendInvitation` in TeamView for the resend flow). **Email failure does not fail the invite** — the invitation row already exists and the Copy-link affordance below the form keeps working as a manual fallback. The flash message switches between "Sent an invite to X" and "Invite created for X, but the email didn't send. Copy the link below…" based on Resend's response.
- New secrets: `RESEND_API_KEY`, `EMAIL_FROM` (`agency@linkrunner.io`), optional `EMAIL_FROM_NAME` (default `Linkrunner Media`), optional `APP_URL` (default `https://agency.linkrunner.io`). Set via `supabase secrets set` on the project; never in repo.
- Sending domain `linkrunner.io` is verified on Resend (Squarespace DNS, verified 2026-04-29). Reply-To is set to the inviter's own email so replies thread back to whoever sent the invite, while the visible `From` is `agency@linkrunner.io`.
- Sections touched: Recent changes log; §10 Edge functions & integrations (new function); §12 External accounts & secrets (Resend row + new secret rows); §13 Known decisions & gotchas (Resend design notes); §14 Pending work (Tier 2/3 follow-ups added).

### 2026-05-01 — Sidebar Social Calendar badge counts plans, not events
- The sidebar nav badge next to **Social Calendar** previously summed every unread *event* across all plans (`Array.from(unreadByPlan.values()).reduce((a,b) => a+b, 0)` in App.jsx). It now counts the number of plans with any unread (`unreadByPlan.size`), so the badge matches the count of red dots on the calendar instead of being a multiple of it.
- Sections touched: Key feature flows (Unread tracking).

### 2026-05-01 — Post plan URLs nested under calendar
- **`/c/:slug/plan/:id` is gone. Post plans now live at `/c/:slug/calendar/:id`** (and bare `/calendar/:id` for the no-slug fallback). The route shape inside the app is unchanged — it's still `{view: 'plan', id, brandSlug}` — only the URL string changed in `parsePathToRoute` and `viewToPath`. Hard cut, no backward-compat fallback for old `/plan/...` paths since none had been shared externally.
- **Why:** the URL now reflects the UI hierarchy. You enter the calendar at `/c/abcoffee/calendar`, click a chip, and the URL extends to `/c/abcoffee/calendar/a3f9c2d8` — calendar stays in the breadcrumb. Previously the URL silently swapped `calendar` for `plan`, which read like the plan lived somewhere else.
- Sections touched: Routes/Views (plan row), Known decisions (new entry: nested-under-calendar rationale).

### 2026-04-30 — Phase 1 router (real URLs, no per-brand segment yet)
- Added `react-router-dom@6`. `<App/>` now mounts inside `<BrowserRouter/>` ([main.jsx](web/src/main.jsx)). Every view has a real path: `/calendar`, `/tasks`, `/tasks/:id`, `/plan/:id`, `/library`, `/brand`, `/team`, `/performance`, `/profile`, `/settings`, `/clients`, `/members`, `/home`. `/` redirects to the saved or default view.
- **No child component changes.** The legacy `route = {view, id}` shape is preserved by deriving it from `location.pathname` via `parsePathToRoute`, and `setRoute({view, id})` is now a thin adapter over `navigate(viewToPath(...))`. Sidebar's active-state logic (`route.view === n.key`) keeps working unchanged.
- **Short URLs for tasks and post plans.** `/tasks/:id` and `/plan/:id` URLs now use the **first 8 hex chars of the row's UUID** (git-short-SHA style: `/plan/a3f9c2d8` instead of `/plan/a3f9c2d8-7e21-4b3a-9c01-1234567890ab`). `shortenId(uuid)` shortens for display in `viewToPath`; `findFullId(prefix, items)` resolves prefix → full UUID right before passing to `<TaskDetailView>` / `<PostPlanDetailView>`, so child components keep working with the full UUID. **Full-UUID URLs still resolve** (old deep links + bookmarks unchanged), and the same rule auto-applies to every new task/plan you create. No DB change, no migration.
- **404 view for unknown URLs.** `parsePathToRoute` returns `{view: 'not_found', path}` for anything it doesn't recognise; `<NotFoundView>` renders a tasteful page with serif headline ("We don't think you meant *to come here.*"), the bad path in a code chip, and a "Take me to the Social Calendar" CTA. `not_found` is added to both the guest-allowed set and the agency context-snap legal sets so neither effect bounces the user away from the 404. ([NotFoundView.jsx](web/src/components/NotFoundView.jsx))
- **`lr_route` localStorage retired as source of truth.** One-time migration on mount: if the user lands on `/` with a `lr_route` saved, we hop them to the matching path (`replace: true`) and remove the key. After bake, the migration block can be deleted.
- Phase 2 (per-brand segments like `/c/:brandSlug/calendar`) is **not** in this PR. Brand scoping still flows through `BrandPicker` → `localStorage.lr_admin_active_brand`.
- Sections touched: Recent changes log; LocalStorage keys (`lr_route` deprecated); Routes/Views (new path column + short-ID rule + 404); Known decisions (URL-driven routing rationale, short-ID rationale, 404 design); Pending work (Phase 2 still open).

### 2026-04-30 — Social Calendar + Post Plans, BrandPicker replaces shadowing
- Merged in [PR #2](https://github.com/CodeFire98/lr-studio-dashboard/pull/2). Two interconnected features:
  - **BrandPicker** sidebar dropdown replaces the old shadow-impersonation flow. Agency users now scope every per-brand surface (Calendar, Tasks, Library, Brand Intelligence) by picking a brand or "All clients" from the sidebar. `lr_impersonation` is dead; `lr_admin_active_brand` is the new persistence key.
  - **Social Calendar / Post Plans** — the AI Social Media Manager working surface. Month grid, click-to-create, per-platform copy variants (IG / LinkedIn / X), references + deliverables uploads, threaded conversation, full status workflow with auto-logged transitions. "Any activity" unread tracking with red dots on chips and a count badge on the sidebar nav item; both clear instantly via optimistic mutators.
- Migrations applied: `0021_post_plans`, `0022_post_plan_views_and_attachments_storage`, `0023_post_plan_status_log`.
- New storage bucket: `post-plan-attachments` (public read, RLS keyed off `<accountId>/<postPlanId>/...` path).
- New route: `plan` → `PostPlanDetailView`.
- BrandKitView fix: agency now reads `accountId` as a prop instead of `auth.account.id`, fixing the agency-side blank Brand Intelligence page.
- Sections touched: Glossary; Data model (new tables, bucket, migrations); LocalStorage keys; Routes/Views; Key feature flows (added Post Plans + BrandPicker + Unread tracking); Known decisions.

### 2026-04-29 — Admin sidebar reorder
- `Sidebar.buildAdminNav` now orders items: Clients → Inbox → Social Calendar → All tasks → Team. Clients moves to the top (it's the daily entry point — pick a brand first); Team is pinned at the bottom (agency-internal, accessed less often). No functional change beyond order.
- Sections touched: none — Routes/Views table doesn't enumerate sidebar order.

### 2026-04-29 — Reference doc created
- Initial creation of this file. Captures the codebase as of commit `b9c9982`.
- Recent feature work landed this week (in commit order):
  - `bf3c673` Tasks: deadline off-by-one fix + chip-edit activity logging (migration 0019)
  - `eed8563` Library: scope creatives to active brand for multi-brand users
  - `cb942cd` HomeView: wire Schedule a call → cal.linkrunner.io
  - `7efddb7` Onboarding: reorder flow + highlight Fetch brand magic moment
  - `efaa985` Settings: actually delete the brand + force picker after deletion (migration 0020)
  - `691058b` Brand Intelligence: Fetch Brand button + post-onboarding redirect
  - `b9c9982` enrich-brand-kit: bot-wall detection (`proxy: "auto"`) + multi-source URL discovery modes

---

## 1. What this is

**L+R Studio** is a creative-brief and brand-intelligence dashboard for an
agency (L+R) and the brand clients it works with. Brands submit creative
briefs in plain language; agency leads pick them up, deliver creatives,
and the brand sees everything in a shared workspace. A "Brand Intelligence"
module auto-fills a brand kit (palette, fonts, voice, logos, social links)
by scraping the brand's website with Firecrawl.

Two user types: **brand owners/members** (the customer) and **agency
owners/members** (L+R staff). The same React app serves both, with
mode-aware routing.

Hosted at **`agency.linkrunner.io`** (production custom domain, Vercel).
Legacy URL `lr-studio-dashboard-3kkp.vercel.app` still resolves.

---

## 2. Glossary

Same concept often has multiple names in code and copy. Use this when
something looks confusingly named.

| Term | Means | Code identifier(s) |
|---|---|---|
| **Brand** | A customer workspace owned by a brand | `accounts.type = 'brand'`, `auth.workspace = 'customer'` |
| **Agency** / **Admin** / **L+R Studio** | The agency-side workspace | `accounts.type = 'agency'`, `auth.isAgency = true`, `mode = 'admin'` |
| **Account** | DB-level workspace row | `public.accounts` |
| **Workspace** | UI-facing word for an account | (no separate code id) |
| **Owner** | Can delete the account, manage members | `account_members.role = 'owner'` |
| **Member** | Can read/edit but not delete or manage team | `account_members.role = 'member'` |
| **Active brand** | The brand the user is currently viewing | Brand users: `auth.account`, `localStorage[lr_active_brand_<userId>]`. Agency users: `App.activeAdminBrandId`, `localStorage.lr_admin_active_brand` |
| **All clients** | Agency-only sentinel for the BrandPicker meaning "no brand selected" | `ALL_CLIENTS = '__all__'` in `BrandPicker.jsx`; `App.isAllClientsMode` |
| **BrandPicker** | Sidebar dropdown that scopes every surface to one brand (or All clients for agency) | `BrandPicker.jsx`, mounted in `Sidebar` |
| **Brand select view** | Login-time picker shown to brand users with 2+ memberships | `BrandSelectView`, gated by `auth.requiresBrandSelection` |
| **Impersonation** *(deprecated)* | Old shadow flow where agency entered a brand's workspace via sessionStorage | ~~`sessionStorage.lr_impersonation`~~ — replaced by BrandPicker on 2026-04-30 |
| **Brand Kit** / **Brand Intelligence** / **Kit** | Brand's design + voice profile | `brand_kits` table, `BrandKitView` route key `"brand"`, accepts `accountId` prop |
| **Brief** / **Task** | A creative request | `tasks` table, `TasksView` / `TaskDetailView` |
| **Chip** | A structured brief field (count/deadline/format/platform/objective) | `task.brief.chips`, `CHIP_TO_COLUMN` map in `db.js` |
| **Enrichment** / **Fetch Brand** | Auto-fill a kit from the brand's website | `triggerBrandKitEnrichment`, `enrich-brand-kit` edge function |
| **Re-enrich** | Run enrichment again on a kit | same flow, different button label when `kit.enrichedAt` exists |
| **Auto-create-brand** | First-login provisioning of a brand workspace | `create_brand_account` RPC, called from `auth.js _doRefresh` |
| **Brand-just-deleted gate** | Forces picker after delete instead of auto-create | `localStorage.lr_brand_just_deleted` |
| **Library** | Searchable grid of delivered creatives | `LibraryView`, route `"library"` (admin renders `AdminUploadView`) |
| **Activity** *(task-side)* | Per-task event feed | `activity` table, rendered in `TaskDetailView` |
| **Post plan** | A single content concept scheduled for one or more social platforms | `post_plans` table, `PostPlanDetailView`, route `"plan"` |
| **Social Calendar** | Month-grid surface that shows post plans by date; default landing view | `CalendarView`, route `"calendar"` |
| **References** *(post-plan-side)* | Brand-uploaded inspiration files for a post plan | `post_plan_attachments.kind = 'reference'`, brand-only upload |
| **Deliverables** *(post-plan-side)* | Agency-uploaded final creatives for a post plan | `post_plan_attachments.kind = 'final'`, agency-only upload |
| **Status log** | Per-row history of a post plan's status transitions | `post_plan_status_log`, written by `log_post_plan_status_change` AFTER UPDATE trigger |
| **Unread activity** | Red dot on a calendar chip + badge count on sidebar — fires when comments, attachments, or plan edits by other users happened since the viewer's `last_seen_at` | `post_plan_views`, `loadPostPlanUnreadCounts` in `db.js` |
| **Mark seen** | Stamp `post_plan_views.last_seen_at = now()` for the viewer | `markPostPlanSeen`, called on detail-view mount, on tab focus, and after every `persist()` |
| **Trends Radar** | Agency-only "what's trending right now" pool — TikTok / IG / X / LinkedIn signals scraped on demand | `trend_signals` table, `TrendsView`, route `"trends"`, Vercel API route `web/api/fetch-trends.ts` |
| **Trend signal** | One trending hashtag / sound / topic / post row in the pool | `trend_signals` row; mapped via `mapTrendSignalRow` in `db.js` |
| **Trend hashtags** | Per-brand list of IG hashtags the brand wants tracked, drives Phase 3 IG scrape | `brand_kits.trend_hashtags` (text[]); edited via TrendHashtagsCard in `BrandKitView` |
| **Turn into post plan** | Phase 5 action — convert any trend signal into a pre-filled post_plan row in a brand's calendar | `TurnIntoPostPlanModal`; `+ Post plan` pill on each TrendCard |
| **Idea** / **Post plan idea** | A brand-submitted content suggestion the agency reviews and turns into a real post plan | `post_plan_ideas` row, `IdeateView` (brand) / `IdeateInboxView` (agency) |
| **Idea dump** *(brand label)* | Brand-side sidebar surface — composer + history of ideas the brand has sent to the agency. Renamed 2026-05-08 from "Got ideas?" — same `ideate` route, same `IdeateView`. | route `"ideate"`, brand label "Idea dump", `IdeateView` |
| **Inbox** *(post-plan-ideas)* | Agency-in-brand sidebar surface — queue of submitted ideas with edit + "Add to Social Calendar" actions | route `"ideate"`, agency label "Inbox", `IdeateInboxView`. **Note**: the old All-clients "Inbox" (a queue of tasks) is gone — different surface, different table. |
| **Add to Social Calendar** | Agency action — convert a submitted idea into a real `post_plans` row, flipping the idea to `status='converted'` and back-linking via `converted_post_plan_id` | `ConvertIdeaModal`; idea-detail CTA |
| **Idea queue badge** | Sidebar Inbox badge count = number of `post_plan_ideas` for the active brand with `status='submitted'`. Drops by 1 when an idea is converted or archived. | `App.ideaQueueCount` state, refreshed via `subscribeToPostPlanIdeas` |
| **Publication** *(post-plan)* | A row that records "this plan went live on this platform, here's the URL" — one per (plan, platform) | `post_plan_publications` table, written via `MarkAsPostedModal` |
| **Posted** *(derived state)* | Display-only state for plans that are approved AND have ≥1 publication row. Renders with a violet pill across calendar / detail / repo. **Not** a `post_plans.status` enum value — see `getDisplayStatus` | `getDisplayStatus(plan, publications)` in `postPlanShared.jsx`; `STATUS_CONFIG.posted` for the visual |
| **Mark as posted** | Action — opens `MarkAsPostedModal` from `PostPlanDetailView` to upsert publications per platform with optional live URL. Available to brand AND agency on approved plans | `MarkAsPostedModal`, `upsertPostPlanPublication` |
| **Live posts** | Brand-scoped repository view listing every publication tile — grouped by month, filterable by platform, searchable. Sidebar entry "Live posts" with `link` icon | route `"posts"`, `LivePostsView`, path `/c/:slug/posts` |
| **Conversations** *(unified per-brand chat)* | One ongoing chat per brand account at `/c/:slug/conversations`. Brand sees a single thread with their agency; agency sees the same thread, scoped via BrandPicker. Full-pane stacked feed + composer with **paperclip = files** + **calendar = tag a plan** + Slack-style thread drawer for replies. Sticky header + sticky composer (the wrap is the scroll container). Image / video / file attachments work in both the feed composer AND inside thread drawers. Optional `tagged_post_plan_id` per message renders a clickable plan-preview card inline; if the plan is later deleted the chip becomes a greyed-out "Plan deleted" tombstone. Right-click your own message to soft-delete; renders as a WhatsApp-style "Message deleted" italic tombstone everywhere it appears. Composer sends with ⌘↩; plain Enter inserts a newline. | `conversations` + `conversation_messages` + `message_attachments` + `conversation_views` tables (migrations 0042 + 0043); sidebar entry "Conversations" with `chat` icon; route `"conversations"`, path `/c/:slug/conversations`; deep-link `?plan=<short>` pre-fills composer tag. UI in [ConversationsView.jsx](web/src/components/ConversationsView.jsx); CSS namespaced under `.conv-*` in [app.css](web/src/styles/app.css). Attachments reuse the `post-plan-attachments` bucket via `<accountId>/messages/<messageId>/<file>` path. @mentions still deferred. |
| **Conversations badge** | Sidebar Conversations entry's unread count for the active brand. Counts top-level `conversation_messages` rows (replies excluded) where the author is not the viewer and `created_at > conversation_views.last_seen_at`. Cleared when the user opens `ConversationsView` (mounts `markConversationSeen`). Recomputed on any `conversation_messages` change via `subscribeToConversationActivity`. | `loadConversationUnreadCount({userId, accountId})`, `markConversationSeen({userId, accountId})`, `subscribeToConversationActivity({accountId}, onChange)` in [db.js](web/src/lib/db.js); App-level state `conversationsUnread` in [App.jsx](web/src/App.jsx) |
| **Daily reminder** | Automated 6pm-IST email to brand members listing tomorrow's `needs_review` + `approved` plans. Per-brand toggle, default ON. Skips brands with zero qualifying plans tomorrow. | `accounts.daily_reminder_enabled`, `web/api/daily-digest.ts` (Vercel Cron), `send-email` edge function `daily-digest` template |
| **`<SafeImage>`** | Drop-in replacement for `<img>` that swaps to a "Preview unavailable" tile when the image fails to load. Used everywhere we render bucket assets so a single oversize/corrupt file doesn't break the layout. | [SafeImage.jsx](web/src/components/SafeImage.jsx) |
| **Image dimension validator** | Pre-upload guard that rejects images larger than 8,192px on any side or ~33 megapixels total — browsers can't reliably decode/render beyond that, regardless of the on-disk file size. Throws a friendly error with the actual filename + dimensions. | [imageValidation.js](web/src/lib/imageValidation.js); wired into every upload entry point in [db.js](web/src/lib/db.js) |
| **AI Co-pilot** | Agency-side AI assistant powered by Claude. Two surfaces planned: a sidebar chat panel for high-level work (plan a week, build a campaign, brainstorm), and inline "✨ AI" buttons on `PostPlanDetailView` / `ConvertIdeaModal` / `CalendarView` for narrow operations (draft caption, suggest concept, improve copy). Scoped per-brand (uses BrandPicker's active brand). Proposes-first model: AI output lands as a `post_plans` row with `ai_generated=true`, admin edits in the existing detail view, then submits for review through the standard workflow. | Backend: Vercel API route `web/api/ai/chat.ts` (PR 2). Frontend: sidebar Co-pilot panel + inline buttons. Gated by `AI_COPILOT_BRAND_IDS` env var allowlist during rollout. |
| **Brand context (compiled)** | The cached system-prompt blob sent to Claude on every AI Co-pilot call. Assembled from `brand_kits` + `brand_kit_notes` + recent approved `post_plans` (style refs) into a structured markdown string. When `includeCalendar: true` (chat only — opt-in), also pulls upcoming `post_plans`, recent `post_plan_publications`, and latest `post_engagement_snapshots` to add five "right-now" sections: `## Today` (date / day / week / timezone / next-30-day moments from `marketingMoments.js`), `## Upcoming calendar` (next-7-day-detail + 8-30-day-compact), `## Cadence (last 30 days)` with ⚠ GAP markers, `## Top performers` (ranked by engagement), `## Voice anchors` (top-performer opening lines). The static brand-kit / voice / strategy / notes sections stay byte-stable for the 5-min prompt-cache TTL; the `## Today` and calendar sections invalidate when a new draft is created mid-conversation or when the date rolls over at midnight brand-local, which is the desired behaviour (model needs to see fresh state). | [brandContext.js](web/src/lib/brandContext.js); `compileBrandContext({...})` pure function + `loadAndCompileBrandContext(client, accountId, options?)` async wrapper. Marketing moments live in [marketingMoments.js](web/src/lib/marketingMoments.js). |
| **Brand locale** | Per-brand `{ country, timezone }` used by the `## Today` block and as the default for new post-plan timestamps. Resolved via `getBrandLocale(brandKit, account)` — looks at `brandKit.primary_market` / `brandKit.country` / `account.country` then `brandKit.timezone` / `account.timezone`, defaulting to `IN` and `Asia/Kolkata` (matches L+R Studio's actual market). Wired this way so adding a column on either table later is a no-op. | `getBrandLocale` in [brandContext.js](web/src/lib/brandContext.js) |
| **Marketing moments** | Curated list of holidays, festivals, and culturally-relevant observances surfaced into the `## Today` block of the brand-context blob. Powers the AI Co-pilot's proactive suggestion behaviour ("Diwali is in 12 days — want a series?"). Hand-dated for 2026-2027; `date-holidays` (npm) was tried first but only ships 6 public IN holidays — no Diwali / Holi / Eid / Rakshabandhan. **Refresh annually** when 2027 is half-elapsed. | [marketingMoments.js](web/src/lib/marketingMoments.js); `getUpcomingMoments({ from, days, country })` |
| **brand_kit_notes** | Free-form admin annotations on a brand — "remember that the founder hates the word 'authentic'", "no holiday content until Oct 15", "always tag @cofounder on milestone posts". The "memory" layer for the AI Co-pilot. Written by hand from the BrandKitView's `BrandNotesSection` AND by the Co-pilot via the `write_brand_note` tool (PR 6). `is_pinned=true` rows are always-true facts that ride along on every AI call; non-pinned rows are recent context that decays out of the window once we hit the ~20-most-recent cap. | `brand_kit_notes` table (migration 0039); written via `BrandNotesSection` UI or the `write_brand_note` chat tool |
| **`write_brand_note` tool** | Anthropic tool exposed to the chat Co-pilot via `/api/ai/chat`. Triggered when the admin tells the chat to remember something. Inserts a row into `brand_kit_notes` via service-role with `created_by = user.id`; supports `is_pinned` for always-true facts. | `web/api/ai/chat.ts` (tool definition + runToolCall handler) |
| **Pinned note** | A `brand_kit_notes` row with `is_pinned=true`. Always included in the brand-context blob the AI Co-pilot sees, regardless of recency. Used for facts that are "always true" — founder name, voice constraints, perma-instructions. Toggleable from the `BrandNotesSection` UI (Pin / Unpin action). | `brand_kit_notes.is_pinned` |
| **AI image direction** | One of 3-5 image-concept cards the Co-pilot proposes via `/api/ai/image` `mode=ideas`. Each direction is a different visual ANGLE (studio shot vs. lifestyle vs. detail crop vs. behind-the-scenes etc.) with title + 1-2 sentence description + 3-6 style keywords. The admin picks one direction, then the Co-pilot expands it into a paste-ready image-gen prompt via `mode=prompt`. | [AIImagePromptPanel.jsx](web/src/components/AIImagePromptPanel.jsx); `/api/ai/image` `mode=ideas` |
| **AI draft** | A `post_plans` row created by the AI Co-pilot rather than a human. Marked with `ai_generated=true`; the original tool-call args are stored in `ai_draft_payload` (jsonb) so we can diff "AI proposed" vs "admin shipped" later. Renders with a small "✨ AI draft" pill in `PostPlanDetailView` (PR 2+). The admin owns the row — edits it in the existing detail view, submits for review through the standard workflow. | `post_plans.ai_generated`, `post_plans.ai_draft_payload` (migration 0038) |

---

## 3. Architecture at a glance

```
┌──────────────────┐   HTTPS    ┌──────────────────────┐
│  Browser (SPA)   │◀──────────▶│  Vercel              │
│  React + Vite    │            │  agency.linkrunner.io│
└──────────────────┘            └──────────────────────┘
        │
        │ supabase-js (REST + Realtime + Storage + Auth)
        ▼
┌─────────────────────────────────────────────────────┐
│  Supabase project vmfwnfflhvskadkfnvds              │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐ │
│  │Postgres │ │  Auth   │ │ Storage  │ │   Edge   │ │
│  │ + RLS   │ │ + OAuth │ │ buckets  │ │ Functions│ │
│  └─────────┘ └─────────┘ └──────────┘ └──────────┘ │
└─────────────────────────────────────────────────────┘
                                            │
                    enrich-brand-kit fn     ▼
                                  ┌────────────────────┐
                                  │ Firecrawl /v2/scrape│
                                  │ proxy: auto         │
                                  └────────────────────┘
```

Realtime subscriptions stream tasks / messages / activity / assets back to
the browser. Auth state is hydrated into `localStorage` for instant first
paint, then revalidated against the live session.

---

## 4. Tech stack

- **Frontend**: React 18 + Vite, hand-written CSS in `web/src/styles/app.css` (~2500 lines, authoritative for all current UI). **Scoped Tailwind v3.4** added in AI Co-pilot v2 Phase 0 ([PR #61](https://github.com/CodeFire98/lr-studio-dashboard/pull/61)) — content glob restricted to `web/src/components/ai-elements/**` only, `preflight: false` so the existing CSS reset stays authoritative, design tokens scoped under `.ai-elements` class (NOT `:root`). Tailwind only applies inside AI Elements components from Phase 2 onward; the rest of the app remains pure hand-written CSS.
- **AI / LLM**: Vercel **AI SDK v6** (`ai` + `@ai-sdk/anthropic@^3` + `@ai-sdk/react@^3`) + `zod@^4` for tool/output schemas. AI Co-pilot v2 migration in progress — see [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md). Phase 1 server routes (`/api/ai/chat`, `/api/ai/copy`) use `streamText` + `tool({ inputSchema (Zod), execute })`; Phase 2 client uses `useChat` / `useCompletion` / `useObject` hooks. `@anthropic-ai/sdk@^0.95` still in deps as a transitional dep (only used by the `/api/ai/image` route until Phase 1c lands). **AI Elements** component library (shadcn-style copy-paste from `https://elements.ai-sdk.dev/`) lands in Phase 2 for chat surfaces (Conversation / Message / PromptInput / Tool / Reasoning / Persona).
- **Data layer**: `@supabase/supabase-js` v2 — single client at `web/src/lib/supabase.js`
- **Auth**: Supabase Auth (email/password + Google OAuth + invite tokens)
- **Backend**: Postgres on Supabase, RLS-enforced
- **Edge runtime**: Deno on Supabase Functions
- **External**: Firecrawl v2 (`/scrape` for enrichment, planned `/agent` for socials); Anthropic Claude (claude-sonnet-4-6 default; prompt caching via 5-min `ephemeral` TTL)
- **Hosting**: Vercel (auto-deploy on `main`), Vercel Web Analytics + Speed Insights enabled
- **Custom fonts**: Google Fonts loaded on demand by `useGoogleFonts()` hook

---

## 5. Repo layout

```
l-r-studio-dashboard/
├── README.md                  # Original handoff note (Claude Design export)
├── DEPLOY.md                  # Deployment / first-time setup checklist
├── REFERENCE.md               # ← this file
├── CLAUDE.md                  # Project rules for Claude Code (must read REFERENCE.md)
├── supabase/
│   ├── config.toml            # project_id = "vmfwnfflhvskadkfnvds"
│   ├── migrations/            # 0001 → 0023+ (numbered, applied in order)
│   └── functions/
│       ├── _shared/           # cors helper
│       └── enrich-brand-kit/  # the only edge function so far
└── web/
    ├── .env.local             # VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY
    ├── vercel.json            # Static SPA config
    ├── src/
    │   ├── App.jsx            # Routing + global state + onboarding gate
    │   ├── main.jsx           # React mount
    │   ├── components/        # All view components + modals + primitives
    │   ├── lib/
    │   │   ├── supabase.js    # Client init
    │   │   ├── auth.js        # Auth state, hydrate, signin/signup, brand switching
    │   │   ├── db.js          # All Supabase queries (tasks, assets, activity, kits, etc.)
    │   │   ├── chipParser.js  # Free-text → chip extraction
    │   │   └── mockData.js    # Palette + seed data for placeholder UI
    │   └── styles/app.css     # All app CSS (single file, ~2500 lines)
```

---

## 6. Data model

All tables live in `public`. Every table has RLS enabled. FK chains
cascade on delete from `accounts`, so deleting a brand wipes all its data.

### Core tables

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `accounts` | Workspaces (brand or agency) | `id`, `name`, `type` (`brand`/`agency`), `accent_color`, `daily_reminder_enabled` (boolean default `true`, since 0037 — drives the 6pm-IST daily-digest cron) | Members + agency users | Agency for INSERT; members for UPDATE; **owner-only DELETE via `delete_brand_account` RPC** |
| `account_members` | Per-account membership rows | `account_id`, `user_id`, `role` (`owner`/`member`) | Members + agency | Owners (via `remove_team_member`/`change_member_role` RPCs) |
| `profiles` | Per-user profile mirror of auth.users | `id` (=auth.uid), `display_name`, `initials`, `avatar_url`, `avatar_color`, `is_agency`. **No email column** — email lives in `auth.users.email`; surface it via the `account_members_with_email` RPC. | Authenticated | Self-update only |
| `tasks` | Briefs / creative requests | `account_id`, `title`, `brief_text`, `status`, `creatives_count`, `deadline`, `format`, `platform`, `objective`, `assigned_lead_id`, `created_by` | Members of account | Members + agency |
| `assets` | Files uploaded against a task | `task_id`, `kind` (`reference`/`wip`/`deliverable`), `storage_path`, `mime_type`, `version`, `uploaded_by` | Same as task | Same |
| `messages` | Conversation thread per task | `task_id`, `author_id`, `body` | Same as task | Author + agency |
| `activity` | Event feed per task | `task_id`, `actor_id`, `action`, `payload` (jsonb) | Authenticated, scoped to readable tasks | **SELECT-only for users**; writes via `SECURITY DEFINER` triggers (`log_task_activity`, `log_message_activity`, `log_asset_activity`) |
| `brand_kits` | Brand's design + voice profile | one per account; ~60 columns including `palette`, `fonts`, `tagline`, `mission`, `voice_tags`, `logos`, `enrichment_status`, `enriched_at` | Members + agency | Members + agency |
| `invitations` | Pending team invites | `account_id`, `email`, `token`, `role`, `expires_at` | Inviter + invitee | Inviter |

### Post plan tables (Social Calendar — added 2026-04-30)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `post_plans` | One content concept scheduled for one or more platforms | `account_id`, `scheduled_at`, `platforms` (text[]: `instagram`/`linkedin`/`x`), `concept`, `copy_variants` (jsonb, per-platform copy), `status`, `created_by`, `approved_at`, `posted_at` | Members + agency | Members + agency |
| `post_plan_comments` | Threaded conversation per plan | `post_plan_id`, `author_id`, `body` | Anyone with read access to the parent plan | Author + agency |
| `post_plan_attachments` | References (brand) + Deliverables (agency) | `post_plan_id`, `kind` (`reference`/`final`), `version`, `storage_path`, `filename`, `mime_type`, `size_bytes`, `uploaded_by` | Anyone with read access to the parent plan | Uploader (own rows); agency can delete any |
| `post_plan_views` | Per-(user, plan) "last seen" stamp powering unread tracking | `user_id`, `post_plan_id`, `last_seen_at` (composite PK) | Self only | Self only |
| `post_plan_status_log` | Auto-logged status transitions for the Activity feed | `post_plan_id`, `from_status`, `to_status`, `actor_id`, `created_at` | Anyone with read access to the parent plan | Trigger only (`log_post_plan_status_change` SECURITY DEFINER) |
| `post_plan_publications` | One row per (plan, platform) recording that a plan went live, with optional URL — drives the derived "Posted" pill and the Live Posts repository | `post_plan_id` (FK), `platform` (`instagram`/`linkedin`/`x`), `live_url` (text, nullable), `published_at`, `published_by`, `created_at`, `updated_at` (UNIQUE on `(post_plan_id, platform)`) | Anyone with read access to the parent plan | Anyone with edit access (members + agency); INSERT requires `published_by = auth.uid()`; DELETE for own row OR agency |
| `post_engagement_snapshots` | Append-only history of scraped engagement metrics per publication — feeds the Live Posts metrics row + future monthly reports | `publication_id` (FK ON DELETE CASCADE), `fetched_at`, `like_count`, `comment_count`, `share_count`, `save_count`, `view_count`, `bookmark_count`, `quote_count`, `reaction_count`, `engagement_rate`, `availability_notes`, `raw_payload` (jsonb), `actor_id`, `actor_run_id`, `scrape_status` (`ok`/`partial`/`failed`/`blocked`), `error_message` | Agency OR account-members-of-the-parent-plan | **Service-role only** — no client INSERT/UPDATE/DELETE policies. Writes happen via `/api/engagement/refresh`. |
| `post_embed_cache` | 1:1 with publications — cached author/caption/media for the embed card | `publication_id` (PK, FK ON DELETE CASCADE), `author_handle`, `author_display_name`, `author_avatar_url`, `caption`, `media_type` (`image`/`video`/`carousel`/`text`/`unknown`), `media_url`, `media_urls` (jsonb), `media_aspect_ratio`, `posted_at`, `oembed_html` (X only), `last_refreshed_at`, `refresh_status` (`ok`/`failed`/`stale`), `created_at`, `updated_at` | Agency OR account-members-of-the-parent-plan | **Service-role only** — no client INSERT/UPDATE/DELETE policies. Writes happen via `/api/engagement/refresh`. |

`post_plans.status` enum (since migration 0035): `drafting`, `needs_review`, `approved`. Default = `drafting`. The `touch_post_plan_status_stamps` trigger auto-stamps `approved_at` on the first transition into `approved`. The `posted_at` column is preserved for historical rows but nothing writes to it anymore — see `post_plan_publications` for the live-shipped record. **Pre-0035 enum values** (`not_started`, `wip`, `needs_brand_feedback`, `needs_admin_revision`, `scheduled`, `posted`, `delayed`) are no longer accepted by the CHECK constraint, but `STATUS_CONFIG` in [postPlanShared.jsx](web/src/components/postPlanShared.jsx) still maps them to the right bucket so legacy `post_plan_status_log` rows render correctly in the activity feed.

**"Posted" is a derived display state, not a status value** (added 2026-05-07). `getDisplayStatus(plan, publications)` in [postPlanShared.jsx](web/src/components/postPlanShared.jsx) returns `'posted'` when the plan is approved AND has at least one `post_plan_publications` row; otherwise returns `plan.status`. Every UI surface reads this helper instead of `plan.status` directly so the calendar / detail / repo all show "Posted" uniformly. The status enum stayed at 3 values intentionally — see §13 Known decisions.

### Post plan ideas (Got ideas? / Inbox — added 2026-05-05)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `post_plan_ideas` | Brand-submitted content suggestion queued for the agency to convert into a `post_plans` row | `account_id`, `title`, `details`, `desired_date` (date, optional), `platforms` (text[]: `instagram`/`linkedin`/`x`), `status` enum `submitted`/`converted`/`archived`, `submitted_by`, `converted_post_plan_id` (FK post_plans, set when converted), `converted_at`, `created_at`, `updated_at` | Members + agency | Members + agency |
| `post_plan_idea_attachments` | Reference files the brand uploads alongside an idea | `idea_id`, `storage_path`, `filename`, `mime_type`, `size_bytes`, `uploaded_by` | Anyone with read access to the parent idea | Uploader (own rows); agency can delete any |

`post_plan_ideas.status` enum: `submitted` (new, unhandled — counted by the Inbox badge), `converted` (the agency made a `post_plans` row from it; `converted_post_plan_id` points at the new row), `archived` (agency dismissed; recoverable from the Archived filter). Default Inbox queue filter is `status = 'submitted'` so converting OR archiving an idea drops it off the queue.

Idea attachments **reuse the existing `post-plan-attachments` storage bucket** via path scheme `<accountId>/ideas/<ideaId>/<ts>_<filename>`. The bucket's storage RLS extracts the leading account id via `split_part(name, '/', 1)` (set up in 0022), so the `ideas/<ideaId>/...` middle segment doesn't affect access decisions — no separate bucket, no policy changes.

Both tables are in `supabase_realtime`; `IdeateView` (brand) and `IdeateInboxView` (agency) subscribe via `subscribeToPostPlanIdeas` for cross-tab + agency↔brand sync.

### AI Co-pilot tables (added 2026-05-11)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `brand_kit_notes` | Free-form admin annotations powering the AI Co-pilot's "memory" — facts that don't fit `brand_kits`' structured columns. Composed into the brand-context blob on every AI call. | `account_id` (FK → accounts), `body` (text), `is_pinned` (boolean), `created_by` (FK → profiles ON DELETE SET NULL), `created_at`, `updated_at` | **Agency staff only** (tightened 2026-05-12, migration 0040 — was agency OR members) | Same — agency-only |

`post_plans` also gains two AI-related columns in migration 0038:

- **`ai_generated boolean default false`** — `true` for plans created by the Co-pilot. Drives the "✨ AI draft" pill (PR 2+) and lets us segment telemetry.
- **`ai_draft_payload jsonb default '{}'::jsonb`** — original Co-pilot tool-call arguments. Stored for diff'ing "what AI proposed" vs "what the admin shipped" and for a future "reset to AI draft" affordance.

A partial index `post_plans_ai_generated_idx ON (account_id, created_at desc) WHERE ai_generated = true` supports the eventual "show me AI drafts I haven't reviewed" query — stays small because the vast majority of rows are human-created.

`brand_kit_notes` is in `supabase_realtime` so the Co-pilot panel and BrandKit UI stay in sync across tabs when notes are added/edited.

### Trends Radar table (added 2026-05-02)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `trend_signals` | Platform-agnostic pool of trending things (hashtags / sounds / topics / posts / creators) for the agency-only Trends Radar surface | `platform` ('tiktok'/'instagram'/'twitter'/'linkedin'), `kind` ('hashtag'/'sound'/...), `region` (ISO-2 or 'global'), `category`, `title`, `subtitle`, `url`, `thumbnail_url`, `metric_value`, `metric_label`, `rank`, `trend_window` ('now'/'24h'/'7d'/'30d'), `captured_at`, `expires_at`, `raw_payload` (jsonb), `account_id` (nullable, for per-brand IG signals in Phase 3) | Agency staff (via `is_agency_user()`) — and members of `account_id` if set (forward-compat for Phase 3) | **Service role only** (the Vercel `/api/fetch-trends` route). No client-side writes. |

Unique dedupe index on `(platform, kind, region, title, trend_window, account_id)` so `/api/fetch-trends` upserts re-fetched rows instead of duplicating. `prune_expired_trend_signals()` SECURITY DEFINER helper deletes rows past `expires_at` (default `now() + 14 days` on insert).

All four post-plan tables are in the `supabase_realtime` publication. Realtime drives cross-tab unread refresh and same-tab cross-user updates; same-tab same-user updates use optimistic mutators (`upsertPostPlan`, `removePostPlanLocal`, `clearUnreadForPlan` in `App.jsx`).

### Conversations tables (added 2026-05-14)

The unified per-brand chat. Replaces `post_plan_comments` as the home for all back-and-forth between brand and agency.

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `conversations` | One chat per brand account. The `unique(account_id)` constraint is the whole "channels list" — there is no list. | `account_id` (FK accounts ON DELETE CASCADE, UNIQUE), `created_at` | Agency OR account-members | **Service-role only at the client level.** Auto-provisioned by the migration backfill + the `accounts_ensure_brand_conversation` trigger on `accounts` INSERT. |
| `conversation_messages` | Top-level messages + Slack-style thread replies. Body + optional `tagged_post_plan_id` chip + soft-delete tombstone. | `conversation_id` (FK conversations ON DELETE CASCADE), `parent_message_id` (self-FK ON DELETE CASCADE; null = top-level, set = thread reply), `author_id` (FK profiles ON DELETE SET NULL), `body`, `tagged_post_plan_id` (FK post_plans ON DELETE SET NULL), `created_at`, `edited_at`, `deleted_at`. Three partial indexes: `(conversation_id, created_at desc) where parent_message_id is null` (top-level feed), `(parent_message_id, created_at) where parent_message_id is not null` (thread reads), `(tagged_post_plan_id, created_at) where tagged_post_plan_id is not null` (per-plan filter). | Agency OR account-members (via the parent conversation) | INSERT requires `author_id = auth.uid()` + visible conversation. UPDATE/DELETE limited to own messages or agency. |
| `message_attachments` | Image / video / file uploads + pasted-link previews on a message. Wired up in PR 2/3. | `message_id` (FK conversation_messages ON DELETE CASCADE), `kind` (`'image'`/`'video'`/`'file'`/`'link'`), `storage_path` (null for kind='link'), `url` (null for media), `filename`, `mime_type`, `size_bytes`, `width`, `height`, `uploaded_by` (FK profiles ON DELETE SET NULL) | Agency OR account-members (via the parent message) | INSERT requires `uploaded_by = auth.uid()` (or null) + visible parent message. DELETE limited to uploader or agency. |
| `conversation_views` | Per-(user, conversation) "last seen" stamp powering the sidebar Conversations badge. Mirror of `post_plan_views` from migration 0022. | `user_id` (FK profiles ON DELETE CASCADE), `conversation_id` (FK conversations ON DELETE CASCADE), `last_seen_at`. PK `(user_id, conversation_id)` | Own rows only | Own rows only |

**Naming note.** The intuitive name `messages` is taken by the legacy tasks-chat table from migration 0001 (still on disk while the tasks-table cleanup is pending in §14). Hence `conversation_messages`. The cleanup PR can rename it back to `messages` once the legacy table is dropped.

**Realtime.** All three new tables (`conversations`, `conversation_messages`, `message_attachments`) are in the `supabase_realtime` publication.

### Daily-digest audit log (added 2026-05-11)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `daily_digest_log` | Per-(run, brand) audit trail of every cron decision the daily-digest route makes — so "did email X go out on day Y?" is a one-line SQL query instead of Vercel-log archaeology | `run_at`, `account_id` (FK accounts ON DELETE SET NULL), `brand_name`, `sent`, `failed`, `recipients`, `plans_needs_review`, `plans_approved`, `skip_reason`, `skip_details`, `window_start_utc`, `window_end_utc`, `tomorrow_ist_label` | Agency staff (`is_agency_user()`) | **Service role only** (the Vercel `/api/daily-digest` route). No INSERT/UPDATE/DELETE policy — matches `post_plan_status_log`'s shape (trigger/route-only writes). |

Two indexes — `(run_at desc)` for recency queries and `(account_id, run_at desc)` for brand-history. No realtime; this is an audit surface, no client subscribes.

### Storage buckets

| Bucket | Contents | Public? | Access policy |
|---|---|---|---|
| `assets` | Task deliverables, WIPs, references | Private (signed URLs) | Members of the task's account |
| `brand-assets` | Brand kit references (mood, packaging, etc.) | Public read | Members for write |
| `brand-logos` | Brand logo + variants | Public read | Members for write |
| `post-plan-attachments` | Post plan references + final deliverables | Public read | Members of the account; RLS keyed off path scheme `<accountId>/<postPlanId>/<ts>_<filename>` via `post_plan_attachment_account_id(name)` SQL helper |

### Activity event types

Emitted by triggers on the matching tables. The renderer in
`mapActivityRow` (db.js) knows about:

- `created` — task insert
- `status_changed` — task status transition
- `assigned` — task lead change
- `field_edited` — chip change (count/deadline/format/platform/objective) — added in migration 0019
- `comment_posted` — new message
- `asset_uploaded` — new asset

### RPCs (SECURITY DEFINER functions)

Called via `supabase.rpc(...)` from the client. Each enforces auth checks
internally because it bypasses RLS:

- `create_brand_account(p_name)` — first-time brand provisioning
- `create_additional_brand_account(p_name)` — explicit "create another brand" from picker
- `delete_brand_account(p_account_id)` — owner-only brand deletion (migration 0020)
- `remove_team_member(p_user_id, p_account_id)` — caller must be an `owner` of `p_account_id`; can't remove self. Demotes `profiles.is_agency` if it's the user's last agency membership (since 0026). Pre-0028 the gate was agency-only; 0028 made it match `change_member_role`.
- `change_member_role(p_user_id, p_account_id, p_new_role)` — owner-only
- `accept_invitation(p_token)` — redeem an invite
- `account_members_with_email(p_account_id)` — returns the account's members joined to `auth.users.email` (migration 0027). Authz: caller must be a member of the account, OR be agency staff. Used by `loadTeamForAccount` so TeamView and AdminTeamView can display each member's email next to their name.
- `prune_expired_trend_signals()` — deletes rows from `trend_signals` where `expires_at < now()`. Returns the number of rows removed. SECURITY DEFINER, no public grant — invoked by service-role from a future cron in Phase 4 (migration 0028).
- ~~`auto_accept_pending_invitations()`~~ *(deprecated 2026-05-02)* — was called on every session refresh and matched by email. Removed because it silently granted access to existing-account invitees and made mistyped invite emails dangerous. Function still exists on prod (defensive — in case of cached clients), no longer called from anywhere in the app. Safe to drop in a follow-up migration.

### Migrations

Sequentially numbered SQL files in `supabase/migrations/`. Apply via:
- **CLI** (requires `supabase link` + DB password): `SUPABASE_ACCESS_TOKEN=<PAT> supabase db push`
- **Management API** (PAT-only — what we used for 0025/0026): `POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "..."}` and PAT bearer
- **Dashboard**: SQL Editor → paste → run

Most recent: `0042_conversations.sql`.

Recent batch:
- `0021_post_plans` — `post_plans` + `post_plan_comments` + `post_plan_attachments` + RLS + triggers + realtime.
- `0022_post_plan_views_and_attachments_storage` — `post_plan_views` table, `post-plan-attachments` storage bucket + storage RLS scoped via `post_plan_attachment_account_id(name)` helper.
- `0023_post_plan_status_log` — `post_plan_status_log` + `log_post_plan_status_change` trigger.
- `0024_account_slug_backfill` — `accounts.slug` backfill + auto-generation trigger for Phase 2 routing.
- `0025_accept_invitation_idempotent` — `accept_invitation(token)` is idempotent for the auto-accept race (don't raise "invalid or expired" when the row was already accepted by `auto_accept_pending_invitations()` and the caller is a member). See §13 entry.
- `0026_remove_team_member_resets_is_agency` — `remove_team_member` now flips `profiles.is_agency = false` when removing the user's last agency membership. Includes a one-shot backfill for stale rows already in the broken state. See §13 entry.
- `0027_account_members_with_email` — `account_members_with_email(p_account_id)` SECURITY DEFINER RPC that joins `account_members → profiles → auth.users.email` for team-list rendering. See §13 entry.
- `0028_remove_team_member_owner_can_remove` — replaces the agency-only gate on `remove_team_member` with an account-owner check (matches `change_member_role`). Brand owners can now remove members of their own brand. See §13 entry.
- `0029_trend_signals` — new `trend_signals` table + indexes + RLS (agency-only read; service-role write) + `prune_expired_trend_signals()` cleanup helper. Backs the new Trends Radar surface; first writer is the Vercel route `web/api/fetch-trends.ts`. See §13 entry.
- `0030_brand_trend_hashtags` — adds `brand_kits.trend_hashtags text[] not null default '{}'`. Per-brand hashtag list driving the Trends Radar Instagram scrape. Existing RLS on `brand_kits` already covers it — no policy changes.
- `0031_trend_signals_dedupe_nulls_not_distinct` / `0032_brand_competitor_handles` / `0033_brand_competitors_jsonb` — Trends Radar follow-on work (dedupe fix + per-brand competitor handle list, then a jsonb richer-shape rewrite). Not detailed here yet — see the migration files themselves.
- `0034_post_plan_ideas` — new tables `post_plan_ideas` + `post_plan_idea_attachments` powering the brand "Got ideas?" composer and the agency "Inbox" surface. RLS mirrors `post_plans`; storage reuses the `post-plan-attachments` bucket via path `<accountId>/ideas/<ideaId>/...`. See §13 entry.
- `0035_post_plan_status_simplification` — collapses `post_plans.status` from 8 values to 3 (`drafting`/`needs_review`/`approved`), remaps existing rows (legacy → new mapping in the migration body), updates the column default and CHECK constraint, and trims the auto-stamp trigger to drop the now-impossible `posted` branch. Historical `post_plan_status_log` rows are deliberately untouched. See §13 entry.
- `0036_post_plan_publications` — new table `post_plan_publications` recording when a plan went live on a given platform with optional URL. Composite UNIQUE on (post_plan_id, platform) so re-marking edits the existing row. RLS mirrors `post_plan_attachments`. Powers the derived "Posted" pill (status enum is unchanged) and the new `/c/:slug/posts` Live Posts repository. See §13 entry on publication-as-record vs 4th-status-enum-value.
- `0037_daily_reminder_settings` — adds `accounts.daily_reminder_enabled boolean not null default true`. Drives the 6pm-IST daily-digest email cron to brand members. No timezone column for v1 (every customer is in India today); add `accounts.timezone` when expansion happens. See §13 entry on cron-as-orchestrator-edge-function-as-renderer split.
- `0038_daily_digest_log` — new table `daily_digest_log` capturing every per-brand decision the cron makes (sent / failed / skipped, with counts and timestamps). One row per (run_at, account_id). RLS: agency reads, service-role-only writes. Indexes on `run_at desc` and `(account_id, run_at desc)`. See §13 entry on audit-as-table over read-from-logs.
- `0039_ai_copilot_scaffolding` — new `brand_kit_notes` table (free-form admin annotations powering the AI Co-pilot's "memory" layer, RLS mirrors `post_plan_ideas`) + new `post_plans.ai_generated` and `post_plans.ai_draft_payload` columns marking AI-proposed plans. Partial index on the AI-generated subset. Purely additive — nothing in the SPA reads these yet. See §13 entries on compiler-as-pure-function and notes-as-table-not-jsonb.
- `0040_brand_kit_notes_agency_only_rls` — tightens `brand_kit_notes` RLS from "agency staff OR account members" to **agency staff only** on SELECT/INSERT/UPDATE/DELETE. Notes are an agency-internal memory surface; brand users should never see the raw memory dump. Frontend in the same PR adds defense-in-depth (BrandNotesSection returns null for non-agency callers, sidebar entry hidden for brand users) but RLS is the real enforcement. **User runs via Supabase dashboard before the frontend PR lands.**
- `0041_post_engagement` — two new tables (`post_engagement_snapshots`, `post_embed_cache`) attached to `post_plan_publications` for the Live Posts engagement + embeds feature. Snapshots is append-only (powers monthly reports); embed cache is 1:1 with publications. Read RLS = agency OR account-members-of-the-parent-plan; **no client INSERT/UPDATE/DELETE policies** — writes are service-role only via `/api/engagement/refresh`. Both tables added to `supabase_realtime`. See §13 entry on snapshots-vs-columns and the engagement-scraping decision log.
- `0042_conversations` — Conversations PR 1: four new tables (`conversations` + `conversation_messages` + `message_attachments` + `conversation_views`) backing the unified per-brand chat. RLS: agency OR account-members read; self-author write on messages; agency-or-uploader on attachments; own-rows on views. Realtime: first three tables in `supabase_realtime`. Backfill: one `conversations` row per existing brand account, every `post_plan_comments` row copied into `conversation_messages` with the plan auto-tagged. Trigger: `accounts_ensure_brand_conversation` provisions a conversation on every new `accounts` INSERT with `type='brand'`. **The legacy `post_plan_comments` table is intentionally not dropped** — kept as a rollback escape hatch for one bake cycle, then deleted in a follow-up. See §13 entry on `conversation_messages`-vs-`messages` naming.
- `0043_conversation_messages_tagged_plan_decouple` — drops the FK on `conversation_messages.tagged_post_plan_id`. The column stays as a UUID but no longer cascades-set-null when a plan is deleted, so deleted-plan messages keep their orphaned id → the bubble can detect "tagged a plan that no longer exists" and render a "Plan deleted" tombstone chip. Tiny migration — single `drop constraint if exists`.
- `0044_brand_trend_snapshots` — adds the `brand_trend_snapshots` table for the AI Co-pilot daily trend cache. Append-only, RLS mirrors `post_engagement_snapshots`. Service-role-only writes via `/api/trends/refresh-cron`.
- `0045_engagement_refresh_cron` — moves the engagement-refresh cron from Vercel to Supabase pg_cron. **Installs the `pg_cron` and `pg_net` extensions**, creates the `cron_run_log` observability table (agency-readable, service-role writes), seeds two **Vault** secrets the cron statement reads at fire time (`engagement_cron_secret` + `engagement_project_url` — both start as `REPLACE_ME` placeholders; operator overwrites via Dashboard → Vault), and registers cron job `engagement-refresh-daily` on schedule `30 0 * * *` UTC (= 6:00 AM IST) which calls `<project_url>/functions/v1/engagement-refresh` with the bearer secret. Re-cadencing is a SQL-only change: `cron.unschedule('engagement-refresh-daily')` + `cron.schedule(...)` with the new expr. To verify after applying, see the migration's footer comment block.

---

## 7. Auth & access flow

### Sign-in paths (all → `_doRefresh` in `auth.js`)

1. **Email/password** — `signInWithPassword`
2. **Google OAuth** — `signInWithGoogle`; `redirectTo` uses `window.location.origin` so it stays on the current domain
3. **Invite token** — `accept_invitation` RPC after sign-in if `localStorage.lr_pending_invite` is set. **This is now the only invite-redemption path** — the previous email-match auto-accept was removed 2026-05-02.

### Sign-up paths

1. **Email/password** — `signUpBrand`; if confirmation email is enabled, lands on Site URL configured in Supabase Dashboard (set to `https://agency.linkrunner.io`)
2. **Google OAuth signup** — first sign-in auto-creates a profile via the `on_auth_user_created` trigger
3. **Invite-redemption signup** — `signUpForInvite`; promotes to agency or member based on the invitation row

### Brand resolution (the part that matters most)

There are two parallel brand-resolution paths now — one for brand users (login-time picker), one for agency users (sidebar BrandPicker).

**Brand users** — `hydrateProfile()` in `auth.js`:

```
has localStorage.lr_active_brand_<userId> matching a membership? → use it
else exactly 1 membership? → auto-select
else (0 or 2+ memberships) → picker (BrandSelectView)
```

`requiresBrandSelection = true` when:
- Non-agency user
- No active membership
- 2+ memberships **OR** `localStorage.lr_brand_just_deleted` is set

**Agency users** — `App.jsx`:

```
activeAdminBrandId state, hydrated from localStorage.lr_admin_active_brand,
defaults to ALL_CLIENTS sentinel ('__all__').
isAllClientsMode = isAgency && (activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId)
scopeAccountId = isAllClientsMode ? null : activeAdminBrandId
```

The sidebar `<BrandPicker/>` is the only UI that mutates `activeAdminBrandId`. Every per-brand surface (CalendarView, BrandKitView, LibraryView, PerformanceView, TeamView, PostPlanDetailView) reads the resolved `scopeAccountId` (aliased as `calendarAccountId` for legibility) via props. In All-clients mode, those views fall back to a "Pick a brand from the sidebar" empty state.

**Agency BrandSelectView is never shown.** The login-time picker is brand-only — agency members are auto-routed to All-clients mode on first sign-in regardless of how many memberships they have.

### Auto-create-brand guard

In `_doRefresh`, after auth: if a brand user has 0 memberships, auto-create
a default brand. **Skipped** when:
- User has a pending invite (`lr_pending_invite`)
- User just deleted their last brand (`lr_brand_just_deleted`)

This prevents both invite races and silent re-creation after deletion.

### LocalStorage / sessionStorage keys

| Key | Purpose | Set by | Cleared by |
|---|---|---|---|
| `lr_auth` | Cached auth profile for instant first paint | `_doRefresh` | sign-out |
| `lr_active_brand_<userId>` | Brand user's last-picked brand on this device | `setActiveBrand` | sign-out (per-user) |
| `lr_admin_active_brand` | Agency user's active brand id (or `'__all__'` sentinel) | `App.setActiveAdminBrandId`, driven by `<BrandPicker/>` | — (persists across sessions) |
| `lr_brand_just_deleted` | Forces picker on next login after deletion | `SettingsView.deleteWorkspace` | `setActiveBrand` |
| `lr_pending_invite` | Invite token to redeem on next sign-in | URL `?invite=…` query string | After redemption |
| `lr_pending_brand_name` | Brand name to use during auto-create | `signUpBrand` | After auto-create |
| `lr_mode` | `'admin'` or `'customer'` | `useEffect` mirror of `mode` state | — |
| `lr_calendar_view_mode` | Social Calendar view: `'month'`, `'week'`, or `'list'`. Defaults to `'month'`. | Month/Week/List segmented toggle in CalendarView controls bar | — |
| ~~`lr_calendar_density`~~ *(deprecated 2026-05-05)* | Was: month-view density (`'comfortable'`/`'compact'`). Removed in favour of the List view as a third primary mode. CalendarView no longer reads or writes this key; existing values in user localStorage sit harmlessly until the browser clears them. | — | — |
| `lr_calendar_status_filter` | Active status-group filter: `'all'`/`'drafting'`/`'needs_review'`/`'approved'`/`'posted'`. | Filter pills row in CalendarView | — |
| `lr_library_kind` | Library asset toggle: `'deliverable'` or `'reference'`. Defaults to `'deliverable'`. | Library Deliverables/References segmented control | — |
| `lr_copilot_conv_<userId>_<accountId>` | Persisted AI Co-pilot conversation per (user, brand). JSON array of messages, capped at last 60 entries. Survives panel close, page refresh, and brand-switch. | [CopilotPanel.jsx](web/src/components/CopilotPanel.jsx) — read on mount + brand-change, written on every messages update | "Start new" button in panel header clears the entry; sign-out doesn't (history per-brand persists across sign-out/in for the same user-id) |
| ~~`lr_route`~~ *(deprecated 2026-04-30)* | Was: last visited view, persisted across reloads. Replaced by the URL itself when Phase 1 router landed. One-time migration on first post-deploy load hops the user to the saved view, then drops the key. | Removed — App.jsx no longer writes it; existing values are migrated then deleted. | Migration block in App.jsx |
| ~~`lr_impersonation`~~ *(deprecated)* | Was: admin → client view shadow | Removed 2026-04-30 in the BrandPicker rollout. Old code that read this is gone. | — |

---

## 8. Routes / Views

URL-driven routing via `react-router-dom@6`. `<BrowserRouter>` wraps `<App/>` in [main.jsx](web/src/main.jsx); inside App we derive `route = {view, id}` from `location.pathname` (`parsePathToRoute` in [App.jsx](web/src/App.jsx)). Child components still call `setRoute({view, id})` — that's a thin adapter over `navigate(viewToPath(...))`. Sidebar renders different items per `mode`. View / path / component table:

| `route.view` | URL path | Component (customer mode) | Component (admin mode) | Purpose |
|---|---|---|---|---|
| `calendar` | `/` or `/calendar` | `CalendarView` | `CalendarView` | Social Calendar — month grid of post plans. Universal landing view (signed-in + guest). |
| `ideate` | `/ideate` (or `/c/:slug/ideate`) | `IdeateView` | `IdeateInboxView` | Brand: **Idea dump** composer + history of submitted ideas (sidebar label was "Got ideas?" until 2026-05-08). Agency-in-brand: **Inbox** queue of submitted ideas with edit + Add-to-Calendar. |
| `library` | `/library` | `LibraryView` | `LibraryView` | Searchable grid of deliverables, scoped to active brand. |
| `posts` | `/posts` (or `/c/:slug/posts`) | `LivePostsView` | `LivePostsView` | Live posts repository — every plan that's gone live, grouped by month, filterable by platform. Brand-scoped. |
| `performance` | `/performance` | `PerformanceView` | — | Metrics dashboard (placeholder) |
| `team` | `/team` | `TeamView` | `AdminClientsView` | Customer: invite teammates. Admin: client list |
| `members` | `/members` | — | `AdminTeamView` | Agency-only team management |
| `brand` | `/brand` | `BrandKitView` | `BrandKitView` | Brand Intelligence — full kit view + Fetch Brand. Receives `accountId` from App. |
| `notes` | `/c/:slug/notes` | — | `BrandNotesView` | **Agency-only** memory workspace for `brand_kit_notes`. Promoted from a card inside BrandKitView on 2026-05-12. Sidebar entry below "Trends Radar". RLS blocks brand users from SELECT/INSERT/UPDATE/DELETE (migration 0040). |
| `plan` + `id` | `/calendar/:shortId` (or `/c/:slug/calendar/:shortId`) | `PostPlanDetailView` | `PostPlanDetailView` | Per-plan detail nested under calendar — calendar is the parent surface, so the URL stays `…/calendar/:shortId` instead of switching to a sibling `/plan/`. `:shortId` follows the same first-8-hex-chars rule as tasks. |
| `clients` | `/clients` | — | `AdminClientsView` | Agency-only client list (reachable from BrandPicker). |
| `settings` | `/settings` | `SettingsView` | `SettingsView` | Workspace name, danger-zone delete |
| `profile` | `/profile` | `ProfileView` | `ProfileView` | User profile |
| `not_found` | *(any unrecognised path)* | `NotFoundView` | `NotFoundView` | Tasteful 404 — serif headline + bad path chip + "Take me to Social Calendar" CTA. ([NotFoundView.jsx](web/src/components/NotFoundView.jsx)) |

Unknown paths land on the 404 view (`view: 'not_found'`) — the bad pathname is preserved on the route object so `NotFoundView` can echo it back. `not_found` is in both the guest-allowed set and the agency context-snap legal sets, so neither effect bounces the user away. Vercel SPA fallback rewrites every path to `/index.html` ([web/vercel.json](web/vercel.json)) so deep links resolve on cold load.

**Phase 2 routing is live** as of the brand-slug-driven `setActiveBrand` work — agency users can deep-link `/c/:slug/calendar`, `/c/:slug/ideate`, etc., and the URL is the source of truth for active brand (`localStorage.lr_admin_active_brand` is the fallback for bare paths only).

### First-paint defaults

- **Everyone (signed-in + guest)**: `view: "calendar"` is the universal landing surface (Social Calendar). Returning users with a saved `lr_route` are restored to wherever they left off.
- **After onboarding completes**: `view: "brand"` (so the user sees enriched Brand Intelligence immediately).
- **After sign-in**: `view: "calendar"` is the default; if a `pendingAction` was stashed (e.g. unsubmitted brief), that action runs instead and owns its own navigation.

### Gates

- `auth?.requiresBrandSelection` → renders `BrandSelectView` instead of the app shell
- `onboarding.open` → renders `BrandOnboardingModal` over the app
- Guest accessing any non-`calendar` route → snapped back to `/calendar`

---

## 9. Key feature flows

### Submit an idea (brand-side)
`IdeateView` → title + details + optional date + multi-platform pills + paperclip-uploader → `createPostPlanIdea()` in db.js → INSERT into `post_plan_ideas` (status `submitted`). Each pending file is then uploaded via `addPostPlanIdeaAttachment` to `post-plan-attachments/<accountId>/ideas/<ideaId>/...`. The brand sees the idea immediately in the "Your recent ideas" list (status pill shows `Submitted`); the agency sees it land in their Inbox via realtime.

### Convert an idea to a post plan (agency-side)
1. Agency opens **Inbox** (`route.view = 'ideate'` for an agency user) → list filters default to `Queue` (`status='submitted'`).
2. Click an idea → detail panel on the right.
3. (Optional) Edit title / details / desired date / platforms → "Save changes" button appears when fields differ from the row → `updatePostPlanIdea`.
4. Click **Add to Social Calendar** → `ConvertIdeaModal` opens, pre-filled from the idea.
5. Submit → `convertIdeaToPostPlan` creates a `post_plans` row at 09:00 local on the chosen date with the idea's `title` as concept and `details` as the per-platform copy seed, then patches the idea row: `status='converted'`, `converted_post_plan_id=<plan.id>`, `converted_at=now()`.
6. Parent `IdeateInboxView` calls `navigateToPlan(plan.id)` → user lands on `PostPlanDetailView` for the new plan.
7. The idea drops out of the default `Queue` filter (status no longer `submitted`); still reachable under the `On calendar` filter and back-links to the plan via `converted_post_plan_id`.

### Mark a plan as posted (brand or agency)
1. Plan reaches `status='approved'` (brand approves from `Needs review`).
2. Either side opens the plan in `PostPlanDetailView` and clicks **Mark as posted** (top action bar) or the equivalent CTA inside the Live posts overview card. RLS allows both members and agency staff to write — either side often does the actual publishing depending on the engagement.
3. `MarkAsPostedModal` opens with one row per platform on `plan.platforms`. Each row has a checkbox ("posted on this platform") + an optional `https://` URL input. Pre-filled from any existing publication rows so the same modal also edits.
4. Submit → for each checked platform with changes, `upsertPostPlanPublication({ postPlanId, platform, liveUrl, publishedBy })` (uses `ON CONFLICT (post_plan_id, platform) DO UPDATE`). For each unchecked platform that *had* a publication row, `deletePostPlanPublication`.
5. `getDisplayStatus(plan, publications)` now returns `'posted'` for the plan; the status pill flips to violet on every surface — calendar chips, list rows, week cards, detail header, timeline sidebar.
6. The plan appears in the Live posts repository (`/c/:slug/posts`) within the next realtime tick — `LivePostsView` listens to `subscribeToAllPostPlanPublications` and refetches the brand-joined list on any event.
7. Calendar Posted filter pill increments by one; Approved pill decrements (the bucket excludes posted plans).

### Live Posts engagement (how it all fits together)
End-to-end flow for tracking engagement on a brand's live posts, shipped 2026-05-12 across PRs #78, #79, #80, #81, #82.

**Trigger:** an agency user marks a plan as posted with a `live_url` (the flow above). For IG / LinkedIn URLs, that fires a chain that ends with the post's embed card + metrics row rendering on `/c/:slug/posts` within ~10s, with no further user action.

**The chain:**
1. `MarkAsPostedModal` → `upsertPostPlanPublication` writes the publication row (existing flow).
2. `PostPlanDetailView.handleMarkPostedSubmit` then fires `refreshEngagement(publicationId)` for every IG / LinkedIn publication with a URL. Fire-and-forget — the modal close doesn't block on the ~7-10s Apify scrape. X publications are skipped (no actor wired, see §13).
3. **`POST /api/engagement/refresh`** ([web/api/engagement/refresh.ts](web/api/engagement/refresh.ts)) — JWT → `is_agency` (brand users 403) → loads publication → `dispatchScrape(platform, liveUrl)` from `scraper-lib.ts` → `apify/instagram-scraper` or `supreme_coder/linkedin-post` → normalizes the response → writes an append-only `post_engagement_snapshots` row + upserts the 1:1 `post_embed_cache` row.
4. `LivePostsView` realtime subscriptions on both tables pick up the writes; the tile re-renders with the embed card (author + caption + image) and the metrics row (likes / comments / shares / saves / views; `—` for fields the platform doesn't expose). Brand users see the data; only agency sees the "Refresh now" button.
5. Images route through **`/api/engagement/image-proxy`** ([web/api/engagement/image-proxy.ts](web/api/engagement/image-proxy.ts)) — Meta + LinkedIn CDNs both send `Cross-Origin-Resource-Policy: same-origin`, which blocks direct embedding. The proxy fetches server-side (CORP doesn't apply) and re-emits the bytes with permissive CORP. Host allowlist locked to `*.cdninstagram.com` / `*.fbcdn.net` / `*.licdn.com`.
6. **`/api/engagement/refresh-cron`** ([web/api/engagement/refresh-cron.ts](web/api/engagement/refresh-cron.ts)) fires once daily at 1am UTC (Vercel Hobby caps cron at once-per-day, see §13). Loads eligible publications, picks "due" set by tiered cadence (<14d → daily, <60d → 3d, else weekly; demoted to weekly after 3 consecutive failures), scrapes up to 5 due rows per fire via the same `scraper-lib.ts` helpers, writes through the same persistence path. Daily fires give us a multi-day curve which is what monthly reports need; sub-day cadence would require Pro.
7. Future monthly-report builder consumes **`loadEngagementForBrandRange(accountId, fromISO, toISO)`** ([web/src/lib/db.js](web/src/lib/db.js)) — returns one entry per publication with `firstSnapshot` / `lastSnapshot` / `snapshotCount` / per-metric `delta` / `note`. No UI yet; the data shape is frozen so when the report ships it doesn't need to refactor db.js.

**Platform coverage (as of 2026-05-12):**
- **Instagram** — `apify/instagram-scraper`, full embed + likes/comments/views. Validated against a real Bamboo Bear post.
- **LinkedIn** — `supreme_coder/linkedin-post` (cookie-free, `$0.001` per scrape), full embed + likes/comments/**shares** (LinkedIn tiles end up more informative than IG since IG doesn't expose share count via Apify). Validated against a real public post.
- **X** — intentionally not tracked. Apify shootout found no viable actor; official X API at \$200/mo not worth the spend for one platform's stats in MVP. Tiles render the post URL with a permanent "X engagement not tracked" badge. Trivially reversible later.

**Auth model:**
- Reads (snapshots + embed cache): agency OR account-members-of-the-parent-plan. Both can see the data.
- Writes: service-role only via the two API routes. **No client INSERT/UPDATE/DELETE policies** on either table — brand users can't trigger Apify scrapes (cost protection).
- "Refresh now" button: agency-only at the route layer (403s brand users). When/if brand-side refresh ships later, the gate becomes a rate-limit + daily quota at the same layer, still not RLS.

**Cost model:**
- IG: \~\$0.0023 per scrape (apify/instagram-scraper)
- LinkedIn: \~\$0.001 per scrape (supreme_coder/linkedin-post)
- X: \$0 (not scraped)
- Bamboo Bear MVP (\~30 posts × \~30 scrapes/month) → **\~\$0.50/month**. 10-brand rollout (\~100 posts each) → **\~\$15/month**. Comfortably inside Apify free-tier credits.

**Files added (full list):**
- Migration `supabase/migrations/0041_post_engagement.sql`
- Routes: `web/api/engagement/refresh.ts`, `refresh-cron.ts`, `image-proxy.ts`
- Shared: `web/api/engagement/scraper-lib.ts`
- UI: `web/src/components/LivePostEmbed.jsx`; tile changes in `LivePostsView.jsx`; trigger in `PostPlanDetailView.jsx`; helpers in `web/src/lib/db.js`
- Scripts: `scripts/scrape-engagement-dry-run.mjs`, `scrape-engagement-actor-preflight.mjs`, `inspect-linkedin-actor.mjs`

### Brand onboarding (first-time brand owner)
1. `_doRefresh` resolves a brand-owner profile
2. App.jsx checks `loadBrandOnboardingStatus`; if `onboarding_completed_at` is null → opens `BrandOnboardingModal`
3. Modal shows: Name → Website → **Auto-fill banner** → Socials → Tagline → Audience → Voice → Logo
4. "Fetch brand" button → `triggerBrandKitEnrichment` → fields auto-populate
5. Save → `completeBrandOnboarding` → `setRoute({view: "brand"})` lands user in Brand Intelligence
6. Skip → `skipBrandOnboarding` → still flips the completion marker so the modal doesn't reappear

### Brand enrichment (Fetch Brand button)
1. Click → `handleReenrich` in `BrandKitView`
2. If `kit.websiteUrl` is missing → `window.prompt()` for URL → save via `updateBrandKit`
3. Call `triggerBrandKitEnrichment({accountId, websiteUrl})` which POSTs to the edge function
4. Edge function: `callFirecrawl(url)` with `proxy: "auto"`, `waitFor: 2500`
5. **Bot-wall guard** (`assertNotBotWall`) — throws on titles like "Something went wrong" / "Just a moment…" → existing failure path sets `enrichment_status = 'failed'` without overwriting real fields
6. Otherwise: `buildKitUpdate(fcResponse, sourceUrl)` extracts colors/fonts/tagline/etc. → write to `brand_kits` → `enrichment_status = 'success'`
7. Client re-fetches the kit

### Delete a brand workspace
1. SettingsView → Danger Zone → Delete… → confirmation modal (must type workspace name)
2. `deleteWorkspace` → `delete_brand_account(account.id)` RPC (owner-check + brand-type guard)
3. Cascade FKs wipe tasks/assets/messages/activity/brand_kits/invitations/account_members
4. Set `localStorage.lr_brand_just_deleted = '1'` → sign out → `window.location.reload()`
5. Next sign-in: auto-create-brand skipped, `requiresBrandSelection = true` regardless of remaining count → user lands in `BrandSelectView` with "Create your next brand" CTA

### Library scoping
`LibraryView` calls `loadLibraryAssets({kind: 'deliverable'})` (RLS pre-filters to user-accessible tasks), then client-side filters by `auth.account.id` for non-agency users. Mirrors the tasks-scoping pattern in App.jsx.

### Activity logging
All activity rows are written by SECURITY DEFINER triggers (RLS allows SELECT only). The `log_task_activity` trigger fires on INSERT/UPDATE of `tasks` and emits `created`, `status_changed`, `assigned`, and (since migration 0019) `field_edited` for chip changes. `log_message_activity` and `log_asset_activity` cover their respective tables.

### Schedule a call
HomeView "Schedule a call" button → external link to `https://cal.linkrunner.io/team/demos/lragency`, opens in new tab.

### Brand scope switching (BrandPicker)
1. Sidebar `<BrandPicker/>` is mounted under the L+R wordmark whenever the user is signed in.
2. **Brand owners** see their brand memberships + "Create new brand". Selecting a brand calls `auth.setActiveBrand(accountId)` (the existing brand-side flow).
3. **Agency users** see "All clients" sentinel + every brand account + "Add a client" + "Manage clients". Selecting a brand calls `App.setActiveAdminBrandId(id)`, which writes to `localStorage.lr_admin_active_brand` and updates `App.activeAdminBrandId` state.
4. The `App.scopeAccountId` derivation feeds every per-brand surface as `calendarAccountId` (or `accountId` to BrandKitView). When the agency picker is on All-clients, the value is `null` and the surfaces fall back to "Pick a brand from the sidebar" empty states.
5. The agency `Sidebar` swaps its nav based on `isAllClientsMode`: cross-client surfaces (Inbox, All tasks) when on All clients, per-brand surfaces (Calendar, Tasks, Library, Brand Intelligence, Performance, Brand team, L+R Team) when in a specific brand. (Brand owners see the same secondary entry labelled simply "Team" — agency-in-brand keeps "Brand team" to disambiguate from the agency's own L+R Team.)

### Create + edit a post plan
1. **Agency only.** From `CalendarView`, click an empty day cell or "New post plan" → `createStubAndOpen` → `createPostPlan` writes a stub row (status `not_started`, no copy, no platforms) → `setRoute({view: 'plan', id})` opens `PostPlanDetailView`.
2. The stub also lands in `App.postPlans` immediately via `onPlanCreated`/`upsertPostPlan` so the chip shows up on the calendar without waiting for realtime.
3. In `PostPlanDetailView`: title is click-to-edit (pencil icon, Enter saves, Escape cancels). Schedule is a `<input type="datetime-local">` with on-blur persist (raw string draft state — typing through day → month → year → time doesn't lose focus).
4. Toggle platforms (IG / LinkedIn / X) → per-platform copy variants surface as a row of pill tabs; active platform is the filled pill. Copy text saves on blur.
5. Status workflow: agency clicks **Submit for review** → `needs_brand_feedback`. Brand clicks **Approve** (`approved`) or **Request changes** (`needs_admin_revision`, requires a comment). Agency can also flip to `delayed` or `posted` directly. Every transition calls `persist({status})` → `updatePostPlan` → trigger writes to `post_plan_status_log` → triggers also stamp `approved_at` / `posted_at` on first transition into those states.
6. Conversation tab: `addPostPlanComment`. Inserts subscribe via `subscribeToPostPlanComments` for the open plan.
7. Activity tab: synthesized feed showing creation, comments, attachments uploaded, and every status transition. Sorted newest-first.

### Post plan attachments (References + Deliverables)
- **References** card: brand-only upload. Shows the inspiration files the brand has shared. Both sides view, only brand uploads.
- **Deliverables** card: agency-only upload. Final creatives. Both sides view, only agency uploads.
- Storage: `post-plan-attachments` bucket, path `<accountId>/<postPlanId>/<ts>_<filename>`. Storage RLS extracts the leading account id via the `post_plan_attachment_account_id(name)` SQL helper.
- Upload flow: `addPostPlanAttachment({postPlanId, accountId, kind, file, uploadedBy})` uploads to storage, then inserts the metadata row. If the row insert fails, the storage object is deleted to avoid orphaning.
- Delete: storage first, then row (best-effort on storage so a stale orphan never blocks a row delete).

### Unread activity tracking
1. Every post-plan touchpoint (open, edit, comment, upload, status flip) writes `post_plan_views(user_id, post_plan_id, last_seen_at = now())` via `markPostPlanSeen`. Idempotent upsert on the composite PK.
2. `loadPostPlanUnreadCounts({userId, postPlans})` returns `Map<postPlanId, count>` by counting:
   - Comments authored by **others** with `created_at > last_seen_at`
   - Attachments uploaded by **others** with `created_at > last_seen_at`
   - Plan-level edits (`post_plans.updated_at > last_seen_at`)
3. App.jsx subscribes to all three tables (`subscribeToPostPlanActivity`) — any new event triggers a refresh of the unread map.
4. Same-tab edits update `App.unreadByPlan` directly via the `clearUnreadForPlan` callback (passed through to `PostPlanDetailView` as `onPlanSeen`) — no realtime roundtrip needed for the dot to clear when the viewer opens or edits a plan.
5. Calendar chips show a red `<span>` dot at the right edge when the count is positive. Sidebar nav item shows a `badge-count` equal to the **number of plans with any unread activity** (`unreadByPlan.size` in App.jsx) — i.e. it matches the count of red dots on the calendar, not the total event count across them.

### Replicating live data in another env

The post-plan tables and bucket are migration-driven (0021–0023). On a fresh project: `supabase db push` applies them in order, then the bucket and storage RLS land via 0022. No manual seed.

---

## 10. Edge functions & integrations

### `enrich-brand-kit`

Single edge function, three modes (controlled by `body.mode`):

| Mode | Purpose | Status |
|---|---|---|
| `enrich` (default) | Single-URL website enrichment for the current Brand Kit flow | **Live** — used by `triggerBrandKitEnrichment` |
| `discover` | Multi-source URL discovery (find socials from a seed URL) | Deployed but not yet wired to client UI |
| `check_agent` | Poll a Firecrawl Agent run | Deployed but not yet wired to client UI |

#### Firecrawl call shape (`callFirecrawl`)

```js
POST https://api.firecrawl.dev/v2/scrape
{
  url,
  formats: ["branding", "markdown", {type:"json", schema, prompt}],
  onlyMainContent: false,
  proxy: "auto",      // tries basic, falls back to stealth on bot wall
  waitFor: 2500       // lets JS-rendered Shopify/Webflow settle
}
```

#### Bot-wall protection

After every scrape, `assertNotBotWall()` checks the page title against:
`/^something went wrong$/i`, `/^just a moment/i`,
`/attention required.*cloudflare/i`, `/^access denied/i`,
`/verify you are human/i`, `/checking your browser/i`,
`/please enable javascript/i`. Match → throw → existing failure path runs.

#### Deploying the edge function

```sh
SUPABASE_ACCESS_TOKEN=<PAT> \
  supabase functions deploy enrich-brand-kit \
  --project-ref vmfwnfflhvskadkfnvds
```

### `engagement-refresh`

Daily cron orchestrator that refreshes engagement snapshots for every IG / LinkedIn / X publication with a `live_url`. Replaces the old Vercel cron route `/api/engagement/refresh-cron` (deleted 2026-05-15).

**Why this lives on Supabase, not Vercel.** Vercel Hobby caps cron jobs at once-per-day and serverless function timeouts at 60s. With ~10s per scrape that ceilings us at 5 publications/day, which doesn't scale past the first brand. Supabase Edge Functions get a 400s wall-clock budget on Pro, are co-located with Postgres (no inter-cloud DB hop), and pg_cron can fire as often as every minute. Same code shape, ~16× the throughput per fire.

**Trigger:** a pg_cron job inside Postgres calls this function via `pg_net.http_post()`. The schedule is registered by migration `0045_engagement_refresh_cron.sql`:

```
jobname:  engagement-refresh-daily
schedule: 30 0 * * *           — daily at 00:30 UTC = 6:00 AM IST
url:      <vault: engagement_project_url>/functions/v1/engagement-refresh
auth:     Bearer <vault: engagement_cron_secret>
timeout:  390000ms             — just under the function's 400s ceiling
```

To re-cadence (e.g. hourly when scale demands): `SELECT cron.unschedule('engagement-refresh-daily'); SELECT cron.schedule('engagement-refresh-daily', '0 * * * *', $cron$ ... $cron$);` — SQL only, no code change, no redeploy.

**Algorithm** (identical tiering to the old Vercel route; see [supabase/functions/engagement-refresh/index.ts](supabase/functions/engagement-refresh/index.ts) for the source):

1. Load publications where `platform IN ('instagram','linkedin','x')` and `live_url IS NOT NULL`.
2. Load the latest snapshot per publication + the last-3 status streak.
3. Tier each publication by time-since-publication: <14 days → daily, 15-60 days → every 3 days, 60+ days → weekly. Auto-demote to weekly if the last 3 attempts all failed/blocked (stops burning Apify credit on a permanently-broken URL).
4. Sort by oldest-snapshot-first (never-scraped go to the top).
5. Take the top **20** (was 5 on Vercel). Scrape in chunks of **3** with `Promise.allSettled`. Persist each into `post_engagement_snapshots` + upsert `post_embed_cache`.

**Auth:** `Authorization: Bearer <CRON_SECRET>`. The function reads `Deno.env.get("CRON_SECRET")` and does a literal string compare. Same pattern as `send-email`'s daily-digest path. The pg_cron job pulls the value from `vault.decrypted_secrets` so the cron statement doesn't hardcode it.

**Observability:**
- Every run inserts one row into `public.cron_run_log` (success or fail) with `started_at`, `finished_at`, `duration_ms`, `status`, `pubs_eligible`, `pubs_due`, `pubs_processed`, `pubs_failed`, `pubs_blocked`, `error_message`, and a `details` jsonb of per-publication outcomes. Single SELECT answers "did the cron run today and what did it do?":
  ```sql
  select * from cron_run_log where function_name = 'engagement-refresh' order by started_at desc limit 5;
  ```
- pg_net's `net._http_response` table holds the raw HTTP response from the cron-side call.
- Email alerts on failure are deferred. When we want them, add an `engagement-cron-alert` template to `send-email` and call it from this function on `runError || failed > 0 || blocked > 0`.

**Env vars** (set with `supabase secrets set ...` or via Dashboard → Edge Functions → Secrets):

| Var | Required | Source |
|---|---|---|
| `CRON_SECRET` | yes | Same opaque string as Vercel's `CRON_SECRET` (so a future re-merge of the cron back onto Vercel doesn't change the auth path) |
| `APIFY_API_TOKEN` | yes | `apify_api_...` |
| `SUPABASE_URL` | auto | Injected by platform |
| `SUPABASE_SERVICE_ROLE_KEY` | auto | Injected by platform |

**Manually trigger a run** (useful right after deploy or for spot-debug):
```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_project_url')
         || '/functions/v1/engagement-refresh',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'engagement_cron_secret')
  ),
  body := '{}'::jsonb
);
```

**Note about `web/api/engagement/refresh.ts`** — the on-paste auto-refresh route is **unchanged**. That route is user-triggered (fired from `PostPlanDetailView` on mark-posted), Vercel-hosted, and shares `scraper-lib.ts` with no other consumer now that the cron route is gone. Both code paths use the same Apify actors and the same `persistScrapeResult` shape, so a snapshot inserted by either looks identical.

#### Deploying the edge function

```sh
SUPABASE_ACCESS_TOKEN=<PAT> \
  supabase functions deploy engagement-refresh \
  --project-ref vmfwnfflhvskadkfnvds
```

If the local PAT 403's on `/functions/deploy` (legacy issue from 2026-04-27, may still bite), the alternative is paste-into-Dashboard at Project Settings → Edge Functions → New Function. The function code is self-contained — no external imports beyond `@supabase/supabase-js` and the shared `_shared/cors.ts`.

### `send-email`

Transactional email via Resend. Single function, dispatches by `template`
in the request body.

| Template | Purpose | Status |
|---|---|---|
| `team-invite` | Sends a teammate-invite email when a row is created in `invitations`. Subject: "X invited you to {workspace} on Linkrunner Media". Includes accept-invite CTA + the same `?invite=<token>` URL the Copy-link button writes. | **Live** — used by both [TeamView.jsx](web/src/components/TeamView.jsx) (brand teammates) and [admin.jsx](web/src/components/admin.jsx) (agency staff). |
| `agency-update` | Agency-only batch update email. Caller posts `{accountId, message, subject?}`; the function fans out one email per member of the brand workspace via Resend (one call per recipient — members don't see each other's addresses). Subject defaults to "Update on {brand} from Linkrunner Media" if not overridden. Authz: caller must have `profiles.is_agency = true`. Recipients sourced from the existing `account_members_with_email` RPC. | **Live** — triggered from the "Send update" button in agency-mode [CalendarView](web/src/components/CalendarView.jsx) header, opens [UpdateBrandModal](web/src/components/UpdateBrandModal.jsx). |

#### Auth

- `verify_jwt = true` (per [config.toml](supabase/config.toml)) — caller's JWT is verified by the platform.
- The function uses a **JWT-scoped client** to read the target invitation through RLS, so the caller can only mail invites for accounts they belong to.
- The function uses the **service-role client** to read the inviter's `profiles` row (display name) without depending on profiles SELECT policies.
- The Resend API call itself is server-side only (`RESEND_API_KEY` never reaches the browser).

#### Request shape

```js
POST /functions/v1/send-email
Authorization: Bearer <user JWT>
{
  "template": "team-invite",
  "invitationId": "<uuid of the invitations row>"
}
// → 200 { ok: true, id: "<resend message id>" }
// → 4xx/5xx { error: "..." }
```

#### Reply-to behavior

`From` is always `EMAIL_FROM` (default `agency@linkrunner.io`); `Reply-To`
is set to the inviter's own email address so replies thread back to whoever
created the invite, not to the shared `agency@` mailbox. Failure to send
does **not** rollback the invitation row — the client treats email send as
best-effort and falls back to the Copy-link UI.

#### Environment variables

| Name | Required | Default | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | yes | — | `re_…` from resend.com/api-keys |
| `EMAIL_FROM` | yes | — | `agency@linkrunner.io` (must be a verified domain on Resend) |
| `EMAIL_FROM_NAME` | no | `Linkrunner Media` | Display name in `From` header |
| `APP_URL` | no | `https://agency.linkrunner.io` | Base for the invite link |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` | yes | auto-injected | Set by Supabase platform |

#### Deploying the edge function

```sh
SUPABASE_ACCESS_TOKEN=<PAT> \
  supabase secrets set \
    RESEND_API_KEY=re_... \
    EMAIL_FROM=agency@linkrunner.io \
    EMAIL_FROM_NAME="Linkrunner Media" \
    APP_URL=https://agency.linkrunner.io \
  --project-ref vmfwnfflhvskadkfnvds

SUPABASE_ACCESS_TOKEN=<PAT> \
  supabase functions deploy send-email \
  --project-ref vmfwnfflhvskadkfnvds
```

### `signup-for-invite`

Creates an auth user with `email_confirm = true` for invited teammates,
bypassing Supabase's standard "click the link in your inbox" confirmation
step. The invitation row itself is the proof of email ownership.

#### Auth

- `verify_jwt = false` — caller is the invitee, who doesn't have a session yet.
- The invitation token is the credential; we only proceed when the row is unaccepted, unexpired, and findable by token.
- The email used for `createUser` is read from the invitation row server-side, never from the request body. So a typo or substitution attempt in the client can't create an auth user under a different address than the invite.

#### Request shape

```js
POST /functions/v1/signup-for-invite
// (no Authorization header — anon-callable)
{
  "token": "<invitation token from URL or localStorage>",
  "password": "<at least 6 chars>",
  "displayName": "<optional name for user_metadata.display_name>"
}
// → 200 { ok: true, userId, email }
// → 409 { error: "...exists...", code: "user_exists" }   // pivot to sign-in
// → 404 { error: "Invitation not found" }
// → 410 { error: "Invitation expired" } | { error: "Invitation already accepted" }
```

#### Client integration

`signUpForInvite()` in [auth.js](web/src/lib/auth.js) reads the token from `localStorage.lr_pending_invite`, calls this function, then `signInWithPassword()` to establish the session. The existing pending-invite useEffect in App.jsx redeems the token and lands the user on the workspace. Net UX: invitee enters name + password, hits Create, lands directly in the workspace — no second email.

[LoginModal.jsx](web/src/components/LoginModal.jsx) catches the `user_exists` error code and pivots the modal to sign-in mode with a friendly message instead of surfacing a raw error.

### `/api/fetch-trends` (Vercel serverless route)

External-trend scraper that writes into `trend_signals`. **Lives on Vercel, not Supabase Edge Functions** — see the Recent Changes log entry from 2026-05-02 for the rationale (the Supabase multipart deploy endpoint started 403'ing for our PAT despite Owner role + MFA + full-scope tokens, and the Vercel route co-deploys with the SPA on every push to main with zero friction).

Source code: [web/api/fetch-trends.ts](web/api/fetch-trends.ts). Runtime: default Node (no `export const config` block — `runtime: "nodejs20.x"` literal silently failed Vercel's bundler).

| Source | Purpose | Status |
|---|---|---|
| `tiktok` | TikTok Creative Center hashtags + sounds (Firecrawl only — no extra API key) | **Live** in Phase 1. Default regions: US, IN, GB, CA, AU. |
| `twitter` | Apify Twitter Trends Scraper (`apify.com/automation-lab/twitter-trends-scraper`). Single multi-region call returns trending topics + hashtags + tweet volumes. | **Live** in Phase 2. Default regions: US, IN, GB, CA, AU (GB → UK at the API boundary). |
| `instagram` | Apify Instagram Hashtag Scraper (`apify/instagram-hashtag-scraper`). Per-brand: reads `brand_kits.trend_hashtags` for the requested `accountId`, scrapes recent top posts for each hashtag. | **Live** in Phase 3. `accountId` required in request body. Posts stored with `account_id` set so RLS exposes them only to that brand + agency. |
| `linkedin` *(maybe)* | Taplio scrape or partnership data — ToS-sensitive | Not committed. |

#### Auth

- Caller MUST send `Authorization: Bearer <user JWT>`. The handler verifies it server-side via `supabase.auth.getUser()` (anon-key client, the user's JWT scoped in).
- The handler additionally reads `profiles.is_agency` for the caller via the service-role client and **403s if false** — feature is fully agency-only at the API surface, in addition to the table's RLS gate.
- Writes use the service-role client (the table's RLS denies authenticated INSERT).

#### Request shape

```js
POST /api/fetch-trends
Authorization: Bearer <user JWT>            // from supabase.auth.getSession()
Content-Type: application/json
{
  "source": "tiktok",
  "regions": ["US", "IN"],   // optional; defaults to ["US","IN","GB","CA","AU"]
  "window":  "7d"            // optional; "7d" | "30d", defaults to "7d"
}
// → 200 { ok: true, source, window, regions, written, summaries: [...] }
// → 4xx/5xx { error }
```

Client wrapper: `refreshTrends({source, regions, window})` in [db.js](web/src/lib/db.js).

#### Firecrawl call shape (per region, per kind)

```js
POST https://api.firecrawl.dev/v2/scrape
{
  url: "https://ads.tiktok.com/business/creativecenter/inspiration/popular/{hashtag|music}/pc/en?countryCode=XX&period={7|30}",
  formats: [{ type: "json", schema: TIKTOK_TREND_SCHEMA, prompt: "..." }],
  onlyMainContent: true,
  waitFor: 3500,
  proxy: "auto"
}
```

The schema captures `{ trends: [{ rank, title, subtitle, url, thumbnail_url, metric_value, metric_label }] }` regardless of whether we're on the hashtag or music page; the handler tags `kind = 'hashtag' | 'sound'` based on which URL it hit. Hashtag titles are normalised (strip leading `#`, lowercase) before upsert.

#### Upsert / dedupe

`upsertTrends` upserts into `trend_signals` using the unique index `(platform, kind, region, title, trend_window, account_id)`. Re-runs refresh `captured_at` and push `expires_at` forward by 14 days, so a daily cron extends row lifetime instead of churning IDs.

#### Vercel routing

`web/vercel.json` keeps the standard SPA fallback `/(.*)` → `/index.html`. Vercel processes `/api/*` against serverless functions in `web/api/` *before* applying any rewrite, so the rewrite doesn't need to exclude `/api/`. Don't try to "defensively" exclude with a negative lookahead — Vercel's path-to-regexp parser handles those inconsistently in `source` patterns and it'll break ALL SPA routes.

#### Environment variables (set on the `lr-studio-dashboard-3kkp` Vercel project, all 3 environment toggles ticked)

| Name | Required for | Where to get it |
|---|---|---|
| `VITE_SUPABASE_URL` | SPA build | `https://vmfwnfflhvskadkfnvds.supabase.co` — already there for the SPA. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | SPA build | Same publishable key already there for the SPA. |
| `FIRECRAWL_API_KEY` | `tiktok` source | Same `fc-…` key already in use by the `enrich-brand-kit` Supabase function — copy from Supabase project secrets, or grab a fresh key from https://www.firecrawl.dev/app/api-keys. |
| `APIFY_API_TOKEN` | `twitter` + `instagram` sources | Apify console → https://console.apify.com/settings/integrations. Free tier ($5 starter credit) is enough for Phase 2 + 3 testing. |
| `SUPABASE_URL` | every API route call | Same value as `VITE_SUPABASE_URL`. The non-`VITE_` version is what the API route reads at runtime (Vercel only injects non-`VITE_` env vars into Node serverless functions). |
| `SUPABASE_ANON_KEY` | every API route call | Same publishable key as `VITE_SUPABASE_PUBLISHABLE_KEY`, mirrored under a non-`VITE_` name for the API route. |
| `SUPABASE_SERVICE_ROLE_KEY` | every API route call | Supabase Dashboard → Project Settings → API → "service_role" key (`sb_secret_...`). **Server-side only — never `VITE_` prefixed, never exposed to the client bundle.** |

#### Deploying

No CLI / no manual step. Push to the branch, Vercel preview deploys; merge to main, prod deploys. The route is bundled and served alongside the SPA.

No `supabase secrets set` step needed — Supabase secrets don't apply to Vercel routes; everything lives in Vercel env vars.

### `/api/ai/chat` (Vercel serverless route — AI Co-pilot)

Agency-side AI Co-pilot chat backend. Streams Claude responses over Server-Sent Events to [CopilotPanel.jsx](web/src/components/CopilotPanel.jsx), runs tool calls server-side, and writes AI-drafted post plans to the DB via service-role. Source: [web/api/ai/chat.ts](web/api/ai/chat.ts).

#### Auth & gating

- **JWT verification**: caller MUST send `Authorization: Bearer <user JWT>`. The handler verifies it via the anon-key Supabase client (`supabase.auth.getUser()`).
- **Agency-only**: handler reads `profiles.is_agency` for the caller via service-role; 403s if false. Brand users are explicitly locked out at the API surface — Brand Co-pilot is a later phase.
- **Brand allowlist**: the request's `accountId` MUST be in the `AI_COPILOT_BRAND_IDS` env-var list (comma-separated UUIDs). This is the rollout gate. Expand the list as we widen the test set; today only Bamboo Bear should be on it.

#### Tools

- **`create_post_plan_draft({scheduled_at, platforms, concept, copy_variants})`** *(PR 2)* — inserts a row into `post_plans` with `status='drafting'`, `ai_generated=true`, `ai_draft_payload=<original args>`. Writes via service-role since the agency-staff + brand-allowlist gates above are the real boundary. Returns `{id, scheduled_at, platforms, concept, status}` for the panel to render an "Open plan →" CTA.
- **`write_brand_note({body, is_pinned?})`** *(PR 6)* — inserts a row into `brand_kit_notes` with `created_by = user.id`. Body capped at 1000 chars server-side. Triggered when the admin tells the chat to remember something ("remember that…", "from now on…", "make a note that…"). The note flows into the brand-context blob on every future AI call (chat + inline copy) via the existing `brandContext.js` compiler. Pin always-true facts (founder name, voice constraints, perma-instructions); leave non-pinned for time-bound context (campaign-specific notes that decay out of the 20-most-recent window over time). Returns `{id, body, is_pinned, created_at}` for the tool-card to render.

Future tools: `update_post_plan` (revise an existing plan based on the admin's instruction), `list_recent_post_plans` (read-only context lookup so the model can answer "what's scheduled this week?"), `suggest_calendar_blocks` (proactive gap-filler).

#### Streaming protocol (SSE)

The handler emits these event types over `text/event-stream`. Each event is `event: <type>\ndata: <json>\n\n`. The client uses a manual SSE parser (`parseSse` in [CopilotPanel.jsx](web/src/components/CopilotPanel.jsx)) rather than `EventSource`, because EventSource doesn't support POST bodies or auth headers.

| Event | Payload | Purpose |
|---|---|---|
| `text` | `{ delta }` | Token-by-token model output. The panel appends to the current assistant message. |
| `tool_call` | `{ id, name, input }` | Model called a tool. Renders an in-flight tool card. |
| `tool_result` | `{ id, name, ok, result?, error? }` | Tool finished. Updates the card status. |
| `usage` | `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` | Per-turn usage. Drives the footer token meter. |
| `done` | `{ stop_reason }` | Model finished this turn / loop. |
| `error` | `{ error }` | Server-side error during streaming. |

#### Prompt caching

The system prompt is split into two cached blocks with `cache_control: { type: 'ephemeral' }`:
1. The static instruction prefix (rarely changes — system-prompt edits only).
2. The brand-context blob from `compileBrandContext({ includeCalendar: true })`. Changes when:
   - the brand kit / notes / past approved plans mutate (existing)
   - a new draft is created mid-conversation (because `## Upcoming calendar` rebuilds)
   - a post gets marked posted or new engagement snapshots land (because `## Cadence`, `## Top performers`, `## Voice anchors` rebuild)
   - the date rolls over at midnight brand-local (because `## Today` rebuilds — one cache miss per day, expected)

   The chat route opts INTO the calendar block via `loadAndCompileBrandContext(client, id, { includeCalendar: true })`. The other AI routes (`/api/ai/copy`, `/api/ai/image`, `/api/ai/suggestions`) leave it off — they get the cheap base context (kit + notes + past approved plans only). Inline routes share the SAME prompt-cache pool as chat for the kit/notes blocks, so cache reads land across routes within the 5-min TTL.

Anthropic's cache TTL is 5 minutes; back-to-back chat turns for the same brand re-hit the cache and pay ~10% input-token rate. The `usage` SSE event surfaces cache reads/writes in the panel footer so the agency can see this landing in real time.

#### Model & limits

- Default: `claude-sonnet-4-6` (hard-coded; switch via env var if we need to A/B later).
- `max_tokens: 1500` per turn — aggressive cap, prevents the model from rambling.
- `MAX_TURNS = 8` cap on the agentic tool-use loop. If the model wants more, we emit `stop_reason: 'max_turns_reached'` and stop.

#### Request shape

```js
POST /api/ai/chat
Authorization: Bearer <user JWT>            // from supabase.auth.getSession()
Content-Type: application/json
Accept: text/event-stream
{
  "accountId": "<brand uuid>",
  "messages": [
    { "role": "user", "content": "Draft an Instagram post about ..." },
    // assistant + user turns accumulate as the chat grows
  ]
}
// → 200 text/event-stream (see events table above)
// → 4xx/5xx { error }
```

#### Environment variables (set on `lr-studio-dashboard-3kkp` Vercel project, all 3 environment toggles)

| Name | Required for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | every call | https://console.anthropic.com/settings/keys — `sk-ant-...`. Server-only, never `VITE_`-prefixed. |
| `AI_COPILOT_BRAND_IDS` | every call | Comma-separated list of brand UUIDs that get to use the Co-pilot. Run `select id, name from accounts where type='brand';` in Supabase to find the UUID for your target brand. Empty = nobody can use it. |
| `VITE_AI_COPILOT_BRAND_IDS` | SPA build | Same value as above. Exposed to the SPA so the topbar "✨ Co-pilot" button renders only for whitelisted brands. The server is the real authz; this is just for the conditional render. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | every call | Already set for `/api/fetch-trends` and `/api/daily-digest`. No change. |

#### Deploying

Same as the other Vercel routes: push to branch → preview deploy auto-builds; merge to main → prod deploys. No `supabase secrets set` step. New env vars must be added in Vercel Project Settings before the route works.

### `/api/ai/copy` (Vercel serverless route — inline copy generation)

Single-shot text generator for the per-platform "✨ AI draft" button in [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx). Streams a brand-voice caption suggestion as raw `text/plain` chunks (AI SDK text-stream protocol); the client renders it in an inline preview block ([AICopyPreview.jsx](web/src/components/AICopyPreview.jsx)) and the user accepts / regenerates / discards. The server never writes to `post_plans.copy_variants` — the existing client-side persist flow owns DB writes.

#### Auth & gating

Identical to `/api/ai/chat`: JWT verification → `profiles.is_agency` check → `AI_COPILOT_BRAND_IDS` allowlist check on the request's `accountId`. Same env vars; no new secrets needed (reuses `ANTHROPIC_API_KEY` + `AI_COPILOT_BRAND_IDS` from PR 2).

#### Request shape

`useCompletion` always sends the admin's instruction as `prompt` (the first arg to `complete()`); everything else flows in the per-call body override.

```js
POST /api/ai/copy
Authorization: Bearer <user JWT>
Content-Type: application/json
{
  "prompt": "<free-form direction>",        // useCompletion's primary field — the admin's instruction. Optional but strongly used; primary signal for WHAT to write.
  "accountId": "<brand uuid>",
  "plan_id": "<post_plans.id>",
  "platform": "instagram" | "linkedin" | "x",
  "mode": "draft" | "improve",              // default 'draft'
  "current_copy": "<existing caption>"      // required for mode='improve'; the starting point the model preserves and only changes per the instruction
}
// → 200 text/plain; charset=utf-8 — AI SDK text-stream protocol via pipeTextStreamToResponse. Each text delta is a separate chunk; client's useCompletion accumulates into a single string.
// → 4xx/5xx { error }   (JSON body for errors, before the stream starts)
```

**Pre-Phase-2b (history)**: the body field was `instruction` (not `prompt`) and the response was `text/event-stream` with custom SSE events (`text` / `usage` / `done` / `error`). All retired with Phase 2b.

#### Observability

No client-side usage meter (useCompletion's text protocol doesn't surface usage). Server logs every call:
```
[copy] usage account=<uuid> plan=<uuid> platform=instagram mode=draft input=… cache_read=… cache_write=… output=… finish=stop
```
Grep `[copy] usage` in Vercel Function Logs to monitor cache hit rate. If `cache_read=0` consistently across consecutive calls within 5 min for the same brand, the cache is broken — investigate per the breakage checklist in [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md).

#### Modes

- **`draft`**: generate a fresh caption. The admin's `instruction` (e.g. "a Mother's Day post celebrating moms who run small businesses") is the primary direction; the plan's stored `concept` is fallback context. Empty instruction is allowed — the model falls back to concept + brand voice.
- **`improve`**: revise the provided `current_copy` based on the admin's `instruction` (e.g. "make the hook punchier", "add a CTA at the end"). The model's system prompt explicitly says to **preserve what works and change only what the instruction asks** — no scratch rewrites, no unrequested changes. Empty instruction triggers a conservative polish (tighten weak phrasing, fix awkward rhythm, lean further into the brand voice).

`current_copy` for `improve` mode is the **in-flight client draft** (whatever's in the textarea, including unsaved edits), not the saved server-side value. This matches the admin's intent: "improve what I have RIGHT NOW," not "improve what was last saved."

Deferred / dropped from earlier roadmap:
- **`variants` mode** (3 side-by-side A/B angles): moved to long-tail backlog. The instruction-driven loop covers iteration ("regenerate with a different instruction") natively.
- **Generic Improve dropdown** ("Shorter" / "More playful" / "Remove emojis"): dropped permanently — the free-form instruction textarea covers everything presets would have, plus the long tail.

#### Why a separate endpoint from `/api/ai/chat` and not just another tool

`/api/ai/chat` runs an agentic tool-use loop — the model can call multiple tools, receive results, and iterate. That's the right shape for "plan a week" but overkill for "write me one caption." Three concrete reasons we split:

1. **Latency**: no tool-use loop overhead. The user clicks "AI draft" and tokens start streaming directly. No first-turn "I'll call a tool" preamble.
2. **System prompt shape**: this route says "output the caption text ONLY — no preamble, no quotes, no explanation." The chat route says "you're a conversational co-pilot." Different shape — Claude's behaviour follows the system prompt closely, so we get cleaner caption output by giving it a clean instruction.
3. **Client simplicity**: the consumer parses ONE event type (`text`) into a single growing string. No tool_call / tool_result cards to render. The `AICopyPreview` component is half the size of `CopilotPanel`.

Trade-off: two endpoints to maintain instead of one. Acceptable — they share the auth pipeline and `brandContext.js` compiler.

#### Cost

Brand context blob (~4-5k tokens) is sent cached. After the first call, subsequent drafts within 5 minutes hit Anthropic's cache. Per-call cost:

- First-time (cache miss): ~$0.005-0.015
- Cached (within 5 min of any other AI Co-pilot call for the same brand): ~$0.001-0.003

Drafting copy for IG + LinkedIn + X on the same plan = ~$0.01-0.02 total. Agency drafting 30 plans/week ≈ $0.30-0.60/week per brand for inline drafts (in addition to chat-panel costs).

#### Deploying

Same as the other Vercel routes: push to branch → preview deploy auto-builds; merge to main → prod deploys. No new env vars to set — reuses PR 2's allowlist + Anthropic key.

### `/api/ai/image` (Vercel serverless route — image-prompt ideation)

Two-step image-prompt generation for the "AI image prompts" card on PostPlanDetailView ([AIImagePromptPanel.jsx](web/src/components/AIImagePromptPanel.jsx)). The admin gets 3-5 direction ideas first, picks one, then expands it into a detailed paste-ready image-gen prompt.

#### Auth & gating

Identical to `/api/ai/chat` and `/api/ai/copy`: JWT verification → `profiles.is_agency` check → `AI_COPILOT_BRAND_IDS` allowlist on `accountId`. Same env vars — no new secrets.

#### Modes

- **`ideas`**: returns 3-5 direction concepts via `streamObject` with a Zod schema enforcing `{ ideas: [{title, description, style_keywords: []}] }` (min 3, max 5). The Vercel AI SDK constrains Claude to produce schema-conforming JSON AND validates it server-side. Wire shape: text-stream of raw JSON deltas via `pipeTextStreamToResponse`. The client (`useObject({ schema })`) parses progressively via `parsePartialJson` into `DeepPartial<RESULT>` so cards render as fields land. Brand voice + photography style + voice tags + pinned brand notes from the cached brand-context blob inform every direction.
- **`prompt`**: given the chosen idea (title + description + keywords) + the admin's free-form additional details (riding as `prompt` — see body shape below), returns a single detailed image-gen prompt via `streamText` as text deltas. 100-250 words, covers subject / setting / composition / lighting / style / brand palette / texture. NO Midjourney `--ar` flags or other tool-specific syntax (admin adds those for their tool of choice).

#### Request shape

Ideas mode (sent via `useObject.submit(input)` — body is the raw input object verbatim):

```js
POST /api/ai/image
Authorization: Bearer <user JWT>
Content-Type: application/json
{
  "accountId": "<brand uuid>",
  "plan_id": "<post_plans.id>",
  "platform": "instagram" | "linkedin" | "x",
  "mode": "ideas",
  "brief": "<optional brief — extra context beyond the post concept>"
}
// → 200 text/plain; charset=utf-8 — AI SDK text-stream protocol via streamObject.pipeTextStreamToResponse. JSON deltas streamed as the object is built; useObject parses progressively into DeepPartial<IDEAS_SCHEMA>.
// → 4xx/5xx { error }   (JSON body for errors, before the stream starts)
```

Prompt mode (sent via `useCompletion.complete(prompt, { body })` — always sends `{ prompt, ...body }`):

```js
POST /api/ai/image
Authorization: Bearer <user JWT>
Content-Type: application/json
{
  "prompt": "<admin's free-form details for THIS prompt — was `details` pre-Phase-2c>",
  "accountId": "<brand uuid>",
  "plan_id": "<post_plans.id>",
  "platform": "instagram" | "linkedin" | "x",
  "mode": "prompt",
  "idea_title": "<chosen direction title>",
  "idea_description": "<chosen direction description>",
  "idea_style_keywords": ["<keyword>", ...]
}
// → 200 text/plain; charset=utf-8 — AI SDK text-stream protocol via streamText.pipeTextStreamToResponse. Text deltas accumulated by useCompletion.
// → 4xx/5xx { error }
```

**Pre-Phase-2c (history)**: both modes returned `text/event-stream` with custom SSE events (`text` / `usage` / `done` / `error`). The prompt-mode body used the field `details` — now `prompt` to match `useCompletion`'s convention.

#### Observability

No client-side usage meter (neither `useObject` nor `useCompletion` text-stream surfaces usage). Server logs every call:
```
[image] usage account=<uuid> plan=<uuid> platform=instagram mode=ideas|prompt input=… cache_read=… cache_write=… output=… finish=stop|n/a
```
Grep `[image] usage` in Vercel Function Logs to monitor cache hit rate. Same monitoring path as `[copy] usage`. If `cache_read=0` consistently across consecutive calls within 5 min for the same brand, the cache is broken — investigate per the breakage checklist in [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md).

#### Cost

Both modes use the same cached brand-context blob, so cache reads across `chat` / `copy` / `image` surfaces within the 5-minute TTL. Per-call cost:
- `ideas` first-time (cache miss): ~$0.008-0.015 (slightly larger output token count for the JSON structure)
- `ideas` cached: ~$0.003-0.005
- `prompt` first-time (cache miss): ~$0.008-0.015
- `prompt` cached: ~$0.002-0.004

Generating image prompts for one plan (ideas + 1 chosen prompt) = ~$0.01-0.02. Heavy workflow (5 ideas regens + 3 prompts) = ~$0.04-0.06.

#### Deploying

Same as the other Vercel routes: push to branch → preview deploy auto-builds; merge to main → prod deploys. No new env vars.

---

## 11. Deployment & environments

### Vercel
- Project auto-deploys on push to `main`
- Production: `https://agency.linkrunner.io` (custom domain)
- Legacy URL: `https://lr-studio-dashboard-3kkp.vercel.app` (still works, used as Supabase redirect-URL fallback for preview deploys)
- Build: Vite (`web/` is the build root per `vercel.json`)

### Supabase
- Project ref: **`vmfwnfflhvskadkfnvds`**
- Migrations applied via Management API SQL endpoint, CLI, or Dashboard SQL Editor
- Edge function deployed via Supabase CLI
- Site URL (Authentication → URL Configuration): `https://agency.linkrunner.io`
- Redirect URLs: `https://agency.linkrunner.io/**`, `https://lr-studio-dashboard-*.vercel.app/**`, `http://localhost:5173/**`

### Local dev
- `cd web && npm install && npm run dev` → Vite on `http://localhost:5173`
- `web/.env.local` needs `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`
- For testing logged-in features: copy the Supabase session token from `localStorage` on prod (`sb-vmfwnfflhvskadkfnvds-auth-token`) into localhost localStorage

---

## 12. External accounts & secrets

**Reference card only — no secret values stored here.**

| Service | Where it lives | What we use |
|---|---|---|
| Supabase | `supabase.com/dashboard/project/vmfwnfflhvskadkfnvds` | Postgres, Auth, Storage, Edge Functions |
| Vercel | linked GitHub repo `CodeFire98/lr-studio-dashboard` | Hosting, Web Analytics, Speed Insights |
| Firecrawl | dashboard at `firecrawl.dev` | Brand kit enrichment via `/v2/scrape` |
| Resend | dashboard at `resend.com` | Transactional email via `send-email` edge function. Sending domain `linkrunner.io` (Squarespace DNS), verified 2026-04-29. From: `agency@linkrunner.io`. |
| Anthropic | `console.anthropic.com` | Claude API for the AI Co-pilot (`/api/ai/chat`). Default model `claude-sonnet-4-6`. Direct SDK integration — no OpenRouter (caching pass-through unreliable). |
| Google OAuth | Google Cloud Console → OAuth client | Sign-in via Supabase OAuth provider |
| Google Workspace | hosts `agency@linkrunner.io` mailbox | Receives replies to outbound invitation emails (Reply-To header points at the inviter, but bounces / replies-to-the-from land here) |
| Domain registrar | (per Lakshith) | `agency.linkrunner.io`, `cal.linkrunner.io`, `linkrunner.io` |
| Cal.com | `cal.linkrunner.io/team/demos/lragency` | Scheduling link from HomeView |

### Secret storage locations

| Secret | Where it goes | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `web/.env.local` (committed: no) | Public, included in client bundle |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `web/.env.local` | Public; RLS-restricted |
| Supabase `service_role` key | **Never in repo** | Should only live in Supabase function secrets |
| `FIRECRAWL_API_KEY` | Supabase function secret | Read by `enrich-brand-kit` from `Deno.env` |
| `RESEND_API_KEY` | Supabase function secret | Read by `send-email` from `Deno.env` |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` / `APP_URL` | Supabase function secrets (non-secret values, but stored alongside the API key for convenience) | Read by `send-email`. Defaults baked in if unset. |
| Supabase Personal Access Token (PAT) | Local `.claude/local-secrets.env` (gitignored) **or** `~/.supabase/access-token` (CLI default) | Used for `db push`, `functions deploy`, Management API SQL endpoint. Source the file before CLI ops: `source .claude/local-secrets.env`. |
| `.claude/local-secrets.env` | Local-only, gitignored (entry in `.gitignore`) | Single-source-of-truth for the PAT. Keys in Supabase Edge Function secrets (service_role / Firecrawl / Resend) **do not** live here — they only get written to Supabase via `supabase secrets set` and never come back to disk. |
| `ANTHROPIC_API_KEY` | Vercel env vars (all 3 environment toggles) | Read by `/api/ai/chat` from `process.env`. Server-only; never `VITE_`-prefixed. |
| `AI_COPILOT_BRAND_IDS` | Vercel env vars | Comma-separated UUIDs that may use the Co-pilot. Server-side allowlist enforced inside `/api/ai/chat`. |
| `VITE_AI_COPILOT_BRAND_IDS` | Vercel env vars | Same value as above, exposed to the SPA so the topbar trigger renders conditionally. Server is the real authz boundary; this is just for the render gate. |

### Pending credential rotations (from session memory, 2026-04-23 → 05-01)

- Supabase `service_role` key — shared in chat 2026-04-23, rotate at Settings → API
- Firecrawl key (`fc-…`) — shared in chat 2026-04-27, rotate at firecrawl.dev/app/api-keys
- Supabase PAT (`sbp_…`) — shared in chat 2026-04-27 + reused 2026-04-28, rotate at supabase.com/dashboard/account/tokens
- Resend key (`re_…`) — shared in chat 2026-05-01, rotate at resend.com/api-keys after Tier 1 ships

---

## 13. Known decisions & gotchas

Running log of "we considered X and chose Y because Z" — newest first.

- **X engagement uses `scrape.badger/twitter-tweets-scraper` (re-enabled 2026-05-14).** The earlier 2026-05-12 decision to skip X was correct for what we'd found at the time — every Apify X actor I tried (apidojo/tweet-scraper, kaitoeasyapi, apidojo/twitter-scraper-lite, tugkan, xquik, xtdata, parseforge) either was missing, charged for empty results, or used `startUrls` for profile/search/list URLs rather than individual tweet URLs. Reversed two days later after a deeper Apify Store pass found `scrape.badger/twitter-tweets-scraper`: 700k runs, 1.2k users, $0.0002/result (cheapest in the X market), takes `{ id: "<tweet-id>" }` and returns real engagement (validated against a real Bamboo Bear tweet: `views: 82`, `favorite_count: 0`, `retweet_count: 0`, full text + author + avatar). The cost ceiling at full rollout is now ~$0.30/month for X, well inside free-tier credits — what made me skip X originally (uncapped cost risk + $200/mo X API alternative) no longer applies. The runner-up `pratikdani/twitter-posts-scraper` works with `{ url }` input but at $0.02/result is 100× more expensive; documented in the preflight as a fallback only. **Lessons that informed the find:** (a) "Twitter scraper" in Apify naming nearly always means "scrape from a profile/timeline", NOT "look up one tweet" — keyword-skim the input schema for `tweets`/`tweet_ids`/`tweetUrls`/`id`/`url` before integrating; (b) `feedback_apify_inspect_full_payload.md` still applies — scrape.badger's reply/bookmark/quote count fields don't appear in the first-20 keys, so the normalizer probes multiple candidate names and reports unavailable fields via `availability_notes`; first prod cron run will tell us which (if any) exist past key 20.
- **LinkedIn uses `supreme_coder/linkedin-post` (cookie-free, $1/1k).** Considered (a) the official LinkedIn Marketing API (owned Pages only, requires per-brand OAuth + LinkedIn product approval), (b) a cookie-gated actor that returns richer data but breaks every ~30 days when the session expires, (c) a cookie-free public scrape that accepts sparse metrics. Chose (c). The actor was picked via shootout (see PRs 5+6 entry above) — won on real-data return (33 reactions, 2 comments, 1 share for a real LinkedIn post URL) AND cost (\$0.001 per scrape vs. \$0.0023 for the IG actor). LinkedIn tiles actually end up MORE informative than IG ones because share count IS exposed for LinkedIn public posts (IG doesn't expose share count via Apify). The trade-off: no view count, and the actor returns `timeSincePosted` as a relative string ("3 weeks ago") instead of an ISO timestamp — `posted_at` stays null and the agency-marked `published_at` on `post_plan_publications` is the only "this went live at" source of truth. Acceptable; absolute post timestamps are nice-to-have, not load-bearing.
- **Vercel + Node 24 strict ESM: relative TS imports need explicit `.js` extension.** Vercel bumped the default Node version 22 → 24 around mid-May 2026. Node 24's ESM resolver doesn't auto-extend `./scraper-lib` to `./scraper-lib.js` — the runtime throws `ERR_MODULE_NOT_FOUND` with the path verbatim. Source is `scraper-lib.ts`, compiled artifact is `scraper-lib.js`, import must say `from "./scraper-lib.js"`. The convention is already in use across all `web/api/ai/*.ts` routes (`from "../../src/lib/brandContext.js"` etc.) — engagement routes were the outlier. The /api/engagement/refresh on-demand route had been working since PR 7 on Node 22, then started 500ing on the X-integration deploy under Node 24 with NO code changes to the import statement. **False trail during the debug**: I initially blamed the helper's leading underscore (`_shared.ts`) and renamed it to `scraper-lib.ts` because `feedback_vercel_underscore_prefix.md` documents Vercel's private-file convention for routes. Renamed; same error. The actual fix was adding the `.js` extension. Lesson saved in `feedback_vercel_node24_esm_extensions.md`. The route-underscore memory is now caveated to flag that the helper-underscore claim was unverified.
- **Meta CDN images need a same-origin proxy, not just a referrer fix.** During PR #78 smoke test on 2026-05-12 the IG images didn't render even though the URL + metrics were correct. First-guess diagnosis was hotlink protection on `scontent-*.cdninstagram.com` (i.e. the CDN rejecting requests whose `Referer` isn't `instagram.com`) and the fix would be `referrerpolicy="no-referrer"` on the `<img>` tag. **Wrong.** Verified by injecting the real CDN URL into a test page: all variants — with/without `referrerpolicy`, with/without `crossorigin`, `mode: 'cors'`, `mode: 'no-cors'`, even raw `fetch()` — fail with `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. The real cause is that Meta's CDN sends `Cross-Origin-Resource-Policy: same-origin` (or `same-site`), which is a browser-side mechanism that blocks the response from being embedded by any other origin, regardless of how it was fetched. No `<img>` attribute and no `fetch()` option bypasses CORP. The only working answer is a server-side proxy: Vercel fetches the image (server-to-server, CORP doesn't apply) and re-emits the bytes with permissive CORP. Considered (a) the referrer fix that didn't work, (b) Instagram's blockquote+embed.js renderer (Meta's own oEmbed iframe — fragile, tracks users, conflicts with our "static cards" decision), (c) skip the image entirely and just show caption, (d) Vercel proxy route, (e) Supabase Storage cache. Shipped (d) in PR #78. (e) is still the durable answer for URL-expiry handling and will come with the social asset pipeline. **Lesson for the next Meta CDN embedding need**: don't try `referrerpolicy` first — go straight to a same-origin proxy. The error code `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` is the unique signature of CORP enforcement.
- **Live-post engagement uses Apify scrapers, not official platform APIs (v1).** Considered (a) X API + Meta Graph API (IG) + LinkedIn Marketing API — the "official" path, (b) Apify-only across all three, (c) hybrid (X official + Apify for IG/LinkedIn). Chose (b). Reasons: (i) Apify works for ANY public post URL with no brand-side OAuth ceremony — critical for an MVP where the agency pastes URLs across many brands, (ii) X API's paid tier ($200/mo Basic minimum just for read access) is a real subscription decision vs Apify's pay-per-result (~$22/mo at projected full scale, see plan), (iii) IG official requires every brand to OAuth a professional/business IG account into a Meta-reviewed app — multi-week onboarding per brand vs zero, (iv) LinkedIn official only works for owned Pages the app has product access for — arbitrary public LinkedIn URLs are simply unsupported officially. Trade-off: Apify scrapes are gray-area under platform ToS (hiQ v. LinkedIn precedent makes it not illegal, but contractually disallowed); brittle to platform UI changes; LinkedIn returns thin data without session cookies. Mitigation: the snapshot table stamps `scrape_status` (`ok`/`partial`/`failed`/`blocked`) and the UI shows "metrics unavailable" honestly instead of guessing. Revisit when (i) we hit a brand asking for Page-level analytics (move that brand to official), (ii) Apify breakage rate exceeds a usable threshold, or (iii) the agency goes brand-facing at scale and platform pursuit risk becomes real. Actors locked in for v1: `apify/instagram-scraper` (IG, already in use by Trends Radar), `apidojo/tweet-scraper` (X, cheapest stable pay-per-result — input is `tweetIDs` extracted from `/status/(\d+)`, not `startUrls`), `harvestapi/linkedin-post-scraper` (LinkedIn). **Actor pivot 2026-05-12**: original plan named `apify/linkedin-post-scraper` but that actor doesn't exist on Apify (404 `record-not-found` from dry-run). Pivoted to `harvestapi/linkedin-post-scraper` — same shape, well-maintained third-party. Reinforces the broader "Apify actors are volatile, plan for breakage" point: anyone of them can vanish; the route's `scrape_status='failed'` path is what protects the user experience when it happens.
- **Engagement is two tables (`post_engagement_snapshots` append-only + `post_embed_cache` 1:1), not one combined table.** Considered (a) one denormalized `post_engagement` table with both metrics and embed fields, refreshed in place, (b) two tables. Chose (b). Counts change every refresh; the post's caption/image/author rarely change after first scrape. Combining them would either (i) duplicate the caption N times in history rows or (ii) lose the snapshot history to keep them denormalized. The split keeps history cheap (snapshots are skinny rows) AND gives the embed card a single row to read (no "latest snapshot for content" query). Monthly-report deltas read the snapshots table; the tile reads the cache. Trade-off: one extra table to maintain. Worth it.
- **Engagement writes are service-role only (no RLS INSERT policies for authenticated).** Considered (a) brand and agency users can hit `/api/engagement/refresh` and the route writes back via the user's JWT (RLS would gate them), (b) the route always writes as service-role and gates "who can trigger a refresh" at the application layer. Chose (b). Reason: Apify costs real money per scrape. Letting any authenticated user trigger a scrape via spammable client-side API call invites abuse (a curious brand user clicking "Refresh now" 100 times = $$). Service-role writes + an explicit `is_agency_user()` check inside the route is the cleaner gate. Reads stay open to brand users (they see the data); writes are agency-only at the route, regardless of what RLS would allow. When/if brand-side "refresh now" lands later, the gate is rate-limit + agency-issued daily quota at the route layer, still not RLS.
- **Daily-digest idempotency keys on `window_start_utc`, not a label or a date column.** When adding the per-brand "already sent today" check we had three options: (a) compare the human label like `"Tuesday, May 12"`, (b) compare a date-only column (would need a new migration), (c) compare `window_start_utc` which we already write to every row. Chose (c). The label is fragile across years (`"May 12"` collides next year) and feels brittle to read. A new date column would mean another migration just for this. `window_start_utc` is already the canonical "this IST day's tomorrow-midnight" value, written by the same code path that decides what to send, and unique-per-IST-day. The check is one indexed predicate (`account_id = $1 AND window_start_utc = $2 AND sent > 0`) — cheap, robust, no schema change.
- **Vercel Hobby cron is best-effort against deploy churn — code defensively.** Discovered the hard way on May 11: a busy merge afternoon (other Claude session shipped 7 PRs) put two deploys at 12:29 UTC and 12:44 UTC, bracketing the cron's 12:30 UTC schedule. Vercel silently skipped the scheduled fire — no error, no log entry on the dashboard, just no invocation. Hobby's flexible 1-hour fire window can't survive back-to-back deploys overlapping it. Considered (a) accept the limitation + manual recovery, (b) move to Vercel Pro (~$20/mo, ~5-min cron window), (c) move scheduling to Supabase `pg_cron` + `pg_net.http_post` (server-side, immune to Vercel deploys), (d) external cron service (cron-job.org / GitHub Actions) as a parallel trigger. Chose (a) for now — manual Run + idempotency covers it — but ranked the upgrade paths in §14. Whichever path we eventually take, the idempotency makes redundant triggers a no-op, so adding a second trigger source later is risk-free.
- **AI image surface generates PROMPTS, not images.** Considered (a) integrate Midjourney / DALL-E / Imagen directly so clicking "Generate image" produces actual PNGs in the Deliverables card, (b) generate a paste-ready prompt and let the admin run their own image-gen workflow. Chose (b). Reasons: (i) every image-gen tool has subtly different syntax, style biases, and pricing — picking ONE locks the agency in; (ii) the agency already has a workflow they like elsewhere (Midjourney, ChatGPT image, etc.) and the value-add is the brand-aware PROMPT, not the rendering; (iii) image-gen API costs are 50-100x the text-gen costs and meaningful compute spend deserves a deliberate decision per brand, not a click-and-it-runs default; (iv) prompts are clipboard-paste-portable forever even as the underlying tools change. We'll revisit if/when one tool's API becomes overwhelmingly the standard AND brand-aware fine-tuning closes the prompt-portability gap.
- **Image prompts use a two-step "ideas → picked direction → detailed prompt" flow, not one-shot.** Considered (a) one-click → AI writes a detailed prompt directly from the post concept, (b) two-step with 3-5 directions in between. Chose (b). One-shot generation was the original PR 8 plan but the user pushed back: a single shot is too random — the AI picks ONE angle (studio shot? lifestyle? abstract?) and the admin has no signal that other directions exist. The two-step pattern shows the angle SPACE first (5 cards across different styles — studio product, in-context lifestyle, abstract/conceptual, hands/detail crop, behind-the-scenes), the admin picks the one that fits the post's intent, THEN expands to detail. Same UX pattern as the instruction-driven copy flow from PR 5 — give the admin directional choice before locking in. Trade-off: two round-trips instead of one (~2x the latency before the admin gets a usable prompt). Worth it for the choice. Mitigated by prompt caching — both round-trips hit the cached brand-context blob.
- **AI Co-pilot brand memory is write-only from chat — destructive ops live in the BrandKit UI.** Considered (a) full CRUD via chat tools (`write_brand_note`, `update_brand_note`, `delete_brand_note`), (b) write-only from chat, hand-edit / delete in BrandKitView only. Chose (b). Phrase ambiguity in chat is real — "forget that we hate the word authentic" could mean "delete the existing note" OR "remember a new note that we don't hate it anymore." A misunderstood phrasing on a destructive op = silently lost institutional memory. Curation actions live in the UI where the action is explicit and confirmed. Chat is the **acquisition** path — the agency leans on the AI to capture facts they would otherwise have to remember to manually type into the kit. The friction shape matches the value: typing "remember that…" mid-chat is frictionless; explicitly deleting a note in a UI is the right amount of friction for something destructive.
- **Brand notes are scoped per-brand, not global to the agency.** A "founder hates the word X" fact for Bamboo Bear shouldn't bleed into Acme's AI calls. The `brand_kit_notes.account_id` foreign key + the brand-context compiler reading only the active brand's notes enforces this. Considered (a) a global `agency_notes` table for cross-brand patterns ("we work in IST timezone", "our style guide is X"), (b) per-brand only for now, add agency-level later if patterns repeat. Chose (b) — start with the obvious scope, add globals only if the repetition pain becomes real. Most agency-level facts can be encoded in the chat system prompt directly.
- **AI copy generation asks the admin for an instruction BEFORE generating, no presets.** PR 4 generated copy from brand voice + concept alone — output was too random and didn't react to the admin's intent for this specific post. Considered (a) a "Custom prompt" textarea + a dropdown of presets like "Shorter / More playful / Remove emojis", (b) free-form instruction textarea only, (c) leave as-is and ask the admin to refine via Regenerate. Chose (b). Presets sound friendly but in practice an agency drafting for a specific brand has specific things in mind — "a Mother's Day post celebrating moms who run small businesses" isn't a preset; "make the hook punchier and add a CTA about our sustainability page" isn't a preset. A textarea covers both the easy case ("shorter") AND the long tail, and an agency lead types fast enough that the friction is minimal. Presets would also have to be maintained, internationalized, A/B tested for which ones work, etc. — overhead for a feature that's strictly worse than letting users say what they actually want. The instruction stays editable after streaming so the admin can refine + Regenerate to iterate without closing the preview. For "redraft" mode specifically, the system prompt is critical — it instructs the model to **preserve what works in the current copy and change ONLY what the admin's instruction asks**. The first iteration of redraft just rewrote everything from scratch, which felt like "AI took my work away." The fix is in the prompt, not the API shape: explicit instructions to preserve + change-only-what's-asked.
- **Inline copy generation is a separate `/api/ai/copy` endpoint, not another tool on `/api/ai/chat`.** The chat panel does agentic multi-turn work (call a tool → see the result → call another tool). Inline "AI draft" is single-shot — user clicks a button, the model writes one caption, that's it. Considered (a) add a `draft_post_copy(plan_id, platform)` tool to `/api/ai/chat`, (b) build a separate endpoint. Chose (b). Reasons: (i) latency — no tool-use loop overhead so tokens stream immediately on click instead of after the model "decides" to call the tool; (ii) the system prompt shape is different — chat is conversational, copy generation is "output ONE caption, no preamble, no quotes, no explanation," which Claude follows much better with a clean system message vs sharing context with chat instructions; (iii) the client consumer is half the size — only `text` events to parse, no `tool_call` / `tool_result` rendering. Trade-off: two endpoints to maintain, but they share the auth pipeline and `brandContext.js` compiler. Will keep this split if we add `improve` / `variants` modes (same endpoint, new mode flag) and only revisit if a use case wants AI orchestration across copy generation + plan creation in a single agentic flow.
- **AI Co-pilot chat history persists to localStorage, not a DB table (for v1).** When the panel closes or the page refreshes today, the in-memory React state would be lost. Considered (a) DB table `copilot_conversations(account_id, user_id, messages jsonb)` with realtime + cross-device sync, (b) localStorage keyed by `(userId, accountId)`. Chose (b). Reasons: realtime cross-device sync isn't a real need yet (agency staff work from one machine 90%+ of the time); a DB table adds a migration, RLS, db.js helpers, optimistic-update plumbing, and realtime subscriptions for what users haven't asked for. localStorage gives us close→reopen continuity and refresh-survives — the two cases that actually came up in first-use testing — with one file and 30 LOC. We cap at last 60 messages per (user, brand) to keep growth bounded (~50KB per conversation, well under the 5MB browser cap even at 100 brands). When cross-device sync becomes a real ask, this migrates cleanly to a DB table — the message shape doesn't change, just the storage backend. The "Start new" header button explicitly clears (with confirm if non-empty) so the user has a manual reset they can trust.
- **AI Co-pilot streams via SSE, not WebSocket and not a polling endpoint.** Three options for getting token-by-token Claude output to the panel: (a) WebSocket, (b) Server-Sent Events over a long-lived `text/event-stream` response, (c) chunked JSON polling. Chose (b) for several reasons: Vercel serverless functions support streaming responses out of the box (with `X-Accel-Buffering: no` to disable the default response buffering), Anthropic's TypeScript SDK has a first-class `stream()` API that exposes per-token deltas via `.on('text', ...)`, and SSE is one-way (server→client) which exactly matches our needs — we only send the user message at the start, then watch tokens come back. WebSocket would add bidirectional plumbing we don't use; polling would lose the token-level interactivity that makes the Co-pilot feel fast. The client uses a manual SSE parser (`parseSse` async generator) rather than `EventSource` because EventSource doesn't support POST bodies or `Authorization` headers — both of which we need (the user's JWT goes in the Authorization header, and the chat history goes in the POST body).
- **AI Co-pilot rollout uses a UUID allowlist env var, not a per-account boolean column.** Considered (a) `accounts.ai_copilot_enabled boolean default false` — clean, queryable, surfaced in the Settings UI later, (b) a server-side `AI_COPILOT_BRAND_IDS` env-var allowlist + matching `VITE_` mirror for the client conditional render. Chose (b) for the rollout phase because flipping the allowlist in Vercel env vars takes one click and zero schema changes — perfect for "let's test with Bamboo Bear today and add Acme tomorrow." A DB-column approach would force a migration + a CRUD UI for the agency to toggle it, neither of which earn their weight while we're still validating the loop end-to-end. Once we're widening past a handful of brands, we'll move to the column approach (or a `feature_flags` table) and let the env-var allowlist deprecate naturally. The double-gate (server allowlist + client `VITE_` mirror) is intentional — the client mirror is just for the conditional render; if someone bypasses the UI and calls `/api/ai/chat` directly, the server still enforces the allowlist.
- **AI Co-pilot tools run server-side, not in the client.** Anthropic's tool-use protocol works in two modes: client-side execution (server returns "I want to call tool X with args Y", client runs it, sends back the result) or server-side wrapper (the API handler runs the tool inline before returning the final response). We went with server-side execution inside the `/api/ai/chat` route. Reasons: (a) the only PR-2 tool (`create_post_plan_draft`) writes to the DB via service-role, which can't safely run from the browser; (b) keeping the agentic loop server-side means the client just consumes a stream and renders cards, no orchestration logic — way simpler component; (c) it lets us add tools later (`write_brand_note`, `update_post_plan`) without changing the client at all. Trade-off: the SSE stream has to carry tool-call and tool-result events as additional event types alongside text deltas, so the client SSE parser is a bit more complex. Worth it.
- **Cron → edge-function auth uses a shared CRON_SECRET, not the Supabase service-role key.** When PR #44 first shipped the daily-digest cron, the Vercel route passed `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}` to the send-email function and relied on the platform's `verify_jwt: true` gate. That worked in May while Vercel's env held the legacy `eyJ…` service-role JWT. Then Supabase introduced the new `sb_secret_…` opaque-string format as the default for the same key, and the platform's JWT verifier started rejecting every cron call with `UNAUTHORIZED_INVALID_JWT_FORMAT` — the cron route was sending a non-JWT, and the platform never let the request reach our code. PR #47's "decode the bearer and check role=service_role" fix didn't help (decoded an opaque string → null), and the legacy JWT could be re-enabled in Supabase but is being deprecated. Considered (a) require the legacy JWT in Vercel env and accept the deprecation risk, (b) write our own JWT validator using Supabase's JWKS, (c) move auth off the Supabase key entirely. Chose (c). The cron is server-to-server with both sides under our control — a shared random opaque secret (`CRON_SECRET`, the same one Vercel uses to authenticate its cron *to* us) is the simplest model, doesn't depend on Supabase key formats, and can't be invalidated by Supabase product changes. The edge function now runs with `verify_jwt: false`; user-template auth (`team-invite`, `agency-update`) is enforced inside our handler via `auth.getUser()` against ANON_KEY — equivalent security guarantee, just done in code rather than at the platform gate.
- **AI Co-pilot brand-context compiler is a pure single-purpose module, not inlined into the API route.** Prompt caching is the entire cost story for this feature — Anthropic's prompt cache gives ~90% input-token discount on cache hits within a 5-min TTL. For the cache to actually hit, the compiled blob must be **byte-stable per brand**: same inputs, same output, every time. Considered (a) inlining the compile logic directly into the future `/api/ai/chat` route, (b) building it as a method on a brand-context class with internal state, (c) a pure function in its own module. Chose (c). Pure + stateless = trivially testable, no hidden mutations, can be imported from both the SPA (for UI previews) and the Vercel route (for actual AI calls), and we can swap the data sources later (e.g. add `post_plan_publications` once we have analytics) without restructuring callers. Trade-off: one extra file in `web/src/lib/`. Worth it.
- **`brand_kit_notes` lives in its own table, not as a jsonb array on `brand_kits`.** Considered (a) `brand_kits.admin_notes jsonb default '[]'::jsonb` — single-table, no migration ceremony, (b) a dedicated `brand_kit_notes` table mirroring `post_plan_ideas` shape. Chose (b). Reasons: notes will be written frequently by the Co-pilot (every "remember that …" turn), often concurrently with admin edits to the BrandKit UI — jsonb-array mutation has classic last-write-wins race conditions that a row-per-note shape sidesteps. Per-note metadata (created_by, is_pinned, individual delete) needs columnar structure anyway; jamming it into an array of objects would just reinvent half a table. And realtime subscriptions per note (for cross-tab sync between Co-pilot and BrandKit UI) are clean when each note is a row but messy when the whole array refires on every change. Same pattern as the `brand_kits` ↔ `brand_kit_enrichments` split from migration 0017. Trade-off: one extra table + four RLS policies. Already mirrors `post_plan_ideas` so the pattern is familiar.
- **AI-generated plans are marked with a flag column, not stored in a separate `ai_drafts` table.** Considered (a) staging AI proposals in a parallel `ai_drafts` table that promotes to `post_plans` when the admin approves, (b) writing directly into `post_plans` with an `ai_generated` flag and showing a pill in the existing detail view. Chose (b). The user's spec is "propose first, in the post plan view, in an editable format" — that's exactly what we get by writing directly to `post_plans`: the AI's output IS a real plan, the admin edits it in the surface they already use, submits for review through the existing workflow. No separate "AI inbox" to manage, no "promote draft" plumbing, no duplicate RLS policies. The `ai_generated` flag is the minimum metadata needed to surface "✨ AI draft" branding and run acceptance-rate telemetry. `ai_draft_payload jsonb` preserves the original tool-call args so we can later diff what AI proposed vs what the admin shipped (and offer "reset to AI draft" if the admin over-edits).
- **Daily-digest observability: audit table in Postgres, not read-from-logs.** First production miss (Bamboo Bear's May 10 cron didn't deliver) took three consoles to diagnose — Vercel cron registration page, Vercel runtime logs (which Hobby evicts after ~24h), Resend dashboard. None of them is a queryable artifact, and you can only see ~12h of cron history. Considered (a) bump Vercel to Pro for longer log retention, (b) ship logs to a dedicated observability tool (Logflare / Axiom), (c) write a small audit table. Chose (c) — Postgres is already our system of record, the row volume is tiny (~8 brands × 1 row/day = ~240/month), the access pattern is "SELECT WHERE brand AND date", and the data we care about is structured (sent counts, skip reasons) not freeform log text. Now "did email X go out on day Y?" is `select * from daily_digest_log where brand_name = '…' order by run_at desc limit 10;`. The Vercel logs still exist for debugging the route itself (exceptions, env-var issues), but the per-brand audit is now permanent.
- **Image dimension limits: 8,192px / 33MP, hard reject on upload, friendly fallback on render.** Hit a real bug 2026-05-09 — three reference PNGs at 32768×21846 (~716 megapixels) on disk as 3.7MB files (PNG compresses well) but ~3GB RGBA decoded. No browser will allocate that, so the `<img>` rendered as the default broken-image-with-alt-text placeholder. Considered (a) auto-downscale on upload via canvas, (b) hard-reject with a clear error, (c) only do the render-side fallback. Chose (b) + a render-side `<SafeImage>` fallback for files already in storage from before the validator existed. Auto-downscale would be friendlier UX-wise but: it'd lose the user's original (or force us to keep both versions), browser canvas re-encoding silently changes colour profiles, and our actual use case is "this was uploaded by accident" rather than "user intentionally wants their 700MP image displayed at thumbnail size." Reject + clear message lets the user resize in their preferred tool. Limits 8192px-per-side / 33MP-total are both well under the practical browser caps (~16k px / 64-256MP depending on browser+OS+RAM) and cover every realistic content-creator workflow. Auto-downscale tracked as future work in §14.
- **Invite redemption: pre-flight email check + token preservation, not catch-and-clear.** Original flow blindly called `accept_invitation(token)` whenever an authed session showed up with a pending token in localStorage; the catch handler then nuked the token on any error. This worked for the common case but failed silently when the invitee was signed in as the wrong account (typical: multi-Google-account browser, picks the wrong identity at the OAuth chooser) — `accept_invitation` threw the email-mismatch exception, the banner flashed, the token was destroyed, and the user had no recovery path beyond clicking the email link again (which they often didn't, because they thought the redemption had succeeded). Considered (a) auto-sign-out on email mismatch, (b) make `accept_invitation` return success even on mismatch (terrible — would let any signed-in user redeem any token), (c) pre-flight the email server-side before the redemption call, (d) just stop clearing the token on errors. Chose (c) + (d) + a one-click "Sign out & switch account" CTA: `previewInvitation(token)` is anon-safe, returns the invite's `email`, we compare to `auth.email` case-insensitively, and only call `accept_invitation` when they match. On mismatch we keep the token alive and surface the action button. The catch handler now distinguishes truly-dead invites (`invalid or expired` — clear the token) from recoverable errors (network blip, racy state — keep the token; the user can reload or sign in again). The pre-flight adds one extra RPC per redemption attempt, which is cheap and worth it. (Concrete repro that surfaced this: lakshithd98@gmail.com / Linkrunner, 2026-05-08 — see Recent changes log.)
- **Library is a per-brand asset repo with a kind toggle, not a free-form file lake.** Considered going wider with the Library — third toggle for brand-kit assets (logos/fonts), surfacing idea-attachment thumbnails, CSV export, tags, folders, bulk download. Decided to keep the surface tight: a Deliverables/References toggle that mirrors the two `post_plan_attachments` kinds, with the existing platform/date filters. Counts at the top, clickable section headings to jump back to the source post plan, no other new affordances. Brand-kit and idea-attachment integration are clean follow-ups; tags/folders/bulk-download are heavier features that need their own design rounds. The principle: Library should always read from existing data shapes (no new schema) until a real workflow gap demands more.
- **Calendar List view is full-width stacked rows grouped by day, not a time-grid agenda.** Considered (a) Google Calendar's Schedule view (each post as a single line with time gutter), (b) a Day-grid like Outlook's "agenda by day" with hour rows. Chose (a) — content posts aren't appointments; the day matters far more than the time-of-day, and a stacked row gives each post enough room to show concept + platforms + status pill + counts + lead avatar without truncating. Empty days are skipped entirely (no "Friday — no posts" rows). Sticky day headers + week separator headings (with weekly post count + review backlog count) give the bird's-eye view that nothing else in the calendar provided.
- **Density toggle retired in favour of List view.** The earlier `Comfortable / Compact` toggle on month view was a UX half-measure: compact mode was barely distinguishable from comfortable (just slimmer chips in the same calendar grid), and the real need ("show me everything in chronological order without truncation") was a different visual paradigm entirely. Replaced with `Month / Week / List` as a single segmented control. List view replaces every reason to use Compact.
- **Daily-digest is split: Vercel cron route is the orchestrator, edge function is the renderer.** The cron route at `web/api/daily-digest.ts` does all the data work — IST window math, brand iteration, plans / thumbnails / recipients queries, exclusion logic — and POSTs a fully-prepared payload to the existing `send-email` edge function with a new `template: 'daily-digest'` case. Considered (a) doing everything in the edge function (cron just pings it), (b) doing everything in the Vercel route incl. Resend call (skip the edge function entirely), (c) the split. Chose (c): keeps Resend access in one file (the existing send-email function — matches the "one Resend client, one set of secrets, one cold-start" decision), but keeps the data orchestration in the Vercel route where it belongs (Postgres + Storage public-URL building + recipient resolution feel cleaner from Node than Deno). The edge function becomes pure renderer + sender — no DB queries for this template, payload-in / send-out. Bonus: the cron route is easy to dry-run later by skipping the fetch to the edge function and returning the would-be payload; tee'd up for the manual-trigger affordance in §14.
- **Daily-digest auth bypasses the user-JWT path.** Other `send-email` templates require `auth.getUser()` to identify the caller. The cron route has no user — it runs on Vercel and holds the service-role key. Added a single special-case branch in the dispatcher: if `template === 'daily-digest'` AND `Authorization: Bearer <SERVICE_ROLE>`, route to `handleDailyDigest`; otherwise hit the normal user-auth path. This keeps the user-scoped templates strictly user-auth (someone holding the service-role key can't impersonate a user via team-invite, for example) and keeps the cron path narrowly scoped (only daily-digest is callable that way).
- **Daily-digest excludes drafting plans.** This email goes to brand members; brands can't act on a drafting plan (the agency is still working on it). Including drafting would either alarm the brand ("why is tomorrow's post not even drafted?") or train them to ignore the email when most rows are uneditable for them. Either is bad. The agency-side notification flow (planned, see §14) is the right place to surface "drafting plans for tomorrow" — that's an agency action item.
- **IST is hardcoded; `accounts.timezone` deferred.** Every current customer is in India. Adding a per-brand timezone column + per-brand cron pickup logic adds real complexity (multi-cron entries, or hourly-fire + per-brand local-time check). Skipping for v1; revisit when the first non-India brand lands. Migration 0037 deliberately doesn't include the column — easier to add cleanly later than to half-build it now.
- **"Posted" is a publication record, not a 4th status enum value.** Adding `posted` as a 4th `post_plans.status` would have re-litigated migration 0035's deliberate collapse to 3 workflow values. Considered (a) re-add `posted` to the enum, (b) put a `posted_url` column directly on `post_plans`, (c) a separate `post_plan_publications` table. Chose (c). Status (`drafting → needs_review → approved`) is the *workflow* axis; "is this live" is a *terminal-outcome* axis — mixing them was exactly the design error 0035 fixed. A separate table also handles multi-platform cleanly (one row per (plan, platform) with its own URL and timestamp), which a column on `post_plans` couldn't without jsonb gymnastics. The "Posted" pill becomes a derived display state via `getDisplayStatus(plan, publications)` — every status-rendering surface reads the helper, not `plan.status` directly. Trade-off: one extra join (or a small `Map<planId, publications[]>` bulk-load) on the calendar to know "is this posted." Worth it to keep the workflow enum honest. The CalendarView Approved bucket now excludes posted plans, so "Approved" becomes the *actionable* "approved-but-not-yet-live" pile the agency can chase.
- **Mark-as-posted RLS allows both members and agency, not brand-only.** Initial spec was brand-only ("only the client can mark posted after approving"). Considered keeping that restriction. Rejected because in practice the agency frequently does the actual posting (Buffer / Later / scheduled tools, or just "let me hit Publish for you while we're on the call"). Brand-only would force a friction step where someone has to ping the brand to flip a button. RLS now: anyone with edit access on the parent plan can insert/update; deletes for own row OR agency. `published_by` records who actually marked it for the activity feed and the Live posts repo. Easy one-line policy change to brand-only if usage shows abuse, but that hasn't been observed.
- **Live posts is its own top-level route, not a Library tab.** Considered extending Library (which already toggles Deliverables / References) with a third tab. Rejected for v1 — Library is per-asset (each tile = a file), Live posts is per-publication-event (each tile = a (plan, platform) tuple with an external URL). Different shapes, different filters (platform-only for Live posts; platform+date+search for Library), different empty-state copy. Easier to keep them as separate surfaces and revisit a merge later if the user explicitly wants one combined view. The route is brand-scoped (`/c/:slug/posts`) so it slots into existing routing patterns; sidebar entry "Live posts" sits below Library with the `link` icon.
- **Post-plan status workflow is 3 values, not 8 — and "needs changes" is a comment, not a status.** The original 8-value enum (`not_started`/`wip`/`needs_brand_feedback`/`needs_admin_revision`/`approved`/`scheduled`/`posted`/`delayed`) modelled state nobody actually used. In practice the agency only ever cared about three buckets: am I working on it (Drafting), is the brand looking at it (Needs review), is it locked in (Approved). Considered (a) keeping the 8-value enum and just bucketing in the UI, (b) collapsing to 3. Chose (b) — keeping the 8-value enum forever as a UI-only abstraction would mean "what does the brand do when they want changes?" stays ambiguous (do they flip to `needs_admin_revision`? Do they comment? Both?). The new model says: brand wants changes → leave a comment → row stays at `needs_review` → agency addresses comment → brand approves when satisfied. One status flip per side per cycle, not a ping-pong of revision-statuses. Agency can flip Approved → Drafting as a manual reopen if needed (rare). Migration 0035 remaps existing rows; the `posted_at` column is preserved for historical timestamps but nothing writes to it anymore (we deliberately gave up tracking "did this actually go live" — that was never reliably maintained anyway, and the agency can always look at the post on the platform itself).
- **Calendar week view is Trello-style stacked columns, not a Google-Cal time grid.** Considered (a) hours-on-Y-axis × days-on-X-axis time grid (Google Cal / Outlook), (b) flat 7-column stack of cards in time order. Chose (b): for content scheduling the *day* is the meaningful unit; *time-of-day* matters maybe 5% of the time and only for "morning vs. evening". A time grid would leave 80% of the canvas empty (most posts cluster around morning) and force tiny chips. Stacked cards give every plan room to show concept + status pill + platform icons + time without clipping. If "post-at-exactly-11:42" planning ever becomes a real use case we can add a time-grid mode behind a toggle, but it's not now.
- **Status filter is a pill row of workflow buckets, not a per-status select.** The original `<select>` exposed all 8 raw enum values (`not_started`, `wip`, `needs_brand_feedback`, etc.) — agency leads don't think in enum values, they think in workflow stages. Workflow buckets `All / Drafting / Needs review / Approved` (4) with count badges cover the actual mental model. *(Originally landed with a 5th `Posted` bucket; collapsed to 4 alongside the 0035 status simplification — `posted` no longer exists as a status.)* If anyone needs to filter at the raw-enum level for a specific debug case, they can edit a single line in `STATUS_GROUPS` to add a one-status bucket.
- **Density toggle is month-only.** Considered exposing it in week view too, but the week-card already has the right amount of room (multi-line title, status pill, platform icons) — there's no readability problem to solve there. Forcing a "compact week card" mode would just shrink everything for symmetry's sake. The toggle hides itself when you switch to week mode.
- **Ideas live in their own table, not as a status on `post_plans`.** Considered (a) a new status `idea` at the head of the `post_plans.status` enum so a single table handles the full content-lifecycle, (b) a separate `post_plan_ideas` table linked back via FK. Chose (b): ideas and post plans have different lifecycles (ideas pre-curation, post plans scheduled commitments) and would fight for the same RLS shape, the same status-log trigger, and the same calendar-grid filtering rules. A separate table keeps both surfaces clean — calendar never accidentally picks up ungroomed brand suggestions, the Inbox query never filters across an enum that's mostly post-plan transitions. The link is one-way: idea → `converted_post_plan_id` → plan.
- **Idea status enum is intentionally tiny: `submitted` / `converted` / `archived`.** Considered an `in_review` middle state (auto-flips when the agency opens the idea), but it complicates the badge math without giving the brand any new signal — the brand can't see in_review either way, and the agency already knows what they've opened. The badge counts `submitted` only, so converting OR archiving an idea drops it off the Inbox queue with one status flip. Add `in_review` later if we wire per-user "I've looked at this" tracking.
- **Idea attachments reuse the existing `post-plan-attachments` bucket.** The bucket's storage RLS extracts account_id via `split_part(name, '/', 1)`, so the path scheme `<accountId>/ideas/<ideaId>/<ts>_<filename>` is naturally accepted (the `ideas/` middle segment is opaque to RLS). Considered a separate bucket for cleaner separation, but we'd duplicate three storage policies for no security gain — the bucket's gate is already exactly what idea attachments need (members of the leading account). Saves a migration and a deploy step.
- **Tasks UI sunset, table not dropped.** Sidebar entries (`Tasks`, "All tasks", brand-side "Request") and route rendering (`HomeView`, `TasksView`, `TaskDetailView`, `AdminHome`, `AdminUploadView`) are gone in this PR. The component files and the underlying `tasks` / `assets` / `messages` / `activity` tables are intentionally **left in place** — destructive cleanup (delete files + drop tables migration) is queued as a follow-up after a bake period. If a brand or agency staff member has a tab open mid-deploy, it'll just snap to a 404 on next navigation rather than throwing on a missing table. Considered a "Tasks have moved to Got ideas?" deprecation banner on the old views — overkill since no one had been told this was coming and the routes don't actually resolve in the navigation any more.
- **All-clients sidebar shrinks to just Trends Radar.** Considered keeping a "cross-client overview" surface in the All-clients nav. Rejected because every meaningful action (calendar, inbox, library, brand-kit) is per-brand, and the BrandPicker is already the single point of entry. Forcing a brand-pick before *any* substantive action matches the agency's mental model: "go work in a brand". Trends Radar is the lone exception (it's intentionally cross-brand insight) and stays.
- **Idea queue badge counts submitted only, not unread.** Considered per-user view tracking (`post_plan_idea_views` mirroring `post_plan_views`) so each agency staffer has their own unread count. Rejected for v1 — overkill given the small-team setup; "1 idea is sitting in the queue" is more useful information than "you specifically haven't seen it." Revisit if the agency team grows or two staff members start stepping on each other's reviews.
- **Email-match auto-accept removed; invites require an explicit token click.** The `auto_accept_pending_invitations()` RPC was introduced in 0010 with the goal of letting invitees skip the click — sign in with the matching email and you're in. Removed 2026-05-02 because the silent-grant cases (existing-account invitees, typos in the invite email) outweighed the QoL benefit. Considered: (a) keep auto-accept but only when `lr_pending_invite` localStorage is set — equivalent to just using the token flow, so redundant; (b) gate auto-accept on signup-event vs every session refresh — narrower, but still silent for the existing-account case which was the main complaint. Chose to remove entirely. Token flow is the single redemption path. The SQL function is intentionally left in place on prod for defensive compatibility with any cached client; safe to drop in a follow-up migration.
- **`accept_invitation` is idempotent for the auto-accept race.** The token-based `accept_invitation` runs *after* the email-based `auto_accept_pending_invitations` in the auth refresh chain. If the user's email matches the invite (which it does for any normal invite flow), auto-accept redeems the row first and then the token-based accept finds `accepted_at` non-null. Original RPC raised "invalid or expired" in this case even though the user was already a member. Fix (0025): look up the row regardless of `accepted_at`, then return success if the caller is already a member of the target account. Considered alternatives — (a) gate the App.jsx token-redemption useEffect on `auth.newlyJoinedAccountIds` being empty (works but only patches the symptom in one client path), (b) drop one of the two redemption paths entirely. Chose the SQL fix because it's robust against any future client path that calls `accept_invitation` on an already-accepted row, not just this one.
- **`remove_team_member` resets `profiles.is_agency` when the last agency membership goes.** The flag was being set on join (in `accept_invitation` since 0002) but never cleared on removal, leaving stale `is_agency=true` rows and putting brand-only users in agency mode after they'd been removed from the agency. Considered: (a) compute `is_agency` on the read path as `memberships.some(m => m.accounts.type === 'agency')` instead of trusting the stored flag — cleanest but a behavior change touching every `auth.isAgency` read and the RLS helper `is_agency_user()`. (b) trigger on `account_members` DELETE that recomputes the flag — broader scope (covers any future delete path). (c) fix the specific RPC. Chose (c) for now because there's only one delete path in the app today; revisit (b) if a second appears. The migration also includes a one-shot backfill for rows that were already in the broken state.
- **Email sending uses one edge function with `template` dispatch, not per-template functions.** Considered separate functions per email type (`send-team-invite`, `send-task-delivered`, etc. — clean isolation). Chose a single `send-email` function that switches on `body.template` because: (a) one Resend client, one set of secrets, one cold-start; (b) shared template-rendering helpers (HTML scaffolding, `escapeHtml`, From/Reply-To logic) live in one file instead of being copy-pasted; (c) we'll add Tier 2 templates (post-plan status, comments) without each one needing its own deploy. Each template still gets its own request shape and its own auth check inside the function — the dispatcher is just a switch, not a `eval`-like surface. As of 2026-05-02 this is a true dispatcher: the `Deno.serve` handler verifies JWT once, then routes to `handleTeamInvite` or `handleAgencyUpdate` based on `body.template`.
- **Agency-update fans out via Resend's batch endpoint (`POST /emails/batch`), not sequential single sends.** Initial implementation called `POST /emails` once per recipient inside a `for` loop. That hit Resend's 2-req/sec rate limit on brands with 3+ members and silently dropped sends — the modal would show "Sent to 1 member" when 3 were expected. Switched to the batch endpoint on 2026-05-02: one HTTP call, N envelopes inside, each with its own `to: [singleEmail]` so per-recipient privacy is preserved. Resend returns `{data: [{id}|...]}` indexed to input order; we map index→recipient to capture per-recipient failures. The function also returns `total` (recipients identified) alongside `sent` so the modal can render "Sent to X of Y" and partial failures are visible immediately. Considered: (a) keeping sequential + adding 500ms sleeps between sends (slow, still risky on free-tier upgrades); (b) single-envelope multi-`to` (leaks addresses); (c) BCC (one envelope, no per-recipient personalization). Batch is the right primitive.
- **`remove_team_member` gates on "caller is owner of the target account", not "caller is agency".** Original 0002 hard-coded `is_agency_user()` as the precondition — workable when only the agency removed people, but the brand-side TeamView UI also exposes a Remove button for brand owners, and that button always errored with "only agency staff can remove team members" when clicked. Considered: (a) leaving the SQL as-is and removing the brand-side Remove button (UX regression — brand owners genuinely want to manage their own team); (b) splitting into two RPCs (`remove_brand_member`, `remove_agency_member`) with different gates. Chose neither — the symmetric rule "you must be an owner of the account you're modifying" works for both sides identically and matches `change_member_role`'s existing pattern. Cross-side removal (agency owner trying to drop a brand member, or vice versa) is naturally blocked because they're not owners of the other side's account. The agency-flag-reset side-effect from 0026 stays in place.
- **URL slug is the source of truth for active brand — brand users included.** App.jsx had a URL→`activeAdminBrandId` sync useEffect for agency users (so `/c/<slug>/...` would switch the picker), but brand users with multiple memberships always landed on whichever brand `localStorage.lr_active_brand_<userId>` remembered. Per-brand deep links (e.g. the "Open Social Calendar" button in agency-update emails) were unreliable — clicking would open the recipient's *last* brand, not the *target* brand. Added a symmetric useEffect for non-agency users on 2026-05-02 that calls `setActiveBrand(match.account.id)` when the URL slug matches one of their memberships and isn't already active. Considered keeping localStorage authoritative and forcing the email link to include a query like `?switch_to=...` instead — rejected because the URL slug is already a clean signal that's consistent with how agency users handle the same case.
- **Duplicate post plan is agency-only at the UI layer too, not just at RLS.** RLS already rejects non-agency `post_plans` INSERTs, but the brand UI used to render the Duplicate affordance (calendar right-click + detail-view button) anyway. That meant brand users saw a button that always errored — bad UX. Considered (a) hiding only the menu item; (b) hiding the entire right-click menu since Duplicate was its only entry; (c) leaving as-is and letting RLS speak. Chose (b): on chips for non-admin users, the right-click handler now early-returns and the browser's native context menu renders instead. Detail-view button is wrapped in `{isAdmin && ...}`. Server-side RLS unchanged — UI gating is defense-in-depth, not the primary boundary.
- **Local-secrets file: only the Supabase PAT lives there; everything else stays in Supabase Edge Function secrets.** Pattern: `.claude/local-secrets.env` (gitignored) holds `SUPABASE_ACCESS_TOKEN=sbp_...` for `supabase functions deploy` / Management API SQL endpoint. The other rotatable keys (Supabase service_role, Firecrawl, Resend) never need to land on disk in this repo — they're written into Supabase via `supabase secrets set` (which uses the PAT) and read from `Deno.env` inside edge functions. Considered putting all four in the local file for "one place to rotate," but service_role / Firecrawl / Resend would just be sitting on disk doing nothing — and a key on disk is a key that can leak. Single-key local file = minimum attack surface for the same operational benefit.
- **Email failure is non-fatal for the invite flow.** If Resend errors out, the `invitations` row already exists and the Copy-link affordance below the invite form keeps working. We changed the flash message based on the email outcome ("Sent an invite to X" vs "Invite created for X, but the email didn't send. Copy the link below…") rather than aborting the whole submission. Reasoning: the row is the source of truth for accept-invite; the email is just delivery convenience. Better to let the user fall back to the manual flow than tell them "invite failed" when actually their teammate can still redeem.
- **`Reply-To` set to the inviter, `From` always `agency@linkrunner.io`.** The visible `From` is the workspace identity (the recipient should see "Linkrunner Media" not a personal address), but replies should thread to the human who actually invited them. Resend allows distinct `from` and `reply_to`, so we use both. The `agency@linkrunner.io` Google Workspace mailbox catches anything not-replies-to-the-inviter (bounces, "wrong person" forwards, etc.).
- **Post plan URLs nest under `/calendar/:id`, not a sibling `/plan/:id`.** Considered (a) sibling — `/c/:slug/calendar` and `/c/:slug/plan/:id` as peers (the original Phase 1/2 shape), (b) nested — `/c/:slug/calendar/:id`. Chose (b): the URL now reflects the UI hierarchy. You enter the calendar at `/c/abcoffee/calendar`, click a chip, and the URL extends to `/c/abcoffee/calendar/a3f9c2d8` — calendar stays in the breadcrumb instead of silently swapping for `plan`. Hard cut, no backward-compat for old `/plan/...` paths since none had been shared externally. The internal route shape (`{view: 'plan', id, brandSlug}`) didn't change — only `parsePathToRoute` and `viewToPath` did, so child components are untouched.
- **BrandPicker replaces shadow-impersonation.** The old `lr_impersonation` sessionStorage flow was a UI-only shadow that left an "agency viewing X" banner across the screen. The new `BrandPicker` makes brand selection a first-class sidebar control for both brand owners and agency users — same control, different option list. Cleaner mental model, no banner, agency state persists across sessions via `localStorage.lr_admin_active_brand`.
- **Same-tab edits use optimistic mutators, not realtime.** Realtime subscriptions are great for cross-tab and cross-user, but the same-tab same-user case (open plan → edit title → navigate back) was eating ~200ms before the calendar chip reflected the change. App.jsx now exposes `upsertPostPlan` / `removePostPlanLocal` / `clearUnreadForPlan` callbacks, passed down to detail and calendar views, that update App-level state synchronously. Realtime is the safety net.
- **Post-plan status changes go through a log table, not the existing `activity` table.** `activity` is task-scoped and its triggers/types are tightly coupled to the brief flow. A standalone `post_plan_status_log` keeps post-plan history isolated, matches the pattern of `post_plan_attachments` / `post_plan_comments`, and makes RLS straightforward.
- **`markPostPlanSeen` after every persist, not just on mount.** Originally it only fired on detail-view mount + tab focus. That left a gap where the viewer's own edit would re-bump `post_plans.updated_at` without re-stamping their `last_seen_at` — generating a phantom unread on their own action. Re-stamping inside `persist()` closes it.
- **Activity feed sorted newest-first.** Matches Slack / Linear / Notion convention; matches the human "what just happened?" mental model when reopening a plan after a few hours.
- **Datetime input persists on blur, not change.** A controlled `value={toDatetimeLocal(scheduledAt)}` re-rendered on every keystroke, kicking the cursor out of whichever date sub-field the user was typing into. Switched to a raw-string `scheduledDraft` state and on-blur persist — input keeps focus while typing through day → month → year → time. Same pattern as the title input.
- **Agency-side BrandKitView reads `accountId` as a prop.** Was originally falling back to `auth.account.id` + a legacy impersonation lookup, which broke completely after the BrandPicker rollout. Now matches the same prop pattern as LibraryView / PerformanceView / TeamView.
- **Library scoping is client-side, not server-side.** RLS already restricts to accessible accounts; an extra DB filter would just complicate the query without security gain. Mirrors the TasksView pattern in App.jsx.
- **Brand deletion uses a SECURITY DEFINER RPC, not a DELETE policy.** Cleaner ownership/type guards in one place; matches the pattern of `remove_team_member` and `change_member_role`.
- **Bot-wall detection is title-based, not content-based.** Real homepages don't have titles like "Something went wrong" — high-precision check, won't false-positive on a site that mentions "Cloudflare" in its footer.
- **Firecrawl `proxy: "auto"` instead of explicit `"stealth"`.** Auto only escalates to stealth (extra credits) when basic mode hits a wall. Pays for robustness only when needed.
- **Date-only fields are formatted via `toLocalIsoDate(d)` in db.js, never `.toISOString().slice(0,10)`.** The latter shifts dates by one day for any user in a positive UTC offset (e.g. IST).
- **Activity rows are written by triggers, not the client.** The `activity` table has SELECT-only RLS; client-side `INSERT` is silently rejected. This was the cause of the chip-edit-not-logged bug fixed in 0019.
- **`window.prompt()` for first-time website URL on Fetch Brand.** Functional, not pretty. Swap for an inline modal when there's time.
- **Phase 1 router: URL-driven routing via a thin adapter.** Migrated from React-state routing (`route.view` + `localStorage.lr_route`) to `react-router-dom@6` on 2026-04-30. Considered a full `<Routes>`/`<Route>` refactor (would have meant changing every `setRoute` callsite — 55 of them across 10 files), and instead chose a minimum-surgical pattern: `route` is derived from `location.pathname` via a tiny `parsePathToRoute` parser, and `setRoute({view, id})` is preserved as an adapter over `navigate(viewToPath(...))`. Net diff in child components: zero. Phase 2 (per-brand URL segments) will add real `<Route>` machinery once it pulls its weight.
- **Short URLs use the first 8 hex chars of the row's UUID, not a separate slug column.** Considered (a) a `display_id` integer counter + migration, (b) a per-row `slug` column generated from the title, (c) shortening the existing UUID. Chose (c): zero DB change, full-UUID URLs still resolve as a fallback, the same rule auto-applies to every new task/plan, and collision math (8 hex chars = 16^8 = 4.3B; ~50% birthday-paradox at ~65k items) leaves enormous headroom for this product's lifetime. `shortenId(uuid)` shortens for the URL, `findFullId(prefix, items)` resolves on render — the rest of the codebase keeps using full UUIDs. Slugs from titles were rejected because edits to a title would break old links and Unicode/duplicate handling adds complexity.
- **404 view uses the same visual language as the Performance hero.** Same radial gradient, serif headline with `<em>` accent treatment, and the existing `.btn-primary btn-lg` / `.btn-ghost btn-lg` button system. Friendly headline ("We don't think you meant *to come here.*") echoes the brand voice rather than going generic-error. The bad pathname is shown verbatim in a code chip so users know where they tried to go. `parsePathToRoute` returns `{view: 'not_found', path}` for any unknown URL; `not_found` is added to the guest-allowed set and both agency-context-snap legal sets so neither effect strips the user away from the 404.
- **Single CSS file (~2500 lines).** All styles in `web/src/styles/app.css`. Inline styles used liberally for one-off card layouts.
- **Conversations table named `conversation_messages`, not `messages`.** The intuitive name `messages` is taken by the legacy task-chat table from migration 0001 — the tasks-table cleanup follow-up that drops it has been pending since the tasks UI was sunset (see §14). Considered (a) renaming the legacy table to `task_messages` in the same migration, (b) using `messages` and dropping the legacy table inline, (c) using a distinct name. Chose (c). Renaming the legacy table inline would couple Conversations PR 1 to the tasks-cleanup risk surface (cascading FKs from `tasks` → `assets` → `messages` etc.), and dropping the legacy table outright before the bake cycle on the sunset UI is bad ordering. `conversation_messages` reads cleanly in code, doesn't require any of those choices, and the table-cleanup PR can rename it to `messages` once the legacy is gone if desired.
- **Conversation attachments reuse the `post-plan-attachments` bucket** (path `<accountId>/messages/<messageId>/<file>`). Considered (a) a new `conversation-attachments` bucket with its own RLS, (b) reusing the existing bucket. The bucket's storage RLS only checks the first path segment matches `accessible_account_ids()` (see migration 0022's `post_plan_attachment_account_id(name)` helper) — `<accountId>/messages/...` slots in cleanly without adding a second copy of the same policies. Trade-off: the bucket name no longer describes everything it stores. Worth it for the simplicity.
- **Soft-delete over hard-delete for message tombstones.** WhatsApp-style "Message deleted" placeholder rather than removing the row. (a) Hard-delete cascades to attachments + breaks thread parents (`parent_message_id` ON DELETE CASCADE), (b) soft-delete preserves the conversation flow + the parent stays clickable. RLS already allows UPDATE on own messages, so soft-delete needs no policy changes. The body is cleared on delete so the original text doesn't leak via the row's `body` column.
- **Dropped FK on `conversation_messages.tagged_post_plan_id` (migration 0043) so deleted plans show a "Plan deleted" tombstone.** With the FK in place + `ON DELETE SET NULL`, deleting a plan nulled the column → bubble silently lost the "this was about plan X" context. Without the FK the orphaned id lingers, and the client renders a greyed-out "Plan deleted" chip when `plansById.get(taggedPostPlanId)` returns null (we load all the brand's plans on mount so a miss means "deleted", not "didn't fetch"). Considered (a) adding a `tagged_post_plan_concept` snapshot column populated at insert time, (b) dropping the FK. Chose (b) — simpler migration, no per-write client work, no concept-string drift if the plan is later renamed.
- **Conversations PR 1 keeps `post_plan_comments` alive instead of dropping it.** The migration backfills every comment row into `conversation_messages` — at that point the legacy table is dead weight. Considered (a) dropping it in 0042 inside the same transaction, (b) leaving it for one bake cycle, (c) leaving it indefinitely until the next time someone touches that area. Chose (b). Deploy-ordering risk is non-trivial (frontend writes go to `conversation_messages` immediately on merge; if the migration fails partway and we have to roll back, having the original rows still present means no data lost — frontend would silently render empty for new comments until the migration re-runs, which is recoverable). Once the new chat UI ships in PR 2 and stabilises for a week, a follow-up migration drops `post_plan_comments`.

---

## 14. Pending work / known issues

- **Conversations follow-ups (next-in-queue / long-tail, after the 2026-05-14 polish pass shipped file attachments + soft-delete + plan-deleted tombstones)**:
  - **Pasted-link previews** — when the user pastes a URL into the composer, auto-fetch `metadata` via Firecrawl `/scrape` on a small Vercel route, store the result on a `message_attachments` row with `kind='link'` and render a clickable link card. Schema already supports it (the `url` column was added in 0042 specifically for this case).
  - **Drag-and-drop file uploads** onto the chat surface (currently only the 📎 picker works). Low-effort layer on top of the existing `addMessageAttachment` plumbing.
  - Drop the legacy `post_plan_comments` table once the new chat UI has baked for a week (see §13 entry on rollback safety).
  - Add `@mention` typeahead inside the composer + Resend Tier 2 emails on mention-received (DMs themselves stay out of scope — see below).
  - **Per-thread unread tracking** — today the sidebar badge counts every non-author message including replies, but there's no per-thread last-seen so the reply-count link doesn't carry an "you haven't read N of these" affordance. Add a `conversation_thread_views(user_id, parent_message_id, last_seen_at)` table when threads start getting heavy use.
  - "📍 Pin to plan" affordance on messages so the admin can curate a small set of decisions on the plan detail page that pulls from the brand chat.
  - Emoji reactions on messages — low-effort, high-signal once the rest is stable.
  - **Explicitly out of scope until users ask**: DMs (1:1 between specific users), group chats, cross-brand agency-internal chatter. The "one chat per brand" model deliberately keeps the surface non-technical-friendly; adding "who am I talking to?" introduces exactly the kind of decision-making a brand user wouldn't expect.
- **Universal cross-surface search** *(roadmap, added 2026-05-11 when the topbar placeholder was removed)*: the topbar previously rendered a non-functional "Search posts, ideas / ⌘K" input which we pulled because shipping placeholder UI for a non-feature damaged trust. Real implementation should hit: post plans (concept, copy variants, status), ideas (body, kicker), brands (name, tagline), members (name, email), live posts (concept, URL, person), library assets (filename). Surfaces: ⌘K modal palette with fuzzy match + grouped sections + keyboard nav. RLS makes this server-cheap (just `or(...)` queries scoped to `accessible_account_ids()`). Defer until either (a) we hit a brand with 100+ plans where scrolling becomes painful or (b) two-plus users explicitly ask. The per-page search inputs in TasksView / LibraryView / LivePostsView / BrandPicker should NOT be removed when this lands — those are scoped, functional, and the user model is "narrow search inside the current surface."
- **Backfill video thumbnails for pre-2026-05-11 uploads** *(script written 2026-05-11, ready to run)*: pre-existing videos in `post-plan-attachments` + `brand-assets` have no sidecar JPEG so the UI tile falls back to a clean play-icon (looks intentional but not as informative as a real frame). One-shot fix exists at [scripts/backfill-video-thumbnails.mjs](scripts/backfill-video-thumbnails.mjs); run via `npm run backfill:video-thumbnails` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set. Uses vendored ffmpeg (`@ffmpeg-installer/ffmpeg`, no system install needed). Idempotent — re-running is safe. Supports `DRY_RUN=1`, `ONLY_BUCKET=...`, `LIMIT=N` flags for testing. Service-role only — RLS bypassed for the listing + uploads.
- **Daily-digest cron reliability — three escalation paths ranked.** Vercel Hobby cron is best-effort against deploy churn (see May 11 18:00 IST miss). Idempotency now makes redundant triggers safe, but the underlying fragility remains. If misses become a pattern, in increasing order of cost/complexity:
  1. **External cron ping** (cron-job.org or GitHub Actions Scheduled Workflow): free, ~5-min granularity, decoupled from Vercel deploys. Pings `/api/daily-digest` at 12:30 + 12:35 UTC daily. Idempotency dedupes. Zero infra changes.
  2. **Supabase `pg_cron` + `pg_net.http_post`**: schedule in Postgres, immune to Vercel entirely. Need the `pg_net` extension + a small SQL function. More integrated with our existing infra.
  3. **Vercel Pro** (~$20/mo): tighter ~5-min cron fire window, plus longer log retention (handy for our cron debugging in general). Easiest, costs money.
  Recommendation: don't act on this until we see a second miss. The first one was a fluke caused by 7 PRs landing in one afternoon.
- **AI Co-pilot PR 8 — Suggest concept** on `ConvertIdeaModal` and the calendar empty-day right-click *(promoted from PR 8 → next-in-queue after PR 7 image prompts shipped 2026-05-11)*. Pre-fills a new plan from a vague idea or a blank Tuesday slot. Will reuse the same instruction-driven preview pattern from PR 5.
- **AI Co-pilot long-tail / backlog**:
  - **A/B 3 variants for copy generation** *(was PR 6, deferred 2026-05-11)*: side-by-side comparison UI generating 3 different angles. Less urgent now that instruction-driven `improve` covers iteration via the Regenerate-with-edited-instruction loop. Revisit if multiple users explicitly ask for side-by-side.
  - Trend → plan auto-suggest (pre-fill `TurnIntoPostPlanModal` from a trend signal). Idea Inbox triage. Recurring series autopilot. Weekly Friday strategy memo. Performance feedback loop (needs `post_plan_publications` analytics piped in first).
- **AI Co-pilot chat persistence**: PR 2 (2026-05-11) keeps chat history in-memory only — resets when the active brand changes or the panel unmounts. Not addressing yet. If users start losing context they care about, add a `copilot_conversations` table keyed by `(account_id, user_id)` with a jsonb `messages` column + an "Open recent chats" affordance in the panel header. Trivial migration, ~50 LOC on the panel side. Defer until someone asks.
- **AI Co-pilot per-account toggle (vs env-var allowlist)**: PR 2 gates rollout via `AI_COPILOT_BRAND_IDS` env var. Once we're past the initial validation phase (multiple brands using it weekly), migrate to either `accounts.ai_copilot_enabled boolean` or a `feature_flags` table so the agency can self-serve toggle without a Vercel env-var deploy. Defer.
- **Auto-downscale oversize images on upload**: today the dimension validator (`web/src/lib/imageValidation.js`) rejects images larger than 8192×8192 / 33MP. A friendlier alternative is auto-resizing via canvas: detect oversize, downscale to fit within the limits, replace the `File` reference, then proceed with upload. Trade-offs: canvas re-encoding silently shifts colour profiles (sRGB assumed), the original is lost unless we keep both, and EXIF/metadata is stripped. Worth doing if support requests pile up but not before. Track when we hear repeat complaints from non-technical users.
- **Daily-digest manual-trigger affordance**: deferred from the 2026-05-08 build. Plan was a `?force=true&accountId=<uuid>&dry_run=true&date=YYYY-MM-DD` set of query params on `/api/daily-digest` so the team can preview a brand's digest HTML without waiting for 18:00 IST or actually mailing anyone. `dry_run=true` returns the rendered HTML + recipient list as JSON instead of calling `send-email`; `date=YYYY-MM-DD` overrides the IST tomorrow-window for previewing future days; `accountId=<uuid>` scopes the run to one brand; `force=true` bypasses any future "already sent today" idempotency check. Auth stays on `CRON_SECRET`, so still gated. Follow-up PR: ~30 LOC additive change to the existing route, no schema work.
- **Agency-side workflow email triggers**: brand-side daily digest shipped 2026-05-08; the agency-side equivalent is on the roadmap as a separate flow, not a sibling of the brand digest. Likely shape: (a) **idea-submitted** notification when a brand drops a new `post_plan_ideas` row (Tier 2 in the Resend integration memory note); (b) **per-day "your morning brief"** email at e.g. 9am IST surfacing what's drafting/needs_review for *today* across all brands the agency lead owns ("4 plans to ship to brand A, 2 awaiting brand B's approval, 1 going live in 2hrs"); (c) **stale plan weekly digest** every Monday flagging plans that have been in Drafting / Needs review for >7 days. All three land as new `template` cases on the existing `send-email` function. Agency-side recipients come from the agency `accounts` membership rather than per-brand `account_members_with_email`. The brand-side digest deliberately excludes Drafting plans (brand can't act on them) — the agency-side digest is where "drafting plans for tomorrow" belongs.
- **Resend Tier 2 — workflow notifications**: not built yet. Tier 1 (invitation emails) shipped 2026-05-01. Tier 2 fans out emails on DB writes via `pg_net` from existing triggers — task delivered, brief assigned, post-plan submitted-for-review / approved / needs-changes / delayed, new comments, new deliverables. See the Tier-2 list in the [Resend integration memory note](.claude/projects/.../memory/project_resend_email_integration.md). All hooks land in `send-email` as new `template` cases.
- **Resend Tier 3 — digests + auth-side replacements**: also not built. Daily/weekly digest of unread post-plan activity (powered by `post_plan_views.last_seen_at`); optionally replacing Supabase's native password-reset / signup-confirm emails with branded Resend versions.
- **Multi-source URL discovery (`discover` / `check_agent` modes)**: deployed in `enrich-brand-kit` but no client wires call them yet. Designed to find socials from a seed URL via Firecrawl Agent.
- **Past creatives image cache**: noted in session memory — IG image fetch + cache to Supabase Storage is deferred until the social asset pipeline is built. `kit.pastCreatives` entries without `imageUrl` are filtered out of the UI (`BrandKitView` line ~1710).
- **Tasks-table cleanup**: this PR cycle's sunset removed the UI surfaces but kept `HomeView.jsx` / `TasksView.jsx` / `TaskDetailView.jsx` / `admin.jsx` (`AdminHome`, `AdminUploadView`) on disk and `tasks` / `assets` / `messages` / `activity` in the DB. Follow-up PR: delete the files + add migration to drop the tables (cascade FKs will wipe related rows). Wait at least one bake cycle before pulling the trigger.
- **Idea-submitted email notifications**: when a brand submits a `post_plan_ideas` row, agency staff currently learn about it only by checking the Inbox. Plug into the existing Resend Tier 2 work — new `template: 'idea-submitted'` case in `send-email`, fanned out to the agency team via `account_members_with_email` for the agency account. Track in the Resend integration memory note.
- **Per-user unread tracking on Inbox**: badge currently counts `status='submitted'` (team-level). Add a `post_plan_idea_views(user_id, idea_id, last_seen_at)` table mirroring `post_plan_views` if multi-staff agencies start stepping on each other.
- **Post plan → Library promotion**: subtitle on the Deliverables card promises "Pushed to Library when marked posted." Trigger isn't wired yet — needs a hook off `post_plans.status = 'posted'` that copies (or links) `post_plan_attachments` of `kind = 'final'` into `assets`.
- **Post plan attachment versioning**: schema has `version int default 1` on `post_plan_attachments` but no UI to bump. Currently each upload is `version = 1` regardless. Revisit when an admin needs to re-deliver after a brand revision request.
- **Status `scheduled` has no button**: `post_plans.status` enum includes `scheduled` (between approved and posted), but no UI surface flips into it. Either add a "Schedule" CTA on approved plans or remove the value from the enum.
- **Realtime publication for `post_plan_views`**: not added in 0022. Doesn't break unread today (App.jsx refetches the view stamps on each refresh tick triggered by comment/attachment/plan events), but means cross-tab "I marked seen in tab A → clear dot in tab B" relies on the next refresh tick rather than firing on the views write itself. Add to publication if cross-tab unread feels laggy.
- **Credential rotations** (see §12).

---

## How to update this doc

When you make a change that affects any section above:

1. Update the relevant section in place.
2. Bump the **Last updated** field at the top.
3. Add an entry to the **Recent changes log** at the very top with date + 1-line summary + which sections were touched.
4. If you renamed something, update the **Glossary** so the search-by-old-name still works.

Treat this like a real production doc — out-of-date is worse than missing.
