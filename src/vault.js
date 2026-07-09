// Encrypted-at-rest credential vault — MULTI-TENANT.
// Every record belongs to an `owner` (the Auth0 email of the person who
// enrolled it), and every query is scoped by owner. Keyed by "owner:email" so
// two users can independently enroll even the same shared mailbox.
//
// Record shape on disk:
//   { owner, email, provider, label, refresh_token_enc, created_at, updated_at }
// The refresh token is the ONLY encrypted field; everything else is metadata.
// Loaded into memory on startup, write-through on every mutation.
import fs from "fs";
import path from "path";
import { encrypt, decrypt } from "./crypto.js";

const STORE_PATH = path.resolve(process.env.VAULT_STORE_PATH || "./vault.enc.json");

// Legacy/dev records (or auth-off smoke tests) fall under this owner.
export const DEV_OWNER = "dev@local";

const keyOf = (owner, email) => `${String(owner).toLowerCase()}:${String(email).toLowerCase()}`;

/** @type {Map<string, object>} "owner:email" -> record */
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
    accounts = new Map(
      arr.map((r) => {
        const rec = { owner: (r.owner || DEV_OWNER).toLowerCase(), ...r, email: r.email.toLowerCase() };
        return [keyOf(rec.owner, rec.email), rec];
      })
    );
  } catch (err) {
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

/** Upsert an account for an owner, encrypting its refresh token. */
export function putAccount({ owner, email, provider, label, refreshToken }) {
  if (!owner) throw new Error("putAccount requires an owner");
  const ownerKey = String(owner).toLowerCase();
  const emailKey = String(email).toLowerCase();
  const now = new Date().toISOString();
  const existing = accounts.get(keyOf(ownerKey, emailKey));
  const record = {
    owner: ownerKey,
    email: emailKey,
    provider,
    label: label || existing?.label || email,
    refresh_token_enc: encrypt(refreshToken),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  accounts.set(keyOf(ownerKey, emailKey), record);
  persist();
  return { owner: ownerKey, email: emailKey, provider, label: record.label };
}

/** Full record (including encrypted token) or null — owner-scoped. */
export function getAccount(email, owner) {
  return accounts.get(keyOf(owner, email)) || null;
}

/** Decrypted refresh token or null — owner-scoped. */
export function getRefreshToken(email, owner) {
  const rec = accounts.get(keyOf(owner, email));
  if (!rec) return null;
  return decrypt(rec.refresh_token_enc);
}

/** Safe listing for ONE owner — NEVER includes tokens. */
export function listAccounts(owner) {
  const ownerKey = String(owner || "").toLowerCase();
  return [...accounts.values()]
    .filter((r) => r.owner === ownerKey)
    .map(({ email, provider, label }) => ({ email, provider, label }));
}

export function deleteAccount(email, owner) {
  const existed = accounts.delete(keyOf(owner, email));
  if (existed) persist();
  return existed;
}

/** Total enrolled mailboxes across ALL owners (startup logging only). */
export function countAccounts() {
  return accounts.size;
}

export function storePath() {
  return STORE_PATH;
}
