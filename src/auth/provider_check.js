import { resolveCredential } from "./broker.js";
import { getProvider, normalizeProviderError } from "./providers.js";
import { recordAudit } from "./audit.js";

async function readPayload(response) {
  try { return await response.json(); } catch { return {}; }
}

export async function checkProvider(data, {
  credentialId, grantId, runId, branchId = null, provider: providerId,
  fetchImpl = fetch, now = new Date(), includeReadCheck = true,
}) {
  const provider = getProvider(providerId);
  const checks = [provider.identity, ...(includeReadCheck ? [provider.readCheck] : [])];
  const results = [];
  for (const check of checks) {
    const target = new URL(check.url);
    const auth = resolveCredential(data, {
      credentialId, grantId, runId, branchId, domain: target.hostname,
      scope: check.scope, action: "read", now, consume: false,
    });
    const response = await fetchImpl(check.url, { headers: { accept: "application/json", ...auth.headers } });
    const payload = await readPayload(response);
    if (!response.ok) {
      const normalized = normalizeProviderError(provider.id, response.status, payload);
      recordAudit(data, { type: "provider.check_failed", credentialId, provider: provider.id, result: normalized.code }, now);
      const error = new Error(normalized.message);
      error.code = normalized.code;
      throw error;
    }
    results.push({ kind: check === provider.identity ? "identity" : "read", ok: true, status: response.status });
  }
  recordAudit(data, { type: "provider.checked", credentialId, provider: provider.id, result: "healthy" }, now);
  return { provider: provider.id, status: "healthy", checks: results };
}
