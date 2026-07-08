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
