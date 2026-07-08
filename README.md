# Claude Email Connector (MCP Server)

A stateless remote [MCP](https://modelcontextprotocol.io) server that lets Claude
send email from a Microsoft mailbox via Microsoft Graph `/me/sendMail`.

Microsoft Entra is the OAuth authorization server. When a user connects this
connector in Claude, Claude runs OAuth against Entra and sends the resulting
delegated Graph access token as a bearer token on every tool call. **This server
stores no tokens and has no refresh logic** — it relays the bearer token straight
to Graph.

## Tools

- **`preview_email`** — formats a draft for review. Sends nothing.
- **`send_email`** — sends via the authenticated user's mailbox, but **only if
  `confirmed: true`**. Two separate tools by design (no auto-send).

## Endpoints

- `GET /.well-known/oauth-protected-resource` — OAuth Protected Resource
  Metadata (RFC 9728). Points Claude at Entra as the auth server.
- `POST /mcp` — MCP Streamable HTTP endpoint (stateless). Requires
  `Authorization: Bearer <token>`; returns `401` + `WWW-Authenticate` otherwise.

## Run locally

```bash
npm install
# set PUBLIC_URL to your public HTTPS URL, then:
node server.js
```

## Deploy (free tier)

1. Push this repo to your host (Render / Railway / Fly.io / etc.).
2. Set environment variables on the host:
   - `PUBLIC_URL` = the app's public HTTPS URL, e.g. `https://your-app.onrender.com` (no trailing slash).
   - `PORT` is usually injected by the host automatically; the server honors it.
3. Start command: `node server.js`
4. Verify `https://<your-app>/.well-known/oauth-protected-resource` returns raw JSON.

## Connect in Claude

claude.ai → Settings → Connectors → Add custom connector:

- **URL:** `https://<your-app>/mcp`
- **Advanced settings:** paste your Entra **Application (client) ID** and **client
  secret value**. These live in Claude only — never in this server.

## Security

Client ID/secret are **never** stored in this server or repo. `.env` is
gitignored. The server only ever relays the per-request bearer token to Graph.
