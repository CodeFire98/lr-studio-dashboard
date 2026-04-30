# L+R Studio Dashboard — Reference

> Single source of truth for what this thing is, how it's built, and how the
> pieces fit together. Updated as the codebase evolves.

**Last updated:** 2026-04-29 (initial creation)

---

## Recent changes log

Newest at top. Each entry: date, what changed, and which sections of this
doc were updated. When you make material changes, add a new dated entry.

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
| **Active brand** | The brand the user is currently viewing | `auth.account`, `localStorage[lr_active_brand_<userId>]` |
| **Brand picker** | Modal for choosing a brand on login | `BrandSelectView`, gated by `auth.requiresBrandSelection` |
| **Impersonation** | Agency staff opening a brand's workspace | `sessionStorage.lr_impersonation` |
| **Brand Kit** / **Brand Intelligence** / **Kit** | Brand's design + voice profile | `brand_kits` table, `BrandKitView` route key `"brand"` |
| **Brief** / **Task** | A creative request | `tasks` table, `TasksView` / `TaskDetailView` |
| **Chip** | A structured brief field (count/deadline/format/platform/objective) | `task.brief.chips`, `CHIP_TO_COLUMN` map in `db.js` |
| **Enrichment** / **Fetch Brand** | Auto-fill a kit from the brand's website | `triggerBrandKitEnrichment`, `enrich-brand-kit` edge function |
| **Re-enrich** | Run enrichment again on a kit | same flow, different button label when `kit.enrichedAt` exists |
| **Auto-create-brand** | First-login provisioning of a brand workspace | `create_brand_account` RPC, called from `auth.js _doRefresh` |
| **Brand-just-deleted gate** | Forces picker after delete instead of auto-create | `localStorage.lr_brand_just_deleted` |
| **Library** | Searchable grid of delivered creatives | `LibraryView`, route `"library"` (admin renders `AdminUploadView`) |
| **Activity** | Per-task event feed | `activity` table, rendered in `TaskDetailView` |

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
│   ├── migrations/            # 0001 → 0020+ (numbered, applied in order)
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
| `profiles` | Per-user profile mirror of auth.users | `id` (=auth.uid), `display_name`, `initials`, `avatar_color`, `is_agency`, `email` | Authenticated | Self-update only |
| `tasks` | Briefs / creative requests | `account_id`, `title`, `brief_text`, `status`, `creatives_count`, `deadline`, `format`, `platform`, `objective`, `assigned_lead_id`, `created_by` | Members of account | Members + agency |
| `assets` | Files uploaded against a task | `task_id`, `kind` (`reference`/`wip`/`deliverable`), `storage_path`, `mime_type`, `version`, `uploaded_by` | Same as task | Same |
| `messages` | Conversation thread per task | `task_id`, `author_id`, `body` | Same as task | Author + agency |
| `activity` | Event feed per task | `task_id`, `actor_id`, `action`, `payload` (jsonb) | Authenticated, scoped to readable tasks | **SELECT-only for users**; writes via `SECURITY DEFINER` triggers (`log_task_activity`, `log_message_activity`, `log_asset_activity`) |
| `brand_kits` | Brand's design + voice profile | one per account; ~60 columns including `palette`, `fonts`, `tagline`, `mission`, `voice_tags`, `logos`, `enrichment_status`, `enriched_at` | Members + agency | Members + agency |
| `invitations` | Pending team invites | `account_id`, `email`, `token`, `role`, `expires_at` | Inviter + invitee | Inviter |

### Storage buckets

| Bucket | Contents | Public? | Access policy |
|---|---|---|---|
| `assets` | Task deliverables, WIPs, references | Private (signed URLs) | Members of the task's account |
| `brand-assets` | Brand kit references (mood, packaging, etc.) | Public read | Members for write |
| `brand-logos` | Brand logo + variants | Public read | Members for write |

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
- `auto_accept_pending_invitations()` — runs on every session refresh; matches by email

### Migrations

Sequentially numbered SQL files in `supabase/migrations/`. Apply via:
- **CLI**: `SUPABASE_ACCESS_TOKEN=<PAT> supabase db push --project-ref vmfwnfflhvskadkfnvds`
- **Management API**: `POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "..."}` and PAT bearer
- **Dashboard**: SQL Editor → paste → run

Most recent: `0020_delete_brand_account_rpc.sql`.

---

## 7. Auth & access flow

### Sign-in paths (all → `_doRefresh` in `auth.js`)

1. **Email/password** — `signInWithPassword`
2. **Google OAuth** — `signInWithGoogle`; `redirectTo` uses `window.location.origin` so it stays on the current domain
3. **Invite token** — `accept_invitation` RPC after sign-in if `localStorage.lr_pending_invite` is set

### Sign-up paths

1. **Email/password** — `signUpBrand`; if confirmation email is enabled, lands on Site URL configured in Supabase Dashboard (set to `https://agency.linkrunner.io`)
2. **Google OAuth signup** — first sign-in auto-creates a profile via the `on_auth_user_created` trigger
3. **Invite-redemption signup** — `signUpForInvite`; promotes to agency or member based on the invitation row

### Brand resolution (the part that matters most)

`hydrateProfile()` in `auth.js`:

```
isAgency? → first agency membership wins, picker never shows
else:
  has localStorage.lr_active_brand_<userId> matching a membership? → use it
  else exactly 1 membership? → auto-select
  else (0 or 2+ memberships) → picker (BrandSelectView)
```

**`requiresBrandSelection = true`** when:
- Non-agency user
- No active membership
- 2+ memberships **OR** `localStorage.lr_brand_just_deleted` is set

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
| `lr_active_brand_<userId>` | Last-picked brand for this user on this device | `setActiveBrand` | sign-out (per-user) |
| `lr_brand_just_deleted` | Forces picker on next login after deletion | `SettingsView.deleteWorkspace` | `setActiveBrand` |
| `lr_pending_invite` | Invite token to redeem on next sign-in | URL `?invite=…` query string | After redemption |
| `lr_pending_brand_name` | Brand name to use during auto-create | `signUpBrand` | After auto-create |
| `lr_mode` | `'admin'` or `'customer'` | `useEffect` mirror of `mode` state | — |
| `lr_route` | Last visited route | `useEffect` in App.jsx | — |
| `lr_impersonation` (sessionStorage) | Admin → client view shadow | `enterClientView` | `exitClientView` |

---

## 8. Routes / Views

State-based routing — `route.view` is a string. Sidebar renders different
items per `mode`. View IDs:

| `route.view` | Component (customer mode) | Component (admin mode) | Purpose |
|---|---|---|---|
| `home` | `HomeView` | `AdminHome` | Submit brief composer / agency inbox |
| `tasks` | `TasksView` | `TasksView` | List of briefs |
| `tasks` + `id` | `TaskDetailView` | `TaskDetailView` | Single brief detail (chat, deliverables, activity) |
| `library` | `LibraryView` | `AdminUploadView` | Customer: searchable grid of deliverables, scoped to active brand. Admin: upload creatives |
| `performance` | `PerformanceView` | — | Metrics dashboard (placeholder) |
| `team` | `TeamView` | `AdminClientsView` | Customer: invite teammates. Admin: client list |
| `members` | — | `AdminTeamView` | Agency-only team management |
| `brand` | `BrandKitView` | `BrandKitView` | Brand Intelligence — full kit view + Fetch Brand |
| `calendar` | `CalendarView` | `CalendarView` | Social calendar (default landing for customers) |
| `settings` | `SettingsView` | `SettingsView` | Workspace name, danger-zone delete |
| `profile` | `ProfileView` | `ProfileView` | User profile |

### First-paint defaults

- **Customer**: `view: "calendar"`
- **Admin**: `view: "home"`
- **Guest**: snapped back to `view: "home"` on every render
- **After onboarding completes**: `view: "brand"` (so the user sees enriched data immediately)

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
| Google OAuth | Google Cloud Console → OAuth client | Sign-in via Supabase OAuth provider |
| Domain registrar | (per Lakshith) | `agency.linkrunner.io`, `cal.linkrunner.io`, `linkrunner.io` |
| Cal.com | `cal.linkrunner.io/team/demos/lragency` | Scheduling link from HomeView |

### Secret storage locations

| Secret | Where it goes | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `web/.env.local` (committed: no) | Public, included in client bundle |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `web/.env.local` | Public; RLS-restricted |
| Supabase `service_role` key | **Never in repo** | Should only live in Supabase function secrets |
| `FIRECRAWL_API_KEY` | Supabase function secret | Read by `enrich-brand-kit` from `Deno.env` |
| Supabase Personal Access Token (PAT) | Local `~/.supabase/access-token` (CLI manages) | Used for `db push` and `functions deploy` |

### Pending credential rotations (from session memory, 2026-04-23 → 04-27)

- Supabase `service_role` key — shared in chat 2026-04-23, rotate at Settings → API
- Firecrawl key (`fc-…`) — shared in chat 2026-04-27, rotate at firecrawl.dev/app/api-keys
- Supabase PAT (`sbp_…`) — shared in chat 2026-04-27 + reused 2026-04-28, rotate at supabase.com/dashboard/account/tokens

---

## 13. Known decisions & gotchas

Running log of "we considered X and chose Y because Z" — newest first.

- **Library scoping is client-side, not server-side.** RLS already restricts to accessible accounts; an extra DB filter would just complicate the query without security gain. Mirrors the TasksView pattern in App.jsx.
- **Brand deletion uses a SECURITY DEFINER RPC, not a DELETE policy.** Cleaner ownership/type guards in one place; matches the pattern of `remove_team_member` and `change_member_role`.
- **Bot-wall detection is title-based, not content-based.** Real homepages don't have titles like "Something went wrong" — high-precision check, won't false-positive on a site that mentions "Cloudflare" in its footer.
- **Firecrawl `proxy: "auto"` instead of explicit `"stealth"`.** Auto only escalates to stealth (extra credits) when basic mode hits a wall. Pays for robustness only when needed.
- **Date-only fields are formatted via `toLocalIsoDate(d)` in db.js, never `.toISOString().slice(0,10)`.** The latter shifts dates by one day for any user in a positive UTC offset (e.g. IST).
- **Activity rows are written by triggers, not the client.** The `activity` table has SELECT-only RLS; client-side `INSERT` is silently rejected. This was the cause of the chip-edit-not-logged bug fixed in 0019.
- **`window.prompt()` for first-time website URL on Fetch Brand.** Functional, not pretty. Swap for an inline modal when there's time.
- **No router library.** Routing is `route.view` state in App.jsx, persisted to `localStorage.lr_route`. Each view has a `route.view` value; deep-link only via `?` query for invites.
- **Single CSS file (~2500 lines).** All styles in `web/src/styles/app.css`. Inline styles used liberally for one-off card layouts.

---

## 14. Pending work / known issues

- **Multi-source URL discovery (`discover` / `check_agent` modes)**: deployed in `enrich-brand-kit` but no client wires call them yet. Designed to find socials from a seed URL via Firecrawl Agent.
- **Past creatives image cache**: noted in session memory — IG image fetch + cache to Supabase Storage is deferred until the social asset pipeline is built. `kit.pastCreatives` entries without `imageUrl` are filtered out of the UI (`BrandKitView` line ~1710).
- **Per-project URL paths**: requested but not implemented. Currently all brand workspaces sit at `/`; switching is via state. Real per-brand URLs would need a router refactor.
- **Credential rotations** (see §12).

---

## How to update this doc

When you make a change that affects any section above:

1. Update the relevant section in place.
2. Bump the **Last updated** field at the top.
3. Add an entry to the **Recent changes log** at the very top with date + 1-line summary + which sections were touched.
4. If you renamed something, update the **Glossary** so the search-by-old-name still works.

Treat this like a real production doc — out-of-date is worse than missing.
