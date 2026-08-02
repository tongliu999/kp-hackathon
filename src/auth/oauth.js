import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createCredential } from "./broker.js";
import { recordAudit } from "./audit.js";
import { getProvider } from "./providers.js";
import { ensureAuthState, iso, uniqueStrings } from "./state.js";

function opaque(prefix, idFactory) {
  return `${prefix}_${idFactory().replaceAll("-", "")}`;
}

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function publicOAuthAttempt(attempt, now = new Date()) {
  const expired = new Date(attempt.expiresAt) <= new Date(now);
  return {
    id: attempt.id,
    provider: attempt.provider,
    flow: attempt.flow,
    scopes: [...attempt.scopes],
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    status: expired && attempt.status === "pending" ? "expired" : attempt.status,
    authorizationUrl: attempt.authorizationUrl ?? null,
    verificationUri: attempt.verificationUri ?? null,
    userCode: attempt.userCode ?? null,
    interval: attempt.interval ?? null,
    credentialId: attempt.credentialId ?? null,
  };
}

export function startAuthorizationCode(data, {
  provider: providerId, clientId, redirectUri, scopes,
  now = new Date(), ttlSeconds = 600, idFactory = randomUUID,
  randomBytesFn = randomBytes,
}) {
  if (!clientId) throw new Error(`${providerId} OAuth is not configured`);
  const provider = getProvider(providerId);
  const auth = ensureAuthState(data);
  const verifier = b64url(randomBytesFn(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytesFn(24));
  const nonce = b64url(randomBytesFn(24));
  const requestedScopes = uniqueStrings(scopes?.length ? scopes : provider.defaultScopes, "scopes");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: requestedScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (provider.id === "google") {
    params.set("nonce", nonce);
    params.set("access_type", "offline");
    params.set("include_granted_scopes", "true");
    params.set("prompt", "consent");
  }
  const attempt = {
    id: opaque("oauth", idFactory),
    provider: provider.id,
    flow: "authorization_code",
    scopes: requestedScopes,
    redirectUri,
    verifier,
    state,
    nonce,
    authorizationUrl: `${provider.authorizationEndpoint}?${params}`,
    createdAt: iso(now),
    expiresAt: iso(new Date(new Date(now).getTime() + ttlSeconds * 1000)),
    status: "pending",
  };
  auth.oauthAttempts[attempt.id] = attempt;
  recordAudit(data, { type: "oauth.started", provider: provider.id, result: attempt.flow }, now);
  return publicOAuthAttempt(attempt, now);
}

export async function completeAuthorizationCode(data, {
  attemptId, state, code, exchange, accountFromToken = (token) => token.account ?? "connected account",
  now = new Date(), idFactory = randomUUID,
}) {
  const attempt = ensureAuthState(data).oauthAttempts[attemptId];
  if (!attempt || attempt.flow !== "authorization_code") throw new Error("OAuth attempt not found");
  if (attempt.status !== "pending") throw new Error(`OAuth attempt is ${attempt.status}`);
  if (new Date(attempt.expiresAt) <= new Date(now)) {
    attempt.status = "expired";
    throw new Error("OAuth attempt expired");
  }
  if (!state || state !== attempt.state) throw new Error("OAuth state mismatch");
  if (!code) throw new Error("OAuth authorization code is missing");
  const token = await exchange({
    provider: attempt.provider,
    code,
    redirectUri: attempt.redirectUri,
    codeVerifier: attempt.verifier,
    scopes: attempt.scopes,
  });
  const provider = getProvider(attempt.provider);
  const credential = createCredential(data, {
    provider: provider.id,
    account: accountFromToken(token),
    type: "oauth2",
    domains: provider.domains,
    scopes: token.scopes?.length ? token.scopes : attempt.scopes,
    material: { accessToken: token.accessToken, refreshToken: token.refreshToken ?? null, tokenType: token.tokenType ?? "Bearer" },
    expiresAt: token.expiresAt ?? null,
    now,
    idFactory,
  });
  attempt.status = "connected";
  attempt.credentialId = credential.id;
  delete attempt.verifier;
  delete attempt.state;
  delete attempt.nonce;
  recordAudit(data, { type: "oauth.connected", provider: provider.id, credentialId: credential.id }, now);
  return { attempt: publicOAuthAttempt(attempt, now), credential };
}

export async function startDeviceCode(data, {
  provider: providerId, clientId, scopes, authorize,
  now = new Date(), idFactory = randomUUID,
}) {
  if (!clientId) throw new Error(`${providerId} OAuth is not configured`);
  const provider = getProvider(providerId);
  const requestedScopes = uniqueStrings(scopes?.length ? scopes : provider.defaultScopes, "scopes");
  const result = await authorize({ provider: provider.id, clientId, scopes: requestedScopes });
  if (!result.deviceCode || !result.userCode || !result.verificationUri) throw new Error("provider returned an invalid device code");
  const attempt = {
    id: opaque("oauth", idFactory),
    provider: provider.id,
    flow: "device_code",
    scopes: requestedScopes,
    deviceCode: result.deviceCode,
    userCode: result.userCode,
    verificationUri: result.verificationUri,
    interval: Math.max(1, Number(result.interval) || 5),
    createdAt: iso(now),
    expiresAt: iso(new Date(new Date(now).getTime() + Number(result.expiresIn ?? 900) * 1000)),
    status: "pending",
  };
  ensureAuthState(data).oauthAttempts[attempt.id] = attempt;
  recordAudit(data, { type: "oauth.started", provider: provider.id, result: attempt.flow }, now);
  return publicOAuthAttempt(attempt, now);
}

export async function pollDeviceCode(data, {
  attemptId, exchange, accountFromToken = (token) => token.account ?? "connected account",
  now = new Date(), idFactory = randomUUID,
}) {
  const attempt = ensureAuthState(data).oauthAttempts[attemptId];
  if (!attempt || attempt.flow !== "device_code") throw new Error("device OAuth attempt not found");
  if (attempt.status !== "pending") throw new Error(`OAuth attempt is ${attempt.status}`);
  if (new Date(attempt.expiresAt) <= new Date(now)) {
    attempt.status = "expired";
    throw new Error("device OAuth attempt expired");
  }
  let token;
  try {
    token = await exchange({ provider: attempt.provider, deviceCode: attempt.deviceCode, scopes: attempt.scopes });
  } catch (error) {
    if (error.code === "authorization_pending" || error.code === "slow_down") return publicOAuthAttempt(attempt, now);
    if (error.code === "access_denied") return denyOAuthAttempt(data, attemptId, error.message, now);
    throw error;
  }
  const provider = getProvider(attempt.provider);
  const credential = createCredential(data, {
    provider: provider.id,
    account: accountFromToken(token),
    type: "oauth2",
    domains: provider.domains,
    scopes: token.scopes?.length ? token.scopes : attempt.scopes,
    material: { accessToken: token.accessToken, refreshToken: token.refreshToken ?? null, tokenType: token.tokenType ?? "Bearer" },
    expiresAt: token.expiresAt ?? null,
    now,
    idFactory,
  });
  attempt.status = "connected";
  attempt.credentialId = credential.id;
  delete attempt.deviceCode;
  recordAudit(data, { type: "oauth.connected", provider: provider.id, credentialId: credential.id }, now);
  return { attempt: publicOAuthAttempt(attempt, now), credential };
}

export function denyOAuthAttempt(data, attemptId, detail = "access denied", now = new Date()) {
  const attempt = ensureAuthState(data).oauthAttempts[attemptId];
  if (!attempt) return null;
  attempt.status = "denied";
  delete attempt.verifier;
  delete attempt.deviceCode;
  recordAudit(data, { type: "oauth.denied", provider: attempt.provider, detail }, now);
  return publicOAuthAttempt(attempt, now);
}
