# L+R Studio Dashboard — Reference

> Single source of truth for what this thing is, how it's built, and how the
> pieces fit together. Updated as the codebase evolves.

**Last updated:** 2026-05-02 (Member email surfaced via new RPC; auto-accept removed)

---

## Recent changes log

Newest at top. Each entry: date, what changed, and which sections of this
doc were updated. When you make material changes, add a new dated entry.

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
- New secrets: `RESEND_API_KEY`, `EMAIL_FROM` (`agency@linkrunner.io`), optional `EMAIL_FROM_NAME` (default `L+R Agency`), optional `APP_URL` (default `https://agency.linkrunner.io`). Set via `supabase secrets set` on the project; never in repo.
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

- **Frontend**: React 18 + Vite, vanilla CSS (no Tailwind), no router (state-based routing in App.jsx)
- **Data layer**: `@supabase/supabase-js` v2 — single client at `web/src/lib/supabase.js`
- **Auth**: Supabase Auth (email/password + Google OAuth + invite tokens)
- **Backend**: Postgres on Supabase, RLS-enforced
- **Edge runtime**: Deno on Supabase Functions
- **External**: Firecrawl v2 (`/scrape` for enrichment, planned `/agent` for socials)
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
| `accounts` | Workspaces (brand or agency) | `id`, `name`, `type` (`brand`/`agency`), `accent_color` | Members + agency users | Agency for INSERT; members for UPDATE; **owner-only DELETE via `delete_brand_account` RPC** |
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

`post_plans.status` enum: `not_started`, `wip`, `needs_brand_feedback`, `needs_admin_revision`, `approved`, `scheduled`, `posted`, `delayed`. The `touch_post_plan_status_stamps` trigger auto-stamps `approved_at` / `posted_at` on first transition into those states.

All four post-plan tables are in the `supabase_realtime` publication. Realtime drives cross-tab unread refresh and same-tab cross-user updates; same-tab same-user updates use optimistic mutators (`upsertPostPlan`, `removePostPlanLocal`, `clearUnreadForPlan` in `App.jsx`).

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
- `remove_team_member(p_user_id, p_account_id)` — owner-only
- `change_member_role(p_user_id, p_account_id, p_new_role)` — owner-only
- `accept_invitation(p_token)` — redeem an invite
- `account_members_with_email(p_account_id)` — returns the account's members joined to `auth.users.email` (migration 0027). Authz: caller must be a member of the account, OR be agency staff. Used by `loadTeamForAccount` so TeamView and AdminTeamView can display each member's email next to their name.
- ~~`auto_accept_pending_invitations()`~~ *(deprecated 2026-05-02)* — was called on every session refresh and matched by email. Removed because it silently granted access to existing-account invitees and made mistyped invite emails dangerous. Function still exists on prod (defensive — in case of cached clients), no longer called from anywhere in the app. Safe to drop in a follow-up migration.

### Migrations

Sequentially numbered SQL files in `supabase/migrations/`. Apply via:
- **CLI** (requires `supabase link` + DB password): `SUPABASE_ACCESS_TOKEN=<PAT> supabase db push`
- **Management API** (PAT-only — what we used for 0025/0026): `POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "..."}` and PAT bearer
- **Dashboard**: SQL Editor → paste → run

Most recent: `0027_account_members_with_email.sql`.

Recent batch:
- `0021_post_plans` — `post_plans` + `post_plan_comments` + `post_plan_attachments` + RLS + triggers + realtime.
- `0022_post_plan_views_and_attachments_storage` — `post_plan_views` table, `post-plan-attachments` storage bucket + storage RLS scoped via `post_plan_attachment_account_id(name)` helper.
- `0023_post_plan_status_log` — `post_plan_status_log` + `log_post_plan_status_change` trigger.
- `0024_account_slug_backfill` — `accounts.slug` backfill + auto-generation trigger for Phase 2 routing.
- `0025_accept_invitation_idempotent` — `accept_invitation(token)` is idempotent for the auto-accept race (don't raise "invalid or expired" when the row was already accepted by `auto_accept_pending_invitations()` and the caller is a member). See §13 entry.
- `0026_remove_team_member_resets_is_agency` — `remove_team_member` now flips `profiles.is_agency = false` when removing the user's last agency membership. Includes a one-shot backfill for stale rows already in the broken state. See §13 entry.
- `0027_account_members_with_email` — `account_members_with_email(p_account_id)` SECURITY DEFINER RPC that joins `account_members → profiles → auth.users.email` for team-list rendering. See §13 entry.

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
| ~~`lr_route`~~ *(deprecated 2026-04-30)* | Was: last visited view, persisted across reloads. Replaced by the URL itself when Phase 1 router landed. One-time migration on first post-deploy load hops the user to the saved view, then drops the key. | Removed — App.jsx no longer writes it; existing values are migrated then deleted. | Migration block in App.jsx |
| ~~`lr_impersonation`~~ *(deprecated)* | Was: admin → client view shadow | Removed 2026-04-30 in the BrandPicker rollout. Old code that read this is gone. | — |

---

## 8. Routes / Views

URL-driven routing via `react-router-dom@6`. `<BrowserRouter>` wraps `<App/>` in [main.jsx](web/src/main.jsx); inside App we derive `route = {view, id}` from `location.pathname` (`parsePathToRoute` in [App.jsx](web/src/App.jsx)). Child components still call `setRoute({view, id})` — that's a thin adapter over `navigate(viewToPath(...))`. Sidebar renders different items per `mode`. View / path / component table:

| `route.view` | URL path | Component (customer mode) | Component (admin mode) | Purpose |
|---|---|---|---|---|
| `calendar` | `/` or `/calendar` | `CalendarView` | `CalendarView` | Social Calendar — month grid of post plans. Universal landing view (signed-in + guest). |
| `home` | `/home` | `HomeView` | `AdminHome` | Submit brief composer / agency inbox |
| `tasks` | `/tasks` | `TasksView` | `TasksView` | List of briefs |
| `tasks` + `id` | `/tasks/:shortId` | `TaskDetailView` | `TaskDetailView` | Single brief detail (chat, deliverables, activity). `:shortId` is the first 8 hex chars of the task's UUID; full UUIDs still resolve. |
| `library` | `/library` | `LibraryView` | `AdminUploadView` | Customer: searchable grid of deliverables, scoped to active brand. Admin: upload creatives |
| `performance` | `/performance` | `PerformanceView` | — | Metrics dashboard (placeholder) |
| `team` | `/team` | `TeamView` | `AdminClientsView` | Customer: invite teammates. Admin: client list |
| `members` | `/members` | — | `AdminTeamView` | Agency-only team management |
| `brand` | `/brand` | `BrandKitView` | `BrandKitView` | Brand Intelligence — full kit view + Fetch Brand. Receives `accountId` from App. |
| `plan` + `id` | `/calendar/:shortId` (or `/c/:slug/calendar/:shortId`) | `PostPlanDetailView` | `PostPlanDetailView` | Per-plan detail nested under calendar — calendar is the parent surface, so the URL stays `…/calendar/:shortId` instead of switching to a sibling `/plan/`. `:shortId` follows the same first-8-hex-chars rule as tasks. |
| `clients` | `/clients` | — | `AdminClientsView` | Agency-only client list (reachable from BrandPicker). |
| `settings` | `/settings` | `SettingsView` | `SettingsView` | Workspace name, danger-zone delete |
| `profile` | `/profile` | `ProfileView` | `ProfileView` | User profile |
| `not_found` | *(any unrecognised path)* | `NotFoundView` | `NotFoundView` | Tasteful 404 — serif headline + bad path chip + "Take me to Social Calendar" CTA. ([NotFoundView.jsx](web/src/components/NotFoundView.jsx)) |

Unknown paths land on the 404 view (`view: 'not_found'`) — the bad pathname is preserved on the route object so `NotFoundView` can echo it back. `not_found` is in both the guest-allowed set and the agency context-snap legal sets, so neither effect bounces the user away. Vercel SPA fallback rewrites every path to `/index.html` ([web/vercel.json](web/vercel.json)) so deep links resolve on cold load.

**Phase 2 (not done yet):** add a `/c/:brandSlug/...` segment so brand scope is part of the URL instead of `localStorage.lr_admin_active_brand`. See §14.

### First-paint defaults

- **Everyone (signed-in + guest)**: `view: "calendar"` is the universal landing surface (Social Calendar). Returning users with a saved `lr_route` are restored to wherever they left off.
- **After onboarding completes**: `view: "brand"` (so the user sees enriched Brand Intelligence immediately).
- **After sign-in**: `view: "calendar"` is the default; if a `pendingAction` was stashed (e.g. unsubmitted brief), that action runs instead and owns its own navigation.

### Gates

- `auth?.requiresBrandSelection` → renders `BrandSelectView` instead of the app shell
- `onboarding.open` → renders `BrandOnboardingModal` over the app
- Guest accessing any non-`home` route → snapped back to home

---

## 9. Key feature flows

### Submit a brief
`HomeView` → free-text composer + chip pickers → `submitTask()` in db.js → INSERT into `tasks` → trigger fires `created` activity → redirects into `TaskDetailView`.

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
5. The agency `Sidebar` swaps its nav based on `isAllClientsMode`: cross-client surfaces (Inbox, All tasks) when on All clients, per-brand surfaces (Calendar, Tasks, Library, Brand Intelligence, Performance, Brand team, L+R Team) when in a specific brand.

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

### `send-email`

Transactional email via Resend. Single function, dispatches by `template`
in the request body.

| Template | Purpose | Status |
|---|---|---|
| `team-invite` | Sends a teammate-invite email when a row is created in `invitations`. Subject: "X invited you to {workspace} on L+R Agency". Includes accept-invite CTA + the same `?invite=<token>` URL the Copy-link button writes. | **Live** — used by both [TeamView.jsx](web/src/components/TeamView.jsx) (brand teammates) and [admin.jsx](web/src/components/admin.jsx) (agency staff). |

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
| `EMAIL_FROM_NAME` | no | `L+R Agency` | Display name in `From` header |
| `APP_URL` | no | `https://agency.linkrunner.io` | Base for the invite link |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` | yes | auto-injected | Set by Supabase platform |

#### Deploying the edge function

```sh
SUPABASE_ACCESS_TOKEN=<PAT> \
  supabase secrets set \
    RESEND_API_KEY=re_... \
    EMAIL_FROM=agency@linkrunner.io \
    EMAIL_FROM_NAME="L+R Agency" \
    APP_URL=https://agency.linkrunner.io \
  --project-ref vmfwnfflhvskadkfnvds

SUPABASE_ACCESS_TOKEN=<PAT> \
  supabase functions deploy send-email \
  --project-ref vmfwnfflhvskadkfnvds
```

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
| Supabase Personal Access Token (PAT) | Local `~/.supabase/access-token` (CLI manages) | Used for `db push` and `functions deploy` |

### Pending credential rotations (from session memory, 2026-04-23 → 05-01)

- Supabase `service_role` key — shared in chat 2026-04-23, rotate at Settings → API
- Firecrawl key (`fc-…`) — shared in chat 2026-04-27, rotate at firecrawl.dev/app/api-keys
- Supabase PAT (`sbp_…`) — shared in chat 2026-04-27 + reused 2026-04-28, rotate at supabase.com/dashboard/account/tokens
- Resend key (`re_…`) — shared in chat 2026-05-01, rotate at resend.com/api-keys after Tier 1 ships

---

## 13. Known decisions & gotchas

Running log of "we considered X and chose Y because Z" — newest first.

- **Email-match auto-accept removed; invites require an explicit token click.** The `auto_accept_pending_invitations()` RPC was introduced in 0010 with the goal of letting invitees skip the click — sign in with the matching email and you're in. Removed 2026-05-02 because the silent-grant cases (existing-account invitees, typos in the invite email) outweighed the QoL benefit. Considered: (a) keep auto-accept but only when `lr_pending_invite` localStorage is set — equivalent to just using the token flow, so redundant; (b) gate auto-accept on signup-event vs every session refresh — narrower, but still silent for the existing-account case which was the main complaint. Chose to remove entirely. Token flow is the single redemption path. The SQL function is intentionally left in place on prod for defensive compatibility with any cached client; safe to drop in a follow-up migration.
- **`accept_invitation` is idempotent for the auto-accept race.** The token-based `accept_invitation` runs *after* the email-based `auto_accept_pending_invitations` in the auth refresh chain. If the user's email matches the invite (which it does for any normal invite flow), auto-accept redeems the row first and then the token-based accept finds `accepted_at` non-null. Original RPC raised "invalid or expired" in this case even though the user was already a member. Fix (0025): look up the row regardless of `accepted_at`, then return success if the caller is already a member of the target account. Considered alternatives — (a) gate the App.jsx token-redemption useEffect on `auth.newlyJoinedAccountIds` being empty (works but only patches the symptom in one client path), (b) drop one of the two redemption paths entirely. Chose the SQL fix because it's robust against any future client path that calls `accept_invitation` on an already-accepted row, not just this one.
- **`remove_team_member` resets `profiles.is_agency` when the last agency membership goes.** The flag was being set on join (in `accept_invitation` since 0002) but never cleared on removal, leaving stale `is_agency=true` rows and putting brand-only users in agency mode after they'd been removed from the agency. Considered: (a) compute `is_agency` on the read path as `memberships.some(m => m.accounts.type === 'agency')` instead of trusting the stored flag — cleanest but a behavior change touching every `auth.isAgency` read and the RLS helper `is_agency_user()`. (b) trigger on `account_members` DELETE that recomputes the flag — broader scope (covers any future delete path). (c) fix the specific RPC. Chose (c) for now because there's only one delete path in the app today; revisit (b) if a second appears. The migration also includes a one-shot backfill for rows that were already in the broken state.
- **Email sending uses one edge function with `template` dispatch, not per-template functions.** Considered separate functions per email type (`send-team-invite`, `send-task-delivered`, etc. — clean isolation). Chose a single `send-email` function that switches on `body.template` because: (a) one Resend client, one set of secrets, one cold-start; (b) shared template-rendering helpers (HTML scaffolding, `escapeHtml`, From/Reply-To logic) live in one file instead of being copy-pasted; (c) we'll add Tier 2 templates (post-plan status, comments) without each one needing its own deploy. Each template still gets its own request shape and its own auth check inside the function — the dispatcher is just a switch, not a `eval`-like surface.
- **Email failure is non-fatal for the invite flow.** If Resend errors out, the `invitations` row already exists and the Copy-link affordance below the invite form keeps working. We changed the flash message based on the email outcome ("Sent an invite to X" vs "Invite created for X, but the email didn't send. Copy the link below…") rather than aborting the whole submission. Reasoning: the row is the source of truth for accept-invite; the email is just delivery convenience. Better to let the user fall back to the manual flow than tell them "invite failed" when actually their teammate can still redeem.
- **`Reply-To` set to the inviter, `From` always `agency@linkrunner.io`.** The visible `From` is the workspace identity (the recipient should see "L+R Agency" not a personal address), but replies should thread to the human who actually invited them. Resend allows distinct `from` and `reply_to`, so we use both. The `agency@linkrunner.io` Google Workspace mailbox catches anything not-replies-to-the-inviter (bounces, "wrong person" forwards, etc.).
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

---

## 14. Pending work / known issues

- **Resend Tier 2 — workflow notifications**: not built yet. Tier 1 (invitation emails) shipped 2026-05-01. Tier 2 fans out emails on DB writes via `pg_net` from existing triggers — task delivered, brief assigned, post-plan submitted-for-review / approved / needs-changes / delayed, new comments, new deliverables. See the Tier-2 list in the [Resend integration memory note](.claude/projects/.../memory/project_resend_email_integration.md). All hooks land in `send-email` as new `template` cases.
- **Resend Tier 3 — digests + auth-side replacements**: also not built. Daily/weekly digest of unread post-plan activity (powered by `post_plan_views.last_seen_at`); optionally replacing Supabase's native password-reset / signup-confirm emails with branded Resend versions.
- **Multi-source URL discovery (`discover` / `check_agent` modes)**: deployed in `enrich-brand-kit` but no client wires call them yet. Designed to find socials from a seed URL via Firecrawl Agent.
- **Past creatives image cache**: noted in session memory — IG image fetch + cache to Supabase Storage is deferred until the social asset pipeline is built. `kit.pastCreatives` entries without `imageUrl` are filtered out of the UI (`BrandKitView` line ~1710).
- **Per-brand URL paths (Phase 2 of the routing work)**: not implemented. Phase 1 (2026-04-30) added real per-view URLs (`/calendar`, `/plan/:id`, etc.) but brand context is still scoped via `BrandPicker` + `localStorage.lr_admin_active_brand`. Phase 2 will add a `/c/:brandSlug/...` URL segment so agency users can deep-link to "this brand's calendar / this plan in this brand", make multiple tabs independent, and stop relying on localStorage for brand scope. Needs an additive `accounts.slug` migration (or fall back to UUIDs in URLs).
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
