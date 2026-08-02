import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyVault } from "../../vault/vault.js";
import {
  completeAuthorizationCode, denyOAuthAttempt, pollDeviceCode,
  startAuthorizationCode, startDeviceCode,
} from "../oauth.js";

const now = new Date("2030-01-01T00:00:00.000Z");
const later = new Date("2030-01-01T00:01:00.000Z");
let counter = 100;
const idFactory = () => `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`;
const randomBytesFn = (size) => Buffer.alloc(size, counter % 255);

test("authorization-code flow emits PKCE metadata without exposing verifier, state, or nonce", () => {
  const data = emptyVault();
  const attempt = startAuthorizationCode(data, {
    provider: "google", clientId: "client", redirectUri: "http://localhost/callback",
    scopes: ["openid", "email"], now, idFactory, randomBytesFn,
  });
  assert.match(attempt.authorizationUrl, /code_challenge=/);
  assert.match(attempt.authorizationUrl, /code_challenge_method=S256/);
  assert.match(attempt.authorizationUrl, /state=/);
  assert.equal(attempt.verifier, undefined);
  assert.equal(attempt.state, undefined);
  assert.equal(attempt.nonce, undefined);
});

test("state mismatch and expired authorization attempts fail closed", async () => {
  const data = emptyVault();
  const publicAttempt = startAuthorizationCode(data, {
    provider: "github", clientId: "client", redirectUri: "http://localhost/callback",
    scopes: ["read:user"], now, ttlSeconds: 30, idFactory, randomBytesFn,
  });
  const internal = data.auth.oauthAttempts[publicAttempt.id];
  await assert.rejects(() => completeAuthorizationCode(data, {
    attemptId: publicAttempt.id, state: "wrong", code: "code", exchange: async () => ({}), now: later,
  }), /expired/);
  const next = startAuthorizationCode(data, {
    provider: "github", clientId: "client", redirectUri: "http://localhost/callback",
    scopes: ["read:user"], now, idFactory, randomBytesFn,
  });
  await assert.rejects(() => completeAuthorizationCode(data, {
    attemptId: next.id, state: `${internal.state}-wrong`, code: "code", exchange: async () => ({}), now,
  }), /state mismatch/);
});

test("a successful code exchange stores an OAuth credential and scrubs one-time secrets", async () => {
  const data = emptyVault();
  const attempt = startAuthorizationCode(data, {
    provider: "github", clientId: "client", redirectUri: "http://localhost/callback",
    scopes: ["read:user"], now, idFactory, randomBytesFn,
  });
  const state = data.auth.oauthAttempts[attempt.id].state;
  const result = await completeAuthorizationCode(data, {
    attemptId: attempt.id, state, code: "one-time-code", now, idFactory,
    exchange: async ({ codeVerifier }) => {
      assert.ok(codeVerifier.length > 40);
      return { accessToken: "github-access-token", refreshToken: "github-refresh-token", scopes: ["read:user"], account: "octocat" };
    },
  });
  assert.equal(result.attempt.status, "connected");
  assert.equal(result.credential.account, "octocat");
  assert.equal(data.auth.oauthAttempts[attempt.id].verifier, undefined);
  assert.ok(!JSON.stringify(result).includes("github-access-token"));
});

test("device flow supports pending, denial, and success", async () => {
  const data = emptyVault();
  const attempt = await startDeviceCode(data, {
    provider: "github", clientId: "client", scopes: ["read:user"], now, idFactory,
    authorize: async () => ({ deviceCode: "device-secret-code", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", interval: 5, expiresIn: 900 }),
  });
  const pending = new Error("pending"); pending.code = "authorization_pending";
  assert.equal((await pollDeviceCode(data, { attemptId: attempt.id, exchange: async () => { throw pending; }, now })).status, "pending");
  const result = await pollDeviceCode(data, {
    attemptId: attempt.id, now, idFactory,
    exchange: async () => ({ accessToken: "device-access-token", scopes: ["read:user"], account: "device-user" }),
  });
  assert.equal(result.attempt.status, "connected");
  assert.equal(data.auth.oauthAttempts[attempt.id].deviceCode, undefined);

  const deniedAttempt = await startDeviceCode(data, {
    provider: "github", clientId: "client", scopes: ["read:user"], now, idFactory,
    authorize: async () => ({ deviceCode: "another-device-secret", userCode: "IJKL-MNOP", verificationUri: "https://github.com/login/device" }),
  });
  assert.equal(denyOAuthAttempt(data, deniedAttempt.id).status, "denied");
});
