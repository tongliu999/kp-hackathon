import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyVault } from "../../vault/vault.js";
import { AuthService } from "../service.js";

const now = new Date("2030-01-01T00:00:00.000Z");

test("service snapshots contain provider and credential metadata but no secrets", async () => {
  const data = emptyVault();
  let saves = 0;
  const service = new AuthService({
    data,
    now: () => now,
    env: { GITHUB_OAUTH_CLIENT_ID: "configured-client" },
    save: async () => { saves += 1; },
  });
  const credential = await service.addCredential({
    provider: "github", account: "octocat", type: "oauth2",
    domains: ["api.github.com", "github.com"], scopes: ["read:user"],
    material: { accessToken: "top-secret-access-token", refreshToken: "top-secret-refresh-token" },
    expiresAt: "2030-01-01T02:00:00Z",
  });
  const snapshot = service.snapshot();
  assert.equal(snapshot.providers.find((provider) => provider.id === "github").configured, true);
  assert.equal(snapshot.accounts[0].id, credential.id);
  assert.equal(saves, 1);
  assert.ok(!JSON.stringify(snapshot).includes("top-secret"));
});

test("service creates and immediately revokes scoped grants", async () => {
  const data = emptyVault();
  const service = new AuthService({ data, now: () => now });
  const credential = await service.addCredential({
    provider: "github", account: "octocat", type: "oauth2",
    domains: ["api.github.com"], scopes: ["read:user"],
    material: { accessToken: "top-secret-access-token" }, expiresAt: "2030-01-01T02:00:00Z",
  });
  const grant = await service.grant({
    credentialId: credential.id, runId: "console-run", domains: ["api.github.com"],
    scopes: ["read:user"], actions: ["read"],
  });
  assert.equal(grant.status, "active");
  assert.equal((await service.revokeGrant(grant.id)).status, "revoked");
});

test("provider health check never returns provider payload or access tokens", async () => {
  const data = emptyVault();
  const service = new AuthService({
    data,
    now: () => now,
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ login: "octocat", private: "provider-payload" }); } }),
  });
  const credential = await service.addCredential({
    provider: "github", account: "octocat", type: "oauth2",
    domains: ["api.github.com", "github.com"], scopes: ["read:user", "repo:status"],
    material: { accessToken: "top-secret-access-token" }, expiresAt: "2030-01-01T02:00:00Z",
  });
  const result = await service.check(credential.id);
  assert.equal(result.status, "healthy");
  assert.ok(!JSON.stringify(result).includes("top-secret"));
  assert.ok(!JSON.stringify(result).includes("provider-payload"));
});
