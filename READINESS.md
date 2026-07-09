# Readiness — Pending Tasks Only

✅ Done: code pushed (`multi-emails-support`) · live at
**https://claude-outlook-connector.onrender.com** (PRM ✓, /enroll ✓, all 7 tools ✓)
· Render env vars set & fixed · **Azure done** · **Google done** ·
end-to-end send/read verified · **multi-user support built** (login-gated
enrollment, per-user mailbox ownership — verified locally, needs deploy).

---

## 0. Deploy multi-user update (NEW — needs push + config)
- [ ] Ask Claude Code to push the multi-user changes to `multi-emails-support`
      (Render auto-deploys)
- [ ] Render env → ADD two new vars:
      `AUTH0_CLIENT_ID` = `u6i8OSm8BPvuAaALQGmidQKCIsnAWTlI`
      `AUTH0_CLIENT_SECRET` = (in local `.env`)
- [ ] Auth0 → Applications → your app → **Allowed Callback URLs** → ADD:
      `https://claude-outlook-connector.onrender.com/enroll/auth/callback`
      (alongside the Claude/ChatGPT ones already there)
- [ ] After deploy: `/enroll` now shows **Sign in / create account** instead of
      the mailbox list — each user logs in with Auth0 and sees only their own
      mailboxes. Re-enroll your test mailboxes under your login (redeploy wiped
      them anyway).
- [ ] Verify isolation: sign into `/enroll` with a second Auth0 account → its
      mailbox list is empty; in Claude, `list_accounts` shows only the mailboxes
      of whoever connected the MCP.

---

## 1. Auth0 setup  ← YOU ARE HERE (last dashboard task)

Auth0 is the login gate for the connector: when you click **Connect** in
Claude/ChatGPT you'll sign into Auth0, and the server verifies that token on
every call. Three things to configure, all in **manage.auth0.com**:

### 1a. Create the API (tells Auth0 our server exists)
- Left sidebar → **Applications → APIs** → **Create API**
- **Name:** anything, e.g. `mail-connector`
- **Identifier:** `https://claude-outlook-connector.onrender.com/mcp`
  (paste exactly — this is the "audience" written into every token; our server
  rejects tokens whose audience doesn't match)
- **Signing algorithm:** RS256 → **Create**

### 1b. Set the tenant Default Audience (makes tokens verifiable)
- Left sidebar → **Settings** (tenant settings) → **General** tab →
  scroll to **API Authorization Settings**
- **Default Audience:** `https://claude-outlook-connector.onrender.com/mcp`
- Save.
- *Why:* Claude/ChatGPT don't send an "audience" parameter when they request a
  token. Without a default, Auth0 issues an opaque token our server can't
  verify → endless 401s. With it, every token is a proper JWT for our API.

### 1c. Allow the platforms' callback URLs on your Application
- Left sidebar → **Applications → Applications** → the app whose Client ID is
  `u6i8OSm8…` → **Settings** tab → **Allowed Callback URLs** — paste all three,
  comma-separated:
  ```
  https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, https://chatgpt.com/connector_platform_oauth_redirect
  ```
- Save (bottom of page).
- *Why:* after you log in, Auth0 redirects the browser back to Claude/ChatGPT.
  Auth0 only redirects to URLs on this list — missing entry = "Callback URL
  mismatch" error at login.

### 1d. Make sure tokens carry your email (for the allowlist)
- Same Application → Settings: no change needed normally — the `email` claim is
  included when the login requests the `openid profile email` scopes (both
  platforms do). Just ensure `OPERATOR_ALLOWLIST` on Render is the exact email
  you sign into Auth0 with (Google-login email counts, if you used
  "Continue with Google").

## 2. Enroll test mailboxes (auth still off — do BEFORE flipping auth if you like, or after; enrollment is unaffected by operator auth)
- [ ] https://claude-outlook-connector.onrender.com/enroll → **Add Microsoft account** → appears in list
- [ ] Same page → **Add Google account** → appears in list

## 3. Enable security
- [ ] Render env: `OPERATOR_AUTH_ENABLED=true` → redeploy
- [ ] `POST /mcp` now returns **401** (ask Claude Code to verify)
- ⚠️ Redeploy wipes Render's free disk → enrollments from step 2 vanish.
  Either enroll AFTER this step, or accept re-enrolling.

## 4. Connect the platforms
- [ ] **Claude:** Settings → Connectors → Add custom →
      `https://claude-outlook-connector.onrender.com/mcp` → Advanced settings:
      Auth0 Client ID/Secret (in local `.env` comments) → Connect → Auth0 login
- [ ] **ChatGPT** (Business/Enterprise/Edu + Developer Mode): Add custom connector →
      same `/mcp` URL → OAuth (same Auth0 creds) → Scan tools → publish

## 5. Functional tests (Claude first, then ChatGPT)
- [ ] "Which mailboxes can you use?" → lists both
- [ ] Draft from Outlook address → preview only; "Send it" → arrives + Sent Items
- [ ] Same from Gmail address
- [ ] "Unread across all my mailboxes?" → combined counts
- [ ] "Show my 5 most recent emails" → merged cards from both inboxes
- [ ] "Search all my mail for <word>" → results; "open the first one" → full body

## 6. Later: Hostinger
- [ ] New URL: add its redirect URIs in Azure + Google, new Auth0 API audience,
      same `VAULT_ENCRYPTION_KEY`, `.env` on server, pm2 + reverse proxy,
      re-point connectors to the new `/mcp`

## Gotchas
- Render free disk wipes on every restart/redeploy → enrollments vanish → re-enroll
  (persistent disk + `VAULT_STORE_PATH=/data/vault.enc.json` fixes permanently)
- Render sleeps ~15 min idle → first request slow, retry once
- Google app in Testing: refresh tokens expire after **7 days**, test users only
- Auth0 "Callback URL mismatch" at login → the URL list in 1c is missing/typo'd
