// server.js — entry point. Mounts the enrollment portal, the RFC 9728
// protected-resource metadata, and the MCP endpoint (operator-gated) on one
// Express app. Platform-neutral: the same server serves Claude and ChatGPT.
import "dotenv/config";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./src/mcp.js";
import { createEnrollmentRouter } from "./src/enrollment.js";
import { requireOperator } from "./src/operatorAuth.js";
import { countAccounts, storePath } from "./src/vault.js";
import { loginEnabled } from "./src/enrollAuth.js";

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const OPERATOR_AUTH_ENABLED = process.env.OPERATOR_AUTH_ENABLED === "true";
const READ_ENABLED = process.env.ENABLE_READ_SCOPES === "true";

if (!PUBLIC_URL) {
  console.error("PUBLIC_URL is not set — set it to your public HTTPS URL (no trailing slash) and restart.");
  process.exit(1);
}
process.env.PUBLIC_URL = PUBLIC_URL; // normalized (trailing slash stripped)

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── OAuth Protected Resource Metadata (RFC 9728) ──────────────────────────
// When operator auth is on, advertise the operator authorization server so
// both Claude and ChatGPT run the standard discovery + OAuth flow.
function protectedResourceMetadata() {
  const meta = {
    resource: `${PUBLIC_URL}/mcp`,
    bearer_methods_supported: ["header"],
  };
  if (OPERATOR_AUTH_ENABLED && process.env.OPERATOR_ISSUER) {
    meta.authorization_servers = [process.env.OPERATOR_ISSUER];
    if (process.env.OPERATOR_REQUIRED_SCOPE) meta.scopes_supported = [process.env.OPERATOR_REQUIRED_SCOPE];
  }
  return meta;
}
app.get("/.well-known/oauth-protected-resource", (req, res) => res.json(protectedResourceMetadata()));
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => res.json(protectedResourceMetadata()));

// ── Enrollment portal ─────────────────────────────────────────────────────
app.use("/enroll", createEnrollmentRouter());

// Friendly root.
app.get("/", (req, res) => {
  res.type("html").send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
     <h1>Multi-account mail connector</h1>
     <p>Enroll a mailbox at <a href="/enroll">/enroll</a>. Connect the assistant at <code>${PUBLIC_URL}/mcp</code>.</p></body>`
  );
});

// ── MCP endpoint (operator-gated, stateless streamable HTTP) ──────────────
app.post("/mcp", requireOperator, async (req, res) => {
  // req.operator (set by requireOperator) scopes every tool to the caller's
  // own enrolled mailboxes. Without operator auth (dev), the shared dev owner is used.
  const server = buildServer(req.operator);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  const accountCount = countAccounts();
  console.log("─".repeat(64));
  console.log(`  multi-account-mail-connector listening on port ${PORT}`);
  console.log(`  Public URL:      ${PUBLIC_URL}`);
  console.log(`  Enrollment:      ${PUBLIC_URL}/enroll`);
  console.log(`  PRM metadata:    ${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  console.log(`  MCP endpoint:    ${PUBLIC_URL}/mcp`);
  console.log(`  Vault store:     ${storePath()}  (${accountCount} account(s) enrolled)`);
  console.log(`  Read tools:      ${READ_ENABLED ? "ENABLED (Mail.Read / gmail.readonly)" : "disabled (send-only)"}`);
  console.log(`  Enrollment auth: ${loginEnabled() ? "ON (Auth0 login required; per-user mailboxes)" : "OFF (single shared dev owner — set AUTH0_CLIENT_ID/SECRET for multi-user)"}`);
  if (OPERATOR_AUTH_ENABLED) {
    console.log(`  Operator auth:   ON  (issuer ${process.env.OPERATOR_ISSUER || "??"})`);
  } else {
    console.log("  Operator auth:   OFF");
    console.log("  " + "!".repeat(60));
    console.log("  !! WARNING: /mcp is UNAUTHENTICATED. Anyone who finds this URL");
    console.log("  !! can send/read as every enrolled mailbox. Use THROWAWAY test");
    console.log("  !! mailboxes only, Claude-only smoke testing. Set");
    console.log("  !! OPERATOR_AUTH_ENABLED=true before any real mailbox or ChatGPT.");
    console.log("  " + "!".repeat(60));
  }
  console.log("─".repeat(64));
});
