import { randomUUID } from "node:crypto";
import { domainMatches, normalizeDomain } from "../vault/domains.js";
import { recordAudit } from "./audit.js";
import { ensureAuthState, iso, uniqueStrings } from "./state.js";

export const WRITE_ACTIONS = new Set(["book", "charge", "delete", "pay", "send", "write"]);

function opaque(prefix, idFactory) {
  return `${prefix}_${idFactory().replaceAll("-", "")}`;
}

export function isWriteAction(action) {
  return WRITE_ACTIONS.has(String(action).toLowerCase());
}

export function publicGrant(grant, now = new Date()) {
  const expired = new Date(grant.expiresAt).getTime() <= new Date(now).getTime();
  return {
    id: grant.id,
    credentialId: grant.credentialId,
    provider: grant.provider,
    runId: grant.runId,
    branchId: grant.branchId,
    domains: [...grant.domains],
    scopes: [...grant.scopes],
    actions: [...grant.actions],
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    usesRemaining: grant.usesRemaining,
    status: grant.revokedAt ? "revoked" : expired ? "expired" : "active",
    confirmationRequired: grant.actions.some(isWriteAction),
  };
}

export function createGrant(data, {
  credentialId, runId, branchId = null, domains, scopes = [], actions,
  expiresAt, ttlSeconds = 900, maxUses = null, confirmed = false,
  now = new Date(), idFactory = randomUUID,
}) {
  const auth = ensureAuthState(data);
  const credential = auth.credentials[credentialId];
  if (!credential || credential.revokedAt) throw new Error("credential is unavailable");
  if (!runId) throw new Error("runId is required");
  const normalizedDomains = uniqueStrings(domains, "domains").map(normalizeDomain);
  const normalizedScopes = uniqueStrings(scopes, "scopes");
  const normalizedActions = uniqueStrings(actions, "actions").map((value) => value.toLowerCase());
  if (!normalizedDomains.length || !normalizedActions.length) {
    throw new Error("a grant needs at least one domain and action");
  }
  if (normalizedDomains.some((domain) => !credential.domains.some((allowed) => domainMatches(domain, allowed)))) {
    throw new Error("grant domain exceeds the credential boundary");
  }
  if (normalizedScopes.some((scope) => !credential.scopes.includes(scope))) {
    throw new Error("grant scope exceeds the credential boundary");
  }
  if (normalizedActions.some(isWriteAction) && !confirmed) {
    throw new Error("write-capable grants require explicit confirmation");
  }
  const start = new Date(now);
  const end = expiresAt ? new Date(expiresAt) : new Date(start.getTime() + ttlSeconds * 1000);
  if (!Number.isFinite(end.getTime()) || end <= start) throw new Error("grant expiry must be in the future");
  const grant = {
    id: opaque("grant", idFactory),
    credentialId,
    provider: credential.provider,
    runId: String(runId),
    branchId: branchId == null ? null : String(branchId),
    domains: normalizedDomains,
    scopes: normalizedScopes,
    actions: normalizedActions,
    createdAt: iso(start),
    expiresAt: iso(end),
    usesRemaining: maxUses == null ? (normalizedActions.some(isWriteAction) ? 1 : null) : Number(maxUses),
    confirmedAt: confirmed ? iso(start) : null,
    revokedAt: null,
  };
  if (grant.usesRemaining != null && (!Number.isInteger(grant.usesRemaining) || grant.usesRemaining < 1)) {
    throw new Error("maxUses must be a positive integer");
  }
  auth.grants[grant.id] = grant;
  recordAudit(data, { type: "grant.created", grantId: grant.id, credentialId, runId, branchId, provider: credential.provider }, start);
  return publicGrant(grant, start);
}

export function revokeGrant(data, id, now = new Date()) {
  const grant = ensureAuthState(data).grants[id];
  if (!grant) return null;
  grant.revokedAt ??= iso(now);
  recordAudit(data, { type: "grant.revoked", grantId: id, credentialId: grant.credentialId, provider: grant.provider }, now);
  return publicGrant(grant, now);
}

export function authorizeGrant(data, {
  grantId, credentialId, runId, branchId = null, domain, scope = null, action,
  now = new Date(), consume = true,
}) {
  const auth = ensureAuthState(data);
  const grant = auth.grants[grantId];
  const refuse = (message) => {
    recordAudit(data, { type: "grant.denied", grantId, credentialId, runId, branchId, domain, scope, action, result: message }, now);
    throw new Error(message);
  };
  if (!grant || grant.revokedAt) refuse("grant is unavailable");
  if (grant.credentialId !== credentialId) refuse("grant does not match credential");
  if (grant.runId !== String(runId)) refuse("grant does not belong to this run");
  if (grant.branchId !== (branchId == null ? null : String(branchId))) refuse("grant does not belong to this branch");
  if (new Date(grant.expiresAt) <= new Date(now)) refuse("grant has expired");
  if (!grant.actions.includes(String(action).toLowerCase())) refuse("action is not granted");
  if (scope && !grant.scopes.includes(String(scope))) refuse("scope is not granted");
  const host = normalizeDomain(domain);
  if (!grant.domains.some((allowed) => domainMatches(host, allowed))) refuse("domain is not granted");
  if (grant.usesRemaining != null && grant.usesRemaining < 1) refuse("grant has already been consumed");
  if (consume && grant.usesRemaining != null) grant.usesRemaining -= 1;
  recordAudit(data, { type: "grant.used", grantId, credentialId, runId, branchId, domain: host, scope, action, result: "allowed" }, now);
  return publicGrant(grant, now);
}

export function listGrants(data, now = new Date()) {
  return Object.values(ensureAuthState(data).grants).map((grant) => publicGrant(grant, now));
}
