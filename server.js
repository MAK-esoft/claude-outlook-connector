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
  console.log(`Public URL configured as: ${PUBLIC_URL}`);
  console.log(`PRM endpoint: ${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  console.log(`OAuth proxy: ${PUBLIC_URL}/authorize  ${PUBLIC_URL}/token`);
});
