import { randomUUID } from "node:crypto";
import { cookiesForDomain, domainMatches, normalizeDomain } from "../vault/domains.js";
import { recordAudit } from "./audit.js";
import { authorizeGrant } from "./grants.js";
import { ensureAuthState, iso, uniqueStrings } from "./state.js";

export const CREDENTIAL_TYPES = new Set(["api_key", "bearer_token", "browser_session", "oauth2"]);

function opaque(idFactory) {
  return `auth_${idFactory().replaceAll("-", "")}`;
}

function materialExpiry(record) {
  return record.expiresAt ? new Date(record.expiresAt).getTime() : null;
}

export function credentialStatus(record, now = new Date(), warningSeconds = 900) {
  if (record.revokedAt) return "revoked";
  const expiry = materialExpiry(record);
  if (expiry == null) return "healthy";
  const remaining = expiry - new Date(now).getTime();
  if (remaining <= 0) return "expired";
  if (remaining <= warningSeconds * 1000) return "expiring";
  return "healthy";
}

export function publicCredential(record, now = new Date()) {
  return {
    id: record.id,
    provider: record.provider,
    account: record.account,
    type: record.type,
    domains: [...record.domains],
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    status: credentialStatus(record, now),
    refreshable: Boolean(record.material.refreshToken),
  };
}

function validateMaterial(type, material, domains) {
  if (!material || typeof material !== "object") throw new Error("credential material is required");
  if (type === "api_key" && String(material.apiKey ?? "").length < 8) throw new Error("api key is invalid");
  if (type === "bearer_token" && String(material.accessToken ?? "").length < 8) throw new Error("bearer token is invalid");
  if (type === "oauth2" && String(material.accessToken ?? "").length < 8) throw new Error("OAuth access token is invalid");
  if (type === "browser_session") {
    if (!Array.isArray(material.cookies) || !material.cookies.length) throw new Error("browser session needs cookies");
    const scoped = material.cookies.filter((cookie) => domains.some((domain) => cookie.domain && domainMatches(cookie.domain, domain)));
    if (!scoped.length) throw new Error("browser session has no cookies for its allowed domains");
  }
}

export function createCredential(data, {
  provider, account, type, domains, scopes = [], material, expiresAt = null,
  now = new Date(), idFactory = randomUUID,
}) {
  const auth = ensureAuthState(data);
  const normalizedType = String(type);
  if (!CREDENTIAL_TYPES.has(normalizedType)) throw new Error(`unsupported credential type ${normalizedType}`);
  if (!provider || !account) throw new Error("provider and account are required");
  const normalizedDomains = uniqueStrings(domains, "domains").map(normalizeDomain);
  if (!normalizedDomains.length) throw new Error("credential needs at least one domain");
  const normalizedScopes = uniqueStrings(scopes, "scopes");
  validateMaterial(normalizedType, material, normalizedDomains);
  const expiry = expiresAt == null ? null : iso(expiresAt);
  if (expiry && new Date(expiry) <= new Date(now)) throw new Error("credential is already expired");
  const record = {
    id: opaque(idFactory),
    provider: String(provider).toLowerCase(),
    account: String(account),
    type: normalizedType,
    domains: normalizedDomains,
    scopes: normalizedScopes,
    material: structuredClone(material),
    createdAt: iso(now),
    updatedAt: iso(now),
    expiresAt: expiry,
    lastUsedAt: null,
    revokedAt: null,
  };
  auth.credentials[record.id] = record;
  recordAudit(data, { type: "credential.created", credentialId: record.id, provider: record.provider }, now);
  return publicCredential(record, now);
}

export function getCredentialRecord(data, id) {
  const record = ensureAuthState(data).credentials[id];
  if (!record) throw new Error("credential not found");
  return record;
}

export function listCredentials(data, now = new Date()) {
  return Object.values(ensureAuthState(data).credentials)
    .map((record) => publicCredential(record, now))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.account.localeCompare(b.account));
}

export function revokeCredential(data, id, now = new Date()) {
  const record = ensureAuthState(data).credentials[id];
  if (!record) return null;
  record.revokedAt ??= iso(now);
  record.updatedAt = iso(now);
  for (const grant of Object.values(ensureAuthState(data).grants)) {
    if (grant.credentialId === id) grant.revokedAt ??= iso(now);
  }
  recordAudit(data, { type: "credential.revoked", credentialId: id, provider: record.provider }, now);
  return publicCredential(record, now);
}

export function resolveCredential(data, {
  credentialId, grantId, runId, branchId = null, domain, scope = null, action,
  now = new Date(), consume = true,
}) {
  const record = getCredentialRecord(data, credentialId);
  const status = credentialStatus(record, now);
  if (status === "expired" || status === "revoked") throw new Error(`credential is ${status}`);
  authorizeGrant(data, { grantId, credentialId, runId, branchId, domain, scope, action, now, consume });
  const host = normalizeDomain(domain);
  if (!record.domains.some((allowed) => domainMatches(host, allowed))) throw new Error("credential domain mismatch");
  record.lastUsedAt = iso(now);
  record.updatedAt = iso(now);
  recordAudit(data, { type: "credential.resolved", credentialId, grantId, provider: record.provider, domain: host, action }, now);
  if (record.type === "browser_session") {
    return { type: record.type, cookies: cookiesForDomain(record.material.cookies, host) };
  }
  if (record.type === "api_key") {
    const headerName = String(record.material.headerName ?? "x-api-key").toLowerCase();
    return { type: record.type, headers: { [headerName]: record.material.apiKey } };
  }
  return { type: record.type, headers: { authorization: `Bearer ${record.material.accessToken}` } };
}

export function credentialSecretValues(record) {
  const values = [];
  const visit = (value) => {
    if (typeof value === "string" && value.length >= 8) values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(record.material);
  return [...new Set(values)];
}
