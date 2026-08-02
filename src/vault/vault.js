// The vault: domain -> label -> session.
//
// Per-domain because the assistant learns tasks on arbitrary sites, and
// multi-label per domain because a burned session must not block a demo --
// rotation is the recovery path, so it is in the data model rather than in
// somebody's head.
//
// The pure functions here operate on a plain object and never touch disk or
// crypto; load/save do the IO. That split is what lets the whole rotation and
// expiry story be tested with no key, no network and no browser.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { seal, unseal } from "./crypto.js";
import { normalizeDomain, cookiesForDomain } from "./domains.js";
import { sessionExpiry, isExpired, describeRemaining } from "./expiry.js";
import { emptyCapability } from "./capabilities.js";

export const VAULT_VERSION = 1;

export function defaultVaultPath(env = process.env) {
  if (env.KP_VAULT_PATH) return path.resolve(env.KP_VAULT_PATH);
  return path.join(os.homedir(), ".kp-hackathon", "vault.enc.json");
}

/** This file is src/vault/vault.js, so the working tree root is two levels up. */
function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Refuse to put the vault anywhere inside the working tree.
 *
 * .gitignore is not sufficient on its own: a rename, a new worktree or a `git
 * add -f` all defeat it, and the failure is permanent and public.
 */
export function assertOutsideRepo(vaultPath, root = repoRoot()) {
  const resolved = path.resolve(vaultPath);
  const rel = path.relative(root, resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(
      `refusing to write the vault inside the repository (${resolved}). ` +
        "Credentials never live in the working tree. Set KP_VAULT_PATH to a location outside it."
    );
  }
  return resolved;
}

export function emptyVault() {
  return { version: VAULT_VERSION, domains: {}, capabilities: {} };
}

export async function loadVault({ vaultPath, key }) {
  const resolved = assertOutsideRepo(vaultPath);
  let text;
  try {
    text = await readFile(resolved, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyVault();
    throw error;
  }
  const data = JSON.parse(unseal(JSON.parse(text), key));
  if (data.version !== VAULT_VERSION) throw new Error(`unsupported vault version ${data.version}`);
  return data;
}

export async function saveVault(data, { vaultPath, key }) {
  const resolved = assertOutsideRepo(vaultPath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const envelope = JSON.stringify(seal(JSON.stringify(data), key), null, 2);
  // Write-then-rename: a crash mid-write must not leave a vault that decrypts
  // to half a file, which the GCM tag would (correctly) reject wholesale.
  const temp = `${resolved}.tmp`;
  await writeFile(temp, envelope, { mode: 0o600 });
  await rename(temp, resolved);
  return resolved;
}

export function putSession(data, { domain, label, cookies, mailbox = null, accountOrigin = "human-import", now = new Date() }) {
  const key = normalizeDomain(domain);
  if (!label) throw new Error("a session needs a label — that is how it is rotated");
  const scoped = cookiesForDomain(cookies, key);
  if (scoped.length === 0) {
    throw new Error(`no cookies for ${key} in that file (it held ${cookies.length} for other domains)`);
  }
  const { expiresAt, source } = sessionExpiry(scoped);

  const record = {
    domain: key,
    label: String(label),
    importedAt: now.toISOString(),
    expiresAt,
    expirySource: source,
    cookieNames: scoped.map((c) => c.name),
    cookieCount: scoped.length,
    account: mailbox ? { mailbox: String(mailbox), origin: accountOrigin } : { mailbox: null, origin: accountOrigin },
    cookies: scoped,
  };

  data.domains[key] ??= { sessions: {} };
  data.domains[key].sessions[record.label] = record;
  return record;
}

export function removeSession(data, { domain, label }) {
  const key = normalizeDomain(domain);
  const sessions = data.domains[key]?.sessions;
  if (!sessions?.[label]) return null;
  const removed = sessions[label];
  delete sessions[label];
  if (Object.keys(sessions).length === 0) delete data.domains[key];
  return { domain: key, label: removed.label };
}

/** Names and dates only — never cookie values. Safe to print as-is. */
export function listSessions(data, now = new Date()) {
  const rows = [];
  for (const [domain, entry] of Object.entries(data.domains ?? {})) {
    for (const record of Object.values(entry.sessions ?? {})) {
      rows.push({
        domain,
        label: record.label,
        importedAt: record.importedAt,
        expiresAt: record.expiresAt,
        expirySource: record.expirySource,
        remaining: describeRemaining(record.expiresAt, now),
        status: isExpired(record.expiresAt, now) ? "EXPIRED" : record.expiresAt ? "ok" : "unknown-expiry",
        mailbox: record.account?.mailbox ?? null,
        cookieCount: record.cookieCount,
      });
    }
  }
  return rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.label.localeCompare(b.label));
}

function reimportHint(record) {
  const who = record.account?.mailbox ? `the account ${record.account.mailbox}` : `the account behind "${record.label}"`;
  return (
    `Re-import it: log in as ${who} on your own machine, export the ${record.domain} cookies, then\n` +
    `  node scripts/vault.mjs add <cookies.json> --domain ${record.domain} --label ${record.label} --forget`
  );
}

/**
 * Pick a usable session.
 *
 * With a label: that one, or a refusal naming it. Without: the most recently
 * imported session that has not expired -- rotation, so one burned account does
 * not take the demo down with it.
 *
 * An expired session is REFUSED here rather than handed out and allowed to fail
 * mid-run, which is the failure this vault exists to prevent.
 */
export function selectSession(data, { domain, label, now = new Date() } = {}) {
  const key = normalizeDomain(domain);
  const sessions = Object.values(data.domains[key]?.sessions ?? {});
  if (sessions.length === 0) {
    const known = Object.keys(data.domains ?? {});
    throw new Error(
      `no session stored for ${key}${known.length ? ` (have: ${known.join(", ")})` : " (vault is empty)"}`
    );
  }

  if (label) {
    const record = sessions.find((s) => s.label === label);
    if (!record) {
      throw new Error(`no session "${label}" for ${key} (have: ${sessions.map((s) => s.label).join(", ")})`);
    }
    if (isExpired(record.expiresAt, now)) {
      throw new Error(`session ${key}/${record.label} expired ${record.expiresAt}.\n${reimportHint(record)}`);
    }
    return record;
  }

  const live = sessions
    .filter((s) => !isExpired(s.expiresAt, now))
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));

  if (live.length === 0) {
    const lines = sessions.map((s) => `  ${key}/${s.label} expired ${s.expiresAt}`).join("\n");
    throw new Error(
      `every stored ${key} session has expired:\n${lines}\n${reimportHint(sessions[0])}`
    );
  }
  return live[0];
}

export function getCapability(data, domain) {
  const key = normalizeDomain(domain);
  return data.capabilities?.[key] ?? emptyCapability(key);
}

export function putCapability(data, domain, capability) {
  const key = normalizeDomain(domain);
  data.capabilities ??= {};
  data.capabilities[key] = { ...getCapability(data, key), ...capability, domain: key };
  return data.capabilities[key];
}
