import {
  init_logger,
  logger
} from "./chunk-SZXICFQ3.mjs";
import "./chunk-UCMJJ3IM.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/github-auth.ts
import { Octokit } from "@octokit/rest";
import * as fs from "fs";
import * as path from "path";
async function createAuthenticatedOctokit(options) {
  const { token, appId, installationId, owner, repo } = options;
  const privateKey = options.privateKey ? resolvePrivateKey(options.privateKey) : void 0;
  if (appId && privateKey) {
    const { createAppAuth } = await import("@octokit/auth-app");
    let finalInstallationId;
    if (installationId) {
      finalInstallationId = parseInt(installationId, 10);
      if (isNaN(finalInstallationId) || finalInstallationId <= 0) {
        throw new Error("Invalid installation-id. It must be a positive integer.");
      }
    }
    if (!finalInstallationId && owner && repo) {
      const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey }
      });
      try {
        const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
          owner,
          repo
        });
        finalInstallationId = installation.id;
      } catch {
        throw new Error(
          "GitHub App installation ID could not be auto-detected. Provide --github-installation-id or ensure the app is installed on the repository."
        );
      }
    }
    if (!finalInstallationId) {
      throw new Error(
        "GitHub App installation ID is required. Provide --github-installation-id or set owner/repo for auto-detection."
      );
    }
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId: finalInstallationId
      }
    });
    const authResult = await octokit.auth({ type: "installation" });
    return {
      octokit,
      authType: "github-app",
      token: authResult.token
    };
  }
  if (token) {
    return {
      octokit: new Octokit({ auth: token }),
      authType: "token",
      token
    };
  }
  return void 0;
}
function resolveAuthFromEnvironment() {
  return {
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    owner: process.env.GITHUB_REPOSITORY_OWNER || process.env.GITHUB_REPOSITORY?.split("/")[0],
    repo: process.env.GITHUB_REPOSITORY?.split("/")[1]
  };
}
function resolvePrivateKey(keyOrPath) {
  if (keyOrPath.includes("-----BEGIN")) {
    return keyOrPath;
  }
  const resolved = path.resolve(keyOrPath);
  if (fs.existsSync(resolved)) {
    return fs.readFileSync(resolved, "utf8");
  }
  return keyOrPath;
}
function injectGitHubCredentials(token) {
  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = token;
  const currentCount = parseInt(process.env.GIT_CONFIG_COUNT || "0", 10);
  let base;
  if (_authBase === void 0) {
    base = currentCount;
  } else if (_lastWrittenCount !== void 0 && currentCount !== _lastWrittenCount) {
    base = currentCount;
  } else {
    base = _authBase;
  }
  _authBase = base;
  const authUrl = `https://x-access-token:${token}@github.com/`;
  process.env[`GIT_CONFIG_KEY_${base}`] = `url.${authUrl}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${base}`] = "https://github.com/";
  process.env[`GIT_CONFIG_KEY_${base + 1}`] = `url.${authUrl}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${base + 1}`] = "git@github.com:";
  const newCount = base + 2;
  process.env.GIT_CONFIG_COUNT = String(newCount);
  _lastWrittenCount = newCount;
}
function markTokenFresh() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    _cachedAppToken = { token, generatedAt: Date.now() };
  }
}
async function refreshGitHubCredentials() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return;
  const now = Date.now();
  if (_cachedAppToken && now - _cachedAppToken.generatedAt < TOKEN_REFRESH_MS) {
    return;
  }
  try {
    const opts = resolveAuthFromEnvironment();
    const result = await createAuthenticatedOctokit(opts);
    if (result && result.authType === "github-app") {
      injectGitHubCredentials(result.token);
      _cachedAppToken = { token: result.token, generatedAt: now };
      logger.debug("[github-auth] Refreshed GitHub App installation token");
    }
  } catch (err) {
    const age = _cachedAppToken ? `${Math.round((now - _cachedAppToken.generatedAt) / 6e4)}min old` : "no cached token";
    logger.warn(
      `[github-auth] Failed to refresh GitHub App token (${age}): ${err instanceof Error ? err.message : String(err)}. Child processes may fail with authentication errors.`
    );
  }
}
function startTokenRefreshTimer() {
  if (_refreshTimer) return;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return;
  _refreshTimer = setInterval(() => {
    refreshGitHubCredentials().catch((err) => {
      logger.warn(
        `[github-auth] Background token refresh failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, TIMER_INTERVAL_MS);
  _refreshTimer.unref();
  logger.debug("[github-auth] Background token refresh timer started (every 30 min)");
}
function stopTokenRefreshTimer() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = void 0;
    logger.debug("[github-auth] Background token refresh timer stopped");
  }
}
function _testSetCachedToken(token, generatedAt) {
  if (token) {
    _cachedAppToken = { token, generatedAt: generatedAt ?? Date.now() };
  } else {
    _cachedAppToken = void 0;
  }
}
function _testGetCachedToken() {
  return _cachedAppToken;
}
var _authBase, _lastWrittenCount, _cachedAppToken, TOKEN_REFRESH_MS, _refreshTimer, TIMER_INTERVAL_MS;
var init_github_auth = __esm({
  "src/github-auth.ts"() {
    init_logger();
    TOKEN_REFRESH_MS = 45 * 60 * 1e3;
    TIMER_INTERVAL_MS = 30 * 60 * 1e3;
  }
});
init_github_auth();
export {
  _testGetCachedToken,
  _testSetCachedToken,
  createAuthenticatedOctokit,
  injectGitHubCredentials,
  markTokenFresh,
  refreshGitHubCredentials,
  resolveAuthFromEnvironment,
  resolvePrivateKey,
  startTokenRefreshTimer,
  stopTokenRefreshTimer
};
//# sourceMappingURL=github-auth-UPBBBOME.mjs.map