import { ensureAuthState, iso } from "./state.js";

const ALLOWED_FIELDS = new Set([
  "action", "branchId", "credentialId", "detail", "domain", "grantId",
  "provider", "result", "runId", "scope",
]);

export function recordAudit(data, event, now = new Date()) {
  const auth = ensureAuthState(data);
  const safe = { at: iso(now), type: String(event.type ?? "auth.event") };
  for (const [key, value] of Object.entries(event)) {
    if (key === "type" || !ALLOWED_FIELDS.has(key) || value == null) continue;
    safe[key] = String(value).slice(0, 240);
  }
  auth.audit.push(safe);
  if (auth.audit.length > 500) auth.audit.splice(0, auth.audit.length - 500);
  return safe;
}

export function listAudit(data, limit = 50) {
  const auth = ensureAuthState(data);
  return auth.audit.slice(-Math.max(0, Math.min(Number(limit) || 50, 250))).reverse();
}
