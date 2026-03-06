import { logger } from '../logger';
import { EnvironmentResolver } from './env-resolver';

/**
 * OAuth2 client_credentials auth configuration
 */
export interface OAuth2ClientCredentialsConfig {
  type: 'oauth2_client_credentials';
  /** OAuth2 token endpoint URL */
  token_url: string;
  /** OAuth2 client ID (supports ${ENV_VAR} syntax) */
  client_id: string;
  /** OAuth2 client secret (supports ${ENV_VAR} syntax) */
  client_secret: string;
  /** Optional scopes to request */
  scopes?: string[];
  /** Buffer in seconds before expiry to trigger refresh (default: 300 = 5 min) */
  token_ttl_buffer?: number;
}

/**
 * Generic auth configuration — extensible for future auth types
 */
export type AuthConfig = OAuth2ClientCredentialsConfig;

interface CachedToken {
  access_token: string;
  expires_at: number; // Unix timestamp in ms
  /** In-flight refresh promise to prevent concurrent token fetches */
  refreshPromise?: Promise<string>;
}

/**
 * Singleton cache for OAuth2 tokens.
 *
 * - Keyed by hash(token_url + client_id) to support multiple providers
 * - Lazy refresh: only fetches when expired or near-expiry
 * - Deduplicates concurrent requests: if two calls hit with an expired token,
 *   both await the same fetch promise
 */
export class OAuth2TokenCache {
  private static instance: OAuth2TokenCache;
  private cache = new Map<string, CachedToken>();

  static getInstance(): OAuth2TokenCache {
    if (!OAuth2TokenCache.instance) {
      OAuth2TokenCache.instance = new OAuth2TokenCache();
    }
    return OAuth2TokenCache.instance;
  }

  /** Visible for testing */
  static resetInstance(): void {
    OAuth2TokenCache.instance = undefined as unknown as OAuth2TokenCache;
  }

  /**
   * Get a valid Bearer token for the given config.
   * Returns a cached token if still valid, otherwise fetches a new one.
   */
  async getToken(config: OAuth2ClientCredentialsConfig): Promise<string> {
    const clientId = String(EnvironmentResolver.resolveValue(config.client_id));
    const clientSecret = String(EnvironmentResolver.resolveValue(config.client_secret));
    const tokenUrl = String(EnvironmentResolver.resolveValue(config.token_url));
    const bufferMs = (config.token_ttl_buffer ?? 300) * 1000;

    const cacheKey = `${tokenUrl}|${clientId}`;
    const cached = this.cache.get(cacheKey);

    // Return cached token if still valid (with buffer)
    if (cached && cached.expires_at - bufferMs > Date.now()) {
      logger.verbose('[oauth2] Using cached token');
      return cached.access_token;
    }

    // If another request is already refreshing, await it
    if (cached?.refreshPromise) {
      logger.verbose('[oauth2] Awaiting in-flight token refresh');
      return cached.refreshPromise;
    }

    // Fetch a new token
    const refreshPromise = this.fetchToken(tokenUrl, clientId, clientSecret, config.scopes);

    // Store the promise so concurrent callers share it
    if (cached) {
      cached.refreshPromise = refreshPromise;
    } else {
      this.cache.set(cacheKey, {
        access_token: '',
        expires_at: 0,
        refreshPromise,
      });
    }

    try {
      const token = await refreshPromise;
      return token;
    } finally {
      // Clear the in-flight promise regardless of outcome
      const entry = this.cache.get(cacheKey);
      if (entry) {
        entry.refreshPromise = undefined;
      }
    }
  }

  private async fetchToken(
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    scopes?: string[]
  ): Promise<string> {
    logger.verbose(`[oauth2] Fetching token from ${tokenUrl}`);

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const bodyParams = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scopes?.length) {
      bodyParams.set('scope', scopes.join(' '));
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: bodyParams.toString(),
    });

    if (!response.ok) {
      let errorDetail = '';
      try {
        errorDetail = await response.text();
      } catch {}
      throw new Error(
        `OAuth2 token request failed: HTTP ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail.substring(0, 200)}` : ''}`
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in?: number;
      token_type?: string;
    };

    if (!data.access_token) {
      throw new Error('OAuth2 token response missing access_token');
    }

    // Default to 1 hour if expires_in not provided
    const expiresIn = data.expires_in ?? 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    const cacheKey = `${tokenUrl}|${clientId}`;
    this.cache.set(cacheKey, {
      access_token: data.access_token,
      expires_at: expiresAt,
    });

    logger.verbose(`[oauth2] Token acquired, expires in ${expiresIn}s`);
    return data.access_token;
  }

  /** Clear all cached tokens (for testing or credential rotation) */
  clear(): void {
    this.cache.clear();
  }
}
