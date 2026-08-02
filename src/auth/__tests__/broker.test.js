import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyVault } from "../../vault/vault.js";
import {
  createCredential, credentialSecretValues, listCredentials,
  resolveCredential, revokeCredential,
} from "../broker.js";
import { createGrant } from "../grants.js";
import { listAudit } from "../audit.js";

const now = new Date("2030-01-01T00:00:00.000Z");
let counter = 0;
const idFactory = () => `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`;

function oauthCredential(data, overrides = {}) {
  return createCredential(data, {
    provider: "github",
    account: "founder@example.test",
    type: "oauth2",
    domains: ["api.github.com", "github.com"],
    scopes: ["read:user", "repo:status"],
    material: { accessToken: "access-token-super-secret", refreshToken: "refresh-token-super-secret" },
    expiresAt: "2030-01-01T02:00:00.000Z",
    now,
    idFactory,
    ...overrides,
  });
}

test("the broker exposes opaque metadata but never credential material", () => {
  const data = emptyVault();
  const credential = oauthCredential(data);
  const serialized = JSON.stringify({ credential, list: listCredentials(data), audit: listAudit(data) });
  assert.match(credential.id, /^auth_[a-f0-9]+$/);
  assert.equal(credential.refreshable, true);
  assert.ok(!serialized.includes("access-token-super-secret"));
  assert.ok(!serialized.includes("refresh-token-super-secret"));
  assert.deepEqual(credentialSecretValues(data.auth.credentials[credential.id]).sort(), ["access-token-super-secret", "refresh-token-super-secret"]);
});

test("all supported credential types validate and list safely", () => {
  const data = emptyVault();
  createCredential(data, { provider: "internal", account: "key", type: "api_key", domains: ["api.example.com"], material: { apiKey: "apikey-secret-value" }, now, idFactory });
  createCredential(data, { provider: "internal", account: "bearer", type: "bearer_token", domains: ["api.example.com"], material: { accessToken: "bearer-secret-value" }, now, idFactory });
  createCredential(data, { provider: "browser", account: "session", type: "browser_session", domains: ["example.com"], material: { cookies: [{ name: "sid", value: "cookie-secret-value", domain: ".example.com" }] }, now, idFactory });
  assert.deepEqual(listCredentials(data).map((item) => item.type), ["browser_session", "bearer_token", "api_key"]);
  assert.throws(() => createCredential(data, { provider: "x", account: "x", type: "password", domains: ["x.test"], material: {}, now }), /unsupported/);
});

test("credential resolution requires an exact run, branch, domain, scope, and action grant", () => {
  const data = emptyVault();
  const credential = oauthCredential(data);
  const grant = createGrant(data, {
    credentialId: credential.id,
    runId: "run-1",
    branchId: "b0",
    domains: ["api.github.com"],
    scopes: ["read:user"],
    actions: ["read"],
    now,
    idFactory,
  });
  const resolved = resolveCredential(data, {
    credentialId: credential.id, grantId: grant.id, runId: "run-1", branchId: "b0",
    domain: "api.github.com", scope: "read:user", action: "read", now,
  });
  assert.equal(resolved.headers.authorization, "Bearer access-token-super-secret");
  assert.throws(() => resolveCredential(data, {
    credentialId: credential.id, grantId: grant.id, runId: "run-1", branchId: "b1",
    domain: "api.github.com", scope: "read:user", action: "read", now,
  }), /branch/);
  assert.throws(() => resolveCredential(data, {
    credentialId: credential.id, grantId: grant.id, runId: "run-1", branchId: "b0",
    domain: "evil.test", scope: "read:user", action: "read", now,
  }), /domain/);
});

test("write grants require confirmation, are single use, and revoke with the credential", () => {
  const data = emptyVault();
  const credential = oauthCredential(data);
  const input = {
    credentialId: credential.id, runId: "run-write", domains: ["api.github.com"],
    scopes: ["read:user"], actions: ["send"], now, idFactory,
  };
  assert.throws(() => createGrant(data, input), /confirmation/);
  const grant = createGrant(data, { ...input, confirmed: true });
  resolveCredential(data, {
    credentialId: credential.id, grantId: grant.id, runId: "run-write",
    domain: "api.github.com", scope: "read:user", action: "send", now,
  });
  assert.throws(() => resolveCredential(data, {
    credentialId: credential.id, grantId: grant.id, runId: "run-write",
    domain: "api.github.com", scope: "read:user", action: "send", now,
  }), /consumed/);
  revokeCredential(data, credential.id, now);
  assert.throws(() => resolveCredential(data, {
    credentialId: credential.id, grantId: grant.id, runId: "run-write",
    domain: "api.github.com", scope: "read:user", action: "send", now,
  }), /revoked/);
});

test("audit records contain metadata only", () => {
  const data = emptyVault();
  const credential = oauthCredential(data);
  const audit = JSON.stringify(listAudit(data));
  assert.match(audit, new RegExp(credential.id));
  assert.ok(!audit.includes("super-secret"));
});
