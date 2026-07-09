// Operator auth (Layer A, Phase 6) — platform-agnostic Express middleware for
// /mcp. Validates the bearer JWT the AI platform (Claude OR ChatGPT) sends on
// behalf of the human operator: signature via JWKS, iss, aud, exp/nbf, scope,
// then an email allowlist. Identical for every platform.
import { createRemoteJWKSet, jwtVerify } from "jose";

const allow = (process.env.OPERATOR_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Lazily built so a missing OPERATOR_JWKS_URL (dev, auth disabled) doesn't throw
// at import time.
let _jwks = null;
function jwks() {
  if (!_jwks) {
    if (!process.env.OPERATOR_JWKS_URL) throw new Error("OPERATOR_JWKS_URL is not set");
    _jwks = createRemoteJWKSet(new URL(process.env.OPERATOR_JWKS_URL));
  }
  return _jwks;
}

function unauthorized(res, error = "unauthorized") {
  return res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${process.env.PUBLIC_URL}/.well-known/oauth-protected-resource"`
    )
    .json({ error });
}

// ── Optional defense-in-depth: ingress IP allowlist (CIDR, IPv4/IPv6) ──────
function ipToBig(ip) {
  if (ip.includes(":")) {
    // Expand IPv6 to a BigInt.
    let [head, tail] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const fill = new Array(8 - h.length - t.length).fill("0");
    const parts = [...h, ...fill, ...t].map((x) => parseInt(x || "0", 16));
    return parts.reduce((acc, p) => (acc << 16n) + BigInt(p), 0n);
  }
  return ip.split(".").reduce((acc, p) => (acc << 8n) + BigInt(parseInt(p, 10)), 0n);
}
function inCidr(ip, cidr) {
  try {
    const [base, bitsStr] = cidr.trim().split("/");
    const bits = BigInt(bitsStr);
    const total = base.includes(":") ? 128n : 32n;
    const mask = ((1n << bits) - 1n) << (total - bits);
    return (ipToBig(ip) & mask) === (ipToBig(base) & mask);
  } catch {
    return false;
  }
}
function ipAllowed(req) {
  const list = (process.env.INGRESS_IP_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true; // not configured → no restriction
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "").replace(/^::ffff:/, "").trim();
  return list.some((cidr) => inCidr(ip, cidr));
}

export async function requireOperator(req, res, next) {
  if (process.env.OPERATOR_AUTH_ENABLED !== "true") return next(); // dev-only bypass; startup warns

  if (!ipAllowed(req)) return res.status(403).json({ error: "ingress_not_allowed" });

  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return unauthorized(res);

  try {
    const { payload } = await jwtVerify(h.slice(7), jwks(), {
      issuer: process.env.OPERATOR_ISSUER,
      audience: process.env.OPERATOR_AUDIENCE,
    });
    const requiredScope = process.env.OPERATOR_REQUIRED_SCOPE;
    if (requiredScope) {
      const scopes = String(payload.scope || payload.scp || "").split(" ").filter(Boolean);
      if (!scopes.includes(requiredScope)) return res.status(403).json({ error: "insufficient_scope" });
    }
    const email = String(payload.email || payload.preferred_username || "").toLowerCase();
    if (allow.length && !allow.includes(email)) return res.status(403).json({ error: "operator_not_allowed" });
    req.operator = { email: email || "(unknown)" };
    return next();
  } catch {
    // Never echo the token or internal error detail.
    return res
      .status(401)
      .set("WWW-Authenticate", `Bearer error="invalid_token"`)
      .json({ error: "invalid_token" });
  }
}
