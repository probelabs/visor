import {
  SpanStatusCode,
  context,
  init_lazy_otel,
  trace
} from "./chunk-UCMJJ3IM.mjs";
import {
  __commonJS,
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-J7LXIPZS.mjs";

// src/telemetry/fallback-ndjson.ts
var fallback_ndjson_exports = {};
__export(fallback_ndjson_exports, {
  emitNdjsonFallback: () => emitNdjsonFallback,
  emitNdjsonSpanWithEvents: () => emitNdjsonSpanWithEvents,
  flushNdjson: () => flushNdjson
});
import * as fs from "fs";
import * as path from "path";
function resolveTargetPath(outDir) {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) {
    CURRENT_FILE = process.env.VISOR_FALLBACK_TRACE_FILE;
    return CURRENT_FILE;
  }
  if (CURRENT_FILE) return CURRENT_FILE;
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  CURRENT_FILE = path.join(outDir, `${ts}.ndjson`);
  return CURRENT_FILE;
}
function isEnabled() {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) return true;
  return process.env.VISOR_TELEMETRY_ENABLED === "true" && (process.env.VISOR_TELEMETRY_SINK || "file") === "file";
}
function appendAsync(outDir, line) {
  writeChain = writeChain.then(async () => {
    if (!dirReady) {
      try {
        await fs.promises.mkdir(outDir, { recursive: true });
      } catch {
      }
      dirReady = true;
    }
    const target = resolveTargetPath(outDir);
    await fs.promises.appendFile(target, line, "utf8");
  }).catch(() => {
  });
}
async function flushNdjson() {
  try {
    await writeChain;
  } catch {
  }
}
function emitNdjsonFallback(name, attrs) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify({ name, attributes: attrs }) + "\n";
    appendAsync(outDir, line);
  } catch {
  }
}
function emitNdjsonSpanWithEvents(name, attrs, events) {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), "output", "traces");
    const line = JSON.stringify({ name, attributes: attrs, events }) + "\n";
    appendAsync(outDir, line);
  } catch {
  }
}
var CURRENT_FILE, dirReady, writeChain;
var init_fallback_ndjson = __esm({
  "src/telemetry/fallback-ndjson.ts"() {
    "use strict";
    CURRENT_FILE = null;
    dirReady = false;
    writeChain = Promise.resolve();
  }
});

// package.json
var require_package = __commonJS({
  "package.json"(exports, module) {
    module.exports = {
      name: "@probelabs/visor",
      version: "0.1.42",
      main: "dist/index.js",
      bin: {
        visor: "./dist/index.js"
      },
      exports: {
        ".": {
          require: "./dist/index.js",
          import: "./dist/index.js"
        },
        "./sdk": {
          types: "./dist/sdk/sdk.d.ts",
          import: "./dist/sdk/sdk.mjs",
          require: "./dist/sdk/sdk.js"
        },
        "./cli": {
          require: "./dist/index.js"
        }
      },
      files: [
        "dist/",
        "defaults/",
        "action.yml",
        "README.md",
        "LICENSE"
      ],
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/"
      },
      scripts: {
        "build:cli": "ncc build src/index.ts -o dist && cp -r defaults dist/ && cp -r output dist/ && cp -r docs dist/ && cp -r examples dist/ && cp -r src/debug-visualizer/ui dist/debug-visualizer/ && node scripts/inject-version.js && echo '#!/usr/bin/env node' | cat - dist/index.js > temp && mv temp dist/index.js && chmod +x dist/index.js",
        "build:sdk": "tsup src/sdk.ts --dts --sourcemap --format esm,cjs --out-dir dist/sdk",
        build: "./scripts/build-oss.sh",
        "build:ee": "npm run build:cli && npm run build:sdk",
        test: "jest && npm run test:yaml",
        "test:unit": "jest",
        prepublishOnly: "npm run build",
        "test:watch": "jest --watch",
        "test:coverage": "jest --coverage",
        "test:ee": "jest --testPathPatterns='tests/ee' --testPathIgnorePatterns='/node_modules/' --no-coverage",
        "test:manual:bash": "RUN_MANUAL_TESTS=true jest tests/manual/bash-config-manual.test.ts",
        lint: "eslint src tests --ext .ts",
        "lint:fix": "eslint src tests --ext .ts --fix",
        format: "prettier --write src tests",
        "format:check": "prettier --check src tests",
        clean: "",
        prebuild: "npm run clean && node scripts/generate-config-schema.js",
        pretest: "node scripts/generate-config-schema.js && npm run build:cli",
        "pretest:unit": "node scripts/generate-config-schema.js && npm run build:cli",
        "test:with-build": "npm run build:cli && jest",
        "test:yaml": "node dist/index.js test --progress compact",
        "test:yaml:parallel": "node dist/index.js test --progress compact --max-parallel 4",
        prepare: "husky",
        "pre-commit": "lint-staged",
        "deploy:site": "cd site && npx wrangler pages deploy . --project-name=visor-site --commit-dirty=true",
        "deploy:worker": "npx wrangler deploy",
        deploy: "npm run deploy:site && npm run deploy:worker",
        "publish:ee": "./scripts/publish-ee.sh",
        release: "./scripts/release.sh",
        "release:patch": "./scripts/release.sh patch",
        "release:minor": "./scripts/release.sh minor",
        "release:major": "./scripts/release.sh major",
        "release:prerelease": "./scripts/release.sh prerelease",
        "docs:validate": "node scripts/validate-readme-links.js",
        "workshop:setup": "npm install -D reveal-md@6.1.2",
        "workshop:serve": "cd workshop && reveal-md slides.md -w",
        "workshop:export": "reveal-md workshop/slides.md --static workshop/build",
        "workshop:pdf": "reveal-md workshop/slides.md --print workshop/Visor-Workshop.pdf --print-size letter",
        "workshop:pdf:ci": 'reveal-md workshop/slides.md --print workshop/Visor-Workshop.pdf --print-size letter --puppeteer-launch-args="--no-sandbox --disable-dev-shm-usage"',
        "workshop:pdf:a4": "reveal-md workshop/slides.md --print workshop/Visor-Workshop-A4.pdf --print-size A4",
        "workshop:build": "npm run workshop:export && npm run workshop:pdf",
        "simulate:issue": "TS_NODE_TRANSPILE_ONLY=1 ts-node scripts/simulate-gh-run.ts --event issues --action opened --debug",
        "simulate:comment": "TS_NODE_TRANSPILE_ONLY=1 ts-node scripts/simulate-gh-run.ts --event issue_comment --action created --debug"
      },
      keywords: [
        "code-review",
        "ai",
        "github-action",
        "cli",
        "pr-review",
        "visor"
      ],
      author: "Probe Labs",
      license: "MIT",
      description: "AI-powered code review tool for GitHub Pull Requests - CLI and GitHub Action",
      repository: {
        type: "git",
        url: "git+https://github.com/probelabs/visor.git"
      },
      bugs: {
        url: "https://github.com/probelabs/visor/issues"
      },
      homepage: "https://github.com/probelabs/visor#readme",
      dependencies: {
        "@actions/core": "^1.11.1",
        "@modelcontextprotocol/sdk": "^1.25.3",
        "@nyariv/sandboxjs": "github:probelabs/SandboxJS#f1c13b8eee98734a8ea024061eada4aa9a9ff2e9",
        "@octokit/action": "^8.0.2",
        "@octokit/auth-app": "^8.1.0",
        "@octokit/core": "^7.0.3",
        "@octokit/rest": "^22.0.0",
        "@probelabs/probe": "^0.6.0-rc230",
        "@types/commander": "^2.12.0",
        "@types/uuid": "^10.0.0",
        ajv: "^8.17.1",
        "ajv-formats": "^3.0.1",
        "better-sqlite3": "^11.0.0",
        blessed: "^0.1.81",
        "cli-table3": "^0.6.5",
        commander: "^14.0.0",
        dotenv: "^17.2.3",
        ignore: "^7.0.5",
        "js-yaml": "^4.1.0",
        liquidjs: "^10.21.1",
        "node-cron": "^3.0.3",
        open: "^9.1.0",
        "simple-git": "^3.28.0",
        uuid: "^11.1.0",
        ws: "^8.18.3"
      },
      optionalDependencies: {
        "@anthropic/claude-code-sdk": "npm:null@*",
        "@open-policy-agent/opa-wasm": "^1.10.0",
        "@opentelemetry/api": "^1.9.0",
        "@opentelemetry/core": "^1.30.1",
        "@opentelemetry/exporter-trace-otlp-grpc": "^0.203.0",
        "@opentelemetry/exporter-trace-otlp-http": "^0.203.0",
        "@opentelemetry/instrumentation": "^0.203.0",
        "@opentelemetry/resources": "^1.30.1",
        "@opentelemetry/sdk-metrics": "^1.30.1",
        "@opentelemetry/sdk-node": "^0.203.0",
        "@opentelemetry/sdk-trace-base": "^1.30.1",
        "@opentelemetry/semantic-conventions": "^1.30.1",
        knex: "^3.1.0",
        mysql2: "^3.11.0",
        pg: "^8.13.0",
        tedious: "^19.0.0"
      },
      devDependencies: {
        "@eslint/js": "^9.34.0",
        "@kie/act-js": "^2.6.2",
        "@kie/mock-github": "^2.0.1",
        "@swc/core": "^1.13.2",
        "@swc/jest": "^0.2.37",
        "@types/better-sqlite3": "^7.6.0",
        "@types/blessed": "^0.1.27",
        "@types/jest": "^30.0.0",
        "@types/js-yaml": "^4.0.9",
        "@types/node": "^24.3.0",
        "@types/node-cron": "^3.0.11",
        "@types/ws": "^8.18.1",
        "@typescript-eslint/eslint-plugin": "^8.42.0",
        "@typescript-eslint/parser": "^8.42.0",
        "@vercel/ncc": "^0.38.4",
        eslint: "^9.34.0",
        "eslint-config-prettier": "^10.1.8",
        "eslint-plugin-prettier": "^5.5.4",
        husky: "^9.1.7",
        jest: "^30.1.3",
        "lint-staged": "^16.1.6",
        prettier: "^3.6.2",
        "reveal-md": "^6.1.2",
        "ts-json-schema-generator": "^1.5.1",
        "ts-node": "^10.9.2",
        tsup: "^8.5.0",
        typescript: "^5.9.2",
        wrangler: "^3.0.0"
      },
      peerDependenciesMeta: {
        "@anthropic/claude-code-sdk": {
          optional: true
        }
      },
      directories: {
        test: "tests"
      },
      "lint-staged": {
        "src/**/*.{ts,js}": [
          "eslint --fix",
          "prettier --write"
        ],
        "tests/**/*.{ts,js}": [
          "eslint --fix",
          "prettier --write"
        ],
        "*.{json,md,yml,yaml}": [
          "prettier --write"
        ]
      }
    };
  }
});

// src/telemetry/trace-helpers.ts
var trace_helpers_exports = {};
__export(trace_helpers_exports, {
  __getOrCreateNdjsonPath: () => __getOrCreateNdjsonPath,
  _appendRunMarker: () => _appendRunMarker,
  addEvent: () => addEvent,
  getTracer: () => getTracer,
  getVisorRunAttributes: () => getVisorRunAttributes,
  setSpanAttributes: () => setSpanAttributes,
  setSpanError: () => setSpanError,
  withActiveSpan: () => withActiveSpan
});
function getTracer() {
  return trace.getTracer("visor");
}
async function withActiveSpan(name, attrs, fn) {
  const tracer = getTracer();
  return await new Promise((resolve, reject) => {
    const callback = async (span) => {
      try {
        const res = await fn(span);
        resolve(res);
      } catch (err) {
        try {
          if (err instanceof Error) span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {
        }
        reject(err);
      } finally {
        try {
          span.end();
        } catch {
        }
      }
    };
    const options = attrs ? { attributes: attrs } : {};
    tracer.startActiveSpan(name, options, callback);
  });
}
function addEvent(name, attrs) {
  const span = trace.getSpan(context.active());
  if (span) {
    try {
      span.addEvent(name, attrs);
    } catch {
    }
  }
  try {
    const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
    emitNdjsonSpanWithEvents2("visor.event", {}, [{ name, attrs }]);
    if (name === "fail_if.triggered") {
      emitNdjsonSpanWithEvents2("visor.event", {}, [
        { name: "fail_if.evaluated", attrs },
        { name: "fail_if.triggered", attrs }
      ]);
    }
  } catch {
  }
}
function setSpanAttributes(attrs) {
  const span = trace.getSpan(context.active());
  if (!span) return;
  try {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } catch {
  }
}
function setSpanError(err) {
  const span = trace.getSpan(context.active());
  if (!span) return;
  try {
    if (err instanceof Error) span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
  }
}
function getVisorRunAttributes() {
  const attrs = {};
  try {
    attrs["visor.version"] = process.env.VISOR_VERSION || (require_package()?.version ?? "dev");
  } catch {
    attrs["visor.version"] = "dev";
  }
  const commitShort = process.env.VISOR_COMMIT_SHORT || "";
  const commitFull = process.env.VISOR_COMMIT_SHA || process.env.VISOR_COMMIT || "";
  if (commitShort) {
    attrs["visor.commit"] = commitShort;
  }
  if (commitFull) {
    attrs["visor.commit.sha"] = commitFull;
  }
  return attrs;
}
function __getOrCreateNdjsonPath() {
  try {
    if (process.env.VISOR_TELEMETRY_SINK && process.env.VISOR_TELEMETRY_SINK !== "file")
      return null;
    const path2 = __require("path");
    const fs2 = __require("fs");
    if (process.env.VISOR_FALLBACK_TRACE_FILE) {
      __ndjsonPath = process.env.VISOR_FALLBACK_TRACE_FILE;
      const dir = path2.dirname(__ndjsonPath);
      if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
      return __ndjsonPath;
    }
    const outDir = process.env.VISOR_TRACE_DIR || path2.join(process.cwd(), "output", "traces");
    if (!fs2.existsSync(outDir)) fs2.mkdirSync(outDir, { recursive: true });
    if (!__ndjsonPath) {
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      __ndjsonPath = path2.join(outDir, `${ts}.ndjson`);
    }
    return __ndjsonPath;
  } catch {
    return null;
  }
}
function _appendRunMarker() {
  try {
    const fs2 = __require("fs");
    const p = __getOrCreateNdjsonPath();
    if (!p) return;
    const line = { name: "visor.run", attributes: { started: true } };
    fs2.appendFileSync(p, JSON.stringify(line) + "\n", "utf8");
  } catch {
  }
}
var __ndjsonPath;
var init_trace_helpers = __esm({
  "src/telemetry/trace-helpers.ts"() {
    init_lazy_otel();
    __ndjsonPath = null;
  }
});

export {
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  getTracer,
  withActiveSpan,
  addEvent,
  setSpanAttributes,
  setSpanError,
  getVisorRunAttributes,
  __getOrCreateNdjsonPath,
  _appendRunMarker,
  trace_helpers_exports,
  init_trace_helpers
};
//# sourceMappingURL=chunk-HRRUGILI.mjs.map