import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, unseal, newKey, KEY_BYTES } from "../crypto.js";
import { loadKey, KEYCHAIN_SERVICE } from "../keyring.js";

test("seal -> unseal round-trips", () => {
  const key = newKey();
  assert.equal(unseal(seal("hello vault", key), key), "hello vault");
});

test("the ciphertext does not contain the plaintext", () => {
  const envelope = seal("super-secret-token-value", newKey());
  assert.ok(!JSON.stringify(envelope).includes("super-secret-token-value"));
});

test("the same plaintext seals differently every time", () => {
  const key = newKey();
  assert.notEqual(seal("x", key).ciphertext, seal("x", key).ciphertext);
});

test("a tampered ciphertext is refused, not partially decrypted", () => {
  const key = newKey();
  const envelope = seal("hello vault", key);
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 0xff;
  assert.throws(() => unseal({ ...envelope, ciphertext: bytes.toString("base64") }, key), /wrong key, or the file has been modified/);
});

test("a truncated ciphertext is refused", () => {
  const key = newKey();
  const envelope = seal("hello vault, this is long enough to truncate", key);
  const bytes = Buffer.from(envelope.ciphertext, "base64").subarray(0, 5);
  assert.throws(() => unseal({ ...envelope, ciphertext: bytes.toString("base64") }, key), /wrong key, or the file/);
});

test("the wrong key is refused", () => {
  assert.throws(() => unseal(seal("hello", newKey()), newKey()), /wrong key/);
});

test("a short key is rejected up front", () => {
  assert.throws(() => seal("x", Buffer.alloc(16)), new RegExp(`must be ${KEY_BYTES} raw bytes`));
});

test("an unknown envelope version is refused rather than best-effort parsed", () => {
  const key = newKey();
  assert.throws(() => unseal({ ...seal("x", key), version: 99 }, key), /unsupported vault envelope version/);
});

test("a key from the environment is used when present", async () => {
  const key = newKey();
  const loaded = await loadKey({ env: { KP_VAULT_KEY: key.toString("base64") } });
  assert.ok(loaded.key.equals(key));
  assert.equal(loaded.source, "env:KP_VAULT_KEY");
});

test("a wrong-length environment key is rejected with instructions", async () => {
  await assert.rejects(
    () => loadKey({ env: { KP_VAULT_KEY: Buffer.alloc(8).toString("base64") } }),
    /expected base64 of exactly 32 bytes/
  );
});

test("with no env key and no keychain, the vault REFUSES rather than falling back to plaintext", async () => {
  await assert.rejects(() => loadKey({ env: {}, platform: "linux" }), /will not fall back to plaintext/);
});

test("a key is generated and stored on first use, then reused", async () => {
  let stored = null;
  const keychain = {
    name: "fake keychain",
    async read() { return stored; },
    async write(value) { stored = value; },
  };
  const first = await loadKey({ env: {}, platform: "linux", keychain });
  const second = await loadKey({ env: {}, platform: "linux", keychain });
  assert.ok(first.key.equals(second.key));
  assert.match(first.source, /created/);
  assert.equal(second.source, "fake keychain");
});

test("macOS falls back to a protected key file when non-interactive keychain creation fails", async () => {
  let stored = null;
  const keychain = {
    name: "locked keychain",
    async read() { return null; },
    async write() { throw new Error("keychain command timed out"); },
  };
  const fileStore = {
    name: "fake mode-0600 key file",
    async read() { return stored; },
    async write(value) { stored = value; },
  };
  const first = await loadKey({ env: {}, platform: "darwin", keychain, fileStore });
  const second = await loadKey({ env: {}, platform: "darwin", keychain, fileStore });
  assert.ok(first.key.equals(second.key));
  assert.match(first.source, /created after keychain failure/);
  assert.equal(second.source, "fake mode-0600 key file");
});

test("key creation can be refused, for callers that must not mint one", async () => {
  const keychain = { name: "fake keychain", async read() { return null; }, async write() {} };
  await assert.rejects(() => loadKey({ env: {}, platform: "linux", keychain, create: false }), /key creation was not requested/);
});

test("the keychain service name is stable, so keys are findable after a rename", () => {
  assert.equal(KEYCHAIN_SERVICE, "kp-hackathon-vault");
});
