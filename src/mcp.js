// MCP server factory (Phase 5). Platform-neutral: NO per-platform branching.
// Tools:
//   send:  list_accounts, preview_email, send_email
//   read:  check_inbox, list_recent_emails, search_emails, read_email
// Read tools accept an optional `account`; omit it to act across ALL enrolled
// mailboxes collectively, or pass one address to scope to a single mailbox.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProvider } from "./providers/index.js";
import { listAccounts, getAccount, getRefreshToken, putAccount, DEV_OWNER } from "./vault.js";

const READ_ENABLED = process.env.ENABLE_READ_SCOPES === "true";
const PUB = () => process.env.PUBLIC_URL || "";

function ok(text) {
  return { content: [{ type: "text", text }] };
}
function err(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// Mint a fresh access token for an enrolled mailbox, persisting rotated refresh
// tokens. Returns { provider, providerName, accessToken } or { error }.
async function freshToken(email, owner) {
  const account = getAccount(email, owner);
  if (!account) {
    return { error: `I couldn't find an enrolled mailbox for "${email}". You can add it at ${PUB()}/enroll, then try again.` };
  }
  const provider = getProvider(account.provider);
  const refreshToken = getRefreshToken(email, owner);
  let refreshed;
  try {
    refreshed = await provider.refreshAccessToken(refreshToken);
  } catch {
    return {
      error: `The authorization for ${email} has expired or been revoked, so I can't act on it right now. Please re-enroll that mailbox at ${PUB()}/enroll and I'll be able to continue.`,
    };
  }
  if (refreshed.refreshToken) {
    putAccount({ owner, email, provider: account.provider, label: account.label, refreshToken: refreshed.refreshToken });
  }
  return { provider, providerName: account.provider, accessToken: refreshed.accessToken };
}

// Resolve which accounts a read tool should touch: a specific one, or all.
function resolveTargets(account, owner) {
  const all = listAccounts(owner);
  if (account && account.trim()) {
    const match = all.find((a) => a.email === account.trim().toLowerCase());
    return match ? [match] : [];
  }
  return all;
}

function statusDot(isRead) {
  return isRead ? "○ read" : "● unread";
}

function renderCard(m, showAccount) {
  const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress || "(unknown sender)";
  const meta = [who, m.date, statusDot(m.isRead)];
  if (showAccount && m._account) meta.push(`📬 ${m._account}`);
  const lines = [`**${m.subject}**`, `_${meta.join("  ·  ")}_`];
  if (m.snippet) lines.push(`> ${m.snippet}`);
  if (m.id) lines.push(`\`ref: ${m.id}\``);
  return lines.join("\n");
}

function renderList(messages, showAccount) {
  return messages.map((m) => renderCard(m, showAccount)).join("\n\n---\n\n");
}

// Run a read operation across targets in parallel; collect data + friendly errors.
async function gather(targets, owner, fn) {
  const settled = await Promise.allSettled(
    targets.map(async (t) => {
      const tok = await freshToken(t.email, owner);
      if (tok.error) throw new Error(tok.error);
      const data = await fn(t, tok);
      return { email: t.email, provider: t.provider, data };
    })
  );
  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(s.value);
    else errors.push({ email: targets[i].email, message: s.reason.message });
  });
  return { results, errors };
}

function errorFooter(errors) {
  if (!errors.length) return "";
  const lines = errors.map((e) => `- ${e.email}: ${e.message}`);
  return `\n\n---\n\n⚠️ I couldn't reach ${errors.length} mailbox(es):\n${lines.join("\n")}`;
}

export function buildServer(operator) {
  // All vault access below is scoped to this operator's identity — one person's
  // mailboxes are never visible to another operator.
  const owner = (operator?.email || DEV_OWNER).toLowerCase();
  const server = new McpServer({ name: "multi-account-mail-connector", version: "2.0.0" });

  // ── list_accounts ────────────────────────────────────────────────────
  server.tool(
    "list_accounts",
    "Lists the email mailboxes enrolled in this connector that can be used to send or read mail. Call this when the user hasn't named a specific 'from' address, then present the options warmly and ask which one they'd like to use.",
    {},
    async () => {
      const accounts = listAccounts(owner);
      if (!accounts.length) {
        return ok(`There are no mailboxes enrolled yet. You can add one — Microsoft or Google — at ${PUB()}/enroll, and then I can send and check mail for it.`);
      }
      const rows = accounts.map((a) => `- **${a.email}**  ·  _${a.provider}_${a.label && a.label !== a.email ? `  ·  ${a.label}` : ""}`);
      return ok(`Here are the mailboxes I can work with:\n\n${rows.join("\n")}\n\nJust tell me which one to use (or say "all" to act across every mailbox for reading).`);
    }
  );

  // ── preview_email ────────────────────────────────────────────────────
  server.tool(
    "preview_email",
    "Formats an email draft for the user to review WITHOUT sending anything. Always call this before send_email so the user can confirm the exact content and sender. Present the draft nicely and ask for confirmation.",
    {
      from: z.string().email().describe("The enrolled sender mailbox to send from"),
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text (plain text)"),
    },
    async ({ from, to, subject, body }) => {
      const account = getAccount(from, owner);
      if (!account) {
        return err(`I don't have "${from}" enrolled yet, so I can't draft from it. You can add it at ${PUB()}/enroll, or pick one of your enrolled addresses instead.`);
      }
      return ok(
        `Here's your draft — nothing has been sent yet:\n\n` +
          `**From:** ${from} _(${account.provider})_\n` +
          `**To:** ${to}\n` +
          `**Subject:** ${subject}\n\n` +
          `${body}\n\n` +
          `If this looks right, just say the word and I'll send it.`
      );
    }
  );

  // ── send_email ───────────────────────────────────────────────────────
  server.tool(
    "send_email",
    "Sends an email from one of the enrolled mailboxes. Only sends when confirmed=true. If not confirmed, it returns a reminder to get the user's explicit approval first. Routes automatically to the correct provider (Microsoft or Google) based on how the mailbox was enrolled.",
    {
      from: z.string().email().describe("The enrolled sender mailbox to send from (must match an enrolled address exactly)"),
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text (plain text)"),
      confirmed: z.boolean().describe("Must be true. Set only after the user has explicitly approved sending this exact draft."),
    },
    async ({ from, to, subject, body, confirmed }) => {
      if (confirmed !== true) {
        return ok(`I haven't sent anything yet — I'd like your explicit go-ahead first. Here's what I'm about to send:\n\n**From:** ${from}\n**To:** ${to}\n**Subject:** ${subject}\n\n${body}\n\nShall I send it?`);
      }
      const tok = await freshToken(from, owner);
      if (tok.error) return err(tok.error);
      try {
        await tok.provider.sendMail({ accessToken: tok.accessToken, from, to, subject, body });
      } catch (e) {
        return err(`I wasn't able to send that one. The provider reported: ${e.message}. Nothing was sent — want me to try again?`);
      }
      return ok(`✅ Done — your email to **${to}** has been sent from **${from}** _(${tok.providerName})_. Subject: "${subject}". A copy has been saved to that mailbox's Sent folder.`);
    }
  );

  if (!READ_ENABLED) return server;

  // ── check_inbox ──────────────────────────────────────────────────────
  server.tool(
    "check_inbox",
    "Reports how many messages are in the inbox and how many are unread, for one mailbox or (if no account given) all enrolled mailboxes collectively. Present the numbers in a friendly one-or-two sentence summary.",
    {
      account: z.string().optional().describe("Specific enrolled mailbox to check. Omit to summarize all enrolled mailboxes together."),
    },
    async ({ account }) => {
      const targets = resolveTargets(account, owner);
      if (!targets.length) return err(account ? `"${account}" isn't enrolled. Try ${PUB()}/enroll or pick an enrolled address.` : `No mailboxes are enrolled yet — add one at ${PUB()}/enroll.`);
      const { results, errors } = await gather(targets, owner, async (t, tok) => tok.provider.getCounts({ accessToken: tok.accessToken }));
      if (!results.length) return err(`I couldn't read any inboxes right now.${errorFooter(errors)}`);
      const totalUnread = results.reduce((n, r) => n + (r.data.unread || 0), 0);
      const rows = results.map((r) => `- **${r.email}** _(${r.provider})_: ${r.data.unread ?? "?"} unread of ${r.data.total ?? "?"} total`);
      const header = results.length > 1
        ? `Across your ${results.length} mailboxes you have **${totalUnread} unread** message(s):`
        : `Here's where **${results[0].email}** stands:`;
      return ok(`${header}\n\n${rows.join("\n")}${errorFooter(errors)}`);
    }
  );

  // ── list_recent_emails ───────────────────────────────────────────────
  server.tool(
    "list_recent_emails",
    "Lists the most recent emails — for one mailbox or (if no account given) merged across all enrolled mailboxes, newest first. Reads only; never sends. Present the result as clean cards, and offer to open or reply to any of them.",
    {
      account: z.string().optional().describe("Specific enrolled mailbox. Omit to merge recent mail across all mailboxes."),
      count: z.number().int().min(1).max(50).optional().describe("How many messages to return (default 10, max 50)."),
      unread_only: z.boolean().optional().describe("If true, only unread messages."),
    },
    async ({ account, count, unread_only }) => {
      const targets = resolveTargets(account, owner);
      if (!targets.length) return err(account ? `"${account}" isn't enrolled.` : `No mailboxes are enrolled yet — add one at ${PUB()}/enroll.`);
      const top = count || 10;
      const { results, errors } = await gather(targets, owner, async (t, tok) =>
        tok.provider.listRecent({ accessToken: tok.accessToken, top, unreadOnly: !!unread_only })
      );
      let messages = results.flatMap((r) => r.data.map((m) => ({ ...m, _account: r.email })));
      messages.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      messages = messages.slice(0, top);
      if (!messages.length) return ok(`No ${unread_only ? "unread " : ""}emails found${account ? ` in ${account}` : ""}.${errorFooter(errors)}`);
      const multi = targets.length > 1;
      const header = `Here ${messages.length === 1 ? "is" : "are"} the ${messages.length} most recent ${unread_only ? "unread " : ""}message(s)${multi ? " across your mailboxes" : ` in ${results[0]?.email || account}`}:`;
      return ok(`${header}\n\n${renderList(messages, multi)}${errorFooter(errors)}`);
    }
  );

  // ── search_emails ────────────────────────────────────────────────────
  server.tool(
    "search_emails",
    "Searches mail by keyword, sender, or phrase — in one mailbox or across all enrolled mailboxes. Reads only. Present matches as cards and summarize what was found.",
    {
      query: z.string().min(1).describe("Search text (keyword, sender, or phrase)."),
      account: z.string().optional().describe("Specific enrolled mailbox. Omit to search all mailboxes."),
      count: z.number().int().min(1).max(50).optional().describe("Max results per mailbox (default 10)."),
    },
    async ({ query, account, count }) => {
      const targets = resolveTargets(account, owner);
      if (!targets.length) return err(account ? `"${account}" isn't enrolled.` : `No mailboxes are enrolled yet — add one at ${PUB()}/enroll.`);
      const top = count || 10;
      const { results, errors } = await gather(targets, owner, async (t, tok) =>
        tok.provider.search({ accessToken: tok.accessToken, query, top })
      );
      let messages = results.flatMap((r) => r.data.map((m) => ({ ...m, _account: r.email })));
      messages.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      if (!messages.length) return ok(`I searched ${targets.length > 1 ? "all your mailboxes" : results[0]?.email || account} but found nothing matching "${query}".${errorFooter(errors)}`);
      const multi = targets.length > 1;
      return ok(`I found ${messages.length} message(s) matching "${query}":\n\n${renderList(messages, multi)}${errorFooter(errors)}`);
    }
  );

  // ── read_email ───────────────────────────────────────────────────────
  server.tool(
    "read_email",
    "Opens the full body of a single email by its ref id (from list_recent_emails or search_emails) in a specific mailbox. Reads only. Present the message clearly and offer to help reply.",
    {
      account: z.string().email().describe("The enrolled mailbox the message belongs to."),
      ref: z.string().min(1).describe("The message ref id shown by list_recent_emails / search_emails."),
    },
    async ({ account, ref }) => {
      const targets = resolveTargets(account, owner);
      if (!targets.length) return err(`"${account}" isn't an enrolled mailbox.`);
      const tok = await freshToken(account, owner);
      if (tok.error) return err(tok.error);
      let m;
      try {
        m = await tok.provider.getMessage({ accessToken: tok.accessToken, id: ref });
      } catch (e) {
        return err(`I couldn't open that message: ${e.message}`);
      }
      const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
      return ok(
        `**${m.subject}**\n` +
          `_From ${who}  ·  ${m.date}  ·  ${statusDot(m.isRead)}  ·  📬 ${account}_\n\n` +
          `${(m.body || m.snippet || "(no content)").trim()}\n\n` +
          `Would you like me to draft a reply?`
      );
    }
  );

  // ── reply_email ──────────────────────────────────────────────────────
  server.tool(
    "reply_email",
    "Replies to an existing email in its thread, from the mailbox that received it. Only sends when confirmed=true — always show the user the reply text and get their approval first.",
    {
      account: z.string().email().describe("The enrolled mailbox the original message is in (the reply is sent from it)."),
      ref: z.string().min(1).describe("The message ref id (from list_recent_emails / search_emails / read_email)."),
      body: z.string().describe("The reply text (plain text)."),
      confirmed: z.boolean().describe("Must be true. Set only after the user has explicitly approved this exact reply."),
    },
    async ({ account, ref, body, confirmed }) => {
      if (confirmed !== true) {
        return ok(`Here's the reply I'm ready to send from **${account}** — nothing has gone out yet:\n\n${body}\n\nShall I send it?`);
      }
      const tok = await freshToken(account, owner);
      if (tok.error) return err(tok.error);
      try {
        await tok.provider.replyMessage({ accessToken: tok.accessToken, id: ref, comment: body, from: account });
      } catch (e) {
        return err(`I couldn't send that reply: ${e.message}. Nothing was sent.`);
      }
      return ok(`✅ Reply sent from **${account}**, in the same thread as the original message.`);
    }
  );

  // ── forward_email ────────────────────────────────────────────────────
  server.tool(
    "forward_email",
    "Forwards an existing email to a new recipient, optionally with a note on top. Only sends when confirmed=true — get the user's approval first.",
    {
      account: z.string().email().describe("The enrolled mailbox the original message is in."),
      ref: z.string().min(1).describe("The message ref id (from list_recent_emails / search_emails / read_email)."),
      to: z.string().email().describe("Who to forward it to."),
      note: z.string().optional().describe("Optional note to add above the forwarded message."),
      confirmed: z.boolean().describe("Must be true. Set only after the user has explicitly approved forwarding."),
    },
    async ({ account, ref, to, note, confirmed }) => {
      if (confirmed !== true) {
        return ok(`Ready to forward that message from **${account}** to **${to}**${note ? ` with your note:\n\n${note}` : ""}.\n\nNothing has been sent yet — shall I go ahead?`);
      }
      const tok = await freshToken(account, owner);
      if (tok.error) return err(tok.error);
      try {
        await tok.provider.forwardMessage({ accessToken: tok.accessToken, id: ref, to, comment: note || "", from: account });
      } catch (e) {
        return err(`I couldn't forward that message: ${e.message}. Nothing was sent.`);
      }
      return ok(`✅ Forwarded to **${to}** from **${account}**.`);
    }
  );

  // ── mark_email ───────────────────────────────────────────────────────
  server.tool(
    "mark_email",
    "Marks an email as read or unread. Safe, reversible action.",
    {
      account: z.string().email().describe("The enrolled mailbox the message is in."),
      ref: z.string().min(1).describe("The message ref id."),
      read: z.boolean().describe("true = mark as read, false = mark as unread."),
    },
    async ({ account, ref, read }) => {
      const tok = await freshToken(account, owner);
      if (tok.error) return err(tok.error);
      try {
        await tok.provider.setRead({ accessToken: tok.accessToken, id: ref, read });
      } catch (e) {
        return err(`I couldn't update that message: ${e.message}`);
      }
      return ok(`Done — marked as ${read ? "read ○" : "unread ●"} in **${account}**.`);
    }
  );

  // ── delete_email ─────────────────────────────────────────────────────
  server.tool(
    "delete_email",
    "Moves an email to the Trash / Deleted Items folder (recoverable — never a permanent delete). Only acts when confirmed=true; confirm with the user first, naming the message.",
    {
      account: z.string().email().describe("The enrolled mailbox the message is in."),
      ref: z.string().min(1).describe("The message ref id."),
      confirmed: z.boolean().describe("Must be true. Set only after the user has explicitly approved deleting this message."),
    },
    async ({ account, ref, confirmed }) => {
      if (confirmed !== true) {
        return ok(`I'll move that message in **${account}** to Trash (it stays recoverable there). Just confirm and I'll do it.`);
      }
      const tok = await freshToken(account, owner);
      if (tok.error) return err(tok.error);
      try {
        await tok.provider.trashMessage({ accessToken: tok.accessToken, id: ref });
      } catch (e) {
        return err(`I couldn't delete that message: ${e.message}`);
      }
      return ok(`🗑️ Moved to Trash in **${account}**. It can still be recovered from there if needed.`);
    }
  );

  return server;
}
