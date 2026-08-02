import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyVault } from "../../vault/vault.js";
import { createCredential } from "../broker.js";
import { createGrant } from "../grants.js";
import { credentialHealth, refreshCredential, rotateCredential } from "../lifecycle.js";
import { checkProvider } from "../provider_check.js";

const now = new Date("2030-01-01T00:00:00.000Z");
let counter = 300;
const idFactory = () => `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`;

function credential(data, { provider = "github", account = "a", expiresAt = "2030-01-01T00:05:00.000Z", scopes = ["read:user", "repo:status"] } = {}) {
  return createCredential(data, {
    provider, account, type: "oauth2",
    domains: provider === "google" ? ["googleapis.com"] : ["api.github.com", "github.com"],
    scopes,
    material: { accessToken: `access-token-${account}`, refreshToken: `refresh-token-${account}` },
    expiresAt, now, idFactory,
  });
}

test("health distinguishes expiring, expired, revoked, and healthy credentials", () => {
  const data = emptyVault();
  const expiring = credential(data);
  assert.equal(credentialHealth(data.auth.credentials[expiring.id], now, 600).status, "expiring");
  assert.equal(credentialHealth(data.auth.credentials[expiring.id], new Date("2030-01-01T00:06:00Z")).status, "expired");
  data.auth.credentials[expiring.id].revokedAt = now.toISOString();
  assert.equal(credentialHealth(data.auth.credentials[expiring.id], now).status, "revoked");
});

test("concurrent refresh calls share one provider exchange", async () => {
  const data = emptyVault();
  const item = credential(data);
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { accessToken: "new-access-token", refreshToken: "new-refresh-token", expiresAt: "2030-01-01T03:00:00Z" };
  };
  const [a, b] = await Promise.all([
    refreshCredential(data, { credentialId: item.id, refresh, now, force: true }),
    refreshCredential(data, { credentialId: item.id, refresh, now, force: true }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.expiresAt, b.expiresAt);
});

test("invalid refresh revokes the credential and rotation is deterministic", async () => {
  const data = emptyVault();
  const first = credential(data, { account: "alpha", expiresAt: "2030-01-01T02:00:00Z" });
  const second = credential(data, { account: "beta", expiresAt: "2030-01-01T02:00:00Z" });
  assert.equal(rotateCredential(data, { provider: "github", now }).id, first.id);
  data.auth.credentials[first.id].lastUsedAt = "2030-01-01T00:01:00Z";
  assert.equal(rotateCredential(data, { provider: "github", now }).id, second.id);
  await assert.rejects(() => refreshCredential(data, {
    credentialId: second.id, force: true, now,
    refresh: async () => { throw new Error("invalid_grant: refresh token revoked"); },
  }), /invalid_grant/);
  assert.ok(data.auth.credentials[second.id].revokedAt);
});

test("GitHub and Google checks use scoped broker headers and normalize provider errors", async () => {
  for (const provider of ["github", "google"]) {
    const data = emptyVault();
    const scopes = provider === "github"
      ? ["read:user", "repo:status"]
      : ["openid", "https://www.googleapis.com/auth/calendar.readonly"];
    const item = credential(data, { provider, scopes, expiresAt: "2030-01-01T02:00:00Z" });
    const grant = createGrant(data, {
      credentialId: item.id, runId: "check", domains: data.auth.credentials[item.id].domains,
      scopes, actions: ["read"], maxUses: 4, now, idFactory,
    });
    const calls = [];
    const result = await checkProvider(data, {
      credentialId: item.id, grantId: grant.id, runId: "check", provider, now,
      fetchImpl: async (url, options) => {
        calls.push({ url, authorization: options.headers.authorization });
        return { ok: true, status: 200, async json() { return {}; } };
      },
    });
    assert.equal(result.status, "healthy");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.authorization.startsWith("Bearer access-token-")));
  }
});

test("provider failures become stable auth error codes without returning provider payloads", async () => {
  const data = emptyVault();
  const item = credential(data, { expiresAt: "2030-01-01T02:00:00Z" });
  const grant = createGrant(data, {
    credentialId: item.id, runId: "check", domains: ["api.github.com", "github.com"],
    scopes: ["read:user", "repo:status"], actions: ["read"], maxUses: 4, now, idFactory,
  });
  await assert.rejects(() => checkProvider(data, {
    credentialId: item.id, grantId: grant.id, runId: "check", provider: "github", now,
    fetchImpl: async () => ({ ok: false, status: 403, async json() { return { message: "private provider detail" }; } }),
  }), (error) => {
    assert.equal(error.code, "insufficient_scope");
    return true;
  });
});
