# Deploying L+R Studio

Ship the `web/` app to Vercel, pointed at the hosted Supabase project.

## Prereqs

- GitHub repo with this code pushed
- Vercel account connected to GitHub
- Supabase project (`vmfwnfflhvskadkfnvds` — already set up)
- Migrations 0001–0004 already applied

## One-time Supabase settings to flip for production

### 1. Turn on email confirmation

Dashboard → **Authentication → Providers → Email** → enable **Confirm email**.

For development we left this off so brand signups could sign in immediately. In prod, turn it on — new signups will receive a "Confirm your email" link before their session becomes active.

### 2. Set the Site URL and redirect URLs

Dashboard → **Authentication → URL Configuration**:

- **Site URL**: your production origin (e.g. `https://studio.landr.com`)
- **Redirect URLs**: add all origins that may receive magic/recovery links — at minimum the production origin, the Vercel preview-branch pattern `https://l-r-studio-dashboard-*.vercel.app`, and `http://localhost:5173` for local dev.

Supabase uses these for password recovery, magic link, and OAuth callbacks.

### 3. Enable Google OAuth (optional)

Dashboard → **Authentication → Providers → Google**. Add a Google Cloud OAuth 2.0 client (create one at console.cloud.google.com → APIs & Services → Credentials), paste the client ID + secret, and add the Supabase-provided callback URL to the Google client's authorized redirect list.

The "Continue with Google" button in our login modal is already wired — it'll start working the moment this is enabled.

### 4. Rotate the service_role key

Dashboard → **Project Settings → API Keys → Roll keys** on `service_role`. The key wasn't written to any file, but it was exposed in chat during setup. Rotating it invalidates the old one.

## Vercel setup

```
# From repo root
vercel link        # pick the l-r-studio-dashboard project or create it
```

In Vercel Dashboard → **Project → Settings → General**:
- **Root Directory**: `web`
- **Framework Preset**: Vite (auto-detected)
- **Build Command**: `npm run build` (auto)
- **Output Directory**: `dist` (auto)

In Vercel Dashboard → **Project → Settings → Environment Variables**, add to **Production**, **Preview**, and **Development**:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://vmfwnfflhvskadkfnvds.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (from Supabase → Project Settings → API Keys) |

Never put the service_role / secret key in Vercel env vars — it's not used by the web app (only for server-side migrations), and Vite would ship it in the bundle.

## Deploy

```
# Trigger a deploy from the CLI:
vercel --prod

# Or just push to main — Vercel auto-deploys when GitHub is connected.
```

## Post-deploy checklist

- [ ] Open the prod URL, sign up a throwaway brand, submit a brief.
- [ ] Sign in as agency in another window, verify the brief lands in Inbox.
- [ ] Upload a reference + deliverable pair, verify both sides see them.
- [ ] Send yourself an invite, open in incognito, verify the email is pre-filled and locked.
- [ ] Trigger a password reset email, click the link, verify you land on `/#…type=recovery` and can set a new password.
- [ ] Click "Continue with Google" in the login modal, verify the redirect round-trips correctly.
- [ ] Run the app through the L6 Lighthouse score — we expect reasonable numbers on desktop.

## Known gaps still present at deploy time

These are documented in Phase 7 scope:

- **Onboarding for OAuth brand signups** — a user who signs up via Google without a pending invite has no brand workspace attached. They'll see a "No brand workspace found" message on the submit button. Onboarding flow is Phase 7.
- **Real invite email delivery** — invite links are copyable but not automatically emailed. Send them through your own email/Slack/DM for now.
- **Video/PDF thumbnails** — show a filetype badge instead of a preview image.
- **React Router** — deep-link URLs (e.g. `/tasks/abc`) don't work yet; the app routes via localStorage.
- **Analytics/telemetry** — none wired.

## Troubleshooting

**"Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY" on prod**
The env vars aren't applied to the current deploy. Redeploy after setting them, or run `vercel env pull` locally to sanity-check.

**Password reset link opens the app but doesn't show the reset page**
The link must land on the Vercel domain that's in Supabase's Redirect URLs list. If the link opens a different origin, the Supabase client can't pick up the recovery token from the hash.

**RLS errors like "new row violates row-level security policy"**
Usually means a code path isn't using an authenticated client, or the auth session is stale. Run `supabase.auth.refreshSession()` in the browser console to verify.

**Realtime doesn't fire on prod**
Verify the tables are in the `supabase_realtime` publication (SQL Editor: `select * from pg_publication_tables where pubname = 'supabase_realtime';`). Should include `tasks`, `messages`, `activity`, `assets`, `invitations`.
