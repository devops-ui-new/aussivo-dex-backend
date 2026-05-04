import crypto from "crypto";

const ALGO = "aes-256-gcm";

/** Derive 32-byte key from any-length secret. */
function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest();
}

export function encryptPrivateKeyHex(privateKeyHex: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(privateKeyHex, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * One-way SHA-256 of the normalized 32-byte private key hex (64 hex chars, no 0x).
 * Stored for audit; cannot recover the key. The encrypted field is used for signing until purged after sweep.
 */
export function hashPrivateKeyHexFingerprint(privateKeyHex: string): string {
  const raw = String(privateKeyHex).trim();
  const hex = (raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("Invalid secp256k1 private key hex for fingerprint");
  }
  return crypto.createHash("sha256").update(hex, "utf8").digest("hex");
}

export function decryptPrivateKeyHex(payloadB64: string, secret: string): string {
  const buf = Buffer.from(payloadB64, "base64");
  if (buf.length < 32) throw new Error("Invalid encrypted payload");
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const enc = buf.subarray(32);
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
