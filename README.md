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
  Metadata (RFC 9728). Points Claude at **this server** as the auth server.
- `GET /.well-known/oauth-authorization-server` (and `/openid-configuration`) —
  OAuth Authorization Server Metadata (RFC 8414). Advertises the proxy endpoints.
- `GET /authorize` / `POST /token` — **OAuth proxy** to Microsoft Entra.
- `POST /mcp` — MCP Streamable HTTP endpoint (stateless). Requires
  `Authorization: Bearer <token>`; returns `401` + `WWW-Authenticate` otherwise.

### Why the OAuth proxy?

Claude (like all MCP clients) includes the RFC 8707 `resource` parameter in the
OAuth authorize/token requests. Entra's v2.0 endpoint rejects `resource` outright
(`AADSTS901002` / `AADSTS9010010`). So this server advertises itself as the
authorization server, **strips the `resource` parameter**, and forwards the
requests to Entra. It remains stateless — `/authorize` is a 302 redirect and
`/token` is a transparent form forward; no tokens or secrets are stored.

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
