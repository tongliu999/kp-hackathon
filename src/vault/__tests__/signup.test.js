// Account creation is refused by default. These tests pin each gate open-eyed,
// so that removing one is a visible, deliberate act rather than a quiet drift.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerSignupAdapter, clearSignupAdapters, createAccount, signupEnabledFor,
  mailboxIsControlled, MAX_ACCOUNTS_PER_DOMAIN, SIGNUP_NOT_VIABLE,
} from "../signup.js";
import { cookie } from "./fakes.js";

const OURS = "ours.test";
const ENABLED = { KP_VAULT_SIGNUP_DOMAINS: "friendly.test" };

function adapter(overrides = {}) {
  return registerSignupAdapter({
    domain: "friendly.test",
    termsPermitAdditionalAccounts: true,
    smsRequired: false,
    mailboxDomains: [OURS],
    async createAccount() {
      return { cookies: [cookie("sid", "s".repeat(40), { domain: ".friendly.test" })] };
    },
    ...overrides,
  });
}

beforeEach(() => clearSignupAdapters());

test("with no adapter, signup is refused and the human path is named", async () => {
  await assert.rejects(
    () => createAccount({ domain: "resy.com", mailbox: `a@${OURS}`, env: ENABLED }),
    (error) => {
      assert.match(error.message, /not supported for resy\.com/);
      assert.match(error.message, /human logging in on their own machine/);
      return true;
    }
  );
});

test("an adapter alone is not enough — the domain must be opted in", async () => {
  adapter();
  await assert.rejects(
    () => createAccount({ domain: "friendly.test", mailbox: `a@${OURS}`, env: {} }),
    /never a default/
  );
});

test("an SMS gate refuses, because automating it would need a real phone", async () => {
  adapter({ smsRequired: true });
  await assert.rejects(
    () => createAccount({ domain: "friendly.test", mailbox: `a@${OURS}`, env: ENABLED }),
    /gates signup behind an SMS step/
  );
});

test("terms that do not permit additional accounts refuse", async () => {
  adapter({ termsPermitAdditionalAccounts: false });
  await assert.rejects(
    () => createAccount({ domain: "friendly.test", mailbox: `a@${OURS}`, env: ENABLED }),
    /does not assert that additional accounts are permitted/
  );
});

test("a mailbox on a domain we do not control refuses — no fabricated identities", async () => {
  adapter();
  for (const mailbox of [undefined, "", "someone@gmail.com", `a@evil${OURS}`]) {
    await assert.rejects(
      () => createAccount({ domain: "friendly.test", mailbox, env: ENABLED }),
      /must belong to a real mailbox on a domain the team controls/
    );
  }
});

test("the refusal message does not echo the rejected mailbox's local part", async () => {
  adapter();
  await assert.rejects(
    () => createAccount({ domain: "friendly.test", mailbox: "private.person@gmail.com", env: ENABLED }),
    (error) => {
      assert.ok(!error.message.includes("private.person"));
      return true;
    }
  );
});

test("a successful signup records the real mailbox it belongs to", async () => {
  adapter();
  const result = await createAccount({ domain: "friendly.test", mailbox: `booker@${OURS}`, env: ENABLED });
  assert.equal(result.account.mailbox, `booker@${OURS}`);
  assert.equal(result.account.origin, "adapter:friendly.test");
  assert.equal(result.cookies.length, 1);
});

test("bulk generation is capped — these accounts hold real inventory", async () => {
  adapter();
  const existingLabels = Array.from({ length: MAX_ACCOUNTS_PER_DOMAIN }, (_, i) => `acct${i}`);
  await assert.rejects(
    () => createAccount({ domain: "friendly.test", mailbox: `a@${OURS}`, env: ENABLED, existingLabels }),
    /at the cap of/
  );
});

test("an adapter that returns no cookies is a failed signup, not a stored empty session", async () => {
  adapter({ async createAccount() { return { cookies: [] }; } });
  await assert.rejects(
    () => createAccount({ domain: "friendly.test", mailbox: `a@${OURS}`, env: ENABLED }),
    /returned no session cookies/
  );
});

test("an adapter must state its SMS and terms position explicitly", () => {
  assert.throws(
    () => registerSignupAdapter({ domain: "x.test", mailboxDomains: [OURS], createAccount() {} }),
    /must state termsPermitAdditionalAccounts explicitly/
  );
  assert.throws(
    () => registerSignupAdapter({
      domain: "x.test", termsPermitAdditionalAccounts: true, smsRequired: false, createAccount() {},
    }),
    /must list the mail domains the team controls/
  );
});

test("opt-in is read per domain from the environment", () => {
  assert.equal(signupEnabledFor("a.test", { KP_VAULT_SIGNUP_DOMAINS: "a.test, b.test" }), true);
  assert.equal(signupEnabledFor("c.test", { KP_VAULT_SIGNUP_DOMAINS: "a.test, b.test" }), false);
  assert.equal(signupEnabledFor("a.test", {}), false);
});

test("mailbox ownership is an exact domain match, not a suffix match", () => {
  assert.equal(mailboxIsControlled(`a@${OURS}`, [OURS]), true);
  assert.equal(mailboxIsControlled(`a@evil-${OURS}`, [OURS]), false);
  assert.equal(mailboxIsControlled(`a@sub.${OURS}`, [OURS]), false);
});

test("Resy stays on record as not viable, so the question is not re-opened", () => {
  assert.match(SIGNUP_NOT_VIABLE["resy.com"], /phone verification/);
});
