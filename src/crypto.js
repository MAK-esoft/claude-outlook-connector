// AES-256-GCM helpers for the credential vault.
// Key comes from VAULT_ENCRYPTION_KEY (32 bytes, base64). Payload format is
// "iv:tag:ciphertext", each part base64.
import crypto from "crypto";

const KEY = Buffer.from(process.env.VAULT_ENCRYPTION_KEY || "", "base64");
if (KEY.length !== 32) {
  throw new Error(
    "VAULT_ENCRYPTION_KEY must be 32 bytes (base64-encoded). Generate one with:\n" +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
  );
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
