// The real macOS keychain backend, against a THROWAWAY keychain.
//
// Needs no network, no Sailbox and no real credential -- but it does shell out
// to `security`, so it skips off macOS.
//
// It earns its place: the first implementation used the documented "bare -w
// prompts for the password" form, which with an explicit keychain path makes
// `security` consume the PATH as the password and write the item to the LOGIN
// keychain instead. Exit code 0, plausible output, key silently in the wrong
// store. Only a real invocation catches that, so there is one here.
//
// It writes under a test-only service name, so even a regression of exactly
// that kind cannot collide with a real vault key -- and the cleanup below
// removes the stray from the login keychain if it happens again.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityKeychain, loadKey } from "../keyring.js";
import { newKey } from "../crypto.js";

const run = promisify(execFile);
const SERVICE = "kp-hackathon-vault-test";
const darwin = process.platform === "darwin";

let dir;
let keychainPath;

before(async () => {
  if (!darwin) return;
  dir = await mkdtemp(path.join(tmpdir(), "kp-keychain-"));
  keychainPath = path.join(dir, "test.keychain");
  await run("security", ["create-keychain", "-p", "testpass", keychainPath]);
  await run("security", ["unlock-keychain", "-p", "testpass", keychainPath]);
});

after(async () => {
  if (!darwin) return;
  // Delete any stray that reached the login keychain, then the temp keychain.
  await run("security", ["delete-generic-password", "-s", SERVICE, "-a", "default"]).catch(() => {});
  await run("security", ["delete-keychain", keychainPath]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

test("a key round-trips through a real keychain", { skip: !darwin && "macOS only" }, async () => {
  const backend = securityKeychain({ keychainPath, service: SERVICE });
  const key = newKey().toString("base64");
  await backend.write(key);
  assert.equal(await backend.read(), key);
});

// The regression. If `security` ever consumes the path as the password again,
// read() returns something other than what we wrote and write() must refuse.
test("the key lands in the NAMED keychain, not the login keychain", { skip: !darwin && "macOS only" }, async () => {
  const backend = securityKeychain({ keychainPath, service: SERVICE });
  const key = newKey().toString("base64");
  await backend.write(key);

  const inLoginKeychain = await run("security", ["find-generic-password", "-s", SERVICE, "-a", "default", "-w"])
    .then((r) => r.stdout.trim())
    .catch(() => null);
  assert.equal(inLoginKeychain, null, "nothing may be written to the login keychain");
});

test("a missing item reads as null rather than throwing", { skip: !darwin && "macOS only" }, async () => {
  const backend = securityKeychain({ keychainPath, service: `${SERVICE}-absent` });
  assert.equal(await backend.read(), null);
});

test("a non-base64 key is refused before it reaches the command line", { skip: !darwin && "macOS only" }, async () => {
  const backend = securityKeychain({ keychainPath, service: SERVICE });
  await assert.rejects(() => backend.write('x" ; echo pwned ; "'), /refusing to store a non-base64 vault key/);
});

test("loadKey mints once through the real backend, then reuses it", { skip: !darwin && "macOS only" }, async () => {
  const service = `${SERVICE}-loadkey`;
  const backend = securityKeychain({ keychainPath, service });
  const isolatedFallback = {
    name: "disabled test fallback",
    async read() { return null; },
    async write() { throw new Error("the temporary keychain must accept the key"); },
  };
  try {
    const first = await loadKey({ env: {}, keychain: backend, fileStore: isolatedFallback });
    const second = await loadKey({ env: {}, keychain: backend, fileStore: isolatedFallback });
    assert.ok(first.key.equals(second.key));
    assert.match(first.source, /created/);
    assert.ok(!/created/.test(second.source));
  } finally {
    await run("security", ["delete-generic-password", "-s", service, "-a", "default", keychainPath]).catch(() => {});
  }
});
