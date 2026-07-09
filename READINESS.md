# Readiness — Step-by-Step Setup & Test

Do these in order. Microsoft keys are already prepared in local `.env` — you only
add **one Azure value**, the **Google keys**, and the **Auth0 values**.

## 1. Push & deploy to Render
1. Push branch `multi-emails-support` (ask Claude Code).
2. Render → New → Web Service → repo `MAK-esoft/claude-outlook-connector`,
   branch `multi-emails-support`, build `npm install`, start `npm start`.
3. Note your URL → `<RENDER_URL>` (e.g. `https://xxx.onrender.com`).

## 2. Microsoft (2 minutes — keys mostly done)
1. portal.azure.com → App registrations → your app → **Overview** → copy
   **Application (client) ID** → this is `MS_CLIENT_ID` (secret already saved).
2. **Authentication** → add Web redirect URI:
   `<RENDER_URL>/enroll/callback/microsoft`
3. **API permissions**: confirm `Mail.Send`, `Mail.Read`, `offline_access`,
   `openid`, `profile`, `email`, `User.Read` (you already granted most).

## 3. Google (you set this up)
1. console.cloud.google.com → create/pick project → **Enable Gmail API**.
2. **OAuth consent screen** (External) → add your Gmail test address as **Test user**.
3. **Credentials → Create OAuth client ID → Web application** → redirect URI:
   `<RENDER_URL>/enroll/callback/google`
4. Copy → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## 4. Auth0 (operator login for Claude/ChatGPT)
1. auth0.com free account → **APIs → Create API** → Identifier = `<RENDER_URL>/mcp`, RS256.
2. Tenant **Settings → Advanced** → enable **OIDC Dynamic Application Registration**.
3. Note: `OPERATOR_ISSUER` = `https://<tenant>.<region>.auth0.com/` (keep trailing `/`),
   `OPERATOR_JWKS_URL` = issuer + `.well-known/jwks.json`,
   `OPERATOR_AUDIENCE` = `<RENDER_URL>/mcp`.

## 5. Render environment variables
```
PUBLIC_URL=<RENDER_URL>
VAULT_ENCRYPTION_KEY=<from local .env — never commit this value>
VAULT_STORE_PATH=./vault.enc.json
MS_CLIENT_ID=<from step 2.1>
MS_CLIENT_SECRET=<in local .env>
GOOGLE_CLIENT_ID=<step 3>
GOOGLE_CLIENT_SECRET=<step 3>
ENABLE_READ_SCOPES=true
OPERATOR_AUTH_ENABLED=false        # flip true after step 7
OPERATOR_ISSUER=<step 4>
OPERATOR_JWKS_URL=<step 4>
OPERATOR_AUDIENCE=<RENDER_URL>/mcp
OPERATOR_ALLOWLIST=<your email used to log into Auth0>
```
(Don't set PORT — Render injects it.)

## 6. Smoke test
- `<RENDER_URL>/.well-known/oauth-protected-resource` → JSON ✅
- `<RENDER_URL>/enroll` → page with 2 buttons ✅

## 7. Enroll test mailboxes (throwaway accounts, auth still off)
- `/enroll` → **Add Microsoft account** → sign in → appears in list.
- `/enroll` → **Add Google account** → sign in → appears in list.

## 8. Enable security, then connect
1. Render env: `OPERATOR_AUTH_ENABLED=true` → redeploy.
   `curl -X POST <RENDER_URL>/mcp` should now return **401**.
2. **Claude:** Settings → Connectors → Add custom → `<RENDER_URL>/mcp` →
   Connect → Auth0 login → done.
3. **ChatGPT** (Business/Enterprise/Edu + Developer Mode): Settings → Connectors →
   Create → `<RENDER_URL>/mcp` → OAuth → Scan tools → Create → publish.

## 9. Test prompts (run in Claude, then ChatGPT)
1. "Which mailboxes can you use?" → lists both.
2. "Draft an email from <outlook-test> to me, subject 'Test', body 'hello'" → preview only.
3. "Send it." → arrives + in Sent Items. Repeat from the Gmail address.
4. "How many unread emails across all my mailboxes?" → combined counts.
5. "Show my 5 most recent emails" → merged cards from both inboxes.
6. "Search all my mail for invoice" → results; "open the first one" → full body.

## 10. Later: move to Hostinger
1. Same steps, new URL (e.g. `https://outlook-mcp.srv1802008.hstgr.cloud`):
   add that redirect URI in Microsoft + Google, new Auth0 API audience, same
   `VAULT_ENCRYPTION_KEY` (keeps enrollments), `.env` on server, pm2 + reverse proxy.
2. Re-point Claude/ChatGPT connectors to the new `/mcp` URL (remove + re-add).

## Gotchas
- Render free disk is **wiped on restart** → enrolled mailboxes vanish → re-enroll
  (or add a Render persistent disk and set `VAULT_STORE_PATH=/data/vault.enc.json`).
- Render sleeps ~15 min idle → first request slow; retry once.
- Google app in Testing: refresh tokens die after **7 days**, test users only.
- Any URL change ⇒ update redirect URIs in **all** consoles.
