import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

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
export async function createAuthenticatedOctokit(
  options: GitHubAuthOptions
): Promise<GitHubAuthResult | undefined> {
  const { token, appId, installationId, owner, repo } = options;
  const privateKey = options.privateKey ? resolvePrivateKey(options.privateKey) : undefined;

  // Prefer GitHub App authentication if app credentials are provided
  if (appId && privateKey) {
    const { createAppAuth } = await import('@octokit/auth-app');

    let finalInstallationId: number | undefined;

    if (installationId) {
      finalInstallationId = parseInt(installationId, 10);
      if (isNaN(finalInstallationId) || finalInstallationId <= 0) {
        throw new Error('Invalid installation-id. It must be a positive integer.');
      }
    }

    // Auto-detect installation ID if not provided
    if (!finalInstallationId && owner && repo) {
      const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey },
      });

      try {
        const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
          owner,
          repo,
        });
        finalInstallationId = installation.id;
      } catch {
        throw new Error(
          'GitHub App installation ID could not be auto-detected. ' +
            'Provide --github-installation-id or ensure the app is installed on the repository.'
        );
      }
    }

    if (!finalInstallationId) {
      throw new Error(
        'GitHub App installation ID is required. Provide --github-installation-id or set owner/repo for auto-detection.'
      );
    }

    // Create the authenticated Octokit instance
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId: finalInstallationId,
      },
    });

    // Extract the installation access token for environment propagation
    const authResult = (await octokit.auth({ type: 'installation' })) as { token: string };

    return {
      octokit,
      authType: 'github-app',
      token: authResult.token,
    };
  }

  // Fall back to token authentication
  if (token) {
    return {
      octokit: new Octokit({ auth: token }),
      authType: 'token',
      token,
    };
  }

  // No credentials provided
  return undefined;
}

/**
 * Resolve GitHub auth options from environment variables.
 * Used as fallback when no explicit CLI arguments are provided.
 */
export function resolveAuthFromEnvironment(): GitHubAuthOptions {
  return {
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    owner: process.env.GITHUB_REPOSITORY_OWNER || process.env.GITHUB_REPOSITORY?.split('/')[0],
    repo: process.env.GITHUB_REPOSITORY?.split('/')[1],
  };
}

/**
 * Resolve private key — supports both inline PEM content and file paths.
 */
export function resolvePrivateKey(keyOrPath: string): string {
  if (keyOrPath.includes('-----BEGIN')) {
    return keyOrPath;
  }
  const resolved = path.resolve(keyOrPath);
  if (fs.existsSync(resolved)) {
    return fs.readFileSync(resolved, 'utf8');
  }
  // Return as-is and let the auth library handle errors
  return keyOrPath;
}

// Track our auth entries position so repeated calls replace instead of stacking.
// _authBase: the GIT_CONFIG index where our 2 auth entries start.
// _lastWrittenCount: what we last set GIT_CONFIG_COUNT to (detects external changes).
let _authBase: number | undefined;
let _lastWrittenCount: number | undefined;

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
export function injectGitHubCredentials(token: string): void {
  // Set for gh CLI and general GitHub API usage
  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = token;

  const currentCount = parseInt(process.env.GIT_CONFIG_COUNT || '0', 10);

  // Determine where to write our 2 auth entries:
  // - First call: append after any pre-existing entries
  // - Subsequent calls with unchanged count: overwrite at same position
  // - If count changed externally: someone added entries, append after them
  let base: number;
  if (_authBase === undefined) {
    base = currentCount;
  } else if (_lastWrittenCount !== undefined && currentCount !== _lastWrittenCount) {
    base = currentCount;
  } else {
    base = _authBase;
  }
  _authBase = base;

  // Configure git HTTPS auth via url.<base>.insteadOf
  const authUrl = `https://x-access-token:${token}@github.com/`;

  // Rewrite HTTPS URLs
  process.env[`GIT_CONFIG_KEY_${base}`] = `url.${authUrl}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${base}`] = 'https://github.com/';

  // Rewrite SSH-style URLs (git@github.com:org/repo)
  process.env[`GIT_CONFIG_KEY_${base + 1}`] = `url.${authUrl}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${base + 1}`] = 'git@github.com:';

  const newCount = base + 2;
  process.env.GIT_CONFIG_COUNT = String(newCount);
  _lastWrittenCount = newCount;
}

/**
 * Mark the current token as freshly generated (for use after initial startup auth).
 * Prevents the first refreshGitHubCredentials() call from unnecessarily regenerating.
 */
export function markTokenFresh(): void {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    _cachedAppToken = { token, generatedAt: Date.now() };
  }
}

// Cached token with generation timestamp for expiry checks
let _cachedAppToken: { token: string; generatedAt: number } | undefined;

// Installation tokens live 1 hour; refresh after 45 minutes.
// Using 45 min (not 50) leaves a 15-minute buffer for long-running tasks
// that start right before a refresh cycle.
const TOKEN_REFRESH_MS = 45 * 60 * 1000;

// Background refresh timer
let _refreshTimer: ReturnType<typeof setInterval> | undefined;

// How often the background timer checks (30 minutes)
const TIMER_INTERVAL_MS = 30 * 60 * 1000;

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
export async function refreshGitHubCredentials(): Promise<void> {
  // Quick check: do we have App credentials?
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return;

  // Skip if cached token is still fresh
  const now = Date.now();
  if (_cachedAppToken && now - _cachedAppToken.generatedAt < TOKEN_REFRESH_MS) {
    return;
  }

  try {
    const opts = resolveAuthFromEnvironment();
    const result = await createAuthenticatedOctokit(opts);
    if (result && result.authType === 'github-app') {
      injectGitHubCredentials(result.token);
      _cachedAppToken = { token: result.token, generatedAt: now };
      logger.debug('[github-auth] Refreshed GitHub App installation token');
    }
  } catch (err) {
    logger.warn(
      `[github-auth] Failed to refresh GitHub App token: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

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
export function startTokenRefreshTimer(): void {
  if (_refreshTimer) return; // Already running

  // Only start if we have App credentials
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return;

  _refreshTimer = setInterval(() => {
    refreshGitHubCredentials().catch(err => {
      logger.warn(
        `[github-auth] Background token refresh failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, TIMER_INTERVAL_MS);

  // Don't prevent Node from exiting
  _refreshTimer.unref();

  logger.debug('[github-auth] Background token refresh timer started (every 30 min)');
}

/**
 * Stop the background token refresh timer.
 */
export function stopTokenRefreshTimer(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = undefined;
    logger.debug('[github-auth] Background token refresh timer stopped');
  }
}

/** Visible for testing: override the cached token state. */
export function _testSetCachedToken(token: string | undefined, generatedAt?: number): void {
  if (token) {
    _cachedAppToken = { token, generatedAt: generatedAt ?? Date.now() };
  } else {
    _cachedAppToken = undefined;
  }
}

/** Visible for testing: get the current cached token info. */
export function _testGetCachedToken(): { token: string; generatedAt: number } | undefined {
  return _cachedAppToken;
}
