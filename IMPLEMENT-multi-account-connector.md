# Implementation Spec — Multi-Account, Multi-Provider Email Connector (Platform-Agnostic MCP + Server-Side Credential Vault)

> **For Claude Code.** This is a NEW architecture on a fresh branch — do not assume the previous single-identity connector applies. Read this whole file before writing code. Build in the phase order given. Several phases have hard security requirements that are NOT optional.
>
> **Platform goal:** the same MCP server must work with **both Claude and ChatGPT** (and any other MCP-speaking AI app) with only *configuration* changes — no code forks. Section 1.5 and Phase 6 are where this is earned. Everything else is platform-neutral by construction.

---

## 0. What changed, and why this is portable

The old connector was **single-identity**: the AI platform's own OAuth carried one Microsoft user's token to the server, and the server stored nothing. That cannot send from multiple accounts without disconnect/reconnect, and it tied the design to one platform's OAuth semantics.

This version **inverts the auth model**, which is also what makes it platform-agnostic:
- The **server** holds credentials (refresh tokens) for many mailboxes, across providers (Microsoft, Google, and any custom-domain address hosted by either).
- At send time, the AI passes a `from` address; the server looks up that account's stored provider + refresh token, mints a fresh access token, and sends via the correct provider API.
- The user enrolls each mailbox **once** through a server-hosted enrollment portal (separate from any AI platform). After that, no re-auth per send.

Because the mailbox credentials live in the server's vault and the AI platform's OAuth only authenticates *the operator* (the human using the AI), the only platform-specific surface is the operator-auth layer. That layer is built to a standard (OAuth 2.1 + RFC 9728 discovery + PKCE) that both Claude and ChatGPT implement, so it is shared, not forked.

This means the server is a **credential vault**. That is a serious security responsibility and drives the requirements in Section 2. Do not treat any of Section 2 as optional.

---

## 1. Architecture overview

Two distinct auth layers. Do not conflate them.

### Layer A — Operator auth (gates the MCP endpoint; the ONLY platform-aware layer)
Controls *which human is allowed to use the connector at all*. Both Claude and ChatGPT authenticate the operator here via standard OAuth. Without this, anyone who discovers the `/mcp` URL can send mail as every enrolled mailbox. See Phase 6.

### Layer B — Mailbox vault (per-address send-as credentials; fully platform-neutral)
The store of refresh tokens for each enrolled email address, collected via the enrollment portal (Phase 4), used by the send tools (Phase 5). Identical regardless of which AI app calls the server.

### Data flow at send time (identical for Claude and ChatGPT)
```
Operator in Claude OR ChatGPT: "email the client from ali@esoftsols.com"
      │
      ▼
AI platform → MCP server /mcp   (operator-authenticated via OAuth, Layer A)
      │  tool call: send_email(from="ali@esoftsols.com", to=..., subject=..., body=..., confirmed=true)
      ▼
Server: validate operator token (JWT/JWKS) + allowlist
      → look up account "ali@esoftsols.com" in vault
      → provider = "microsoft", refresh_token = <encrypted>
      → decrypt, exchange refresh_token for fresh access_token at Microsoft
      → POST to Microsoft Graph /me/sendMail with that access_token
      ▼
Email sent from ali@esoftsols.com
```

### Data flow at enrollment time (one-time per address; platform-neutral)
```
Mailbox owner → https://<server>/enroll  (portal, NOT any AI app)
      → picks "Add Microsoft account" or "Add Google account"
      → provider OAuth consent (offline access requested)
      → provider redirects back to /enroll/callback/<provider> with a code
      → server exchanges code for access + refresh token
      → server stores { email, provider, refresh_token(encrypted), label }
```

### Why the custom-domain problem disappears
Provider is **recorded at enrollment** — whichever OAuth flow the user completed IS the provider. So `ali@esoftsols.com` on Microsoft and `sara@markedai.com` on Google are just rows with different `provider` fields. No send-time guessing, ever. (Optional MX-lookup *hint* in Phase 4 is UX only and never overrides the recorded provider.)

---

## 1.5 Platform-agnostic design contract (READ BEFORE CODING)

To guarantee "works on any MCP AI app with config-only tweaks," obey these rules everywhere:

1. **One standard, no per-platform branches in tool logic.** The MCP server implements the plain MCP spec: streamable-HTTP transport, tools with JSON-schema inputs, RFC 9728 protected-resource metadata, 401 + `WWW-Authenticate` for unauthenticated calls, OAuth 2.1 authorization-code + PKCE for the operator. Both Claude and ChatGPT consume exactly this. There must be NO `if (platform === 'claude')` logic in `send_email`/`preview_email`/`list_accounts`.

2. **Bearer-token validation is universal.** Every `/mcp` request carries `Authorization: Bearer <token>`. The server validates it the same way no matter who sent it: verify signature against the operator authorization server's JWKS, check `iss`, `aud`/resource, `exp`/`nbf`, and required scope, then map to an operator identity and check the allowlist. Do not rely on any platform "trusting" the token for you.

3. **Client registration must accept all of DCR, CIMD, and pre-registered clients.** This is a property of the *operator authorization server* you choose (Phase 6), not your code. Claude uses Anthropic-held creds / DCR / CIMD; ChatGPT uses CIMD / DCR / predefined clients / PKCE. Pick an AS that supports DCR (dynamic client registration) so both platforms self-register without manual per-platform client setup. Managed IdPs (Auth0, Okta, Cognito, Entra External ID) do this out of the box.

4. **No machine-to-machine assumption.** Neither platform supports client-credentials / service-account grants for connectors — every connection requires an interactive user (operator) consent. Do not design operator auth around a static token or M2M grant.

5. **Two required read-tools for ChatGPT compatibility mode.** ChatGPT's deep-research / company-knowledge surface expects tools named `search` and `fetch`. Our connector is action-oriented (email send), used via ChatGPT **Developer Mode** (full MCP), which calls arbitrary tools — so `search`/`fetch` are NOT required for the Developer-Mode path we target. Do NOT rename our tools to satisfy the deep-research schema. (Documented here only so nobody "fixes" tool names later and breaks the action flow.)

6. **All platform differences live in config + docs, not code.** Anything that differs between Claude and ChatGPT (setup clicks, plan gating, which URL suffix, enabling Developer Mode) goes in the `PLATFORM_NOTES.md` this spec produces (Phase 8), never in server logic.

---

## 2. Security requirements (NON-NEGOTIABLE)

Because the server holds live send-as credentials, all of the following are required:

1. **Encrypt refresh tokens at rest.** AES-256-GCM, key from `VAULT_ENCRYPTION_KEY` (32 bytes, base64). Code in Phase 2.
2. **Never log tokens** (access, refresh, auth codes, encryption key, operator tokens). Scrub them from error output.
3. **`.env` and the vault store are gitignored.** Never commit secrets or the token store.
4. **Full operator-token validation is REQUIRED (not deferred) because of cross-platform support.** ChatGPT explicitly requires the resource server to verify the token itself (signature, iss, aud/resource, exp/nbf, scope). A decode-and-allowlist shortcut is NOT acceptable for the cross-platform build. Phase 6 implements real JWKS validation.
5. **Operator auth before any real credentials.** During very early dev you MAY run `/mcp` unauthenticated to smoke-test tools — but ONLY while enrolling THROWAWAY test mailboxes, and only on Claude (ChatGPT Developer Mode strongly expects OAuth). Print a startup warning while unauthenticated. Do not enroll any real/company mailbox until Phase 6 is complete.
6. **Least-privilege scopes.** Only send + offline access + basic identity. No mail-read, no mailbox management. Exact scopes in Phase 3.
7. **Confirmed-send safety preserved.** Keep the two-tool model: `preview_email` sends nothing; `send_email` only sends when `confirmed === true`.
8. **Token-refresh failure is surfaced, not swallowed.** Dead refresh token → clear "needs re-enrollment" message naming the address. Never fail silently.
9. **Verify the caller is the AI platform at the transport layer where possible.** ChatGPT presents an OpenAI-managed client certificate (mTLS) and publishes egress IP ranges; Anthropic also publishes egress ranges. Support optional IP allowlisting via config (`INGRESS_IP_ALLOWLIST`) as defense-in-depth. Do not make it the only control.

If anything elsewhere conflicts with these, these win.

---

## 3. Manual prerequisites (the USER must do these — print reminders, do not attempt yourself)

### 3.1 Microsoft (Entra) — mailbox provider for Outlook/M365 addresses
- **https://portal.azure.com** → App registrations → existing app (or new) → **Authentication**.
- Add **Web** redirect URI: `https://<YOUR_SERVER_URL>/enroll/callback/microsoft`
- Delegated Graph permissions: `Mail.Send`, `offline_access`, `openid`, `profile`, `email`, `User.Read`.
- Client ID/Secret → `.env` as `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.

### 3.2 Google — mailbox provider for Gmail/Workspace addresses
- **https://console.cloud.google.com** → project → enable **Gmail API**.
- **OAuth consent screen** (External) → add operator + test mailbox addresses as **Test users**.
- **Credentials → OAuth client ID → Web application** → redirect URI `https://<YOUR_SERVER_URL>/enroll/callback/google`.
- Client ID/Secret → `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- **Google caveats to tell the user:** scope `https://www.googleapis.com/auth/gmail.send` + `openid email profile`; MUST send `access_type=offline` AND `prompt=consent` to get a refresh token; while the app is in **Testing** status refresh tokens **expire after 7 days** and only test users can enroll — full "never re-auth" for Gmail needs Google verification.

### 3.3 Operator authorization server (NEW — the platform-agnostic auth layer)
Pick ONE identity provider to authenticate the *operator* (the human in Claude/ChatGPT). It must publish OAuth/OIDC discovery metadata, issue verifiable JWTs, and support **DCR** (so both Claude and ChatGPT self-register). Recommended options, easiest first:
- **Auth0** (free tier): create an API (audience = `https://<YOUR_SERVER_URL>/mcp`), enable Dynamic Client Registration, note the domain (issuer) and JWKS URL.
- **Microsoft Entra External ID**, **Okta**, or **AWS Cognito**: equivalent capability.
- Record for `.env`: `OPERATOR_ISSUER` (e.g. `https://YOUR_TENANT.us.auth0.com/`), `OPERATOR_JWKS_URL`, `OPERATOR_AUDIENCE` (= your `/mcp` URL), and the allowlist of operator emails.
- Enable DCR in the IdP so no manual per-platform client creation is needed. If your chosen IdP cannot do DCR, you must instead register a client per platform and use CIMD or predefined client IDs — more manual, still code-free.

### 3.4 Encryption key
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
→ `.env` as `VAULT_ENCRYPTION_KEY`. If lost, all stored tokens are undecryptable (users re-enroll). Keep it safe.

---

## 4. Config (`.env`) — full template

```
# Server
PUBLIC_URL=                 # tunnel or deployed URL, no trailing slash
PORT=3000

# Vault
VAULT_ENCRYPTION_KEY=       # 32-byte base64 (Section 3.4)
VAULT_STORE_PATH=./vault.enc.json

# Mailbox provider: Microsoft
MS_CLIENT_ID=
MS_CLIENT_SECRET=

# Mailbox provider: Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Operator auth (Layer A) — platform-agnostic
OPERATOR_AUTH_ENABLED=false        # set true before enrolling real mailboxes / using ChatGPT
OPERATOR_ISSUER=                   # e.g. https://YOUR_TENANT.us.auth0.com/
OPERATOR_JWKS_URL=                 # e.g. https://YOUR_TENANT.us.auth0.com/.well-known/jwks.json
OPERATOR_AUDIENCE=                 # = <PUBLIC_URL>/mcp
OPERATOR_ALLOWLIST=you@example.com,manager@example.com
OPERATOR_REQUIRED_SCOPE=email.send # optional scope your AS issues

# Defense-in-depth (optional)
INGRESS_IP_ALLOWLIST=              # comma-separated CIDR ranges for Anthropic + OpenAI egress (optional)
```

`.gitignore` must contain:
```
node_modules/
.env
vault.enc.json
```

Extra dependency for JWT validation (Phase 6): `jose` (JWKS + JWT verify).
```bash
npm install @modelcontextprotocol/sdk express zod dotenv jose
```
(Node built-in `crypto`, `fetch`, `dns/promises` cover the rest. No DB dep for the dev POC.)

---

## 5. Project structure

```
/
├─ .env
├─ .gitignore
├─ package.json                 ("type": "module")
├─ server.js                    entry: mounts enrollment routes + MCP endpoint on one Express app
├─ PLATFORM_NOTES.md            per-platform setup (Claude vs ChatGPT) — produced in Phase 8
├─ src/
│  ├─ vault.js                  encrypted store: get/put/list/delete accounts
│  ├─ crypto.js                 AES-256-GCM helpers
│  ├─ operatorAuth.js           JWT/JWKS validation + allowlist (Layer A) — platform-agnostic
│  ├─ providers/
│  │  ├─ index.js               registry: "microsoft"|"google" → adapter
│  │  ├─ microsoft.js           OAuth exchange/refresh + Graph sendMail
│  │  └─ google.js              OAuth exchange/refresh + Gmail send
│  ├─ enrollment.js             router: /enroll, /enroll/start/:provider, /enroll/callback/:provider
│  ├─ mcp.js                    MCP server factory + the three tools
│  └─ mx.js                     (optional) MX hint for enrollment
```

---

## 6. PHASE 2 — Vault + crypto layer

### `src/crypto.js`
```javascript
import crypto from "crypto";

const KEY = Buffer.from(process.env.VAULT_ENCRYPTION_KEY || "", "base64");
if (KEY.length !== 32) {
  throw new Error("VAULT_ENCRYPTION_KEY must be 32 bytes (base64-encoded). Generate one per the spec.");
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
```

### `src/vault.js`
Encrypted-at-rest JSON store keyed by lowercased email. Record shape:
```
{ email, provider: "microsoft"|"google", label, refresh_token_enc, created_at, updated_at }
```
Exported: `putAccount({email,provider,label,refreshToken})` (encrypts, upserts, persists), `getAccount(email)`, `getRefreshToken(email)` (decrypted or null), `listAccounts()` (array of `{email,provider,label}`, NO tokens), `deleteAccount(email)`. Load into memory on startup; write-through on mutation. Never leak tokens in `listAccounts`.

---

## 7. PHASE 3 — Provider adapters

Common interface (provider-agnostic router depends on this):
```
exchangeCode({ code, redirectUri }) -> { email, refreshToken }
refreshAccessToken(refreshToken)    -> { accessToken, refreshToken? }   // return rotated refresh token if provider rotates
sendMail({ accessToken, from, to, subject, body }) -> void (throws on failure)
buildAuthorizeUrl({ redirectUri, state }) -> string
```

### `src/providers/microsoft.js`
- Authorize: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` with `client_id=MS_CLIENT_ID`, `response_type=code`, `redirect_uri`, `response_mode=query`, `scope=openid profile email offline_access User.Read https://graph.microsoft.com/Mail.Send`, `state`.
- Token: `https://login.microsoftonline.com/common/oauth2/v2.0/token` (form-urlencoded). Exchange (authorization_code) and refresh (refresh_token) both include client_id, client_secret, scope. Persist the newest refresh_token (it rotates).
- Email discovery: decode `id_token` payload or `GET https://graph.microsoft.com/v1.0/me` → `mail` || `userPrincipalName`.
- sendMail: `POST https://graph.microsoft.com/v1.0/me/sendMail`, `Authorization: Bearer <accessToken>`, body:
  ```json
  { "message": { "subject": "...", "body": { "contentType": "Text", "content": "..." },
    "toRecipients": [{ "emailAddress": { "address": "<to>" } }] }, "saveToSentItems": true }
  ```
  Success = 202.

### `src/providers/google.js`
- Authorize: `https://accounts.google.com/o/oauth2/v2/auth` with `client_id=GOOGLE_CLIENT_ID`, `response_type=code`, `redirect_uri`, `scope=openid email profile https://www.googleapis.com/auth/gmail.send`, `access_type=offline`, `prompt=consent`, `state`. (offline+consent REQUIRED for refresh token.)
- Token: `https://oauth2.googleapis.com/token` (form-urlencoded).
- Email discovery: decode `id_token` → `email` (or `https://openidconnect.googleapis.com/v1/userinfo`).
- sendMail via Gmail API: build RFC 2822, base64url-encode, `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, body `{ "raw": "<base64url>" }`.
  ```javascript
  const raw = [`From: ${from}`,`To: ${to}`,`Subject: ${subject}`,`Content-Type: text/plain; charset="UTF-8"`,``,body].join("\r\n");
  const encoded = Buffer.from(raw).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  ```
  Success = 200.

### `src/providers/index.js`
```javascript
import * as microsoft from "./microsoft.js";
import * as google from "./google.js";
const registry = { microsoft, google };
export function getProvider(name){ const p=registry[name]; if(!p) throw new Error(`Unknown provider: ${name}`); return p; }
export const PROVIDER_NAMES = Object.keys(registry);
```

---

## 8. PHASE 4 — Enrollment portal

`src/enrollment.js` — Express router at `/enroll`, minimal plain HTML (no framework; keep it clean and readable).
- `GET /enroll` — lists enrolled accounts (`vault.listAccounts()`), two buttons: Add Microsoft / Add Google. Optional email input for MX hint.
- `GET /enroll/start/:provider` — random `state` (store in a `Map<state,{provider,expiresAt}>`, 10-min TTL; comment that prod needs signed state), redirect to `provider.buildAuthorizeUrl(...)`.
- `GET /enroll/callback/:provider` — validate `state`, read `code`, `provider.exchangeCode(...)` → `{email,refreshToken}`, `vault.putAccount({email,provider,label:email,refreshToken})`, success page.
- `POST /enroll/remove` — dev convenience, remove by email.

### MX hint `src/mx.js` (optional, UX only)
```javascript
import { resolveMx } from "dns/promises";
export async function guessProvider(domain){
  try{
    const hosts=(await resolveMx(domain)).map(r=>r.exchange.toLowerCase()).join(" ");
    if(hosts.includes("outlook.com")||hosts.includes("protection.outlook.com")) return "microsoft";
    if(hosts.includes("google.com")||hosts.includes("googlemail.com")) return "google";
    return null;
  }catch{ return null; }
}
```
Hint only; never overrides the recorded provider.

---

## 9. PHASE 5 — MCP server + tools (platform-neutral)

`src/mcp.js` builds an `McpServer` (name `multi-account-mail-connector`) with THREE tools, stateless streamable-HTTP, mounted at `POST /mcp` in `server.js`. Tool logic must contain NO platform branching.

- **`list_accounts`** — no input; returns enrolled `email — provider — label` list from `vault.listAccounts()`. This is how the AI/user discovers valid senders; if the user didn't name an account, the AI calls this and asks.
- **`preview_email`** — input `from,to,subject,body`; validate `from` exists in vault (else error suggesting enrollment); return formatted draft; send nothing.
- **`send_email`** — input `from,to,subject,body,confirmed`:
  1. `confirmed !== true` → return "not sent, needs explicit approval".
  2. `getAccount(from)` null → "No enrolled account for <from>. Enroll at <PUBLIC_URL>/enroll." (isError)
  3. `getRefreshToken(from)`; `getProvider(account.provider)`.
  4. `refreshAccessToken(...)`; on throw → "Authorization for <from> expired/revoked. Re-enroll at <PUBLIC_URL>/enroll." (isError). If a rotated refresh token returned, persist via `putAccount`.
  5. `sendMail(...)`.
  6. Success → "Email sent from <from> to <to>." Provider error → status+message (isError), SCRUB tokens.

`from` must exactly match an enrolled address (prevents spoofing; the token is bound to that mailbox).

### PRM endpoint (`server.js`)
`GET /.well-known/oauth-protected-resource` returns RFC 9728 JSON. When `OPERATOR_AUTH_ENABLED=true`, advertise the operator authorization server:
```json
{
  "resource": "<PUBLIC_URL>/mcp",
  "authorization_servers": ["<OPERATOR_ISSUER>"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["<OPERATOR_REQUIRED_SCOPE>"]
}
```
`/mcp` returns 401 + `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"` when unauthenticated. This exact discovery flow is what BOTH Claude and ChatGPT follow — no per-platform variation.

When `OPERATOR_AUTH_ENABLED=false` (early Claude-only smoke test), `/mcp` may run open; startup log MUST warn.

---

## 10. PHASE 6 — Operator auth (platform-agnostic, REQUIRED for cross-platform + real creds)

`src/operatorAuth.js` — Express middleware for `/mcp`. Uses `jose`.
1. Extract bearer token; if absent → 401 + WWW-Authenticate (triggers the OAuth flow in either platform).
2. Verify JWT against `OPERATOR_JWKS_URL` (cache JWKS via `jose`'s `createRemoteJWKSet`).
3. Check `iss === OPERATOR_ISSUER`, `aud`/resource includes `OPERATOR_AUDIENCE`, `exp`/`nbf` valid, and `OPERATOR_REQUIRED_SCOPE` present (if set).
4. Extract operator email/identity claim; if not in `OPERATOR_ALLOWLIST` → 403.
5. Attach operator identity to the request for logging (never log the token).

Skeleton:
```javascript
import { createRemoteJWKSet, jwtVerify } from "jose";
const JWKS = createRemoteJWKSet(new URL(process.env.OPERATOR_JWKS_URL));
const allow = (process.env.OPERATOR_ALLOWLIST||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

export async function requireOperator(req, res, next){
  if (process.env.OPERATOR_AUTH_ENABLED !== "true") return next(); // dev-only bypass; startup warns
  const h = req.headers.authorization||"";
  if(!h.startsWith("Bearer ")){
    return res.status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${process.env.PUBLIC_URL}/.well-known/oauth-protected-resource"`)
      .json({ error:"unauthorized" });
  }
  try{
    const { payload } = await jwtVerify(h.slice(7), JWKS, {
      issuer: process.env.OPERATOR_ISSUER,
      audience: process.env.OPERATOR_AUDIENCE,
    });
    const scope = process.env.OPERATOR_REQUIRED_SCOPE;
    if (scope && !(payload.scope||"").split(" ").includes(scope)) return res.status(403).json({error:"insufficient_scope"});
    const email = (payload.email || payload.preferred_username || "").toLowerCase();
    if (allow.length && !allow.includes(email)) return res.status(403).json({error:"operator_not_allowed"});
    req.operator = { email };
    next();
  }catch(e){
    return res.status(401).set("WWW-Authenticate",`Bearer error="invalid_token"`).json({error:"invalid_token"});
  }
}
```
This middleware is identical for Claude and ChatGPT. The ONLY difference between platforms is how each self-registers as an OAuth client against your AS — handled by the AS's DCR/CIMD support (Section 3.3), not by your code.

Optional: `INGRESS_IP_ALLOWLIST` check as defense-in-depth (allow Anthropic + OpenAI egress ranges).

**Until `OPERATOR_AUTH_ENABLED=true`, startup must print a visible warning: endpoint unauthenticated, throwaway test mailboxes only, Claude-only smoke testing.**

---

## 11. PHASE 7 — Run, tunnel, verify

1. Fill `.env` (Sections 3+4).
2. `node server.js` — startup log prints: port, PUBLIC_URL, PRM URL, enrollment URL, operator-auth status (+ warning if off).
3. Tunnel with a STATIC domain (redirect URIs must stay stable): `ngrok http --url=<static-domain> 3000` (or Cloudflare).
4. Put tunnel URL in `.env` `PUBLIC_URL`, restart.
5. Confirm the three registered redirect/audience values match current PUBLIC_URL: Microsoft `/enroll/callback/microsoft`, Google `/enroll/callback/google`, operator AS `OPERATOR_AUDIENCE=<PUBLIC_URL>/mcp`. If the tunnel URL changed, update all three consoles.
6. Browser check: `<PUBLIC_URL>/enroll` loads; `<PUBLIC_URL>/.well-known/oauth-protected-resource` returns JSON.

---

## 12. PHASE 8 — Produce `PLATFORM_NOTES.md` (the config-only per-platform guide)

Claude Code must GENERATE this file so the operator can connect either platform. Contents:

### Claude
- Individual (Pro/Max): Settings → Connectors → Add custom connector → URL `<PUBLIC_URL>/mcp`. If the operator AS needs a pre-registered client, put Client ID/Secret in Advanced settings; if the AS supports DCR/CIMD, leave blank. Connect → operator OAuth → consent.
- Team/Enterprise: Owner adds under Organization settings → Connectors; members then Connect.
- Enable per chat via the "+" → Connectors toggle.

### ChatGPT
- **Plan gate:** write-capable custom connectors require **Business / Enterprise / Edu** (Plus/Pro individual = read-only custom connectors, which cannot run `send_email`). State this prominently.
- Admin enables **Developer Mode**: Workspace Settings → Permissions & Roles → Connected Data → Developer mode / Create custom MCP connectors.
- Settings → Connectors (or Apps & Connectors) → Add custom connector / Create → paste `<PUBLIC_URL>/mcp`, set Authentication = OAuth → Scan Tools → complete operator OAuth → Create. App appears as a Dev draft; publish to workspace to use.
- Enable the connector in a chat; ChatGPT confirms each tool call before executing.
- Note: ChatGPT validates the operator token strictly (signature/iss/aud/exp/scope) — our Phase 6 middleware already satisfies this.

### Shared truths (put once, apply to both)
- Server must be public HTTPS reachable from the platform's cloud (not localhost/VPN).
- Same `/mcp` URL, same PRM discovery, same tools.
- Mailbox enrollment is done once at `<PUBLIC_URL>/enroll` regardless of platform.
- Switching platforms is configuration only; the server does not change.

---

## 13. Test plan

1. **Enroll a Microsoft test account** at `<PUBLIC_URL>/enroll` → appears in list; confirm `vault.enc.json` has encrypted `refresh_token_enc` (not plaintext).
2. **Enroll a Google test account** (listed test user) → appears in list.
3. **Operator auth on** (`OPERATOR_AUTH_ENABLED=true`), AS configured.
4. **Claude:** add connector, operator OAuth, `list_accounts` → both addresses; `preview_email` → draft only; `send_email` from MS → arrives + in Sent Items; `send_email` from Google → arrives via Gmail.
5. **ChatGPT (Business/Enterprise/Edu):** enable Developer Mode, add connector, operator OAuth, repeat `list_accounts` / `preview_email` / `send_email` for both providers. Confirms same server serves both platforms unchanged.
6. **Custom-domain routing:** enroll a custom-domain address via its actual host provider, send from it → routes correctly with NO domain guessing.
7. **Dead-token path:** revoke one account's consent, send from it → clear "re-enroll" message, no crash.
8. **Operator allowlist:** attempt with a non-allowlisted operator identity → 403.

---

## 14. Troubleshooting reference

| Symptom | Cause | Fix |
|---|---|---|
| No refresh token (Google) | Missing `access_type=offline`/`prompt=consent` | Add both; re-enroll |
| Google blocked / access denied | Not a Test user or app unverified | Add address as test user |
| Google dies after ~7 days | App in Testing status | Submit for Google verification, or re-enroll during testing |
| `AADSTS50011` (MS enrollment) | Redirect URI mismatch | Must equal `<PUBLIC_URL>/enroll/callback/microsoft`, type Web |
| Graph 202 but no mail / MailboxNotEnabledForRESTAPI | Mailbox not provisioned | Log in once via web, send manual email, retry |
| `send_email` account not found | `from` not enrolled / case mismatch | Match enrolled address; lookups are lowercased |
| 401 loop on connect (either platform) | PRM/JWKS/audience misconfig | Verify PRM `authorization_servers`, `OPERATOR_ISSUER`, `OPERATOR_AUDIENCE`=`<PUBLIC_URL>/mcp`, JWKS reachable |
| ChatGPT: no "Add custom connector" | Developer Mode off or wrong plan | Admin enables Developer Mode; Business/Enterprise/Edu for write tools |
| ChatGPT connects but won't run send | Plus/Pro read-only limitation | Use Business/Enterprise/Edu workspace |
| Client fails to register | AS lacks DCR/CIMD | Enable DCR in IdP, or pre-register client + set Client ID/Secret in platform advanced settings |
| Decrypt error on startup | `VAULT_ENCRYPTION_KEY` wrong/changed | Restore original key; if lost, clear store + re-enroll |
| Anyone can hit /mcp | Operator auth off | Set `OPERATOR_AUTH_ENABLED=true`; complete Phase 6 before real mailboxes |
| Redirect works then breaks | Tunnel URL rotated | Update `PUBLIC_URL` + all 3 consoles + restart |

---

## 15. Definition of done

- Vault stores accounts with **encrypted** refresh tokens; `listAccounts` never leaks tokens.
- Enrollment completes Microsoft AND Google OAuth, discovers the address, records provider, stores rotated-aware refresh token.
- `list_accounts` / `preview_email` / `send_email` work; `send_email` respects `confirmed`, routes by recorded provider (no domain guessing), and contains NO platform branching.
- Operator auth (Phase 6) does full JWT/JWKS validation + allowlist, identical for both platforms.
- Verified working on **both Claude and ChatGPT** using the SAME server, differing only by the steps in `PLATFORM_NOTES.md`.
- Custom-domain address routes correctly by enrolled provider.
- Dead-token sends return a clear re-enrollment message; non-allowlisted operator gets 403.
- No secrets committed; startup warns if operator auth is off.

---

## 16. Explicitly deferred (do NOT build now unless asked)

- HTML bodies / attachments / CC / BCC (spec is plain-text, single recipient).
- Real database or multi-tenant vault (dev uses encrypted JSON store, single-operator scope).
- Provider verification submissions (Google verification, Microsoft publisher verification) — user-handled when past testing.
- mTLS client-certificate verification of the calling platform (IP allowlist is the dev-tier substitute).
- Additional mailbox providers beyond Microsoft/Google — adapter interface makes this a drop-in.
- ChatGPT `search`/`fetch` deep-research schema — not needed for the Developer-Mode action flow; do not add.
