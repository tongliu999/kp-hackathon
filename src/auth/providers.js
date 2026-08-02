const PROVIDERS = {
  github: {
    id: "github",
    name: "GitHub",
    domains: ["api.github.com", "github.com"],
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    deviceEndpoint: "https://github.com/login/device/code",
    identity: { url: "https://api.github.com/user", scope: "read:user" },
    readCheck: { url: "https://api.github.com/user/repos?per_page=1", scope: "read:user" },
    defaultScopes: ["read:user"],
    writeScopes: ["repo", "workflow", "write:packages"],
    envPrefix: "GITHUB",
  },
  google: {
    id: "google",
    name: "Google",
    domains: ["googleapis.com"],
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    deviceEndpoint: "https://oauth2.googleapis.com/device/code",
    identity: { url: "https://www.googleapis.com/oauth2/v3/userinfo", scope: "openid" },
    readCheck: { url: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", scope: "https://www.googleapis.com/auth/calendar.readonly" },
    defaultScopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.send"],
    envPrefix: "GOOGLE",
  },
};

export function getProvider(id) {
  const provider = PROVIDERS[String(id).toLowerCase()];
  if (!provider) throw new Error(`unsupported auth provider ${id}`);
  return provider;
}

export function listProviders(env = process.env) {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    name: provider.name,
    domains: [...provider.domains],
    defaultScopes: [...provider.defaultScopes],
    writeScopes: [...provider.writeScopes],
    configured: Boolean(env[`${provider.envPrefix}_OAUTH_CLIENT_ID`]),
    flows: provider.id === "github" ? ["authorization_code", "device_code"] : ["authorization_code", "device_code"],
  }));
}

export function providerRuntime(id, env = process.env) {
  const provider = getProvider(id);
  return {
    ...provider,
    clientId: env[`${provider.envPrefix}_OAUTH_CLIENT_ID`] ?? "",
    clientSecret: env[`${provider.envPrefix}_OAUTH_CLIENT_SECRET`] ?? "",
    redirectUri: env[`${provider.envPrefix}_OAUTH_REDIRECT_URI`] ?? "http://127.0.0.1:4173/api/auth/callback",
  };
}

export function normalizeProviderError(providerId, status, payload = {}) {
  const detail = payload.error_description ?? payload.message ?? payload.error ?? `HTTP ${status}`;
  if (status === 401) return { code: "invalid_credential", provider: providerId, message: detail };
  if (status === 403) return { code: "insufficient_scope", provider: providerId, message: detail };
  if (status === 429) return { code: "rate_limited", provider: providerId, message: detail };
  return { code: status >= 500 ? "provider_unreachable" : "provider_error", provider: providerId, message: detail };
}
