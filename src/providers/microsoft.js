// Microsoft (Entra) provider adapter: OAuth exchange/refresh + Graph send & read.
// Refresh tokens rotate — callers must persist the newest one returned by refresh.
const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

const READ = process.env.ENABLE_READ_SCOPES === "true";

function scopeString() {
  const s = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "https://graph.microsoft.com/Mail.Send",
  ];
  if (READ) s.push("https://graph.microsoft.com/Mail.Read", "https://graph.microsoft.com/Mail.ReadWrite");
  return s.join(" ");
}

export const name = "microsoft";

export function buildAuthorizeUrl({ redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopeString(),
    state,
  });
  return `${AUTHORIZE}?${p.toString()}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID || "",
      client_secret: process.env.MS_CLIENT_SECRET || "",
      ...params,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Scrub: surface Entra's error code but never the tokens/secret.
    throw new Error(`Microsoft token error (${res.status}): ${data.error || "unknown"} ${data.error_description || ""}`.trim());
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
    scope: scopeString(),
  });
  let email = "";
  if (data.id_token) {
    const claims = decodeJwtPayload(data.id_token);
    email = claims.email || claims.preferred_username || "";
  }
  if (!email && data.access_token) {
    const me = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    }).then((r) => r.json()).catch(() => ({}));
    email = me.mail || me.userPrincipalName || "";
  }
  if (!email) throw new Error("Could not determine the mailbox address from Microsoft.");
  return { email, refreshToken: data.refresh_token };
}

export async function refreshAccessToken(refreshToken) {
  const data = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopeString(),
  });
  return { accessToken: data.access_token, refreshToken: data.refresh_token || undefined };
}

export async function sendMail({ accessToken, to, subject, body }) {
  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202) {
    const t = await res.text();
    throw new Error(`Graph sendMail error (${res.status}): ${t.slice(0, 300)}`);
  }
}

// ── Read ─────────────────────────────────────────────────────────────────
function normalize(m) {
  const ea = m.from?.emailAddress || {};
  return {
    id: m.id,
    subject: m.subject || "(no subject)",
    fromName: ea.name || "",
    fromAddress: ea.address || "",
    date: m.receivedDateTime || "",
    isRead: m.isRead !== false,
    snippet: (m.bodyPreview || "").replace(/\s+/g, " ").trim(),
    body: typeof m.body?.content === "string" ? m.body.content : undefined,
  };
}

export async function listRecent({ accessToken, top = 10, unreadOnly = false }) {
  const p = new URLSearchParams({
    $top: String(top),
    $select: "id,subject,from,receivedDateTime,isRead,bodyPreview",
    $orderby: "receivedDateTime desc",
  });
  if (unreadOnly) p.set("$filter", "isRead eq false");
  const res = await fetch(`${GRAPH}/me/messages?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Graph list error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.value || []).map(normalize);
}

export async function getCounts({ accessToken }) {
  const res = await fetch(`${GRAPH}/me/mailFolders/inbox`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Graph count error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const f = await res.json();
  return { total: f.totalItemCount ?? null, unread: f.unreadItemCount ?? null };
}

export async function search({ accessToken, query, top = 10 }) {
  const p = new URLSearchParams({
    $search: `"${query}"`,
    $top: String(top),
    $select: "id,subject,from,receivedDateTime,isRead,bodyPreview",
  });
  const res = await fetch(`${GRAPH}/me/messages?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: "eventual" },
  });
  if (!res.ok) throw new Error(`Graph search error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.value || []).map(normalize);
}

export async function getMessage({ accessToken, id }) {
  const p = new URLSearchParams({
    $select: "id,subject,from,toRecipients,receivedDateTime,isRead,body,bodyPreview",
  });
  const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Graph message error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const m = await res.json();
  const out = normalize(m);
  // Graph body may be HTML; provide plain text if contentType is text.
  if (m.body?.contentType === "html" && out.body) {
    out.body = out.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return out;
}

// ── Actions (require Mail.ReadWrite; reply/forward also use Mail.Send) ─────
export async function replyMessage({ accessToken, id, comment }) {
  const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ comment }),
  });
  if (res.status !== 202) throw new Error(`Graph reply error (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export async function forwardMessage({ accessToken, id, to, comment }) {
  const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}/forward`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      comment: comment || "",
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });
  if (res.status !== 202) throw new Error(`Graph forward error (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export async function setRead({ accessToken, id, read }) {
  const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ isRead: !!read }),
  });
  if (!res.ok) throw new Error(`Graph mark error (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// Soft delete — moves to Deleted Items (recoverable), never a permanent purge.
export async function trashMessage({ accessToken, id }) {
  const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 204) throw new Error(`Graph delete error (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
