# Linkrunner Media Dashboard — Reference

> Single source of truth for what this thing is, how it's built, and how the
> pieces fit together. Updated as the codebase evolves.

**Last updated:** 2026-06-03 (**Engagement: LinkedIn scraper fixed — actor swap + error-classification (RCA fix a+b).** RCA of "Live Posts → LinkedIn shows No metrics in this window": the third-party Apify actor `supreme_coder/linkedin-post` broke ~2026-06-01 (LinkedIn markup change) and now returns HTTP 200 with a dataset item shaped `{error:"Failed to scrape post: Cannot read properties of undefined (reading '0')", inputUrl}` instead of post data — for every LinkedIn URL. LinkedIn was healthy through 2026-05-31 (145→188 reactions etc.). Contributing bug: both `scrapeLinkedIn` implementations only treated an EMPTY dataset (`!item`) as failure, so the 200-with-error-item fell through, read `numLikes/authorName/text` as null, built a null-metric snapshot, and labelled it `partial` — which the UI renders as "No metrics in this window" / "Unknown author" AND which hid the outage from monitoring (snapshot overview showed `failed:0, blocked:0`; the breakage all sat in `partial`). Fix a: both `scrapeLinkedIn` (the Vercel on-demand path `web/api/engagement/scraper-lib.ts` AND the daily-cron Deno edge function `supabase/functions/engagement-refresh/index.ts`) now detect an item with a non-empty `error` field and return `status:"failed"` with the actor message surfaced, so the failure is alertable and distinguishable from a genuinely zero-engagement post. Fix b (the actual restore): swapped the dead `supreme_coder/linkedin-post` → **`apimaestro/linkedin-post-detail`** (no-cookies, accepts a single post URL or activity id) in BOTH `scrapeLinkedIn` implementations + all three `APIFY_USD_PER_SCRAPE` cost maps ($5/1k results). New input is `{post_urls:[cleanUrl]}` (query string stripped); the nested response maps `stats.total_reactions`→like/reaction count, `stats.comments`→comments, `stats.shares`→shares, `author.name`→display name, handle parsed from `author.profile_url` (`/in/<h>` or `/company/<h>/posts`), `author.profile_picture`→avatar, `post.text`→caption, `media[].url`→media, `post.created_at.timestamp`→posted_at. **Verified live 2026-06-03** against Bamboo Bear's 3 real LinkedIn URLs: 13/0/0, 193/14/2 (matches our last good scrape of 188/14/2 + growth), 50/2/1 — handles `drinkbamboobear` / `theshrutimishra` resolved correctly. Secondary finding (latent, NOT fixed): daily cron caps ~20 scrapes/run but Bamboo Bear has 22 live pubs, so LinkedIn lags ~1 day in rotation; raise/scale the cap as volume grows. **The edge function must be redeployed** for the cron to use the new actor (the Vercel on-demand path ships on merge). No prod secret change — the new actor reuses the existing `APIFY_API_TOKEN`. Verified: `tsc` clean on scraper-lib.ts + refresh.ts; mapping validated against the live actor output. Files: `web/api/engagement/scraper-lib.ts`, `supabase/functions/engagement-refresh/index.ts`, `web/api/_shared/usage.ts`. Sections touched: Recent changes log; `Last updated`; §9/§10 engagement scraper + edge functions.)

**Previous update:** 2026-06-02 (**Image-attachment robustness follow-ups (post image-prompting merge).** Two small cleanups after #161/#163/#164 landed. (1) **Unify downscale util:** `AIImagePromptPanel.jsx` had its own inline `downscaleToDataUrl`; removed it and now imports the shared `downscaleImageToDataUrl` from `web/src/lib/imageDownscale.js` (the one the LinkAI composer uses) — single source of truth for the ~1568px-JPEG / 4.5MB-body-limit logic. (2) **Surface failed sends in LinkAI:** the chat error banner was gated on `streamingActiveConv` (which requires `isBusy`), so a pre-stream failure — e.g. an oversized-payload 413 rejected at the edge, which flips status straight to `error` with `isBusy` already false — hid the banner and the message silently vanished. Added a dedicated `errorOnActiveConv` gate (`!!error && (!isPageVariant || sdkConvId === activeConvId)`) that keeps the multi-conversation correctness but drops the `isBusy` requirement, plus a friendly fallback string when `error.message` is empty. Pure client — no schema/server change. Verified: `vite build` clean. Files: `web/src/components/AIImagePromptPanel.jsx`, `web/src/components/LinkAIPanel.jsx`. Sections touched: Recent changes log; `Last updated`.)

**Previous update:** 2026-06-02 (**Fix: LinkAI image attachments 413'd silently — downscale before send.** Sending a LinkAI chat message with image attachment(s) showed "thinking…" then the bubble vanished with no response (text-only requests worked). Root cause (confirmed via Vercel runtime logs — zero `/api/ai/chat` function logs for image requests → rejected at the edge before the function ran): attachments are sent as base64 data URLs inside the JSON request body, and full-size photos exceed Vercel's ~4.5 MB serverless body limit → 413. Fix: shared util `web/src/lib/imageDownscale.js` (`downscaleImageToDataUrl` — canvas resize to ~1568px long edge, JPEG q0.85) wired into `LinkAIPanel.jsx`'s `addFiles` so each attachment shrinks to ~150-400 KB before send. Shipped to prod via PR #163 (independent of the image-prompting PRs). Files: `web/src/lib/imageDownscale.js`, `web/src/components/LinkAIPanel.jsx`. NOTE: `AIImagePromptPanel`'s inline `downscaleToDataUrl` should be refactored to import this shared util.)

**Previous update:** 2026-06-01 (**Image-prompting reference images pivoted to EPHEMERAL per-generation (replaces the persisted PR-2 library).** Reverted the persisted brand-level product-image library (migration 0063, `ProductImagesCard`, `brand_kits.product_reference_images`, `brand-product-images` bucket) in favour of per-generation reference images that are never stored. New migration `0064_drop_brand_kit_product_images` (applied to prod via MCP) drops the column, helper fn, and 4 storage policies; the empty bucket is left (SQL can't DELETE storage.buckets — remove via dashboard). `/api/ai/image` now reads `reference_images: [{dataUrl, mediaType}]` from the request body, validates via `parseReferenceImages` (well-formed `data:image/*;base64`, jpeg/png/gif/webp, cap 3), and passes them to Claude as image parts on both modes; removed the storage-download path + `brand_kits` product-image load + the persisted `db.js` helpers + `ProductImagesCard` in `BrandKitView`. `AIImagePromptPanel.jsx` gets an ephemeral `ProductRefStrip` (up to 3, held in state, **downscaled to ≤1568px JPEG via `downscaleToDataUrl`** to stay under Vercel's ~4.5MB body limit, cleared on reset). **LinkAI chat** needs no change — its composer already sends attached images as AI SDK `file` parts, so asking it for an image prompt with images attached already works. Verified: 0064 applied (column/fn/policies gone, empty bucket remains); `vite build` clean; `tsc --noEmit` clean on image.ts; grep confirms zero leftover persisted refs. Files: `supabase/migrations/0064_drop_brand_kit_product_images.sql`, `web/api/ai/image.ts`, `web/src/lib/db.js`, `web/src/components/BrandKitView.jsx`, `web/src/components/AIImagePromptPanel.jsx`, `web/src/styles/app.css`. Sections touched: Recent changes log; `Last updated`; §6 Data model (`brand_kits` row); §6 Migrations (0063 reverted + new 0064); §10 Storage buckets; §10 `/api/ai/image` (ephemeral reference images).)

**Previous update:** 2026-06-01 (**Image-prompting PR 2 — product reference images fed to Claude via vision.** Builds on PR 1's house style. New migration `0063_brand_kit_product_images`: `brand_kits.product_reference_images jsonb default '[]'` (array of `{id, path, filename, mimeType, sizeBytes, addedAt}`) + PRIVATE Storage bucket `brand-product-images` (path `<accountId>/<ts>_<filename>`, helper `brand_product_image_account_id`, RLS read+write/delete by agency or path-scoped account members). Applied to prod via MCP. New `lib/db.js` helpers: `addBrandProductImage` (validate ≤5MB + dimensions, upload, append to jsonb), `removeBrandProductImage` (remove + best-effort storage cleanup), `getBrandProductImageUrl` (1h signed URL); `mapBrandKitRow` exposes `productReferenceImages`. New `ProductImagesCard` in `BrandKitView` (upload / thumbnail grid via signed URLs / delete; an "AI" badge marks the last 3 that get fed to Claude), AND an inline `ProductRefStrip` uploader at the top of the AI image-prompt panel's compose steps (`AIImagePromptPanel.jsx` + `listBrandProductImages` helper + `.ai-image-prodref*` CSS) so admins can upload mid-prompt — both write the same shared library. `/api/ai/image` now loads the kit's product images, downloads up to **3 most recent** via service-role (`loadProductImages` → Uint8Array), and sends them as AI SDK image parts on BOTH modes (multimodal: images first, then text) with an explicit "these are the ACTUAL product" note; media type restricted to jpeg/png/gif/webp; best-effort so an empty library / failed download degrades to text-only. The PR 1 system prompts were already reference-image-aware, so NO prompt rewrite was needed. Observability: `images=N` on the `[image] usage…` log line + `product_images` in `service_usage_log.meta`. Images sent uncached (would consume the 4th cache breakpoint — future optimization). Verified: migration live (column jsonb default `'[]'`, bucket private, 4 RLS policies); `vite build` clean; `tsc --noEmit` clean on image.ts. Live vision round-trip pending Vercel-preview smoke test on Epigamia (auth-gated; no preview creds locally). Files: `supabase/migrations/0063_brand_kit_product_images.sql`, `web/api/ai/image.ts`, `web/src/lib/db.js`, `web/src/components/BrandKitView.jsx`. Sections touched: Recent changes log; `Last updated`; §6 Data model (`brand_kits` row); §6 Migrations (0062 + 0063); §10 Storage buckets (`brand-product-images`, `brand-invoices`); §10 `/api/ai/image` (product-image vision).)

**Previous update:** 2026-06-01 (**Image-prompting house style — Linkrunner Media guide wired into `/api/ai/image` + LinkAI chat (PR 1 of 2).** Captured the agency's hard-won image-gen prompting playbook (format-first, accurate product proportions, label front-and-centre, no-face defaults, named lighting, camera-style lines, product reference line, category-specific rules) into a single source of truth and routed it through every image-prompting surface. New skill `image-prompting` at [web/src/data/skills/image-prompting/](web/src/data/skills/image-prompting/): `SKILL.md` (curated always-on universal directives, reference-image-aware) + `references/guide.md` (full verbatim guide with templates + category notes). New `skillRegistry.js` exports: `compileImagePromptGuide({ industry, productCategories })` (universal directives + the brand's matching category block), `resolveImageCategory()` (regex maps brand industry/product-categories → Beverages/Food/Fashion/Skincare/Tech; Epigamia → Food verified), plus the `image-prompting` entry in `SKILL_MENU` (loadable in chat with the `guide` reference; menu count now dynamic). `/api/ai/image` injects the house style as a 2nd cached system block on BOTH modes, fetches `brand_kits.industry + product_categories` to pick the category, derives `Target format` from platform (`PLATFORM_FORMAT`: IG → 4:5, LI/X → 16:9), rewrites `SYSTEM_IDEAS` + `SYSTEM_PROMPT_DETAILED` to defer to the house style + be reference-image-aware, and bumps `MAX_TOKENS_PROMPT` 1000 → 1200 for longer lifestyle prompts. `web/vercel.json` adds `includeFiles: "src/data/skills/**"` to `api/ai/image.ts` so the markdown ships in the bundle. The reference-image directives are forward-compatible: **PR 2** (planned) adds product-image upload to the brand kit and feeds the real shot to Claude via vision — no prompt rewrite needed then. Pure prompt/server + new content files — no schema, migration, or env-var work. Verified: `vite build` clean; `tsc --noEmit` clean on image.ts + skillRegistry.js; Node sanity check confirms category routing + extraction for all 5 categories + universal-only fallback. Files: `web/api/ai/image.ts`, `web/src/lib/skillRegistry.js`, `web/vercel.json`, `web/src/data/skills/image-prompting/{SKILL.md,references/guide.md}`. Sections touched: Recent changes log; `Last updated`; §10 `/api/ai/image` (new "Image-prompting house style" subsection + mode descriptions).)

**Previous update:** 2026-06-01 (**LinkAI composer — mobile camera capture + Conversations-style icon layout.** Two changes to the LinkAI page composer (`web/src/components/LinkAIPanel.jsx`, page variant only). (1) Added a camera-capture button (`<input type="file" accept="image/*" capture="environment">` + aperture-icon button, both gated on `useCoarsePointer()`) next to the existing paperclip — touch devices only. It feeds the SAME `addFiles` → in-memory data-URL pipeline as the paperclip and paste/drop (image-only PNG/JPEG/WebP/GIF, 5 MB, 4 max), so a phone user can snap a photo straight into the chat for Claude to see. Mirrors the ConversationsView Composer pattern. Note: LinkAI image attachments remain in-memory for the session and are NOT persisted to Storage (the localStorage breadcrumb strips them on hard reload — unchanged). (2) Restructured the composer row to match Conversations: the textarea now comes FIRST, and the action buttons (attach + camera + Send/Stop) are grouped to its right in a new `.link-ai-page-actions` flex container — previously the paperclip/camera sat to the LEFT of the textarea with Send on the right. Icon buttons resized 40px→32px and Send 40px→32px to match `.conv-composer-icon-btn` / `.conv-composer-send`. CSS: `web/src/styles/app.css` (new `.link-ai-input--page .link-ai-page-actions` rule; `.link-ai-attach-btn` 40→32px + radius 8→6px; page-row `.link-ai-send` 40→32px). Pure client + CSS — no schema, migration, env-var, or server work. The drawer/compact composer variant is untouched (it has no attachments by design). Verified: `vite build` clean + HMR applied without error; live screenshot not possible (both LinkAI and Conversations sit behind authenticated routes with no preview credentials). Files: `web/src/components/LinkAIPanel.jsx`, `web/src/styles/app.css`. Sections touched: Recent changes log; `Last updated`; §15 Mobile UX.)

**Previous update:** 2026-05-28 (**Billing v1 — payment-request inbox at `/c/:slug/billing`.** New per-brand surface for handling Razorpay-mediated retainer + ad-hoc invoicing. Agency creates payment requests (title, amount in USD or INR, Razorpay payment-link URL, optional due date), brand sees them as Outstanding rows with a `Pay now ↗` button that opens the Razorpay link in a new tab. Agency marks paid + uploads the invoice PDF, which the brand can download from Payment history via signed URL (1h TTL). No plans/tiers in v1 — each request is independent. New table `brand_payments` (migration 0062, with the explicit-GRANT convention) + private Storage bucket `brand-invoices` (path `<account_id>/<payment_id>/<filename>`). RLS: agency full CRUD, brand SELECT-only on own brand. New nav entry in `Sidebar.jsx` secondary group (`receipt` icon), new view in `App.jsx`, new helpers in `lib/db.js` (loadBillingForAccount, createPayment, markPaymentPaid, updatePayment, voidPayment, uploadInvoiceFile, getInvoiceDownloadUrl), new `lib/format.js` (formatMoney, formatDateShort), four new components (`BillingView`, `NewPaymentRequestModal`, `MarkPaidModal`, `EditPaymentModal`). Verified: migration applied; RLS confirmed via role-impersonation in three scenarios (agency sees 3 Epigamia rows, Epigamia member sees 3, Bamboo-only owner sees 0); brand-member INSERT denied by policy; `vite build` clean; `.app` grid byte-stable at 1440×900 (`232px 1208px`); zero console errors on dev server.)

**Previous update:** 2026-05-28 (**Mobile rollout COMPLETE — PR 4: final polish (PWA meta, landscape, narrow-viewport tweaks).** Closes out the 4-PR mobile rollout. Three small additions: (1) iOS PWA meta tags in `web/index.html` — `theme-color` (light/dark), `apple-mobile-web-app-capable: yes`, `apple-mobile-web-app-status-bar-style: default`, `apple-mobile-web-app-title: "L+R Media"`, `application-name`. When a user "Adds to Home Screen" from mobile Safari / Chrome, the dashboard now launches as a standalone PWA with proper status-bar tinting (cream `#F9F7F2` in light mode, ink `#0F0E0C` in dark mode) and a clean app title instead of the document title. (2) Landscape orientation cap on bottom-sheet modal heights — `@media (max-height: 500px) and (orientation: landscape)` caps `.modal` and `.login-modal` at `max-height: 90dvh` so they don't go nearly-full-screen on the ~375px-tall iPhone landscape. The modal body's existing `overflow-y: auto` keeps the content scrollable inside the cap. Tablet landscape (≥~1024×768) is unaffected. (3) Ultra-narrow viewport polish at ≤360px — `.page-head h1` drops from 32px → 28px so it doesn't overwhelm a 320px viewport, `.cal-filter-pill` padding tightens further, `.view` padding crunches another notch. Targets iPhone SE 1st-gen and small Android devices. **Deferred from PR 4 to future cleanup**: bottom-sheet drag-to-dismiss gesture (pure delight, modals already close via X / scrim tap) and unifying `.modal-scrim` + `.login-modal-backdrop` classnames (risky refactor with no user-visible benefit). Both are documented as known future polish in the §15 Mobile UX roadmap. **Status: mobile rollout done.** Desktop layout above 980px stays byte-stable (verified at 1440×900: `.app` grid `232px 1198px`, PWA meta tags read correctly, zero console errors). Full mobile experience shipped over PR 1, PR 2, PR 2.5, PR 2.6, PR 2.7, PR 2.8, PR 2.9, PR 3, PR 4 — 9 PRs total, ~1900 LOC across CSS + JSX + the `useCoarsePointer` hook + `CopyButton` primitive + REFERENCE.md docs.)

**Previous update:** 2026-05-28 (**Mobile rollout — PR 3: touch interaction polish.** Five touch-ergonomic fixes layered on top of PR 1/2/2.5–2.9 work. (1) Camera-capture button (`accept="image/*" capture="environment"`) added alongside the paperclip in the ConversationsView shared Composer (used by both the main feed + thread drawer) AND the PostPlanDetailView AttachmentSection (references + deliverables uploaders). Mirrors the IdeateView pattern from PR 2 — brand users can snap a reference photo into a chat or post-plan attachment directly from the rear camera; agency staff at a shoot can attach a deliverable photo without going through the photo library. Coarse-pointer gated so the button only renders on touch devices. (2) Composer hint copy ("⌘↩ to send · paste or drop an image to attach") and similar `⌘↩` / drop-image hints hidden on coarse-pointer — both affordances are desktop-only (no Cmd on mobile, no drag gesture on touch) so the hint reads as broken instructions. Class targets: `.conv-composer-hint`, `.link-ai-page-hint`, `.link-ai-hint`. (3) All `.kbd-hint` keyboard-shortcut labels (⌘⇧L, ⌘↩, Esc) hidden on coarse-pointer — they suggest shortcuts that mobile keyboards can't produce. Note: the ⌘⇧L theme-toggle "shortcut" never had an actual keydown listener anywhere in the codebase — the label was visual cruft. The "Dark theme" menu item in the user-menu remains the canonical path. (4) Transform-based `:hover` lifts on five cards (`.project-card`, `.lib-tile`, `.pf-swatch`, `.sidebar-login-btn`, `.cal-week-card`) reset to `transform: none` under `@media (hover: none) and (pointer: coarse)` — iOS Safari keeps `:hover` styles applied after a tap until the user taps elsewhere, leaving these cards visibly "lifted" until the next tap. Targeted list rather than nuking all hover effects globally (color/background swaps don't have the same stick-after-tap problem and are intentionally preserved). (5) No new dependencies; all changes additive via existing `useCoarsePointer()` hook + new `@media (hover: none) and (pointer: coarse)` blocks. Desktop layout above 980px stays byte-stable (verified at 1440×900: `.app` grid `232px 1198px`, `.kbd-hint` shows `inline`, `.conv-composer-hint` shows `block`, zero console errors).)

**Previous update:** 2026-05-28 (**Mobile rollout — PR 2.5: real-device feedback fixes.** Eight fixes from the user's Android smoke-test of PR 2: (1) list-row text was wrapping one-letter-per-line because the desktop grid template (`100px auto minmax(0,1fr) auto auto auto`) leaves ~40px for the title at 375px width — redone as a 2-row grid-areas layout (`time | title | status` / `plats | stats | lead`); (2) mobile agenda now uses week-view navigation instead of month — new `weekScoped` derived state filters ListView to a single week (Sun-anchored), prev/next arrows step by 7 days, heading shows "Week of MMM D" + empty-state copy adapts; (3) new `<CopyButton>` primitive exposed from primitives.jsx with copy + check icon swap, wired into each per-platform copy textarea on PostPlanDetailView (both edit-mode footer and read-mode card top-right) AND each plan-preview variant in the LinkAI artifact pane; (4) iOS/Android keyboard scrolling the entire feed up — fixed by adding `interactive-widget=resizes-content` to the viewport meta so the layout viewport shrinks when the soft keyboard opens (Chrome 108+ / iOS 16.4+) instead of overlaying the content; (5) LinkAI on mobile now has a "Chats" + "New" header — the history rail (which PR 2 hid) re-emerges as a left-anchored slide-in overlay toggled by the new header's Chats button (tap-row or scrim to close), with the rail's existing "+ New chat" button also closing the sheet on click; (6) reversed PR 2's Enter-sends-on-touch behaviour — Enter always inserts a newline now (across desktop + mobile, both Conversations and LinkAI composers), users must tap Send (matches WhatsApp / native iMessage convention better than the Slack-web hybrid); Send buttons sized up to 40px height on phone; (7) BrandKitView's many inline `grid-template-columns: 1fr 1fr` / `repeat(3,1fr)` / `180px 1fr` cards collapse to single column at ≤640px via attribute selector + !important on `.view .card [style*="grid-template-columns"]` (only way to beat React inline styles without className-ifying every grid); generic `.card-head` also stacks title above primary-action; (8) Brand notes card: row stacks vertically on phone with body full-width above meta strip (was crashing into a narrow column on desktop's side-by-side layout); meta is always-visible on touch (no hover entry point); action buttons sized to 32px tap target. Plus belt-and-suspenders `window.addEventListener('resize', ...)` alongside matchMedia change on the CalendarView narrow detector — programmatic resize tools sometimes skip matchMedia events. Verified by fresh-load at desktop (1440px — `.app` grid `232px 1208px`, segmented control visible, Month active, heading "May 2026", hamburger hidden) and phone (375px — week-range heading, agenda renders without text-wrap bug, filter pills wrap). Zero console errors at either viewport.)

**Previous update:** 2026-05-28 (**Mobile rollout — PR 2: per-surface mobile layouts.** Built on PR 1's shell. CalendarView swaps to the existing `.cal-list` agenda renderer at ≤640px (via `useCoarsePointer()` OR a new `isNarrow` viewport-width hook — OR'ing both means Chrome devtools mobile-emulation also triggers the agenda, not just real touch devices). Month/Week segmented control hidden at ≤640px since the toggle is now irrelevant. PostPlanDetailView: page-head stacks to column, copy-tab strip becomes a snap-scrolling horizontal row at ≤640px (new `.copy-platform-tabs` class hook), AttachmentCard edit-pencil always visible on coarse-pointer. ConversationsView: new visible `…` overflow button on own messages opens the existing right-click context menu (hidden on desktop until hover, always visible on coarse-pointer); composer Enter sends on coarse-pointer with Shift+Enter for newlines (matches WhatsApp/Slack mobile); composer icon buttons sized up to 36px on phone. LinkAIPanel: same Enter-sends behaviour as Conversations; history rail hidden at ≤640px (single ongoing chat on phone — multi-conv switching is desktop-only for v1). IdeateView: new camera capture button alongside the existing paperclip on coarse-pointer (`accept="image/*" capture="environment"` so it triggers the device rear camera directly). MarkAsPostedModal: sticky footer for the action row at ≤640px so the Save CTA stays reachable while the body scrolls; URL inputs `scrollIntoView({block:'center'})` on focus so the mobile keyboard doesn't cover them. LivePostsView's MasonryGrid already auto-collapses to 1 column on phones via its ResizeObserver. Verified by resizing through 1440px (sidebar 232px sticky, Month active, segmented control visible — desktop byte-stable) and 375px (segmented hidden, agenda list, no horizontal scroll, no console errors). PR 3 is touch polish (hover-rule guards, drag-drop copy hidden); PR 4 is the final pass (drag-to-dismiss, iOS PWA meta).)

**Previous update:** 2026-05-28 (**Mobile shell — PR 1 of the phased mobile rollout.** The dashboard is now navigable on phones + tablets. Off-canvas sidebar drawer triggered by a new hamburger in `.topbar`, full-screen sheet modals at ≤640px, `100vh` → `100dvh` dual-value swaps at nine sites for iOS Safari, `viewport-fit=cover` so safe-area envs populate, `useCoarsePointer()` hook for touch-detection. Strategy is *additive*: every change is layered through new media-query blocks and `if (isCoarsePointer) { … }` branches that return false on desktop, so desktop layout above 980px stays byte-stable. New §15 Mobile UX section documents the breakpoint scheme, drawer pattern, and PR 2-4 roadmap.)

**Previous update:** 2026-05-26 (**Supabase: adopt explicit-GRANT convention for new public-schema tables ahead of the 2026-10-30 platform default flip.** Supabase emailed announcing that on 2026-10-30 existing projects (us) will start enforcing a security-first default for the Data API: new public-schema tables created from that date will NOT be exposed to the Data API unless an explicit `GRANT ... ON public.foo TO authenticated` is added in the migration. Tables that exist on Oct 30 are grandfathered and unaffected — all 61 current migrations + every table they create stay working forever with zero changes. Production is safe today and stays safe. The only impact is on future migrations: any new public-schema table that needs client-side query access must include the GRANT alongside the RLS-enable + policies, or `supabase.from('foo')...` will silently fail with a PostgREST "relation does not exist" error. Adopting the convention NOW (5 months ahead of the cutoff) so we don't have to remember the date later — every migration written from this point on includes the GRANT. Service-role-only tables (telemetry / audit / scraper-write paths — see `service_usage_log`, `daily_digest_log`, `slack_notify_log` for the pattern) skip the GRANT since service_role bypasses Data API restrictions. Pure doc + convention change — no code, no migration, no env-var work. Action item for the user: optionally run Supabase dashboard → Database → Security Advisor once before Oct 30 to audit which tables are currently exposed (RLS should already restrict appropriately, but worth eyeballing). Sections touched: Recent changes log; `Last updated`; §6 Data model > Migrations (new "Convention going forward" subsection documenting the GRANT pattern + template).)

## Recent changes log

### 2026-06-01 — LinkAI composer: mobile camera capture + Conversations-style icon layout

**Brought the LinkAI page composer in line with the Conversations composer on two fronts.** The user asked for the Conversations "open the camera and upload an image" capability in LinkAI, and for the LinkAI chat bar's icon layout to match Conversations.

**1. Mobile camera button.** LinkAI already supported image upload via the paperclip, clipboard paste, and drag-drop (PR C2). What it lacked was the dedicated rear-camera button Conversations has. Added a second hidden `<input type="file" accept="image/*" capture="environment">` + aperture-icon button, both gated on `useCoarsePointer()` so they only render on touch devices. The camera input's `onChange` funnels into the existing `addFiles` pipeline (resets `value` after so the same shot can be retaken), so captured photos behave identically to paperclip/paste/drop attachments — image-only whitelist (PNG/JPEG/WebP/GIF), 5 MB per file, 4 per message, in-memory data URLs only (not persisted to Storage; the localStorage breadcrumb still strips attachments on hard reload — unchanged by design).

**2. Composer icon layout matched to Conversations.** Previously LinkAI put the paperclip (and now camera) to the LEFT of the textarea with Send on the right. Conversations groups ALL buttons to the right of the textarea in a `.conv-composer-actions` container. Restructured `.link-ai-page-row` so the textarea comes first, followed by a new `.link-ai-page-actions` flex group holding attach + camera + Send/Stop. Resized the icon buttons (`.link-ai-attach-btn`) from 40px→32px (radius 8→6px) and the page-row Send from 40px→32px to match `.conv-composer-icon-btn` / `.conv-composer-send`.

Only the **page** composer variant is affected; the drawer/compact variant has no attachment affordances and was left alone.

Files: `web/src/components/LinkAIPanel.jsx` (camera ref + input + button; row restructure into `.link-ai-page-actions`), `web/src/styles/app.css` (new `.link-ai-page-actions` rule; `.link-ai-attach-btn` + `.link-ai-send` resize). Pure client + CSS — no schema, migration, env-var, or server work. Verified: `vite build` clean, HMR applied without error. Live screenshot not possible — both surfaces require auth and no preview credentials were available. Sections touched: Recent changes log; `Last updated`; §15 Mobile UX.

### 2026-05-28 — Billing v1: payment-request inbox at `/c/:slug/billing`

**New per-brand surface for handling Razorpay-mediated retainer + ad-hoc invoicing.** No plans/tiers in v1 — just a flat list of payment requests per brand. Agency posts the Razorpay payment link, brand clicks through to pay, agency uploads the invoice afterwards for the brand to download.

**Flow:**
1. Agency creates a Razorpay payment link in Razorpay (out-of-band).
2. Agency opens `/c/:slug/billing` → `+ New payment request` → pastes title, amount + currency (USD or INR), the Razorpay link URL, optional due date.
3. Brand opens the same page, sees the request under **Outstanding** with a `Pay now ↗` button that opens the Razorpay link in a new tab.
4. After payment, agency clicks `Mark paid` on the row → captures `paid_at` + optional reference note + optionally attaches the invoice PDF (drag-drop or file picker, PDF/image, ≤10 MB).
5. The row moves to **Payment history**. Brand can `Download invoice ↓` (1h-TTL signed URL).
6. Missed the invoice upload at mark-paid time? `Upload invoice` button on the history row uploads it later. `Replace invoice` to swap.

**New table — `brand_payments`** (migration `0062_brand_payments`):
- `id, account_id, title, description, amount, currency('USD'|'INR'), payment_link_url, status('outstanding'|'paid'|'voided'), due_on, issued_on, paid_at, paid_note, invoice_file_path, invoice_file_name, internal_notes, created_at, updated_at, created_by`.
- Indexes on `(account_id, status, issued_on desc)` and `(account_id, created_at desc)`.
- `updated_at` trigger.
- RLS: agency full CRUD; brand SELECT-only on rows where `account_id in accessible_account_ids()` (matches `brand_kit_notes` pattern from migration 0052).
- Explicit `GRANT … TO authenticated` per the 2026-10-30 convention.

**New Storage bucket — `brand-invoices`** (private):
- Path: `<account_id>/<payment_id>/<timestamp>_<filename>`.
- Helper `public.brand_invoice_account_id(name)` extracts the account_id from the path for RLS.
- Read: agency or any brand member of `<account_id>` can read (matches the bucket gate).
- Write/update/delete: agency only.
- Downloads use signed URLs (`createSignedUrl`, 1h TTL).

**New files:**
- [supabase/migrations/0062_brand_payments.sql](supabase/migrations/0062_brand_payments.sql)
- [web/src/lib/format.js](web/src/lib/format.js) — `formatMoney(amount, currency)` + `formatDateShort(iso)`
- [web/src/components/BillingView.jsx](web/src/components/BillingView.jsx) — page-head + three sections (Outstanding / Payment history / Voided) + UploadInvoiceModal co-located
- [web/src/components/NewPaymentRequestModal.jsx](web/src/components/NewPaymentRequestModal.jsx)
- [web/src/components/MarkPaidModal.jsx](web/src/components/MarkPaidModal.jsx)
- [web/src/components/EditPaymentModal.jsx](web/src/components/EditPaymentModal.jsx)

**Files touched:**
- [web/src/lib/db.js](web/src/lib/db.js) — new billing data layer at the bottom: `loadBillingForAccount`, `createPayment`, `updatePayment`, `voidPayment`, `deletePayment`, `markPaymentPaid`, `uploadInvoiceFile`, `getInvoiceDownloadUrl`.
- [web/src/components/Sidebar.jsx](web/src/components/Sidebar.jsx) — new `{ key: "billing", label: "Billing", icon: "receipt" }` in the `secondary` nav (between Performance and Team). Visible to both brand owners and agency-in-a-brand because the `buildBrandNav` function runs the same for both.
- [web/src/components/Icon.jsx](web/src/components/Icon.jsx) — new `receipt` glyph (stylised invoice with three text lines).
- [web/src/App.jsx](web/src/App.jsx) — `billing` added to `SIMPLE_VIEWS` + `BRAND_SCOPED_VIEWS`, `parsePathToRoute` recognises `/billing` and `/c/:slug/billing`, page-head resolver, view-render switch wires `<BillingView accountId={…} isAgency={…} authUserId={…} />`.

**Why this shape (vs. a Stripe-style SaaS billing):** the agency negotiates retainers per brand and most clients prefer Razorpay payment links + emailed invoices. Building Stripe subscription / dunning would be premature — manual links + uploaded PDFs match how invoicing actually works today.

**Why no plans/tiers:** explicit user direction. Each payment request stands alone. If/when plan-tier logic is added later, it can hang off `brand_payments` via a `plan_id` FK without breaking existing rows.

**Currency policy:** USD or INR per row. There's no `default_currency` on the brand today — agency picks at request-creation time. If currency selection becomes annoying ("I always pick INR for Bamboo Bear"), add `default_currency text` to `accounts` and pre-select in the modal. Not worth a column for v1.

**Verification:**
- Migration applied via `mcp__supabase__apply_migration` — table + 4 RLS policies + storage bucket + 4 storage policies confirmed.
- RLS confirmed via role-impersonation (`set role authenticated` + `set_config('request.jwt.claims', ...)`) for three sessions:
  - Agency user (`0ba7920b…`) → sees 3 Epigamia rows.
  - Epigamia member (`3e0660dd…`) → sees 3 Epigamia rows.
  - Bamboo-only owner (`d569da3d…`) → sees 0 Epigamia rows (cross-brand isolation works).
- Brand-member INSERT denied by policy (count stays at 3 after attempted insert).
- Seed: 3 payments for Epigamia in the live DB (one outstanding-with-link, one outstanding-no-link, one paid-with-invoice-stub).
- `vite build` clean (the only warnings are the pre-existing >500KB chunk warnings on `wasm`, `cpp`, `mermaid`, etc. — unrelated).
- Dev server clean: zero console errors at fresh load, `.app` grid stable at `232px 1208px` at 1440×900 (matches the post-PR-2.5 baseline).
- Live agency-UI verification (sidebar entry visible, outstanding rows render, modals open, Mark-paid + Upload-invoice flows) is gated on user-side auth — to be done by the user in a Vercel preview deploy of this branch.

**Known v1 limitations / future work:**
- No reminder emails when due_on slips into overdue (could hook into the existing daily digest cron — `daily-digest` already runs at 6pm IST).
- No bulk-mark-paid (rare use case at v1 brand counts).
- Brand cannot dispute / message about an invoice from this page — they'd use the existing `/c/:slug/conversations` thread.
- `internal_notes` is excluded from brand reads by RLS column-level filtering — currently relies on the brand client not selecting `internal_notes` explicitly (the BillingView never reads it for brand users). For a true belt-and-suspenders fix, swap the table for a SECURITY DEFINER view that excludes the column. Not worth it today — the brand-side BillingView code path never references the field.

**Sections touched:** Recent changes log; `Last updated`; §6 Data model > Tables (new `brand_payments`); §6 Migrations (new 0062 entry); §10 Storage buckets (new `brand-invoices`); §15 sidebar nav documentation if/when that exists.

### 2026-05-28 — Mobile rollout COMPLETE — PR 4: final polish (PWA meta, landscape, narrow-viewport)

**Closes out the 4-PR mobile rollout.** Three small additions. All additive — desktop layout above 980px stays byte-stable.

**1. iOS PWA meta tags.** [web/index.html](web/index.html) gains: `theme-color` (light variant `#F9F7F2` + dark variant `#0F0E0C` via `media="(prefers-color-scheme: ...)"`), `apple-mobile-web-app-capable: yes`, `apple-mobile-web-app-status-bar-style: default`, `apple-mobile-web-app-title: "L+R Media"`, `application-name: "L+R Media"`. When a user "Adds to Home Screen" from mobile Safari / Chrome, the dashboard launches as a standalone PWA with proper status-bar tinting and a clean app title (instead of the long `"Linkrunner Media — Creative Agency"` document title spilling onto the home screen).

**2. Landscape orientation cap on bottom-sheet modals.** New `@media (max-height: 500px) and (orientation: landscape)` block caps `.modal` and `.login-modal` at `max-height: 90dvh`. Without this, the bottom-sheet modals slide up to nearly full-screen on iPhone landscape (~375px viewport height) which loses the orientation context. Tablet landscape (≥~1024×768) is unaffected since `max-height: 500px` doesn't match there. The modal body's existing `overflow-y: auto` keeps the content scrollable inside the cap.

**3. Ultra-narrow viewport polish at ≤360px.** New `@media (max-width: 360px)` block — `.page-head h1` drops from 32px → 28px so it doesn't overwhelm a 320px viewport, `.cal-filter-pill` tightens to `padding: 3px 8px; font-size: 12px`, `.view` horizontal padding crunches another notch via `--space-3`. Targets iPhone SE 1st-gen and small Android devices.

**Deferred from PR 4 to future cleanup (documented in §15 Mobile UX roadmap):**
- Bottom-sheet drag-to-dismiss gesture (~80 LOC pointer-event hook). Modals already close via X button or scrim tap; the drag gesture is pure delight, not load-bearing.
- Unifying `.modal-scrim` and `.login-modal-backdrop` into one class. Risky refactor — both classes power different modal mounts across the app (LoginModal, BrandOnboardingModal, ConvertIdeaModal, MarkAsPostedModal, TurnIntoPostPlanModal, UpdateBrandModal, CreateBrandModal, etc.) with subtly different padding + animation timings. Zero user-visible benefit from unification. Document as known cleanup; touch if/when adding a new modal that surfaces the duplication.

**Mobile rollout status: COMPLETE.** Full mobile experience shipped across 9 PRs:
- PR 1 — Off-canvas drawer shell, sheet modals, safe-area, `useCoarsePointer` hook
- PR 2 — Per-surface layouts (CalendarView agenda, PostPlanDetailView, ConversationsView, LinkAI, IdeateView, MarkAsPostedModal, LivePostsView)
- PR 2.5 — 8 fixes from first Android smoke-test (list-row text bug, week-view nav, copy buttons, keyboard scroll, LinkAI history, Enter newlines, BrandKit, Brand notes)
- PR 2.6 — CSS cascade order bugs (mobile header + BrandKit grid)
- PR 2.7 — LinkAI rail unclamped (was capped to 180px by legacy 720px rule)
- PR 2.8 — Chat-rail close button + Chats icon disambiguation
- PR 2.9 — User-menu containment inside drawer
- PR 3 — Touch polish (camera capture in Conversations + PostPlanDetail uploaders, hide ⌘↩/kbd-hint labels, stuck-hover transform resets)
- PR 4 — Final polish (PWA meta, landscape, narrow-viewport)

~1900 LOC total across CSS + JSX + new primitives (`useCoarsePointer` hook, `<CopyButton>` component) + REFERENCE.md docs.

**Verified at desktop 1440×900:** `.app` grid `232px 1198px`, PWA meta tags read correctly (`theme-color: #F9F7F2`, `apple-mobile-web-app-capable: yes`, `apple-mobile-web-app-title: "L+R Media"`), zero console errors.

**Sections touched:** Recent changes log; `Last updated`; §15 Mobile UX (PR 4 items move to "shipped", roadmap section closes out with the deferred cleanup items).

### 2026-05-28 — Mobile rollout — PR 3: touch interaction polish

**Five touch-ergonomic fixes** layered on top of PR 1/2/2.5–2.9 work. All additive via the existing `useCoarsePointer()` hook and new `@media (hover: none) and (pointer: coarse)` CSS blocks. Desktop layout above 980px stays byte-stable.

**1. Camera capture extended to ConversationsView Composer + PostPlanDetailView attachment uploaders.** The IdeateView camera button pattern from PR 2 (paperclip alongside `accept="image/*" capture="environment"` input, both gated on `isCoarsePointer`) now also appears in:
- The shared `Composer` component in [ConversationsView.jsx](web/src/components/ConversationsView.jsx) — propagates to both the main feed composer mount AND the thread-drawer composer mount via the single component definition. Brand users can snap a reference photo straight into a chat with their agency; agency staff can document something visually mid-conversation.
- The `AttachmentSection` component in [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) — used by both the references uploader (brand-side) and the deliverables uploader (agency-side). Agency staff at a shoot can attach a deliverable photo directly without the library round-trip; brand users on the go can add a reference image.
- Same `e.target.value = ''` reset pattern so the input fires `onChange` even when the same file is re-selected.

**2. Composer hint copy hidden on touch.** `.conv-composer-hint` ("⌘↩ to send · paste images to attach") and `.link-ai-page-hint` ("⌘↩ to send · paste or drop an image to attach") + `.link-ai-hint` all hidden under `@media (hover: none) and (pointer: coarse)`. Both hints describe desktop-only affordances — mobile keyboards have no Cmd, and touch has no drag gesture. The visible Send button + paperclip + camera buttons are enough on mobile.

**3. `.kbd-hint` shortcut labels hidden on touch.** Every kbd-hint span (⌘⇧L theme toggle, ⌘↩ send, Esc close, etc.) is hidden globally on coarse-pointer. Mobile keyboards can't produce these modifier combos so the hints are misleading. Discovered while researching this task: the ⌘⇧L theme-toggle "shortcut" never had an actual `keydown` listener in the codebase — the label in Sidebar.jsx was visual cruft suggesting a shortcut that wasn't wired up. The "Dark theme" menu item remains the canonical theme-switch path.

**4. Transform-based hover lifts reset on touch.** iOS Safari keeps `:hover` styles applied after a tap until the user taps elsewhere — transform-based lifts (`translateY(-1px)` or `scale(1.08)`) end up visually frozen in the lifted state, looking permanently hovered. Listed five known offenders explicitly so the override stays surgical: `.project-card:hover`, `.lib-tile:hover`, `.pf-swatch:hover`, `.sidebar-login-btn:hover`, `.cal-week-card:hover` all get `transform: none` under coarse-pointer. Color/background hover swaps don't have this problem (they reset on next interaction without leaving a visible artifact) and are intentionally preserved. The inline comment in app.css warns: if a new transform-on-hover gets added later, add it to the override list too.

**Files touched:** [web/src/components/ConversationsView.jsx](web/src/components/ConversationsView.jsx) (+15 LOC: cameraInputRef + camera button), [web/src/components/PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) (+30 LOC: cameraRef + camera button in AttachmentSection), [web/src/styles/app.css](web/src/styles/app.css) (+35 LOC: three new coarse-pointer rule blocks).

**Verified at desktop 1440×900:** `.app` grid `232px 1198px`, `.kbd-hint` evaluates to `inline`, `.conv-composer-hint` evaluates to `block`, zero console errors. Coarse-pointer rules don't fire on desktop (which is correct — `(hover: none) and (pointer: coarse)` is only true on touch). Chrome devtools mobile-emulation doesn't trigger coarse-pointer either, so the rules are only observable on real Android/iOS — verified textually that the rules are syntactically valid and the page parses + serves cleanly.

**Sections touched:** Recent changes log; `Last updated`; §15 Mobile UX (PR 3 items move from "planned" to "shipped" in the roadmap section).

### 2026-05-28 — Mobile rollout — PR 2.5: real-device feedback fixes

**Eight fixes from the user's Android smoke-test of PR 2.** All additive to PR 2's surface work, layered through the existing `@media (max-width: 640px)` block + `useCoarsePointer()` hook. Desktop layout above 980px stays byte-stable.

1. **List-row text breaking one-letter-per-line (the worst regression).** PR 2's `.cal-list-row` override used `flex-wrap: wrap; flex-basis: 100%`, but `.cal-list-row` is a `display: grid` container — flex properties did nothing. The original grid (`100px auto minmax(0,1fr) auto auto auto`) leaves ~40px for the title at 375px width, and `word-break: break-word` then collapses long text to one letter per line. **Fix**: redo as a 2-row grid-areas layout at ≤640px — `"time title status" / "plats stats lead"` with `grid-template-columns: auto 1fr auto`. Title now gets a full row with the natural reading width.

2. **Mobile agenda navigates by week instead of month.** PR 2 used the existing `.cal-list` agenda renderer (which shows a whole month grouped by week). Scrolling four weeks at a time on a phone is too much. **Fix**: new `weekScoped` derived state in CalendarView (`weekScoped = forceList = isCoarsePointer || isNarrow`). When true, ListView filters `monthPosts` to a single week (Sun-anchored via `startOfWeek`); `goPrev/goNext` step by 7 days; heading shows `formatWeekRange(weekStart)` → e.g. "May 24–30, 2026"; empty-state copy adapts ("No posts the week of May 24" + "browse another week"). Plus a `window.addEventListener('resize', update)` listener alongside the matchMedia change subscription on `isNarrow` — preview-tool programmatic resizes sometimes skip matchMedia events.

3. **One-click Copy buttons on every copy textarea.** New `<CopyButton text=... />` primitive exposed from [primitives.jsx](web/src/components/primitives.jsx) — `navigator.clipboard.writeText` with selection-trick fallback (lifted from `AIImagePromptPanel.jsx`), shows a tick + "Copied" pill for 1.6s then reverts. Wired into PostPlanDetailView in two spots — edit-mode footer (copies the current draft) AND read-mode card top-right floating button (copies the saved copy, click is stop-propped so it doesn't bubble to enter-edit-mode). Also wired into each plan-preview variant in the LinkAI artifact pane head (copies the variant body). New "copy" icon in [Icon.jsx](web/src/components/Icon.jsx). CSS: `.copy-btn` ghost-style chip + `.copy-btn--copied` green confirm state.

4. **iOS/Android keyboard pushing the whole feed up.** Default soft-keyboard behaviour overlays the visual viewport — `position: sticky; bottom: 0` composers end up behind the keyboard, and the browser scrolls the page to keep the focused input visible, which can push earlier messages off-screen (especially bad inside a 1-message thread drawer). **Fix**: add `interactive-widget=resizes-content` to the viewport meta. Chrome 108+ / iOS 16.4+ honour this and shrink the layout viewport when the keyboard opens — `100dvh` becomes the keyboard-adjusted height, sticky composers stay anchored above the keyboard, and the page doesn't need to scroll. Older browsers (iOS < 16.4) fall back to the default behaviour, accepted as a v1 trade-off.

5. **LinkAI new-chat + history accessible on phone.** PR 2 hid `.link-ai-history` at ≤640px without exposing an alternate entry point — users couldn't switch chats or start new ones. **Fix**: new mobile-only `.link-ai-header.link-ai-header--mobile` rendered above the chat (page variant only, CSS-hidden on desktop). Two buttons — "Chats" (toggles a new `historyOpen` state) and "+ New" (calls `startNew`). At ≤640px the rail repositions to a left-anchored slide-in overlay (`position: fixed; transform: translateX(-100%)` by default; `.is-open` flips to `0`); new `.link-ai-history-scrim` sibling for tap-to-dismiss. The existing rail's "+ New chat" button + chat rows both auto-close the sheet on click.

6. **Reverted Enter-sends-on-touch from PR 2.** Users want native messaging-app behaviour: Enter inserts a newline (across both desktop + mobile), Send button is the only submit affordance on touch (⌘↩ still sends on desktop for power users). Removed the coarse-pointer fork in both `ConversationsView.Composer` and `LinkAIPanel`'s `handleKeyDown`. Send buttons sized up at ≤640px (`.conv-composer-send { height: 40px; padding: 0 16px }`, `.link-ai-send { padding: 10px 18px; min-height: 40px }`) so they're thumb-comfortable.

7. **Brand Intelligence (BrandKitView) — collapse 1fr-1fr inline grids to single column on phone.** BrandKitView uses ~15 inline `gridTemplateColumns: '1fr 1fr'` / `'180px 1fr'` / `'repeat(3, 1fr)'` etc. on its section blocks. Adding `className` to each is too invasive. **Fix**: `.view .card [style*="grid-template-columns"] { grid-template-columns: 1fr !important; gap: 12px !important; }` at ≤640px — uses attribute selector + !important (only way to beat React inline styles) to flatten every `grid-template-columns` inline-styled descendant of any `.card` to a single column. Centering grids (`display: grid; place-items: center`) are untouched since they don't set `grid-template-columns`.

8. **Brand notes card layout.** Desktop row is `body | meta` side-by-side with meta hover-revealed (opacity 0.55 → 1). On phone the meta is always-visible (no hover entry point) and side-by-side crashes body into a narrow column. **Fix**: at ≤640px, `.brand-note-row` stacks `flex-direction: column`; `.brand-note-meta` gets `opacity: 1; flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid var(--line-3)` so the metadata strip sits below the body with a faint separator. Action buttons sized to 32px tap target. Generic `.card-head` also stacks title-above-action at ≤640px (was `display: flex; justify-content: space-between` which crashed long titles into the "Add note" button).

**Files touched:** [web/index.html](web/index.html) (viewport meta), [Icon.jsx](web/src/components/Icon.jsx) (+1 case), [primitives.jsx](web/src/components/primitives.jsx) (+CopyButton), [CalendarView.jsx](web/src/components/CalendarView.jsx) (weekScoped + resize listener), [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx) (2× CopyButton mount), [ConversationsView.jsx](web/src/components/ConversationsView.jsx) (revert Enter-sends), [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx) (mobile header + revert Enter-sends + close-on-row-click), [app.css](web/src/styles/app.css) (+185 LOC of mobile rules and new component classes).

**Verified at fresh-load desktop (1440×900) and phone (375×812):** desktop grid `232px 1208px`, segmented control visible, Month active, heading "May 2026", hamburger hidden, zero console errors. Phone heading "May 24–30, 2026", agenda renders with proper title wrap, filter pills wrap to two rows, no horizontal scroll, no console errors.

**Sections touched:** Recent changes log; `Last updated`.

### 2026-05-28 — Mobile rollout — PR 2: per-surface mobile layouts

**PR 2 of the phased mobile rollout.** Built on PR 1's shell — every per-surface change uses the established `useCoarsePointer()` hook and the existing `@media (max-width: 640px)` block, additive only, desktop layout above 980px byte-stable.

**CalendarView — agenda-only at ≤640px or coarse-pointer.** The 7-column week grid is the worst-on-mobile surface (forces 1085px min width via `repeat(7, minmax(155px, 1fr))`). The existing `.cal-list` renderer at line 954 is purpose-built for narrow viewports; we route to it instead via a JS short-circuit. `viewMode = (isCoarsePointer || isNarrow) ? 'list' : storedViewMode` — OR'ing both signals means Chrome devtools mobile-emulation also triggers the agenda (a narrow viewport is enough; doesn't need a touch device). `setStoredViewMode` still writes the user's last Month/Week/List preference to localStorage, so when they're back on desktop their choice is preserved. Month/Week/List segmented control hidden at ≤640px (irrelevant when the JS forces List). Filter pills tighten gap+padding so they wrap to two rows cleanly. The `.cal-list-row` itself wraps with `row-gap: 4px` and `flex-basis: 100%` on the title so title + status + stats each get their own line at narrow widths.

**PostPlanDetailView — stacking, scroll-snap tabs, hover-pencil reveal on coarse-pointer.** `.page-head` switches to `flex-direction: column` at ≤640px (title above actions, no margin-left:auto wrap weirdness). H1 shrinks from 48px to 32px on phone. Per-platform copy tab strip (previously inline `display: flex; flex-wrap: wrap`) gets a new `.copy-platform-tabs` className hook — at ≤640px, `flex-wrap: nowrap`, `overflow-x: auto`, `scroll-snap-type: x mandatory` with `scroll-snap-align: start` on each pill, scrollbar hidden. Desktop styling is unchanged via the inline-style fallback. AttachmentCard edit-pencil (previously `hovering && (...)` for mouse-only reveal) now ORs in `useCoarsePointer()`: `showEditAffordances = hovering || isCoarsePointer`. Desktop keeps its minimal-chrome-on-idle behaviour; touch always sees the pencil.

**ConversationsView — visible `…` overflow + Enter-sends + 36px composer icons.** Each own-message bubble (`message.from === 'me'`) gains a `.conv-msg-overflow-btn` `…` button that synthesizes a `{ clientX, clientY }` from its bounding rect and fires the same `onContextMenu` callback the right-click handler does — so the existing context menu renders unchanged. CSS hides the button on hover-capable devices, reveals on bubble hover, and always shows it on `(hover: none) and (pointer: coarse)`. Right-click still works on desktop for power users. Composer `onKeyDown` forks: coarse-pointer devices get Enter-sends with Shift+Enter for newlines (WhatsApp/Slack mobile convention); desktop keeps ⌘↩/Ctrl+Enter unchanged. `.conv-composer-icon-btn` sized up from 32px → 36px at ≤640px for thumb-friendliness. The body-scroll-lock from PR 1 + the existing `.conv-wrap` sticky pattern means the composer stays anchored above the soft keyboard on iOS (verified separately).

**LinkAIPanel — Enter-sends + history rail hidden at ≤640px.** `handleKeyDown` mirrors the ConversationsView fork (touch → Enter sends, desktop → ⌘↩ sends). The 240px `.link-ai-history` rail is hidden at ≤640px — there's no room for it alongside the chat on a 375px viewport (chat would get squeezed to ~135px). Multi-conversation switching is a desktop-only affordance for v1; users on phone get one ongoing LinkAI conversation. The artifact pane already converts to a full-width overlay at 900px (existing rule), so it works at phone size with no extra rules. Tracked as a follow-up: in PR 3+ the rail becomes a top-sheet drawer toggled from the chat header.

**IdeateView — camera capture button.** New `cameraInputRef` + `<input type="file" accept="image/*" capture="environment">` rendered alongside the existing paperclip, only on coarse-pointer devices. Brand users on the go can snap a reference photo directly into a new idea (the `capture="environment"` attribute triggers the rear-facing camera on iOS + Android Chrome). Paperclip still opens the photo library for existing screenshots. Same pattern is planned for ConversationsView Composer and PostPlanDetailView attachment uploaders in a future PR — deferred from PR 2 to keep scope tight.

**MarkAsPostedModal — sticky footer + keyboard-aware scroll.** The modal uses `.login-modal` which becomes a bottom sheet at ≤640px (PR 1 behaviour). The body of the sheet can scroll when multiple platforms + URL inputs push past viewport height, leaving the Save CTA below the fold. New `.mark-as-posted-modal` className hook + `position: sticky; bottom: 0; padding-bottom: calc(20px + env(safe-area-inset-bottom))` on the action-row div keeps Save reachable at all times. Each URL input's `onFocus` triggers `scrollIntoView({behavior:'smooth', block:'center'})` so the mobile keyboard never covers the input.

**LivePostsView — no work needed.** The MasonryGrid's ResizeObserver-based column calculation (MIN_COLUMN_WIDTH=280) naturally collapses to 1 column at ≤375px. Filter pills reuse `.cal-filter-pills` which PR 2 already styled. Tile content + engagement metrics render fine in a single column.

**Files touched:** [web/src/components/CalendarView.jsx](web/src/components/CalendarView.jsx), [PostPlanDetailView.jsx](web/src/components/PostPlanDetailView.jsx), [ConversationsView.jsx](web/src/components/ConversationsView.jsx), [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx), [IdeateView.jsx](web/src/components/IdeateView.jsx), [MarkAsPostedModal.jsx](web/src/components/MarkAsPostedModal.jsx), [web/src/styles/app.css](web/src/styles/app.css), [REFERENCE.md](REFERENCE.md).

**Verified during dev:** Dev-server resized through desktop (1440×900) and phone (375×812). Desktop: `.app` grid still `232px 1198px`, `.cal-segmented` visible, Month button active, month grid renders. Phone: `.cal-segmented` hidden, agenda list renders, filter pills wrap to two rows, no horizontal scroll, zero console errors at any viewport.

**Sections touched:** Recent changes log; `Last updated`; §15 Mobile UX (updated roadmap — PR 2 items moved from "planned" to "shipped" inline).

### 2026-05-28 — Mobile shell — PR 1: off-canvas drawer, sheet modals, safe-area, useCoarsePointer hook

**Mobile shell — PR 1 of the phased mobile rollout.** First slice of the mobile work. Goal of this PR: every screen navigable on a phone, modals usable, LinkAI reachable, with desktop layout above 980px byte-stable. The next PRs build on this foundation with per-surface mobile layouts (PR 2 — CalendarView agenda mode, PostPlanDetailView per-platform tab snap-scroll, ConversationsView visible-`…`-menu replacing right-click, LinkAIPanel top-sheet history rail + bottom-sheet artifact pane, camera capture on IdeateView), touch-pattern retrofits (PR 3 — Enter-sends-on-mobile composers, hover-rule guards), and polish (PR 4 — bottom-sheet drag-to-dismiss, iOS PWA meta, landscape).

**Design principle: additive only.** Every change is layered through new media-query blocks and `useCoarsePointer()` branches that return `false` on desktop. Desktop selectors (`.sidebar`, `.topbar`, `.modal-scrim`, `.app`) keep their pre-PR declarations. The one exception is the `100vh` → `100dvh` dual-value swap at nine sites — `100vh` stays as the desktop fallback for browsers that don't understand `100dvh`, so the cost is zero. JSX changes are prop additions with behaviour-preserving defaults (`isOpen = false`, `onClose` undefined).

**Files added:**
- [web/src/lib/useCoarsePointer.ts](web/src/lib/useCoarsePointer.ts) (new, ~30 LOC) — `matchMedia('(hover: none) and (pointer: coarse)')` wrapper with `addEventListener('change')` subscription. Returns false on desktop and during SSR / pre-mount. Single source of truth for touch detection — CSS uses the same media query directly, so behaviour and styles never disagree.

**Files touched:**
- [web/index.html](web/index.html) — viewport meta gains `viewport-fit=cover` so iOS populates `env(safe-area-inset-*)`.
- [web/src/App.jsx](web/src/App.jsx) — new `navOpen` state + two effects (auto-close on `location.pathname` change, body-scroll-lock while open). Hamburger button (`list` icon) at the start of `.topbar`, hidden via CSS above 980px. Sidebar receives `isOpen` + `onClose` props. Topbar LinkAI button branches on `useCoarsePointer()`: desktop toggles the drawer mount (existing behaviour), touch devices route to `/c/:slug/linkai` instead. The LinkAI drawer mount itself (the `linkAiEligible && linkAiOpen && …` block) gains a `!isCoarsePointer` gate so it never appears on mobile — only the persistent page-variant mount renders there.
- [web/src/components/Sidebar.jsx](web/src/components/Sidebar.jsx) — new `isOpen` + `onClose` props (default to behaviour-preserving values). New `.sidebar-scrim` sibling (tap to dismiss), new `.sidebar-drawer-close` (`x` icon) top-right. Escape-key handler when open. Nav-item click chains `onClose` for snappier UX. The wrapping `<>...</>` fragment is new so the scrim can be a sidebar sibling.
- [web/src/styles/app.css](web/src/styles/app.css) — ~200 LOC appended at the end. `100vh` → `100dvh` dual-value at nine sites. New `@media (max-width: 980px)` block: `.app` collapses to `1fr`, sidebar `position: fixed` + `transform: translateX(-100%)`, `.is-open` flips to `translateX(0)`, hamburger reveals, scrim + drawer-close reveal, safe-area padding. The pre-existing 980px block (line 2097) is intentionally left alone — its hide-rules for nav-item text + brand wordmark are overridden by selectors `.sidebar .nav-item span { display: inline; }` etc. in the new block (so the drawer shows full text, not a compact rail). New `@media (max-width: 640px)` block: `.modal-scrim` + `.login-modal-backdrop` become bottom sheets (align-items end, 100% width, `border-radius: var(--radius-xl) var(--radius-xl) 0 0`, slide-up animation, `padding-bottom: env(safe-area-inset-bottom)`). New `@media (hover: none) and (pointer: coarse)` block: `touch-action: manipulation`, no tap-highlight, 44px tap-target floor on hamburger + drawer-close + sidebar nav-items.
- [REFERENCE.md](REFERENCE.md) — new §15 Mobile UX section documents the breakpoint scheme, useCoarsePointer hook, drawer pattern, and PR 2-4 roadmap.

**Verification ran during dev:** dev server up, viewport resized through desktop (1440×900 — sidebar 232px sticky, hamburger hidden, drawer-close hidden, grid `232px 1198px`), tablet (820×900 — sidebar offscreen at `translateX(-320px)`, hamburger reveals, tap opens drawer with scrim + body-scroll-lock + close button), phone (375×812 — same drawer behaviour, plus LoginModal opens as a bottom sheet with `align-items: end` and 100% width). Zero console errors across all viewports.

**Sections touched:** Recent changes log; `Last updated`; new §15 Mobile UX.

### 2026-05-26 — hotfix: chat.ts SYSTEM_PROMPT — remove stray backticks that broke prod

**hotfix: chat.ts SYSTEM_PROMPT — remove stray backticks that broke prod.** PR #143 (brand-notes discipline) introduced backticks around the literal `write_brand_note` in the new SYSTEM_PROMPT bullet. SYSTEM_PROMPT itself is a template literal delimited by backticks, so the first internal backtick terminated the literal early → invalid JS at module load → every cold start of `/api/ai/chat` died with SyntaxError → user observed "thinking..." for ~1s then nothing on every chat message. The file's top-of-file GOTCHA comment explicitly warns about this AND notes that `vite build` doesn't catch it (Vite doesn't compile API routes; Vercel's esbuild emits the broken bundle without flagging). Fix was one character-class change: ``\`write_brand_note\``` → `**write_brand_note**` (bold, no backticks). Per the GOTCHA: italics / bold / plain text all fine for emphasis; only backticks break. **Lesson logged**: every PR that touches SYSTEM_PROMPT needs an explicit "no internal backticks" check, since the local `vite build` smoke-test is structurally blind to this class of bug. Defensive fix for the next session: a `node --check` (or tiny `import()`) on `api/ai/*.ts` in a pre-commit or CI step would have caught this before deploy. Tracked as a possible follow-up. Pure 1-line code change. Sections touched: Recent changes log; `Last updated`.

### 2026-05-26 — LinkAI: brand-notes discipline — default to NOT saving; explicit allow/deny rules

**LinkAI: brand-notes discipline — default to NOT saving; explicit allow/deny rules + anti-pattern callout for meeting-minutes dumps.** User reported LinkAI was indiscriminately saving every bullet from a pasted meeting-minutes blob into `brand_kit_notes` (content pipeline lists, post schedules, week-specific tactical observations, event details — none of which are evergreen brand truths). Notes get re-injected into every future AI call, so polluting them degrades every subsequent generation. Three coordinated prompt changes in `web/api/ai/chat.ts` to fix the over-eagerness: (1) the `write_brand_note` tool description was rewritten with an explicit DEFAULT=NO stance, a 2-clause allow-rule (admin explicit ask OR new evergreen brand-level rule), a labelled allow-list (voice rules, audience facts, forbidden terms, recurring schedule rules, compliance) AND a labelled deny-list with concrete negative examples lifted from the user's screenshot (content pipeline lists, specific upcoming posts, tactical observations, event details, performance recaps). (2) The SYSTEM_PROMPT bullet about remembering things was rewritten in parallel to mirror the same rules and call out the CRITICAL anti-pattern: when admin pastes meeting minutes / transcripts / "content pipeline" dumps, reply with a summary + propose 1-3 maybe-memory-worthy items + ASK before saving — never auto-fire write_brand_note per bullet. (3) The tool-menu entry was tightened to flag "Default: do NOT call" prominently. Same prompt-tightening pattern as the no-em-dashes work: the prompt rule is the primary signal, but the model can still slip — if observed behaviour still leaks after a few weeks of production, a server-side validator-loop is the next layer (regex-reject write_brand_note calls whose body matches anti-pattern signatures: dates, "scheduled for", "post X on Y", numbered pipeline lists). Pure prompt change — no schema, migration, env-var, or client work. Existing 3 over-eager notes in Bamboo Bear's brand_kit_notes are NOT auto-cleaned; user deletes them manually via Brand notes page. **Follow-up incident**: the deploy crashed prod because of a stray backtick in the new SYSTEM_PROMPT bullet — fixed in hotfix #144 (see entry above). Sections touched: Recent changes log; `Last updated`; §10 Edge functions & integrations (chat.ts behavioural change on write_brand_note triggering).

### 2026-05-26 — Live Posts engagement summary: Engagement-rate KPI replaced with Engagement-per-post

**Live Posts engagement summary: replace broken brand-level "Engagement rate" KPI with "Engagement per post"; move true engagement-rate-as-% into per-platform rows where the math is honest.** The old middle KPI tile divided engagement-from-all-posts by views-from-IG-video-and-X-only, routinely producing inflated values (e.g. 204% on Bamboo Bear with 297 engagement / 145 views from 4 of 16 posts). The previous "views from IG/X only" annotation labelled the inflation but didn't fix it - users saw 204% and either thought the brand was on fire or that the metric was broken. **New brand-level KPI** = `total engagement ÷ posts` (e.g. 297 ÷ 16 = 18.6) - works for every platform regardless of view-data coverage, no inflation possible. **True engagement rate (%)** now appears as an extra chip in the "By platform" rows ONLY when every in-scope publication on that platform reports view counts (`rateBasis === 'all'`). For X this is usually the case (X exposes view_count reliably); for an Instagram brand that only posts Reels, also yes; for IG-mixed (Reels + photos) the rate chip hides to avoid the same inflation at platform scope; for LinkedIn the chip never appears (no public view-count access by design). Tooltip on the chip explains the math (`engagement N ÷ views M × 100`). Files: `web/src/lib/db.js` (`aggregateAtTime` now returns `avgEngagementPerPost`; new `avgPerPost` sparkline replaces the broken `rate` sparkline at the top level; `deltas` carry `avgPerPost` % change instead of `ratePoints`; dead `ratePointDiff` helper removed), `web/src/components/LivePostsSummary.jsx` (new `formatPerPost` formatter; `tiles.rate` replaced by `tiles.avgPerPost`; `PlatformRow` renders an engagement-rate chip alongside the existing metric chips when `rateBasis === 'all'`; header doc updated). Pure client + math change - no schema, migration, env-var, or server work. Sections touched: Recent changes log; `Last updated`.

### 2026-05-26 — LinkAI: defensive lone-surrogate sanitisation on incoming chat history + copy inputs

**LinkAI: defensive lone-surrogate sanitisation on incoming chat history + copy inputs.** Observed prod 400 from Anthropic: `The request body is not valid JSON: no low surrogate in string: line 1 column 42471`. Cause: JavaScript strings tolerate "lone surrogates" (half of a UTF-16 surrogate pair, e.g. an emoji that got split mid-pair by a clipboard or localStorage round-trip), but Anthropic's strict JSON parser rejects requests containing them. The poisoned character lives in the message HISTORY, so once it's there every subsequent chat turn 400s identically until the user starts a new chat. Fix: scan every string leaf in `body.messages` (chat.ts) and `body.prompt` + `body.current_copy` (copy.ts) before they reach `convertToModelMessages`, and replace any lone surrogate with U+FFFD (the standard Unicode REPLACEMENT CHARACTER). New helpers in `web/api/_shared/textNormalize.ts`: `isWellFormedString()` + `toWellFormedString()` (regex polyfill of ES2024's `String.prototype.isWellFormed`/`toWellFormed` since the project's tsconfig lib is ES2022) + `toWellFormedDeep()` (deep walker returning `{value, repaired}` so callers emit a `console.warn` only when something actually got repaired - usually zero per request). chat.ts wires this in alongside the existing `sanitizeBrokenToolCalls` step; copy.ts wires it on the two free-form input fields. Well-formed emoji / em-dashes / CJK / accents pass through unchanged - regex tests all 9 cases pass. Pure server-side defensive sanitisation - no schema, migration, env-var, or client work. Files: `web/api/_shared/textNormalize.ts` (+~75 LOC: 3 new exports), `web/api/ai/chat.ts` (+~15 LOC: import + IIFE around `convertToModelMessages` input), `web/api/ai/copy.ts` (+~12 LOC: import + sanitise-and-warn on `instruction` + `current_copy`). Sections touched: Recent changes log; `Last updated`.

### 2026-05-26 — LinkAI: server-side hard-stop on em-dashes (U+2014) and en-dashes (U+2013)

**LinkAI: server-side hard-stop on em-dashes (U+2014) and en-dashes (U+2013).** Claude habitually emits em-dashes for elegant prose, especially on LinkedIn-tone copy, and a prompt-only "do not use em-dashes" rule has a known soft floor (negative-priming + nonzero violation rate). The brand notes had the rule too but it still leaked through. This change makes the rule load-bearing in two places: (1) a server-side stream filter (`experimental_transform` on `streamText`) substitutes both characters with a regular hyphen (`-`) inside `text-delta` AND `tool-input-delta` chunks before the stream reaches the client - so the user is GUARANTEED never to see an em-dash regardless of how many times the model slips; (2) a deep-strip on tool inputs at execute() time (defence-in-depth — catches em-dashes in the assembled-from-buffer tool input that gets echoed back to the model for the next reasoning step AND that gets committed to `post_plans.copyVariants` when the admin clicks "Open plan"). New shared helper `web/api/_shared/textNormalize.ts` exports `stripDashes()` + `stripDashesDeep()` + `stripDashesStreamTransform()`. Wired into both `chat.ts` (text + tool-input streams + `create_post_plan_draft` echo + `write_brand_note` body before DB insert) and `copy.ts` (text stream). The SYSTEM_PROMPT strings in both routes are themselves run through `stripDashes()` at module load - removes in-context priming that historically pushed the model to imitate the prompt's own em-dash-heavy style. A NO_DASHES_RULE block was added near the top of each prompt as the explicit instruction; the stream filter is the actual guarantee. Files: `web/api/_shared/textNormalize.ts` (new, ~75 LOC), `web/api/ai/chat.ts` (+~30 LOC: import, prompt rule, prompt wrap, stream transform, execute strip, note-body strip), `web/api/ai/copy.ts` (+~15 LOC: import, prompt rule, prompt wraps, stream transform). Pure server-side change - no schema, migration, env-var, or client work. Sections touched: Recent changes log; `Last updated`; §10 Edge functions & integrations (chat.ts + copy.ts gain the dash-strip behaviour).

### 2026-05-26 — Paste images directly into LinkAI and Conversations composers with Ctrl/Cmd+V

**Paste images directly into the LinkAI composer AND the Conversations composer with Ctrl/Cmd+V.** Third entry point for image attachments on both per-brand chat surfaces, alongside the existing paperclip button (and, on LinkAI, drag-drop). Each surface wires an `onPaste` handler on its composer textarea, scoped to fire only when the composer has focus so it doesn't surprise users pasting anywhere else on the page.

**Shared behaviour across both surfaces:**
- **Mixed-content paste** (clipboard carries both image AND plain text, e.g. a rich block from Slack/Notion): the image attaches AND the text pastes into the textarea normally. Implementation: only `preventDefault` the no-op image-into-textarea attempt when there's no accompanying `text/plain` string item.
- **Multiple-image rename**: browsers name clipboard images "image.png" generically, so the handler renames them to a timestamped form (`pasted-2026-05-26T14-30-22.png`, `pasted-2026-05-26T14-30-22-2.png`, ...) via the `File` constructor — original blob bytes preserved.
- **Pipeline reuse**: paste funnels into each surface's existing add-files pipeline, so attachments behave identically to ones added via the paperclip click. Zero behavioural divergence from existing flows.

**Per-surface differences (matching each composer's existing pipeline):**
- **LinkAI** (`web/src/components/LinkAIPanel.jsx`, page variant only): image-only whitelist (PNG/JPEG/WebP/GIF — Claude vision constraint), 5 MB per file, 4 attachments per message. Routes through `addFiles` → in-memory data URLs (not persisted to localStorage; attachments are "in this turn only" by design). Hint updated to "⌘↩ to send · paste or drop an image to attach". The drawer variant has no paperclip/drag-drop today and is intentionally left alone; PR D retires the drawer entirely.
- **Conversations** (`web/src/components/ConversationsView.jsx`, `Composer` sub-component used by BOTH the main feed AND the thread drawer): broader mime acceptance matching the existing paperclip's `accept` attr (`image/*`, `video/*`, PDF, zip, text). Routes through `onPickFiles` → `pendingFiles` state → on Send, uploads to the `post-plan-attachments` Storage bucket at `<accountId>/messages/<messageId>/<filename>` (the pattern from migration 0042). Only image-mime files get the timestamped rename; non-image files (rare via Ctrl+V, possible via "Copy file" from a file manager) keep their browser-provided name. Hint updated to "⌘↩ to send · paste images to attach". Single change to the shared `Composer` propagates to both the main composer mount AND the thread-drawer composer mount.

Files: `web/src/components/LinkAIPanel.jsx` (+~45 LOC: new `onPaste` useCallback + textarea wire + hint copy tweak), `web/src/components/ConversationsView.jsx` (+~50 LOC: inline `onPaste` handler inside the shared `Composer` component + textarea wire + hint copy tweak). Pure client change — no schema, migration, env-var, or server work. Sections touched: Recent changes log; `Last updated`.

### 2026-05-26 — Calendar status filter pills coloured to match cards

**Calendar status filter pills coloured to match cards.** The 5 status-filter pills on the Social Calendar (Drafting / Proposed / Needs review / Approved / Posted) now wear the same colour their matching cards wear on the grid — coral for Proposed, mustard for Needs review, green for Approved, violet for Posted, neutral grey for Drafting. **Idle state** shows a small 8px coloured dot before the pill label; the pill chrome itself stays quiet so the row of pills doesn't shout. **Active state** ("on") swaps the generic ink-on-surface treatment for the status's tinted background + matching text colour + matching border (and drops the dot — the pill chrome now tells the colour story directly, no need to duplicate via a sub-element). The **"All" pill** has no single status to inherit from and intentionally stays neutral (keeps the original ink-black active treatment). Implementation: each pill button in `CalendarView.jsx`'s `cal-filter-pills` render block reads the first `displayStatus` in its `STATUS_GROUPS[key]` entry, looks up the matching `STATUS_CONFIG` colour + tint from `postPlanShared.jsx`, and passes both as **inline CSS custom props** (`--pill-color`, `--pill-bg-tint`) on the button element. A new `.has-status-color` class flips the active-state CSS rules to use those props instead of the generic ink/surface palette. Files: `web/src/components/CalendarView.jsx` (+~20 LOC in the pill render block), `web/src/styles/app.css` (+~30 LOC of `.cal-filter-pill-dot` + `.has-status-color` active-state rules). Pure client + CSS — no schema, migration, or env-var work. Sections touched: Recent changes log; `Last updated`.

### 2026-05-25 — Brand → Slack relay for #lrmedia-inbox

**Brand → Slack relay for #lrmedia-inbox.** New always-on pipeline that pings the agency's `#lrmedia-inbox` Slack channel every time a brand user posts a top-level (or threaded) message in `/c/:slug/conversations`. Migration `0061_slack_brand_message_notify` adds (1) a `slack_notify_log` table (PK = `message_id`, used as a dedupe claim before the HTTP fire), (2) a Vault entry `slack_notify_shared_secret` (reuses the existing `vercel_app_url` entry from 0054), and (3) an AFTER INSERT trigger on `conversation_messages` whose function `notify_slack_on_brand_message` pre-filters (`kind = 'user'`, non-deleted, non-empty body, author profile `is_agency = false`), claims the dedupe row via `INSERT … ON CONFLICT DO NOTHING`, then `net.http_post`s `{message_id}` to the new Vercel route with a `Bearer <shared_secret>` header. Every failure path is wrapped — Slack outages never roll back a brand's message.

The Vercel route `web/api/slack/brand-message-notify.ts` verifies the bearer, re-fetches the message with service-role across three small queries — (1) message + author + conversation.account_id via FK embeds, (2) `accounts` row for the brand display name + URL slug (brand identity lives on `accounts`, not `brand_kits`), (3) `post_plans` row when `tagged_post_plan_id` is set (separate query, not an embed — migration 0043 dropped that FK so PostgREST can't resolve it; a null result here just omits the plan chip, mirroring the UI's "Plan deleted" tombstone). Then assembles a Block Kit payload — body-first layout: a `context` line with the bold brand + author + IST timestamp, a `section` blockquote of the body (truncated at 600 chars), an optional `On plan: <concept>` context line when `tagged_post_plan_id` is set, and a footer `context` line with inline mrkdwn link(s) — `Open conversation` (always, deep-links `/c/<slug>/conversations#msg-<uuid>`) and `Open plan` (when applicable, points at `/c/<slug>/calendar/<plan_id>`). **No header block, no action-button block** — both were dominant chrome that crowded the actual message, and `actions` blocks specifically triggered Slack's "interactivity not configured" warning ⚠ on every bubble until an Interactivity URL was wired up at the Slack-app level. Inline mrkdwn links render as a single discreet footer line and bypass interactivity entirely. POSTs to `SLACK_BRAND_MSG_WEBHOOK_URL`, then updates the log row with `delivered_at` / `slack_status` / `slack_error`.

`ConversationsView.jsx` learns the `#msg-<uuid>` deep-link convention: every `MessageBubble` (system + regular branches) gets an `id={`msg-${message.id}`}`, and a new effect inside the default export reads `location.hash`, scrolls the targeted element into view with `behavior: smooth, block: center`, and applies a new CSS class `conv-msg-flash` that fades over 2.2s via the `conv-msg-flash-anim` keyframes added in `web/src/styles/app.css`. A `scrolledHashRef` makes the effect one-shot per hash so realtime new messages don't re-trigger it; the same effect flips `stuckToBottomRef.current = false` so the existing stick-to-bottom heuristic doesn't yank the viewport back. Thread replies (parent_message_id set) are not in the top-level DOM yet on deep-link land; the selector silently no-ops in that case — accepted v1 limitation.

**Why this shape (vs. pg_net straight to Slack):** brand-name + plan-title + deep-link formatting in plpgsql is painful; the Vercel route owns Block Kit assembly. **Why Vercel (vs. Supabase Edge):** zero-downtime deploys make webhook receivers immune to the deploy-churn issue that bit Vercel cron in 0054 — webhooks aren't scheduled, they hit whatever URL handles the request at fire time. **Why one channel for all brands (vs. per-brand):** the inbox metaphor is the whole point — one place to triage everything.

Two secrets handed off to the user in chat (Slack Incoming Webhook URL + an `openssl rand -hex 32` shared secret); see [[project-slack-inbox-rotation]] for the rotation reminder once the first ping confirms in production.

Files: `supabase/migrations/0061_slack_brand_message_notify.sql` (new), `web/api/slack/brand-message-notify.ts` (new), `web/src/components/ConversationsView.jsx` (+id attrs on bubbles + hash-scroll effect, ~25 LOC), `web/src/styles/app.css` (+9 LOC keyframe + class). Sections touched: Recent changes log; `Last updated`; §6 Data model (new `slack_notify_log` audit table); §6 Migrations (new `0061` entry).

### 2026-05-24 — Brand System v1 — claim guardrails + channel voice on `brand_kits`

**Brand System v1 — claim guardrails + channel voice on `brand_kits`.** First slice of the new Brand System layer: two JSONB columns added to `brand_kits` (migration `0059_brand_system_v1`) that capture the brand-specific rules the LinkAI needs to write on-brand reliably.

- **`claim_guardrails`** — `{ never_use: [{phrase, category, reason, use_instead, severity}], always_pair: [...], approved_qualifiers: [string], off_limits_numbers: [...] }`. Encodes **swap rules** ("never X → use Y") and **pair rules** ("if you say X, also say Y") that flat `dos`/`donts` string arrays can't preserve. The `severity` field (`hard_block` / `soft_block`) future-proofs a validator-loop in v2.
- **`channel_voice`** — `{ global: {...}, instagram: {...}, linkedin: {...}, twitter: {...}, whatsapp: {...} }`. Per-channel voice prescription overlay (case / person / cadence / lead_with / ending_pattern / posting_frequency / pillars / rhythms / tone_modifiers / etc.) layered **above** skillRegistry's universal `platforms.md` playbook — universal mechanics stay there, brand-specific voice rules live here. The `global` sub-object carries brand-wide signatures (sign-off emoji, signature phrases, must-include differentiators).

`brandContext.js` gains two pure helpers — `claimGuardrailsSection(jsonb)` and `channelVoiceSection(jsonb)` — that render the JSONB into `## Claim guardrails` and `## Channel voice` markdown sections inside `compileBrandContext()`'s output, between the existing `## Voice` ↔ `## Strategy` ↔ `## Visual identity` blocks. The new content sits in the high-attention upper portion of the prompt and benefits from the existing cache tier. **Empty-state defensive**: both helpers return `''` when the JSONB is `{}` / missing / malformed / has no usable sub-keys. Underscore-prefixed keys (e.g. `_meta`) are skipped so per-row metadata (source, schema_version, last_seeded_at) never leaks into the prompt.

**Bamboo Bear is the only seeded brand in v1.** Migration `0060_seed_bamboo_bear_brand_system` populates both columns from the validated `Bamboo_Bear_Brand_System.md` content bible (§4 claim guardrails, §5 voice & tone, §8 channel strategy, §9 X rhythms only). Verification confirmed counts of 9 `never_use` / 2 `always_pair` / 6 approved qualifiers / 4 channels / 7 X rhythms / 6 signature phrases. Every other brand keeps `{}` defaults and emits zero new prompt content — strictly no behavioural change for non-seeded brands.

**Out of scope for v1 (deferred to v2):** `content_frameworks` column (carousel templates, hook formulas — §9 of the bible), `sample_bank` column (few-shot examples per channel — §10), UI tab at `/c/:slug/brand-system` for read/edit, auto-extraction from website/IG into the new columns, conversational-correction auto-proposals from LinkAI transcripts, versioning / audit-snapshot-on-approve, evidence links per claim, periodic-refresh cron, REFERENCE.md migration-list backfill (0046–0058 still undocumented in §6 Migrations).

**Brand Intelligence label rename** was considered then dropped — the existing label correctly describes the `brand_kits` page (tagline / audience / palette / competitors), not industry trends. Trend articles already live separately under "Trends" (`brand_trend_snapshots` + TrendsView). Nothing to rename.

Files: `supabase/migrations/0059_brand_system_v1.sql` (schema), `supabase/migrations/0060_seed_bamboo_bear_brand_system.sql` (seed with transaction wrap + safety guard + post-seed verification block), `web/src/lib/brandContext.js` (+131 LOC: two pure helpers + two push calls in `compileBrandContext`). Migrations applied to prod Supabase via MCP `apply_migration` (tracked names: `brand_system_v1`, `bamboo_bear_brand_system_v1_seed`). Sections touched: Recent changes log; `Last updated`; §6 Data model (`brand_kits` core-tables row); §6 Migrations (new `0059` and `0060` entries).

### 2026-05-23 — LinkAI brand-isolation hardening — force-remount on brand switch + session-cache prune + system-prompt sanitisation + brand-resolve log

**LinkAI brand-isolation hardening — force-remount on brand switch + session-cache prune + system-prompt sanitisation + brand-resolve log.**

**Problem.** User reported LinkAI claiming to be in Bamboo Bear while their URL/picker said Epigamia. Hard-reload fixed it; root cause was today-earlier's cross-contamination bug whose recovery snippet was never run on their session, so a Bamboo Bear conv was still resident in the module-level `sessionConvCache` Map and got rendered under the new brand's panel after switch. Wider audit confirmed the data layer is tight (every `loadAndCompileBrandContext` query hard-filters by `account_id`; every localStorage key is brand-scoped), but the *client component lifetime* spans brand switches via the persistent page-variant mount (PR #125), turning every state slot inside `LinkAIPanel` into a leak surface if any single reset step regresses.

**Fix (four layers, smallest diff that closes the actual + adjacent failure modes):**
1. **`<LinkAIPanel key={calendarAccountId} ... />` in `web/src/App.jsx`** (both page + drawer mounts). React unmounts the entire panel on brand switch and remounts a fresh instance. Every `useState`, every `useRef`, every `useChat` array, every closure capture — gone. The brand-switch effect inside the panel still runs on mount but with no prior state to corrupt. In-flight stream to the old brand is aborted on switch (which is correct — that response was for the old brand).
2. **`pruneSessionCacheToBrand(userId, accountId)` in `web/src/components/LinkAIPanel.jsx`** — called inside the brand-switch effect. Drops module-level `sessionConvCache` entries whose key doesn't start with `${userId}|${accountId}|`. The cache is already brand-keyed (wrong-brand reads miss), but stale entries no longer outlive the brand switch — and the prune closes the specific failure mode that caused today's symptom. Cost: multimodal attachment bubbles for any *other* brand toggled-through this session reset to the localStorage breadcrumb on return, which matches existing reload-survival behaviour.
3. **Sanitise `@sarahbamboo` → `@founder_handle` in `web/api/ai/chat.ts`** `write_brand_note` tool description. Hardcoded Bamboo Bear reference shipped to every brand's system prompt — small bias removed.
4. **`[chat] brand-resolve account=<uuid> name="<resolved>" agency=<bool>` log in `web/api/ai/chat.ts`** fires per chat call after `loadAndCompileBrandContext` returns. Vercel function logs gain a one-line audit trail of which brand the server actually resolved for each accountId. Next regression in this class is grep-visible in seconds instead of from screenshots.

**Deferred (C-tier).** Stamping `accountId` inside each conv index entry + filtering mismatches on `loadConvIndex` is the natural next defence-in-depth layer, but A already eliminates the root failure class so C is paranoia, not load-bearing. Tracked as follow-up.

**Recovery for users who hit the pre-fix cross-contamination earlier today** still applies — same snippet as before:
```js
Object.keys(localStorage)
  .filter(k => k.startsWith('lr_link_ai_'))
  .forEach(k => localStorage.removeItem(k))
```
…then hard-reload. Worth pinning in the next agency-side announcement.

Pure code (no schema/migration/env-var). Sections touched: Recent changes log; `Last updated`.

### 2026-05-22 — Post-plan visibility gated by status × role — brand's `brand_draft` is invisible to agency; agency's `drafting` is invisible to brand. UI...

**Post-plan visibility gated by status × role — brand's `brand_draft` is invisible to agency; agency's `drafting` is invisible to brand. UI labels both as "Drafting".**

**Problem.** Until this change, post-plan visibility was governed only by account membership. Brand could see plans agency was mid-drafting (`status='drafting'`); agency could see plans brand was mid-drafting before proposing (`status='brand_draft'`). Both defeat the "let the owning side prep in peace, announce when ready" pattern that migration 0050 established for the brand→agency direction (but never for the agency→brand direction, and even on the brand side the gate was UI-only, not RLS-enforced).

**Schema (migration `0058_post_plans_visibility_by_role.sql`).** Drops + recreates `post_plans_select` with a role-aware filter: agency sees everything except `status='brand_draft'`; brand sees their account's plans except `status='drafting'`. No enum change, no data migration on existing rows. The two distinct internal statuses stay — they carry different visibility scopes by design.

**INSERT / UPDATE / DELETE policies unchanged.** The status-transition guard (`guard_post_plan_status_transitions` from migration 0050) already forbids cross-role state moves. With SELECT-side gating layered on top, the two halves are consistent: you can't write what you can't see, and you can't see what isn't yours.

**Realtime.** Supabase Realtime v2 applies RLS per-event for `postgres_changes` streams, so brand clients automatically stop receiving INSERT/UPDATE events for `drafting`-status plans and agency clients stop for `brand_draft` plans.

**UI label unification (`postPlanShared.jsx`).** `STATUS_CONFIG.brand_draft` label changes from "Draft (not yet proposed)" → "Drafting". The two distinct enums share one display label; whichever one the viewer is allowed to see, they see "Drafting".

**Calendar filter pills (`CalendarView.jsx`).** `STATUS_GROUPS` becomes `STATUS_GROUPS_ALL` + a `getStatusGroupsForRole(isAdmin)` helper. Agency view omits `brand_draft`; brand view omits `drafting`. `LS_STATUS_FILTER` validation uses role-scoped keys, so a previously-saved invalid filter gracefully falls back to `'all'`.

**Dead callout removed (`PostPlanDetailView.jsx`).** The "Your agency is drafting this post" banner for brand viewers on `drafting`-status plans was unreachable after RLS (brand never reaches such a plan). Removed with a comment explaining how the brand still learns about agency drafting activity (via the "accepted the proposed plan." Conversations system message; the plan reappears in their calendar when agency clicks Submit for review).

**Edge case worth knowing about.** Tagged-plan chips in the Conversations log point at `post_plan_id` regardless of status. A brand reading chat history might see a chip for a plan currently in `drafting` state — `loadPostPlans` no longer returns it, chip falls through to `<PlanChip deletedPlaceholder />`. Acceptable for v1.

**Operator action:** apply `0058_post_plans_visibility_by_role.sql` on Supabase before merge.

### 2026-05-22 — Live Posts: soft-delete + Remove menu + View-in-Live-posts deep-link + engagement scraper skip

**Live Posts: soft-delete + Remove menu + View-in-Live-posts deep-link + engagement scraper skip.** Users wanted a way to take a post card off the Live Posts grid without losing the engagement numbers they'd already captured for it — historic totals on the brand summary should not drop when a card is removed; only future tracking should stop.

**Schema (migration `0057_post_plan_publications_soft_delete.sql`).** Adds `deleted_at timestamptz` to `post_plan_publications` + a partial index on `(published_at desc) where deleted_at is null` so the common "active publications" filter stays cheap as soft-deleted rows accumulate. No RLS change — read-path filtering is enforced by the JS helpers (because aggregation paths legitimately need to see soft-deleted rows to keep historical totals stable).

**DB helpers (`web/src/lib/db.js`).** `loadPostPlanPublications`, `loadPublicationsForPlanIds`, and `loadBrandPublications` all gain an `{ includeDeleted = false }` param and default-filter `deleted_at IS NULL`. `loadEngagementSummaryForBrand` and `loadEngagementForBrandRange` opt-in to `includeDeleted: true` so historical brand-level totals don't drop the moment a user removes a card. `deletePostPlanPublication` flips from a hard `.delete()` to a soft `UPDATE deleted_at=now()` — function name kept for backward compat; every existing caller (the modal's uncheck-platform path AND the new Live Posts Remove menu) gets the safer semantics for free. Previously the uncheck flow was silently destroying engagement history via the `ON DELETE CASCADE` on `post_engagement_snapshots.publication_id` (migration 0041). `upsertPostPlanPublication` explicitly sends `deleted_at: null` so re-marking a soft-deleted platform reactivates it cleanly through the existing ON CONFLICT path.

**Engagement scraper (`supabase/functions/engagement-refresh/index.ts`).** The cron query that selects publications to scrape gains `.is('deleted_at', null)` so no new snapshots land for removed posts. Vercel manual-refresh route (`web/api/engagement/refresh.ts`) gets the same defensive guard — returns 404 "Publication has been removed" if a stale client tries to refresh a since-removed pub id. Requires Edge Function redeploy via Supabase Dashboard.

**UI: Remove menu (`web/src/components/LivePostsView.jsx`).** Each `LiveTile` gains a `…` overflow button in the card header. Single item "Remove post" → confirm dialog ("Future engagement tracking for this post will stop. Historical engagement data captured so far will be preserved for reference (totals on the brand summary won't change). You can re-mark the post as posted later to start tracking again."). On confirm, optimistic remove from the local rows list, then `deletePostPlanPublication` (soft-delete); rolls back via a refetch on failure. The same confirm dialog now fires from the modal-uncheck path too — when the user unchecks a platform in `MarkAsPostedModal`, `handleMarkPostedSubmit` shows the confirm before running the deletes (single-platform → "Remove this Instagram post"; multi-platform → "Remove 2 posts (Instagram, LinkedIn)"). Cancel aborts the entire submit so the modal state stays exactly as the user left it.

**UI: Deep-link `?focus=<publicationId>` (`LivePostsView` + `PostPlanDetailView`).** New "View in Live posts" button renders on the post-plan detail view (in the action row, right next to "Edit live posts") whenever `publications.length > 0` AND the brandSlug is resolvable. Click navigates to `/c/<slug>/posts?focus=<firstPublicationId>`. `LivePostsView` reads the param once on mount, passes `focused={row.id === focusId}` to each tile, and each tile `scrollIntoView({ behavior: 'smooth', block: 'center' })` + flips a 1.8-second highlight ring. The "Edit live posts" button stays — both buttons coexist because multi-channel plans where some platforms aren't posted yet still need the modal to add the missing channel URLs.

**Operator action:** apply `0057_post_plan_publications_soft_delete.sql` + redeploy the `engagement-refresh` Edge Function via Supabase Dashboard.

### 2026-05-22 — Brand-side copy editing: inline "Edit" pill + per-platform proposals + proposer can withdraw + recall-proposed-new-plan

**Brand-side copy editing: inline "Edit" pill + per-platform proposals + proposer can withdraw + recall-proposed-new-plan.** Replaces the brand "Propose changes" button + full-page modal with the same inline Edit pill the agency uses, plus three structural upgrades to the proposal model: one pending copy proposal PER PLATFORM (not per plan); proposer-can-cancel a pending copy/date proposal (new 'withdrawn' status on `plan_proposals`); and brand-creator-can-recall a new-plan proposal (post_plan flips proposed → brand_draft).

**UI behavior (`PostPlanDetailView.jsx`).** Brand sees the same Edit pill top-right of the copy textbox the agency does. Click → textarea + branch on role at the footer: agency keeps existing "Done" / "Cancel" / "AI redraft" (direct-save via `persist({ copyVariants })`); brand gets "Cancel" (always while editing) and "Propose change" (only while dirty) that routes to `createProposal({ kind: 'copy_change', payload: { copy_variants: { [activeCopyTab]: draft } } })`. One proposal per click — multi-platform changes become N proposals, cleaner audit. AI Draft / AI Redraft button is now available in the brand footer too (gated on `aiInlineEligible`, which already includes brand). Subtler focus halo on the textarea — opt-out from the global coral `:focus-visible` ring via a `.copy-edit-textarea` class.

**Per-platform proposal state.** Replaces the singleton `pendingCopyProposal` (gated everything globally) with `pendingCopyProposalByPlatform` (map). `brandCanProposeCopyForPlatform(p)` returns true iff status is needs_review or approved-not-posted AND no pending copy proposal already exists for that specific platform. Each pending proposal renders its own `PendingCopyProposalCard` (stacked, marginTop 12 between them) with independent Accept/Reject (agency) / Cancel (brand-proposer) actions.

**Brand can add new platforms.** For brand-in-eligible state, the platform-tabs strip surfaces ALL `PLATFORMS` (not just `plan.platforms`) with a "+" prefix icon + dashed border on tabs not yet on the plan. Click "+LinkedIn" → empty textarea auto-enters edit mode → brand types + "Propose change" submits a proposal carrying the new-platform copy. Agency's existing Accept logic merges newly-touched platform keys into `plan.platforms` automatically.

**Withdrawal (migration `0056_proposal_withdrawal.sql`).** Adds `'withdrawn'` as a third terminal status on `plan_proposals`. New RLS UPDATE policy `plan_proposals_update_proposer_withdraw` lets `proposed_by = auth.uid()` flip a pending proposal to withdrawn — and ONLY that transition, ONLY their own row. `emit_plan_proposal_resolved_message()` trigger extended with `withdrawn` branch for all three proposal kinds. `stamp_plan_proposal_resolution` stamps `resolved_at` / `resolved_by` on withdrawn too. New `withdrawProposal({ proposalId })` helper in `web/src/lib/db.js`; brand-side "Cancel proposal" button on their own `PendingCopyProposalCard` (with a confirm dialog).

**Recall a proposed new-plan (migration `0056b_post_plan_recall_transition.sql`).** New-plan proposals don't have a `plan_proposals` row (per migration 0049, "the plan IS the proposal"), so recalling them means flipping the post_plan from `proposed` back to `brand_draft`. Migration adds that transition to `guard_post_plan_status_transitions`' brand allow-list and extends `emit_post_plan_status_message` so the Conversations log shows "recalled the proposed plan." instead of the generic fallback. UI: "Recall proposal" button in the status-action row on the plan detail page (gated on `statusBucket === 'proposed' && plan.createdBy === userId`, mirroring the original "Propose plan" button's gate).

**Cleanup.** Old `proposeCopyOpen` state + `ProposeCopyChangesModal` mount + the two `propose-copy` status-action button entries are gone. Modal component definition stays in the file in case a deeper "propose with a note" flow is ever revived. The existing `emit_plan_proposal_created_message()` trigger from migration 0047 emits "X proposed copy changes for this plan." in the Conversations log automatically — same event fires for inline-pill proposals.

**Operator action:** apply `0056_proposal_withdrawal.sql` AND `0056b_post_plan_recall_transition.sql` on Supabase before merge.

### 2026-05-22 — Conversations log: "marked as posted" system message via a new trigger on `post_plan_publications`

**Conversations log: "marked as posted" system message via a new trigger on `post_plan_publications`.** Mirrors the existing pattern from migration `0047` (status-change + proposal-created + proposal-resolved triggers calling `emit_plan_system_message`). When a user marks a plan as posted, one row lands in `post_plan_publications` per platform; the new row-level AFTER INSERT trigger emits a system message with a 30-second dedupe window — within that window, subsequent platforms for the same plan + same author UPDATE the existing message body (appending the platform name) instead of inserting a fresh one. Result: a single modal submit covering IG + LinkedIn + X produces one combined message "X marked this as posted on Instagram, LinkedIn, X." instead of three. Two genuinely separate user actions ≥30s apart still produce separate log entries. Format is comma-separated (no "and" / Oxford comma) because the trigger can't predict in advance how many platforms will arrive in the window. Trigger is INSERT-only — UPDATEs and DELETEs deliberately don't log, since they're edits to the live-post record. The "X proposed a copy change" half needs no new code, because `emit_plan_proposal_created_message()` from migration `0047` already fires on every `plan_proposals` insert. Migration: `supabase/migrations/0055_emit_post_plan_publication_message.sql`. No JS, no UI, no env-var work — pure SQL.

### 2026-05-22 — usage-digest fix #2 — Resend 429 returned on the natural fire (PR #115's 600ms spacer was too tight)

**usage-digest fix #2 — Resend 429 returned on the natural fire (PR #115's 600ms spacer was too tight).** The 2026-05-21 fix (PR #115) swapped Resend's `/emails/batch` for sequential single-sends with a 600ms spacer between recipients. The manual-trigger smoke test passed, so the PR shipped — but the next natural pg_cron fire (2026-05-22 07:30 IST) only delivered to 1 of 3 agency recipients. Root cause: Resend uses a sliding 1-second window for the 2-req/sec cap, and `setTimeout(600ms)` between calls means calls 1+2 land inside the same 1-second window (≤1000ms apart) — call 1 succeeds, call 2 returns `429 "2 requests per second"`. Call 3, ~1.2s after call 2, can either succeed or 429 depending on where the sliding-window boundary lands; in practice call 3 also 429'd. Total runtime ~1.7s on the natural fire — too fast for 3 successful Resend calls (each takes ~300-400ms), consistent with 1 success + 2 fast 429-fail. Made worse by the Vercel route's success branch in `web/api/usage-digest.ts` (lines 512-516) discarding `parsed.failed[]` — `net._http_response` only saw `{ok:true, sent:1}`, so the cron HTTP log looked indistinguishable from a clean 3-of-3 delivery; the regression silently masked itself for a full day.

**Fix (three-layer):**
1. `SPACER_MS = 600` → `SPACER_MS = 1100` in `handleServiceUsageDaily` so any 1-second sliding window strictly contains at most one of our calls.
2. `callResend` gains a 1-shot retry on Resend 429 with a 1500ms cool-off — safety net for the case where boundary timing still skews under network jitter / function cold-start / Deno timer drift. 4xx-other and 5xx still bubble up immediately.
3. `/api/usage-digest` response now surfaces `sent`, `total`, `failed[]` and sets `ok: false` whenever `sent < recipients.length` — so the next regression is visible in `net._http_response` directly, no edge-function-log archaeology required.

**Verified:** today's missed digest was manually delivered to the two affected inboxes via direct single-recipient `send-email` curls (Resend IDs `ba63fbd9-…` for lakshith, `de1a5b41-…` for agency) — they bypassed the rate limit because they're single-recipient calls. Tomorrow's natural fire will use the new 1100ms spacer + retry once the operator redeploys `send-email` via Supabase Dashboard (PAT still 401'ing per the prior memo). No schema/migration/env-var work — pure code change to `supabase/functions/send-email/index.ts` + `web/api/usage-digest.ts`. Sections touched: Recent changes log; `Last updated`.

### 2026-05-22 — LinkAI: cross-contamination bug fix — sync `sdkConvIdRef` BEFORE `setMessages` in the align effect

**LinkAI: cross-contamination bug fix — sync `sdkConvIdRef` BEFORE `setMessages` in the align effect.** Bug shipped in the multi-conv refactor earlier the same day. Symptom: every rail click silently corrupted the previous conv's localStorage + cache slot with the next conv's content. After clicking through 3 chats, all 3 slots held the last-viewed conv's messages — clicking back to any earlier conv displayed the corrupted (latest-viewed) content under its original title.

**Root cause.** The AI SDK v6 `useChat.setMessages` setter **flushes synchronously** — calling it from inside an effect triggers an immediate re-render that fires other effects' dep-change handlers BEFORE the calling effect's remaining lines execute. The align effect was:

```js
setMessages(newConvContent);  // ← flushes! persist fires NOW with stale sdkConvIdRef!
setSdkConvId(newConvId);      // ← runs too late; the mirror effect that updates the ref runs even later
```

When persist fired mid-align from the synchronous flush, `sdkConvIdRef.current` still pointed at the OLD conv (the mirror effect that updates it from `sdkConvId` state hadn't run yet, because the `setSdkConvId` call below the flush hadn't executed). So persist wrote `newConvContent` into the OLD conv's slot.

**Fix.** Write `sdkConvIdRef.current = activeConvId` synchronously BEFORE `setMessages` in the align effect (matching the pattern already used in `handleSend` and `brand-switch`). The plain `setSdkConvId` state setter is still called for downstream consumers (display logic, JSX), but the ref is the load-bearing field for the persist effect — and refs update synchronously.

**Diagnosis path.** Couldn't be found by code reading — all 5 scenarios traced through cleanly on paper. Caught by instrumenting persist + align + handleSend + switchToConv with `[LinkAI]` tagged console logs gated behind `?linkaiLog=1`, plus a `window.__linkaiDebug()` helper that dumps current state + every conv's cache/storage length. User's dump showed `persist: WRITE {targetId: OLD, sdkConvId: OLD, activeConvId: NEW}` immediately after every `align: setMessages(loaded) + setSdkConvId(active) {active: NEW, fromSdk: OLD}` — the smoking gun.

**Belt-and-suspenders safeguard kept.** Persist still skips writing when `messages.length === 0` AND the slot has existing content (cache or storage). Cheap insurance against any future race that might wipe a populated slot.

**Recovery for users who hit the bug** (before this fix landed): the existing localStorage entries are corrupted. Run in DevTools console:

```js
Object.keys(localStorage)
  .filter(k => k.startsWith('lr_link_ai_'))
  .forEach(k => localStorage.removeItem(k))
```

…then reload to start fresh.

Files: `web/src/components/LinkAIPanel.jsx` — align effect (sync ref write) + persist effect (empty-slot safeguard kept as defense in depth). Pure client. Sections touched: Recent changes log; `Last updated`.

### 2026-05-22 — LinkAI: multi-conv state machine refactored to a clean `activeConvId` / `sdkConvId` split

**LinkAI: multi-conv state machine refactored to a clean `activeConvId` / `sdkConvId` split.** The previous shape — `streamConvId` + `justMintedConvIdRef` + `lastHydratedKeyRef` + `activeConvIdRef` + `streamConvIdRef` + 3 effects (hydrate, persist, post-stream cleanup) — accumulated through bandaid fixes for: first-message wipe on new chats, breadcrumbs showing mid-session, cross-contamination from rail clicks writing prior-conv content into clicked slots, "lost" chats after switching, and a TDZ from declaration ordering. Every individual fix introduced a new race.

**New model — two ids, one source of truth per slot.**
- `activeConvId` = which conv the USER is VIEWING (drives rail + display).
- `sdkConvId` = which conv the SDK's `messages` array BELONGS TO. The AI SDK gives us one array; we track which conv it represents.
- They diverge in two cases: mid-stream (sdk = the streaming conv, active wherever the user clicked), and briefly right after an idle rail click (active = new, sdk = old until align catches up).

**One align effect replaces hydrate + cleanup.** Fires when `!isBusy && active !== sdk`. Loads target into SDK via `setMessages`, then `setSdkConvId(active)`. Covers every "SDK needs to catch up to the rail" scenario: initial mount, rail click while idle, stream completion when the user navigated away mid-stream, "+ New chat" while idle. While `isBusy` it skips — the SDK array must stay pinned to the streaming conv.

**Persist effect targets `sdkConvIdRef` ONLY**, never `activeConvId`. This is the key invariant that prevents the cross-contamination class of bug. Reads from a ref (not state) so `sdkConvId` stays out of deps — persist only fires on real `messages` / `isBusy` changes, not on the align effect's `setSdkConvId`. Bump+sort the rail only when `isBusy` (real stream activity); align's setMessages also triggers persist but skips the bump.

**`handleSend`** sets `sdkConvIdRef.current = targetConvId` SYNCHRONOUSLY before `sendMessage`, so the first persist fire for the new conv routes tokens to the right slot without depending on mirror-effect timing.

**Brand switch** synchronously resets `sdkConvIdRef = null` + `setSdkConvId(null)` + `setMessages([])` so the persist effect's dep-driven fire on `(userId, accountId)` change finds no targetId and skips — prevents prior brand's messages from being written into the new brand's slot.

**Net result:** All chat behaviors work as the user demanded (Claude / WhatsApp style): multiple historical chats sorted by activity; switch chats mid-stream and see the right messages; type in a new chat while another generates (Send still disabled while busy — the single useChat array can't fork); switch away mid-stream and back without losing history; first message of a fresh chat never wiped; inline images survive nav-away/nav-back.

Files: `web/src/components/LinkAIPanel.jsx` — state declarations + brand-switch effect + align effect (was hydrate) + persist effect + handleSend + startNew + switchToConv + deleteConv + display derivations + rail rendering. Pure client. No schema/migration/env-var. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — LinkAI: rail switching + new-chat + textarea typing all allowed mid-stream

**LinkAI: rail switching + new-chat + textarea typing all allowed mid-stream.** Completes the user's "keep generating in the background" ask. PR C2 disabled the rail interactions while busy (no modal); the previous PR made `useChat` survive route nav via a persistent panel mount. This change lifts the busy-disables off everything *except* the actual Send button + delete-the-streaming-conv (the only true blockers given the AI SDK's single in-flight stream per `useChat` instance).

**Mechanism — `streamConvId` state in LinkAIPanel.** New piece of state that tracks "the conv the SDK is currently streaming INTO", separately from `activeConvId` (the conv the user is currently VIEWING). Set by `handleSend` the moment we call `sendMessage`; cleared by a post-stream cleanup effect once `isBusy` goes back to false.

When the two match (no stream, or user is on the streaming conv) → render `messages` straight from the SDK.

When they differ → render a static snapshot of `activeConvId` from the session cache / localStorage; the SDK keeps appending stream tokens to `streamConvId` in the background. The persist effect targets `streamConvId || activeConvId` so the tokens land in the right localStorage slot, not the displayed conv's.

**Post-stream cleanup effect.** When `isBusy` flips false with `streamConvId` still set: if the user is now on a different conv, rehydrate the SDK to that conv's messages (so their next `sendMessage` starts from the right baseline). Clear `streamConvId`.

**Hydrate effect** gets a new short-circuit: when `streamConvId && streamConvId !== activeConvId`, skip — touching the SDK's messages array would wipe the in-flight stream's tokens.

**UI changes.**
- Rail rows: clickable mid-stream, no more `is-disabled` greying. The streaming conv gets a coral pulsing dot + "Generating…" instead of the relative time.
- "+ New chat" button: enabled mid-stream. Clicking it clears `activeConvId` (but NOT the SDK's messages, which still belong to streamConvId) → hero/empty state on screen. The user can prep an attachment / draft text; Send stays disabled until the current stream ends.
- Delete: still blocked, but only for the streaming conv (orphaning the in-flight request would be bad). All other rows are deletable freely.
- Textarea: typing always enabled. Placeholder updates contextually — "Generating… type your next message" when streaming the active conv, "Type while LinkAI finishes the other chat…" when streaming for a background conv, "Message LinkAI…" otherwise.
- Send button: disabled while `isBusy` (the documented blocker — single useChat can't fork into a parallel stream). Tooltip: "Wait for the current generation to finish, or click Stop."
- Stop button: only renders when the user is VIEWING the streaming conv (clicking Stop while looking at a different background conv would be confusing).
- "Generating…" status indicator + error banner: gated on `streamingActiveConv` — only show on the conv they describe.

**Documented blocker.** Sending a new message in any conv while another is streaming is rejected at the UI level (Send button disabled with tooltip). The AI SDK's `useChat` has one messages array per hook instance; supporting truly parallel streams would require lifting useChat into a multi-instance pattern (one per conv) or building a server-side queue. Out of scope.

Pure client + CSS. No schema/migration/env-var. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — LinkAI: persistent panel mount so streaming survives SPA route navigation

**LinkAI: persistent panel mount so streaming survives SPA route navigation.** Follow-up to PR C2's "stop on switch" change. Half of the user's "keep generating in the background" ask (the rail-switch half) shipped in PR C2 as "disable rail interactions while busy, no modal". This change handles the OTHER half: navigating to a different route while a generation is in flight (e.g. user on `/linkai`, clicks `/calendar`, comes back) used to unmount `LinkAIPanel`, which killed `useChat`'s in-flight fetch — coming back showed only the user's message, no assistant reply.

**Fix:** the page-variant `<LinkAIPanel variant="page">` is now rendered PERSISTENTLY in App.jsx (inside `.main`, always when `auth && calendarAccountId`) wrapped in `<div className="linkai-page is-active?">`. The `is-active` class toggles based on `route.view === 'linkai'`. CSS: `.main:has(.linkai-page.is-active)` gates the 100vh/overflow-hidden layout override (so non-linkai routes aren't affected by the always-mounted panel); `.linkai-page:not(.is-active) { display: none; }` hides the panel when the user is on a different route. React state survives the visibility toggle — `useChat`, conv index, active conv id, attachments, rail scroll all persist. `renderView`'s linkai branch becomes `return null` to avoid double-mounting.

**Effect:** user starts a generation on `/linkai`, navigates to `/calendar` mid-stream, comes back → the stream is still going (or completed and waiting) into the same conv. No more "I lost my response when I checked the calendar."

**Drawer variant unchanged** — still mounted/unmounted via `linkAiOpen` outside `.main`. PR D retires it.

**Known remaining gap (logged to memory `linkai-roadmap-followups`):** hard reload (Cmd+R, tab close) still loses the streaming response — the only way to fix that is server-side resumable streaming, which is a much bigger lift. Out of scope.

Pure client + CSS change (~40 LOC across App.jsx + app.css). No schema/migration/env-var. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — LinkAI PR C2 — image attachments in the composer (paperclip + drag-drop)

**LinkAI PR C2 — image attachments in the composer (paperclip + drag-drop).** The LinkAI composer now accepts image attachments. Two entry points: a paperclip button at the left of the composer row (opens the native file picker), and drag-and-drop anywhere on the LinkAI page (renders a translucent overlay with a dashed accent border + "Drop to attach" card while a file is dragged over the page).

**Constraints (client-enforced):**
- Mime types: `image/png`, `image/jpeg`, `image/webp`, `image/gif` (the four Claude vision supports). PDFs deferred.
- 5 MB per file (Claude's vision limit).
- 4 attachments per message.

Each accepted file is read as a base64 `data:` URL via `FileReader.readAsDataURL` and queued as an `{ id, name, mimeType, size, dataUrl }` entry in component state. Queued files render as chips in a `.link-ai-attach-tray` above the composer row — thumbnail (for images) + name + size + remove ×. First rejection per add-batch surfaces as an inline error chip in the same tray.

**Send-side wiring.** `handleSend` now builds a UIMessage `parts` array: `{type:'file', mediaType, filename, url: dataUrl}` for each attachment, followed by `{type:'text', text}` if there's a prompt. Attachment-only sends (no text) are allowed — "look at this and tell me what you think" with just a dropped image is a real use case. The AI SDK's `useChat.sendMessage` accepts the parts array directly; server-side `convertToModelMessages` in `web/api/ai/chat.ts` maps `file` parts to Claude's vision input blocks with no chat.ts change needed (the AI SDK v6 + Anthropic provider handles it transparently).

**Render in chat thread.** New `file` branch in `renderPart`: image mime types render as a clickable thumbnail (`.link-ai-attachment-img`) on the user's message bubble (max-width 320px, opens full size in a new tab); other file types render as a paperclip-icon chip with filename.

**Persistence.** Attachments are deliberately NOT persisted to localStorage. A 5 MB base64 data URL × multiple messages would torch the 5–10 MB localStorage quota in ~2 turns. The chat stays multimodal in-memory during the session; on reload a small breadcrumb text part (`_[attached N image(s) — not retained after reload]_`) replaces the file parts so the conversation still reads coherently. A future PR can move attachment storage to Supabase Storage with stable URLs and replace the breadcrumb pattern with proper rehydration.

**Composer hint** updated to `⌘↩ to send · drop an image to attach` so users discover the feature without docs.

Pure client + CSS change. No schema/migration/env-var. Sections touched: Recent changes log; `Last updated`. ~280 LOC added between `LinkAIPanel.jsx` (state, helpers, handlers, JSX) and `app.css` (paperclip button, attach tray + chips, drop overlay, in-message attachment renderers).

### 2026-05-21 — LinkAI PR C4 — collapsible history rail + side-by-side artifact pane with explicit "Add to calendar"

**LinkAI PR C4 — collapsible history rail + side-by-side artifact pane with explicit "Add to calendar".** Built ahead of PR C2 (attachments) and C3 (@-mentions) at the user's request — they wanted the side panel + rail collapse together since opening an artifact must auto-collapse the rail to keep the three-column layout sane.

**1

Rail collapse.** New `.link-ai-history-controls` row at the top of the rail with a chevron toggle (`<` to collapse, `>` to expand) and the existing "+ New chat" button. Collapsed state is a 44px-wide strip with just the toggle + an icon-only "+" button — the rest of the rail rolls up. User preference persists per-user (not per-brand — collapse intent is global) at `lr_link_ai_rail_collapsed_${userId}` (`"1"` / `"0"`). When the artifact pane opens, the rail is *temporarily* forced collapsed (`railCollapsed = railManuallyCollapsed || !!artifact`) without touching the persisted preference; closing the artifact restores it.

**2) Artifact pane (right-side).** New `<ArtifactPane>` React component (~200 LOC + ~150 CSS lines under "LinkAI artifact pane (PR C4)"). 420px wide on standard viewports, drops to 360px under 1100px, and goes full-width-over-chat under 900px (`:has(.link-ai-artifact)` queries). Three-section flex column: header (kicker + serif title + meta chips + close ×); scrollable body with one card per `copy_variants[]` entry; footer pinned to the bottom with the CTA. Only renders for `kind: 'plan-draft'` today — extensible to brand-note edits, web-search detail, etc. in future PRs.

**3) Explicit-commit pattern (per memory `linkai-pr-c4-side-panel-explicit-commit`).** The tool card's CTA on `create_post_plan_draft` for the PAGE variant changes from "Open plan →" (which commit+navigated) to **"Preview"** — opens the artifact pane with the in-memory draft, **no DB write**. The pane's footer shows "Add to calendar" as the primary CTA; clicking it calls the existing `onCommitDraft` → on success the pane swaps to a "Added to calendar ✓" state with an "Open in Calendar view →" link (which navigates). Failure surfaces inline error in the footer. The pane stays open after commit so the user doesn't lose their place in chat. DRAWER variant keeps the legacy commit+navigate behaviour (no side panel available — there's no room for a third column inside the 420px drawer). PR D retires the drawer entirely.

**4) Tool-card "Showing in side panel" state.** When the artifact pane is currently displaying a particular tool card's draft, that card's CTA renders in a pressed/disabled style (`.link-ai-tool-cta.is-active`) so it's clear which preview is on screen. Tracked via `openArtifactId` (the `toolCallId` of the open artifact) flowing down through the `renderPart` context.

**5) Brand-side flow unchanged downstream.** `commitAiDraftPlan` still writes brand callers' plans with `status: 'brand_draft'`. Brand users still need to "Propose plan" from the calendar detail view — that's left untouched. The artifact pane just shifts the "I want to commit this" moment from "I clicked Open plan" to "I clicked Add to calendar inside the pane".

Pure client + CSS change. No schema/migration/env-var. Sections touched: Recent changes log; `Last updated`.)

### 2026-05-21 — LinkAI PR C1 — conversation history rail on the full-page surface

**LinkAI PR C1 — conversation history rail on the full-page surface.** Third PR in the LinkAI promotion series (PR A shipped the full-page route; PR B renamed; PR C2/C3/C4 will add attachments / @-mentions / side-by-side; PR D retires the right-side drawer). The `/c/:slug/linkai` page now has a 240px left rail listing the user's past chats for the active brand, newest-first. "+ New chat" at the top of the rail; per-row hover-revealed delete icon; click a row to switch into that chat (mid-stream switches prompt to stop first). The hero/empty state still renders inside the panel when the active conversation has zero messages — same suggestion chips, same composer.

**Storage rewrite** in `web/src/components/LinkAIPanel.jsx`. The drawer variant keeps its single-conversation key (`lr_copilot_conv_v2_${userId}_${accountId}`, name preserved through the PR B rename — see that file's header). The page variant now uses a two-tier scheme: an *index* at `lr_link_ai_index_v1_${userId}_${accountId}` listing every conversation (`[{id, title, createdAt, updatedAt}, …]` sorted newest-first); plus per-conv message arrays at `lr_link_ai_conv_v3_${userId}_${accountId}_${convId}`. New conversations are minted just-in-time on first send (no empty rows ever pile up). Titles auto-derive from the first user-text part of the first message (≤50 chars, ellipsised); they back-fill if the title was still "Untitled chat" when the first real message lands so the rail label updates without flapping. Re-sort on every message change so the active chat bubbles to the top of the rail. `MAX_PERSISTED_MESSAGES = 60` cap moved with the storage helpers so per-conv localStorage stays bounded.

**Drawer → rail import.** On first page mount per (user, brand), if the v3 index is empty AND the v2 single-conv key has messages, those messages are *copied* (not moved) into the v3 store as a single seed entry titled from the existing first message. The v2 key is left in place so the drawer keeps working until PR D retires it.

**UI** lives entirely in `LinkAIPanel.jsx` (rail JSX rendered inside a new `.link-ai-page-wrapper` flex-row that contains the rail aside + the existing `.link-ai-panel--page` content). New CSS block in `app.css` (~120 lines under "LinkAI history rail (PR C1)"): rail container, new-chat button (dashed accent on hover), row + active-state + hover-reveal delete, mobile breakpoint that stacks the rail above the panel under 720px wide. Removed the PR A `.link-ai-page-startnew` floating pill — the rail's "+ New chat" button is the canonical entrypoint now.

**Pure client. No schema, no migration, no env var.** Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — LinkAI PR B — "Co-pilot" → "LinkAI" rename across the codebase

**LinkAI PR B — "Co-pilot" → "LinkAI" rename across the codebase.** Second of four planned PRs (PR A shipped the new full-page surface; PR C adds the history rail + side-by-side + attachments; PR D retires the right-side drawer). Mechanical find-and-replace across 23 source files: all UI strings ("AI Co-pilot" / "Co-pilot" / "Copilot" → "LinkAI"); all React component + identifier names (`CopilotPanel` → `LinkAIPanel`, `CopilotFollowUpChips` → `LinkAIFollowUpChips`, `CopilotStatus` → `LinkAIStatus`, `copilotEligible` → `linkAiEligible`, `copilotOpen` / `setCopilotOpen` → `linkAiOpen` / `setLinkAiOpen`); CSS class namespace (`.copilot-*` → `.link-ai-*` — 60+ selectors); CSS keyframe names (`copilotSlideIn` → `linkAiSlideIn`, `copilotPulse` → `linkAiPulse`); the `buildTemplatedCopilotSuggestions` db helper → `buildTemplatedLinkAISuggestions`; the `COPILOT_GENERIC_SUGGESTIONS` const → `LINKAI_GENERIC_SUGGESTIONS`; comments mentioning Co-pilot. File rename: `web/src/components/CopilotPanel.jsx` → `LinkAIPanel.jsx` via `git mv` (history preserved). Server-side: the system prompt + tool descriptions in `web/api/ai/chat.ts` rename so the model self-identifies as "LinkAI". **Deliberately preserved**: (1) the `lr_copilot_conv_v2_*` localStorage key string so existing users keep their chat history through the rename — comment in `LinkAIPanel.jsx` flags this; (2) the `AI_COPILOT_BRAND_IDS` / `VITE_AI_COPILOT_BRAND_IDS` env var names — referenced only by the paused Trends Radar refresh-cron and renaming would require an operator Vercel-env update for a code-cosmetic win; (3) the historical `AI_COPILOT_V2_MIGRATION.md` runbook + every `0039_ai_copilot_*.sql` / similar migration comment, which describe the build at the time. The 46 remaining mentions in REFERENCE.md are these three legitimate categories (env vars, the historical migration runbook, and the already-removed `COPILOT_ALLOWED_BRAND_IDS` constant). Pure rename — no functional change, no schema, no migration, no env var work required. Sections touched: every changelog entry that mentioned Co-pilot now reads LinkAI (the rename was applied to the doc itself for consistency); Recent changes log; `Last updated`.

### 2026-05-21 — LinkAI PR A — sidebar reorder + new full-page `/c/:slug/linkai` surface + mermaid snag fix

**LinkAI PR A — sidebar reorder + new full-page `/c/:slug/linkai` surface + mermaid snag fix.** First of four planned PRs that promote the LinkAI from a right-side drawer into a first-class sidebar destination (with later PRs B/C/D renaming + adding history-rail + retiring the drawer).

**(1) Sidebar reorder** in `web/src/components/Sidebar.jsx`. `buildBrandNav` now produces a two-group layout: top group is the active-work surfaces (Social Calendar → LinkAI → Conversations → Live posts); a `.nav-sep` divider; then reference/setup surfaces (Brand Intelligence → Library → Trends Radar [agency-only] → Brand notes → Idea dump/Inbox). Sentinel `{ key: 'sep_*', sep: true }` items render as dividers via a new branch in the nav-rendering loop. New `.nav-sep` CSS class in `app.css`.

**(2) New `/c/:slug/linkai` full-page surface.** `linkai` added to `SIMPLE_VIEWS`, `BRAND_SCOPED_VIEWS`, `inBrandRoutes`, the bare-path `parsePathToRoute` block, and the topbar breadcrumb. `renderView` mounts `<LinkAIPanel variant="page" />` inside a `<div className="view"><div className="view-inner linkai-page-inner">` shell with a `Suspense` fallback (LinkAIPanel is lazy-imported per the existing v2 migration). `LinkAIPanel` accepts a new `variant` prop — `'panel'` (default, unchanged) or `'page'`. In page variant: outer class adds `.link-ai-panel--page`, close button is suppressed, header label says "LinkAI" instead of "LinkAI", placeholder says "Message LinkAI…", and the empty-state welcome renders a large serif hero ("Tell me what you want to make for {brandName}. I can ideate, research, draft posts, and plan your calendar — just ask.") instead of the panel's compact welcome card. The right-side drawer behaviour from the topbar "✨ LinkAI" trigger stays untouched (both surfaces co-exist; PR D retires the drawer).

**(3) Mermaid dynamic-import 404 fix** in `web/src/components/ai-elements/message.tsx`. Dropped the `@streamdown/mermaid` plugin import + its entry in `streamdownPlugins`. Marketing chat doesn't render mermaid diagrams, and the plugin's heavy bundle was being code-split into `mermaid-*.js`, which 404'd whenever a Vercel deploy invalidated the hash between an open SPA tab's cached `index.html` and the panel opening — surfacing as the app's ErrorBoundary "snag" page with "Failed to fetch dynamically imported module: …mermaid-*.js". `cjk` / `code` / `math` plugins stay.

**(4) New CSS** (~110 lines added to `app.css`) for `.link-ai-panel--page` (inline positioning instead of fixed; full-width; flex-fill height), `.link-ai-welcome--page` (serif hero), `.link-ai-welcome-hero`, `.link-ai-suggestions` grid layout in page variant, and `.nav-sep`. Sidebar guest-mode is unchanged (LinkAI is only in `buildBrandNav`, not `GUEST_NAV`).

Pure client + asset change — no schema, no migration, no env var. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — Open `/api/engagement/refresh` to brand users for the FIRST scrape per publication

**Open `/api/engagement/refresh` to brand users for the FIRST scrape per publication.** When a brand user (e.g. a brand-owner-only login like the `Lakshith` user — confirmed via DB: `is_agency=false`, owner of multiple brand accounts) marked a post as posted with a live URL, the auto-refresh in `PostPlanDetailView.markPostedSubmit` fired `refreshEngagement(publicationId)` which hit `/api/engagement/refresh`, which 403'd because the route gated on `profiles.is_agency = true`. The 403 was swallowed (the client comment literally said `// brand user, expected`), and the Live Posts tile stayed empty until an agency user (which the brand owner doesn't have access to) clicked "Refresh now" — meaning brand-only setups never saw their tiles populate. Fix: revised auth model in `web/api/engagement/refresh.ts` — agency callers can still call freely; brand callers can now call too, but only when (a) they're a member of the publication's brand and (b) no successful snapshot (`scrape_status in ('ok', 'partial')`) already exists for that publication. If a snapshot already exists, the route short-circuits with `{ ok: true, skipped: 'already_scraped' }` (still 2xx so the client's "refreshing…" state resolves cleanly). Net effect: brand users get a one-shot first scrape on mark-posted (the path the Live Posts tile needs to populate); subsequent updates flow through the daily pg_cron at 06:00 IST. Agency "Refresh now" UI button stays agency-only (no UI change). Updated stale comments: `PostPlanDetailView.markPostedSubmit` (dropped the "brand user, expected" 403 catch), `db.js#refreshEngagement` header, route-file auth-model comment. Pure code change — no schema/migration/env-var. Operator action: none. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — Brand-delete: route to picker when other brands remain, sign out only when last

**Brand-delete: route to picker when other brands remain, sign out only when last.** Settings → Danger zone → Delete workspace used to always `signOut() + window.location.reload()` regardless of whether the user had other brands attached to their session — a brand user with 2 brands deleting one was thrown back to the login screen even though their session was still valid for the remaining brand. Fix in `web/src/components/SettingsView.jsx` `deleteWorkspace`: count `auth.memberships` excluding the brand-being-deleted BEFORE calling `delete_brand_account`. If remaining > 0, set the `lr_brand_just_deleted` flag (existing mechanism — `hydrateProfile` in auth.js reads it to force `requiresBrandSelection = true`), call `setActiveBrand(null)` to clear the per-user active-brand localStorage + rehydrate `_cachedAuth`, then `window.location.assign('/')` (hard reload to drop all per-brand cached state — tasks, realtime subs, etc. — without chasing every useEffect cleanup). The auth-hydrated `requiresBrandSelection` gate in App.jsx (~line 1107) then renders BrandSelectView automatically. If remaining === 0 (last brand), fall through to the original `signOut() + reload()` path since the session has no useful context to preserve. New import of `setActiveBrand` from `../lib/auth.js`. Pure client-side. No schema, no migration, no env var. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — Remove dead agency "Add a client" / "Manage clients" buttons from BrandPicker + fix two adjacent nav/banner bugs surfaced during testing

**Remove dead agency "Add a client" / "Manage clients" buttons from BrandPicker + fix two adjacent nav/banner bugs surfaced during testing.** Three bundled changes in the same brand-picker-area touch.

1

**Dead-button removal.** Both buttons in the agency branch of `web/src/components/BrandPicker.jsx` are gone. "Add a client" was a no-op since the original PR #16 that introduced `create_additional_brand_account` — the RPC explicitly raises `'agency users cannot create brand workspaces'` for any caller with `profiles.is_agency = true` (the button silently failed: modal showed the error, no brand ever created). "Manage clients" is no longer needed as a dedicated entrypoint because selecting "All clients" in the BrandPicker now navigates directly to `/clients` (`AdminClientsView`). Removed: the two `<button>` elements plus the dividing `<div className="brand-picker-sep"/>` separator (the brand-user branch's separator above "Create new brand" stays); the `onManageClients` prop from `BrandPicker` and `Sidebar`; the now-dead agency branch of `handleCreateBrand` (the RPC always threw, so the prior PR #116 careful agency-side navigation was unreachable code); and `handleManageClients` in `App.jsx`.

2) **Agency "All clients" → 404 flash fix.** Selecting "All clients" in the BrandPicker used to `navigate('/home')` and rely on the route-snap effect (App.jsx ~line 614) to bounce `/home` → `/clients`. But `/home` isn't a real route, so `parsePathToRoute('/home')` returned `{ view: 'not_found' }` — and `'not_found'` is in `allClientsRoutes` (so the route-snap intentionally does NOT bounce away from a 404 to avoid render loops on truly bad URLs). The result was a full-render 404 page before the user could do anything; clicking the 404's "Take me to the Social Calendar" button then `navigate('/calendar')`'d, which the route-snap immediately bounced to `/clients` (because calendar isn't a legal route in All-clients mode without a brand) — so the button label said "Social Calendar" but always landed on AdminClientsView. Fix: `handleSelectBrand` (App.jsx) now `navigate('/clients')` directly when `id === ALL_CLIENTS`. No 404 flash, no misleading button.

3) **"Choose a brand workspace below, then resend your brief" banner removed.** This banner was set in `handleSignedIn` whenever `profile?.requiresBrandSelection` was true — but (a) the only two `requireAuth(...)` callers in the codebase both pass `afterSignIn = null` (no actual brief/pending action to "resend"), so the copy was always misleading; (b) the banner had no clear path — it persisted through the BrandSelectView and onto whatever brand surface the user picked, only disappearing on hard refresh. Verified by `grep -rn "requireAuth(" web/src/` — only two callers, both `requireAuth(null, null)`. Removed the `setInviteBanner({...})` line; kept the `setPendingAction(null)` defensive null and the early return so a no-brand sign-in doesn't try to run a pending action against a null brand context. Left a comment in `handleSignedIn` so future callers who add a real `afterSignIn` continuation surface the prompt themselves (in the modal/picker) rather than via a sticky banner.

Pure client-side. No schema, no migration, no env var. Sections touched: Recent changes log; `Last updated`.)

### 2026-05-21 — Brand-user "Create new brand" snap-back — deeper fix

**Brand-user "Create new brand" snap-back — deeper fix.** Test showed the first cut of the snap-back fix only worked for agency callers; brand callers (the actual real-world tester turned out to be a brand user with multi-brand memberships, NOT agency — `is_agency=false` per DB check on `account_members.profiles`) still snapped back. Root cause is a fire-and-forget race in App.jsx's brand-side URL-sync effect (~line 288): `createAdditionalBrand` in `web/src/lib/auth.js` already calls `await setActiveBrand(newId)` internally → `_cachedAuth` is the new brand → fires `lr_auth_change` → App's onAuth listener calls `setAuth(readAuth())` → React re-renders with `auth.account.slug = newSlug` but URL is still `oldSlug`. The brand-side URL-sync effect (which treats URL as source of truth for deep-link routing) sees the mismatch, finds `oldBrand` in `auth.memberships`, and calls `setActiveBrand(oldBrand.id).catch(() => {})` — fire-and-forget. By the time `handleCreateBrand` resumed past its own `await setActiveBrand(newId)`, that fire-and-forget had already won the race: `_cachedAuth` was reset to the OLD brand, so `readAuth().account.slug` returned the OLD slug, and `navigate('/c/${oldSlug}/calendar')` was a no-op. Fix: in `handleCreateBrand`'s brand-user `else` branch, DROP the redundant `await setActiveBrand(newId)` (createAdditionalBrand already did it) and navigate SYNCHRONOUSLY using a memberships-list lookup for the new slug (memberships always contains the new brand row regardless of which brand `auth.account` currently points at after the race). The URL update batches with the pending setAuth so the URL-sync effect sees `URL.slug === auth.account.slug` and early-returns; if the race already happened and auth got reset, the URL-sync effect re-fires after our navigate, finds newSlug in memberships, and calls `setActiveBrand(newId)` to converge auth onto the new brand. Pure client-side. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — React error #310 on brand-flow transitions — "Rules of Hooks" fix

**React error #310 on brand-flow transitions — "Rules of Hooks" fix.** Users saw the "Something went sideways" error-boundary page mid-flow on three transitions: (a) right after login when redirected to the brand picker; (b) right after picking a brand from the picker; (c) right after deleting a brand and being redirected back to the picker. Clicking "Try again" recovered each time. Root cause was a Rules-of-Hooks violation in `web/src/App.jsx`: the brand-selection gate at line ~1107 (`if (auth?.requiresBrandSelection) return <BrandSelectView…>;`) is an EARLY RETURN, but a `useEffect(() => { if (!linkAiEligible && linkAiOpen) setLinkAiOpen(false); }, [linkAiEligible, linkAiOpen])` lived ~30 lines BELOW it. When `auth.requiresBrandSelection` flipped between renders (login → picker, picker → app, delete → picker), the hook count changed render-to-render → React `error #310 "Rendered more hooks than during the previous render"` → ErrorBoundary catches → "snag" page. Fix: moved the `linkAiEligible` / `aiInlineEligible` derivations AND the auto-close `useEffect` to BEFORE the early return. All dependencies (`auth?.id`, `isAllClientsMode`, `scopeAccountId`, `linkAiOpen`) are already defined further up the component so the move is purely cosmetic from a data-flow perspective. Added inline comments at both the moved block and the early return explaining the constraint so future edits don't reintroduce the bug. Pure client-side change — no schema/migration/env-var. Closes the "Brand login React #300" memo from 2026-05-19 (same family of bug, different code's symptom — that earlier #300 was likely an Edit happening to land in a different intermediate render; both share the underlying "hooks below early return" anti-pattern).

### 2026-05-21 — New-brand-creation snap-back fix

**New-brand-creation snap-back fix.** When an agency user with multiple brands clicked "Add a client" in `BrandPicker` and named a new brand, the URL/active brand snapped back to whichever brand was open before instead of landing on the new brand. Root cause was a stale-closure / URL-sync-effect race: `BrandPicker` called `await onCreateBrand?.()` (which inserts + `setBrandAccounts(rows)` + returns `newId`) and then immediately `onSelectBrand?.(newId)` → `handleSelectBrand` ran against the *pre-create* `brandAccounts` closure, `brandAccounts.find((b) => b.id === newId)` returned undefined, the `navigate()` branch was skipped, and the URL stayed on the previous brand's slug; on the next render, the URL-sync effect (`web/src/App.jsx` ~265) found the old brand in the refreshed `brandAccounts` and called `setActiveAdminBrandIdState(match.id)`, snapping back. Fix: `handleCreateBrand` in `web/src/App.jsx` now owns post-create navigation for both agency and brand callers — agency path uses the fresh `rows` to look up the new brand's slug and calls `setActiveAdminBrandId(newId)` + `navigate('/c/${slug}/calendar')`; brand path uses `setActiveBrand(newId)` + `readAuth()` + navigate (mirroring `handleSelectBrand`'s brand-user branch). `BrandPicker.jsx` drops the redundant `onSelectBrand?.(newId)` follow-up call at both create-brand sites (agency "Add a client" and brand "Create new brand"). Pure client-side change — no schema/migration/env-var. Sections touched: Recent changes log; `Last updated`.

### 2026-05-21 — usage-digest email fix — Resend 429 on batch send

**usage-digest email fix — Resend 429 on batch send.** First two scheduled fires of `usage-digest-agency` (2026-05-20 + 2026-05-21 at 07:30 IST) reached Vercel correctly via pg_cron, but the email never landed in agency inboxes. Diagnosis chain: pg_cron → `/api/usage-digest` → Vercel route aggregates fine → calls `send-email` template `service-usage-daily` → `callResendBatch` POSTs all 3 agency recipients to Resend `/emails/batch` in one call → Resend returns `429 "You can only make 2 requests per second"` → `ids.length === 0` → `handleServiceUsageDaily` returns 502 → Vercel route returns 502 → `net._http_response` logs status 502 → no inbox delivery. Confirmed by SQL inspection of `net._http_response` (today's 502 response body literally starts with `"Resend 429: Too many requests..."`). On our Resend plan, the per-second cap is enforced per-message inside a batch call, so a 3-recipient batch counts as 3 ops in <1s and always 429s. The 18:00 IST brand daily-digest works because `handleDailyDigest` is called once per brand and each batch is naturally spaced apart by network/DB latency. **Fix:** `handleServiceUsageDaily` in `supabase/functions/send-email/index.ts` now sends recipients one-at-a-time via the existing single-send `callResend` helper with a 600ms spacer between calls (`SPACER_MS = 600`); agency-team size is small (<10) so the added latency is irrelevant. Verified end-to-end against the prod cron secret + Vercel URL — manual `net.http_post` to `/api/usage-digest` returned `200 OK` and the digest email landed in the agency inbox. Sections touched: Recent changes log; `Last updated`. No schema/migration/env-var work — pure Edge Function code change. Operator action required: redeploy `send-email` via Supabase Dashboard (`supabase functions deploy` is still 401'ing per the PAT memo).

### 2026-05-20 — Live Posts engagement summary redesigned (cumulative-snapshot model)

The original delta-in-window engagement model from earlier today (#113) was confusing for users: a recently-published IG post with 8 likes only contributed `3` to "engagement gained in window" because the first snapshot already captured 5 of those likes before the window opened. Users naturally read the numbers as current totals, not as recent velocity, and the math diverged from what they could see on individual posts. Full rewrite of `loadEngagementSummaryForBrand`.

**New model — "as-of-now" cumulative totals:**
- KPI values are **current cumulative counts** across in-scope publications. A post with 8 likes contributes 8, regardless of window or first-scrape timing.
- **Period selector now scopes WHICH POSTS** to include (`Last 30 days` = posts with `published_at` in the last 30d, `All time` = every post). It's no longer a math window for delta computation.
- **D/W/M deltas** are snapshot-vs-snapshot comparisons: `(current_value - value_N_days_ago) / value_N_days_ago × 100`. To compute the historical value, the helper finds each pub's latest snapshot with `fetched_at <= N-days-ago` and sums.
- **Pubs published AFTER the historical baseline** are excluded from that baseline's aggregate — no phantom "infinite growth" deltas for brand-new posts.

**Sparklines — each tile gets its own series (fixes the bug from #113 where all 3 tiles showed identical lines):**
- Engagement tile → cumulative engagement count over time (climbs as the brand publishes + accumulates)
- Engagement rate tile → rate (engagement / views × 100) at each historical day; rendered with gaps for days where views = 0
- Posts tile → cumulative count of published pubs over time
- Per-platform rows → cumulative engagement for that platform over time

**Per-platform metric chips show current cumulative counts.** The fix the user flagged: an IG row with 5 publications where one post has 8 likes now shows `♥ 8+` (sum of current likes across all 5 IG pubs), not the misleading `♥ 3` from the delta model.

**Renamed tile:** "Active posts" → "Posts". The "active" qualifier (engagement > 0 in window) doesn't apply in the cumulative model. The tile is now just the count of in-scope publications, which is what most people read it as anyway.

**Sparkline component hardened for null values.** The rate sparkline can have `null` on days when no pub had a positive view-count (so rate is undefined). Renderer breaks the SVG path at nulls (uses Move instead of Line), so the line shows a visible gap rather than dropping to zero.

**Two DB reads** (was one in the previous version):
1. All snapshots in the last 60 days — covers vs-last-month baseline + 60-day sparkline densely
2. Absolute latest snapshot per pub regardless of age — catches pubs not scraped in 60+ days so they still show their last-known counts in the "current" total

For a brand with ~50 publications, ~1500 snapshot rows in the 60-day window. Indexed on `(publication_id, fetched_at desc)` so the queries stay sub-millisecond.

**New helper functions in `db.js`:**
- `aggregateAtTime(publications, snapsByPub, asOfMs, platformFilter?)` — sums engagement / views / posts across in-scope pubs as-of a moment. Handles the "pub not yet published at this asOfMs → skip" logic.
- `aggregatePerMetricAtTime(...)` — per-metric variant for the platform chips. Returns null when no pub on the platform reports the metric in any snapshot (UI hides chip).
- `latestSnapshotAtOrBefore(snaps, asOfMs)` — single forward scan since snaps are asc-ordered.
- `lastNIstDateKeysSummary(n, today)` — date-key generator for sparkline X-axis.
- `istDayKeyToEndOfDayMs(key)` — IST date string → end-of-day UTC ms for the aggregator.

**Renamed output shape:**
- `period.postsCount` (was `period.activePubs`)
- `deltas.vsYesterday.postsCount` etc. (was `activePubs`)
- `sparklines: { engagement, rate, posts }` (was a single `sparklineDaily`)
- `byPlatform[platform].sparklineDaily` now uses `{ date, value }` items (was `{ date, engagement }`)
- New `periodLabel` field at the top level (`'7d'` / `'30d'` / `'90d'` / `'all'`)

**Touched files:**
- [web/src/lib/db.js](web/src/lib/db.js) — `loadEngagementSummaryForBrand` + 4 private helpers fully rewritten (~360 LOC; net diff close to wash since we deleted similar amount of dead code)
- [web/src/components/LivePostsSummary.jsx](web/src/components/LivePostsSummary.jsx) — `tiles` useMemo + JSX consume new shape; renamed `tiles.activePubs` → `tiles.posts`; Sparkline rewritten to consume `{date, value}` items + handle null gaps
- No CSS changes needed — same layout, just different numbers in the boxes.

**Sections touched:** Recent changes log; `Last updated`. No schema, no migration, no env vars.

### 2026-05-20 — Live Posts engagement summary strip

New summary block at the top of `/c/:slug/posts` showing KPI tiles + per-platform engagement breakdown, sitting between the existing page-head and the platform filter pills.

**Revised mid-PR** to reflect actual scraper-returned metric coverage rather than aggregating apples-and-oranges. Original PR pulled a single "engagement" total per platform that hid two real issues: (1) LinkedIn's `reaction_count` is populated with the SAME number as `like_count` ([scraper-lib.ts:310-320](web/api/engagement/scraper-lib.ts:310)), so the original sum double-counted LinkedIn engagement; (2) different platforms expose different signals (X has bookmarks + quotes, IG has views on videos, LinkedIn has shares but no views, etc.), and a single rolled-up number obscures that asymmetry. Both addressed below.

**Engagement formula:** `likes + comments + shares + saves`. Universal across platforms, all public signals. **Excluded** from the sum (with rationale):
- `reaction_count` — duplicates `like_count` on LinkedIn (would double-count), `null` elsewhere
- `view_count` — reach, not engagement. Stays as the denominator for engagement-rate.
- `bookmark_count` — X-specific and private (user's personal save list, not public engagement)
- `quote_count` — X scraper already maps retweets to `share_count`; quotes would double-count shares-equivalent activity

**Per-platform metric breakdown** replaces the single per-platform engagement total. Each platform row now renders an icon-prefixed chip strip showing ONLY the metrics that platform's scraper actually returns:

| Platform | Metrics shown |
|---|---|
| Instagram | ♥ likes · 💬 comments · 👁 views (videos only) |
| LinkedIn | ♥ likes · 💬 comments · ⇱ shares |
| X | ♥ likes · 💬 comments · ⇱ shares · 👁 views (probed) · 🔖 bookmarks (probed) |

New `perMetricGainPlatform()` private helper in `db.js` returns `null` when no publication on a platform has any non-null sample for a metric — the UI hides the chip rather than rendering "—". This means a brand with only LinkedIn posts won't see ghost "0 views" chips, and an X publication whose scraper run happened to miss `bookmark_count` doesn't get a hallucinated zero.

The KPI tile aggregation still uses the universal `engagement = likes + comments + shares + saves` formula so cross-platform comparison stays meaningful.

**Layout:**
- **Top row** — 3 KPI tiles (Engagement / Engagement rate / Active posts). Each tile has:
  - Big-number value
  - Optional annotation ("views from IG/X only" on the rate tile when partial-coverage)
  - 24px-tall inline-SVG sparkline showing daily-delta engagement over the selected period
  - 3 deltas underneath: vs yesterday, vs last week, vs last month (signed % for engagement, percentage-points `pp` for rate, integer `+N`/`-N` for active-post count)
- **Divider**
- **Per-platform rows** — Instagram / LinkedIn / X (only rendered for platforms with ≥1 publication). Each row: colored dot + name, post count, total engagement, mini-sparkline, week-over-week % change.

**Period picker top-right:** 7d / 30d / 90d / All time. Default 30d. Choice persisted in `localStorage.lr_live_posts_summary_period`.

**Data layer (`web/src/lib/db.js`):** new `loadEngagementSummaryForBrand(accountId, periodDays)` helper. Single DB read — 90 days of `post_engagement_snapshots` rows for the brand's publications (90 chosen so the "vs last month" baseline window at 30-60 days ago has data even when the selected period is 30d). All aggregation client-side.

**Engagement math:**
- Snapshots are cumulative counts (likes total, etc.) — to express "engagement gained in a window" we compute (latest snapshot in window − earliest snapshot in window) per publication, then sum.
- Days bucketed by IST calendar date (`sv-SE` locale + `Asia/Kolkata` timezone) so day boundaries align with the cron's 06:00 IST refresh schedule.
- Daily-delta carry-forward: missing snapshots on a given day inherit the most recent known value, so a day with no scrape contributes 0 to the daily delta rather than a phantom drop.

**Engagement-rate handling for mixed platforms:** LinkedIn never exposes views, X often doesn't. When at least one pub reports views and at least one doesn't, the rate tile annotates with `views from IG/X only` so the displayed rate isn't misread as platform-wide.

**Delta thresholds:**
- `|Δ%| < 5` → grey "─ flat"
- `|Δ pp| < 0.5` → grey "─ flat" (for engagement rate)
- Active-post count deltas always shown as `+N` / `-N` integers (no percentage)
- Zero-baseline edge cases handled: 0→0 renders flat, 0→positive renders `—` (can't express infinite growth as %)

**Color rules:** green ▲ for engagement-up, coral ▼ for engagement-down, grey ─ for flat, em-dash `—` for unknown / insufficient data. Matches the daily-digest email's arrow convention.

**Empty + loading states:**
- Brand with zero live publications → "No live posts yet — mark a post plan as posted (with its live URL) to start tracking engagement here."
- Loading → 3 shimmer-animated tile placeholders so the layout doesn't jump.
- Network error → coral error string, doesn't crash the tiles below.

**Touched files:**
- New: [web/src/components/LivePostsSummary.jsx](web/src/components/LivePostsSummary.jsx) — ~310 LOC. Includes inline Sparkline + PeriodPicker + KpiTile + PlatformRow subcomponents. No new deps.
- [web/src/lib/db.js](web/src/lib/db.js) — new `loadEngagementSummaryForBrand` helper (+ private helpers `bucketByIstDay` / `lastNIstDateKeys` / `dailyDeltaSeries` / `viewGainsInRange` / `activePubCount` / `pctChange`). ~280 LOC.
- [web/src/styles/app.css](web/src/styles/app.css) — new `.lps-*` namespace, ~210 LOC. Responsive (1-column at ≤720px).
- [web/src/components/LivePostsView.jsx](web/src/components/LivePostsView.jsx) — 2-line wiring: import + JSX placement.

**Verification:** typecheck-equivalent passes (Vite-served files all transform cleanly), no console errors, no React rendering errors. Visual verification deferred to production deploy since this worktree has no auth env.

**Sections touched:** Recent changes log; `Last updated`. No schema, no migration, no env var, no edge function changes.

### 2026-05-19 — AI features open to all brands (allowlist dropped)

The Bamboo Bear-only allowlist is gone. LinkAI chat, inline ✨ AI draft / redraft on the copy editor, the AI image-prompt panel, and the welcome-screen suggestion chips all work for every brand on the platform now — agency and brand callers alike.

**Cost protection still in place.** The per-brand 50 AI calls / day quota in `web/api/ai/auth-lib.ts`'s `checkAndRecordAiUsage()` (shipped in Phase 1) stays as the live guardrail:
- **Agency users:** uncapped; calls still logged for telemetry.
- **Brand users:** hard 50/day cap across all 4 AI surfaces, day boundary midnight IST. 429 past the cap with the "Refreshes at midnight IST" message the AI SDK surfaces in the chat panel.

Combined with the daily usage-digest from #108 (next fire: 07:30 IST tomorrow), any spend spike from the wider rollout will be visible the next morning.

**Server-side changes:**
- [web/api/ai/auth-lib.ts](web/api/ai/auth-lib.ts) — removed the `allowlist: Set<string>` parameter from `authorizeAiCall()`'s signature; removed the `if (!allowlist.has(accountId)) return 403` block; updated the docstring to describe the new (3-step) auth flow.
- [web/api/ai/chat.ts](web/api/ai/chat.ts) — removed the `WHITELIST = new Set(process.env.AI_COPILOT_BRAND_IDS ?? '')` constant + the `allowlist: WHITELIST` argument in the `authorizeAiCall({...})` call.
- [web/api/ai/copy.ts](web/api/ai/copy.ts) — same removals.
- [web/api/ai/image.ts](web/api/ai/image.ts) — same removals.
- [web/api/ai/suggestions.ts](web/api/ai/suggestions.ts) — same removals.

**Frontend changes (`web/src/App.jsx`):**
- Removed `COPILOT_ALLOWED_BRAND_IDS` Set + `import.meta.env.VITE_AI_COPILOT_BRAND_IDS` env read.
- `linkAiEligible` simplifies to `auth?.id && !isAllClientsMode && !!scopeAccountId` — any signed-in user with a selected brand context. `aiInlineEligible` continues to alias `linkAiEligible`.
- The auto-close useEffect that closes the LinkAI panel when eligibility falls off stays — now it only closes when the user switches to All-clients mode (which is correct behavior).

**What stays gated (deliberate):**
- The Trends Radar daily refresh-cron at [web/api/trends/refresh-cron.ts](web/api/trends/refresh-cron.ts) still respects the `AI_COPILOT_BRAND_IDS` allowlist. That cron refreshes `brand_trend_snapshots` used by the AI brand-context compiler, but Trends Radar is paused per the user's broader call, and `compileBrandContext` falls back gracefully when trend snapshots are absent. When Trends comes off pause, this gate goes too.
- The `accounts_ensure_brand_conversation` trigger and other gating elsewhere in the system that's role-based (agency vs brand, owner vs member) is unchanged — this PR only drops the AI feature allowlist.

**Operator cleanup (post-merge, optional):**
- `AI_COPILOT_BRAND_IDS` env var in Vercel — now orphan, no code references it. Remove from Vercel project env when convenient. Not blocking.
- `VITE_AI_COPILOT_BRAND_IDS` env var in Vercel — same.

**Test plan after merge:**
- [ ] Sign in as a non-Bamboo-Bear brand. BrandPicker → that brand → look for the ✨ LinkAI button in the topbar. **Should be visible** (was hidden before this PR).
- [ ] Open the LinkAI, send a chat message. **Should stream back** (was 403'd before).
- [ ] On a post plan, click ✨ AI draft on a copy field with an instruction. **Should stream a draft**.
- [ ] Same for image-prompt panel + suggestion chips.
- [ ] Tomorrow morning at 07:30 IST: the usage-digest email should show Claude cost for whichever brand exercised the new access (assuming any did between now and tomorrow's window close at 00:00 IST May 20).

**Sections touched:** Recent changes log; `Last updated`; §10 Edge functions & integrations (auth-lib's allowlist gate removed); §14 Pending work (drop the "LinkAI per-account toggle vs env-var allowlist" entry — replaced by this PR's reality). No schema change, no migration.

### 2026-05-19 — Digest crons moved to Supabase pg_cron

Both digest crons — the 18:00 IST brand daily-digest and the 07:30 IST agency usage-digest — move off Vercel Hobby cron onto Supabase pg_cron. The Vercel API routes (`/api/daily-digest`, `/api/usage-digest`) themselves are untouched; only the caller changes.

**Why:** two confirmed Vercel-cron deploy-churn misses in eight days.
- **2026-05-11 18:00 IST** — brand daily-digest missed; user reported on May 12 morning when checking yesterday-was-Sunday status.
- **2026-05-19 18:00 IST** — brand daily-digest missed again, same day we shipped 4 PRs to main (#106, #107, #108, #109 — heavy deploy activity through the 18:00 window). User manually fired via curl at 21:56 IST.

Vercel's scheduler skips cron fires that overlap with an active deploy build. On any day with 3+ PR merges, the risk is meaningful. Patterns shows up: this won't be the last time. pg_cron runs inside Postgres, completely decoupled from Vercel deploys, so the trigger is reliable even on push-heavy days.

**Same pattern as `0045` (engagement-refresh-daily):**
- New migration `0054_digests_to_pg_cron.sql` enables pg_cron + pg_net (idempotent — already on from `0045`).
- Adds one new Vault secret `vercel_app_url` (operator sets to `https://agency.linkrunner.io` after applying). Stored in Vault to match the existing `engagement_project_url` pattern.
- Re-uses existing `engagement_cron_secret` Vault entry for the bearer — that secret's value already matches Vercel's `CRON_SECRET`, which is what every cron in the project shares.
- Schedules two `pg_cron` jobs:
  - `daily-digest-brand` on `30 12 * * *` UTC = 18:00 IST
  - `usage-digest-agency` on `0 2 * * *` UTC = 07:30 IST
- Both call `net.http_post()` with a 90s timeout (Vercel function cap is 60s; 90s gives pg_net headroom for network egress + a brief tail).
- `vercel.json` drops both entries from its `crons` array. Trends Radar cron stays on Vercel for now since Trends is paused.

**The Vercel routes don't change.** Same `CRON_SECRET` bearer auth check, same idempotency, same `daily_digest_log` audit writes for daily-digest. pg_cron just becomes a different caller — and a more reliable one.

**Failure modes worth knowing:**
- If `vercel_app_url` is still the `REPLACE.example.com` placeholder after applying, pg_net POSTs to a non-existent host. `select * from net._http_response order by created desc` shows DNS errors. Fix: update the Vault entry.
- If `engagement_cron_secret` doesn't match Vercel's `CRON_SECRET` env var, the Vercel route returns 401 and the email never lands. `net._http_response.status_code = 401`. Fix: rotate the Vault entry to match.
- If Vercel's deploy is hard-down (rare), pg_cron retries on the next scheduled fire — no built-in retry. For the daily-digest specifically, the idempotency check inside the route means the operator can also manually `curl` later in the day to recover.

**Touched files:**
- New: [supabase/migrations/0054_digests_to_pg_cron.sql](supabase/migrations/0054_digests_to_pg_cron.sql) — extensions + Vault secret + two cron schedules.
- [web/vercel.json](web/vercel.json) — both digest cron entries removed from the `crons` array.

**Operator action required:**
1. Apply migration `0054_digests_to_pg_cron.sql` via Supabase Dashboard SQL editor (or `supabase db push`).
2. Set the new Vault secret to the prod URL:
   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'vercel_app_url'),
     'https://agency.linkrunner.io'
   );
   ```
3. Vercel auto-deploys the updated `vercel.json` on merge — the Vercel-side cron entries vanish on the next deployment.
4. Verify cron schedules registered:
   ```sql
   select jobname, schedule, command from cron.job
   where jobname in ('daily-digest-brand', 'usage-digest-agency');
   ```

**Test plan after merge + migration:**
- [ ] Manual fire the daily-digest via pg_net (the verify-1 query in the migration comments) → email lands in brand inbox, `daily_digest_log` shows a row with `run_at` matching now.
- [ ] Manual fire the usage-digest the same way → email lands in agency inboxes.
- [ ] Wait for the next natural fire (next 12:30 UTC for daily-digest, or next 02:00 UTC for usage-digest, whichever comes first). Confirm pg_cron fired on schedule.

**Sections touched:** Recent changes log; `Last updated`; §6 Migrations (new `0054` row); §10 Edge functions & integrations (note that the digest crons now live in pg_cron, not Vercel).

### 2026-05-19 — AI-route telemetry wiring + daily digest header fix

Small follow-up to #108. Completes the telemetry coverage for the four AI routes (chat / copy / image / suggestions) so the daily usage digest starts showing Claude cost + token counts alongside the Apify scrape data. Also fixes one cosmetic bug in the digest email header noticed on yesterday's first natural send.

**AI route wiring:** each of the four routes already had an `onFinish` callback (or, for chat, didn't have one and got one added in this PR) doing per-call `console.log` for Vercel Function Log observability. The wiring just adds a parallel `logServiceUsage()` call inside the same callback. Pattern is the same in every route:

```ts
const startedAt = Date.now();
const result = streamText({  // or streamObject for suggestions / image-ideas
  ...,
  onFinish: ({ totalUsage, finishReason }) => {  // ({ usage }) for streamObject
    // existing console.log stays
    void logServiceUsage({
      service: "anthropic",
      route: "/api/ai/<name>",
      accountId: body.accountId,
      userId: caller.userId,
      tokensIn: totalUsage.inputTokens ?? 0,
      tokensOut: totalUsage.outputTokens ?? 0,
      costUsd: estimateAnthropicCostUsd({ model: MODEL_ID, ... }),
      latencyMs: Date.now() - startedAt,
      status: "ok",
      meta: { model, finish_reason, cache_read_tokens, cache_write_tokens, ...routeExtras },
    });
  },
});
```

**Per-route extras in `meta`:**
- chat: `caller_is_agency` (so the digest's per-brand bucketing can tell agency vs brand spend).
- copy + image: `plan_id`, `platform`, `mode` (so a future per-plan cost view is one query away).
- suggestions: nothing extra — these are always agency-initiated, brand-scoped via accountId.

**Multi-step / repair-model handling (chat-specific):** chat.ts can run multiple LLM calls in a single request (tool-call steps + the SDK's silent `experimental_repairToolCall` Haiku fallback for malformed tool inputs). `totalUsage` aggregates token counts across all of them. Repair calls bill at Haiku rates but our cost estimator uses the primary MODEL_ID (Sonnet 4.6) — slight over-estimate, tolerable since repair calls are a single-digit % of token volume.

**Cosmetic fix:** yesterday's first usage-digest email landed at 21:56 IST with header "Daily service usage · Monday Mon May 18, 2026" — the long weekday from `istWeekdayLabel` and the short weekday baked into `istDateLabel` were both being rendered. Dropped the `${istWeekdayLabel}` interpolation from the header in `send-email/index.ts`'s `service-usage-daily` template. Header now reads "Daily service usage · Mon May 18, 2026" matching the subject-line format.

**Touched files:**
- [web/api/ai/chat.ts](web/api/ai/chat.ts) — new `onFinish` on the streamText call.
- [web/api/ai/copy.ts](web/api/ai/copy.ts) — extended existing onFinish.
- [web/api/ai/image.ts](web/api/ai/image.ts) — extended the shared `logUsage` helper.
- [web/api/ai/suggestions.ts](web/api/ai/suggestions.ts) — extended existing onFinish.
- [supabase/functions/send-email/index.ts](supabase/functions/send-email/index.ts) — single-line header fix in `renderServiceUsageDaily`.

**Operator action required:** `supabase functions deploy send-email` (or Dashboard equivalent) to ship the header fix. The four AI route changes deploy automatically via Vercel on merge. Migration `0053` already applied per the parent PR.

**Sections touched:** Recent changes log; `Last updated`. No schema, no migration, no env-var work.

### 2026-05-19 — Service usage telemetry + daily digest email

Operational observability for every external-service call we make on behalf of users — Anthropic (Claude), Firecrawl, Apify. New append-only audit table, fire-and-forget logger helper, daily aggregated email to the agency team. Sets up two things the next launch milestones depend on: (a) the per-brand AI chat quota check (helper exists, route wiring waits on the parallel brand-side AI rollout), and (b) a daily ops digest so we never get surprised by an Apify monthly-cap or a Claude bill spike.

**Schema (`0053_service_usage_log.sql`):**
- Table `service_usage_log` with `(service, route, account_id, user_id, tokens_in, tokens_out, cost_usd, latency_ms, status, error, meta)`. `service` constrained to `('anthropic'|'firecrawl'|'apify')`; `status` to `('ok'|'failed'|'blocked')` ('blocked' is reserved for upstream quota/4xx errors distinct from genuine 5xx fails).
- Indexes: `(created_at desc)` for last-24h totals, `(service, created_at desc)` for per-service trends, `(account_id, created_at desc)` for top-brands, plus a **partial** `(account_id, created_at desc) where service='anthropic'` for the hot quota-check path so per-chat-message lookups stay sub-millisecond.
- RLS: agency-only SELECT via `is_agency_user()`; no INSERT/UPDATE/DELETE policy at all — service-role bypasses, regular auth users hit no-policy-matched and get denied. Same shape as `daily_digest_log` and `post_plan_status_log`.

**Shared helper (`web/api/_shared/usage.ts`):**
- `logServiceUsage({service, route, accountId, userId, tokensIn, tokensOut, costUsd, latencyMs, status, error, meta})` — singleton service-role client per cold start; INSERT fire-and-forget; **never throws** so the hot path never blocks on telemetry. On any failure (env missing, network blip, Supabase down) we lose the row and the route returns normally.
- `estimateAnthropicCostUsd({model, inputTokens, outputTokens, cacheWriteTokens?, cacheReadTokens?})` with rate cards baked in for `claude-sonnet-4-6` / `claude-opus-4-6` / `claude-haiku-4-5` (input + output + cache-write + cache-read prices per million tokens). Fresh-input is computed as `inputTokens - cacheWriteTokens - cacheReadTokens` so the math doesn't double-count.
- `estimateFirecrawlCostUsd(credits)` — flat $3/1000 credits.
- `estimateApifyCostUsd(actorId, resultCount)` — per-actor table: IG $0.0023, LinkedIn $0.001, X $0.0002. Unknown actor falls back to IG rate (conservative).
- `checkBrandAiQuota({accountId, isAgency})` returns `{allowed, used, remaining, resetsAt, bypass}`. 50 messages/brand per rolling 24h, agency bypass (always `allowed: true, bypass: true` regardless of count). Uses a single `select(count: 'exact')` query against the partial index. Fails OPEN on DB errors — degraded observability beats a false-positive 429 on the user.
- `AI_QUOTA_PER_BRAND_PER_DAY` re-exported so the digest cron + future UI can show the right cap without hard-coding 50.

**Engagement wiring:**
- `web/api/engagement/refresh.ts` — on-demand scrape. Join extended to `post_plan_publications.post_plans(account_id)` so the cost row attributes to the right brand. `logServiceUsage` fires after `dispatchScrape` with `service='apify'`, `route='/api/engagement/refresh'`, status mapped from `ScrapeResult.status` (`partial → ok`, `failed → failed`, `blocked → blocked`), meta carries `{actor_id, actor_run_id, platform, scrape_status, publication_id}`. Latency measured around the dispatch call only.
- `supabase/functions/engagement-refresh/index.ts` — daily Supabase pg_cron at 06:00 IST. Same publications query extended with the join. Deno function can't import from the Vercel API tree, so a small `logScrapeUsage()` mirror lives inline at the top of the file alongside an `APIFY_USD_PER_SCRAPE` rate-card duplicate (deliberate two-call-site copy; if a third site appears, extract to `supabase/functions/_shared/usage.ts`). Fires inside the Promise.allSettled chunk for every scrape; doesn't block the per-scrape persist.
- `fetch-trends.ts` (Trends Radar Firecrawl wiring) **deliberately deferred** per the Trends Radar pause. Wire in a follow-up once Trends comes off pause; helper is ready, just an import + call site.

**Daily digest cron (`web/api/usage-digest.ts`):**
- Vercel cron `0 2 * * *` UTC (= 07:30 IST). Hobby-tier-compatible (once-daily fire).
- Window math: yesterday's IST-day, 00:00 → 00:00 IST, converted to UTC. Baseline window: 7 IST-days before yesterday, used for Δ-vs-7-day-avg on per-service rows and the snapshot tile. Subject line shows the IST date label so "Tue May 19, 2026" maps unambiguously to a single 24h window.
- Aggregation passes (all in-memory after two range queries): per-service totals, per-account totals (top 5 by cost), per-account anthropic-chat counts (vs. 50-msg cap; alert at ≥80%), errors grouped by `(service, route)` with example error message + count.
- Recipients: looked up at cron time. Find the single agency-type account → `account_members` user_ids → page through `auth.admin.listUsers()` (same pattern as daily-digest, the `account_members_with_email` RPC refuses service-role callers since `auth.uid()` is null). Auto-includes new agency members, auto-excludes removed ones — no env-var maintenance.
- Dispatches to `send-email` with `template='service-usage-daily'`, CRON_SECRET bearer auth. Skips with `skipped: 'no_agency_recipients'` if the agency account has zero email-capable members.
- Returns `{ok, sent, payload}` on success — the JSON includes the full aggregated payload for debugging.

**Email template (`send-email` edge function — new `service-usage-daily` case):**
- Subject adapts: `Linkrunner Media · Daily usage · Tue May 19, 2026 · $1.47` (normal); `· N alert(s)` suffix when alerts present; `· idle` suffix when zero calls. Cost is the leading metric, not call count.
- HTML matches the daily-digest aesthetic — 600px max-width centered card, brand cream header band, table-based layout (Outlook compat), inline styles only. Sections: header band → 3-tile snapshot (cost / calls / active brands of total) with Δ-vs-7d-avg under the cost → "By service" table (Service · Calls · Volume · Cost · Δ vs 7-day avg, with ▲/▼/─ arrows colored mustard for spend-up / green for spend-down / grey for flat) → optional "Top N brands by spend" table → optional alerts block (mustard `#FEF3C7` / `#A16207` styling, matches the `needs_review` pill) → errors block (coral when non-empty, muted "None." when clean) → footer link.
- Idle-day variant (zero calls) renders a single italic notice "No external service calls were made in this window. Either traffic was zero, or the telemetry pipeline didn't fire. Worth a glance at the next run." — beats sending three empty tiles.
- Plain-text MIME fallback included; mirror of the HTML content with monospace-aligned columns. CRON_SECRET-gated, same auth model as daily-digest.

**Vercel config:** new entry under `functions["api/usage-digest.ts"]` with `maxDuration: 60`, new entry under `crons` at schedule `0 2 * * *`. Total active Vercel crons now three (daily-digest 12:30 UTC, trends 00:30 UTC, usage-digest 02:00 UTC) — all on once-per-day cadence, comfortably inside the Hobby tier limit.

**Operator action required (you do this, not Claude):**
- Apply migration `0053_service_usage_log.sql` via Supabase Dashboard's SQL editor (or `supabase db push`).
- Redeploy the `send-email` edge function so the new `service-usage-daily` template case ships: `supabase functions deploy send-email`.
- Vercel auto-redeploys the new `/api/usage-digest` route + cron on the next push to `main`.

**Test plan:**
- After applying migration: do one mark-as-posted with a real Instagram URL → verify `service_usage_log` lands a row with `service='apify'`, `cost_usd ≈ 0.0023`, `status='ok'`, correct `account_id` from the joined post-plan.
- Manually invoke the digest: `curl -H "Authorization: Bearer $CRON_SECRET" https://agency.linkrunner.io/api/usage-digest` → response should be 200 with `ok: true, sent: N` where N = agency-account members with email, payload echoes yesterday's aggregation. Check inbox for the email.
- Empty-state: invoke on a day with zero `service_usage_log` rows → email subject ends in `· idle`, body shows the italic notice instead of tiles. Errors section says "None.".
- Alerts: temporarily lower `QUOTA_PER_BRAND_PER_DAY` (in `usage.ts` only, not committed) to 5 + send enough chat messages → next digest should list the brand in the mustard alerts block.

**Sections touched:** Recent changes log; `Last updated`; §6 Data model (new `service_usage_log` row); §6 Migrations (`0053` row); §10 Edge functions & integrations (new `service-usage-daily` template); §14 Pending work (launch-readiness slate).

### 2026-05-19 — Live Posts: daily-refresh cadence callout

Brand users on `/c/:slug/posts` see a small clock-icon line directly under the page heading: *"Engagement stats refresh daily at 6:00 AM IST."* Sets the cadence expectation without needing the per-tile "Refresh now" affordance (which stays agency-only). The 06:00 IST time matches the actual Supabase pg_cron job `engagement-refresh-daily` (`30 0 * * *` UTC, migration `0045`). One-file change in `web/src/components/LivePostsView.jsx`; uses the existing `<Icon name="clock">` from the icon library + `var(--ink-4)` for muted secondary-text color. Brand & agency both see the line; agency sees it alongside the per-tile manual button.

**Touched files:** [web/src/components/LivePostsView.jsx](web/src/components/LivePostsView.jsx) — 14-line insertion under the existing sub-heading. No new migration, no schema work, no env vars.

**Sections touched:** Recent changes log only — surface-level UI annotation, the data flow + cron schedule it documents are already in §9 and §10.

### 2026-05-19 — Conversations: inline attachments polish

Three small UX wins on the per-brand chat's attachment rendering. Closes a long-standing visual gap where the chat's attachment block was structurally functional but felt like a stub compared to the polished plan-attachments grid.

**(1) Image attachments → open in shared `<Lightbox/>`.**
Previously: image click opened the public URL in a new tab — visually flat, no zoom, no obvious way back, and the lightbox the rest of the app uses for attachments was nowhere to be seen.
Now: click flows through `useLightbox().open({ src, mimeType, name, alt, downloadUrl })`. Same surface plan attachments use — zoom on click, arrow-key nav (no-op for a single-image lightbox but consistent), Download button in the chrome, escape to close, body-scroll lock. The `<img>` is wrapped in a `<button>` so it's keyboard-focusable + screen-reader-labelled (`Open <filename>`). `loading="lazy"` added so off-screen images don't fetch on initial render. Cursor is `zoom-in` on hover.

**(2) File chips grow an explicit Download icon button.**
Previously: the whole file chip was a single `<a target="_blank">`. On Safari/iOS that often inline-previews the file (PDF, image, text) and leaves the user no obvious save path. The "paperclip" icon doesn't communicate "downloadable" — it just says "this is an attachment."
Now: the chip is split into two side-by-side buttons sharing a border:
- **Open** (filename + size, fills available width) — routes through `lightbox.open()`. The lightbox's mime classifier handles PDFs / images / videos / audio natively; everything else falls back to its internal `window.open()` path. So clicking a PDF previews it in the lightbox, clicking a `.zip` opens the standard browser save dialog.
- **Download** (download icon, fixed width, vertical divider) — forces an actual download by creating a programmatic `<a download>` element. Always works regardless of mime, regardless of browser, regardless of whether the file would normally inline-preview.

The chip now reads as one visual unit (single rounded border, one hover state on the wrapper) but the two action affordances are unambiguous.

**(3) Inline `<video>` gains `playsInline`.**
Tiny but important: without `playsInline`, iOS Safari hijacks the video into a full-screen player on tap, which contradicts the "videos stay in the bubble" pattern. With it, the video plays inline like every other video on the web.

**CSS** — six new rules added to [app.css](web/src/styles/app.css) (kept inside the same `.conv-attachment-*` namespace as the existing rules):
- `.conv-attachment-image-btn` — button reset + `cursor: zoom-in` + focus-visible outline (so keyboard users get a clear focus ring).
- `.conv-attachment-image-btn:hover .conv-attachment-image` — brand-accent border tint on hover.
- `.conv-attachment-file` — restructured from a single anchor to a two-button wrapper with `overflow: hidden` so the shared border clips the inner buttons cleanly.
- `.conv-attachment-file-open` — flex-1 button, no chrome, ellipsis-truncates long filenames.
- `.conv-attachment-file-download` — fixed-width icon button with vertical divider on the left, accent hover background.
- All three new buttons get `:focus-visible` outline rings.

**Same treatment in thread drawers.** `AttachmentBlock` is the shared renderer used by both the main feed and the thread drawer, so the polish applies in both surfaces automatically.

**Touched files:**
- [web/src/components/ConversationsView.jsx](web/src/components/ConversationsView.jsx) — `AttachmentBlock` rewritten, new `useLightbox` import.
- [web/src/styles/app.css](web/src/styles/app.css) — `.conv-attachment-*` rules reshuffled + extended.

**Sections touched:** Recent changes log; `Last updated`. No schema, no migration, no env vars. The shared `<Lightbox/>` is already mounted at the app root (since the plan-attachments rollout), so no provider wiring needed.

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
- Role-only features explicitly kept on `isAdmin`: status workflow buttons matrix, auto-title sparkle banner, Duplicate plan, LinkAI AICopyPreview + AIImagePromptPanel, References / Deliverables subtitle / emptyText / upload / caption-edit gates.
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

**Next:** PR 3 wires up brand-side "Propose plan" CTA on the calendar, agency-side accept/reject modal for new-plan proposals, and updates the LinkAI brand-side button label from "Submit for review" to "Propose plan".

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

### 2026-05-15 — LinkAI: refresh produces fresh suggestions + scroll detaches during streaming
Two small but visible UX wins on the LinkAI panel, bundled.

**(1) Refresh button was returning the same suggestions.** Temp 0.9 alone isn't enough — Anthropic models converge on near-identical output for identical (within-day) prompts. The route now takes a `previousSuggestions: string[]` argument, the client accumulates every suggestion the admin has been shown into a session-local ref (`seenSuggestionsRef`, capped at 16 entries, deduped case-insensitively), and the prompt explicitly names them with a "DO NOT repeat or paraphrase any of these — pick genuinely different angles" block. A 6-char nonce is also injected on every call so even the first refresh in a session lands a byte-different user message. Brand switch clears the accumulator (would over-constrain the new brand otherwise). While the refresh is in flight, the previously-rendered chips are hidden via a `refreshingSuggestions` flag so the admin sees a clear "new ones coming" beat instead of the stale chips lingering ~500ms until the new stream produces output.

**(2) Scroll was being pulled down on every streamed token.** Made it impossible to read earlier messages mid-generation. Added stick-to-bottom logic with a `SCROLL_SLOP = 64` tolerance: a `stickToBottomRef` flag is maintained by a single scroll listener on the message container, updated to `(scrollHeight - scrollTop - clientHeight) <= SLOP`. The auto-scroll effect now bails out when the user is detached. Scrolling back within 64px of the bottom re-engages auto-follow. When the user is detached AND the model is mid-stream, a "New tokens below ↓" pill surfaces above the composer; clicking it scrolls to the bottom and the scroll listener picks that up to flip stickiness back to true. Slop of 64px is generous enough that a single streamed token (a few chars / pixels) never accidentally marks the user as detached between scroll-event firings.

**Touched files:**
- [web/api/ai/suggestions.ts](web/api/ai/suggestions.ts) — `previousSuggestions` request field; per-call nonce; user-message rewrite with explicit anti-repetition block.
- [web/src/components/LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx) — `seenSuggestionsRef` + `refreshingSuggestions` for fix #1; `stickToBottomRef` + scroll listener + `detached` state + jump-to-latest pill for fix #2.
- [web/src/styles/app.css](web/src/styles/app.css) — `.link-ai-jump-latest` rule for the pill.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (suggestions input-schema doc — covered inline; no new route). No schema change, no migration.

### 2026-05-15 — LinkAI: commit proposed post plans only when the admin opens them
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
- [web/src/components/LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx) — ToolCard takes an `onCommitDraft` prop; tracks per-card `committedId` / `committing` / `commitError`; headline flips between "Drafted a post plan — open to add" and "Added to the calendar".
- [web/src/App.jsx](web/src/App.jsx) — wires the `onCommitDraft` handler that calls `commitAiDraftPlan` and seeds App-level state via `upsertPostPlan` so the calendar reflects the new row immediately.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (tool-side behaviour of `create_post_plan_draft` — documented in this entry's body; full §10 sweep deferred).

### 2026-05-15 — Reset window scroll on forward SPA navigation
Tiny but visible UX bug: opening a post plan from the calendar landed the user mid-page (typically near the Copy card) instead of at the top. Root cause was React Router doing client-side route changes — the browser preserves the previous page's scroll-y on those, so the y-pixel position from the calendar carried straight into the detail view. With both pages having similar vertical extent, this consistently put the user near the middle of the new page.

**Fix:** one `useEffect` in [App.jsx](web/src/App.jsx) keyed on `location.pathname`, calling `window.scrollTo(0, 0)` on every PUSH / REPLACE navigation. Gated on `useNavigationType() !== 'POP'` so back/forward browser navigation still restores the previous scroll position — the browser's default `history.scrollRestoration: 'auto'` handles that case correctly and we don't want to override it ("take me back to where I was in the calendar" should still work).

Applies globally to every route in the SPA, not just post-plan opens. No per-route override needed — every forward nav resets to top, every back/forward restores.

- **Sections touched:** Recent changes log; `Last updated`. No data model, route, or integration changes.

### 2026-05-15 — Shorter post-plan headlines (concept field)
Tightens both auto-generation paths for the post plan `concept` field so calendar chips and detail-view headlines fit in **5-10 words**, not the 15-20 word sentences we were seeing. Two surgical changes:
- **LinkAI path** (`create_post_plan_draft` tool in `web/api/ai/chat.ts`): the zod field description was *"Short (1-2 sentence) concept for the post — what it's about, what angle"*, which led the model to write full descriptive sentences. Rewritten to demand a *"Very short HEADLINE… TARGET 5-10 words, single phrase, NOT a full sentence"* with concrete GOOD examples (*'Spring drop teaser'*, *'Customer story: Maya'*, *'Holi limited-edition launch'*, etc.) and one BAD example (the kind of full-sentence concept we don't want). Hard cap added: `.min(3).max(80)` — if the model overshoots, zod fails the tool call and the SDK's existing `experimental_repairToolCall` flow re-prompts with the validation error attached.
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

### 2026-05-14 — LinkAI web search + daily trend snapshots (PR 3 of N)
Third PR in the LinkAI upgrade series. Closes the "model doesn't know what's trending right now" gap with a hybrid: a cheap daily-refreshed cache (always-on, proactive) plus an on-demand web-search tool (responsive). Layered on top of PR 2's skills work.

- **Migration `0044_brand_trend_snapshots`** — new append-only table `brand_trend_snapshots` (id, account_id FK, fetched_at, query, source_url, title, summary, published_at, raw_payload jsonb, source, scrape_status, error_message). One row per (brand × query × URL × day). Indexes on `(account_id, fetched_at desc)` and `(account_id, source_url)`. RLS mirrors `post_engagement_snapshots`: agency staff + brand members SELECT; service-role-only writes. Added to `supabase_realtime`.
- **New `/api/trends/refresh-cron`** — Vercel Cron, daily at `30 0 * * *` (06:00 IST). For each brand in `AI_COPILOT_BRAND_IDS`, fires 2 Firecrawl `/search` queries:
  1. Industry trends — `"${industry} trends ${year}"`
  2. Hashtag pulse — first 3 tracked hashtags joined with the industry
  Top 5 results per query, deduped by URL across queries, written into `brand_trend_snapshots`. Failed calls write a single error row so the brand-context loader can decide whether to surface stale data. ~2 Firecrawl credits per brand per day, scoped to allowlisted brands only.
- **Brand-context compiler grows `## Industry signals (recent trend articles)`** — pulled by `loadAndCompileBrandContext({ includeCalendar: true })` (chat route only). Latest snapshots per brand, max 7 days old, deduped by URL, capped at 8 entries. Each entry: age tag ("today" / "yesterday" / "N days ago"), title, summary, source URL. ~1-2K cached tokens when present. Empty section drops out cleanly when no data.
- **New `web_search(query)` tool on `/api/ai/chat`** — Firecrawl `/search`, top 5 results returned as `{ query, result_count, results: [{ url, title, summary, published_at? }] }`. Costs ~1 Firecrawl credit per call. The system prompt instructs the model to lean on the cached `## Industry signals` first and only fire `web_search` for information not already there (specific recent events, competitor announcements, niche topics, fresh data for "today" / "this week" framings).
- **System prompt updates** — proactive-opening rule now names `## Industry signals` as one of the things to lead with. New "Use Industry signals before searching" rule prevents speculative web_search calls.
- **LinkAIPanel polish** — ToolCard + LinkAIStatus learn `web_search` headlines:
  - Running: `Searching the web for "sustainable fashion India trends"…` (or `Searching the web…` if no query yet)
  - Done: `Read 5 results from the web` / `Searched the web`
- **vercel.json** — new function entry `api/trends/refresh-cron.ts` (maxDuration 60), new cron schedule `30 0 * * *` for `/api/trends/refresh-cron`.
- **Operator action required after deploy**:
  1. Apply migration `0044_brand_trend_snapshots.sql` via Supabase dashboard or CLI before the cron lands its first batch.
  2. Verify `FIRECRAWL_API_KEY` is set in Vercel project env across all 3 environments (already set per prior PRs — `find-competitors.ts` uses it too).
- **Sections touched**: Recent changes log; `Last updated`. §6 Data model (new `brand_trend_snapshots` table — will sweep in a follow-up doc pass). §10 Edge functions (new cron route + new chat tool — covered in this entry's body for now).

### 2026-05-14 — LinkAI marketing skills (PR 2 of N)
Second PR in the LinkAI upgrade series. Gives the model deep marketing playbooks it can pull on demand, instead of relying purely on its general training. Layered on top of PR 1's calendar/context work.

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
- **LinkAIPanel ToolCard polish**: friendly headlines for the two new tools — "Consulting the launch-strategy playbook…" → "Loaded the launch-strategy playbook" on load_skill, and `"Pulling "ideas-by-category" from the marketing-ideas playbook…"` shape on load_skill_reference. Skill slug → human title mapping baked into `LinkAIPanel.jsx`. Without this, the tiles would say "Running load_skill…" / "Ran load_skill" which is low-signal.
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

### 2026-05-14 — LinkAI calendar awareness: confidence flip + context expansion (PR 1 of N)
Fixes the longstanding "the LinkAI asks me 4 questions before it'll draft anything" complaint. Two-layer change to `/api/ai/chat`'s system prompt and the shared `brandContext.js` compiler.

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

**2. Top-level view** — new [BrandNotesView.jsx](web/src/components/BrandNotesView.jsx) mounts the existing BrandNotesSection in a dedicated page. Route: `/c/:slug/notes`. Page chrome: title "Brand notes", sub copy explaining the AI-LinkAI connection. Old `<BrandNotesSection/>` in BrandKitView is removed (line replaced with a placeholder comment pointing to the new view).

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

This was deferred during Track A (the LinkAI v2 migration) — it was intentional to ship the v2 plumbing first without mixing in prompt-quality changes. Now's the moment.

- **Sections touched:** Recent changes log; `Last updated`; §10 Edge functions / API routes (`/api/ai/chat` SYSTEM_PROMPT documented).

### 2026-05-12 — LinkAI Phase 3: dynamic suggestion chips + Refresh ([PR #74](https://github.com/CodeFire98/lr-studio-dashboard/pull/74))
First post-Track-A net-new improvement to the LinkAI. Replaced [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx)'s hardcoded `EMPTY_SUGGESTIONS` array (three generic prompt-starters that have shipped since the first LinkAI PR) with **AI-generated brand-aware suggestion chips** + a **Refresh button** so the admin can get different angles when the current set isn't relevant.

**New server route**: [/api/ai/suggestions](web/api/ai/suggestions.ts). One-shot `generateObject` call with a Zod schema (`{ suggestions: z.array(z.string().min(8).max(150)).length(4) }`), temperature 0.9 for variety between calls. Reuses the cached brand-context blob (same cache pool as chat / copy / image — one 5-min TTL). Anthropic cost: ~$0.005-0.010 first call (cache miss), ~$0.001-0.003 cached. Refresh-heavy admin (10 clicks in a session) ≈ $0.01-0.03 total. Logs `[suggestions] usage account=… cache_read=…` for observability.

**Client wiring**: [db.js](web/src/lib/db.js)'s `loadCopilotSuggestions({ accountId })` now tries the AI route first, falls back to the **templated logic** (still in db.js) if the call errors. Templated fallback uses recent approved plans + brand-kit categories + date-aware brainstorm starter to build chips deterministically — preserves brand-awareness even when the AI route is unreachable.

**Refresh affordance**: LinkAIPanel's welcome screen has a small "Refresh" pill above the chips. Clicking calls a fresh /api/ai/suggestions; spinner replaces the icon during the round-trip; suggestions fade slightly (`is-loading` class) until the new set lands. A `suggestionsTokenRef` cancels stale fetches if the admin double-clicks Refresh or switches brands mid-flight.

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

### 2026-05-12 — LinkAI v2 Phase 2c: AIImagePromptPanel rewrite around useObject + useCompletion ([PR #72](https://github.com/CodeFire98/lr-studio-dashboard/pull/72))
Client-side cutover for the two-step image-direction → image-prompt flow. Rewrote [AIImagePromptPanel.jsx](web/src/components/AIImagePromptPanel.jsx) around `experimental_useObject` (ideas mode, with a Zod schema mirrored from the server) + `useCompletion({ streamProtocol: 'text' })` (prompt mode). The v1's `parseSse` async generator, lenient `parseIdeasJson` (which stripped ```json fences and JSON.parsed on done), 7-phase explicit state machine (`'idle' → 'ideas_compose' → 'ideas_streaming' → 'ideas_picking' → 'prompt_compose' → 'prompt_streaming' → 'prompt_done'`), manual AbortController, and separate usage state all gone. Now: a `section` enum (`'idle' | 'ideas' | 'prompt'`) + sub-phase derived from each hook's `isLoading` / `error` / `object` / `completion`.

**Wire protocol switch**: [/api/ai/image](web/api/ai/image.ts) switched both modes from manual SSE event writers (`writeSseEvent('text', { delta })` / `writeSseEvent('usage', {...})` / etc.) to native `result.pipeTextStreamToResponse(res)`. The streamObject text-stream emits raw JSON-as-text deltas; `useObject` parses them progressively via `parsePartialJson` into `DeepPartial<IDEAS_SCHEMA>`. The streamText text-stream emits text deltas; useCompletion accumulates them. Both replace the legacy SSE events (`text` / `usage` / `done` / `error`) — last route on the v1 wire protocol is retired with this PR.

**Body shape change** (prompt mode only): `details` → `prompt`. Because `useCompletion` always sends the admin's free-form direction as `prompt` (the first arg to `complete()`), the server reads from `body.prompt` instead of `body.details`. Ideas mode body shape unchanged — `useObject.submit(input)` posts the input verbatim as JSON.

**Progressive idea cards**: the v1 model was "wait for full JSON, then parse, then render 3-5 cards at once". Phase 2c renders cards LIVE as the JSON streams in — each card fills in title → description → keywords as the partial JSON resolves. Cards are click-gated until they have BOTH title + description AND `ideasHook.isLoading` is false. This is the actual point of `useObject` (vs `useCompletion` for arbitrary JSON), so we lean into it.

**Inline usage meter dropped**: same tradeoff as Phase 2b's AICopyPreview — `useObject` / `useCompletion` don't surface usage to consumers. Cache observability moves to server logs — `streamObject({ onFinish })` + `streamText({ onFinish })` both log `[image] usage account=… plan=… platform=… mode=ideas|prompt input=… cache_read=… cache_write=… output=… finish=…` to Vercel Function Logs. Same monitoring path as `[copy] usage …` and `[chat]` (chat keeps its inline meter since `useChat`'s UIMessage protocol DOES surface usage via message metadata).

**Auth wiring**: per-request Supabase session token injected via a shared `fetchWithAuth` wrapper passed to both hooks — mirrors AICopyPreview (Phase 2b) and DefaultChatTransport.headers() (Phase 2a) patterns.

**Single endpoint preserved**: `/api/ai/image` keeps serving both modes from one route. They share auth (`is_agency` + allowlist), brand-context load, plan-load, and platform validation. Splitting into `/api/ai/image/ideas` and `/api/ai/image/prompt` would duplicate ~150 LoC of that pipeline for negligible benefit.

- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entries: text-stream-protocol-on-both-modes-of-image-route, progressive-idea-card-rendering-with-useObject, single-endpoint-for-both-image-modes). §10 Edge functions (`/api/ai/image` wire-protocol cutover; body shape change on prompt mode).

### 2026-05-12 — LinkAI v2 cleanup: move system messages into streamText `system` param ([PR #71](https://github.com/CodeFire98/lr-studio-dashboard/pull/71))
Small standalone refactor across all three AI routes (`chat.ts`, `copy.ts`, `image.ts`). The AI SDK emits a security warning when role:'system' entries appear in `messages` arrays — that's in principle a prompt-injection risk vector. Our usage was safe (system content is 100% server-controlled — fixed SYSTEM_PROMPT constants + the brand-context blob), but the warning had been firing across all three routes since Phase 1a/1b/1c. Fix: move the two cached system blocks from `messages: [...]` into the dedicated `system: [...]` parameter. The AI SDK accepts `Array<SystemModelMessage>` for `system`, and each entry keeps `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` — so both cache breakpoints stay intact. No behavior change.

### 2026-05-12 — LinkAI v2 Phase 2b: AICopyPreview rewrite around useCompletion ([PR #70](https://github.com/CodeFire98/lr-studio-dashboard/pull/70))
Client-side cutover for the inline AI draft / AI redraft surface. Rewrote [AICopyPreview.jsx](web/src/components/AICopyPreview.jsx) around the `useCompletion` hook from `@ai-sdk/react` — manual `parseSse` async generator, the explicit `compose` | `streaming` | `done` | `error` state machine, the separate AbortController, and the SSE `usage`-event extractor all gone. The wire protocol on [/api/ai/copy](web/api/ai/copy.ts) switched to the AI SDK's text-stream protocol via `result.pipeTextStreamToResponse(res)` — the legacy SSE event names (`text` / `usage` / `done` / `error`) are retired for this route.

**Body shape change**: `useCompletion` always posts `{ prompt, ...body }`, where `prompt` is the first arg to `complete()`. The admin's free-form instruction now rides as `prompt` instead of the v1 `instruction` field. Everything else (`accountId`, `plan_id`, `platform`, `mode`, `current_copy`) flows through the per-call `body` override.

**Inline usage meter dropped**: useCompletion's text-stream protocol doesn't surface usage to consumers, and adding a side-channel (custom fetch + response header trick) just for an inline debug indicator wasn't worth the complexity. Cache observability shifts to server logs — `streamText({ onFinish })` logs `[copy] usage account=… cache_read=… cache_write=… output=…` on every completion. Greppable in Vercel Function Logs. The breakage checklist in [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md) is updated with the new monitoring path.

**Auth wiring**: per-request Supabase session token injected via a custom `fetch` wrapper passed to `useCompletion` — mirrors the `DefaultChatTransport.headers()` async pattern from Phase 2a. No new env vars.

**Behavior preserved**: autofocus on instruction textarea, ⌘↩ to generate from the textarea, Stop mid-stream keeps partial text and lets the admin "Use this", Regenerate re-fires with the current instruction, mode=improve still passes the in-flight draft as `current_copy`.
- **Sections touched:** Recent changes log; `Last updated`; §13 Known decisions (entries: useCompletion-text-protocol-over-data-protocol-for-single-shot-completions, drop-inline-usage-meter-in-favor-of-server-log-observability). §10 Edge functions (`/api/ai/copy` wire-protocol cutover from custom-SSE to text-stream).

### 2026-05-12 — LinkAI v2 Phase 2a: LinkAIPanel rewrite around useChat + AI Elements ([PR pending])
Client-side cutover for the chat surface. Rewrote [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx) around the `useChat` hook from `@ai-sdk/react` — manual `parseSse` async generator, manual messages state, manual abort controller, and the custom SSE event dispatcher all gone. The wire protocol on [/api/ai/chat](web/api/ai/chat.ts) switched to the AI SDK's native UIMessage data-stream protocol via `pipeUIMessageStreamToResponse` — the legacy custom SSE event names (`text` / `tool_call` / `tool_result` / `usage` / `done` / `error`) are retired for this route. The server's `messageMetadata` callback attaches per-message usage to UIMessage metadata; the client reads `message.metadata.usage` to power the token meter.

Assistant prose now uses **AI Elements `MessageResponse`** (Streamdown-backed) — proper Markdown: headers, lists, code blocks (with syntax highlighting), tables, etc. Replaces v1's tiny inline `renderProse` / `inlineMd` parser (which only handled `**bold**` and `` `code` ``). User bubbles keep the coral-on-white v1 styling via `.link-ai-bubble` — explicitly NOT routed through AI Elements' Message component because shadcn's neutral `--secondary` token would gray out the bubble. Tool cards keep v1's compact visual (concept + platform pills + "Open plan →" CTA) but now read from the UIMessage `parts` model — each tool call is a `tool-{name}` part with state cycling through `input-streaming` → `input-available` → `output-available` | `output-error`.

**Bundle health**: AI Elements pulls in Streamdown + shiki language packs + mermaid (~1.7 MB total). The panel is **code-split via `React.lazy()`** in [App.jsx](web/src/App.jsx) so the eager bundle stays at the v1 baseline (735 KB main JS, gzip 202 KB — unchanged from pre-Phase-2a). The heavy AI Elements dependency tree only downloads when admin clicks the LinkAI trigger.

**Path alias foundation**: `@/*` path alias added to [tsconfig.json](web/tsconfig.json) (TypeScript) + [vite.config.js](web/vite.config.js) (Vite resolver) so the standard shadcn-style imports (`@/components/ai-elements/*`, `@/lib/utils`) resolve. Phase 0's `components.json` was originally configured with raw `src/` prefixes; corrected to `@/` here so future `npx ai-elements add` calls produce standard imports.

**localStorage**: keyed under `lr_copilot_conv_v2_<userId>_<accountId>` (v2 prefix). v1 entries become orphaned — the v1 message shape (`{role, content, parts[]}` with custom tool-call objects) is incompatible with the new UIMessage shape (`{id, role, parts}` with SDK part discriminators). Admin starts fresh on first open after deploy; by design per AI_COPILOT_V2_MIGRATION.md's localStorage migration plan.
- **Sections touched:** Recent changes log; `Last updated`; §4 Tech stack (path alias note); §5 Repo layout (new `web/src/components/ai-elements/` directory); §13 Known decisions (entries: lazy-load-LinkAI-to-protect-eager-bundle, wire-protocol-cutover-server+client-atomic, hybrid-rendering-user-bubble-coral-+-assistant-Streamdown, drop-AI-Elements-Conversation-conflicts-with-existing-scroll-overflow).

> Entries dated **2026-04-29 → 2026-05-11** are archived in [REFERENCE_CHANGELOG_ARCHIVE.md](REFERENCE_CHANGELOG_ARCHIVE.md) — lift back here when something becomes load-bearing for current work.

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
| **LinkAI** | Agency-side AI assistant powered by Claude. Two surfaces planned: a sidebar chat panel for high-level work (plan a week, build a campaign, brainstorm), and inline "✨ AI" buttons on `PostPlanDetailView` / `ConvertIdeaModal` / `CalendarView` for narrow operations (draft caption, suggest concept, improve copy). Scoped per-brand (uses BrandPicker's active brand). Proposes-first model: AI output lands as a `post_plans` row with `ai_generated=true`, admin edits in the existing detail view, then submits for review through the standard workflow. | Backend: Vercel API route `web/api/ai/chat.ts` (PR 2). Frontend: sidebar LinkAI panel + inline buttons. Gated by `AI_COPILOT_BRAND_IDS` env var allowlist during rollout. |
| **Brand context (compiled)** | The cached system-prompt blob sent to Claude on every LinkAI call. Assembled from `brand_kits` + `brand_kit_notes` + recent approved `post_plans` (style refs) into a structured markdown string. When `includeCalendar: true` (chat only — opt-in), also pulls upcoming `post_plans`, recent `post_plan_publications`, and latest `post_engagement_snapshots` to add five "right-now" sections: `## Today` (date / day / week / timezone / next-30-day moments from `marketingMoments.js`), `## Upcoming calendar` (next-7-day-detail + 8-30-day-compact), `## Cadence (last 30 days)` with ⚠ GAP markers, `## Top performers` (ranked by engagement), `## Voice anchors` (top-performer opening lines). The static brand-kit / voice / strategy / notes sections stay byte-stable for the 5-min prompt-cache TTL; the `## Today` and calendar sections invalidate when a new draft is created mid-conversation or when the date rolls over at midnight brand-local, which is the desired behaviour (model needs to see fresh state). | [brandContext.js](web/src/lib/brandContext.js); `compileBrandContext({...})` pure function + `loadAndCompileBrandContext(client, accountId, options?)` async wrapper. Marketing moments live in [marketingMoments.js](web/src/lib/marketingMoments.js). |
| **Brand locale** | Per-brand `{ country, timezone }` used by the `## Today` block and as the default for new post-plan timestamps. Resolved via `getBrandLocale(brandKit, account)` — looks at `brandKit.primary_market` / `brandKit.country` / `account.country` then `brandKit.timezone` / `account.timezone`, defaulting to `IN` and `Asia/Kolkata` (matches L+R Studio's actual market). Wired this way so adding a column on either table later is a no-op. | `getBrandLocale` in [brandContext.js](web/src/lib/brandContext.js) |
| **Marketing moments** | Curated list of holidays, festivals, and culturally-relevant observances surfaced into the `## Today` block of the brand-context blob. Powers the LinkAI's proactive suggestion behaviour ("Diwali is in 12 days — want a series?"). Hand-dated for 2026-2027; `date-holidays` (npm) was tried first but only ships 6 public IN holidays — no Diwali / Holi / Eid / Rakshabandhan. **Refresh annually** when 2027 is half-elapsed. | [marketingMoments.js](web/src/lib/marketingMoments.js); `getUpcomingMoments({ from, days, country })` |
| **brand_kit_notes** | Free-form admin annotations on a brand — "remember that the founder hates the word 'authentic'", "no holiday content until Oct 15", "always tag @cofounder on milestone posts". The "memory" layer for the LinkAI. Written by hand from the BrandKitView's `BrandNotesSection` AND by the LinkAI via the `write_brand_note` tool (PR 6). `is_pinned=true` rows are always-true facts that ride along on every AI call; non-pinned rows are recent context that decays out of the window once we hit the ~20-most-recent cap. | `brand_kit_notes` table (migration 0039); written via `BrandNotesSection` UI or the `write_brand_note` chat tool |
| **`write_brand_note` tool** | Anthropic tool exposed to the chat LinkAI via `/api/ai/chat`. Triggered when the admin tells the chat to remember something. Inserts a row into `brand_kit_notes` via service-role with `created_by = user.id`; supports `is_pinned` for always-true facts. | `web/api/ai/chat.ts` (tool definition + runToolCall handler) |
| **Pinned note** | A `brand_kit_notes` row with `is_pinned=true`. Always included in the brand-context blob the LinkAI sees, regardless of recency. Used for facts that are "always true" — founder name, voice constraints, perma-instructions. Toggleable from the `BrandNotesSection` UI (Pin / Unpin action). | `brand_kit_notes.is_pinned` |
| **AI image direction** | One of 3-5 image-concept cards the LinkAI proposes via `/api/ai/image` `mode=ideas`. Each direction is a different visual ANGLE (studio shot vs. lifestyle vs. detail crop vs. behind-the-scenes etc.) with title + 1-2 sentence description + 3-6 style keywords. The admin picks one direction, then the LinkAI expands it into a paste-ready image-gen prompt via `mode=prompt`. | [AIImagePromptPanel.jsx](web/src/components/AIImagePromptPanel.jsx); `/api/ai/image` `mode=ideas` |
| **AI draft** | A `post_plans` row created by the LinkAI rather than a human. Marked with `ai_generated=true`; the original tool-call args are stored in `ai_draft_payload` (jsonb) so we can diff "AI proposed" vs "admin shipped" later. Renders with a small "✨ AI draft" pill in `PostPlanDetailView` (PR 2+). The admin owns the row — edits it in the existing detail view, submits for review through the standard workflow. | `post_plans.ai_generated`, `post_plans.ai_draft_payload` (migration 0038) |

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

- **Frontend**: React 18 + Vite, hand-written CSS in `web/src/styles/app.css` (~2500 lines, authoritative for all current UI). **Scoped Tailwind v3.4** added in LinkAI v2 Phase 0 ([PR #61](https://github.com/CodeFire98/lr-studio-dashboard/pull/61)) — content glob restricted to `web/src/components/ai-elements/**` only, `preflight: false` so the existing CSS reset stays authoritative, design tokens scoped under `.ai-elements` class (NOT `:root`). Tailwind only applies inside AI Elements components from Phase 2 onward; the rest of the app remains pure hand-written CSS.
- **AI / LLM**: Vercel **AI SDK v6** (`ai` + `@ai-sdk/anthropic@^3` + `@ai-sdk/react@^3`) + `zod@^4` for tool/output schemas. LinkAI v2 migration in progress — see [AI_COPILOT_V2_MIGRATION.md](AI_COPILOT_V2_MIGRATION.md). Phase 1 server routes (`/api/ai/chat`, `/api/ai/copy`) use `streamText` + `tool({ inputSchema (Zod), execute })`; Phase 2 client uses `useChat` / `useCompletion` / `useObject` hooks. `@anthropic-ai/sdk@^0.95` still in deps as a transitional dep (only used by the `/api/ai/image` route until Phase 1c lands). **AI Elements** component library (shadcn-style copy-paste from `https://elements.ai-sdk.dev/`) lands in Phase 2 for chat surfaces (Conversation / Message / PromptInput / Tool / Reasoning / Persona).
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
| `brand_kits` | Brand's design + voice profile | one per account; ~60 columns including `palette`, `fonts`, `tagline`, `mission`, `voice_tags`, `logos`, `enrichment_status`, `enriched_at`. **Brand System v1 (2026-05-24)** adds two JSONB columns: `claim_guardrails` (structured never-use / always-pair / approved-qualifier rules) and `channel_voice` (per-channel voice prescription with `global` + IG/LinkedIn/X/WhatsApp sub-objects). Both default `{}`; consumed by `brandContext.js` and injected into every AI-context blob. (Migration 0063 briefly added a `product_reference_images` column for a persisted product-image library; **reverted in 0064** — image-prompting reference images are now ephemeral/per-generation, never stored. See §10 `/api/ai/image`.) | Members + agency | Members + agency |
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

### LinkAI tables (added 2026-05-11)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `brand_kit_notes` | Free-form admin annotations powering the LinkAI's "memory" — facts that don't fit `brand_kits`' structured columns. Composed into the brand-context blob on every AI call. | `account_id` (FK → accounts), `body` (text), `is_pinned` (boolean), `created_by` (FK → profiles ON DELETE SET NULL), `created_at`, `updated_at` | **Agency staff only** (tightened 2026-05-12, migration 0040 — was agency OR members) | Same — agency-only |

`post_plans` also gains two AI-related columns in migration 0038:

- **`ai_generated boolean default false`** — `true` for plans created by the LinkAI. Drives the "✨ AI draft" pill (PR 2+) and lets us segment telemetry.
- **`ai_draft_payload jsonb default '{}'::jsonb`** — original LinkAI tool-call arguments. Stored for diff'ing "what AI proposed" vs "what the admin shipped" and for a future "reset to AI draft" affordance.

A partial index `post_plans_ai_generated_idx ON (account_id, created_at desc) WHERE ai_generated = true` supports the eventual "show me AI drafts I haven't reviewed" query — stays small because the vast majority of rows are human-created.

`brand_kit_notes` is in `supabase_realtime` so the LinkAI panel and BrandKit UI stay in sync across tabs when notes are added/edited.

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

### Slack notify audit log (added 2026-05-25)

| Table | Purpose | Key columns | Who can SELECT | Who can write |
|---|---|---|---|---|
| `slack_notify_log` | Dedupe + delivery audit for the brand → `#lrmedia-inbox` Slack relay. PK on `message_id` is the dedupe primitive — the AFTER INSERT trigger `notify_slack_on_brand_message` `INSERT … ON CONFLICT DO NOTHING`s here and only fires the HTTP call when it actually claimed the row. | `message_id` (PK, FK conversation_messages ON DELETE CASCADE), `dispatched_at` (set by the DB trigger), `delivered_at` (set by the Vercel route after Slack POSTs 2xx), `slack_status` (HTTP status), `slack_error` (error string, ≤500 chars). One index: `(dispatched_at desc)`. | Agency staff (`is_agency_user()`) | **Service role only** — no client INSERT/UPDATE/DELETE policies. Writes happen via the trigger (INSERT) and `/api/slack/brand-message-notify` (UPDATE). |

A row with `dispatched_at IS NOT NULL` but `delivered_at IS NULL` means "trigger fired but Vercel never ACK'd" — grep signal when Slack goes quiet. Raw HTTP responses also land in `net._http_response` from pg_net for low-level diagnosis.

### Storage buckets

| Bucket | Contents | Public? | Access policy |
|---|---|---|---|
| `assets` | Task deliverables, WIPs, references | Private (signed URLs) | Members of the task's account |
| `brand-assets` | Brand kit references (mood, packaging, etc.) | Public read | Members for write |
| `brand-logos` | Brand logo + variants | Public read | Members for write |
| `post-plan-attachments` | Post plan references + final deliverables | Public read | Members of the account; RLS keyed off path scheme `<accountId>/<postPlanId>/<ts>_<filename>` via `post_plan_attachment_account_id(name)` SQL helper |
| `brand-invoices` | Billing v1 invoice PDFs | Private (signed URLs) | Read: agency or account members; write/delete: agency only. Path `<accountId>/<paymentId>/<filename>` via `brand_invoice_account_id(name)` helper (migration 0062) |

> **Note:** an empty `brand-product-images` bucket exists in storage from the reverted migration 0063 (image-prompting reference images are now ephemeral — see §10 `/api/ai/image`). Migration 0064 dropped its RLS policies + the DB column but Postgres blocks bucket deletion from SQL; the empty, policy-less bucket can be removed via the Storage API/dashboard.

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

#### Convention going forward: explicit GRANTs on new public-schema tables

Per the Supabase 2026-05-26 announcement, the platform's `public`-schema default flips on **2026-10-30** for existing projects (which we are): new tables created from that date will NOT be exposed to the Data API by default. They'll exist in Postgres and migrations will still apply, but `supabase.from('foo')...` from the client will fail until an explicit GRANT is added. Existing tables (0001–0061) are **grandfathered** and unaffected — production is safe forever for everything currently in this list.

To stay aligned with the new convention starting now (so we don't have to remember the cutoff later), every new public-schema table migration should include the GRANT alongside the RLS-enable + policies:

```sql
CREATE TABLE public.foo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ...
);

ALTER TABLE public.foo ENABLE ROW LEVEL SECURITY;

-- Expose to the Data API. Without this line, client-side queries via
-- supabase.from('foo') will fail with a PostgREST "relation does not
-- exist" error on tables created after 2026-10-30. Roles:
--   - authenticated = logged-in users (most reads/writes)
--   - anon          = unauthenticated anon-key path (only if a route
--                     genuinely needs unauth access, e.g. public reads)
--   - service_role  = service-role client (always allowed; no grant
--                     needed — but harmless to include for clarity)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.foo TO authenticated;

-- Then add RLS policies as usual.
CREATE POLICY foo_select ON public.foo FOR SELECT USING (...);
-- etc.
```

Service-role-only tables (writes only via Edge Functions or `/api/*` routes using `SUPABASE_SERVICE_ROLE_KEY`) can omit the `authenticated` / `anon` grants. Most engagement / telemetry / audit tables fall in this bucket — see `service_usage_log` (0053), `daily_digest_log` (0038), `slack_notify_log` (0061) for the pattern.

Reviewable from the dashboard via Database → **Security Advisor**, which flags any table currently exposed to the Data API. Worth running once before 2026-10-30 to confirm nothing existing is leaked.

Most recent: `0064_drop_brand_kit_product_images.sql`.

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
- `0039_ai_copilot_scaffolding` — new `brand_kit_notes` table (free-form admin annotations powering the LinkAI's "memory" layer, RLS mirrors `post_plan_ideas`) + new `post_plans.ai_generated` and `post_plans.ai_draft_payload` columns marking AI-proposed plans. Partial index on the AI-generated subset. Purely additive — nothing in the SPA reads these yet. See §13 entries on compiler-as-pure-function and notes-as-table-not-jsonb.
- `0040_brand_kit_notes_agency_only_rls` — tightens `brand_kit_notes` RLS from "agency staff OR account members" to **agency staff only** on SELECT/INSERT/UPDATE/DELETE. Notes are an agency-internal memory surface; brand users should never see the raw memory dump. Frontend in the same PR adds defense-in-depth (BrandNotesSection returns null for non-agency callers, sidebar entry hidden for brand users) but RLS is the real enforcement. **User runs via Supabase dashboard before the frontend PR lands.**
- `0041_post_engagement` — two new tables (`post_engagement_snapshots`, `post_embed_cache`) attached to `post_plan_publications` for the Live Posts engagement + embeds feature. Snapshots is append-only (powers monthly reports); embed cache is 1:1 with publications. Read RLS = agency OR account-members-of-the-parent-plan; **no client INSERT/UPDATE/DELETE policies** — writes are service-role only via `/api/engagement/refresh`. Both tables added to `supabase_realtime`. See §13 entry on snapshots-vs-columns and the engagement-scraping decision log.
- `0042_conversations` — Conversations PR 1: four new tables (`conversations` + `conversation_messages` + `message_attachments` + `conversation_views`) backing the unified per-brand chat. RLS: agency OR account-members read; self-author write on messages; agency-or-uploader on attachments; own-rows on views. Realtime: first three tables in `supabase_realtime`. Backfill: one `conversations` row per existing brand account, every `post_plan_comments` row copied into `conversation_messages` with the plan auto-tagged. Trigger: `accounts_ensure_brand_conversation` provisions a conversation on every new `accounts` INSERT with `type='brand'`. **The legacy `post_plan_comments` table is intentionally not dropped** — kept as a rollback escape hatch for one bake cycle, then deleted in a follow-up. See §13 entry on `conversation_messages`-vs-`messages` naming.
- `0043_conversation_messages_tagged_plan_decouple` — drops the FK on `conversation_messages.tagged_post_plan_id`. The column stays as a UUID but no longer cascades-set-null when a plan is deleted, so deleted-plan messages keep their orphaned id → the bubble can detect "tagged a plan that no longer exists" and render a "Plan deleted" tombstone chip. Tiny migration — single `drop constraint if exists`.
- `0044_brand_trend_snapshots` — adds the `brand_trend_snapshots` table for the LinkAI daily trend cache. Append-only, RLS mirrors `post_engagement_snapshots`. Service-role-only writes via `/api/trends/refresh-cron`.
- `0045_engagement_refresh_cron` — moves the engagement-refresh cron from Vercel to Supabase pg_cron. **Installs the `pg_cron` and `pg_net` extensions**, creates the `cron_run_log` observability table (agency-readable, service-role writes), seeds two **Vault** secrets the cron statement reads at fire time (`engagement_cron_secret` + `engagement_project_url` — both start as `REPLACE_ME` placeholders; operator overwrites via Dashboard → Vault), and registers cron job `engagement-refresh-daily` on schedule `30 0 * * *` UTC (= 6:00 AM IST) which calls `<project_url>/functions/v1/engagement-refresh` with the bearer secret. Re-cadencing is a SQL-only change: `cron.unschedule('engagement-refresh-daily')` + `cron.schedule(...)` with the new expr. To verify after applying, see the migration's footer comment block.
- `0046_post_plan_attachment_caption` — adds `caption text` column on `post_plan_attachments` (user-editable label distinct from `filename`). Also closes a gap from migration 0021: adds the missing UPDATE RLS policy on `post_plan_attachments` (previously SELECT/INSERT/DELETE only — caption saves were silently failing with PostgREST coercion errors until this).
- `0047_brand_proposals_foundation` — schema-only foundation for the brand-proposals series (PRs 1–6). Adds `'proposed'` as a 4th value on `post_plans.status`; new `plan_proposals` table for edit-proposals on existing plans (`kind in ('new_plan' | 'date_change' | 'copy_change')`, `payload` jsonb, status flow `pending → approved/rejected`); adds `kind` column on `conversation_messages` (`'user'` / `'system'`) — client INSERT RLS tightened to `kind = 'user'` so a malicious client can't impersonate system events; three SECURITY DEFINER triggers emit lifecycle messages via a shared `emit_plan_system_message(account_id, plan_id, actor_id, body)` helper; `plan_proposals` added to `supabase_realtime`.
- `0048_brand_proposals_status_guard` — BEFORE UPDATE trigger on `post_plans.status` that refuses (a) any agency UPDATE setting `status='approved'` (only brand can approve) and (b) any brand UPDATE except `needs_review → approved`. Service-role / SECURITY DEFINER contexts bypass via `if auth.uid() is null then return new;`.
- `0049_brand_proposes_new_plan_message` — AFTER INSERT trigger on `post_plans` that emits "proposed a new post plan." into the brand conversation thread when a row lands with `status='proposed'` on insert. Safety net for direct inserts that bypass the `brand_draft → proposed` path.
- `0050_brand_draft_status` — extends `post_plans.status` to a 5th value `'brand_draft'` (private brand workspace before "Propose plan"); adds `brand_draft → proposed` case to `emit_post_plan_status_message`; tightens `guard_post_plan_status_transitions` to allow brand `brand_draft → proposed` and forbid agency from setting `status='brand_draft'`.
- `0051_ai_usage` — append-only AI quota tracking table (`account_id`, `user_id`, `caller_is_agency`, `kind`, `created_at`) backing the per-brand **50/day AI quota** enforced in `web/api/ai/auth-lib.ts`. Partial index on `(account_id, created_at desc) where caller_is_agency = false` for the hot read path. RLS denies all client access; service role only.
- `0052_brand_kit_notes_open_to_brand` — reverts migration 0040's agency-only tighten. Brand teammates can now SELECT/INSERT/UPDATE/DELETE notes for their own brand. Explicitly chosen by user: brand-side notes visibility is a deliberate openness, not an oversight.
- `0053_service_usage_log` — append-only telemetry table (`service`, `route`, `account_id`, `user_id`, `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms`, `status`, `error`, `meta`) capturing every external call to Anthropic / Firecrawl / Apify. Sits alongside `ai_usage` (which is the lean quota counter). Three b-trees + a partial Anthropic-quota index. Agency-only RLS read; service-role writes. Backs the daily usage-digest email.
- `0054_digests_to_pg_cron` — moves the 18:00 IST brand daily-digest and 07:30 IST agency usage-digest crons off Vercel Hobby cron onto Supabase pg_cron. Adds a `vercel_app_url` Vault secret (operator sets to `https://agency.linkrunner.io` after applying); re-uses the existing `engagement_cron_secret` Vault entry from 0045. Schedules two pg_cron jobs (`daily-digest-brand` at `30 12 * * *` UTC, `usage-digest-agency` at `0 2 * * *` UTC), both wrapping `pg_net.http_post()` with a 90s timeout. Triggered by two confirmed Vercel-cron deploy-churn misses (2026-05-11 and 2026-05-19).
- `0055_emit_post_plan_publication_message` — AFTER INSERT trigger on `post_plan_publications` emitting a "marked as posted on Platform" system message into the brand conversation thread. **30-second dedupe window** so a multi-platform modal submit produces ONE combined message ("marked as posted on Instagram, LinkedIn, X.") instead of N. INSERT-only — UPDATEs / DELETEs deliberately don't log.
- `0056_proposal_withdrawal` — adds `'withdrawn'` as a 3rd terminal status on `plan_proposals` (alongside `'approved'` / `'rejected'`). New RLS UPDATE policy `plan_proposals_update_proposer_withdraw` lets `proposed_by = auth.uid()` flip a pending proposal to withdrawn — and ONLY that transition, ONLY their own row. `emit_plan_proposal_resolved_message()` trigger extended with a `withdrawn` branch.
- `0056b_post_plan_recall_transition` — extends `guard_post_plan_status_transitions` with a brand-side `proposed → brand_draft` transition, so a brand can "recall" a proposed-new-plan they haven't gotten an agency response on yet. Also extends `emit_post_plan_status_message` so the Conversations log shows "recalled the proposed plan." instead of a generic fallback.
- `0057_post_plan_publications_soft_delete` — adds `deleted_at timestamptz` on `post_plan_publications` + a partial index on `(published_at desc) where deleted_at is null`. Engagement scraper + manual-refresh route gate on `deleted_at IS NULL`; aggregator paths (`loadEngagementSummaryForBrand`, `loadEngagementForBrandRange`) opt-in to `includeDeleted: true` so historic brand totals don't drop when a card is removed.
- `0058_post_plans_visibility_by_role` — drops + recreates `post_plans_select` RLS with a role-aware filter: agency sees everything **except** `status='brand_draft'`; brand sees their account's plans **except** `status='drafting'`. Realtime applies the same filter per-event. INSERT/UPDATE/DELETE policies unchanged (the status-transition guard from 0050 already enforces write-side discipline).
- `0059_brand_system_v1` — adds two JSONB columns to `brand_kits` for the new Brand System layer: `claim_guardrails` (structured swap + pair rules + approved qualifiers + off-limits numeric rules) and `channel_voice` (per-channel voice prescription with a `global` brand-wide sub-object + IG/LinkedIn/X/WhatsApp sub-objects). Both default `{}` so existing rows are unaffected. Additive only — no RLS changes (inherits existing `brand_kits` policies). Consumed by new helpers in `brandContext.js`. Tracked in Supabase under name `brand_system_v1`.
- `0060_seed_bamboo_bear_brand_system` — data-only seed populating both new columns for Bamboo Bear from `Bamboo_Bear_Brand_System.md`. Wrapped in a transaction with safety guards: (1) raises if `accounts.slug = 'bamboo-bear'` doesn't exist, (2) raises if Bamboo Bear has no `brand_kits` row, (3) post-seed verification that exactly 1 brand_kit has both columns populated. UPDATEs use `$seed$` dollar-quoted JSON literals + slug-based subselects (no hardcoded IDs). Tracked in Supabase under name `bamboo_bear_brand_system_v1_seed`. **Idempotent** — safe to re-run; both UPDATEs overwrite with the same payload.
- `0061_slack_brand_message_notify` — Brand → Slack relay for `#lrmedia-inbox`. New `slack_notify_log` audit table (PK = `message_id`, used as a dedupe claim before the HTTP fire), a Vault entry `slack_notify_shared_secret`, and an AFTER INSERT trigger on `conversation_messages` whose function `notify_slack_on_brand_message` pre-filters (`kind='user'`, non-deleted, non-empty body, author profile `is_agency=false`), claims the dedupe row via `INSERT … ON CONFLICT DO NOTHING`, then `net.http_post`s `{message_id}` to `web/api/slack/brand-message-notify.ts` with a `Bearer <shared_secret>` header. Every failure path is wrapped — Slack outages never roll back a brand's message.
- `0062_brand_payments` — Billing v1. New `brand_payments` table (one row per payment request) + private Storage bucket `brand-invoices` (path `<accountId>/<paymentId>/<filename>`, helper `brand_invoice_account_id`). RLS: agency full CRUD, brand SELECT-only on own rows; explicit GRANT per the 2026-10-30 convention.
- `0063_brand_kit_product_images` — Image-prompting PR 2 (persisted approach, **later reverted by 0064**). Added `brand_kits.product_reference_images jsonb default '[]'` + private Storage bucket `brand-product-images` + helper `brand_product_image_account_id` + 4 RLS policies. Applied to prod via MCP (tracked name `brand_kit_product_images`).
- `0064_drop_brand_kit_product_images` — Reverts 0063. Image-prompting reference images pivoted from a persisted brand-level library to **ephemeral per-generation** images (attached inline, sent in the request body, never stored). Drops the `product_reference_images` column, the `brand_product_image_account_id` helper, and the 4 storage policies. The empty `brand-product-images` bucket is left in place (Postgres blocks bucket DELETE from SQL via `storage.protect_delete()`); it's policy-less + empty so harmless — remove via Storage API/dashboard if desired. Applied to prod via MCP (tracked name `drop_brand_kit_product_images`).

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
| `lr_copilot_conv_<userId>_<accountId>` | Persisted LinkAI conversation per (user, brand). JSON array of messages, capped at last 60 entries. Survives panel close, page refresh, and brand-switch. | [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx) — read on mount + brand-change, written on every messages update | "Start new" button in panel header clears the entry; sign-out doesn't (history per-brand persists across sign-out/in for the same user-id) |
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

### `/api/ai/chat` (Vercel serverless route — LinkAI)

Agency-side LinkAI chat backend. Streams Claude responses over Server-Sent Events to [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx), runs tool calls server-side, and writes AI-drafted post plans to the DB via service-role. Source: [web/api/ai/chat.ts](web/api/ai/chat.ts).

#### Auth & gating

- **JWT verification**: caller MUST send `Authorization: Bearer <user JWT>`. The handler verifies it via the anon-key Supabase client (`supabase.auth.getUser()`).
- **Agency-only**: handler reads `profiles.is_agency` for the caller via service-role; 403s if false. Brand users are explicitly locked out at the API surface — Brand LinkAI is a later phase.
- **Brand allowlist**: the request's `accountId` MUST be in the `AI_COPILOT_BRAND_IDS` env-var list (comma-separated UUIDs). This is the rollout gate. Expand the list as we widen the test set; today only Bamboo Bear should be on it.

#### Tools

- **`create_post_plan_draft({scheduled_at, platforms, concept, copy_variants})`** *(PR 2)* — inserts a row into `post_plans` with `status='drafting'`, `ai_generated=true`, `ai_draft_payload=<original args>`. Writes via service-role since the agency-staff + brand-allowlist gates above are the real boundary. Returns `{id, scheduled_at, platforms, concept, status}` for the panel to render an "Open plan →" CTA.
- **`write_brand_note({body, is_pinned?})`** *(PR 6)* — inserts a row into `brand_kit_notes` with `created_by = user.id`. Body capped at 1000 chars server-side. Triggered when the admin tells the chat to remember something ("remember that…", "from now on…", "make a note that…"). The note flows into the brand-context blob on every future AI call (chat + inline copy) via the existing `brandContext.js` compiler. Pin always-true facts (founder name, voice constraints, perma-instructions); leave non-pinned for time-bound context (campaign-specific notes that decay out of the 20-most-recent window over time). Returns `{id, body, is_pinned, created_at}` for the tool-card to render.

Future tools: `update_post_plan` (revise an existing plan based on the admin's instruction), `list_recent_post_plans` (read-only context lookup so the model can answer "what's scheduled this week?"), `suggest_calendar_blocks` (proactive gap-filler).

#### Streaming protocol (SSE)

The handler emits these event types over `text/event-stream`. Each event is `event: <type>\ndata: <json>\n\n`. The client uses a manual SSE parser (`parseSse` in [LinkAIPanel.jsx](web/src/components/LinkAIPanel.jsx)) rather than `EventSource`, because EventSource doesn't support POST bodies or auth headers.

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
| `AI_COPILOT_BRAND_IDS` | every call | Comma-separated list of brand UUIDs that get to use the LinkAI. Run `select id, name from accounts where type='brand';` in Supabase to find the UUID for your target brand. Empty = nobody can use it. |
| `VITE_AI_COPILOT_BRAND_IDS` | SPA build | Same value as above. Exposed to the SPA so the topbar "✨ LinkAI" button renders only for whitelisted brands. The server is the real authz; this is just for the conditional render. |
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
2. **System prompt shape**: this route says "output the caption text ONLY — no preamble, no quotes, no explanation." The chat route says "you're a conversational LinkAI." Different shape — Claude's behaviour follows the system prompt closely, so we get cleaner caption output by giving it a clean instruction.
3. **Client simplicity**: the consumer parses ONE event type (`text`) into a single growing string. No tool_call / tool_result cards to render. The `AICopyPreview` component is half the size of `LinkAIPanel`.

Trade-off: two endpoints to maintain instead of one. Acceptable — they share the auth pipeline and `brandContext.js` compiler.

#### Cost

Brand context blob (~4-5k tokens) is sent cached. After the first call, subsequent drafts within 5 minutes hit Anthropic's cache. Per-call cost:

- First-time (cache miss): ~$0.005-0.015
- Cached (within 5 min of any other LinkAI call for the same brand): ~$0.001-0.003

Drafting copy for IG + LinkedIn + X on the same plan = ~$0.01-0.02 total. Agency drafting 30 plans/week ≈ $0.30-0.60/week per brand for inline drafts (in addition to chat-panel costs).

#### Deploying

Same as the other Vercel routes: push to branch → preview deploy auto-builds; merge to main → prod deploys. No new env vars to set — reuses PR 2's allowlist + Anthropic key.

### `/api/ai/image` (Vercel serverless route — image-prompt ideation)

Two-step image-prompt generation for the "AI image prompts" card on PostPlanDetailView ([AIImagePromptPanel.jsx](web/src/components/AIImagePromptPanel.jsx)). The admin gets 3-5 direction ideas first, picks one, then expands it into a detailed paste-ready image-gen prompt.

#### Auth & gating

Identical to `/api/ai/chat` and `/api/ai/copy`: JWT verification → `profiles.is_agency` check → `AI_COPILOT_BRAND_IDS` allowlist on `accountId`. Same env vars — no new secrets.

#### Modes

- **`ideas`**: returns 3-5 direction concepts via `streamObject` with a Zod schema enforcing `{ ideas: [{title, description, style_keywords: []}] }` (min 3, max 5). The Vercel AI SDK constrains Claude to produce schema-conforming JSON AND validates it server-side. Wire shape: text-stream of raw JSON deltas via `pipeTextStreamToResponse`. The client (`useObject({ schema })`) parses progressively via `parsePartialJson` into `DeepPartial<RESULT>` so cards render as fields land. Brand voice + photography style + voice tags + pinned brand notes from the cached brand-context blob inform every direction, and the image-prompting house style (below) steers them toward no-face / product-as-hero framing — kept concept-level (the full house-style detail applies in `prompt` mode).
- **`prompt`**: given the chosen idea (title + description + keywords) + the admin's free-form additional details (riding as `prompt` — see body shape below), returns a single detailed image-gen prompt via `streamText` as text deltas. Follows the **image-prompting house style** (below) as hard rules: opens with the format, follows the prompt-architecture order, names the light, no faces by default, real product proportions, label front-and-centre, closes with the product reference line. Length per the house-style guide (≈150-400 words by shot type). NO Midjourney `--ar` flags or other tool-specific syntax — format is stated in words (admin adds tool flags for their tool of choice).

#### Image-prompting house style (Linkrunner Media)

The route injects a house-style system block on **both** modes via `compileImagePromptGuide({ industry, productCategories })` from [skillRegistry.js](web/src/lib/skillRegistry.js) — same single-shot pattern as `/api/ai/copy`'s `compileCopyGuidance`. It returns:
1. The **universal directives** ([`image-prompting/SKILL.md`](web/src/data/skills/image-prompting/SKILL.md) body) — golden rules, prompt architecture, human-element / lighting / camera vocab, reference-image handling. Fully static → caches across every brand + call.
2. The brand's matching **category-specific notes** (Beverages / Food / Fashion / Skincare / Tech), extracted from [`references/guide.md`](web/src/data/skills/image-prompting/references/guide.md) by `resolveImageCategory()` regex-matching the brand's `brand_kits.industry` + `product_categories`. No match → universal-only.

The guide is also a loadable chat skill (`image-prompting` in `SKILL_MENU`, with the `guide` reference) so LinkAI can pull it when asked to draft / art-direct an image prompt in chat. Single source of truth: the markdown files feed both the route and chat.

**Format from platform**: `PLATFORM_FORMAT` maps instagram → `4:5 vertical`, linkedin / x → `16:9 landscape`, injected as a `Target format:` line in the user message so golden rule #1 ("format first") happens automatically.

**Reference-image-aware — EPHEMERAL per-generation vision (2026-06-01)**: the house-style block tells the model that if reference image(s) are attached it must describe the product's shape / label / colour / proportions from what it SEES (never invent), and otherwise close with the reference-line instruction. Reference images are **per-generation and never persisted** — the admin attaches up to **3** in the AI image-prompt panel for that one prompt-gen, they ride inline in the request body as base64 data URLs (`reference_images: [{ dataUrl, mediaType }]`), and the route passes them to Claude as **AI SDK image parts** (multimodal: image parts first, then text) on **both** modes. `parseReferenceImages` validates each is a well-formed `data:image/<type>;base64,…` URL with an accepted media type (jpeg/png/gif/webp), caps at 3, and drops malformed entries. When images are present an explicit note is appended to the user text ("N reference images attached — they are the ACTUAL product…"). Best-effort: no images / malformed input → text-only, identical to the no-image path. Client side, `ProductRefStrip` in `AIImagePromptPanel.jsx` holds the images in component state, **downscales each to ≤1568px JPEG** (`downscaleToDataUrl`) so 3 images stay well under Vercel's ~4.5MB body limit and match Claude's vision downsampling, and clears them on reset/close. Image count logs as `images=N` + `product_images` in `service_usage_log.meta`. **LinkAI chat** needs no special handling — its composer already attaches images as AI SDK `file` parts (`convertToModelMessages` forwards them), so asking LinkAI for an image prompt with images attached already feeds them to Claude. (An earlier persisted brand-level library — migration 0063, `ProductImagesCard` — was built then reverted in favour of this ephemeral model; see migration 0064.) Images are sent **uncached** for now (they ride the per-call user message; caching them would consume the 4th cache breakpoint — noted as a future optimization).

**Cache breakpoints (3, max 4 allowed)**: (1) per-mode persona — static; (2) house style + category notes — varies only by the 5 category headings; (3) brand context — per brand. `web/vercel.json` gives `api/ai/image.ts` the `includeFiles: "src/data/skills/**"` glob so the markdown ships in the function bundle.

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
| Anthropic | `console.anthropic.com` | Claude API for the LinkAI (`/api/ai/chat`). Default model `claude-sonnet-4-6`. Direct SDK integration — no OpenRouter (caching pass-through unreliable). |
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
| `AI_COPILOT_BRAND_IDS` | Vercel env vars | Comma-separated UUIDs that may use the LinkAI. Server-side allowlist enforced inside `/api/ai/chat`. |
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
- **LinkAI brand memory is write-only from chat — destructive ops live in the BrandKit UI.** Considered (a) full CRUD via chat tools (`write_brand_note`, `update_brand_note`, `delete_brand_note`), (b) write-only from chat, hand-edit / delete in BrandKitView only. Chose (b). Phrase ambiguity in chat is real — "forget that we hate the word authentic" could mean "delete the existing note" OR "remember a new note that we don't hate it anymore." A misunderstood phrasing on a destructive op = silently lost institutional memory. Curation actions live in the UI where the action is explicit and confirmed. Chat is the **acquisition** path — the agency leans on the AI to capture facts they would otherwise have to remember to manually type into the kit. The friction shape matches the value: typing "remember that…" mid-chat is frictionless; explicitly deleting a note in a UI is the right amount of friction for something destructive.
- **Brand notes are scoped per-brand, not global to the agency.** A "founder hates the word X" fact for Bamboo Bear shouldn't bleed into Acme's AI calls. The `brand_kit_notes.account_id` foreign key + the brand-context compiler reading only the active brand's notes enforces this. Considered (a) a global `agency_notes` table for cross-brand patterns ("we work in IST timezone", "our style guide is X"), (b) per-brand only for now, add agency-level later if patterns repeat. Chose (b) — start with the obvious scope, add globals only if the repetition pain becomes real. Most agency-level facts can be encoded in the chat system prompt directly.
- **AI copy generation asks the admin for an instruction BEFORE generating, no presets.** PR 4 generated copy from brand voice + concept alone — output was too random and didn't react to the admin's intent for this specific post. Considered (a) a "Custom prompt" textarea + a dropdown of presets like "Shorter / More playful / Remove emojis", (b) free-form instruction textarea only, (c) leave as-is and ask the admin to refine via Regenerate. Chose (b). Presets sound friendly but in practice an agency drafting for a specific brand has specific things in mind — "a Mother's Day post celebrating moms who run small businesses" isn't a preset; "make the hook punchier and add a CTA about our sustainability page" isn't a preset. A textarea covers both the easy case ("shorter") AND the long tail, and an agency lead types fast enough that the friction is minimal. Presets would also have to be maintained, internationalized, A/B tested for which ones work, etc. — overhead for a feature that's strictly worse than letting users say what they actually want. The instruction stays editable after streaming so the admin can refine + Regenerate to iterate without closing the preview. For "redraft" mode specifically, the system prompt is critical — it instructs the model to **preserve what works in the current copy and change ONLY what the admin's instruction asks**. The first iteration of redraft just rewrote everything from scratch, which felt like "AI took my work away." The fix is in the prompt, not the API shape: explicit instructions to preserve + change-only-what's-asked.
- **Inline copy generation is a separate `/api/ai/copy` endpoint, not another tool on `/api/ai/chat`.** The chat panel does agentic multi-turn work (call a tool → see the result → call another tool). Inline "AI draft" is single-shot — user clicks a button, the model writes one caption, that's it. Considered (a) add a `draft_post_copy(plan_id, platform)` tool to `/api/ai/chat`, (b) build a separate endpoint. Chose (b). Reasons: (i) latency — no tool-use loop overhead so tokens stream immediately on click instead of after the model "decides" to call the tool; (ii) the system prompt shape is different — chat is conversational, copy generation is "output ONE caption, no preamble, no quotes, no explanation," which Claude follows much better with a clean system message vs sharing context with chat instructions; (iii) the client consumer is half the size — only `text` events to parse, no `tool_call` / `tool_result` rendering. Trade-off: two endpoints to maintain, but they share the auth pipeline and `brandContext.js` compiler. Will keep this split if we add `improve` / `variants` modes (same endpoint, new mode flag) and only revisit if a use case wants AI orchestration across copy generation + plan creation in a single agentic flow.
- **LinkAI chat history persists to localStorage, not a DB table (for v1).** When the panel closes or the page refreshes today, the in-memory React state would be lost. Considered (a) DB table `copilot_conversations(account_id, user_id, messages jsonb)` with realtime + cross-device sync, (b) localStorage keyed by `(userId, accountId)`. Chose (b). Reasons: realtime cross-device sync isn't a real need yet (agency staff work from one machine 90%+ of the time); a DB table adds a migration, RLS, db.js helpers, optimistic-update plumbing, and realtime subscriptions for what users haven't asked for. localStorage gives us close→reopen continuity and refresh-survives — the two cases that actually came up in first-use testing — with one file and 30 LOC. We cap at last 60 messages per (user, brand) to keep growth bounded (~50KB per conversation, well under the 5MB browser cap even at 100 brands). When cross-device sync becomes a real ask, this migrates cleanly to a DB table — the message shape doesn't change, just the storage backend. The "Start new" header button explicitly clears (with confirm if non-empty) so the user has a manual reset they can trust.
- **LinkAI streams via SSE, not WebSocket and not a polling endpoint.** Three options for getting token-by-token Claude output to the panel: (a) WebSocket, (b) Server-Sent Events over a long-lived `text/event-stream` response, (c) chunked JSON polling. Chose (b) for several reasons: Vercel serverless functions support streaming responses out of the box (with `X-Accel-Buffering: no` to disable the default response buffering), Anthropic's TypeScript SDK has a first-class `stream()` API that exposes per-token deltas via `.on('text', ...)`, and SSE is one-way (server→client) which exactly matches our needs — we only send the user message at the start, then watch tokens come back. WebSocket would add bidirectional plumbing we don't use; polling would lose the token-level interactivity that makes the LinkAI feel fast. The client uses a manual SSE parser (`parseSse` async generator) rather than `EventSource` because EventSource doesn't support POST bodies or `Authorization` headers — both of which we need (the user's JWT goes in the Authorization header, and the chat history goes in the POST body).
- **LinkAI rollout uses a UUID allowlist env var, not a per-account boolean column.** Considered (a) `accounts.ai_copilot_enabled boolean default false` — clean, queryable, surfaced in the Settings UI later, (b) a server-side `AI_COPILOT_BRAND_IDS` env-var allowlist + matching `VITE_` mirror for the client conditional render. Chose (b) for the rollout phase because flipping the allowlist in Vercel env vars takes one click and zero schema changes — perfect for "let's test with Bamboo Bear today and add Acme tomorrow." A DB-column approach would force a migration + a CRUD UI for the agency to toggle it, neither of which earn their weight while we're still validating the loop end-to-end. Once we're widening past a handful of brands, we'll move to the column approach (or a `feature_flags` table) and let the env-var allowlist deprecate naturally. The double-gate (server allowlist + client `VITE_` mirror) is intentional — the client mirror is just for the conditional render; if someone bypasses the UI and calls `/api/ai/chat` directly, the server still enforces the allowlist.
- **LinkAI tools run server-side, not in the client.** Anthropic's tool-use protocol works in two modes: client-side execution (server returns "I want to call tool X with args Y", client runs it, sends back the result) or server-side wrapper (the API handler runs the tool inline before returning the final response). We went with server-side execution inside the `/api/ai/chat` route. Reasons: (a) the only PR-2 tool (`create_post_plan_draft`) writes to the DB via service-role, which can't safely run from the browser; (b) keeping the agentic loop server-side means the client just consumes a stream and renders cards, no orchestration logic — way simpler component; (c) it lets us add tools later (`write_brand_note`, `update_post_plan`) without changing the client at all. Trade-off: the SSE stream has to carry tool-call and tool-result events as additional event types alongside text deltas, so the client SSE parser is a bit more complex. Worth it.
- **Cron → edge-function auth uses a shared CRON_SECRET, not the Supabase service-role key.** When PR #44 first shipped the daily-digest cron, the Vercel route passed `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}` to the send-email function and relied on the platform's `verify_jwt: true` gate. That worked in May while Vercel's env held the legacy `eyJ…` service-role JWT. Then Supabase introduced the new `sb_secret_…` opaque-string format as the default for the same key, and the platform's JWT verifier started rejecting every cron call with `UNAUTHORIZED_INVALID_JWT_FORMAT` — the cron route was sending a non-JWT, and the platform never let the request reach our code. PR #47's "decode the bearer and check role=service_role" fix didn't help (decoded an opaque string → null), and the legacy JWT could be re-enabled in Supabase but is being deprecated. Considered (a) require the legacy JWT in Vercel env and accept the deprecation risk, (b) write our own JWT validator using Supabase's JWKS, (c) move auth off the Supabase key entirely. Chose (c). The cron is server-to-server with both sides under our control — a shared random opaque secret (`CRON_SECRET`, the same one Vercel uses to authenticate its cron *to* us) is the simplest model, doesn't depend on Supabase key formats, and can't be invalidated by Supabase product changes. The edge function now runs with `verify_jwt: false`; user-template auth (`team-invite`, `agency-update`) is enforced inside our handler via `auth.getUser()` against ANON_KEY — equivalent security guarantee, just done in code rather than at the platform gate.
- **LinkAI brand-context compiler is a pure single-purpose module, not inlined into the API route.** Prompt caching is the entire cost story for this feature — Anthropic's prompt cache gives ~90% input-token discount on cache hits within a 5-min TTL. For the cache to actually hit, the compiled blob must be **byte-stable per brand**: same inputs, same output, every time. Considered (a) inlining the compile logic directly into the future `/api/ai/chat` route, (b) building it as a method on a brand-context class with internal state, (c) a pure function in its own module. Chose (c). Pure + stateless = trivially testable, no hidden mutations, can be imported from both the SPA (for UI previews) and the Vercel route (for actual AI calls), and we can swap the data sources later (e.g. add `post_plan_publications` once we have analytics) without restructuring callers. Trade-off: one extra file in `web/src/lib/`. Worth it.
- **`brand_kit_notes` lives in its own table, not as a jsonb array on `brand_kits`.** Considered (a) `brand_kits.admin_notes jsonb default '[]'::jsonb` — single-table, no migration ceremony, (b) a dedicated `brand_kit_notes` table mirroring `post_plan_ideas` shape. Chose (b). Reasons: notes will be written frequently by the LinkAI (every "remember that …" turn), often concurrently with admin edits to the BrandKit UI — jsonb-array mutation has classic last-write-wins race conditions that a row-per-note shape sidesteps. Per-note metadata (created_by, is_pinned, individual delete) needs columnar structure anyway; jamming it into an array of objects would just reinvent half a table. And realtime subscriptions per note (for cross-tab sync between LinkAI and BrandKit UI) are clean when each note is a row but messy when the whole array refires on every change. Same pattern as the `brand_kits` ↔ `brand_kit_enrichments` split from migration 0017. Trade-off: one extra table + four RLS policies. Already mirrors `post_plan_ideas` so the pattern is familiar.
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

- **Public-launch readiness — items to land before opening the dashboard to all brands** *(roadmap pinned 2026-05-19 ahead of internal workshop)*:
  - **Service usage telemetry + daily digest** *(shipped 2026-05-19)*: `service_usage_log` (migration `0053`) + helper at `web/api/_shared/usage.ts` (`logServiceUsage`, three cost estimators) + engagement wiring (Vercel route + Supabase edge function) + `/api/usage-digest` Vercel cron at `0 2 * * *` UTC (07:30 IST) + new `service-usage-daily` template on `send-email`. Recipients = every agency-account member (queried at cron time via `auth.admin.listUsers()` + `account_members`, no env-var). Trends Radar wiring deferred under the broader Trends pause. AI route wiring (chat / copy / suggestions / image) is a small follow-up — `checkAndRecordAiUsage` from `auth-lib.ts` already records the quota row to `ai_usage`; the follow-up just adds a parallel `logServiceUsage` call after the LLM completes so `cost_usd` + `tokens_in/out` land in `service_usage_log` for the digest. See top-of-file Last-updated entry for the full shape.
  - **AI cost protection — per-brand daily cap** *(shipped 2026-05-19 via Phase 1)*: 50 AI calls per brand per IST-day across all four AI surfaces (chat / copy / image / suggestions). Owned by `web/api/ai/auth-lib.ts`'s `checkAndRecordAiUsage`; usage row INSERTed before the LLM call so concurrent bursts can't slip past the cap; 429 response under the `error` field where the Vercel AI SDK reads it. Agency users uncapped (rows still logged for telemetry). Live in production on Bamboo Bear; when we open the AI to more brands, the cap travels with them automatically.
  - **Slack mirror for daily usage digest** *(deferred for follow-up)*: same payload as the email, posted to a configured incoming-webhook URL. Single env var `SLACK_USAGE_DIGEST_WEBHOOK`. Both email + Slack fire from the same cron route. Defer until email lands and bakes for a week.
  - **LinkAI conversation persistence — DB-backed history** *(promoted from defer 2026-05-19)*: chat history today lives in `localStorage.lr_copilot_conv_<userId>_<accountId>` (60-msg cap, lost on sign-out and on device-switch). For multi-device agency users this is friction. Ship: new `copilot_conversations(account_id, user_id, messages jsonb, updated_at)` table (or normalized `copilot_messages` if jsonb grows uncomfortable), 1:1 RLS by `(account_id, user_id)`, optimistic save on each message exchange, replace the localStorage read with a DB load on panel mount. Trivial migration; ~50 LOC on the panel side. Pick up after current parallel work lands.
  - **AI image generation in-product** *(roadmap, post-launch)*: today `/api/ai/image` returns a paste-ready prompt for an external tool. Integrate Nano-banana / fal.ai / Replicate so the user receives generated images in-panel with a one-click "save to References" path. ~1 day of work; defer until usage of the existing prompt panel proves the demand.
  - **Conversations inline attachments polish** *(in progress 2026-05-19)*: image / video / file uploads work end-to-end but the inline rendering inside message bubbles needs visual polish — proper thumbnail sizing with click-to-lightbox, `<video controls>` players, file icons + size + download affordance instead of bare links, aspect-ratio preservation. Same treatment inside thread drawers as in the main feed.
  - **Live Posts daily-refresh callout** *(shipped 2026-05-19)*: 14-line addition to [LivePostsView.jsx](web/src/components/LivePostsView.jsx) — clock-icon + "Engagement stats refresh daily at 6:00 AM IST." line under the page heading. Agency keeps the per-tile "Refresh now" button.
  - **Brand proposals PR 6 — agency drawer + Resend notifications** *(on hold 2026-05-19)*: top-nav pending-proposals drawer that aggregates every open `plan_proposals` row across all brands for the agency, plus Resend Tier 2 emails when a proposal lands. Today the agency discovers proposals only by opening the specific plan — fine for the workshop, real friction for multi-brand agency leads. PRs 1-5 of 6 shipped 2026-05-19; PR 6 deferred until brand-proposal volume justifies the surface.
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
- **LinkAI PR 8 — Suggest concept** on `ConvertIdeaModal` and the calendar empty-day right-click *(promoted from PR 8 → next-in-queue after PR 7 image prompts shipped 2026-05-11)*. Pre-fills a new plan from a vague idea or a blank Tuesday slot. Will reuse the same instruction-driven preview pattern from PR 5.
- **LinkAI long-tail / backlog**:
  - **A/B 3 variants for copy generation** *(was PR 6, deferred 2026-05-11)*: side-by-side comparison UI generating 3 different angles. Less urgent now that instruction-driven `improve` covers iteration via the Regenerate-with-edited-instruction loop. Revisit if multiple users explicitly ask for side-by-side.
  - Trend → plan auto-suggest (pre-fill `TurnIntoPostPlanModal` from a trend signal). Idea Inbox triage. Recurring series autopilot. Weekly Friday strategy memo. Performance feedback loop (needs `post_plan_publications` analytics piped in first).
- **LinkAI chat persistence**: PR 2 (2026-05-11) keeps chat history in-memory only — resets when the active brand changes or the panel unmounts. Not addressing yet. If users start losing context they care about, add a `copilot_conversations` table keyed by `(account_id, user_id)` with a jsonb `messages` column + an "Open recent chats" affordance in the panel header. Trivial migration, ~50 LOC on the panel side. Defer until someone asks.
- **LinkAI per-account toggle (vs env-var allowlist)**: PR 2 gates rollout via `AI_COPILOT_BRAND_IDS` env var. Once we're past the initial validation phase (multiple brands using it weekly), migrate to either `accounts.ai_copilot_enabled boolean` or a `feature_flags` table so the agency can self-serve toggle without a Vercel env-var deploy. Defer.
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

## 15. Mobile UX

The dashboard was desktop-only until PR 1 of the mobile rollout (2026-05-28). The mobile architecture is **additive** to desktop CSS and JSX — every change is layered through media queries and a single touch-detection hook so the desktop experience stays byte-stable. Desktop is the surface where 100% of usage happens today; a desktop regression is treated as a blocker, not a fix-later.

### Breakpoint scheme

| Range | Layout |
|---|---|
| `≥ 1281px` | Full sidebar (232px) + content. Unchanged from pre-mobile. |
| `980–1280px` | Existing icon-rail at 64px. Pre-mobile behaviour, untouched. |
| `≤ 980px` | Sidebar is removed from the grid (`grid-template-columns: 1fr`) and becomes a `position: fixed` off-canvas drawer transformed offscreen by default. A hamburger button appears in `.topbar`. The 64px-rail rule from the pre-existing 980px block is overridden by the later block — at this breakpoint we want the full nav inside the drawer, not a compact rail. |
| `≤ 640px` | All of the above plus: `.view` padding crunches, topbar shrinks. `.modal-scrim` and `.login-modal-backdrop` both convert to bottom sheets (`align-items: end`, full width, 16px 16px 0 0 border-radius, slide-up animation, `padding-bottom: env(safe-area-inset-bottom)`). |
| `(hover: none) and (pointer: coarse)` | Independent of viewport width — applies to phones, tablets, touch laptops. Adds `touch-action: manipulation` to interactive elements, suppresses tap-highlight, floors the hamburger / drawer-close / sidebar nav-items at 44px tap target. |

### `useCoarsePointer` hook

[web/src/lib/useCoarsePointer.ts](web/src/lib/useCoarsePointer.ts) — wraps `matchMedia('(hover: none) and (pointer: coarse)')` with an `addEventListener('change')` subscription. Returns `false` on every desktop browser and during SSR / pre-mount, so any `if (isCoarsePointer) { … }` branch is a no-op on desktop. Used in [App.jsx](web/src/App.jsx) today to swap the topbar LinkAI button from drawer-open to page-route on touch, and to suppress the LinkAI drawer mount entirely on coarse-pointer devices (only the persistent page-variant mount renders). Future composers will use it for Enter-sends-on-mobile and camera-capture-button-on-touch in PR 2.

### Off-canvas sidebar drawer

[Sidebar.jsx](web/src/components/Sidebar.jsx) accepts `isOpen` + `onClose` props that default to behaviour-preserving values (`false` / `undefined`). On desktop the `is-open` className modifier has no effect because the sidebar isn't transformable above 980px. Below 980px:

- `.sidebar-scrim` is a sibling rendered above content with `z-index: 90`, tap-to-dismiss via `onClick={onClose}`.
- `.sidebar` itself is `position: fixed; width: min(86vw, 320px); transform: translateX(-100%); transition: transform 220ms`. `.is-open` flips to `translateX(0)`.
- A `.sidebar-drawer-close` button (`x` icon) appears inside the drawer top-right.
- The hamburger button (`.topbar-hamburger`, `list` icon) sits at the start of `.topbar`, hidden via CSS above 980px.

App-level state owns the drawer: `navOpen` in [App.jsx](web/src/App.jsx) plus two effects — one auto-closes on `location.pathname` change (catches every entry point including deep links and back/forward), one applies `document.body.style.overflow = 'hidden'` while open to absorb scrim taps without scrolling the underlying page.

### Safe-area + dynamic-viewport units

[web/index.html](web/index.html) carries `viewport-fit=cover` so iOS populates `env(safe-area-inset-*)`. Topbar + sidebar padding use `env(safe-area-inset-top/left/right/bottom)` at the 980px breakpoint so the iOS status bar + home indicator don't overlap. Nine `100vh` sites in [app.css](web/src/styles/app.css) (body, `.app`, `.sidebar`, `.home-stage`, `.auth-root`, `.auth-shell`, `.onboarding-modal`, `.inbox-list`, `.main:has(.linkai-page.is-active)`, `.main:has(.conv-wrap)`) all use the dual-value pattern `height: 100vh; height: 100dvh;` — `100dvh` only matters on mobile browser chrome, so desktop stays unaffected and old browsers fall through to `100vh`.

### Roadmap

**Shipped (PR 2, 2026-05-28):**
- CalendarView agenda-only mode at ≤640px or coarse-pointer (the existing `.cal-list` renderer at line 954 takes over via JS short-circuit + the Month/Week segmented control is CSS-hidden at narrow widths)
- PostPlanDetailView: `.page-head` column-stack, copy-tab strip with `scroll-snap-type: x mandatory`, AttachmentCard edit-pencil always visible on coarse-pointer (`showEditAffordances = hovering || isCoarsePointer`)
- ConversationsView: visible `.conv-msg-overflow-btn` on own messages (always visible on coarse-pointer; hover-only on desktop) opens the existing right-click context menu; composer `onKeyDown` forks to Enter-sends on coarse-pointer; composer icon buttons sized to 36px at ≤640px
- LinkAIPanel: same Enter-sends fork; `.link-ai-history` rail hidden at ≤640px (single ongoing chat on phone is the v1 trade-off)
- IdeateView: camera capture button (`accept="image/*" capture="environment"`) alongside paperclip on coarse-pointer
- MarkAsPostedModal: `position: sticky; bottom: 0` action row inside the bottom-sheet; URL inputs `scrollIntoView({block:'center'})` on focus

**Shipped (PR 3, 2026-05-28):**
- Camera capture in ConversationsView Composer (both feed + thread drawer mounts) and PostPlanDetailView attachment uploaders (references + deliverables) — extends the IdeateView pattern from PR 2
- `.conv-composer-hint` / `.link-ai-page-hint` / `.kbd-hint` labels hidden on coarse-pointer (⌘↩, drop-an-image, ⌘⇧L all desktop-only)
- Transform-based `:hover` lifts on five cards (`.project-card`, `.lib-tile`, `.pf-swatch`, `.sidebar-login-btn`, `.cal-week-card`) reset to `transform: none` on coarse-pointer — fixes iOS Safari stuck-hover-after-tap visual

**Shipped (PR 4, 2026-05-28 — mobile rollout COMPLETE):**
- iOS PWA meta tags (`theme-color` light/dark, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`, `application-name`) — enables "Add to Home Screen" with proper status-bar tinting and a clean app title.
- Landscape-orientation cap on bottom-sheet modals (`max-height: 90dvh` under `@media (max-height: 500px) and (orientation: landscape)`) so iPhone landscape doesn't get nearly-full-screen sheets.
- Ultra-narrow viewport polish at `≤360px` — H1 shrinks, filter pills tighten, view padding crunches further.

**Shipped (post-rollout, 2026-06-01):**
- LinkAI page composer: camera-capture button (`accept="image/*" capture="environment"`, coarse-pointer gated) alongside the paperclip, feeding the existing `addFiles` data-URL pipeline — completes the camera-capture parity with ConversationsView/IdeateView/PostPlanDetailView. Composer row also restructured to the Conversations pattern: textarea first, then attach + camera + Send grouped to the right in `.link-ai-page-actions`; `.link-ai-attach-btn` and page-row Send resized 40→32px to match `.conv-composer-icon-btn`/`.conv-composer-send`.

**Deferred to future cleanup (no rush, low value):**
- Bottom-sheet drag-to-dismiss gesture — pure delight, modals already close via X / scrim tap.
- Unify `.modal-scrim` + `.login-modal-backdrop` classnames — risky refactor (both power different modals across the app) with no user-visible benefit. Touch if/when adding a new modal that surfaces the duplication.

---

## How to update this doc

When you make a change that affects any section above:

1. Update the relevant section in place.
2. Bump the **Last updated** field at the top.
3. Add an entry to the **Recent changes log** at the very top with date + 1-line summary + which sections were touched.
4. If you renamed something, update the **Glossary** so the search-by-old-name still works.

Treat this like a real production doc — out-of-date is worse than missing.
