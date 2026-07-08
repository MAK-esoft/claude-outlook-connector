// server.js
// Claude Email Connector — remote MCP server relaying to Microsoft Graph sendMail.
// No token storage, no refresh logic — Claude owns the OAuth token lifecycle via offline_access.
//
// This server also acts as a thin, stateless OAuth *proxy* in front of Microsoft Entra.
// Reason: Claude (like all MCP clients) includes the RFC 8707 `resource` parameter in the
// OAuth authorize/token requests. Entra's v2.0 endpoint rejects `resource` outright
// (AADSTS901002 / AADSTS9010010). So instead of pointing Claude directly at Entra, we
// advertise THIS server as the authorization server, strip `resource`, and forward the
// requests to Entra. We never see the client secret persistently and store no tokens —
// authorize is a 302 redirect and token is a transparent form forward.

import express from "express";
import dotenv from "dotenv";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // strip trailing slash

if (!PUBLIC_URL) {
  console.error("PUBLIC_URL is not set in .env — set it to your public HTTPS URL and restart.");
  process.exit(1);
}

// Entra v2.0 endpoints (multi-tenant + personal accounts via /common).
const ENTRA_AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const ENTRA_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const GRAPH_SCOPES = [
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "offline_access",
  "openid",
  "profile",
  "email",
];

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- OAuth Protected Resource Metadata (RFC 9728) ---
// Points Claude at THIS server as the authorization server (which then proxies to Entra).
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: GRAPH_SCOPES,
  });
});

// --- OAuth Authorization Server Metadata (RFC 8414) ---
// Advertises our proxy's /authorize and /token endpoints. Served at both well-known paths
// so clients that probe either one succeed.
function authServerMetadata() {
  return {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],
    scopes_supported: GRAPH_SCOPES,
  };
}
app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(authServerMetadata()));
app.get("/.well-known/openid-configuration", (req, res) => res.json(authServerMetadata()));

// --- OAuth proxy: /authorize ---
// Strip the unsupported `resource` param, then redirect the browser to Entra's authorize
// endpoint. Entra redirects back to Claude's registered callback directly (not through us),
// so PKCE + state flow end-to-end with Entra untouched.
app.get("/authorize", (req, res) => {
  const params = new URLSearchParams(req.query);
  params.delete("resource");
  res.redirect(`${ENTRA_AUTHORIZE}?${params.toString()}`);
});

// --- OAuth proxy: /token ---
// Strip `resource`, forward the form body to Entra's token endpoint, relay the response
// verbatim. Preserves client auth whether sent in the body or as a Basic Authorization header.
app.post("/token", async (req, res) => {
  const params = new URLSearchParams(req.body);
  params.delete("resource");

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  try {
    const entraRes = await fetch(ENTRA_TOKEN, {
      method: "POST",
      headers,
      body: params.toString(),
    });
    const text = await entraRes.text();
    res
      .status(entraRes.status)
      .set("Content-Type", entraRes.headers.get("content-type") || "application/json")
      .send(text);
  } catch (err) {
    res.status(502).json({ error: "server_error", error_description: String(err) });
  }
});

// --- Graph helpers ---
// Pull the delegated Graph bearer token off the incoming MCP request.
function extractBearer(extra) {
  const authHeader = extra?.requestInfo?.headers?.authorization;
  return typeof authHeader === "string"
    ? authHeader.replace(/^Bearer\s+/i, "")
    : undefined;
}

// GET against Graph v1.0 with the relayed token. `path` starts with "/".
async function graphGet(token, path, extraHeaders = {}) {
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });
}

// Compact one message record into a readable line for the model/user.
function formatMessage(m) {
  const from = m.from?.emailAddress
    ? `${m.from.emailAddress.name || ""} <${m.from.emailAddress.address || ""}>`.trim()
    : "(unknown sender)";
  const when = m.receivedDateTime || "";
  const unread = m.isRead === false ? " [UNREAD]" : "";
  const preview = (m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 140);
  return `- ${when}${unread}\n  From: ${from}\n  Subject: ${m.subject || "(no subject)"}\n  ${preview}`;
}

const MESSAGE_SELECT = "subject,from,receivedDateTime,isRead,bodyPreview";

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

      const bearerToken = extractBearer(extra);
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

  server.tool(
    "get_email_count",
    "Returns how many emails are in a mail folder. For a named folder returns total and unread counts; use folder='all' for the total across the whole mailbox.",
    {
      folder: z
        .string()
        .optional()
        .describe(
          "Folder to count. Well-known names: inbox (default), sentitems, drafts, deleteditems, junkemail, archive. Use 'all' for the entire mailbox."
        ),
    },
    async ({ folder }, extra) => {
      const token = extractBearer(extra);
      if (!token) {
        return { content: [{ type: "text", text: "No access token available — reconnect the connector." }], isError: true };
      }

      const target = (folder || "inbox").trim();

      if (target.toLowerCase() === "all") {
        const res = await graphGet(token, "/me/messages/$count", { ConsistencyLevel: "eventual" });
        const text = await res.text();
        if (!res.ok) {
          return { content: [{ type: "text", text: `Graph API error (${res.status}): ${text}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Total emails in mailbox: ${text.trim()}` }] };
      }

      const res = await graphGet(token, `/me/mailFolders/${encodeURIComponent(target)}`);
      const body = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Graph API error (${res.status}): ${body}` }], isError: true };
      }
      const f = JSON.parse(body);
      return {
        content: [
          {
            type: "text",
            text: `Folder "${f.displayName || target}": ${f.totalItemCount} total, ${f.unreadItemCount} unread.`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_recent_emails",
    "Lists the most recent emails in a folder (subject, sender, date, read/unread, preview). Reads only — sends and changes nothing.",
    {
      count: z.number().int().min(1).max(50).optional().describe("How many messages to return (default 10, max 50)."),
      folder: z
        .string()
        .optional()
        .describe("Folder to list. Well-known names: inbox (default), sentitems, drafts, etc. Use 'all' for across the whole mailbox."),
    },
    async ({ count, folder }, extra) => {
      const token = extractBearer(extra);
      if (!token) {
        return { content: [{ type: "text", text: "No access token available — reconnect the connector." }], isError: true };
      }

      const top = count || 10;
      const target = (folder || "inbox").trim();
      const base =
        target.toLowerCase() === "all"
          ? "/me/messages"
          : `/me/mailFolders/${encodeURIComponent(target)}/messages`;
      const path = `${base}?$top=${top}&$select=${MESSAGE_SELECT}&$orderby=receivedDateTime%20desc`;

      const res = await graphGet(token, path);
      const body = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Graph API error (${res.status}): ${body}` }], isError: true };
      }
      const items = JSON.parse(body).value || [];
      if (items.length === 0) {
        return { content: [{ type: "text", text: `No emails found in "${target}".` }] };
      }
      const list = items.map(formatMessage).join("\n\n");
      return { content: [{ type: "text", text: `${items.length} most recent in "${target}":\n\n${list}` }] };
    }
  );

  server.tool(
    "search_emails",
    "Searches the mailbox for emails matching a query (matches subject, sender, and body). Reads only — sends and changes nothing.",
    {
      query: z.string().min(1).describe("Search text, e.g. a keyword, sender name, or 'from:alice@example.com'."),
      count: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10, max 50)."),
    },
    async ({ query, count }, extra) => {
      const token = extractBearer(extra);
      if (!token) {
        return { content: [{ type: "text", text: "No access token available — reconnect the connector." }], isError: true };
      }

      const top = count || 10;
      // $search cannot be combined with $orderby; results come back by relevance.
      const path = `/me/messages?$search="${encodeURIComponent(query)}"&$top=${top}&$select=${MESSAGE_SELECT}`;

      const res = await graphGet(token, path, { ConsistencyLevel: "eventual" });
      const body = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Graph API error (${res.status}): ${body}` }], isError: true };
      }
      const items = JSON.parse(body).value || [];
      if (items.length === 0) {
        return { content: [{ type: "text", text: `No emails matched "${query}".` }] };
      }
      const list = items.map(formatMessage).join("\n\n");
      return { content: [{ type: "text", text: `${items.length} result(s) for "${query}":\n\n${list}` }] };
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
  console.log(`Public URL configured as: ${PUBLIC_URL}`);
  console.log(`PRM endpoint: ${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  console.log(`OAuth proxy: ${PUBLIC_URL}/authorize  ${PUBLIC_URL}/token`);
});
