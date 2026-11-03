import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/env-resolver.ts
var EnvironmentResolver;
var init_env_resolver = __esm({
  "src/utils/env-resolver.ts"() {
    "use strict";
    EnvironmentResolver = class {
      /**
       * Resolves a single configuration value that may contain environment variable references
       */
      static resolveValue(value) {
        if (typeof value !== "string") {
          return value;
        }
        let resolved = value.replace(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        resolved = resolved.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        resolved = resolved.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, envVar) => {
          return process.env[envVar] || match;
        });
        return resolved;
      }
      /**
       * Resolves all environment variables in an EnvConfig object
       */
      static resolveEnvConfig(envConfig) {
        const resolved = {};
        for (const [key, value] of Object.entries(envConfig)) {
          resolved[key] = this.resolveValue(value);
        }
        return resolved;
      }
      /**
       * Applies environment configuration to the process environment
       * This allows checks to access their specific environment variables
       */
      static applyEnvConfig(envConfig) {
        const resolved = this.resolveEnvConfig(envConfig);
        for (const [key, value] of Object.entries(resolved)) {
          if (value !== void 0) {
            process.env[key] = String(value);
          }
        }
      }
      /**
       * Creates a temporary environment for a specific check execution
       * Returns a cleanup function to restore the original environment
       */
      static withTemporaryEnv(envConfig, callback) {
        const resolved = this.resolveEnvConfig(envConfig);
        const originalValues = {};
        for (const [key, value] of Object.entries(resolved)) {
          originalValues[key] = process.env[key];
          if (value !== void 0) {
            process.env[key] = String(value);
          }
        }
        try {
          const result = callback();
          if (result instanceof Promise) {
            return result.finally(() => {
              for (const [key, originalValue] of Object.entries(originalValues)) {
                if (originalValue === void 0) {
                  delete process.env[key];
                } else {
                  process.env[key] = originalValue;
                }
              }
            });
          }
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
          return result;
        } catch (error) {
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
          throw error;
        }
      }
      /**
       * Validates that all required environment variables are available
       */
      static validateRequiredEnvVars(envConfig, requiredVars) {
        const resolved = this.resolveEnvConfig(envConfig);
        const missing = [];
        for (const varName of requiredVars) {
          const value = resolved[varName] || process.env[varName];
          if (!value) {
            missing.push(varName);
          }
        }
        return missing;
      }
      /**
       * Resolves environment variables in HTTP headers
       * Each header value is processed through resolveValue to replace env var references
       */
      static resolveHeaders(headers) {
        const resolved = {};
        for (const [key, value] of Object.entries(headers)) {
          resolved[key] = String(this.resolveValue(value));
        }
        return resolved;
      }
      /**
       * Sanitizes headers for logging/telemetry by redacting sensitive values
       * Headers like Authorization, API keys, and cookies are replaced with [REDACTED]
       */
      static sanitizeHeaders(headers) {
        const sensitiveHeaders = ["authorization", "x-api-key", "cookie", "set-cookie"];
        const sanitized = {};
        for (const [key, value] of Object.entries(headers)) {
          if (sensitiveHeaders.includes(key.toLowerCase())) {
            sanitized[key] = "[REDACTED]";
          } else {
            sanitized[key] = value;
          }
        }
        return sanitized;
      }
    };
  }
});

export {
  EnvironmentResolver,
  init_env_resolver
};
//# sourceMappingURL=chunk-7QI6F66G.mjs.map