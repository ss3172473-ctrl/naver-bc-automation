import crypto from "crypto";

function getKeyFromSecret(secret: string): Buffer {
  if (!secret) {
    throw new Error("APP_AUTH_SECRET가 필요합니다.");
  }
  // Derive a fixed 32-byte key from arbitrary secret.
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function encryptString(plaintext: string, secret: string): string {
  const key = getKeyFromSecret(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // v1:<iv>:<tag>:<ciphertext>
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptString(payload: string, secret: string): string {
  const key = getKeyFromSecret(secret);
  const parts = String(payload || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("암호화 포맷이 올바르지 않습니다.");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

