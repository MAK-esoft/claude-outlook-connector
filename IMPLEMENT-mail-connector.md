# Implementation Spec — Claude Email Connector (MCP Server)

> **For Claude Code.** Build a remote MCP server that lets Claude send email from a Microsoft mailbox via Microsoft Graph. Azure/Entra setup is already complete (app registered, permissions granted, client secret created). Your job is the server, the local run, and getting it to a state where a custom connector can be added in Claude and tested end-to-end.

---

## Context you need

- **Architecture:** Microsoft Entra IS the OAuth authorization server. When the user connects this connector in Claude, Claude runs OAuth against Entra, the user signs into Microsoft, and the access token Claude sends with each tool call IS the delegated Graph token. **The server stores no tokens and has no refresh logic** — it just relays the bearer token it receives to Graph's `/me/sendMail`.
- **Safety model (hard requirement — no auto-send):** two separate tools. `preview_email` shows a draft and sends nothing. `send_email` only sends if `confirmed: true`. This is deliberate; do not collapse them into one tool.
- **Transport:** Streamable HTTP, stateless.
- **The Entra permissions already granted (delegated):** `Mail.Send`, `offline_access`, `openid`, `profile`, `email`.
- **Redirect URIs already registered in Entra:** `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`.

---

## Task 0 — Preconditions (verify, don't assume)

Run these and confirm before building:
```bash
node -v      # must be >= 18
npm -v
```
If Node < 18, stop and tell the user to install Node 18+ from https://nodejs.org before continuing.

Confirm you're in the intended project directory (the user created one, e.g. `~/projects/claude-mail-connector`). If the current directory isn't empty or isn't the intended one, ask before scaffolding.

---

## Task 1 — Scaffold the project

```bash
npm init -y
npm install @modelcontextprotocol/sdk express zod dotenv
```

Then edit `package.json` to add the top-level key:
```json
"type": "module"
```

Verify install succeeded:
```bash
npm ls --depth=0
```
All four packages should be listed with no `UNMET DEPENDENCY` errors.

---

## Task 2 — Create `.env`

Create a `.env` file in the project root:
```
PUBLIC_URL=
PORT=3000
```

**Do NOT put CLIENT_ID or CLIENT_SECRET in this file or anywhere in the server.** The server never sees them — Claude holds them and handles the OAuth exchange with Entra directly. The client ID/secret are pasted by the user into Claude's connector Advanced Settings, not into the server. (If you find yourself wanting to add them here, that's a signal the architecture is being misunderstood — re-read the Context section.)

`PUBLIC_URL` stays blank until Task 5, when the tunnel URL is known.

Also create a `.gitignore`:
```
node_modules/
.env
```

---

## Task 3 — Create `server.js`

Create `server.js` in the project root with the following implementation. It must:

1. Load `PUBLIC_URL` and `PORT` from env; strip any trailing slash from `PUBLIC_URL`; exit with a clear error if `PUBLIC_URL` is empty.
2. Serve **OAuth Protected Resource Metadata (RFC 9728)** at `GET /.well-known/oauth-protected-resource` — this is what makes Claude discover Entra as the auth server and trigger the Microsoft login flow.
3. On `POST /mcp`, require an `Authorization: Bearer <token>` header. If missing, return **401** with a `WWW-Authenticate` header pointing at the metadata endpoint.
4. Expose exactly two tools via the MCP SDK: `preview_email` and `send_email`.
5. `send_email` relays the received bearer token straight to `https://graph.microsoft.com/v1.0/me/sendMail` with `saveToSentItems: true`, and only if `confirmed === true`.

Use this exact code:

```javascript
// server.js
// Claude Email Connector — remote MCP server relaying to Microsoft Graph sendMail.
// No token storage, no refresh logic — Claude owns the OAuth token lifecycle via offline_access.

import express from "express";
import dotenv from "dotenv";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // strip trailing slash

if (!PUBLIC_URL) {
  console.error("PUBLIC_URL is not set in .env — set it to your tunnel URL and restart.");
  process.exit(1);
}

const app = express();
app.use(express.json());

// --- OAuth Protected Resource Metadata (RFC 9728) ---
// Tells Claude: "Entra is the authorization server for this resource."
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: ["https://login.microsoftonline.com/common/v2.0"],
    bearer_methods_supported: ["header"],
    scopes_supported: [
      "https://graph.microsoft.com/Mail.Send",
      "offline_access",
      "openid",
      "profile",
      "email",
    ],
  });
});

// --- MCP tool definitions ---
function buildServer() {
  const server = new McpServer({
    name: "claude-mail-connector",
    version: "1.0.0",
  });

  server.tool(
    "preview_email",
    "Formats an email draft for the user to review. Sends nothing. Always call this before send_email.",
    {
      recipient: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
    },
    async ({ recipient, subject, body }) => {
      const draft = `To: ${recipient}\nSubject: ${subject}\n\n${body}`;
      return {
        content: [{ type: "text", text: `Draft ready for review (not sent):\n\n${draft}` }],
      };
    }
  );

  server.tool(
    "send_email",
    "Sends an email via the authenticated user's Microsoft mailbox. Only sends if confirmed=true — otherwise returns a reminder to get user approval first.",
    {
      recipient: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
      confirmed: z
        .boolean()
        .describe("Must be true. Set only after the user has explicitly approved sending this exact draft."),
    },
    async ({ recipient, subject, body, confirmed }, extra) => {
      if (!confirmed) {
        return {
          content: [
            {
              type: "text",
              text: "Not sent — confirmed was not true. Show the draft to the user and only call send_email with confirmed:true after explicit approval.",
            },
          ],
        };
      }

      const authHeader = extra?.requestInfo?.headers?.authorization;
      const bearerToken = typeof authHeader === "string"
        ? authHeader.replace(/^Bearer\s+/i, "")
        : undefined;

      if (!bearerToken) {
        return {
          content: [{ type: "text", text: "No access token available — the connector may need to be reconnected." }],
          isError: true,
        };
      }

      const graphRes = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "Text", content: body },
            toRecipients: [{ emailAddress: { address: recipient } }],
          },
          saveToSentItems: true,
        }),
      });

      if (graphRes.status === 202) {
        return { content: [{ type: "text", text: `Email sent to ${recipient}.` }] };
      }

      const errorText = await graphRes.text();
      return {
        content: [{ type: "text", text: `Graph API error (${graphRes.status}): ${errorText}` }],
        isError: true,
      };
    }
  );

  return server;
}

// --- MCP endpoint — stateless streamable HTTP transport ---
app.post("/mcp", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`
      )
      .json({ error: "unauthorized", error_description: "Missing bearer token" });
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
  console.log(`Public URL configured as: ${PUBLIC_URL || "(not set yet)"}`);
  console.log(`PRM endpoint: ${PUBLIC_URL}/.well-known/oauth-protected-resource`);
});
```

---

## Task 4 — Local sanity check (before tunneling)

The server will refuse to start with an empty `PUBLIC_URL`. So temporarily set it to a placeholder to confirm the code runs, OR just proceed to Task 5 and set the real URL. If you want a pre-tunnel check:

```bash
PUBLIC_URL=http://localhost:3000 node server.js
```
You should see the three log lines and no crash. Then `Ctrl+C`. Confirm in another terminal:
```bash
curl http://localhost:3000/.well-known/oauth-protected-resource
```
It must return JSON with `"authorization_servers":["https://login.microsoftonline.com/common/v2.0"]`. Stop the server after confirming.

---

## Task 5 — Start the tunnel and wire the public URL

The user has a tunnel tool installed (ngrok or Cloudflare) with a reserved static domain.

**If ngrok with a static domain:**
```bash
ngrok http --url=<THE-STATIC-DOMAIN> 3000
```
**If ngrok without a static domain (URL rotates each run):**
```bash
ngrok http 3000
```
**If Cloudflare quick tunnel:**
```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the public `https://...` URL it prints. Then:
1. Put it into `.env` as `PUBLIC_URL=<url>` (no trailing slash).
2. In a **separate terminal**, start the server:
   ```bash
   node server.js
   ```
   Keep both the tunnel and the server running.

---

## Task 6 — Verify the public PRM endpoint

In a browser (or curl), open:
```
<PUBLIC_URL>/.well-known/oauth-protected-resource
```
You must see the raw JSON. If you instead see:
- an ngrok "You are about to visit..." interstitial page → the free-tier interstitial will break Claude's discovery. Use a static domain or Cloudflare tunnel.
- a tunnel error / connection refused → the server isn't running or the tunnel points at the wrong port.

Do not proceed to the Claude side until this returns raw JSON over public HTTPS.

---

## Task 7 — Hand back to the user for the Claude connector steps

These steps happen in the Claude web UI and can't be done from the command line. Print them clearly for the user:

1. Go to **https://claude.ai** → profile icon (bottom-left) → **Settings** → **Connectors** → **Add connector** (custom).
2. **Name:** `claude-mail-connector`
   **Remote MCP server URL:** `<PUBLIC_URL>/mcp`
3. Expand **Advanced settings** and paste:
   - **OAuth Client ID** = the CLIENT_ID from Entra
   - **OAuth Client Secret** = the CLIENT_SECRET from Entra
4. Click **Add**, then click **Connect**.
5. Sign in at the Microsoft prompt with the outlook.com test account → **Accept** the consent screen ("Send mail as you").
6. Connector should show **Connected**.

---

## Task 8 — End-to-end test script (guide the user through this)

1. New chat in Claude → **+** button → enable the `claude-mail-connector` connector.
2. Prompt: *"Draft an email to `<test-address>` with subject 'Test 1' and body 'Connector test.'"*
   → Confirm Claude calls **preview_email** and shows the draft, sends nothing.
3. Prompt: *"Send it."*
   → Claude asks tool-use permission → **Allow** → Claude calls **send_email** with `confirmed: true`.
4. Verify: the email arrives, AND a copy is in the test account's **Sent Items** folder (confirms `saveToSentItems`).
5. **Sender-switch test:** Settings → Connectors → Disconnect → Connect again with a *different* Microsoft account → repeat steps 2–4 → email should now come from the second account, proving the server holds no identity.

---

## Troubleshooting reference

| Symptom | Cause | Fix |
|---|---|---|
| Claude never shows MS login | PRM endpoint not reachable / not raw JSON | Re-check Task 6; `PUBLIC_URL` has no trailing slash; tunnel + server both running |
| `AADSTS50011` | Redirect URI mismatch | Entra URIs must be exactly the two Claude callbacks, type **Web** |
| `AADSTS700016` | Wrong Client ID or wrong directory | Re-copy Client ID; confirm login account matches the app's directory |
| Graph 401/403 on send | `Mail.Send` missing or consent stale | Confirm scope in Entra; disconnect + reconnect the connector |
| `MailboxNotEnabledForRESTAPI` | Test account mailbox not provisioned | Log into outlook.com once, send a manual email, retry |
| Works in Inspector, not Claude | ngrok free interstitial | Use static domain or Cloudflare tunnel |
| Broke after tunnel restart | URL rotated | Update `.env`, restart server, re-add connector with new `/mcp` URL |

---

## Optional — MCP Inspector (isolate server bugs from Claude)

```bash
npx @modelcontextprotocol/inspector
```
Point it at `<PUBLIC_URL>/mcp`, walk the OAuth flow, and manually call `preview_email` / `send_email` to confirm the server independently of Claude.

---

## Definition of done

- `node server.js` runs with the real `PUBLIC_URL`, no crash.
- `<PUBLIC_URL>/.well-known/oauth-protected-resource` returns raw JSON publicly.
- Connector added in Claude, Microsoft login + consent completed, shows Connected.
- `preview_email` shows a draft without sending.
- `send_email` sends a real email, verified in the recipient inbox and the sender's Sent Items.
- (Bonus) sender-switch test passes with a second account.
