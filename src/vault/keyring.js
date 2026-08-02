// Where the vault key comes from. Two sources, no third:
//
//   1. KP_VAULT_KEY   -- base64 of 32 raw bytes. For Linux, the Sailbox, CI.
//   2. macOS keychain -- via `security`, generated on first use.
//
// There is deliberately no "no key" path. A vault that silently degrades to
// plaintext when the keychain is locked is worse than one that refuses, because
// nobody notices the degrade until the file is already on disk.

import { spawn } from "node:child_process";
import { KEY_BYTES, newKey } from "./crypto.js";

export const KEYCHAIN_SERVICE = "kp-hackathon-vault";
const NOT_FOUND_EXIT = 44; // `security`'s "item not found"

function decodeKey(encoded, source) {
  const key = Buffer.from(String(encoded).trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${source} holds a ${key.length}-byte key; expected base64 of exactly ${KEY_BYTES} bytes. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  return key;
}

/** Run a command, feeding `stdin` if given. Never echoes argv or stdin. */
function run(command, args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ code: -1, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/**
 * macOS keychain backend.
 *
 * The key is written over stdin, never as an argv element: `security
 * add-generic-password -w <secret>` would put the vault key in `ps` output for
 * every user on the machine. Trailing bare `-w` makes it prompt, which reads
 * the pipe.
 */
export function securityKeychain({ account = "default", keychainPath = process.env.KP_VAULT_KEYCHAIN } = {}) {
  const where = keychainPath ? [keychainPath] : [];
  return {
    name: keychainPath ? `keychain ${keychainPath}` : "macOS login keychain",
    async read() {
      const { code, stdout } = await run("security", [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", ...where,
      ]);
      if (code === NOT_FOUND_EXIT) return null;
      if (code !== 0) return null;
      return stdout.trim() || null;
    },
    async write(keyB64) {
      const { code, stderr } = await run(
        "security",
        ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-U", ...where, "-w"],
        keyB64
      );
      if (code !== 0) throw new Error(`could not store the vault key in the keychain: ${stderr.trim()}`);
    },
  };
}

/**
 * @returns {Promise<{key: Buffer, source: string}>}
 */
export async function loadKey({
  env = process.env,
  platform = process.platform,
  keychain,
  create = true,
} = {}) {
  if (env.KP_VAULT_KEY) {
    return { key: decodeKey(env.KP_VAULT_KEY, "KP_VAULT_KEY"), source: "env:KP_VAULT_KEY" };
  }

  const backend = keychain ?? (platform === "darwin" ? securityKeychain({ keychainPath: env.KP_VAULT_KEYCHAIN }) : null);
  if (!backend) {
    throw new Error(
      "no vault key available: KP_VAULT_KEY is unset and there is no OS keychain on this platform. " +
        "Set KP_VAULT_KEY to base64 of 32 random bytes. The vault will not fall back to plaintext."
    );
  }

  const existing = await backend.read();
  if (existing) return { key: decodeKey(existing, backend.name), source: backend.name };

  if (!create) {
    throw new Error(`no vault key in ${backend.name}, and key creation was not requested`);
  }
  const key = newKey();
  await backend.write(key.toString("base64"));
  return { key, source: `${backend.name} (created)` };
}
