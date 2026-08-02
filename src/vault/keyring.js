// Where the vault key comes from, in order:
//
//   1. KP_VAULT_KEY   -- base64 of 32 raw bytes. For Linux, the Sailbox, CI.
//   2. macOS keychain -- via `security`, generated on first use.
//   3. A mode-0600 key file outside the repository, only when the macOS
//      keychain cannot create an item non-interactively (the app-console case).
//
// There is deliberately no plaintext path. The file fallback is still a
// separate key protecting an authenticated-encryption envelope; it exists so
// the no-terminal console does not hang on a Keychain password prompt.

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_BYTES, newKey } from "./crypto.js";

export const KEYCHAIN_SERVICE = "kp-hackathon-vault";
const NOT_FOUND_EXIT = 44; // `security`'s "item not found"

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultKeyFile(env = process.env) {
  return path.resolve(env.KP_VAULT_KEY_FILE ?? path.join(os.homedir(), ".kp-hackathon", "vault.key"));
}

export function keyFileStore(file = defaultKeyFile()) {
  const resolved = path.resolve(file);
  const rel = path.relative(repoRoot(), resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error("refusing to store the vault key inside the repository");
  }
  return {
    name: `mode-0600 key file ${resolved}`,
    async read() {
      try { return (await readFile(resolved, "utf8")).trim() || null; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async write(value) {
      await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      const temp = `${resolved}.tmp`;
      await writeFile(temp, `${value}\n`, { mode: 0o600 });
      await rename(temp, resolved);
    },
  };
}

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
function run(command, args, stdin, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : code,
        stdout,
        stderr: timedOut ? `${stderr}\nkeychain command timed out`.trim() : stderr,
      });
    });
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
        `${keyB64}\n`
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
  fileStore,
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

  const fallback = fileStore ?? (platform === "darwin" ? keyFileStore(defaultKeyFile(env)) : null);
  const fileExisting = fallback ? await fallback.read() : null;
  if (fileExisting) return { key: decodeKey(fileExisting, fallback.name), source: fallback.name };

  if (!create) {
    throw new Error(`no vault key in ${backend.name}, and key creation was not requested`);
  }
  const key = newKey();
  try {
    await backend.write(key.toString("base64"));
    return { key, source: `${backend.name} (created)` };
  } catch (error) {
    if (!fallback) throw error;
    await fallback.write(key.toString("base64"));
    return { key, source: `${fallback.name} (created after keychain failure)` };
  }
}
