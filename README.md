# Multi-Account Email Connector (MCP)

A remote [MCP](https://modelcontextprotocol.io) server that lets an AI assistant
(**Claude _and_ ChatGPT**, unchanged) **send and read email across many
mailboxes and providers** — Microsoft/Outlook and Google/Gmail, including
custom-domain addresses hosted on either.

Unlike a single-identity connector, credentials live in a **server-side
encrypted vault**: each mailbox owner enrolls once, and afterwards the assistant
can act on any enrolled mailbox by naming its `from` address — no reconnect per
account.

## How it works — two auth layers, multi-user

- **Layer A — Operator auth:** the human using Claude/ChatGPT signs in through a
  standard OAuth authorization server (Auth0 / Entra External ID / Okta /
  Cognito). Their JWT gates every `/mcp` call (validated by signature, issuer,
  audience, expiry, scope, then an optional allowlist). This is the only
  platform-aware surface, and it's built to a spec both platforms implement.
- **Layer B — Mailbox vault:** per-address refresh tokens, collected via the
  enrollment portal, encrypted at rest (AES-256-GCM). At send/read time the
  server mints a fresh access token and calls the correct provider API.

**Multi-user:** the enrollment portal requires the same Auth0 login (set
`AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET`). Every enrolled mailbox is owned by the
account that enrolled it, and `/mcp` tools are scoped to the operator's identity
— many people can use one deployment, each seeing only their own mailboxes.

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Lists enrolled mailboxes to choose a sender/target |
| `preview_email` | Formats a draft for review — sends nothing |
| `send_email` | Sends from an enrolled mailbox; only when `confirmed: true` |
| `check_inbox` | Total/unread counts, one mailbox or all combined |
| `list_recent_emails` | Recent mail, per mailbox or merged across all, newest first |
| `search_emails` | Keyword/sender search, per mailbox or across all |
| `read_email` | Opens a full message body by ref id |
| `reply_email` | Replies in-thread; only when `confirmed: true` |
| `forward_email` | Forwards to a new recipient; only when `confirmed: true` |
| `mark_email` | Marks read/unread (reversible) |
| `delete_email` | Moves to Trash/Deleted Items (recoverable); only when `confirmed: true` |

Read tools take an optional `account`; omit it to act across **all** enrolled
mailboxes collectively, or pass one address to scope to a single mailbox.

> **Scope note:** this build requests **read** access too (`Mail.Read` /
> `gmail.readonly`), a deliberate expansion of the spec's send-only default so
> the read tools work. Set `ENABLE_READ_SCOPES=false` to revert to send-only.

## Layout

```
server.js                  Express entry: enrollment + PRM + /mcp
src/crypto.js              AES-256-GCM helpers
src/vault.js               encrypted credential store
src/operatorAuth.js        JWT/JWKS validation + allowlist (Layer A)
src/enrollment.js          /enroll portal (Layer B onboarding)
src/mx.js                  optional MX provider hint
src/mcp.js                 MCP server + tools
src/providers/             microsoft.js, google.js, index.js (adapters)
PLATFORM_NOTES.md          per-platform (Claude vs ChatGPT) setup
```

## Run (dev)

1. `npm install`
2. Create `.env` from `.env.example`. Generate the vault key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Fill Microsoft/Google client IDs+secrets and (before real use) the operator
   auth values. See the spec's Section 3 for the console setup each requires.
3. `node server.js` (or `npm start`), expose it over public HTTPS (tunnel with a
   **static** domain, or deploy).
4. Enroll a mailbox at `<PUBLIC_URL>/enroll`.
5. Connect the assistant — see **[PLATFORM_NOTES.md](PLATFORM_NOTES.md)**.

## Security

- Refresh tokens encrypted at rest; `.env` and `vault.enc.json` are gitignored.
- Full operator-token validation (not a decode shortcut) — required for ChatGPT.
- Tokens are never logged; refresh failures surface a clear re-enroll message.
- Two-tool confirmed-send model preserved (`preview_email` / `send_email`).
- Optional `INGRESS_IP_ALLOWLIST` for defense-in-depth.

⚠️ Until `OPERATOR_AUTH_ENABLED=true`, `/mcp` is open — startup prints a warning.
Use throwaway test mailboxes only until operator auth is on.
