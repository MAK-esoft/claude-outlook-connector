// Ultra Mail — enrollment portal (multi-user). Each visitor signs in with Auth0
// first; the mailboxes they enroll are tagged with their identity (owner) and
// only their own mailboxes are ever shown or usable by them (here and over MCP).
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

const BRAND = "Ultra Mail";

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

// ── Logo & icons ───────────────────────────────────────────────────────────
// Ultra Mail mark: paper plane in flight with a motion trail, on a gradient tile.
function logoMark(size = 32) {
  const id = `g${size}`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="48" y2="48">
      <stop offset="0" stop-color="#6366f1"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#d946ef"/>
    </linearGradient></defs>
    <rect width="48" height="48" rx="13" fill="url(#${id})"/>
    <path d="M38.5 12.2 21.4 29.3l-7.6-3.1a1.3 1.3 0 0 1 .1-2.4l22.7-12.9a1.3 1.3 0 0 1 1.9 1.3z" fill="#fff" opacity=".92"/>
    <path d="M39.6 13.5 34 34.6a1.3 1.3 0 0 1-2 .8l-8.9-5.6 14.6-17.5c.9-1 1.9.1 1.9 1.2z" fill="#fff"/>
    <path d="m21.4 29.3 1.7 6.4c.3 1 1.6 1.2 2.2.4l3-3.9z" fill="#e0e7ff"/>
    <path d="M8 33.5h6M6 38h9" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>
  </svg>`;
}

function msIcon(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`;
}
function googleIcon(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
}

const ICONS = {
  microsoft: msIcon(22),
  google: googleIcon(22),
  mail: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 7 8.29 5.4a2 2 0 0 0 2.18 0L22 7"/></svg>`,
  shield: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`,
  check: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  alert: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
  logout: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
  book: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  sparkle: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.7a2 2 0 0 0 1.27 1.27L20.8 10.9a.6.6 0 0 1 0 1.14l-5.63 1.88a2 2 0 0 0-1.27 1.27L12 20.9a.6.6 0 0 1-1.14 0l-1.88-5.63a2 2 0 0 0-1.27-1.27L2.08 12.1a.6.6 0 0 1 0-1.14l5.63-1.88a2 2 0 0 0 1.27-1.27L10.86 2a.6.6 0 0 1 1.14 0z"/></svg>`,
  back: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M19 12H5"/></svg>`,
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
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(logoMark(48))}">
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
    padding:12px 24px;border-bottom:1px solid var(--border);
    background:var(--surface);
  }
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15.5px;letter-spacing:-.01em;color:var(--text);text-decoration:none}
  .nav{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--text-2)}
  .nav .avatar{
    width:28px;height:28px;border-radius:50%;display:grid;place-items:center;
    background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:12px;text-transform:uppercase;
  }
  .navbtn{color:var(--text-2);text-decoration:none;display:inline-flex;align-items:center;gap:6px;
    padding:6px 11px;border:1px solid var(--border);border-radius:8px;transition:.15s;font-size:13px;font-weight:550}
  .navbtn:hover{color:var(--text);border-color:var(--border-2);background:var(--surface-2)}
  main{flex:1;width:100%;max-width:640px;margin:0 auto;padding:40px 20px 64px}
  main.wide{max-width:760px}
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
  .account{display:flex;align-items:center;gap:14px;padding:15px 18px}
  .account + .account{border-top:1px solid var(--border)}
  .picon{
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
  .provider-btn b{display:block;font-size:14px;font-weight:650}
  .provider-btn span{display:block;font-size:12px;color:var(--text-2);margin-top:1px}
  .empty{padding:38px 24px;text-align:center;color:var(--text-2)}
  .empty .picon{width:46px;height:46px;border-radius:12px;margin:0 auto 12px;background:var(--accent-soft);color:var(--accent);border:none}
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
  .cta.ghost{background:transparent;color:var(--text);border:1px solid var(--border)}
  .cta.ghost:hover{background:var(--surface-2)}
  .hero{
    text-align:center;padding:56px 28px;
    background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);
  }
  .hero h1{font-size:25px;margin-top:20px}
  .hero .sub{max-width:410px;margin:8px auto 26px}
  .hero .actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .features{display:flex;justify-content:center;gap:20px;margin-top:30px;flex-wrap:wrap}
  .features div{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-2)}
  .features svg{color:var(--green)}
  .status{
    text-align:center;padding:52px 28px;
    background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);
  }
  .status .ring{width:60px;height:60px;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px}
  .status.good .ring{background:var(--green-soft);color:var(--green)}
  .status.bad .ring{background:var(--red-soft);color:var(--red)}
  .status h1{font-size:21px;margin-bottom:6px}
  .status p{color:var(--text-2);font-size:14px;max-width:400px;margin:0 auto 24px}
  .status .pill{
    display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;
    background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:6px 14px;margin-bottom:22px;
  }
  /* ── Guide ── */
  .tabs{
    display:inline-flex;background:var(--surface-2);border:1px solid var(--border);
    border-radius:11px;padding:4px;gap:4px;margin:20px 0 4px;
  }
  .tab{
    display:inline-flex;align-items:center;gap:7px;
    font-size:13.5px;font-weight:600;font-family:inherit;cursor:pointer;
    color:var(--text-2);background:transparent;border:none;border-radius:8px;
    padding:8px 18px;transition:.15s;
  }
  .tab.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
  .guide-panel{display:none}
  .guide-panel.active{display:block}
  .steps{counter-reset:step;margin-top:14px}
  .step{
    display:flex;gap:14px;padding:16px 18px;
    background:var(--surface);border:1px solid var(--border);
  }
  .step:first-child{border-radius:var(--radius) var(--radius) 0 0}
  .step:last-child{border-radius:0 0 var(--radius) var(--radius)}
  .step + .step{border-top:none}
  .step::before{
    counter-increment:step;content:counter(step);
    width:26px;height:26px;flex-shrink:0;border-radius:50%;
    display:grid;place-items:center;font-size:12.5px;font-weight:700;
    background:var(--accent-soft);color:var(--accent);
  }
  .step .body{font-size:14px;color:var(--text-2)}
  .step .body b{color:var(--text)}
  .step .body code{
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
    background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:2px 7px;
    color:var(--text);word-break:break-all;
  }
  .callout{
    display:flex;gap:10px;align-items:flex-start;margin-top:14px;
    font-size:13px;color:var(--text-2);
    background:var(--accent-soft);border:1px solid transparent;border-radius:12px;padding:13px 15px;
  }
  .callout svg{flex-shrink:0;margin-top:2px;color:var(--accent)}
  .callout b{color:var(--text)}
  .prompts{display:grid;gap:8px;margin-top:14px}
  .prompt{
    font-size:13.5px;padding:11px 15px;color:var(--text-2);
    background:var(--surface);border:1px solid var(--border);border-radius:10px;
  }
  .prompt b{color:var(--text)}
  footer.site{text-align:center;padding:20px;color:var(--text-3);font-size:12px;border-top:1px solid var(--border)}
</style></head><body>
${content}
<footer class="site">${esc(BRAND)} · Your accounts are encrypted and visible only to you</footer>
</body></html>`;
}

function siteHeader(user, { showGuide = true } = {}) {
  const guide = showGuide ? `<a class="navbtn" href="/enroll/guide">${ICONS.book} Guide</a>` : "";
  const who = user && !user.dev
    ? `<span class="avatar">${esc(user.email[0] || "?")}</span>
       <span>${esc(user.email)}</span>
       <a class="navbtn" href="/enroll/logout">${ICONS.logout} Sign out</a>`
    : user?.dev
      ? `<span>dev mode</span>`
      : "";
  return `<header class="site">
    <a class="brand" href="/enroll">${logoMark(32)} ${esc(BRAND)}</a>
    <nav class="nav">${guide}${who}</nav>
  </header>`;
}

// ── Views ──────────────────────────────────────────────────────────────────
function signInView() {
  return layout(
    `Sign in — ${BRAND}`,
    `${siteHeader(null)}
    <main>
      <div class="hero">
        ${logoMark(60)}
        <h1>Your email, in your AI assistant</h1>
        <p class="sub">Connect your Outlook and Gmail accounts once, then send and
        check mail from Claude or ChatGPT — safely, with your approval on every send.</p>
        <div class="actions">
          <a class="cta" href="/enroll/login">Sign in / create account</a>
          <a class="cta ghost" href="/enroll/guide">${ICONS.book} Read the guide</a>
        </div>
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
    `Your mailboxes — ${BRAND}`,
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
        Custom-domain addresses work too — just pick the provider that hosts them.
        New here? <a href="/enroll/guide" style="color:var(--accent)">Read the guide</a>.</span>
      </div>
    </main>`
  );
}

function guideView(user) {
  const mcpUrl = `${process.env.PUBLIC_URL}/mcp`;
  const enrollUrl = `${process.env.PUBLIC_URL}/enroll`;

  const claudeSteps = `
    <div class="steps">
      <div class="step"><div class="body">In Claude, click your initials (bottom-left) →
        <b>Settings</b> → <b>Connectors</b> → <b>Add custom connector</b>.</div></div>
      <div class="step"><div class="body">Fill in the form:<br>
        <b>Name:</b> <code>${esc(BRAND)}</code><br>
        <b>Remote MCP server URL:</b> <code>${esc(mcpUrl)}</code></div></div>
      <div class="step"><div class="body">Expand <b>Advanced settings</b> and enter the
        <b>OAuth Client ID</b> and <b>OAuth Client Secret</b> — these are provided
        privately by your administrator (never shared in this guide).</div></div>
      <div class="step"><div class="body">Click <b>Add</b>, then <b>Connect</b>. A sign-in
        window opens — <b>log in with the same ${esc(BRAND)} account</b> you use on this site.
        That's how Claude finds <i>your</i> mailboxes.</div></div>
      <div class="step"><div class="body">In any chat, press <b>+</b> and switch on
        <b>${esc(BRAND)}</b>. Claude will ask your permission before every action it takes.</div></div>
    </div>`;

  const chatgptSteps = `
    <div class="callout">${ICONS.alert.replace('width="28" height="28"', 'width="16" height="16"')}
      <span><b>Plan requirement:</b> sending email from ChatGPT needs a
      <b>Business, Enterprise, or Edu</b> workspace with <b>Developer Mode</b> enabled
      (a workspace admin turns this on once under Settings → Connectors).</span>
    </div>
    <div class="steps">
      <div class="step"><div class="body">In ChatGPT, open <b>Settings</b> →
        <b>Connectors</b> → <b>Create</b> (or <b>Add custom connector</b>).</div></div>
      <div class="step"><div class="body">Fill in the form:<br>
        <b>Name:</b> <code>${esc(BRAND)}</code><br>
        <b>MCP server URL:</b> <code>${esc(mcpUrl)}</code><br>
        <b>Authentication:</b> OAuth</div></div>
      <div class="step"><div class="body">Enter the <b>Client ID</b> and <b>Client Secret</b>
        when asked — provided privately by your administrator (never shared in this guide).</div></div>
      <div class="step"><div class="body">Click <b>Scan tools</b>, complete the sign-in —
        <b>use the same ${esc(BRAND)} account</b> you use on this site — then <b>Create</b>
        and publish the connector to your workspace.</div></div>
      <div class="step"><div class="body">Enable ${esc(BRAND)} in your chat. ChatGPT
        confirms each action with you before running it.</div></div>
    </div>`;

  return layout(
    `Guide — ${BRAND}`,
    `${siteHeader(user)}
    <main class="wide">
      <a class="navbtn" href="/enroll" style="margin-bottom:18px">${ICONS.back} Back</a>
      <h1 style="margin-top:14px">How to use ${esc(BRAND)}</h1>
      <p class="sub">Three short steps: connect your mailboxes here, link your AI
      assistant, then just talk to it.</p>

      <div class="section-label">Step 1 — Connect your email accounts (on this site)</div>
      <div class="steps">
        <div class="step"><div class="body"><b>Sign in / create an account</b> at
          <code>${esc(enrollUrl)}</code> — remember which account you use.</div></div>
        <div class="step"><div class="body">Click <b>Add Microsoft account</b> (Outlook,
          Hotmail, Microsoft 365) or <b>Add Google account</b> (Gmail, Workspace) and sign
          in with that mailbox.</div></div>
        <div class="step"><div class="body">On the permission screen, <b>tick all the
          checkboxes</b>, then Continue. Repeat for every account you want — you can mix
          providers freely.</div></div>
      </div>

      <div class="section-label">Step 2 — Connect your AI assistant</div>
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="claude" onclick="showTab('claude')">${ICONS.sparkle} Claude</button>
        <button class="tab" data-tab="chatgpt" onclick="showTab('chatgpt')">ChatGPT</button>
      </div>
      <div id="panel-claude" class="guide-panel active">${claudeSteps}</div>
      <div id="panel-chatgpt" class="guide-panel">${chatgptSteps}</div>

      <div class="callout">${ICONS.shield}
        <span><b>Important:</b> always sign in with the <b>same account</b> on this site and
        inside your AI assistant — that's how ${esc(BRAND)} knows which mailboxes are yours.
        Nobody else can ever see or use your accounts.</span>
      </div>

      <div class="section-label">Step 3 — Try it out</div>
      <div class="prompts">
        <div class="prompt"><b>"Which email accounts can you use?"</b> — lists your connected mailboxes</div>
        <div class="prompt"><b>"Send an email from my work address to sara@client.com — subject 'Proposal', tell her the draft is ready."</b> — shows you the draft first, sends only after your OK</div>
        <div class="prompt"><b>"How many unread emails do I have?"</b> — counts across all your accounts</div>
        <div class="prompt"><b>"Show my 10 most recent emails."</b> — merged from every inbox, newest first</div>
        <div class="prompt"><b>"Search my email for the invoice from Acme, and open the first result."</b></div>
      </div>

      <div class="note">${ICONS.shield}
        <span>Nothing is ever sent automatically: you see the exact draft and approve it,
        and your AI app asks its own permission on top. Manage or remove your accounts
        anytime on <a href="/enroll" style="color:var(--accent)">your mailboxes page</a>.</span>
      </div>
    </main>
    <script>
      function showTab(name){
        document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===name));
        document.querySelectorAll(".guide-panel").forEach(p=>p.classList.toggle("active",p.id==="panel-"+name));
      }
    </script>`
  );
}

function statusView({ good, title, message, pill, cta, ctaHref }) {
  return layout(
    `${title} — ${BRAND}`,
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

  // ── Guide (public — no login required) ──────────────────────────────
  router.get("/guide", (req, res) => {
    res.send(guideView(currentUser(req)));
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
