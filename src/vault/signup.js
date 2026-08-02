// Automated account creation. Off by default, and narrow on purpose.
//
// It is viable ONLY where the team controls the identity: a mailbox on a domain
// we own, for a site whose terms permit additional accounts, and where no SMS
// step exists. Everything else is a human logging in on their own machine and
// importing the session -- that is the supported path, not a fallback.
//
// WHAT THIS DELIBERATELY DOES NOT DO, so nobody adds it later thinking it was
// an oversight:
//
//   * No fabricated identities. Every account is bound to a real mailbox on a
//     domain we control, recorded on the session, and there is no name/DOB/
//     address generator anywhere in this module.
//   * No bulk generation. One account per call, capped per domain. Most sites
//     gate signup behind SMS (Resy does), extra accounts are against typical
//     terms of service, and on booking sites the accounts hold real inventory:
//     a no-show is a real cost to a real business.
//
// Each gate below refuses with its own message, because "signup refused" with
// no reason is what makes someone go looking for a way round it.

import { normalizeDomain } from "./domains.js";

/** Rotation needs a couple of accounts. Anything past that is bulk. */
export const MAX_ACCOUNTS_PER_DOMAIN = 3;

const ADAPTERS = new Map();

/**
 * @param {object} adapter
 * @param {string} adapter.domain
 * @param {boolean} adapter.termsPermitAdditionalAccounts  asserted by a human who read them
 * @param {boolean} adapter.smsRequired                    measured against the real signup flow
 * @param {string[]} adapter.mailboxDomains                mail domains the team owns
 * @param {(opts:{mailbox:string}) => Promise<{cookies:object[]}>} adapter.createAccount
 */
export function registerSignupAdapter(adapter) {
  const domain = normalizeDomain(adapter?.domain);
  for (const field of ["termsPermitAdditionalAccounts", "smsRequired"]) {
    if (typeof adapter[field] !== "boolean") {
      throw new TypeError(`signup adapter for ${domain} must state ${field} explicitly as a boolean`);
    }
  }
  if (!Array.isArray(adapter.mailboxDomains) || adapter.mailboxDomains.length === 0) {
    throw new TypeError(`signup adapter for ${domain} must list the mail domains the team controls`);
  }
  if (typeof adapter.createAccount !== "function") {
    throw new TypeError(`signup adapter for ${domain} must implement createAccount()`);
  }
  ADAPTERS.set(domain, { ...adapter, domain });
  return ADAPTERS.get(domain);
}

export function getSignupAdapter(domain) {
  return ADAPTERS.get(normalizeDomain(domain)) ?? null;
}

export function clearSignupAdapters() {
  ADAPTERS.clear();
}

/** Opt-in is per domain and lives in the environment, never in code. */
export function signupEnabledFor(domain, env = process.env) {
  const enabled = String(env.KP_VAULT_SIGNUP_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return enabled.includes(normalizeDomain(domain));
}

export function mailboxIsControlled(mailbox, mailboxDomains) {
  const at = String(mailbox ?? "").lastIndexOf("@");
  if (at < 1) return false;
  const host = mailbox.slice(at + 1).toLowerCase();
  return mailboxDomains.some((d) => host === d.toLowerCase());
}

/**
 * @returns {Promise<{cookies: object[], account: {mailbox: string, origin: string}}>}
 */
export async function createAccount({ domain, mailbox, existingLabels = [], env = process.env, now = new Date() }) {
  const key = normalizeDomain(domain);

  const adapter = getSignupAdapter(key);
  if (!adapter) {
    throw new Error(
      `automated signup is not supported for ${key}. The supported path is a human logging in on ` +
        `their own machine and importing the session:\n` +
        `  node scripts/vault.mjs add <cookies.json> --domain ${key} --label <who> --forget`
    );
  }

  if (!signupEnabledFor(key, env)) {
    throw new Error(
      `automated signup for ${key} is not opted in. It is never a default. ` +
        `Set KP_VAULT_SIGNUP_DOMAINS=${key} only if you have confirmed the terms permit it.`
    );
  }

  if (adapter.smsRequired) {
    throw new Error(
      `${key} gates signup behind an SMS step, so it cannot be automated without a real phone. ` +
        "Have a human sign up and import the session instead."
    );
  }

  if (!adapter.termsPermitAdditionalAccounts) {
    throw new Error(
      `the ${key} adapter does not assert that additional accounts are permitted by its terms. ` +
        "Signup refused."
    );
  }

  if (!mailboxIsControlled(mailbox, adapter.mailboxDomains)) {
    throw new Error(
      `every automated account must belong to a real mailbox on a domain the team controls ` +
        `(${adapter.mailboxDomains.join(", ")}). Got: ${mailbox ? `@${String(mailbox).split("@").pop()}` : "no mailbox"}`
    );
  }

  if (existingLabels.length >= MAX_ACCOUNTS_PER_DOMAIN) {
    throw new Error(
      `${key} already has ${existingLabels.length} accounts (${existingLabels.join(", ")}), at the cap of ` +
        `${MAX_ACCOUNTS_PER_DOMAIN}. The cap exists because these accounts hold real inventory; ` +
        "retire one before creating another."
    );
  }

  const result = await adapter.createAccount({ mailbox });
  if (!Array.isArray(result?.cookies) || result.cookies.length === 0) {
    throw new Error(`the ${key} signup adapter returned no session cookies; treating the signup as failed`);
  }

  return {
    cookies: result.cookies,
    account: { mailbox: String(mailbox), origin: `adapter:${key}`, createdAt: now.toISOString() },
  };
}

/**
 * Domains examined and ruled out, kept so the question is not re-opened by
 * someone assuming nobody checked.
 */
export const SIGNUP_NOT_VIABLE = {
  "resy.com":
    "signup requires phone verification (/4/auth/mobile), and that endpoint is blocked from Sail's " +
    "egress anyway. Human login + session import is the only path.",
};
