import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';

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
 */
export function injectGitHubCredentials(token: string): void {
  // Set for gh CLI and general GitHub API usage
  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = token;

  // Configure git HTTPS auth via url.<base>.insteadOf
  // This rewrites all github.com URLs to include the access token
  const existingCount = parseInt(process.env.GIT_CONFIG_COUNT || '0', 10);
  const authUrl = `https://x-access-token:${token}@github.com/`;

  // Rewrite HTTPS URLs
  process.env[`GIT_CONFIG_KEY_${existingCount}`] = `url.${authUrl}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${existingCount}`] = 'https://github.com/';

  // Rewrite SSH-style URLs (git@github.com:org/repo)
  process.env[`GIT_CONFIG_KEY_${existingCount + 1}`] = `url.${authUrl}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${existingCount + 1}`] = 'git@github.com:';

  process.env.GIT_CONFIG_COUNT = String(existingCount + 2);
}
