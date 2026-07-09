// Enrollment portal — MULTI-USER. Each visitor signs in with Auth0 first; the
// mailboxes they enroll are tagged with their identity (owner) and only their
// own mailboxes are ever shown or usable by them (here and over MCP).
// Server-rendered HTML, no framework, no external assets (all CSS/SVG inline).
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

// ── Inline brand icons ─────────────────────────────────────────────────────
const ICONS = {
  microsoft: `<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`,
  google: `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
  mail: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 7 8.29 5.4a2 2 0 0 0 2.18 0L22 7"/></svg>`,
  shield: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`,
  plus: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  check: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  alert: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
  logout: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
  sparkle: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.7a2 2 0 0 0 1.27 1.27L20.8 10.9a.6.6 0 0 1 0 1.14l-5.63 1.88a2 2 0 0 0-1.27 1.27L12 20.9a.6.6 0 0 1-1.14 0l-1.88-5.63a2 2 0 0 0-1.27-1.27L2.08 12.1a.6.6 0 0 1 0-1.14l5.63-1.88a2 2 0 0 0 1.27-1.27L10.86 2a.6.6 0 0 1 1.14 0z"/></svg>`,
};

const PROVIDER_META = {
  microsoft: { label: "Microsoft", icon: ICONS.microsoft, hint: "Outlook · Hotmail · Microsoft 365" },
  google: { label: "Google", icon: ICONS.google, hint: "Gmail · Google Workspace" },
};

// ── Layout ─────────────────────────────────────────────────────────────────
function layout(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{
    --bg:#f4f5f9; --surface:#ffffff; --surface-2:#f8f9fc;
    --text:#16181d; --text-2:#5c6270; --text-3:#9aa0ae;
    --border:#e4e7ee; --border-2:#d5d9e4;
    --accent:#4f46e5; --accent-hover:#4338ca; --accent-soft:#eef0fe;
    --green:#16a34a; --green-soft:#ecfdf3;
    --red:#dc2626; --red-soft:#fef2f2;
    --shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px -12px rgba(16,24,40,.12);
    --radius:14px;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0e1015; --surface:#171a21; --surface-2:#1d2129;
      --text:#eceef2; --text-2:#a3aab8; --text-3:#6b7280;
      --border:#262b36; --border-2:#333a48;
      --accent:#6d64f5; --accent-hover:#7f77f7; --accent-soft:#232041;
      --green:#34d399; --green-soft:#0d2a1e;
      --red:#f87171; --red-soft:#2c1414;
      --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -12px rgba(0,0,0,.55);
    }
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{-webkit-text-size-adjust:100%}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;
    background:var(--bg);color:var(--text);line-height:1.55;
    min-height:100vh;display:flex;flex-direction:column;
    font-size:15px;-webkit-font-smoothing:antialiased;
  }
  header.site{
    display:flex;justify-content:space-between;align-items:center;
    padding:14px 24px;border-bottom:1px solid var(--border);
    background:var(--surface);
  }
  .brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px;letter-spacing:-.01em}
  .brand .logo{
    display:grid;place-items:center;width:32px;height:32px;border-radius:9px;
    background:linear-gradient(135deg,var(--accent),#8b5cf6);color:#fff;
  }
  .who{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--text-2)}
  .who .avatar{
    width:28px;height:28px;border-radius:50%;display:grid;place-items:center;
    background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:12px;text-transform:uppercase;
  }
  .who a{color:var(--text-2);text-decoration:none;display:inline-flex;align-items:center;gap:5px;
    padding:6px 10px;border:1px solid var(--border);border-radius:8px;transition:.15s}
  .who a:hover{color:var(--text);border-color:var(--border-2);background:var(--surface-2)}
  main{flex:1;width:100%;max-width:640px;margin:0 auto;padding:40px 20px 64px}
  h1{font-size:22px;font-weight:700;letter-spacing:-.02em}
  .sub{color:var(--text-2);margin-top:6px;font-size:14.5px}
  .section-label{
    font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;
    color:var(--text-3);margin:34px 0 10px;
  }
  .panel{
    background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
    box-shadow:var(--shadow);overflow:hidden;
  }
  .account{
    display:flex;align-items:center;gap:14px;padding:15px 18px;
  }
  .account + .account{border-top:1px solid var(--border)}
  .account .picon{
    width:38px;height:38px;border-radius:10px;display:grid;place-items:center;
    background:var(--surface-2);border:1px solid var(--border);flex-shrink:0;
  }
  .account .meta{min-width:0;flex:1}
  .account .email{font-weight:600;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .account .prov{font-size:12.5px;color:var(--text-2);margin-top:1px}
  .badge{
    display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;
    color:var(--green);background:var(--green-soft);border-radius:999px;padding:3px 9px;
  }
  .badge .dot{width:6px;height:6px;border-radius:50%;background:var(--green)}
  .iconbtn{
    display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:550;
    color:var(--text-2);background:transparent;border:1px solid var(--border);
    border-radius:8px;padding:7px 11px;cursor:pointer;transition:.15s;font-family:inherit;
  }
  .iconbtn:hover{color:var(--red);border-color:var(--red);background:var(--red-soft)}
  .providers{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:520px){.providers{grid-template-columns:1fr}}
  .provider-btn{
    display:flex;align-items:center;gap:12px;padding:15px 16px;text-decoration:none;
    background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
    color:var(--text);box-shadow:var(--shadow);transition:.15s;
  }
  .provider-btn:hover{border-color:var(--border-2);transform:translateY(-1px)}
  .provider-btn .picon{
    width:38px;height:38px;border-radius:10px;display:grid;place-items:center;
    background:var(--surface-2);border:1px solid var(--border);
  }
  .provider-btn b{display:block;font-size:14px;font-weight:650}
  .provider-btn span{display:block;font-size:12px;color:var(--text-2);margin-top:1px}
  .empty{
    padding:38px 24px;text-align:center;color:var(--text-2);
  }
  .empty .picon{
    width:46px;height:46px;border-radius:12px;display:grid;place-items:center;margin:0 auto 12px;
    background:var(--accent-soft);color:var(--accent);
  }
  .detect{display:flex;gap:10px;margin-bottom:12px}
  .detect input{
    flex:1;padding:11px 14px;font-size:14px;font-family:inherit;color:var(--text);
    background:var(--surface);border:1px solid var(--border);border-radius:10px;outline:none;transition:.15s;
  }
  .detect input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .detect button{
    padding:11px 18px;font-size:13.5px;font-weight:600;font-family:inherit;cursor:pointer;
    color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:10px;transition:.15s;
  }
  .detect button:hover{border-color:var(--border-2);background:var(--surface-2)}
  .hint{font-size:13px;color:var(--text-2);margin:2px 0 14px}
  .hint b{color:var(--text)}
  .note{
    display:flex;gap:10px;align-items:flex-start;margin-top:26px;
    font-size:12.5px;color:var(--text-2);
    background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:13px 15px;
  }
  .note svg{flex-shrink:0;margin-top:1px;color:var(--text-3)}
  .cta{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    background:var(--accent);color:#fff;font-weight:600;font-size:14.5px;
    padding:13px 26px;border-radius:11px;text-decoration:none;border:none;cursor:pointer;
    transition:.15s;box-shadow:var(--shadow);
  }
  .cta:hover{background:var(--accent-hover)}
  .hero{
    text-align:center;padding:56px 28px;
    background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);
  }
  .hero .logo{
    width:56px;height:56px;border-radius:16px;display:grid;place-items:center;margin:0 auto 20px;
    background:linear-gradient(135deg,var(--accent),#8b5cf6);color:#fff;
  }
  .hero h1{font-size:24px}
  .hero .sub{max-width:400px;margin:8px auto 26px}
  .features{display:flex;justify-content:center;gap:20px;margin-top:30px;flex-wrap:wrap}
  .features div{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-2)}
  .features svg{color:var(--green)}
  .status{
    text-align:center;padding:52px 28px;
    background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);
  }
  .status .ring{
    width:60px;height:60px;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px;
  }
  .status.good .ring{background:var(--green-soft);color:var(--green)}
  .status.bad .ring{background:var(--red-soft);color:var(--red)}
  .status h1{font-size:21px;margin-bottom:6px}
  .status p{color:var(--text-2);font-size:14px;max-width:400px;margin:0 auto 24px}
  .status .pill{
    display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;
    background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:6px 14px;margin-bottom:22px;
  }
  footer.site{
    text-align:center;padding:20px;color:var(--text-3);font-size:12px;border-top:1px solid var(--border);
  }
</style></head><body>
${content}
<footer class="site">Mail Connector · Your accounts are encrypted and visible only to you</footer>
</body></html>`;
}

function siteHeader(user) {
  const who = user && !user.dev
    ? `<div class="who">
         <span class="avatar">${esc(user.email[0] || "?")}</span>
         <span>${esc(user.email)}</span>
         <a href="/enroll/logout">${ICONS.logout} Sign out</a>
       </div>`
    : user?.dev
      ? `<div class="who"><span>dev mode</span></div>`
      : "";
  return `<header class="site">
    <div class="brand"><span class="logo">${ICONS.mail}</span> Mail Connector</div>
    ${who}
  </header>`;
}

// ── Views ──────────────────────────────────────────────────────────────────
function signInView() {
  return layout(
    "Sign in — Mail Connector",
    `${siteHeader(null)}
    <main>
      <div class="hero">
        <div class="logo">${ICONS.mail}</div>
        <h1>Your email, in your AI assistant</h1>
        <p class="sub">Connect your Outlook and Gmail accounts once, then send and
        check mail from Claude or ChatGPT — safely, with your approval on every send.</p>
        <a class="cta" href="/enroll/login">Sign in / create account</a>
        <div class="features">
          <div>${ICONS.shield} Private to you</div>
          <div>${ICONS.shield} Encrypted at rest</div>
          <div>${ICONS.sparkle} Works with Claude &amp; ChatGPT</div>
        </div>
      </div>
      <div class="note">${ICONS.shield}
        <span>Use the same account here and when connecting your AI assistant —
        that's how we know which mailboxes are yours.</span>
      </div>
    </main>`
  );
}

function mailboxesView(user, accounts, hintEmail, hintProvider) {
  const list = accounts.length
    ? accounts
        .map((a) => {
          const meta = PROVIDER_META[a.provider] || { label: a.provider, icon: ICONS.mail };
          return `<div class="account">
            <span class="picon">${meta.icon}</span>
            <div class="meta">
              <div class="email">${esc(a.email)}</div>
              <div class="prov">${esc(meta.label)}</div>
            </div>
            <span class="badge"><span class="dot"></span>Connected</span>
            <form method="post" action="/enroll/remove" onsubmit="return confirm('Disconnect ${esc(a.email)}?')">
              <input type="hidden" name="email" value="${esc(a.email)}">
              <button class="iconbtn" type="submit">${ICONS.trash} Remove</button>
            </form>
          </div>`;
        })
        .join("")
    : `<div class="empty">
         <span class="picon">${ICONS.mail}</span>
         <div style="font-weight:600;color:var(--text)">No mailboxes connected yet</div>
         <div style="font-size:13px;margin-top:3px">Add your first account below — it takes about a minute.</div>
       </div>`;

  let hint = "";
  if (hintEmail) {
    hint = hintProvider
      ? `<p class="hint">✓ <b>${esc(hintEmail)}</b> looks like it's hosted on <b>${esc(PROVIDER_META[hintProvider].label)}</b> — use that option below.</p>`
      : `<p class="hint">Couldn't auto-detect the provider for <b>${esc(hintEmail)}</b> — pick whichever hosts that mailbox.</p>`;
  }

  const providerButtons = PROVIDER_NAMES.map((p) => {
    const meta = PROVIDER_META[p];
    return `<a class="provider-btn" href="/enroll/start/${p}">
      <span class="picon">${meta.icon}</span>
      <span><b>Add ${meta.label} account</b><span>${meta.hint}</span></span>
    </a>`;
  }).join("");

  return layout(
    "Your mailboxes — Mail Connector",
    `${siteHeader(user)}
    <main>
      <h1>Your mailboxes</h1>
      <p class="sub">These accounts are available to your AI assistant. Every send
      still needs your explicit approval in the chat.</p>

      <div class="section-label">Connected accounts</div>
      <div class="panel">${list}</div>

      <div class="section-label">Add a mailbox</div>
      <form class="detect" method="get" action="/enroll">
        <input type="email" name="email" placeholder="you@yourcompany.com — optional, detects the provider" value="${esc(hintEmail || "")}">
        <button type="submit">Detect</button>
      </form>
      ${hint}
      <div class="providers">${providerButtons}</div>

      <div class="note">${ICONS.shield}
        <span>You'll sign in with the mailbox provider and approve access.
        Custom-domain addresses work too — just pick the provider that hosts them.</span>
      </div>
    </main>`
  );
}

function statusView({ good, title, message, pill, cta, ctaHref }) {
  return layout(
    title,
    `${siteHeader(null)}
    <main>
      <div class="status ${good ? "good" : "bad"}">
        <div class="ring">${good ? ICONS.check : ICONS.alert}</div>
        <h1>${esc(title)}</h1>
        ${pill ? `<div><span class="pill">${pill}</span></div>` : ""}
        <p>${message}</p>
        <a class="cta" href="${ctaHref}">${esc(cta)}</a>
      </div>
    </main>`
  );
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
      res.status(400).send(
        statusView({
          good: false,
          title: "Sign-in failed",
          message: esc(e.message),
          cta: "Try again",
          ctaHref: "/enroll/login",
        })
      );
    }
  });

  router.get("/logout", (req, res) => {
    clearSession(res);
    res.redirect("/enroll");
  });

  // ── Portal home ─────────────────────────────────────────────────────
  router.get("/", async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.send(signInView());

    const accounts = listAccounts(user.email);
    const hintEmail = (req.query.email || "").toString().trim();
    let hintProvider = null;
    if (hintEmail.includes("@")) hintProvider = await guessProvider(hintEmail.split("@")[1]);

    res.send(mailboxesView(user, accounts, hintEmail.includes("@") ? hintEmail : "", hintProvider));
  });

  // ── Provider OAuth ──────────────────────────────────────────────────
  router.get("/start/:provider", (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect("/enroll");
    const { provider } = req.params;
    if (!PROVIDER_NAMES.includes(provider)) {
      return res.status(404).send(
        statusView({ good: false, title: "Unknown provider", message: "That mailbox provider isn't supported.", cta: "Back", ctaHref: "/enroll" })
      );
    }
    if (!process.env.PUBLIC_URL) {
      return res.status(500).send(
        statusView({ good: false, title: "Configuration error", message: "PUBLIC_URL is not set on the server.", cta: "Back", ctaHref: "/enroll" })
      );
    }
    const state = newState(provider, user.email);
    const url = getProvider(provider).buildAuthorizeUrl({ redirectUri: redirectUri(provider), state });
    res.redirect(url);
  });

  router.get("/callback/:provider", async (req, res) => {
    const { provider } = req.params;
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res.status(400).send(
        statusView({
          good: false,
          title: "Connection failed",
          message: `${esc(error)}: ${esc(error_description || "")}`,
          cta: "Back to your mailboxes",
          ctaHref: "/enroll",
        })
      );
    }
    const entry = takeState(String(state || ""));
    if (!entry || entry.provider !== provider) {
      return res.status(400).send(
        statusView({
          good: false,
          title: "Session expired",
          message: "That connection attempt timed out. Please try again.",
          cta: "Try again",
          ctaHref: "/enroll",
        })
      );
    }
    try {
      const p = getProvider(provider);
      const { email, refreshToken } = await p.exchangeCode({ code: String(code), redirectUri: redirectUri(provider) });
      putAccount({ owner: entry.owner, email, provider, label: email, refreshToken });
      const meta = PROVIDER_META[provider];
      res.send(
        statusView({
          good: true,
          title: "Mailbox connected",
          pill: `${meta.icon}&nbsp; ${esc(email)}`,
          message: "This account is now available to your AI assistant. You can send and check mail with it from any chat where the connector is enabled.",
          cta: "Back to your mailboxes",
          ctaHref: "/enroll",
        })
      );
    } catch (e) {
      res.status(400).send(
        statusView({
          good: false,
          title: "Connection failed",
          message: esc(e.message),
          cta: "Back to your mailboxes",
          ctaHref: "/enroll",
        })
      );
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
