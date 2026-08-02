import { credentialStatus, getCredentialRecord, publicCredential } from "./broker.js";
import { recordAudit } from "./audit.js";
import { ensureAuthState, iso } from "./state.js";

const refreshLocks = new Map();

export function credentialHealth(record, now = new Date(), warningSeconds = 900) {
  return {
    id: record.id,
    provider: record.provider,
    status: credentialStatus(record, now, warningSeconds),
    expiresAt: record.expiresAt,
    refreshable: Boolean(record.material.refreshToken),
    checkedAt: iso(now),
  };
}

export async function refreshCredential(data, {
  credentialId, refresh, now = new Date(), force = false, warningSeconds = 900,
}) {
  if (refreshLocks.has(credentialId)) return refreshLocks.get(credentialId);
  const operation = (async () => {
    const record = getCredentialRecord(data, credentialId);
    const health = credentialHealth(record, now, warningSeconds);
    if (!force && health.status === "healthy") return publicCredential(record, now);
    if (record.revokedAt) throw new Error("credential is revoked");
    if (!record.material.refreshToken) throw new Error("credential is not refreshable");
    try {
      const token = await refresh({
        provider: record.provider,
        refreshToken: record.material.refreshToken,
        scopes: record.scopes,
      });
      if (!token?.accessToken) throw new Error("provider returned no access token");
      record.material.accessToken = token.accessToken;
      if (token.refreshToken) record.material.refreshToken = token.refreshToken;
      if (token.scopes) record.scopes = [...new Set(token.scopes)].sort();
      record.expiresAt = token.expiresAt ?? record.expiresAt;
      record.updatedAt = iso(now);
      recordAudit(data, { type: "credential.refreshed", credentialId, provider: record.provider, result: "healthy" }, now);
      return publicCredential(record, now);
    } catch (error) {
      if (/invalid_grant|revoked|invalid refresh/i.test(error.message)) record.revokedAt = iso(now);
      recordAudit(data, { type: "credential.refresh_failed", credentialId, provider: record.provider, result: error.message }, now);
      throw error;
    }
  })();
  refreshLocks.set(credentialId, operation);
  try {
    return await operation;
  } finally {
    refreshLocks.delete(credentialId);
  }
}

export function rotateCredential(data, { provider, now = new Date(), warningSeconds = 900 } = {}) {
  const candidates = Object.values(ensureAuthState(data).credentials)
    .filter((record) => record.provider === String(provider).toLowerCase())
    .filter((record) => credentialStatus(record, now, warningSeconds) === "healthy")
    .sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") || a.account.localeCompare(b.account) || a.id.localeCompare(b.id));
  if (!candidates.length) throw new Error(`no healthy ${provider} credential is available`);
  const selected = candidates[0];
  recordAudit(data, { type: "credential.rotated", credentialId: selected.id, provider: selected.provider, result: selected.account }, now);
  return publicCredential(selected, now);
}
