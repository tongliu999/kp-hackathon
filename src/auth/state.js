export const AUTH_STATE_VERSION = 1;

export function ensureAuthState(data) {
  data.auth ??= {
    version: AUTH_STATE_VERSION,
    credentials: {},
    grants: {},
    oauthAttempts: {},
    audit: [],
  };
  if (data.auth.version !== AUTH_STATE_VERSION) {
    throw new Error(`unsupported auth state version ${data.auth.version}`);
  }
  data.auth.credentials ??= {};
  data.auth.grants ??= {};
  data.auth.oauthAttempts ??= {};
  data.auth.audit ??= [];
  return data.auth;
}

export function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}
