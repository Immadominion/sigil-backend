import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

function getEncryptionKey(): Buffer {
  return Buffer.from(config.ENCRYPTION_KEY, "hex");
}

/**
 * Encrypt a buffer using AES-256-GCM.
 * Output format: base64(iv || authTag || ciphertext)
 */
export function encrypt(plaintext: Buffer): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 */
export function decrypt(encryptedBase64: string): Buffer {
  const key = getEncryptionKey();
  const data = Buffer.from(encryptedBase64, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a Solana keypair's secret key for storage.
 */
export function encryptKeypairSecret(secretKey: Uint8Array): string {
  return encrypt(Buffer.from(secretKey));
}

/**
 * Decrypt a stored keypair secret key.
 */
export function decryptKeypairSecret(encrypted: string): Uint8Array {
  return new Uint8Array(decrypt(encrypted));
}
