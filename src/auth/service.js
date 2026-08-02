import { createCredential, getCredentialRecord, listCredentials, revokeCredential } from "./broker.js";
import { listAudit } from "./audit.js";
import { createGrant, listGrants, revokeGrant } from "./grants.js";
import { credentialHealth, refreshCredential, rotateCredential } from "./lifecycle.js";
import {
  completeAuthorizationCode, denyOAuthAttempt, pollDeviceCode,
  startAuthorizationCode, startDeviceCode,
} from "./oauth.js";
import { checkProvider } from "./provider_check.js";
import { getProvider, listProviders, providerRuntime } from "./providers.js";
import { ensureAuthState } from "./state.js";
import { defaultVaultPath, loadVault, saveVault } from "../vault/vault.js";
import { loadKey } from "../vault/keyring.js";

function tokenExpiry(expiresIn, now = new Date()) {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(new Date(now).getTime() + seconds * 1000).toISOString() : null;
}

async function jsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return Object.fromEntries(new URLSearchParams(text)); }
}

export class AuthService {
  constructor({ data, save = async () => {}, env = process.env, fetchImpl = fetch, now = () => new Date() }) {
    this.data = data;
    this.rawSave = save;
    this.saveChain = Promise.resolve();
    this.save = () => {
      const pending = this.saveChain.then(() => this.rawSave());
      this.saveChain = pending.catch(() => {});
      return pending;
    };
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    ensureAuthState(this.data);
  }

  snapshot() {
    const now = this.now();
    return {
      providers: listProviders(this.env),
      accounts: listCredentials(this.data, now),
      grants: listGrants(this.data, now),
      audit: listAudit(this.data, 40),
    };
  }

  async addCredential(input) {
    const credential = createCredential(this.data, { ...input, now: this.now() });
    await this.save();
    return credential;
  }

  async grant(input) {
    const grant = createGrant(this.data, { ...input, now: this.now() });
    await this.save();
    return grant;
  }

  async revokeGrant(id) {
    const grant = revokeGrant(this.data, id, this.now());
    await this.save();
    return grant;
  }

  async revoke(id) {
    const credential = revokeCredential(this.data, id, this.now());
    await this.save();
    return credential;
  }

  health(id, warningSeconds = 900) {
    return credentialHealth(getCredentialRecord(this.data, id), this.now(), warningSeconds);
  }

  async rotate(provider) {
    const credential = rotateCredential(this.data, { provider, now: this.now() });
    await this.save();
    return credential;
  }

  async beginOAuth({ provider, flow = "authorization_code", scopes = [] }) {
    const runtime = providerRuntime(provider, this.env);
    let attempt;
    if (flow === "device_code") {
      attempt = await startDeviceCode(this.data, {
        provider, clientId: runtime.clientId, scopes, now: this.now(),
        authorize: async ({ clientId, scopes: requested }) => {
          const body = new URLSearchParams({ client_id: clientId, scope: requested.join(" ") });
          const response = await this.fetchImpl(runtime.deviceEndpoint, {
            method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body,
          });
          const payload = await jsonResponse(response);
          if (!response.ok) throw new Error(payload.error_description ?? payload.error ?? "device authorization failed");
          return {
            deviceCode: payload.device_code,
            userCode: payload.user_code,
            verificationUri: payload.verification_uri ?? payload.verification_uri_complete,
            interval: payload.interval,
            expiresIn: payload.expires_in,
          };
        },
      });
    } else {
      attempt = startAuthorizationCode(this.data, {
        provider, clientId: runtime.clientId, redirectUri: runtime.redirectUri, scopes, now: this.now(),
      });
    }
    await this.save();
    return attempt;
  }

  async exchangeToken({ provider: providerId, code, redirectUri, codeVerifier, deviceCode, refreshToken }) {
    const runtime = providerRuntime(providerId, this.env);
    const body = new URLSearchParams({ client_id: runtime.clientId });
    if (runtime.clientSecret) body.set("client_secret", runtime.clientSecret);
    if (refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", refreshToken);
    } else if (deviceCode) {
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
      body.set("device_code", deviceCode);
    } else {
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      body.set("redirect_uri", redirectUri);
      body.set("code_verifier", codeVerifier);
    }
    const response = await this.fetchImpl(runtime.tokenEndpoint, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body,
    });
    const payload = await jsonResponse(response);
    if (!response.ok || payload.error) {
      const error = new Error(payload.error_description ?? payload.error ?? "token exchange failed");
      error.code = payload.error;
      throw error;
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      tokenType: payload.token_type,
      scopes: String(payload.scope ?? "").split(/[ ,]+/).filter(Boolean),
      expiresAt: tokenExpiry(payload.expires_in, this.now()),
      account: `${getProvider(providerId).name} account`,
    };
  }

  async finishOAuth({ attemptId, state, code, error, errorDescription }) {
    if (error) {
      const result = denyOAuthAttempt(this.data, attemptId, errorDescription ?? error, this.now());
      await this.save();
      return result;
    }
    const result = await completeAuthorizationCode(this.data, {
      attemptId, state, code, exchange: (input) => this.exchangeToken(input), now: this.now(),
    });
    await this.save();
    return result;
  }

  async finishOAuthByState({ state, code, error, errorDescription }) {
    const attempt = Object.values(ensureAuthState(this.data).oauthAttempts).find((item) => item.state === state);
    if (!attempt) throw new Error("OAuth callback does not match a pending connection");
    return this.finishOAuth({ attemptId: attempt.id, state, code, error, errorDescription });
  }

  async pollDevice(attemptId) {
    const result = await pollDeviceCode(this.data, {
      attemptId, exchange: (input) => this.exchangeToken(input), now: this.now(),
    });
    await this.save();
    return result;
  }

  async refresh(id, force = false) {
    const credential = await refreshCredential(this.data, {
      credentialId: id, force, now: this.now(), refresh: (input) => this.exchangeToken(input),
    });
    await this.save();
    return credential;
  }

  async check(id) {
    const record = getCredentialRecord(this.data, id);
    const provider = getProvider(record.provider);
    const requiredScopes = [...new Set([provider.identity.scope, provider.readCheck.scope].filter((scope) => record.scopes.includes(scope)))];
    if (!requiredScopes.includes(provider.identity.scope)) throw new Error("credential lacks the provider identity scope");
    const grant = createGrant(this.data, {
      credentialId: id,
      runId: "auth-console",
      domains: provider.domains,
      scopes: requiredScopes,
      actions: ["read"],
      ttlSeconds: 60,
      maxUses: 4,
      now: this.now(),
    });
    try {
      const result = await checkProvider(this.data, {
        credentialId: id,
        grantId: grant.id,
        runId: "auth-console",
        provider: record.provider,
        fetchImpl: this.fetchImpl,
        now: this.now(),
        includeReadCheck: requiredScopes.includes(provider.readCheck.scope),
      });
      await this.save();
      return result;
    } finally {
      revokeGrant(this.data, grant.id, this.now());
      await this.save();
    }
  }
}

export async function createVaultAuthService({ env = process.env, fetchImpl = fetch } = {}) {
  const vaultPath = defaultVaultPath(env);
  const { key } = await loadKey({ env });
  const data = await loadVault({ vaultPath, key });
  return new AuthService({
    data,
    env,
    fetchImpl,
    save: () => saveVault(data, { vaultPath, key }),
  });
}
