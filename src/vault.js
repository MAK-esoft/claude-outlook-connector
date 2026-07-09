// Encrypted-at-rest credential vault, keyed by lowercased email.
// Record shape on disk:
//   { email, provider, label, refresh_token_enc, created_at, updated_at }
// The refresh token is the ONLY encrypted field; everything else is metadata.
// Loaded into memory on startup, write-through on every mutation.
import fs from "fs";
import path from "path";
import { encrypt, decrypt } from "./crypto.js";

const STORE_PATH = path.resolve(process.env.VAULT_STORE_PATH || "./vault.enc.json");

/** @type {Map<string, object>} email(lowercased) -> record */
let accounts = new Map();

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      accounts = new Map();
      return;
    }
    const raw = fs.readFileSync(STORE_PATH, "utf8").trim();
    if (!raw) {
      accounts = new Map();
      return;
    }
    const arr = JSON.parse(raw);
    accounts = new Map(arr.map((r) => [r.email.toLowerCase(), r]));
  } catch (err) {
    // Fail loud but without leaking anything sensitive.
    throw new Error(`Failed to load vault store at ${STORE_PATH}: ${err.message}`);
  }
}

function persist() {
  const arr = [...accounts.values()];
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

load();

/** Upsert an account, encrypting its refresh token. */
export function putAccount({ email, provider, label, refreshToken }) {
  const key = email.toLowerCase();
  const now = new Date().toISOString();
  const existing = accounts.get(key);
  const record = {
    email: key,
    provider,
    label: label || existing?.label || email,
    refresh_token_enc: encrypt(refreshToken),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  accounts.set(key, record);
  persist();
  return { email: key, provider, label: record.label };
}

/** Full record (including encrypted token) or null. */
export function getAccount(email) {
  return accounts.get(String(email).toLowerCase()) || null;
}

/** Decrypted refresh token or null. */
export function getRefreshToken(email) {
  const rec = accounts.get(String(email).toLowerCase());
  if (!rec) return null;
  return decrypt(rec.refresh_token_enc);
}

/** Safe listing — NEVER includes tokens. */
export function listAccounts() {
  return [...accounts.values()].map(({ email, provider, label }) => ({ email, provider, label }));
}

export function deleteAccount(email) {
  const key = String(email).toLowerCase();
  const existed = accounts.delete(key);
  if (existed) persist();
  return existed;
}

export function storePath() {
  return STORE_PATH;
}
