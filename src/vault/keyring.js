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
 * add-generic-password -w <key>` would put the vault key in `ps` output for
 * every user on the machine. `security -i` reads its command from stdin, which
 * keeps the key out of argv while still allowing an explicit target keychain.
 *
 * Bare trailing `-w` (the documented "prompt for it" form) is NOT usable here:
 * with a keychain path given, `security` consumes the path as the password and
 * silently writes the item to the LOGIN keychain instead. Measured, not assumed.
 */
export function securityKeychain({
  account = "default",
  keychainPath = process.env.KP_VAULT_KEYCHAIN,
  service = KEYCHAIN_SERVICE,
} = {}) {
  const where = keychainPath ? [keychainPath] : [];

  async function read() {
    const { code, stdout } = await run("security", [
      "find-generic-password", "-s", service, "-a", account, "-w", ...where,
    ]);
    if (code !== 0) return null; // includes NOT_FOUND_EXIT
    return stdout.trim() || null;
  }

  return {
    name: keychainPath ? `keychain ${keychainPath}` : "macOS login keychain",
    read,
    async write(keyB64) {
      // Interpolated into a quoted string below, so it must be base64 and
      // nothing else. Anything able to carry a quote could rewrite the command.
      if (!/^[A-Za-z0-9+/=]+$/.test(keyB64)) throw new Error("refusing to store a non-base64 vault key");
      const target = keychainPath ? ` "${keychainPath}"` : "";
      const command = `add-generic-password -s ${service} -a ${account} -U -w "${keyB64}"${target}\n`;
      const { code, stdout, stderr } = await run("security", ["-i"], command);
      const output = `${stdout}${stderr}`.trim();
      // `security -i` reports some failures in its output while still exiting 0,
      // so a clean exit code alone is not evidence the key was stored.
      if (code !== 0 || /error|Usage:/i.test(output)) {
        throw new Error(`could not store the vault key in the keychain: ${output || `exit ${code}`}`);
      }
      // Read back before trusting it. The earlier bug wrote the key somewhere
      // else entirely and still looked like a success.
      if ((await read()) !== keyB64) {
        throw new Error(
          "the vault key did not survive the keychain write — refusing to continue with a key that cannot be read back"
        );
      }
    },
  };
}

export { NOT_FOUND_EXIT };

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
