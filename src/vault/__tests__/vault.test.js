// The vault's data model: many domains, many labels per domain, rotation, and
// the expiry refusal. No key, no disk and no browser in most of these -- the
// pure functions are the point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emptyVault, putSession, listSessions, selectSession, removeSession,
  getCapability, putCapability, saveVault, loadVault, assertOutsideRepo, defaultVaultPath,
} from "../vault.js";
import { newKey } from "../crypto.js";
import { cookie, jwtWithExp } from "./fakes.js";

const HOUR = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function liveCookies(name = "auth_token") {
  return [cookie(name, jwtWithExp(nowSeconds() + 30 * 24 * HOUR))];
}
function deadCookies(name = "auth_token") {
  return [cookie(name, jwtWithExp(nowSeconds() - HOUR))];
}

test("sessions are stored per domain and per label", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "tong", cookies: liveCookies() });
  putSession(data, { domain: "resy.com", label: "spare", cookies: liveCookies() });
  putSession(data, { domain: "opentable.com", label: "tong", cookies: [cookie("ot", "x".repeat(40), { domain: ".opentable.com", expires: nowSeconds() + HOUR })] });

  const rows = listSessions(data);
  assert.deepEqual(
    rows.map((r) => `${r.domain}/${r.label}`),
    ["opentable.com/tong", "resy.com/spare", "resy.com/tong"]
  );
});

test("a session only ever holds cookies for its own domain", () => {
  const data = emptyVault();
  const mixed = [
    cookie("resy_auth", jwtWithExp(nowSeconds() + HOUR)),
    cookie("other", "y".repeat(40), { domain: ".example.com" }),
  ];
  const record = putSession(data, { domain: "resy.com", label: "tong", cookies: mixed });
  assert.equal(record.cookieCount, 1);
  assert.deepEqual(record.cookieNames, ["resy_auth"]);
});

test("a file with no cookies for the domain is refused rather than stored empty", () => {
  const data = emptyVault();
  assert.throws(
    () => putSession(data, { domain: "resy.com", label: "tong", cookies: [cookie("x", "z".repeat(40), { domain: ".example.com" })] }),
    /no cookies for resy.com/
  );
});

test("list shows names and dates only — never a cookie value", () => {
  const data = emptyVault();
  const secret = jwtWithExp(nowSeconds() + HOUR);
  putSession(data, { domain: "resy.com", label: "tong", cookies: [cookie("auth", secret)] });
  const serialized = JSON.stringify(listSessions(data));
  assert.ok(!serialized.includes(secret), "list output must not carry the token");
});

test("an expired session is REFUSED by label, and the message names the account to re-import", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "tong", cookies: deadCookies(), mailbox: "tong@ours.test" });
  assert.throws(() => selectSession(data, { domain: "resy.com", label: "tong" }), (error) => {
    assert.match(error.message, /expired/);
    assert.match(error.message, /tong@ours\.test/);
    assert.match(error.message, /--label tong/);
    return true;
  });
});

test("selection rotates past a burned session to a live one", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "burned", cookies: deadCookies() });
  putSession(data, { domain: "resy.com", label: "spare", cookies: liveCookies() });
  assert.equal(selectSession(data, { domain: "resy.com" }).label, "spare");
});

test("when every session for a domain is expired, selection refuses and names them all", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "one", cookies: deadCookies() });
  putSession(data, { domain: "resy.com", label: "two", cookies: deadCookies() });
  assert.throws(() => selectSession(data, { domain: "resy.com" }), (error) => {
    assert.match(error.message, /every stored resy\.com session has expired/);
    assert.match(error.message, /resy\.com\/one/);
    assert.match(error.message, /resy\.com\/two/);
    return true;
  });
});

test("selecting an unknown domain says what the vault does hold", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "tong", cookies: liveCookies() });
  assert.throws(() => selectSession(data, { domain: "opentable.com" }), /have: resy\.com/);
});

test("a session with no expiry anywhere is usable but flagged unknown, not assumed healthy", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "tong", cookies: [cookie("opaque", "n".repeat(40))] });
  assert.equal(listSessions(data)[0].status, "unknown-expiry");
  assert.equal(selectSession(data, { domain: "resy.com" }).label, "tong");
});

test("removing the last session for a domain drops the domain", () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "tong", cookies: liveCookies() });
  assert.deepEqual(removeSession(data, { domain: "resy.com", label: "tong" }), { domain: "resy.com", label: "tong" });
  assert.deepEqual(Object.keys(data.domains), []);
  assert.equal(removeSession(data, { domain: "resy.com", label: "tong" }), null);
});

test("capabilities default to null rather than an optimistic guess", () => {
  const capability = getCapability(emptyVault(), "brand-new-site.com");
  assert.equal(capability.probedAt, null);
  assert.equal(capability.needsTunnel, null);
  assert.equal(capability.verdict, null);
  assert.equal(capability.markers.signedIn, null);
});

test("capability writes merge onto what is already recorded", () => {
  const data = emptyVault();
  putCapability(data, "resy.com", { verdict: "residential-only", needsTunnel: true });
  putCapability(data, "resy.com", { markers: { signedIn: "[data-x]" } });
  const capability = getCapability(data, "resy.com");
  assert.equal(capability.verdict, "residential-only");
  assert.equal(capability.markers.signedIn, "[data-x]");
});

test("the vault refuses to be written inside the repository", () => {
  assert.throws(() => assertOutsideRepo(path.join(process.cwd(), "vault.enc.json")), /inside the repository/);
  assert.throws(() => assertOutsideRepo(path.join(process.cwd(), "fixtures", "v.json")), /inside the repository/);
  assert.ok(assertOutsideRepo(path.join(tmpdir(), "vault.enc.json")));
});

test("the default vault path is outside the working tree", () => {
  assert.ok(assertOutsideRepo(defaultVaultPath({})));
});

test("save -> load round-trips, and the file on disk holds no plaintext", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const vaultPath = path.join(dir, "vault.enc.json");
    const key = newKey();
    const secret = jwtWithExp(nowSeconds() + HOUR);

    const data = emptyVault();
    putSession(data, { domain: "resy.com", label: "tong", cookies: [cookie("auth_token", secret)] });
    await saveVault(data, { vaultPath, key });

    const onDisk = await readFile(vaultPath, "utf8");
    assert.ok(!onDisk.includes(secret), "the token must not appear in the vault file");
    assert.ok(!onDisk.includes("auth_token"), "even cookie names must not appear in plaintext");
    assert.ok(!onDisk.includes("resy.com"), "the domain list must not leak either");

    const reloaded = await loadVault({ vaultPath, key });
    assert.equal(selectSession(reloaded, { domain: "resy.com" }).cookies[0].value, secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a vault that does not exist yet loads as empty rather than throwing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const data = await loadVault({ vaultPath: path.join(dir, "absent.json"), key: newKey() });
    assert.deepEqual(listSessions(data), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the wrong key does not half-open the vault", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const vaultPath = path.join(dir, "vault.enc.json");
    const data = emptyVault();
    putSession(data, { domain: "resy.com", label: "tong", cookies: liveCookies() });
    await saveVault(data, { vaultPath, key: newKey() });
    await assert.rejects(() => loadVault({ vaultPath, key: newKey() }), /wrong key, or the file has been modified/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
