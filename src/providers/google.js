// Google provider adapter: OAuth exchange/refresh + Gmail send & read.
// access_type=offline + prompt=consent are REQUIRED to receive a refresh token.
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const READ = process.env.ENABLE_READ_SCOPES === "true";

function scopeString() {
  const s = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.send",
  ];
  // gmail.modify covers read + label changes + trash (everything except
  // permanent deletion); gmail.readonly kept for least-surprise read paths.
  if (READ) s.push("https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify");
  return s.join(" ");
}

export const name = "google";

export function buildAuthorizeUrl({ redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopeString(),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTHORIZE}?${p.toString()}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      ...params,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token error (${res.status}): ${data.error || "unknown"} ${data.error_description || ""}`.trim());
  }
  return data;
}

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export async function exchangeCode({ code, redirectUri }) {
  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  let email = "";
  if (data.id_token) email = decodeJwtPayload(data.id_token).email || "";
  if (!email && data.access_token) {
    const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    }).then((r) => r.json()).catch(() => ({}));
    email = info.email || "";
  }
  if (!email) throw new Error("Could not determine the mailbox address from Google.");
  if (!data.refresh_token) {
    throw new Error("Google did not return a refresh token — the app must request access_type=offline & prompt=consent, and the account must re-consent.");
  }
  return { email, refreshToken: data.refresh_token };
}

export async function refreshAccessToken(refreshToken) {
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  // Google does not rotate refresh tokens on normal refresh.
  return { accessToken: data.access_token, refreshToken: data.refresh_token || undefined };
}

function base64url(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendMail({ accessToken, from, to, subject, body }) {
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");
  const res = await fetch(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64url(raw) }),
  });
  if (res.status !== 200) {
    const t = await res.text();
    throw new Error(`Gmail send error (${res.status}): ${t.slice(0, 300)}`);
  }
}

// ── Read ─────────────────────────────────────────────────────────────────
function parseFrom(value = "") {
  const m = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { fromName: m[1].trim(), fromAddress: m[2].trim() };
  return { fromName: "", fromAddress: value.trim() };
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

async function hydrate(accessToken, ids) {
  return Promise.all(
    ids.map(async ({ id }) => {
      const p = new URLSearchParams({ format: "metadata" });
      ["Subject", "From", "Date"].forEach((h) => p.append("metadataHeaders", h));
      const res = await fetch(`${GMAIL}/messages/${id}?${p.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const m = await res.json();
      const hs = m.payload?.headers;
      const { fromName, fromAddress } = parseFrom(header(hs, "From"));
      return {
        id: m.id,
        subject: header(hs, "Subject") || "(no subject)",
        fromName,
        fromAddress,
        date: header(hs, "Date") || "",
        isRead: !(m.labelIds || []).includes("UNREAD"),
        snippet: (m.snippet || "").replace(/\s+/g, " ").trim(),
      };
    })
  ).then((arr) => arr.filter(Boolean));
}

async function listIds({ accessToken, q, top }) {
  const p = new URLSearchParams({ maxResults: String(top) });
  if (q) p.set("q", q);
  const res = await fetch(`${GMAIL}/messages?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail list error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.messages || [];
}

export async function listRecent({ accessToken, top = 10, unreadOnly = false }) {
  const q = unreadOnly ? "in:inbox is:unread" : "in:inbox";
  const ids = await listIds({ accessToken, q, top });
  return hydrate(accessToken, ids);
}

export async function getCounts({ accessToken }) {
  const res = await fetch(`${GMAIL}/labels/INBOX`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail count error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const l = await res.json();
  return { total: l.messagesTotal ?? null, unread: l.messagesUnread ?? null };
}

export async function search({ accessToken, query, top = 10 }) {
  const ids = await listIds({ accessToken, q: query, top });
  return hydrate(accessToken, ids);
}

function extractBody(payload) {
  if (!payload) return "";
  const decode = (d) => Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);
  if (payload.parts) {
    // Prefer text/plain; fall back to stripped text/html.
    const plain = payload.parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    if (plain) return decode(plain.body.data);
    const html = payload.parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    if (html) return decode(html.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

export async function getMessage({ accessToken, id }) {
  const res = await fetch(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail message error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const m = await res.json();
  const hs = m.payload?.headers;
  const { fromName, fromAddress } = parseFrom(header(hs, "From"));
  return {
    id: m.id,
    subject: header(hs, "Subject") || "(no subject)",
    fromName,
    fromAddress,
    date: header(hs, "Date") || "",
    isRead: !(m.labelIds || []).includes("UNREAD"),
    snippet: (m.snippet || "").replace(/\s+/g, " ").trim(),
    body: extractBody(m.payload),
  };
}

// ── Actions (require gmail.modify; reply/forward also use gmail.send) ──────
// Fetch the headers needed for correct threading.
async function threadContext(accessToken, id) {
  const p = new URLSearchParams({ format: "metadata" });
  ["Subject", "From", "Reply-To", "Message-ID", "References"].forEach((h) => p.append("metadataHeaders", h));
  const res = await fetch(`${GMAIL}/messages/${encodeURIComponent(id)}?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail message error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const m = await res.json();
  const hs = m.payload?.headers;
  return {
    threadId: m.threadId,
    subject: header(hs, "Subject") || "",
    from: header(hs, "Reply-To") || header(hs, "From") || "",
    messageId: header(hs, "Message-ID") || "",
    references: header(hs, "References") || "",
  };
}

async function sendRaw(accessToken, raw, threadId) {
  const body = threadId ? { raw: base64url(raw), threadId } : { raw: base64url(raw) };
  const res = await fetch(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`Gmail send error (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

export async function replyMessage({ accessToken, id, comment, from }) {
  const ctx = await threadContext(accessToken, id);
  const subject = /^re:/i.test(ctx.subject) ? ctx.subject : `Re: ${ctx.subject}`;
  const raw = [
    `From: ${from}`,
    `To: ${ctx.from}`,
    `Subject: ${subject}`,
    ctx.messageId ? `In-Reply-To: ${ctx.messageId}` : null,
    ctx.messageId ? `References: ${[ctx.references, ctx.messageId].filter(Boolean).join(" ")}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    comment,
  ].filter((l) => l !== null).join("\r\n");
  await sendRaw(accessToken, raw, ctx.threadId);
}

export async function forwardMessage({ accessToken, id, to, comment, from }) {
  const original = await getMessage({ accessToken, id });
  const subject = /^fwd?:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`;
  const forwarded = [
    comment || "",
    "",
    "---------- Forwarded message ----------",
    `From: ${original.fromName ? `${original.fromName} <${original.fromAddress}>` : original.fromAddress}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    "",
    original.body || original.snippet || "",
  ].join("\r\n");
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    forwarded,
  ].join("\r\n");
  await sendRaw(accessToken, raw);
}

export async function setRead({ accessToken, id, read }) {
  const body = read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] };
  const res = await fetch(`${GMAIL}/messages/${encodeURIComponent(id)}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gmail mark error (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// Soft delete — moves to Trash (recoverable), never a permanent purge.
export async function trashMessage({ accessToken, id }) {
  const res = await fetch(`${GMAIL}/messages/${encodeURIComponent(id)}/trash`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail delete error (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
