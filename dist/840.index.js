"use strict";
exports.id = 840;
exports.ids = [840];
exports.modules = {

/***/ 83049:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var auth_config_exports = {};
__export(auth_config_exports, {
  isValidAccessToken: () => isValidAccessToken,
  readAuthConfig: () => readAuthConfig,
  writeAuthConfig: () => writeAuthConfig
});
module.exports = __toCommonJS(auth_config_exports);
var fs = __toESM(__webpack_require__(79896));
var path = __toESM(__webpack_require__(16928));
var import_token_util = __webpack_require__(61080);
function getAuthConfigPath() {
  const dataDir = (0, import_token_util.getVercelDataDir)();
  if (!dataDir) {
    throw new Error(
      `Unable to find Vercel CLI data directory. Your platform: ${process.platform}. Supported: darwin, linux, win32.`
    );
  }
  return path.join(dataDir, "auth.json");
}
function readAuthConfig() {
  try {
    const authPath = getAuthConfigPath();
    if (!fs.existsSync(authPath)) {
      return null;
    }
    const content = fs.readFileSync(authPath, "utf8");
    if (!content) {
      return null;
    }
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}
function writeAuthConfig(config) {
  const authPath = getAuthConfigPath();
  const authDir = path.dirname(authPath);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { mode: 504, recursive: true });
  }
  fs.writeFileSync(authPath, JSON.stringify(config, null, 2), { mode: 384 });
}
function isValidAccessToken(authConfig) {
  if (!authConfig.token)
    return false;
  if (typeof authConfig.expiresAt !== "number")
    return true;
  const nowInSeconds = Math.floor(Date.now() / 1e3);
  return authConfig.expiresAt >= nowInSeconds;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (0);


/***/ }),

/***/ 96069:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var oauth_exports = {};
__export(oauth_exports, {
  processTokenResponse: () => processTokenResponse,
  refreshTokenRequest: () => refreshTokenRequest
});
module.exports = __toCommonJS(oauth_exports);
var import_os = __webpack_require__(70857);
const VERCEL_ISSUER = "https://vercel.com";
const VERCEL_CLI_CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
const userAgent = `@vercel/oidc node-${process.version} ${(0, import_os.platform)()} (${(0, import_os.arch)()}) ${(0, import_os.hostname)()}`;
let _tokenEndpoint = null;
async function getTokenEndpoint() {
  if (_tokenEndpoint) {
    return _tokenEndpoint;
  }
  const discoveryUrl = `${VERCEL_ISSUER}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, {
    headers: { "user-agent": userAgent }
  });
  if (!response.ok) {
    throw new Error("Failed to discover OAuth endpoints");
  }
  const metadata = await response.json();
  if (!metadata || typeof metadata.token_endpoint !== "string") {
    throw new Error("Invalid OAuth discovery response");
  }
  const endpoint = metadata.token_endpoint;
  _tokenEndpoint = endpoint;
  return endpoint;
}
async function refreshTokenRequest(options) {
  const tokenEndpoint = await getTokenEndpoint();
  return await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "user-agent": userAgent
    },
    body: new URLSearchParams({
      client_id: VERCEL_CLI_CLIENT_ID,
      grant_type: "refresh_token",
      ...options
    })
  });
}
async function processTokenResponse(response) {
  const json = await response.json();
  if (!response.ok) {
    const errorMsg = typeof json === "object" && json && "error" in json ? String(json.error) : "Token refresh failed";
    return [new Error(errorMsg)];
  }
  if (typeof json !== "object" || json === null) {
    return [new Error("Invalid token response")];
  }
  if (typeof json.access_token !== "string") {
    return [new Error("Missing access_token in response")];
  }
  if (json.token_type !== "Bearer") {
    return [new Error("Invalid token_type in response")];
  }
  if (typeof json.expires_in !== "number") {
    return [new Error("Missing expires_in in response")];
  }
  return [null, json];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (0);


/***/ }),

/***/ 76492:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var token_io_exports = {};
__export(token_io_exports, {
  findRootDir: () => findRootDir,
  getUserDataDir: () => getUserDataDir
});
module.exports = __toCommonJS(token_io_exports);
var import_path = __toESM(__webpack_require__(16928));
var import_fs = __toESM(__webpack_require__(79896));
var import_os = __toESM(__webpack_require__(70857));
var import_token_error = __webpack_require__(19988);
function findRootDir() {
  try {
    let dir = process.cwd();
    while (dir !== import_path.default.dirname(dir)) {
      const pkgPath = import_path.default.join(dir, ".vercel");
      if (import_fs.default.existsSync(pkgPath)) {
        return dir;
      }
      dir = import_path.default.dirname(dir);
    }
  } catch (e) {
    throw new import_token_error.VercelOidcTokenError(
      "Token refresh only supported in node server environments"
    );
  }
  return null;
}
function getUserDataDir() {
  if (process.env.XDG_DATA_HOME) {
    return process.env.XDG_DATA_HOME;
  }
  switch (import_os.default.platform()) {
    case "darwin":
      return import_path.default.join(import_os.default.homedir(), "Library/Application Support");
    case "linux":
      return import_path.default.join(import_os.default.homedir(), ".local/share");
    case "win32":
      if (process.env.LOCALAPPDATA) {
        return process.env.LOCALAPPDATA;
      }
      return null;
    default:
      return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (0);


/***/ }),

/***/ 61080:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var token_util_exports = {};
__export(token_util_exports, {
  assertVercelOidcTokenResponse: () => assertVercelOidcTokenResponse,
  findProjectInfo: () => findProjectInfo,
  getTokenPayload: () => getTokenPayload,
  getVercelCliToken: () => getVercelCliToken,
  getVercelDataDir: () => getVercelDataDir,
  getVercelOidcToken: () => getVercelOidcToken,
  isExpired: () => isExpired,
  loadToken: () => loadToken,
  saveToken: () => saveToken
});
module.exports = __toCommonJS(token_util_exports);
var path = __toESM(__webpack_require__(16928));
var fs = __toESM(__webpack_require__(79896));
var import_token_error = __webpack_require__(19988);
var import_token_io = __webpack_require__(76492);
var import_auth_config = __webpack_require__(83049);
var import_oauth = __webpack_require__(96069);
function getVercelDataDir() {
  const vercelFolder = "com.vercel.cli";
  const dataDir = (0, import_token_io.getUserDataDir)();
  if (!dataDir) {
    return null;
  }
  return path.join(dataDir, vercelFolder);
}
async function getVercelCliToken() {
  const authConfig = (0, import_auth_config.readAuthConfig)();
  if (!authConfig) {
    return null;
  }
  if ((0, import_auth_config.isValidAccessToken)(authConfig)) {
    return authConfig.token || null;
  }
  if (!authConfig.refreshToken) {
    (0, import_auth_config.writeAuthConfig)({});
    return null;
  }
  try {
    const tokenResponse = await (0, import_oauth.refreshTokenRequest)({
      refresh_token: authConfig.refreshToken
    });
    const [tokensError, tokens] = await (0, import_oauth.processTokenResponse)(tokenResponse);
    if (tokensError || !tokens) {
      (0, import_auth_config.writeAuthConfig)({});
      return null;
    }
    const updatedConfig = {
      token: tokens.access_token,
      expiresAt: Math.floor(Date.now() / 1e3) + tokens.expires_in
    };
    if (tokens.refresh_token) {
      updatedConfig.refreshToken = tokens.refresh_token;
    }
    (0, import_auth_config.writeAuthConfig)(updatedConfig);
    return updatedConfig.token ?? null;
  } catch (error) {
    (0, import_auth_config.writeAuthConfig)({});
    return null;
  }
}
async function getVercelOidcToken(authToken, projectId, teamId) {
  const url = `https://api.vercel.com/v1/projects/${projectId}/token?source=vercel-oidc-refresh${teamId ? `&teamId=${teamId}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  });
  if (!res.ok) {
    throw new import_token_error.VercelOidcTokenError(
      `Failed to refresh OIDC token: ${res.statusText}`
    );
  }
  const tokenRes = await res.json();
  assertVercelOidcTokenResponse(tokenRes);
  return tokenRes;
}
function assertVercelOidcTokenResponse(res) {
  if (!res || typeof res !== "object") {
    throw new TypeError(
      "Vercel OIDC token is malformed. Expected an object. Please run `vc env pull` and try again"
    );
  }
  if (!("token" in res) || typeof res.token !== "string") {
    throw new TypeError(
      "Vercel OIDC token is malformed. Expected a string-valued token property. Please run `vc env pull` and try again"
    );
  }
}
function findProjectInfo() {
  const dir = (0, import_token_io.findRootDir)();
  if (!dir) {
    throw new import_token_error.VercelOidcTokenError(
      "Unable to find project root directory. Have you linked your project with `vc link?`"
    );
  }
  const prjPath = path.join(dir, ".vercel", "project.json");
  if (!fs.existsSync(prjPath)) {
    throw new import_token_error.VercelOidcTokenError(
      "project.json not found, have you linked your project with `vc link?`"
    );
  }
  const prj = JSON.parse(fs.readFileSync(prjPath, "utf8"));
  if (typeof prj.projectId !== "string" && typeof prj.orgId !== "string") {
    throw new TypeError(
      "Expected a string-valued projectId property. Try running `vc link` to re-link your project."
    );
  }
  return { projectId: prj.projectId, teamId: prj.orgId };
}
function saveToken(token, projectId) {
  const dir = (0, import_token_io.getUserDataDir)();
  if (!dir) {
    throw new import_token_error.VercelOidcTokenError(
      "Unable to find user data directory. Please reach out to Vercel support."
    );
  }
  const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
  const tokenJson = JSON.stringify(token);
  fs.mkdirSync(path.dirname(tokenPath), { mode: 504, recursive: true });
  fs.writeFileSync(tokenPath, tokenJson);
  fs.chmodSync(tokenPath, 432);
  return;
}
function loadToken(projectId) {
  const dir = (0, import_token_io.getUserDataDir)();
  if (!dir) {
    throw new import_token_error.VercelOidcTokenError(
      "Unable to find user data directory. Please reach out to Vercel support."
    );
  }
  const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  assertVercelOidcTokenResponse(token);
  return token;
}
function getTokenPayload(token) {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    throw new import_token_error.VercelOidcTokenError(
      "Invalid token. Please run `vc env pull` and try again"
    );
  }
  const base64 = tokenParts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + (4 - base64.length % 4) % 4,
    "="
  );
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}
function isExpired(token) {
  return token.exp * 1e3 < Date.now();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (0);


/***/ })

};
;