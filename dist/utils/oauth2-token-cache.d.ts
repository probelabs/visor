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
/**
 * Singleton cache for OAuth2 tokens.
 *
 * - Keyed by hash(token_url + client_id) to support multiple providers
 * - Lazy refresh: only fetches when expired or near-expiry
 * - Deduplicates concurrent requests: if two calls hit with an expired token,
 *   both await the same fetch promise
 */
export declare class OAuth2TokenCache {
    private static instance;
    private cache;
    static getInstance(): OAuth2TokenCache;
    /** Visible for testing */
    static resetInstance(): void;
    /**
     * Get a valid Bearer token for the given config.
     * Returns a cached token if still valid, otherwise fetches a new one.
     */
    getToken(config: OAuth2ClientCredentialsConfig): Promise<string>;
    private fetchToken;
    /** Clear all cached tokens (for testing or credential rotation) */
    clear(): void;
}
//# sourceMappingURL=oauth2-token-cache.d.ts.map