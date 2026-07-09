# Platform Notes — connecting this connector to Claude and ChatGPT

The **same** MCP server (`<PUBLIC_URL>/mcp`) works with both platforms. Nothing
in the server changes between them — only the setup clicks below differ. Mailbox
enrollment is always done once at `<PUBLIC_URL>/enroll`, independent of platform.

> Prerequisite for BOTH: the server must be reachable at a **public HTTPS** URL
> (not localhost/VPN), and `OPERATOR_AUTH_ENABLED=true` with a working operator
> authorization server (Section 3.3 of the spec) before connecting real mailboxes.

---

## Claude

1. **Individual (Pro/Max):** Settings → **Connectors** → **Add custom connector**.
   - **URL:** `<PUBLIC_URL>/mcp`
   - If your operator authorization server supports **DCR/CIMD** (e.g. Auth0 with
     Dynamic Client Registration on), leave Client ID/Secret blank.
   - If it needs a **pre-registered client**, put the Client ID/Secret in
     **Advanced settings**.
   - **Connect** → you'll be sent through the operator OAuth sign-in → consent.
2. **Team/Enterprise:** an Owner adds it under **Organization settings →
   Connectors**; members then click **Connect** individually.
3. **Per chat:** enable it via the **+** (Connectors) menu.
4. Claude asks permission before each tool call — approve `send_email` sends.

## ChatGPT

1. **Plan gate (important):** write-capable custom connectors require
   **Business / Enterprise / Edu**. On **Plus/Pro** custom connectors are
   read-only, so `send_email` will not run there.
2. **Admin enables Developer Mode:** Workspace **Settings → Connectors** (or
   Apps & Connectors) → enable **Developer mode / custom MCP connectors**.
3. **Add the connector:** Settings → Connectors → **Create / Add custom
   connector** → paste `<PUBLIC_URL>/mcp` → **Authentication = OAuth** → **Scan
   tools** → complete the operator OAuth sign-in → **Create**.
   - It appears as a Dev draft; **publish** it to the workspace to use it.
4. **Use it in a chat:** enable the connector; ChatGPT confirms each tool call
   before running it.
5. ChatGPT validates the operator token strictly (signature / iss / aud / exp /
   scope) — the Phase 6 middleware already satisfies this. No server change.

---

## Client registration cheat-sheet

| Your operator AS supports… | Claude | ChatGPT |
|---|---|---|
| **DCR** (recommended, e.g. Auth0) | leave client blank; self-registers | leave client blank; self-registers |
| **CIMD** | supported | supported |
| **Pre-registered client only** | paste Client ID/Secret in Advanced settings | enter client credentials during setup |

Enable **DCR** in your IdP and neither platform needs manual per-platform client
setup — that's what keeps this config-only.

---

## Shared truths (apply to both)

- Server must be public **HTTPS**, reachable from the platform's cloud.
- Same `/mcp` URL, same RFC 9728 discovery, same tools on both platforms.
- Enroll each mailbox **once** at `<PUBLIC_URL>/enroll` (Microsoft or Google).
- The `from` address on `send_email` must exactly match an enrolled mailbox.
- Read tools (`check_inbox`, `list_recent_emails`, `search_emails`, `read_email`)
  work across all mailboxes when you don't name one, or a single mailbox when you
  do — say "all my inboxes" or name an address.
- Switching platforms is configuration only; the server does not change.

---

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 loop on connect (either platform) | PRM / JWKS / audience mismatch | `OPERATOR_AUDIENCE` must equal `<PUBLIC_URL>/mcp`; check `OPERATOR_ISSUER` and that JWKS is reachable |
| ChatGPT has no "Add custom connector" | Developer Mode off or wrong plan | Admin enables Developer Mode; use Business/Enterprise/Edu for write tools |
| ChatGPT connects but won't send | Plus/Pro read-only limitation | Use a Business/Enterprise/Edu workspace |
| Client fails to register | AS lacks DCR/CIMD | Enable DCR, or pre-register a client and paste its ID/secret |
| "mailbox not enrolled" on send | `from` not enrolled / typo | Enroll at `/enroll`; match the address exactly (lookups are lowercased) |
| Read/send says "authorization expired" | Refresh token dead/revoked (Gmail testing = 7-day expiry) | Re-enroll that mailbox at `/enroll` |
