import {
  EnvironmentResolver,
  init_env_resolver
} from "./chunk-7QI6F66G.mjs";
import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/oauth2-token-cache.ts
var OAuth2TokenCache;
var init_oauth2_token_cache = __esm({
  "src/utils/oauth2-token-cache.ts"() {
    init_logger();
    init_env_resolver();
    OAuth2TokenCache = class _OAuth2TokenCache {
      static instance;
      cache = /* @__PURE__ */ new Map();
      static getInstance() {
        if (!_OAuth2TokenCache.instance) {
          _OAuth2TokenCache.instance = new _OAuth2TokenCache();
        }
        return _OAuth2TokenCache.instance;
      }
      /** Visible for testing */
      static resetInstance() {
        _OAuth2TokenCache.instance = void 0;
      }
      /**
       * Get a valid Bearer token for the given config.
       * Returns a cached token if still valid, otherwise fetches a new one.
       */
      async getToken(config) {
        const clientId = String(EnvironmentResolver.resolveValue(config.client_id));
        const clientSecret = String(EnvironmentResolver.resolveValue(config.client_secret));
        const tokenUrl = String(EnvironmentResolver.resolveValue(config.token_url));
        const bufferMs = (config.token_ttl_buffer ?? 300) * 1e3;
        const cacheKey = `${tokenUrl}|${clientId}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expires_at - bufferMs > Date.now()) {
          logger.verbose("[oauth2] Using cached token");
          return cached.access_token;
        }
        if (cached?.refreshPromise) {
          logger.verbose("[oauth2] Awaiting in-flight token refresh");
          return cached.refreshPromise;
        }
        const refreshPromise = this.fetchToken(tokenUrl, clientId, clientSecret, config.scopes);
        if (cached) {
          cached.refreshPromise = refreshPromise;
        } else {
          this.cache.set(cacheKey, {
            access_token: "",
            expires_at: 0,
            refreshPromise
          });
        }
        try {
          const token = await refreshPromise;
          return token;
        } finally {
          const entry = this.cache.get(cacheKey);
          if (entry) {
            entry.refreshPromise = void 0;
          }
        }
      }
      async fetchToken(tokenUrl, clientId, clientSecret, scopes) {
        logger.verbose(`[oauth2] Fetching token from ${tokenUrl}`);
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const bodyParams = new URLSearchParams({ grant_type: "client_credentials" });
        if (scopes?.length) {
          bodyParams.set("scope", scopes.join(" "));
        }
        const response = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`
          },
          body: bodyParams.toString()
        });
        if (!response.ok) {
          let errorDetail = "";
          try {
            errorDetail = await response.text();
          } catch {
          }
          throw new Error(
            `OAuth2 token request failed: HTTP ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail.substring(0, 200)}` : ""}`
          );
        }
        const data = await response.json();
        if (!data.access_token) {
          throw new Error("OAuth2 token response missing access_token");
        }
        const expiresIn = data.expires_in ?? 3600;
        const expiresAt = Date.now() + expiresIn * 1e3;
        const cacheKey = `${tokenUrl}|${clientId}`;
        this.cache.set(cacheKey, {
          access_token: data.access_token,
          expires_at: expiresAt
        });
        logger.verbose(`[oauth2] Token acquired, expires in ${expiresIn}s`);
        return data.access_token;
      }
      /** Clear all cached tokens (for testing or credential rotation) */
      clear() {
        this.cache.clear();
      }
    };
  }
});

export {
  OAuth2TokenCache,
  init_oauth2_token_cache
};
//# sourceMappingURL=chunk-PGBV3VZB.mjs.map