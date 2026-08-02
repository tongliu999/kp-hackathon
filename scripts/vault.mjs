#!/usr/bin/env node
// Provider-agnostic credential and session vault.
//
//   vault list                                  domains, labels, import times, expiry
//   vault show <domain> <label>                 cookie names, lengths, dates
//   vault add <file> --domain d --label l       import an exported session
//   vault rm <domain> <label>
//   vault select <domain> [--label l]           which session would be used, and is it usable
//   vault import <domain> [--label l]           install into the box's browser, then verify
//   vault probe <domain> [--auth-url u]         box vs host, the blocked/broken diagnostic
//   vault probe <domain> --discover             name candidate signed-in markers
//   vault marker <domain> --signed-in <sel>     record the positive marker
//   vault capabilities [<domain>]
//   vault signup <domain> --mailbox you@ours    opt-in, refuses by default
//
// SECRETS. Every line this prints goes through a redactor holding the loaded
// session's values, so a value cannot reach the terminal even by accident.
// Names, byte lengths and dates only.

import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { loadKey } from "../src/vault/keyring.js";
import {
  loadVault, saveVault, defaultVaultPath, putSession, removeSession,
  listSessions, selectSession, getCapability, putCapability,
} from "../src/vault/vault.js";
import { parseCookieText, normalizeCookie } from "../src/vault/cookie_formats.js";
import { normalizeDomain, cookiesForDomain } from "../src/vault/domains.js";
import { summarizeCookies, secretValues, guardedPrinter } from "../src/vault/redact.js";
import { markersFor, probeUrlFor, describeCapability } from "../src/vault/capabilities.js";
import { probeDomain, hostTransport, sailboxTransport, KNOWN_REFRESH_URLS } from "../src/vault/probe.js";
import { installSession, explainFailure } from "../src/vault/install.js";
import { createAccount, SIGNUP_NOT_VIABLE } from "../src/vault/signup.js";
import { describeRemaining } from "../src/vault/expiry.js";

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const has = (name) => argv.includes(`--${name}`);

let print = console.log;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

async function withVault(fn) {
  const vaultPath = defaultVaultPath();
  const { key, source } = await loadKey();
  const data = await loadVault({ vaultPath, key });
  const result = await fn(data, {
    save: () => saveVault(data, { vaultPath, key }),
    vaultPath,
    keySource: source,
  });
  return result;
}

/** Lazy: `list` and `add` must work on a machine with no browser and no SDK. */
async function connectBrowser() {
  const endpoint = process.env.BOOKING_CDP_URL;
  if (!endpoint) {
    fail("BOOKING_CDP_URL is unset — run `node scripts/vnc-start.mjs` first");
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    fail("no browser context in the box");
  }
  return { browser, context };
}

/**
 * The Sailbox gate. Mirrors BOOKING_SAILBOX in scripts/booking_bridge.mjs: real
 * egress is opt-in, so no test run and no accidental invocation reaches the
 * network on its own.
 */
async function findBox() {
  const name = process.env.VAULT_SAILBOX ?? process.env.BOOKING_SAILBOX ?? "";
  if (!name) {
    fail(
      "probing sends real requests from a real Sailbox, so it is opt-in: VAULT_SAILBOX is unset. " +
        "Set VAULT_SAILBOX=booking to opt in."
    );
  }
  const { Sailbox } = await import("@sailresearch/sdk");
  const boxes = await Sailbox.list({ limit: 100 });
  const box = boxes.find((b) => (b.name ?? "") === name && b.status !== "terminated");
  if (!box) fail(`no live Sailbox named "${name}"`);
  return box;
}

function shred(file) {
  try {
    writeFileSync(file, "\0".repeat(statSync(file).size));
    unlinkSync(file);
    print(`${file} overwritten and deleted`);
  } catch (error) {
    console.error(`could not remove ${file}: ${error.message} — delete it by hand`);
  }
}

const COMMANDS = {
  async list() {
    await withVault((data) => {
      const rows = listSessions(data);
      if (rows.length === 0) return print("vault is empty");
      const width = (pick) => Math.max(...rows.map((r) => String(pick(r)).length), 6);
      const dw = width((r) => r.domain);
      const lw = width((r) => r.label);
      print(
        `${"DOMAIN".padEnd(dw)}  ${"LABEL".padEnd(lw)}  ${"IMPORTED".padEnd(20)}  ${"EXPIRES".padEnd(20)}  STATUS`
      );
      for (const r of rows) {
        print(
          `${r.domain.padEnd(dw)}  ${r.label.padEnd(lw)}  ${r.importedAt.slice(0, 19).padEnd(20)}  ` +
            `${(r.expiresAt?.slice(0, 19) ?? "unknown").padEnd(20)}  ${r.status} (${r.remaining})`
        );
      }
    });
  },

  async show() {
    const [, domain, label] = argv;
    if (!domain || !label) fail("usage: vault show <domain> <label>");
    await withVault((data) => {
      const record = selectSession(data, { domain, label });
      print = guardedPrinter(secretValues(record.cookies));
      print(`${record.domain}/${record.label}`);
      print(`  imported ${record.importedAt}`);
      print(`  expires  ${record.expiresAt ?? "unknown"} (${record.expirySource}, ${describeRemaining(record.expiresAt)})`);
      print(`  mailbox  ${record.account?.mailbox ?? "not recorded"} (${record.account?.origin})`);
      print(`  cookies  ${record.cookieCount}`);
      for (const c of summarizeCookies(record.cookies)) {
        print(`    ${c.name}  ${c.bytes}b  ${c.httpOnly ? "httpOnly" : "js-readable"}  expires ${c.expires ?? "session"}`);
      }
    });
  },

  async add() {
    const file = argv[1];
    const domain = flag("domain");
    const label = flag("label");
    if (!file || file.startsWith("--") || !domain || !label) {
      fail("usage: vault add <cookies.json> --domain <domain> --label <label> [--mailbox <you@ours>] [--forget]");
    }
    const raw = parseCookieText(readFileSync(file, "utf8")).map(normalizeCookie);
    const scoped = cookiesForDomain(raw, domain);
    if (scoped.length === 0) fail(`no cookies for ${domain} in ${file} (file held ${raw.length} for other domains)`);

    await withVault(async (data, { save, vaultPath, keySource }) => {
      const record = putSession(data, { domain, label, cookies: scoped, mailbox: flag("mailbox") });
      await save();
      print = guardedPrinter(secretValues(record.cookies));
      print(`stored ${record.domain}/${record.label}: ${record.cookieCount} cookies`);
      print(`  names   ${record.cookieNames.join(", ")}`);
      print(`  expires ${record.expiresAt ?? "unknown"} (${record.expirySource})`);
      print(`  vault   ${vaultPath} (encrypted, key from ${keySource})`);
      print(`\nnext: node scripts/vault.mjs import ${record.domain} --label ${record.label}`);
    });
    if (has("forget")) shred(file);
  },

  async rm() {
    const [, domain, label] = argv;
    if (!domain || !label) fail("usage: vault rm <domain> <label>");
    await withVault(async (data, { save }) => {
      const removed = removeSession(data, { domain, label });
      if (!removed) fail(`no session ${domain}/${label}`);
      await save();
      print(`removed ${removed.domain}/${removed.label}`);
    });
  },

  async select() {
    const domain = argv[1];
    if (!domain) fail("usage: vault select <domain> [--label <label>]");
    await withVault((data) => {
      const record = selectSession(data, { domain, label: flag("label") });
      print(`${record.domain}/${record.label} — imported ${record.importedAt}, expires ${record.expiresAt ?? "unknown"} (${describeRemaining(record.expiresAt)})`);
    });
  },

  async import() {
    const domain = argv[1];
    if (!domain) fail("usage: vault import <domain> [--label <label>] [--probe-url <url>]");
    await withVault(async (data) => {
      const record = selectSession(data, { domain, label: flag("label") });
      const capability = getCapability(data, domain);
      const probeUrl = flag("probe-url") ?? probeUrlFor(domain, capability);
      const markers = markersFor(domain, capability);
      print = guardedPrinter(secretValues(record.cookies));

      print(`installing ${record.domain}/${record.label} (${record.cookieCount} cookies) into the box`);
      if (capability.needsTunnel) {
        print(`note: ${record.domain} ${describeCapability(capability)}`);
      }

      const { browser, context } = await connectBrowser();
      try {
        const { state, detail, installed } = await installSession(context, record, { probeUrl, markers });
        print(`${installed} cookies installed into the box's persistent profile`);
        if (state === "authenticated") {
          print(`\nAUTHENTICATED — ${record.domain} accepts the session. (${detail})`);
        } else {
          print(`\n${explainFailure(state, { domain: record.domain, label: record.label, capability })}\n(${detail})`);
          process.exitCode = 1;
        }
      } finally {
        await browser.close().catch(() => {});
      }
    });
  },

  async probe() {
    const domain = argv[1];
    if (!domain) fail("usage: vault probe <domain> [--auth-url <url>] [--origin <origin>] | --discover");

    if (has("discover")) {
      const { discoverMarkers } = await import("../src/vault/sessionCheck.js");
      await withVault(async (data) => {
        const probeUrl = flag("probe-url") ?? probeUrlFor(domain, getCapability(data, domain));
        if (!probeUrl) fail(`no probe URL for ${domain} — pass --probe-url`);
        const { browser, context } = await connectBrowser();
        try {
          const candidates = await discoverMarkers(context, { probeUrl, domain: normalizeDomain(domain) });
          print(`candidate markers on ${probeUrl}:`);
          for (const c of candidates) print(`  ${c.selector}  x${c.count}`);
          print(
            "\nRun this against a session you KNOW is logged in, pick the selector that appears only when\n" +
              `signed in, then record it:\n  node scripts/vault.mjs marker ${domain} --signed-in '<selector>'`
          );
        } finally {
          await browser.close().catch(() => {});
        }
      });
      return;
    }

    const box = await findBox();
    await withVault(async (data, { save }) => {
      const patch = await probeDomain(domain, {
        authUrl: flag("auth-url"),
        origin: flag("origin"),
        box: sailboxTransport(box),
        host: hostTransport(),
      });
      const refresh = KNOWN_REFRESH_URLS[normalizeDomain(domain)] ?? null;
      putCapability(data, domain, { ...patch, refresh: refresh ? { endpoint: refresh, observed: false } : null });
      await save();

      print(`probe ${patch.authUrl}`);
      print(`  box   ${JSON.stringify(patch.evidence.box)}`);
      print(`  host  ${JSON.stringify(patch.evidence.host)}`);
      print(`\n${patch.verdict}: ${patch.summary}`);
      if (patch.needsTunnel) {
        print(
          "\nThe box needs residential egress for auth on this domain:\n" +
            "  ssh -N -R 1080 booking.sail\n" +
            "  chromium --proxy-server=socks5://127.0.0.1:1080"
        );
      }
      if (refresh) {
        print(`\nrefresh endpoint on record: ${refresh} — a session that cannot reach it never activates`);
      }
    });
  },

  async marker() {
    const domain = argv[1];
    const signedIn = flag("signed-in");
    if (!domain || !signedIn) fail("usage: vault marker <domain> --signed-in <selector> [--logged-out <sel>] [--hydrated <sel>]");
    await withVault(async (data, { save }) => {
      const current = getCapability(data, domain);
      putCapability(data, domain, {
        markers: {
          ...current.markers,
          signedIn,
          loggedOut: flag("logged-out") ?? current.markers.loggedOut,
          hydrated: flag("hydrated") ?? current.markers.hydrated,
          discoveredAt: new Date().toISOString(),
        },
        probeUrl: flag("probe-url") ?? current.probeUrl ?? null,
      });
      await save();
      print(`recorded signed-in marker for ${normalizeDomain(domain)}`);
    });
  },

  async capabilities() {
    const domain = argv[1];
    await withVault((data) => {
      const domains = domain ? [normalizeDomain(domain)] : Object.keys(data.capabilities ?? {});
      if (domains.length === 0) return print("no domain has been probed yet");
      for (const d of domains) {
        const capability = getCapability(data, d);
        const markers = markersFor(d, capability);
        print(`${d}`);
        print(`  auth      ${describeCapability(capability)}`);
        print(`  probed    ${capability.probedAt ?? "never"}${capability.authUrl ? ` (${capability.authUrl})` : ""}`);
        print(`  refresh   ${capability.refresh?.endpoint ?? "unknown"}`);
        print(`  signed-in ${markers.signedIn ?? "NOT RECORDED — cannot report authenticated for this domain"}`);
      }
    });
  },

  async signup() {
    const domain = argv[1];
    if (!domain) fail("usage: vault signup <domain> --mailbox <you@a-domain-you-own>");
    const known = SIGNUP_NOT_VIABLE[normalizeDomain(domain)];
    if (known) print(`note: ${normalizeDomain(domain)} — ${known}\n`);
    await withVault(async (data, { save }) => {
      const existing = Object.keys(data.domains[normalizeDomain(domain)]?.sessions ?? {});
      const { cookies, account } = await createAccount({
        domain,
        mailbox: flag("mailbox"),
        existingLabels: existing,
      });
      const record = putSession(data, {
        domain,
        label: flag("label") ?? account.mailbox.split("@")[0],
        cookies: cookies.map(normalizeCookie),
        mailbox: account.mailbox,
        accountOrigin: account.origin,
      });
      await save();
      print(`created ${record.domain}/${record.label} for mailbox ${account.mailbox}`);
    });
  },
};

const handler = COMMANDS[command];
if (!handler) {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}

try {
  await handler();
} catch (error) {
  fail(error.message);
}
