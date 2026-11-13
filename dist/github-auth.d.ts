import { Octokit } from '@octokit/rest';
/**
 * Options for GitHub authentication.
 * Supports both personal access token and GitHub App authentication.
 */
export interface GitHubAuthOptions {
    /** Personal access token or fine-grained token */
    token?: string;
    /** GitHub App ID */
    appId?: string;
    /** GitHub App private key (PEM content or file path) */
    privateKey?: string;
    /** GitHub App installation ID (auto-detected if omitted) */
    installationId?: string;
    /** Repository owner (for auto-detecting installation ID) */
    owner?: string;
    /** Repository name (for auto-detecting installation ID) */
    repo?: string;
}
/**
 * Result of successful GitHub authentication.
 */
export interface GitHubAuthResult {
    /** Authenticated Octokit instance */
    octokit: Octokit;
    /** Authentication method used */
    authType: 'github-app' | 'token';
    /** Raw token string for environment propagation */
    token: string;
}
/**
 * Create an authenticated Octokit instance.
 * Returns undefined if no credentials are provided (auth is optional in CLI mode).
 *
 * For token auth: uses the token directly.
 * For GitHub App auth: creates JWT-authenticated client, resolves installation ID,
 * then extracts an installation access token for environment propagation.
 */
export declare function createAuthenticatedOctokit(options: GitHubAuthOptions): Promise<GitHubAuthResult | undefined>;
/**
 * Resolve GitHub auth options from environment variables.
 * Used as fallback when no explicit CLI arguments are provided.
 */
export declare function resolveAuthFromEnvironment(): GitHubAuthOptions;
/**
 * Resolve private key — supports both inline PEM content and file paths.
 */
export declare function resolvePrivateKey(keyOrPath: string): string;
/**
 * Inject GitHub credentials into process.env for child processes.
 *
 * Sets GITHUB_TOKEN/GH_TOKEN for gh CLI, and configures git HTTPS auth
 * via GIT_CONFIG_COUNT/KEY/VALUE env vars so `git clone`, `git push`, etc.
 * work automatically against github.com without any local git config.
 *
 * Uses git's GIT_CONFIG_COUNT mechanism (git 2.31+, March 2021):
 * - No temp files or global config mutation
 * - Inherited by all child processes automatically
 * - Works regardless of local git configuration
 *
 * Safe to call multiple times (e.g. on token refresh) — replaces previous entries.
 */
export declare function injectGitHubCredentials(token: string): void;
/**
 * Mark the current token as freshly generated (for use after initial startup auth).
 * Prevents the first refreshGitHubCredentials() call from unnecessarily regenerating.
 */
export declare function markTokenFresh(): void;
/**
 * Refresh GitHub App installation credentials if they are about to expire.
 *
 * No-op when:
 * - No GitHub App credentials are configured (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY)
 * - The current token was generated less than 45 minutes ago
 *
 * Call this before each execution in long-running processes (Slack bot, scheduler)
 * to ensure child processes always have a valid token for git/gh operations.
 */
export declare function refreshGitHubCredentials(): Promise<void>;
/**
 * Start a background timer that refreshes GitHub App tokens every 30 minutes.
 *
 * This ensures tokens stay fresh even during long-running tasks (e.g., an engineer
 * task that takes 40+ minutes). Without this, a token generated at startup could
 * expire mid-execution of a child process.
 *
 * The timer is unref'd so it doesn't prevent Node from exiting.
 * Call stopTokenRefreshTimer() on shutdown.
 */
export declare function startTokenRefreshTimer(): void;
/**
 * Stop the background token refresh timer.
 */
export declare function stopTokenRefreshTimer(): void;
/** Visible for testing: override the cached token state. */
export declare function _testSetCachedToken(token: string | undefined, generatedAt?: number): void;
/** Visible for testing: get the current cached token info. */
export declare function _testGetCachedToken(): {
    token: string;
    generatedAt: number;
} | undefined;
