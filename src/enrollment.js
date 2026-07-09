// Enrollment portal — MULTI-USER. Each visitor signs in with Auth0 first; the
// mailboxes they enroll are tagged with their identity (owner) and only their
// own mailboxes are ever shown or usable by them (here and over MCP).
// Plain HTML, no framework.
import express from "express";
import crypto from "crypto";
import { getProvider, PROVIDER_NAMES } from "./providers/index.js";
import { listAccounts, putAccount, deleteAccount, DEV_OWNER } from "./vault.js";
import { guessProvider } from "./mx.js";
import {
  loginEnabled,
  sessionUser,
  setSession,
  clearSession,
  loginRedirectUrl,
  completeLogin,
} from "./enrollAuth.js";

// Provider-OAuth state -> { provider, owner, expiresAt } (10-min TTL).
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function newState(provider, owner) {
  const state = crypto.randomBytes(24).toString("hex");
  stateStore.set(state, { provider, owner, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}
function takeState(state) {
  const entry = stateStore.get(state);
  if (!entry) return null;
  stateStore.delete(state);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

function redirectUri(provider) {
  return `${process.env.PUBLIC_URL}/enroll/callback/${provider}`;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.5}
  h1{font-size:1.5rem} h2{font-size:1.05rem;margin-top:2rem}
  .card{border:1px solid #8883;border-radius:12px;padding:16px;margin:12px 0}
  .row{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .btn{display:inline-block;padding:10px 16px;border-radius:10px;border:1px solid #8886;
       text-decoration:none;font-weight:600;cursor:pointer;background:transparent;color:inherit}
  .btn.ms{border-color:#0067b8} .btn.g{border-color:#ea4335} .btn.primary{border-color:#6c5ce7}
  .muted{opacity:.7;font-size:.9rem} .pill{font-size:.75rem;border:1px solid #8886;border-radius:999px;padding:2px 8px}
  form.inline{display:inline} input[type=email]{padding:8px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit}
  .ok{color:#1a7f37} .err{color:#cf222e}
  .topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
</style></head><body>${bodyHtml}</body></html>`;
}

// Resolve the acting user. When Auth0 login isn't configured (early local dev),
// fall back to the shared DEV owner so the portal still works for smoke tests.
function currentUser(req) {
  if (!loginEnabled()) return { email: DEV_OWNER, dev: true };
  return sessionUser(req);
}

export function createEnrollmentRouter() {
  const router = express.Router();

  // ── Auth0 login round-trip ──────────────────────────────────────────
  router.get("/login", (req, res) => {
    if (!loginEnabled()) return res.redirect("/enroll");
    res.redirect(loginRedirectUrl());
  });

  router.get("/auth/callback", async (req, res) => {
    try {
      const { email } = await completeLogin({ code: req.query.code, state: req.query.state });
      setSession(res, email);
      res.redirect("/enroll");
    } catch (e) {
      res.status(400).send(page("Sign-in failed", `<h1 class="err">Sign-in failed</h1><p>${esc(e.message)}</p><p><a class="btn" href="/enroll/login">Try again</a></p>`));
    }
  });

  router.get("/logout", (req, res) => {
    clearSession(res);
    res.redirect("/enroll");
  });

  // ── Portal home ─────────────────────────────────────────────────────
  router.get("/", async (req, res) => {
    const user = currentUser(req);
    if (!user) {
      return res.send(
        page(
          "Sign in — mailbox enrollment",
          `<h1>Mailbox enrollment</h1>
           <p>Connect your own email accounts (Microsoft or Google) and use them from
           your AI assistant. Your mailboxes are visible only to you.</p>
           <p><a class="btn primary" href="/enroll/login">Sign in / create account</a></p>
           <p class="muted">You'll sign in with the same account you use when connecting
           the assistant — that's how we know which mailboxes are yours.</p>`
        )
      );
    }

    const accounts = listAccounts(user.email);
    const hintEmail = (req.query.email || "").toString().trim();
    let hint = "";
    if (hintEmail.includes("@")) {
      const p = await guessProvider(hintEmail.split("@")[1]);
      hint = p
        ? `<p class="muted">This address looks like it's hosted on <b>${esc(p)}</b> — use that button below.</p>`
        : `<p class="muted">Couldn't detect the provider automatically — pick the one that hosts this mailbox.</p>`;
    }

    const list = accounts.length
      ? accounts
          .map(
            (a) => `<div class="card row">
              <div><b>${esc(a.email)}</b><br><span class="muted">${esc(a.label)}</span></div>
              <div style="display:flex;gap:10px;align-items:center">
                <span class="pill">${esc(a.provider)}</span>
                <form class="inline" method="post" action="/enroll/remove"
                  onsubmit="return confirm('Remove ${esc(a.email)}?')">
                  <input type="hidden" name="email" value="${esc(a.email)}">
                  <button class="btn" type="submit">Remove</button>
                </form>
              </div></div>`
          )
          .join("")
      : `<p class="muted">You haven't connected any mailboxes yet. Add one below.</p>`;

    const readNote =
      process.env.ENABLE_READ_SCOPES === "true"
        ? `<p class="muted">This connector requests <b>send and read</b> access, so your AI assistant can send mail and check your inboxes.</p>`
        : `<p class="muted">This connector requests <b>send-only</b> access.</p>`;

    const who = user.dev
      ? `<span class="muted">dev mode (no login configured)</span>`
      : `<span class="muted">Signed in as <b>${esc(user.email)}</b> · <a href="/enroll/logout">Sign out</a></span>`;

    res.send(
      page(
        "Mailbox enrollment",
        `<div class="topbar"><h1>Your mailboxes</h1>${who}</div>
        ${readNote}
        ${list}
        <h2>Add a mailbox</h2>
        <form method="get" action="/enroll" style="margin-bottom:8px">
          <input type="email" name="email" placeholder="you@yourdomain.com (optional — detect provider)" value="${esc(hintEmail)}">
          <button class="btn" type="submit">Detect</button>
        </form>
        ${hint}
        <p>
          <a class="btn ms" href="/enroll/start/microsoft">Add Microsoft account</a>
          <a class="btn g" href="/enroll/start/google">Add Google account</a>
        </p>
        <p class="muted">You'll sign in with the mailbox provider and grant access. The provider you complete sign-in with is the one recorded — custom domains work either way.</p>`
      )
    );
  });

  // ── Provider OAuth ──────────────────────────────────────────────────
  router.get("/start/:provider", (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect("/enroll");
    const { provider } = req.params;
    if (!PROVIDER_NAMES.includes(provider)) return res.status(404).send(page("Not found", "<h1>Unknown provider</h1>"));
    if (!process.env.PUBLIC_URL) return res.status(500).send(page("Config error", "<h1>PUBLIC_URL is not set</h1>"));
    const state = newState(provider, user.email);
    const url = getProvider(provider).buildAuthorizeUrl({ redirectUri: redirectUri(provider), state });
    res.redirect(url);
  });

  router.get("/callback/:provider", async (req, res) => {
    const { provider } = req.params;
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res
        .status(400)
        .send(page("Enrollment failed", `<h1 class="err">Enrollment failed</h1><p>${esc(error)}: ${esc(error_description || "")}</p><p><a href="/enroll">Back</a></p>`));
    }
    const entry = takeState(String(state || ""));
    if (!entry || entry.provider !== provider) {
      return res.status(400).send(page("Enrollment failed", `<h1 class="err">Invalid or expired session</h1><p><a href="/enroll">Try again</a></p>`));
    }
    try {
      const p = getProvider(provider);
      const { email, refreshToken } = await p.exchangeCode({ code: String(code), redirectUri: redirectUri(provider) });
      putAccount({ owner: entry.owner, email, provider, label: email, refreshToken });
      res.send(
        page(
          "Mailbox enrolled",
          `<h1 class="ok">✓ ${esc(email)} connected</h1>
           <p>This mailbox (<span class="pill">${esc(provider)}</span>) is now linked to
           <b>${esc(entry.owner)}</b> and usable from your AI assistant.</p>
           <p><a class="btn" href="/enroll">Back to your mailboxes</a></p>`
        )
      );
    } catch (e) {
      res.status(400).send(page("Enrollment failed", `<h1 class="err">Enrollment failed</h1><p>${esc(e.message)}</p><p><a href="/enroll">Back</a></p>`));
    }
  });

  router.post("/remove", (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect("/enroll");
    const email = (req.body?.email || "").toString();
    if (email) deleteAccount(email, user.email); // scoped: can only remove your own
    res.redirect("/enroll");
  });

  return router;
}
