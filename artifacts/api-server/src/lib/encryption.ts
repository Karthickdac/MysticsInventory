import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_SALT = "mystics-inventory:v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env["APP_ENCRYPTION_KEY"];
  if (!raw || raw.length < 16) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not set (or is too short). Set a long random secret to enable encrypted credential storage.",
    );
  }
  cachedKey = scryptSync(raw, KEY_SALT, 32);
  return cachedKey;
}

export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptString(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("encrypted payload is not in the expected v1 format");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const enc = Buffer.from(parts[3]!, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("encrypted payload has malformed iv or auth tag");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
