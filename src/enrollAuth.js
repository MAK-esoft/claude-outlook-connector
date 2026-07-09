// Login for the enrollment portal — Auth0 authorization-code flow + a signed
// HttpOnly session cookie. Uses the SAME Auth0 tenant as operator auth, so a
// person logs in with one identity everywhere: here (to enroll mailboxes) and
// in Claude/ChatGPT (to use them). No extra dependencies: HMAC-signed cookie
// via node:crypto, id_token verified against Auth0's JWKS via jose.
import crypto from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const COOKIE = "enroll_session";
const SESSION_TTL_S = 7 * 24 * 3600; // 7 days

const cfg = () => ({
  domain: (process.env.OPERATOR_ISSUER || "").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  clientId: process.env.AUTH0_CLIENT_ID || "",
  clientSecret: process.env.AUTH0_CLIENT_SECRET || "",
  publicUrl: process.env.PUBLIC_URL || "",
});

export function loginEnabled() {
  const c = cfg();
  return Boolean(c.domain && c.clientId && c.clientSecret);
}

// ── Signed cookie session ──────────────────────────────────────────────────
function secret() {
  // Reuse existing secrets — no new required env var.
  return process.env.AUTH0_CLIENT_SECRET || process.env.VAULT_ENCRYPTION_KEY || "dev-secret";
}
function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}
function encodeSession(data) {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${body}.${sign(body)}`;
}
function decodeSession(raw) {
  if (!raw || !raw.includes(".")) return null;
  const [body, mac] = raw.split(".");
  const expected = sign(body);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.exp || Date.now() / 1000 > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}
function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The logged-in enrollment user ({ email }) or null. */
export function sessionUser(req) {
  const data = decodeSession(readCookie(req, COOKIE));
  return data?.email ? { email: data.email } : null;
}

export function setSession(res, email) {
  const value = encodeSession({ email: email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S });
  res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${process.env.PUBLIC_URL?.startsWith("https") ? "; Secure" : ""}`);
}

export function clearSession(res) {
  res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

// ── Auth0 authorization-code flow ─────────────────────────────────────────
// state -> expiry (10 min) for CSRF protection.
const pendingStates = new Map();
function newLoginState() {
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}
function takeLoginState(state) {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return exp && Date.now() <= exp;
}

export function loginRedirectUrl() {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: `${c.publicUrl}/enroll/auth/callback`,
    scope: "openid email profile",
    state: newLoginState(),
  });
  return `https://${c.domain}/authorize?${p.toString()}`;
}

let _jwks = null;
function jwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(`https://${cfg().domain}/.well-known/jwks.json`));
  return _jwks;
}

/** Exchange the callback code, verify the id_token, return { email }. */
export async function completeLogin({ code, state }) {
  const c = cfg();
  if (!takeLoginState(String(state || ""))) throw new Error("Login session expired — please try again.");
  const res = await fetch(`https://${c.domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code: String(code),
      redirect_uri: `${c.publicUrl}/enroll/auth/callback`,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    throw new Error(`Auth0 login failed (${res.status}): ${data.error_description || data.error || "no id_token"}`);
  }
  const { payload } = await jwtVerify(data.id_token, jwks(), {
    issuer: process.env.OPERATOR_ISSUER,
    audience: c.clientId,
  });
  const email = String(payload.email || "").toLowerCase();
  if (!email) throw new Error("Auth0 did not return an email for this account.");
  return { email };
}
