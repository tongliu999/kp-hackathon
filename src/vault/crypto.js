// Vault at rest: AES-256-GCM over the whole serialised vault.
//
// GCM rather than CBC/CTR because the auth tag is the point: a truncated,
// edited or half-written vault file must fail loudly. A cipher without
// integrity would decrypt tampered bytes into something plausible, and this
// file holds credentials -- "plausible" is the failure mode that gets a burned
// session onto a demo.

import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
export const ENVELOPE_VERSION = 1;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`vault key must be ${KEY_BYTES} raw bytes, got ${Buffer.isBuffer(key) ? key.length : typeof key}`);
  }
}

export function newKey() {
  return randomBytes(KEY_BYTES);
}

/** @returns {{version:number,cipher:string,nonce:string,ciphertext:string,tag:string}} */
export function seal(plaintext, key) {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: ENVELOPE_VERSION,
    cipher: ALGORITHM,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function unseal(envelope, key) {
  assertKey(key);
  if (!envelope || typeof envelope !== "object") throw new Error("vault envelope is not an object");
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`unsupported vault envelope version ${envelope.version}`);
  }
  if (envelope.cipher !== ALGORITHM) {
    throw new Error(`unsupported vault cipher ${envelope.cipher}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key and tampered bytes are indistinguishable here by design, so say
    // both rather than guessing and sending someone down the wrong path.
    throw new Error("vault will not decrypt: wrong key, or the file has been modified");
  }
}

/** Constant-time compare, used when checking a key fingerprint rather than a key. */
export function sameBytes(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
