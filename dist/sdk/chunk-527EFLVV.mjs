import {
  ConfigMerger,
  config_merger_exports,
  init_config_merger
} from "./chunk-O5EZDNYL.mjs";
import {
  init_logger,
  logger
} from "./chunk-VMPLF6FT.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/utils/config-loader.ts
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
var ConfigLoader;
var init_config_loader = __esm({
  "src/utils/config-loader.ts"() {
    "use strict";
    ConfigLoader = class {
      constructor(options = {}) {
        this.options = options;
        this.options = {
          allowRemote: true,
          cacheTTL: 5 * 60 * 1e3,
          // 5 minutes
          timeout: 30 * 1e3,
          // 30 seconds
          maxDepth: 10,
          allowedRemotePatterns: [],
          // Empty by default for security
          projectRoot: this.findProjectRoot(),
          ...options
        };
      }
      cache = /* @__PURE__ */ new Map();
      loadedConfigs = /* @__PURE__ */ new Set();
      /**
       * Determine the source type from a string
       */
      getSourceType(source) {
        if (source === "default") {
          return "default" /* DEFAULT */;
        }
        if (source.startsWith("http://") || source.startsWith("https://")) {
          return "remote" /* REMOTE */;
        }
        return "local" /* LOCAL */;
      }
      /**
       * Fetch configuration from any source
       */
      async fetchConfig(source, currentDepth = 0) {
        if (currentDepth >= (this.options.maxDepth || 10)) {
          throw new Error(
            `Maximum extends depth (${this.options.maxDepth}) exceeded. Check for circular dependencies.`
          );
        }
        const normalizedSource = this.normalizeSource(source);
        if (this.loadedConfigs.has(normalizedSource)) {
          throw new Error(
            `Circular dependency detected: ${normalizedSource} is already in the extends chain`
          );
        }
        const sourceType = this.getSourceType(source);
        try {
          this.loadedConfigs.add(normalizedSource);
          switch (sourceType) {
            case "default" /* DEFAULT */:
              return await this.fetchDefaultConfig();
            case "remote" /* REMOTE */:
              if (!this.options.allowRemote) {
                throw new Error(
                  "Remote extends are disabled. Enable with --allow-remote-extends or remove VISOR_NO_REMOTE_EXTENDS environment variable."
                );
              }
              return await this.fetchRemoteConfig(source);
            case "local" /* LOCAL */:
              return await this.fetchLocalConfig(source);
            default:
              throw new Error(`Unknown configuration source: ${source}`);
          }
        } finally {
          this.loadedConfigs.delete(normalizedSource);
        }
      }
      /**
       * Normalize source path/URL for comparison
       */
      normalizeSource(source) {
        const sourceType = this.getSourceType(source);
        switch (sourceType) {
          case "default" /* DEFAULT */:
            return "default";
          case "remote" /* REMOTE */:
            return source.toLowerCase();
          case "local" /* LOCAL */:
            const basePath = this.options.baseDir || process.cwd();
            return path.resolve(basePath, source);
          default:
            return source;
        }
      }
      /**
       * Load configuration from local file system
       */
      async fetchLocalConfig(filePath) {
        const basePath = this.options.baseDir || process.cwd();
        const resolvedPath = path.resolve(basePath, filePath);
        this.validateLocalPath(resolvedPath);
        try {
          const content = fs.readFileSync(resolvedPath, "utf8");
          const config = yaml.load(content);
          if (!config || typeof config !== "object") {
            throw new Error(`Invalid YAML in configuration file: ${resolvedPath}`);
          }
          if (config.include && !config.extends) {
            const inc = config.include;
            config.extends = Array.isArray(inc) ? inc : [inc];
            delete config.include;
          }
          const previousBaseDir = this.options.baseDir;
          this.options.baseDir = path.dirname(resolvedPath);
          try {
            if (config.extends) {
              const processedConfig = await this.processExtends(config);
              return processedConfig;
            }
            return config;
          } finally {
            this.options.baseDir = previousBaseDir;
          }
        } catch (error) {
          if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            throw new Error(`Configuration file not found: ${resolvedPath}`);
          }
          if (error instanceof Error) {
            throw new Error(`Failed to load configuration from ${resolvedPath}: ${error.message}`);
          }
          throw error;
        }
      }
      /**
       * Fetch configuration from remote URL
       */
      async fetchRemoteConfig(url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error(`Invalid URL: ${url}. Only HTTP and HTTPS protocols are supported.`);
        }
        this.validateRemoteURL(url);
        const cacheEntry = this.cache.get(url);
        if (cacheEntry && Date.now() - cacheEntry.timestamp < cacheEntry.ttl) {
          const outputFormat2 = process.env.VISOR_OUTPUT_FORMAT;
          const logFn2 = outputFormat2 === "json" || outputFormat2 === "sarif" ? console.error : console.log;
          logFn2(`\u{1F4E6} Using cached configuration from: ${url}`);
          return cacheEntry.config;
        }
        const outputFormat = process.env.VISOR_OUTPUT_FORMAT;
        const logFn = outputFormat === "json" || outputFormat === "sarif" ? console.error : console.log;
        logFn(`\u2B07\uFE0F  Fetching remote configuration from: ${url}`);
        const controller = new AbortController();
        const timeoutMs = this.options.timeout ?? 3e4;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "Visor/1.0"
            }
          });
          if (!response.ok) {
            throw new Error(`Failed to fetch config: ${response.status} ${response.statusText}`);
          }
          const content = await response.text();
          const config = yaml.load(content);
          if (!config || typeof config !== "object") {
            throw new Error(`Invalid YAML in remote configuration: ${url}`);
          }
          this.cache.set(url, {
            config,
            timestamp: Date.now(),
            ttl: this.options.cacheTTL || 5 * 60 * 1e3
          });
          if (config.extends) {
            return await this.processExtends(config);
          }
          return config;
        } catch (error) {
          if (error instanceof Error) {
            if (error.name === "AbortError") {
              throw new Error(`Timeout fetching configuration from ${url} (${timeoutMs}ms)`);
            }
            throw new Error(`Failed to fetch remote configuration from ${url}: ${error.message}`);
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      }
      /**
       * Load bundled default configuration
       */
      async fetchDefaultConfig() {
        const possiblePaths = [
          // Only support new non-dot filename
          path.join(__dirname, "defaults", "visor.yaml"),
          // When running from source
          path.join(__dirname, "..", "..", "defaults", "visor.yaml"),
          // Try via package root
          this.findPackageRoot() ? path.join(this.findPackageRoot(), "defaults", "visor.yaml") : "",
          // GitHub Action environment variable
          process.env.GITHUB_ACTION_PATH ? path.join(process.env.GITHUB_ACTION_PATH, "defaults", "visor.yaml") : "",
          process.env.GITHUB_ACTION_PATH ? path.join(process.env.GITHUB_ACTION_PATH, "dist", "defaults", "visor.yaml") : ""
        ].filter((p) => p);
        let defaultConfigPath;
        for (const possiblePath of possiblePaths) {
          if (fs.existsSync(possiblePath)) {
            defaultConfigPath = possiblePath;
            break;
          }
        }
        if (defaultConfigPath) {
          console.error(`\u{1F4E6} Loading bundled default configuration from ${defaultConfigPath}`);
          const content = fs.readFileSync(defaultConfigPath, "utf8");
          let config = yaml.load(content);
          if (!config || typeof config !== "object") {
            throw new Error("Invalid default configuration");
          }
          if (config.include && !config.extends) {
            const inc = config.include;
            config.extends = Array.isArray(inc) ? inc : [inc];
            delete config.include;
          }
          config = this.normalizeStepsAndChecks(config);
          if (config.extends) {
            const previousBaseDir = this.options.baseDir;
            try {
              this.options.baseDir = path.dirname(defaultConfigPath);
              return await this.processExtends(config);
            } finally {
              this.options.baseDir = previousBaseDir;
            }
          }
          return config;
        }
        console.warn("\u26A0\uFE0F  Bundled default configuration not found, using minimal defaults");
        return {
          version: "1.0",
          checks: {},
          output: {
            pr_comment: {
              format: "markdown",
              group_by: "check",
              collapse: true
            }
          }
        };
      }
      /**
       * Process extends directive in a configuration
       */
      async processExtends(config) {
        if (!config.extends) {
          return config;
        }
        const extends_ = Array.isArray(config.extends) ? config.extends : [config.extends];
        const { extends: _extendsField, ...configWithoutExtends } = config;
        const parentConfigs = [];
        for (const source of extends_) {
          const parentConfig = await this.fetchConfig(source, this.loadedConfigs.size);
          parentConfigs.push(parentConfig);
        }
        const { ConfigMerger: ConfigMerger2 } = await import("./config-merger-PX3WIT57.mjs");
        const merger = new ConfigMerger2();
        let mergedParents = {};
        for (const parentConfig of parentConfigs) {
          mergedParents = merger.merge(mergedParents, parentConfig);
        }
        return merger.merge(mergedParents, configWithoutExtends);
      }
      /**
       * Find project root directory (for security validation)
       */
      findProjectRoot() {
        try {
          const { execSync } = __require("child_process");
          const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
          if (gitRoot) return gitRoot;
        } catch {
        }
        const packageRoot = this.findPackageRoot();
        if (packageRoot) return packageRoot;
        return process.cwd();
      }
      /**
       * Validate remote URL against allowlist
       */
      validateRemoteURL(url) {
        const allowedPatterns = this.options.allowedRemotePatterns || [];
        if (allowedPatterns.length === 0) {
          return;
        }
        const isAllowed = allowedPatterns.some((pattern) => url.startsWith(pattern));
        if (!isAllowed) {
          throw new Error(
            `Security error: URL ${url} is not in the allowed list. Allowed patterns: ${allowedPatterns.join(", ")}`
          );
        }
      }
      /**
       * Validate local path against traversal attacks
       */
      validateLocalPath(resolvedPath) {
        const projectRoot = this.options.projectRoot || process.cwd();
        const normalizedPath = path.normalize(resolvedPath);
        const normalizedRoot = path.normalize(projectRoot);
        if (!normalizedPath.startsWith(normalizedRoot)) {
          throw new Error(
            `Security error: Path traversal detected. Cannot access files outside project root: ${projectRoot}`
          );
        }
        const sensitivePatterns = [
          "/etc/passwd",
          "/etc/shadow",
          "/.ssh/",
          "/.aws/",
          "/.env",
          "/private/"
        ];
        const lowerPath = normalizedPath.toLowerCase();
        for (const pattern of sensitivePatterns) {
          if (lowerPath.includes(pattern)) {
            throw new Error(`Security error: Cannot access potentially sensitive file: ${pattern}`);
          }
        }
      }
      /**
       * Find package root directory
       */
      findPackageRoot() {
        let currentDir = __dirname;
        const root = path.parse(currentDir).root;
        while (currentDir !== root) {
          const packageJsonPath = path.join(currentDir, "package.json");
          if (fs.existsSync(packageJsonPath)) {
            try {
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
              if (packageJson.name === "@probelabs/visor") {
                return currentDir;
              }
            } catch {
            }
          }
          currentDir = path.dirname(currentDir);
        }
        return null;
      }
      /**
       * Clear the configuration cache
       */
      clearCache() {
        this.cache.clear();
      }
      /**
       * Reset the loaded configs tracking (for testing)
       */
      reset() {
        this.loadedConfigs.clear();
        this.clearCache();
      }
      /**
       * Normalize 'checks' and 'steps' keys for backward compatibility
       * Ensures both keys are present and contain the same data
       */
      normalizeStepsAndChecks(config) {
        if (config.steps && config.checks) {
          const merged = { ...config.checks, ...config.steps };
          config.checks = merged;
          config.steps = merged;
        } else if (config.steps && !config.checks) {
          config.checks = config.steps;
        } else if (config.checks && !config.steps) {
          config.steps = config.checks;
        }
        return config;
      }
    };
  }
});

// src/generated/config-schema.ts
var config_schema_exports = {};
__export(config_schema_exports, {
  configSchema: () => configSchema,
  default: () => config_schema_default
});
var configSchema, config_schema_default;
var init_config_schema = __esm({
  "src/generated/config-schema.ts"() {
    "use strict";
    configSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $ref: "#/definitions/VisorConfigSchema",
      definitions: {
        VisorConfigSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            hooks: {
              $ref: "#/definitions/Record%3Cstring%2Cunknown%3E"
            },
            version: {
              type: "string",
              description: "Configuration version"
            },
            extends: {
              anyOf: [
                {
                  type: "string"
                },
                {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              ],
              description: 'Extends from other configurations - can be file path, HTTP(S) URL, or "default"'
            },
            include: {
              anyOf: [
                {
                  type: "string"
                },
                {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              ],
              description: "Alias for extends - include from other configurations (backward compatibility)"
            },
            tools: {
              $ref: "#/definitions/Record%3Cstring%2CCustomToolDefinition%3E",
              description: "Custom tool definitions that can be used in MCP blocks"
            },
            imports: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Import workflow definitions from external files or URLs"
            },
            steps: {
              $ref: "#/definitions/Record%3Cstring%2CCheckConfig%3E",
              description: "Step configurations (recommended)"
            },
            checks: {
              $ref: "#/definitions/Record%3Cstring%2CCheckConfig%3E",
              description: "Check configurations (legacy, use 'steps' instead) - always populated after normalization"
            },
            output: {
              $ref: "#/definitions/OutputConfig",
              description: "Output configuration"
            },
            http_server: {
              $ref: "#/definitions/HttpServerConfig",
              description: "HTTP server configuration for receiving webhooks"
            },
            memory: {
              $ref: "#/definitions/MemoryConfig",
              description: "Memory storage configuration"
            },
            env: {
              $ref: "#/definitions/EnvConfig",
              description: "Global environment variables"
            },
            ai_model: {
              type: "string",
              description: "Global AI model setting"
            },
            ai_provider: {
              type: "string",
              description: "Global AI provider setting"
            },
            ai_mcp_servers: {
              $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E",
              description: "Global MCP servers configuration for AI checks"
            },
            max_parallelism: {
              type: "number",
              description: "Maximum number of checks to run in parallel (default: 3)"
            },
            fail_fast: {
              type: "boolean",
              description: "Stop execution when any check fails (default: false)"
            },
            fail_if: {
              type: "string",
              description: "Simple global fail condition - fails if expression evaluates to true"
            },
            failure_conditions: {
              $ref: "#/definitions/FailureConditions",
              description: "Global failure conditions - optional (deprecated, use fail_if)"
            },
            tag_filter: {
              $ref: "#/definitions/TagFilter",
              description: "Tag filter for selective check execution"
            },
            routing: {
              $ref: "#/definitions/RoutingDefaults",
              description: "Optional routing defaults for retry/goto/run policies"
            },
            limits: {
              $ref: "#/definitions/LimitsConfig",
              description: "Global execution limits"
            },
            frontends: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Frontend name, e.g., 'ndjson-sink', 'github'"
                  },
                  config: {
                    description: "Frontend-specific configuration"
                  }
                },
                required: ["name"],
                additionalProperties: false
              },
              description: "Optional integrations: event-driven frontends (e.g., ndjson-sink, github)"
            }
          },
          required: ["output", "version"],
          patternProperties: {
            "^x-": {}
          }
        },
        "Record<string,unknown>": {
          type: "object",
          additionalProperties: {}
        },
        "Record<string,CustomToolDefinition>": {
          type: "object",
          additionalProperties: {
            $ref: "#/definitions/CustomToolDefinition"
          }
        },
        CustomToolDefinition: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Tool name - used to reference the tool in MCP blocks"
            },
            description: {
              type: "string",
              description: "Description of what the tool does"
            },
            inputSchema: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  const: "object"
                },
                properties: {
                  $ref: "#/definitions/Record%3Cstring%2Cunknown%3E"
                },
                required: {
                  type: "array",
                  items: {
                    type: "string"
                  }
                },
                additionalProperties: {
                  type: "boolean"
                }
              },
              required: ["type"],
              additionalProperties: false,
              description: "Input schema for the tool (JSON Schema format)",
              patternProperties: {
                "^x-": {}
              }
            },
            exec: {
              type: "string",
              description: "Command to execute - supports Liquid template"
            },
            stdin: {
              type: "string",
              description: "Optional stdin input - supports Liquid template"
            },
            transform: {
              type: "string",
              description: "Transform the raw output - supports Liquid template"
            },
            transform_js: {
              type: "string",
              description: "Transform the output using JavaScript - alternative to transform"
            },
            cwd: {
              type: "string",
              description: "Working directory for command execution"
            },
            env: {
              $ref: "#/definitions/Record%3Cstring%2Cstring%3E",
              description: "Environment variables for the command"
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds"
            },
            parseJson: {
              type: "boolean",
              description: "Whether to parse output as JSON automatically"
            },
            outputSchema: {
              $ref: "#/definitions/Record%3Cstring%2Cunknown%3E",
              description: "Expected output schema for validation"
            }
          },
          required: ["name", "exec"],
          additionalProperties: false,
          description: "Custom tool definition for use in MCP blocks",
          patternProperties: {
            "^x-": {}
          }
        },
        "Record<string,string>": {
          type: "object",
          additionalProperties: {
            type: "string"
          }
        },
        "Record<string,CheckConfig>": {
          type: "object",
          additionalProperties: {
            $ref: "#/definitions/CheckConfig"
          }
        },
        CheckConfig: {
          type: "object",
          properties: {
            type: {
              $ref: "#/definitions/ConfigCheckType",
              description: "Type of check to perform (defaults to 'ai' if not specified)"
            },
            prompt: {
              type: "string",
              description: "AI prompt for the check - can be inline string or file path (auto-detected) - required for AI checks"
            },
            appendPrompt: {
              type: "string",
              description: "Additional prompt to append when extending configurations - merged with parent prompt"
            },
            exec: {
              type: "string",
              description: "Command execution with Liquid template support - required for command checks"
            },
            stdin: {
              type: "string",
              description: "Stdin input for tools with Liquid template support - optional for tool checks"
            },
            url: {
              type: "string",
              description: "HTTP URL - required for http output checks"
            },
            body: {
              type: "string",
              description: "HTTP body template (Liquid) - required for http output checks"
            },
            method: {
              type: "string",
              description: "HTTP method (defaults to POST)"
            },
            headers: {
              $ref: "#/definitions/Record%3Cstring%2Cstring%3E",
              description: "HTTP headers"
            },
            endpoint: {
              type: "string",
              description: "HTTP endpoint path - required for http_input checks"
            },
            transform: {
              type: "string",
              description: "Transform template for http_input data (Liquid) - optional"
            },
            transform_js: {
              type: "string",
              description: "Transform using JavaScript expressions (evaluated in secure sandbox) - optional"
            },
            content: {
              type: "string",
              description: "Script content to execute for script checks"
            },
            schedule: {
              type: "string",
              description: 'Cron schedule expression (e.g., "0 2 * * *") - optional for any check type'
            },
            focus: {
              type: "string",
              description: "Focus area for the check (security/performance/style/architecture/all) - optional"
            },
            command: {
              type: "string",
              description: 'Command that triggers this check (e.g., "review", "security-scan") - optional'
            },
            on: {
              type: "array",
              items: {
                $ref: "#/definitions/EventTrigger"
              },
              description: "Events that trigger this check (defaults to ['manual'] if not specified)"
            },
            triggers: {
              type: "array",
              items: {
                type: "string"
              },
              description: "File patterns that trigger this check (optional)"
            },
            ai: {
              $ref: "#/definitions/AIProviderConfig",
              description: "AI provider configuration (optional)"
            },
            ai_model: {
              type: "string",
              description: "AI model to use for this check - overrides global setting"
            },
            ai_provider: {
              type: "string",
              description: "AI provider to use for this check - overrides global setting"
            },
            ai_persona: {
              type: "string",
              description: "Optional persona hint, prepended to the prompt as 'Persona: <value>'"
            },
            ai_prompt_type: {
              type: "string",
              description: "Probe promptType for this check (underscore style)"
            },
            ai_system_prompt: {
              type: "string",
              description: "System prompt for this check (underscore style)"
            },
            ai_custom_prompt: {
              type: "string",
              description: "Legacy customPrompt (underscore style) \u2014 deprecated, use ai_system_prompt"
            },
            ai_mcp_servers: {
              $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E",
              description: "MCP servers for this AI check - overrides global setting"
            },
            ai_custom_tools: {
              type: "array",
              items: {
                type: "string"
              },
              description: "List of custom tool names to expose to this AI check via ephemeral SSE MCP server"
            },
            claude_code: {
              $ref: "#/definitions/ClaudeCodeConfig",
              description: "Claude Code configuration (for claude-code type checks)"
            },
            env: {
              $ref: "#/definitions/EnvConfig",
              description: "Environment variables for this check"
            },
            timeout: {
              type: "number",
              description: "Timeout in seconds for command execution (default: 60)"
            },
            depends_on: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Check IDs that this check depends on (optional)"
            },
            group: {
              type: "string",
              description: 'Group name for comment separation (e.g., "code-review", "pr-overview") - optional'
            },
            schema: {
              anyOf: [
                {
                  type: "string"
                },
                {
                  $ref: "#/definitions/Record%3Cstring%2Cunknown%3E"
                }
              ],
              description: 'Schema type for template rendering (e.g., "code-review", "markdown") or inline JSON schema object - optional'
            },
            output_schema: {
              $ref: "#/definitions/Record%3Cstring%2Cunknown%3E",
              description: "Optional JSON Schema to validate the produced output. If omitted and `schema` is an object, the engine will treat that object as the output_schema for validation purposes while still using string schemas (e.g., 'code-review') for template selection."
            },
            template: {
              $ref: "#/definitions/CustomTemplateConfig",
              description: "Custom template configuration - optional"
            },
            if: {
              type: "string",
              description: "Condition to determine if check should run - runs if expression evaluates to true"
            },
            reuse_ai_session: {
              type: ["string", "boolean"],
              description: "Check name to reuse AI session from, or true to use first dependency (only works with depends_on)"
            },
            session_mode: {
              type: "string",
              enum: ["clone", "append"],
              description: "How to reuse AI session: 'clone' (default, copy history) or 'append' (share history)"
            },
            fail_if: {
              type: "string",
              description: "Simple fail condition - fails check if expression evaluates to true"
            },
            failure_conditions: {
              $ref: "#/definitions/FailureConditions",
              description: "Check-specific failure conditions - optional (deprecated, use fail_if)"
            },
            tags: {
              type: "array",
              items: {
                type: "string"
              },
              description: 'Tags for categorizing and filtering checks (e.g., ["local", "fast", "security"])'
            },
            criticality: {
              type: "string",
              enum: ["external", "internal", "policy", "info"],
              description: "Operational criticality of this step. Drives default safety policies (contracts, retries, loop budgets) at load time. Behavior can still be overridden explicitly per step via on_*, fail_if, assume/guarantee, etc.\n\n- 'external': interacts with external systems (side effects). Highest safety.\n- 'internal': modifies CI/config/state but not prod. High safety.\n- 'policy': organizational checks (linting, style, doc). Moderate safety.\n- 'info': informational checks. Lowest safety."
            },
            continue_on_failure: {
              type: "boolean",
              description: "Allow dependents to run even if this step fails. Defaults to false (dependents are gated when this step fails). Similar to GitHub Actions' continue-on-error."
            },
            forEach: {
              type: "boolean",
              description: "Process output as array and run dependent checks for each item"
            },
            fanout: {
              type: "string",
              enum: ["map", "reduce"],
              description: "Control scheduling behavior when this check is triggered via routing (run/goto) from a forEach scope.\n- 'map': schedule once per item (fan-out) using item scopes.\n- 'reduce': schedule a single run at the parent scope (aggregation). If unset, the current default is a single run (reduce) for backward compatibility."
            },
            reduce: {
              type: "boolean",
              description: "Alias for fanout: 'reduce'"
            },
            on_fail: {
              $ref: "#/definitions/OnFailConfig",
              description: "Failure routing configuration for this check (retry/goto/run)"
            },
            on_success: {
              $ref: "#/definitions/OnSuccessConfig",
              description: "Success routing configuration for this check (post-actions and optional goto)"
            },
            on_finish: {
              $ref: "#/definitions/OnFinishConfig",
              description: "Finish routing configuration for forEach checks (runs after ALL iterations complete)"
            },
            assume: {
              anyOf: [
                {
                  type: "string"
                },
                {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              ],
              description: "Preconditions that must hold before executing the check. If any expression evaluates to false, the check is skipped (skipReason='assume')."
            },
            guarantee: {
              anyOf: [
                {
                  type: "string"
                },
                {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              ],
              description: 'Postconditions that should hold after executing the check. Expressions are evaluated against the produced result/output; violations are recorded as error issues with ruleId "contract/guarantee_failed".'
            },
            max_runs: {
              type: "number",
              description: "Hard cap on how many times this check may execute within a single engine run. Overrides global limits.max_runs_per_check. Set to 0 or negative to disable for this step."
            },
            message: {
              type: "string",
              description: "Message template for log checks"
            },
            level: {
              type: "string",
              enum: ["debug", "info", "warn", "error"],
              description: "Log level for log checks"
            },
            include_pr_context: {
              type: "boolean",
              description: "Include PR context in log output"
            },
            include_dependencies: {
              type: "boolean",
              description: "Include dependency summaries in log output"
            },
            include_metadata: {
              type: "boolean",
              description: "Include execution metadata in log output"
            },
            output_format: {
              type: "string",
              enum: ["json", "text"],
              description: "Output parsing hint for command provider (optional) When set to 'json', command stdout is expected to be JSON. When 'text', treat as plain text. Note: command provider attempts JSON parsing heuristically; this flag mainly suppresses schema warnings and may be used by providers to alter parsing behavior in the future."
            },
            operation: {
              type: "string",
              enum: ["get", "set", "append", "increment", "delete", "clear", "list"],
              description: "Memory operation to perform. Use `type: 'script'` for custom JavaScript."
            },
            key: {
              type: "string",
              description: "Key for memory operation"
            },
            value: {
              description: "Value for set/append operations"
            },
            value_js: {
              type: "string",
              description: "JavaScript expression to compute value dynamically"
            },
            namespace: {
              type: "string",
              description: "Override namespace for this check"
            },
            op: {
              type: "string",
              description: "GitHub operation to perform (e.g., 'labels.add', 'labels.remove', 'comment.create')"
            },
            values: {
              anyOf: [
                {
                  type: "array",
                  items: {
                    type: "string"
                  }
                },
                {
                  type: "string"
                }
              ],
              description: "Values for GitHub operations (can be array or single value)"
            },
            transport: {
              type: "string",
              enum: ["stdio", "sse", "http"],
              description: "Transport type for MCP: stdio (default), sse (legacy), or http (streamable HTTP)"
            },
            methodArgs: {
              $ref: "#/definitions/Record%3Cstring%2Cunknown%3E",
              description: "Arguments to pass to the MCP method (supports Liquid templates)"
            },
            argsTransform: {
              type: "string",
              description: "Transform template for method arguments (Liquid)"
            },
            sessionId: {
              type: "string",
              description: "Session ID for HTTP transport (optional, server may generate one)"
            },
            command_args: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Command arguments (for stdio transport in MCP checks)"
            },
            workingDirectory: {
              type: "string",
              description: "Working directory (for stdio transport in MCP checks)"
            },
            placeholder: {
              type: "string",
              description: "Placeholder text to show in input field"
            },
            allow_empty: {
              type: "boolean",
              description: "Allow empty input (default: false)"
            },
            multiline: {
              type: "boolean",
              description: "Support multiline input (default: false)"
            },
            default: {
              type: "string",
              description: "Default value if timeout occurs or empty input when allow_empty is true"
            },
            workflow: {
              type: "string",
              description: "Workflow ID or path to workflow file"
            },
            args: {
              $ref: "#/definitions/Record%3Cstring%2Cunknown%3E",
              description: "Arguments/inputs for the workflow"
            },
            overrides: {
              $ref: "#/definitions/Record%3Cstring%2CPartial%3Cinterface-src_types_config.ts-11138-21346-src_types_config.ts-0-34851%3E%3E",
              description: "Override specific step configurations in the workflow"
            },
            output_mapping: {
              $ref: "#/definitions/Record%3Cstring%2Cstring%3E",
              description: "Map workflow outputs to check outputs"
            }
          },
          additionalProperties: false,
          description: "Configuration for a single check",
          patternProperties: {
            "^x-": {}
          }
        },
        ConfigCheckType: {
          type: "string",
          enum: [
            "ai",
            "command",
            "script",
            "http",
            "http_input",
            "http_client",
            "noop",
            "log",
            "memory",
            "github",
            "claude-code",
            "mcp",
            "human-input",
            "workflow",
            "git-checkout"
          ],
          description: "Valid check types in configuration"
        },
        EventTrigger: {
          type: "string",
          enum: [
            "pr_opened",
            "pr_updated",
            "pr_closed",
            "issue_opened",
            "issue_comment",
            "manual",
            "schedule",
            "webhook_received"
          ],
          description: "Valid event triggers for checks"
        },
        AIProviderConfig: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["google", "anthropic", "openai", "bedrock", "mock"],
              description: "AI provider to use"
            },
            model: {
              type: "string",
              description: "Model name to use"
            },
            apiKey: {
              type: "string",
              description: "API key (usually from environment variables)"
            },
            timeout: {
              type: "number",
              description: "Request timeout in milliseconds"
            },
            debug: {
              type: "boolean",
              description: "Enable debug mode"
            },
            prompt_type: {
              type: "string",
              description: "Probe promptType to use (e.g., engineer, code-review, architect)"
            },
            system_prompt: {
              type: "string",
              description: "System prompt (baseline preamble). Replaces legacy custom_prompt."
            },
            custom_prompt: {
              type: "string",
              description: "Probe customPrompt (baseline/system prompt) \u2014 deprecated, use system_prompt"
            },
            skip_code_context: {
              type: "boolean",
              description: "Skip adding code context (diffs, files, PR info) to the prompt"
            },
            skip_slack_context: {
              type: "boolean",
              description: "Skip adding Slack conversation context to the prompt (when running under Slack)"
            },
            skip_transport_context: {
              type: "boolean",
              description: "Skip adding transport-specific context (e.g., GitHub PR/issue XML, Slack conversation XML) to the prompt. When true, this behaves like setting both skip_code_context and skip_slack_context to true, unless those are explicitly overridden."
            },
            mcpServers: {
              $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E",
              description: "MCP servers configuration"
            },
            enableDelegate: {
              type: "boolean",
              description: "Enable the delegate tool for task distribution to subagents"
            },
            retry: {
              $ref: "#/definitions/AIRetryConfig",
              description: "Retry configuration for this provider"
            },
            fallback: {
              $ref: "#/definitions/AIFallbackConfig",
              description: "Fallback configuration for provider failures"
            },
            allowEdit: {
              type: "boolean",
              description: "Enable Edit and Create tools for file modification (disabled by default for security)"
            },
            allowedTools: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Filter allowed tools - supports whitelist, exclusion (!prefix), or raw AI mode (empty array)"
            },
            disableTools: {
              type: "boolean",
              description: "Disable all tools for raw AI mode (alternative to allowedTools: [])"
            },
            allowBash: {
              type: "boolean",
              description: "Enable bash command execution (shorthand for bashConfig.enabled)"
            },
            bashConfig: {
              $ref: "#/definitions/BashConfig",
              description: "Advanced bash command execution configuration"
            }
          },
          additionalProperties: false,
          description: "AI provider configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        "Record<string,McpServerConfig>": {
          type: "object",
          additionalProperties: {
            $ref: "#/definitions/McpServerConfig"
          }
        },
        McpServerConfig: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Command to execute for the MCP server"
            },
            args: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Arguments to pass to the command"
            },
            env: {
              $ref: "#/definitions/Record%3Cstring%2Cstring%3E",
              description: "Environment variables for the MCP server"
            }
          },
          required: ["command"],
          additionalProperties: false,
          description: "MCP Server configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        AIRetryConfig: {
          type: "object",
          properties: {
            maxRetries: {
              type: "number",
              description: "Maximum retry attempts (0-50)"
            },
            initialDelay: {
              type: "number",
              description: "Initial delay in milliseconds (0-60000)"
            },
            maxDelay: {
              type: "number",
              description: "Maximum delay cap in milliseconds (0-300000)"
            },
            backoffFactor: {
              type: "number",
              description: "Exponential backoff multiplier (1-10)"
            },
            retryableErrors: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Custom error patterns to retry on"
            }
          },
          additionalProperties: false,
          description: "Retry configuration for AI provider calls",
          patternProperties: {
            "^x-": {}
          }
        },
        AIFallbackConfig: {
          type: "object",
          properties: {
            strategy: {
              type: "string",
              enum: ["same-model", "same-provider", "any", "custom"],
              description: "Fallback strategy: 'same-model', 'same-provider', 'any', or 'custom'"
            },
            providers: {
              type: "array",
              items: {
                $ref: "#/definitions/AIFallbackProviderConfig"
              },
              description: "Array of fallback provider configurations"
            },
            maxTotalAttempts: {
              type: "number",
              description: "Maximum total attempts across all providers"
            },
            auto: {
              type: "boolean",
              description: "Enable automatic fallback using available environment variables"
            }
          },
          additionalProperties: false,
          description: "Fallback configuration for AI providers",
          patternProperties: {
            "^x-": {}
          }
        },
        AIFallbackProviderConfig: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["google", "anthropic", "openai", "bedrock"],
              description: "AI provider to use"
            },
            model: {
              type: "string",
              description: "Model name to use"
            },
            apiKey: {
              type: "string",
              description: "API key for this provider"
            },
            maxRetries: {
              type: "number",
              description: "Per-provider retry override"
            },
            region: {
              type: "string",
              description: "AWS region (for Bedrock)"
            },
            accessKeyId: {
              type: "string",
              description: "AWS access key ID (for Bedrock)"
            },
            secretAccessKey: {
              type: "string",
              description: "AWS secret access key (for Bedrock)"
            }
          },
          required: ["provider", "model"],
          additionalProperties: false,
          description: "Fallback provider configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        BashConfig: {
          type: "object",
          properties: {
            allow: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of permitted command patterns (e.g., ['ls', 'git status'])"
            },
            deny: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of blocked command patterns (e.g., ['rm -rf', 'sudo'])"
            },
            noDefaultAllow: {
              type: "boolean",
              description: "Disable default safe command list (use with caution)"
            },
            noDefaultDeny: {
              type: "boolean",
              description: "Disable default dangerous command blocklist (use with extreme caution)"
            },
            timeout: {
              type: "number",
              description: "Execution timeout in milliseconds"
            },
            workingDirectory: {
              type: "string",
              description: "Default working directory for command execution"
            }
          },
          additionalProperties: false,
          description: "Bash command execution configuration for ProbeAgent Note: Use 'allowBash: true' in AIProviderConfig to enable bash execution",
          patternProperties: {
            "^x-": {}
          }
        },
        ClaudeCodeConfig: {
          type: "object",
          properties: {
            allowedTools: {
              type: "array",
              items: {
                type: "string"
              },
              description: "List of allowed tools for Claude Code to use"
            },
            maxTurns: {
              type: "number",
              description: "Maximum number of turns in conversation"
            },
            systemPrompt: {
              type: "string",
              description: "System prompt for Claude Code"
            },
            mcpServers: {
              $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E",
              description: "MCP servers configuration"
            },
            subagent: {
              type: "string",
              description: "Path to subagent script"
            },
            enableDelegate: {
              type: "boolean",
              description: "Enable the delegate tool for task distribution to subagents"
            },
            hooks: {
              type: "object",
              properties: {
                onStart: {
                  type: "string",
                  description: "Called when check starts"
                },
                onEnd: {
                  type: "string",
                  description: "Called when check ends"
                },
                onError: {
                  type: "string",
                  description: "Called when check encounters an error"
                }
              },
              additionalProperties: false,
              description: "Event hooks for lifecycle management",
              patternProperties: {
                "^x-": {}
              }
            }
          },
          additionalProperties: false,
          description: "Claude Code configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        EnvConfig: {
          type: "object",
          additionalProperties: {
            type: ["string", "number", "boolean"]
          },
          description: "Environment variable reference configuration"
        },
        CustomTemplateConfig: {
          type: "object",
          properties: {
            file: {
              type: "string",
              description: "Path to custom template file (relative to config file or absolute)"
            },
            content: {
              type: "string",
              description: "Raw template content as string"
            }
          },
          additionalProperties: false,
          description: "Custom template configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        FailureConditions: {
          type: "object",
          additionalProperties: {
            $ref: "#/definitions/FailureCondition"
          },
          description: "Collection of failure conditions"
        },
        FailureCondition: {
          anyOf: [
            {
              $ref: "#/definitions/SimpleFailureCondition"
            },
            {
              $ref: "#/definitions/ComplexFailureCondition"
            }
          ],
          description: "Failure condition - can be a simple expression string or complex object"
        },
        SimpleFailureCondition: {
          type: "string",
          description: "Simple failure condition - just an expression string"
        },
        ComplexFailureCondition: {
          type: "object",
          properties: {
            condition: {
              type: "string",
              description: "Expression to evaluate using Function Constructor"
            },
            message: {
              type: "string",
              description: "Human-readable message when condition is met"
            },
            severity: {
              $ref: "#/definitions/FailureConditionSeverity",
              description: "Severity level of the failure"
            },
            halt_execution: {
              type: "boolean",
              description: "Whether this condition should halt execution"
            }
          },
          required: ["condition"],
          additionalProperties: false,
          description: "Complex failure condition with additional metadata",
          patternProperties: {
            "^x-": {}
          }
        },
        FailureConditionSeverity: {
          type: "string",
          enum: ["error", "warning", "info"],
          description: "Failure condition severity levels"
        },
        OnFailConfig: {
          type: "object",
          properties: {
            retry: {
              $ref: "#/definitions/RetryPolicy",
              description: "Retry policy"
            },
            run: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Remediation steps to run before reattempt"
            },
            goto: {
              type: "string",
              description: "Jump back to an ancestor step (by id)"
            },
            goto_event: {
              $ref: "#/definitions/EventTrigger",
              description: "Simulate a different event when performing goto (e.g., 'pr_updated')"
            },
            goto_js: {
              type: "string",
              description: "Dynamic goto: JS expression returning step id or null"
            },
            run_js: {
              type: "string",
              description: "Dynamic remediation list: JS expression returning string[]"
            },
            transitions: {
              type: "array",
              items: {
                $ref: "#/definitions/TransitionRule"
              },
              description: "Declarative transitions. Evaluated in order; first matching rule wins. If a rule's `to` is null, no goto occurs. When omitted or none match, the engine falls back to goto_js/goto for backward compatibility."
            }
          },
          additionalProperties: false,
          description: "Failure routing configuration per check",
          patternProperties: {
            "^x-": {}
          }
        },
        RetryPolicy: {
          type: "object",
          properties: {
            max: {
              type: "number",
              description: "Maximum retry attempts (excluding the first attempt)"
            },
            backoff: {
              $ref: "#/definitions/BackoffPolicy",
              description: "Backoff policy"
            }
          },
          additionalProperties: false,
          description: "Retry policy for a step",
          patternProperties: {
            "^x-": {}
          }
        },
        BackoffPolicy: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["fixed", "exponential"],
              description: "Backoff mode"
            },
            delay_ms: {
              type: "number",
              description: "Initial delay in milliseconds"
            }
          },
          additionalProperties: false,
          description: "Backoff policy for retries",
          patternProperties: {
            "^x-": {}
          }
        },
        TransitionRule: {
          type: "object",
          properties: {
            when: {
              type: "string",
              description: "JavaScript expression evaluated in the same sandbox as goto_js; truthy enables the rule."
            },
            to: {
              type: ["string", "null"],
              description: "Target step ID, or null to explicitly prevent goto."
            },
            goto_event: {
              $ref: "#/definitions/EventTrigger",
              description: "Optional event override when performing goto."
            }
          },
          required: ["when"],
          additionalProperties: false,
          description: "Declarative transition rule for on_* blocks.",
          patternProperties: {
            "^x-": {}
          }
        },
        OnSuccessConfig: {
          type: "object",
          properties: {
            run: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Post-success steps to run"
            },
            goto: {
              type: "string",
              description: "Optional jump back to ancestor step (by id)"
            },
            goto_event: {
              $ref: "#/definitions/EventTrigger",
              description: "Simulate a different event when performing goto (e.g., 'pr_updated')"
            },
            goto_js: {
              type: "string",
              description: "Dynamic goto: JS expression returning step id or null"
            },
            run_js: {
              type: "string",
              description: "Dynamic post-success steps: JS expression returning string[]"
            },
            transitions: {
              type: "array",
              items: {
                $ref: "#/definitions/TransitionRule"
              },
              description: "Declarative transitions (see OnFailConfig.transitions)."
            }
          },
          additionalProperties: false,
          description: "Success routing configuration per check",
          patternProperties: {
            "^x-": {}
          }
        },
        OnFinishConfig: {
          type: "object",
          properties: {
            run: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Post-finish steps to run"
            },
            goto: {
              type: "string",
              description: "Optional jump back to ancestor step (by id)"
            },
            goto_event: {
              $ref: "#/definitions/EventTrigger",
              description: "Simulate a different event when performing goto (e.g., 'pr_updated')"
            },
            goto_js: {
              type: "string",
              description: "Dynamic goto: JS expression returning step id or null"
            },
            run_js: {
              type: "string",
              description: "Dynamic post-finish steps: JS expression returning string[]"
            },
            transitions: {
              type: "array",
              items: {
                $ref: "#/definitions/TransitionRule"
              },
              description: "Declarative transitions (see OnFailConfig.transitions)."
            }
          },
          additionalProperties: false,
          description: "Finish routing configuration for forEach checks Runs once after ALL iterations of forEach and ALL dependent checks complete",
          patternProperties: {
            "^x-": {}
          }
        },
        "Record<string,Partial<interface-src_types_config.ts-11138-21346-src_types_config.ts-0-34851>>": {
          type: "object",
          additionalProperties: {
            $ref: "#/definitions/Partial%3Cinterface-src_types_config.ts-11138-21346-src_types_config.ts-0-34851%3E"
          }
        },
        "Partial<interface-src_types_config.ts-11138-21346-src_types_config.ts-0-34851>": {
          type: "object",
          additionalProperties: false
        },
        OutputConfig: {
          type: "object",
          properties: {
            pr_comment: {
              $ref: "#/definitions/PrCommentOutput",
              description: "PR comment configuration"
            },
            file_comment: {
              $ref: "#/definitions/FileCommentOutput",
              description: "File comment configuration (optional)"
            },
            github_checks: {
              $ref: "#/definitions/GitHubCheckOutput",
              description: "GitHub check runs configuration (optional)"
            },
            suppressionEnabled: {
              type: "boolean",
              description: "Whether to enable issue suppression via visor-disable comments (default: true)"
            }
          },
          required: ["pr_comment"],
          additionalProperties: false,
          description: "Output configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        PrCommentOutput: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Whether PR comments are enabled"
            },
            format: {
              $ref: "#/definitions/ConfigOutputFormat",
              description: "Format of the output"
            },
            group_by: {
              $ref: "#/definitions/GroupByOption",
              description: "How to group the results"
            },
            collapse: {
              type: "boolean",
              description: "Whether to collapse sections by default"
            },
            debug: {
              $ref: "#/definitions/DebugConfig",
              description: "Debug mode configuration (optional)"
            }
          },
          required: ["format", "group_by", "collapse"],
          additionalProperties: false,
          description: "PR comment output configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        ConfigOutputFormat: {
          type: "string",
          enum: ["table", "json", "markdown", "sarif"],
          description: "Valid output formats"
        },
        GroupByOption: {
          type: "string",
          enum: ["check", "file", "severity", "group"],
          description: "Valid grouping options"
        },
        DebugConfig: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable debug mode"
            },
            includePrompts: {
              type: "boolean",
              description: "Include AI prompts in debug output"
            },
            includeRawResponses: {
              type: "boolean",
              description: "Include raw AI responses in debug output"
            },
            includeTiming: {
              type: "boolean",
              description: "Include timing information"
            },
            includeProviderInfo: {
              type: "boolean",
              description: "Include provider information"
            }
          },
          required: [
            "enabled",
            "includePrompts",
            "includeRawResponses",
            "includeTiming",
            "includeProviderInfo"
          ],
          additionalProperties: false,
          description: "Debug mode configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        FileCommentOutput: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Whether file comments are enabled"
            },
            inline: {
              type: "boolean",
              description: "Whether to show inline comments"
            }
          },
          required: ["enabled", "inline"],
          additionalProperties: false,
          description: "File comment output configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        GitHubCheckOutput: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Whether GitHub check runs are enabled"
            },
            per_check: {
              type: "boolean",
              description: "Whether to create individual check runs per configured check"
            },
            name_prefix: {
              type: "string",
              description: "Custom name prefix for check runs"
            }
          },
          required: ["enabled", "per_check"],
          additionalProperties: false,
          description: "GitHub Check Runs output configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        HttpServerConfig: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Whether HTTP server is enabled"
            },
            port: {
              type: "number",
              description: "Port to listen on"
            },
            host: {
              type: "string",
              description: "Host/IP to bind to (defaults to 0.0.0.0)"
            },
            tls: {
              $ref: "#/definitions/TlsConfig",
              description: "TLS/SSL configuration for HTTPS"
            },
            auth: {
              $ref: "#/definitions/HttpAuthConfig",
              description: "Authentication configuration"
            },
            endpoints: {
              type: "array",
              items: {
                $ref: "#/definitions/HttpEndpointConfig"
              },
              description: "HTTP endpoints configuration"
            }
          },
          required: ["enabled", "port"],
          additionalProperties: false,
          description: "HTTP server configuration for receiving webhooks",
          patternProperties: {
            "^x-": {}
          }
        },
        TlsConfig: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable TLS/HTTPS"
            },
            cert: {
              type: "string",
              description: "Path to TLS certificate file or certificate content"
            },
            key: {
              type: "string",
              description: "Path to TLS key file or key content"
            },
            ca: {
              type: "string",
              description: "Path to CA certificate file or CA content (optional)"
            },
            rejectUnauthorized: {
              type: "boolean",
              description: "Reject unauthorized connections (default: true)"
            }
          },
          required: ["enabled"],
          additionalProperties: false,
          description: "TLS/SSL configuration for HTTPS server",
          patternProperties: {
            "^x-": {}
          }
        },
        HttpAuthConfig: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["bearer_token", "hmac", "basic", "none"],
              description: "Authentication type"
            },
            secret: {
              type: "string",
              description: "Secret or token for authentication"
            },
            username: {
              type: "string",
              description: "Username for basic auth"
            },
            password: {
              type: "string",
              description: "Password for basic auth"
            }
          },
          required: ["type"],
          additionalProperties: false,
          description: "HTTP server authentication configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        HttpEndpointConfig: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path for the webhook endpoint"
            },
            transform: {
              type: "string",
              description: "Optional transform template (Liquid) for the received data"
            },
            name: {
              type: "string",
              description: "Optional name/ID for this endpoint"
            }
          },
          required: ["path"],
          additionalProperties: false,
          description: "HTTP server endpoint configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        MemoryConfig: {
          type: "object",
          properties: {
            storage: {
              type: "string",
              enum: ["memory", "file"],
              description: 'Storage mode: "memory" (in-memory, default) or "file" (persistent)'
            },
            format: {
              type: "string",
              enum: ["json", "csv"],
              description: "Storage format (only for file storage, default: json)"
            },
            file: {
              type: "string",
              description: "File path (required if storage: file)"
            },
            namespace: {
              type: "string",
              description: 'Default namespace (default: "default")'
            },
            auto_load: {
              type: "boolean",
              description: "Auto-load on startup (default: true if storage: file)"
            },
            auto_save: {
              type: "boolean",
              description: "Auto-save after operations (default: true if storage: file)"
            }
          },
          additionalProperties: false,
          description: "Memory storage configuration",
          patternProperties: {
            "^x-": {}
          }
        },
        TagFilter: {
          type: "object",
          properties: {
            include: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Tags that checks must have to be included (ANY match)"
            },
            exclude: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Tags that will exclude checks if present (ANY match)"
            }
          },
          additionalProperties: false,
          description: "Tag filter configuration for selective check execution",
          patternProperties: {
            "^x-": {}
          }
        },
        RoutingDefaults: {
          type: "object",
          properties: {
            max_loops: {
              type: "number",
              description: "Per-scope cap on routing transitions (success + failure)"
            },
            defaults: {
              type: "object",
              properties: {
                on_fail: {
                  $ref: "#/definitions/OnFailConfig"
                }
              },
              additionalProperties: false,
              description: "Default policies applied to checks (step-level overrides take precedence)",
              patternProperties: {
                "^x-": {}
              }
            }
          },
          additionalProperties: false,
          description: "Global routing defaults",
          patternProperties: {
            "^x-": {}
          }
        },
        LimitsConfig: {
          type: "object",
          properties: {
            max_runs_per_check: {
              type: "number",
              description: "Maximum number of executions per check within a single engine run. Applies to each distinct scope independently for forEach item executions. Set to 0 or negative to disable. Default: 50."
            },
            max_workflow_depth: {
              type: "number",
              description: "Maximum nesting depth for workflows executed by the state machine engine. Nested workflows are invoked by the workflow provider; this limit prevents accidental infinite recursion. Default: 3."
            }
          },
          additionalProperties: false,
          description: "Global engine limits",
          patternProperties: {
            "^x-": {}
          }
        }
      }
    };
    config_schema_default = configSchema;
  }
});

// src/config.ts
var config_exports = {};
__export(config_exports, {
  ConfigManager: () => ConfigManager,
  VALID_EVENT_TRIGGERS: () => VALID_EVENT_TRIGGERS
});
import * as yaml2 from "js-yaml";
import * as fs2 from "fs";
import * as path2 from "path";
import simpleGit from "simple-git";
import Ajv from "ajv";
import addFormats from "ajv-formats";
var VALID_EVENT_TRIGGERS, ConfigManager, __ajvValidate, __ajvErrors;
var init_config = __esm({
  "src/config.ts"() {
    init_logger();
    init_config_loader();
    init_config_merger();
    VALID_EVENT_TRIGGERS = [
      "pr_opened",
      "pr_updated",
      "pr_closed",
      "issue_opened",
      "issue_comment",
      "manual",
      "schedule",
      "webhook_received"
    ];
    ConfigManager = class {
      validCheckTypes = [
        "ai",
        "claude-code",
        "mcp",
        "command",
        "script",
        "http",
        "http_input",
        "http_client",
        "memory",
        "noop",
        "log",
        "github",
        "human-input",
        "workflow",
        "git-checkout"
      ];
      validEventTriggers = [...VALID_EVENT_TRIGGERS];
      validOutputFormats = ["table", "json", "markdown", "sarif"];
      validGroupByOptions = ["check", "file", "severity", "group"];
      /**
       * Load configuration from a file
       */
      async loadConfig(configPath, options = {}) {
        const { validate = true, mergeDefaults = true, allowedRemotePatterns } = options;
        const resolvedPath = path2.isAbsolute(configPath) ? configPath : path2.resolve(process.cwd(), configPath);
        try {
          let configContent;
          try {
            configContent = fs2.readFileSync(resolvedPath, "utf8");
          } catch (readErr) {
            if (readErr && (readErr.code === "ENOENT" || readErr.code === "ENOTDIR")) {
              throw new Error(`Configuration file not found: ${resolvedPath}`);
            }
            throw new Error(
              `Failed to read configuration file ${resolvedPath}: ${readErr?.message || String(readErr)}`
            );
          }
          let parsedConfig;
          try {
            parsedConfig = yaml2.load(configContent);
          } catch (yamlError) {
            const errorMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
            throw new Error(`Invalid YAML syntax in ${resolvedPath}: ${errorMessage}`);
          }
          if (!parsedConfig || typeof parsedConfig !== "object") {
            throw new Error("Configuration file must contain a valid YAML object");
          }
          const extendsValue = parsedConfig.extends || parsedConfig.include;
          if (extendsValue) {
            const loaderOptions = {
              baseDir: path2.dirname(resolvedPath),
              allowRemote: this.isRemoteExtendsAllowed(),
              maxDepth: 10,
              allowedRemotePatterns
            };
            const loader = new ConfigLoader(loaderOptions);
            const merger = new ConfigMerger();
            const extends_ = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
            const { extends: _, include: __, ...configWithoutExtends } = parsedConfig;
            let mergedConfig = {};
            for (const source of extends_) {
              console.log(`\u{1F4E6} Extending from: ${source}`);
              const parentConfig = await loader.fetchConfig(source);
              mergedConfig = merger.merge(mergedConfig, parentConfig);
            }
            parsedConfig = merger.merge(mergedConfig, configWithoutExtends);
            parsedConfig = merger.removeDisabledChecks(parsedConfig);
          }
          if (parsedConfig.id && typeof parsedConfig.id === "string") {
            parsedConfig = await this.convertWorkflowToConfig(parsedConfig, path2.dirname(resolvedPath));
          }
          parsedConfig = this.normalizeStepsAndChecks(parsedConfig, !!extendsValue);
          await this.loadWorkflows(parsedConfig, path2.dirname(resolvedPath));
          if (validate) {
            this.validateConfig(parsedConfig);
          }
          let finalConfig = parsedConfig;
          if (mergeDefaults) {
            finalConfig = this.mergeWithDefaults(parsedConfig);
          }
          return finalConfig;
        } catch (error) {
          if (error instanceof Error) {
            if (error.message.includes("not found") || error.message.includes("Invalid YAML") || error.message.includes("extends") || error.message.includes("EACCES") || error.message.includes("EISDIR")) {
              throw error;
            }
            if (error.message.includes("ENOENT")) {
              throw new Error(`Configuration file not found: ${resolvedPath}`);
            }
            if (error.message.includes("EPERM")) {
              throw new Error(`Permission denied reading configuration file: ${resolvedPath}`);
            }
            throw new Error(`Failed to read configuration file ${resolvedPath}: ${error.message}`);
          }
          throw error;
        }
      }
      /**
       * Load configuration from an in-memory object (used by the test runner to
       * handle co-located config + tests without writing temp files).
       */
      async loadConfigFromObject(obj, options = {}) {
        const { validate = true, mergeDefaults = true, allowedRemotePatterns, baseDir } = options;
        try {
          let parsedConfig = JSON.parse(JSON.stringify(obj || {}));
          if (!parsedConfig || typeof parsedConfig !== "object") {
            throw new Error("Configuration must be a YAML/JSON object");
          }
          const extendsValue = parsedConfig.extends || parsedConfig.include;
          if (extendsValue) {
            const loaderOptions = {
              baseDir: baseDir || process.cwd(),
              allowRemote: this.isRemoteExtendsAllowed(),
              maxDepth: 10,
              allowedRemotePatterns
            };
            const loader = new ConfigLoader(loaderOptions);
            const extends_ = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
            const { extends: _, include: __, ...configWithoutExtends } = parsedConfig;
            let mergedConfig = {};
            for (const source of extends_) {
              console.log(`\u{1F4E6} Extending from: ${source}`);
              const parentConfig = await loader.fetchConfig(String(source));
              mergedConfig = new ConfigMerger().merge(mergedConfig, parentConfig);
            }
            parsedConfig = new ConfigMerger().merge(mergedConfig, configWithoutExtends);
            parsedConfig = new ConfigMerger().removeDisabledChecks(parsedConfig);
          }
          if (parsedConfig.id && typeof parsedConfig.id === "string") {
            parsedConfig = await this.convertWorkflowToConfig(parsedConfig, baseDir || process.cwd());
          }
          parsedConfig = this.normalizeStepsAndChecks(parsedConfig, !!extendsValue);
          await this.loadWorkflows(parsedConfig, baseDir || process.cwd());
          if (validate) this.validateConfig(parsedConfig);
          let finalConfig = parsedConfig;
          if (mergeDefaults) finalConfig = this.mergeWithDefaults(parsedConfig);
          return finalConfig;
        } catch (error) {
          if (error instanceof Error) throw new Error(`Failed to load configuration: ${error.message}`);
          throw error;
        }
      }
      /**
       * Find and load configuration from default locations
       */
      async findAndLoadConfig(options = {}) {
        const gitRoot = await this.findGitRepositoryRoot();
        const searchDirs = [gitRoot, process.cwd()].filter(Boolean);
        for (const baseDir of searchDirs) {
          const candidates = ["visor.yaml", "visor.yml", ".visor.yaml", ".visor.yml"].map(
            (p) => path2.join(baseDir, p)
          );
          for (const p of candidates) {
            try {
              const st = fs2.statSync(p);
              if (!st.isFile()) continue;
              const isLegacy = path2.basename(p).startsWith(".");
              if (isLegacy) {
                if (process.env.VISOR_STRICT_CONFIG_NAME === "true") {
                  const rel = path2.relative(baseDir, p);
                  throw new Error(
                    `Legacy config detected: ${rel}. Please rename to visor.yaml (or visor.yml).`
                  );
                }
                return this.loadConfig(p, options);
              }
              return this.loadConfig(p, options);
            } catch (e) {
              if (e && e.code === "ENOENT") continue;
              if (e) throw e;
            }
          }
        }
        const bundledConfig = this.loadBundledDefaultConfig();
        if (bundledConfig) {
          return bundledConfig;
        }
        return this.getDefaultConfig();
      }
      /**
       * Find the git repository root directory
       */
      async findGitRepositoryRoot() {
        try {
          const git = simpleGit();
          const isRepo = await git.checkIsRepo();
          if (!isRepo) {
            return null;
          }
          const rootDir = await git.revparse(["--show-toplevel"]);
          return rootDir.trim();
        } catch {
          return null;
        }
      }
      /**
       * Get default configuration
       */
      async getDefaultConfig() {
        return {
          version: "1.0",
          steps: {},
          checks: {},
          // Keep for backward compatibility
          max_parallelism: 3,
          output: {
            pr_comment: {
              format: "markdown",
              group_by: "check",
              collapse: true
            }
          }
        };
      }
      /**
       * Load bundled default configuration from the package
       */
      loadBundledDefaultConfig() {
        try {
          const possiblePaths = [];
          if (typeof __dirname !== "undefined") {
            possiblePaths.push(
              path2.join(__dirname, "defaults", "visor.yaml"),
              path2.join(__dirname, "..", "defaults", "visor.yaml")
            );
          }
          const pkgRoot = this.findPackageRoot();
          if (pkgRoot) {
            possiblePaths.push(path2.join(pkgRoot, "defaults", "visor.yaml"));
          }
          if (process.env.GITHUB_ACTION_PATH) {
            possiblePaths.push(
              path2.join(process.env.GITHUB_ACTION_PATH, "defaults", "visor.yaml"),
              path2.join(process.env.GITHUB_ACTION_PATH, "dist", "defaults", "visor.yaml")
            );
          }
          let bundledConfigPath;
          for (const possiblePath of possiblePaths) {
            if (fs2.existsSync(possiblePath)) {
              bundledConfigPath = possiblePath;
              break;
            }
          }
          if (bundledConfigPath) {
            console.error(`\u{1F4E6} Loading bundled default configuration from ${bundledConfigPath}`);
            const readAndParse = (p) => {
              const raw = fs2.readFileSync(p, "utf8");
              const obj = yaml2.load(raw);
              if (!obj || typeof obj !== "object") return {};
              if (obj.include && !obj.extends) {
                const inc = obj.include;
                obj.extends = Array.isArray(inc) ? inc : [inc];
                delete obj.include;
              }
              return obj;
            };
            const baseDir = path2.dirname(bundledConfigPath);
            const merger = new (init_config_merger(), __toCommonJS(config_merger_exports)).ConfigMerger();
            const loadWithExtendsSync = (p) => {
              const current = readAndParse(p);
              const extVal = current.extends || current.include;
              if (current.extends !== void 0) delete current.extends;
              if (current.include !== void 0) delete current.include;
              if (!extVal) return current;
              const list = Array.isArray(extVal) ? extVal : [extVal];
              let acc = {};
              for (const src of list) {
                const rel = typeof src === "string" ? src : String(src);
                const abs = path2.isAbsolute(rel) ? rel : path2.resolve(baseDir, rel);
                const parentCfg = loadWithExtendsSync(abs);
                acc = merger.merge(acc, parentCfg);
              }
              return merger.merge(acc, current);
            };
            let parsedConfig = loadWithExtendsSync(bundledConfigPath);
            parsedConfig = this.normalizeStepsAndChecks(parsedConfig);
            this.validateConfig(parsedConfig);
            return this.mergeWithDefaults(parsedConfig);
          }
        } catch (error) {
          console.warn(
            "Failed to load bundled default config:",
            error instanceof Error ? error.message : String(error)
          );
        }
        return null;
      }
      /**
       * Find the root directory of the Visor package
       */
      findPackageRoot() {
        let currentDir = __dirname;
        while (currentDir !== path2.dirname(currentDir)) {
          const packageJsonPath = path2.join(currentDir, "package.json");
          if (fs2.existsSync(packageJsonPath)) {
            try {
              const packageJson = JSON.parse(fs2.readFileSync(packageJsonPath, "utf8"));
              if (packageJson.name === "@probelabs/visor") {
                return currentDir;
              }
            } catch {
            }
          }
          currentDir = path2.dirname(currentDir);
        }
        return null;
      }
      /**
       * Convert a workflow definition file to a visor config
       * When a workflow YAML is run standalone, register the workflow and use its tests as checks
       */
      async convertWorkflowToConfig(workflowData, _basePath) {
        const { WorkflowRegistry } = await import("./workflow-registry-2YIIXQCK.mjs");
        const registry = WorkflowRegistry.getInstance();
        const workflowId = workflowData.id;
        logger.info(`Detected standalone workflow file: ${workflowId}`);
        const tests = workflowData.tests || {};
        const workflowDefinition = { ...workflowData };
        delete workflowDefinition.tests;
        const result = registry.register(workflowDefinition, "standalone", { override: true });
        if (!result.valid && result.errors) {
          const errors = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
          throw new Error(`Failed to register workflow '${workflowId}':
${errors}`);
        }
        logger.info(`Registered workflow '${workflowId}' for standalone execution`);
        const visorConfig = {
          version: "1.0",
          steps: tests,
          checks: tests
          // Backward compatibility
        };
        logger.debug(`Standalone workflow config has ${Object.keys(tests).length} test checks`);
        logger.debug(`Test check names: ${Object.keys(tests).join(", ")}`);
        logger.debug(`Config keys after conversion: ${Object.keys(visorConfig).join(", ")}`);
        return visorConfig;
      }
      /**
       * Load and register workflows from configuration
       */
      async loadWorkflows(config, basePath) {
        if (!config.imports || config.imports.length === 0) {
          return;
        }
        const { WorkflowRegistry } = await import("./workflow-registry-2YIIXQCK.mjs");
        const registry = WorkflowRegistry.getInstance();
        for (const source of config.imports) {
          const results = await registry.import(source, { basePath, validate: true });
          for (const result of results) {
            if (!result.valid && result.errors) {
              const errors = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
              throw new Error(`Failed to import workflow from '${source}':
${errors}`);
            }
          }
          logger.info(`Imported workflows from: ${source}`);
        }
      }
      /**
       * Normalize 'checks' and 'steps' keys for backward compatibility
       * Ensures both keys are present and contain the same data
       */
      normalizeStepsAndChecks(config, preferChecks = false) {
        if (config.steps && config.checks) {
          if (preferChecks) {
            const merged = { ...config.steps, ...config.checks };
            config.steps = merged;
            config.checks = merged;
          } else {
            config.checks = config.steps;
            config.steps = config.steps;
          }
        } else if (config.steps && !config.checks) {
          config.checks = config.steps;
        } else if (config.checks && !config.steps) {
          config.steps = config.checks;
        }
        return config;
      }
      /**
       * Merge configuration with CLI options
       */
      mergeWithCliOptions(config, cliOptions) {
        const mergedConfig = { ...config };
        if (cliOptions.maxParallelism !== void 0) {
          mergedConfig.max_parallelism = cliOptions.maxParallelism;
        }
        if (cliOptions.failFast !== void 0) {
          mergedConfig.fail_fast = cliOptions.failFast;
        }
        return {
          config: mergedConfig,
          cliChecks: cliOptions.checks || [],
          cliOutput: cliOptions.output || "table"
        };
      }
      /**
       * Load configuration with environment variable overrides
       */
      async loadConfigWithEnvOverrides() {
        const environmentOverrides = {};
        if (process.env.VISOR_CONFIG_PATH) {
          environmentOverrides.configPath = process.env.VISOR_CONFIG_PATH;
        }
        if (process.env.VISOR_OUTPUT_FORMAT) {
          environmentOverrides.outputFormat = process.env.VISOR_OUTPUT_FORMAT;
        }
        let config;
        if (environmentOverrides.configPath) {
          try {
            config = await this.loadConfig(environmentOverrides.configPath);
          } catch {
            config = await this.findAndLoadConfig();
          }
        } else {
          config = await this.findAndLoadConfig();
        }
        return { config, environmentOverrides };
      }
      /**
       * Validate configuration against schema
       * @param config The config to validate
       * @param strict If true, treat warnings as errors (default: false)
       */
      validateConfig(config, strict = false) {
        const errors = [];
        const warnings = [];
        this.validateWithAjvSchema(config, errors, warnings);
        if (!config.version) {
          errors.push({
            field: "version",
            message: "Missing required field: version"
          });
        }
        if (!config.checks && !config.steps) {
          errors.push({
            field: "checks/steps",
            message: 'Missing required field: either "checks" or "steps" must be defined. "steps" is recommended for new configurations.'
          });
        }
        const checksToValidate = config.checks || config.steps;
        if (checksToValidate) {
          for (const [checkName, checkConfig] of Object.entries(checksToValidate)) {
            if (!checkConfig.type) {
              checkConfig.type = "ai";
            }
            this.validateCheckConfig(checkName, checkConfig, errors, config, warnings);
            if (checkConfig.ai_mcp_servers) {
              this.validateMcpServersObject(
                checkConfig.ai_mcp_servers,
                `checks.${checkName}.ai_mcp_servers`,
                errors,
                warnings
              );
            }
            if (checkConfig.ai?.mcpServers) {
              this.validateMcpServersObject(
                checkConfig.ai.mcpServers,
                `checks.${checkName}.ai.mcpServers`,
                errors,
                warnings
              );
            }
            if (checkConfig.ai_mcp_servers && checkConfig.ai?.mcpServers) {
              const lower = Object.keys(checkConfig.ai_mcp_servers);
              const higher = Object.keys(checkConfig.ai.mcpServers);
              const overridden = lower.filter((k) => higher.includes(k));
              warnings.push({
                field: `checks.${checkName}.ai.mcpServers`,
                message: overridden.length > 0 ? `Both ai_mcp_servers and ai.mcpServers are set; ai.mcpServers overrides these servers: ${overridden.join(
                  ", "
                )}` : "Both ai_mcp_servers and ai.mcpServers are set; ai.mcpServers takes precedence for this check."
              });
            }
            try {
              const anyCheck = checkConfig;
              const aiObj = anyCheck.ai || void 0;
              const hasBareMcpAtCheck = Object.prototype.hasOwnProperty.call(anyCheck, "mcpServers");
              const hasAiMcp = aiObj && Object.prototype.hasOwnProperty.call(aiObj, "mcpServers");
              const hasClaudeCodeMcp = anyCheck.claude_code && typeof anyCheck.claude_code === "object" && Object.prototype.hasOwnProperty.call(
                anyCheck.claude_code,
                "mcpServers"
              );
              if (checkConfig.type === "ai") {
                if (hasBareMcpAtCheck) {
                  warnings.push({
                    field: `checks.${checkName}.mcpServers`,
                    message: "'mcpServers' at the check root is ignored for type 'ai'. Use 'ai.mcpServers' or 'ai_mcp_servers' instead.",
                    value: anyCheck.mcpServers
                  });
                }
                if (hasClaudeCodeMcp) {
                  warnings.push({
                    field: `checks.${checkName}.claude_code.mcpServers`,
                    message: "'claude_code.mcpServers' is ignored for type 'ai'. Use 'ai.mcpServers' or 'ai_mcp_servers' instead."
                  });
                }
              }
              if (checkConfig.type === "claude-code") {
                if (hasAiMcp || checkConfig.ai_mcp_servers) {
                  warnings.push({
                    field: hasAiMcp ? `checks.${checkName}.ai.mcpServers` : `checks.${checkName}.ai_mcp_servers`,
                    message: "For type 'claude-code', MCP must be configured under 'claude_code.mcpServers'. 'ai.mcpServers' and 'ai_mcp_servers' are ignored for this check."
                  });
                }
              }
            } catch {
            }
          }
        }
        if (config.ai_mcp_servers) {
          this.validateMcpServersObject(config.ai_mcp_servers, "ai_mcp_servers", errors, warnings);
        }
        if (config.output) {
          this.validateOutputConfig(config.output, errors);
        }
        if (config.http_server) {
          this.validateHttpServerConfig(
            config.http_server,
            errors
          );
        }
        if (config.max_parallelism !== void 0) {
          if (typeof config.max_parallelism !== "number" || config.max_parallelism < 1 || !Number.isInteger(config.max_parallelism)) {
            errors.push({
              field: "max_parallelism",
              message: "max_parallelism must be a positive integer (minimum 1)",
              value: config.max_parallelism
            });
          }
        }
        if (config.tag_filter) {
          this.validateTagFilter(config.tag_filter, errors);
        }
        if (strict && warnings.length > 0) {
          errors.push(...warnings);
        }
        if (errors.length > 0) {
          throw new Error(errors[0].message);
        }
        if (!strict && warnings.length > 0) {
          for (const w of warnings) {
            logger.warn(`\u26A0\uFE0F  Config warning [${w.field}]: ${w.message}`);
          }
        }
      }
      /**
       * Validate individual check configuration
       */
      validateCheckConfig(checkName, checkConfig, errors, config, _warnings) {
        if (!checkConfig.type) {
          checkConfig.type = "ai";
        }
        if (checkConfig.type === "logger") {
          checkConfig.type = "log";
        }
        if (!this.validCheckTypes.includes(checkConfig.type)) {
          errors.push({
            field: `checks.${checkName}.type`,
            message: `Invalid check type "${checkConfig.type}". Must be: ${this.validCheckTypes.join(", ")}`,
            value: checkConfig.type
          });
        }
        if (checkConfig.type === "ai" && !checkConfig.prompt) {
          errors.push({
            field: `checks.${checkName}.prompt`,
            message: `Invalid check configuration for "${checkName}": missing prompt (required for AI checks)`
          });
        }
        try {
          const externalTypes = /* @__PURE__ */ new Set(["github", "http", "http_client", "http_input", "workflow"]);
          if (externalTypes.has(checkConfig.type) && !checkConfig.criticality) {
            errors.push({
              field: `checks.${checkName}.criticality`,
              message: `Missing required criticality for step "${checkName}" (type: ${checkConfig.type}). Set criticality: 'external' or 'internal' to enable safe defaults for side-effecting steps.`
            });
          }
        } catch {
        }
        try {
          const crit = checkConfig.criticality || "policy";
          const isCritical = crit === "external" || crit === "internal";
          if (isCritical) {
            const hasAssume = typeof checkConfig.assume === "string" || Array.isArray(checkConfig.assume) && checkConfig.assume.length > 0;
            const hasIf = typeof checkConfig.if === "string" && checkConfig.if.trim().length > 0;
            if (!hasAssume && !hasIf) {
              errors.push({
                field: `checks.${checkName}.assume`,
                message: `Critical step "${checkName}" (criticality: ${crit}) requires a precondition: set 'assume:' (preferred) or 'if:' to guard execution.`
              });
            }
            const outputProviders = /* @__PURE__ */ new Set([
              "ai",
              "script",
              "command",
              "http",
              "http_client",
              "http_input"
            ]);
            if (outputProviders.has(checkConfig.type)) {
              const hasSchema = typeof checkConfig.schema !== "undefined";
              const hasGuarantee = typeof checkConfig.guarantee === "string" && checkConfig.guarantee.trim().length > 0;
              if (!hasSchema && !hasGuarantee) {
                errors.push({
                  field: `checks.${checkName}.schema/guarantee`,
                  message: `Critical step "${checkName}" (type: ${checkConfig.type}) requires an output contract: provide 'schema:' (renderer name or JSON Schema) or 'guarantee:' expression.`
                });
              }
            }
          }
        } catch {
        }
        if (checkConfig.type === "command" && !checkConfig.exec) {
          errors.push({
            field: `checks.${checkName}.exec`,
            message: `Invalid check configuration for "${checkName}": missing exec field (required for command checks)`
          });
        }
        if (checkConfig.type === "http") {
          if (!checkConfig.url) {
            errors.push({
              field: `checks.${checkName}.url`,
              message: `Invalid check configuration for "${checkName}": missing url field (required for http checks)`
            });
          }
          if (!checkConfig.body) {
            errors.push({
              field: `checks.${checkName}.body`,
              message: `Invalid check configuration for "${checkName}": missing body field (required for http checks)`
            });
          }
        }
        if (checkConfig.type === "http_input" && !checkConfig.endpoint) {
          errors.push({
            field: `checks.${checkName}.endpoint`,
            message: `Invalid check configuration for "${checkName}": missing endpoint field (required for http_input checks)`
          });
        }
        try {
          const hasObjSchema = checkConfig?.schema && typeof checkConfig.schema === "object";
          const hasOutputSchema = checkConfig?.output_schema && typeof checkConfig.output_schema === "object";
          if (hasObjSchema && hasOutputSchema) {
            (_warnings || errors).push({
              field: `checks.${checkName}.schema`,
              message: `Both 'schema' (object) and 'output_schema' are set; 'schema' will be used for validation. 'output_schema' is deprecated.`
            });
          }
        } catch {
        }
        if (checkConfig.type === "http_client" && !checkConfig.url) {
          errors.push({
            field: `checks.${checkName}.url`,
            message: `Invalid check configuration for "${checkName}": missing url field (required for http_client checks)`
          });
        }
        if (checkConfig.schedule) {
          const cronParts = checkConfig.schedule.split(" ");
          if (cronParts.length < 5 || cronParts.length > 6) {
            errors.push({
              field: `checks.${checkName}.schedule`,
              message: `Invalid cron expression for "${checkName}": ${checkConfig.schedule}`,
              value: checkConfig.schedule
            });
          }
        }
        if (checkConfig.on) {
          if (!Array.isArray(checkConfig.on)) {
            errors.push({
              field: `checks.${checkName}.on`,
              message: `Invalid check configuration for "${checkName}": 'on' field must be an array`
            });
          } else {
            for (const event of checkConfig.on) {
              if (!this.validEventTriggers.includes(event)) {
                errors.push({
                  field: `checks.${checkName}.on`,
                  message: `Invalid event "${event}". Must be one of: ${this.validEventTriggers.join(", ")}`,
                  value: event
                });
              }
            }
          }
        }
        if (checkConfig.reuse_ai_session !== void 0) {
          const isString = typeof checkConfig.reuse_ai_session === "string";
          const isBoolean = typeof checkConfig.reuse_ai_session === "boolean";
          if (!isString && !isBoolean) {
            errors.push({
              field: `checks.${checkName}.reuse_ai_session`,
              message: `Invalid reuse_ai_session value for "${checkName}": must be string (check name) or boolean`,
              value: checkConfig.reuse_ai_session
            });
          } else if (isString) {
            const targetCheckName = checkConfig.reuse_ai_session;
            if (!config?.checks || !config.checks[targetCheckName]) {
              errors.push({
                field: `checks.${checkName}.reuse_ai_session`,
                message: `Check "${checkName}" references non-existent check "${targetCheckName}" for session reuse`,
                value: checkConfig.reuse_ai_session
              });
            }
          } else if (checkConfig.reuse_ai_session === true) {
            if (!checkConfig.depends_on || !Array.isArray(checkConfig.depends_on) || checkConfig.depends_on.length === 0) {
              errors.push({
                field: `checks.${checkName}.reuse_ai_session`,
                message: `Check "${checkName}" has reuse_ai_session=true but missing or empty depends_on. Session reuse requires dependency on another check.`,
                value: checkConfig.reuse_ai_session
              });
            }
          }
        }
        if (checkConfig.session_mode !== void 0) {
          if (checkConfig.session_mode !== "clone" && checkConfig.session_mode !== "append") {
            errors.push({
              field: `checks.${checkName}.session_mode`,
              message: `Invalid session_mode value for "${checkName}": must be 'clone' or 'append'`,
              value: checkConfig.session_mode
            });
          }
          if (!checkConfig.reuse_ai_session) {
            errors.push({
              field: `checks.${checkName}.session_mode`,
              message: `Check "${checkName}" has session_mode but no reuse_ai_session. session_mode requires reuse_ai_session to be set.`,
              value: checkConfig.session_mode
            });
          }
        }
        if (checkConfig.tags !== void 0) {
          if (!Array.isArray(checkConfig.tags)) {
            errors.push({
              field: `checks.${checkName}.tags`,
              message: `Invalid tags value for "${checkName}": must be an array of strings`,
              value: checkConfig.tags
            });
          } else {
            const validTagPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;
            checkConfig.tags.forEach((tag, index) => {
              if (typeof tag !== "string") {
                errors.push({
                  field: `checks.${checkName}.tags[${index}]`,
                  message: `Invalid tag at index ${index} for "${checkName}": must be a string`,
                  value: tag
                });
              } else if (!validTagPattern.test(tag)) {
                errors.push({
                  field: `checks.${checkName}.tags[${index}]`,
                  message: `Invalid tag "${tag}" for "${checkName}": tags must be alphanumeric with hyphens or underscores (start with alphanumeric)`,
                  value: tag
                });
              }
            });
          }
        }
        if (checkConfig.on_finish !== void 0) {
          if (!checkConfig.forEach) {
            errors.push({
              field: `checks.${checkName}.on_finish`,
              message: `Check "${checkName}" has on_finish but forEach is not true. on_finish is only valid on forEach checks.`,
              value: checkConfig.on_finish
            });
          }
        }
      }
      /**
       * Validate MCP servers object shape and values (basic shape only)
       */
      validateMcpServersObject(mcpServers, fieldPrefix, errors, _warnings) {
        if (typeof mcpServers !== "object" || mcpServers === null) {
          errors.push({
            field: fieldPrefix,
            message: `${fieldPrefix} must be an object mapping server names to { command, args?, env? }`,
            value: mcpServers
          });
          return;
        }
        for (const [serverName, cfg] of Object.entries(mcpServers)) {
          const pathStr = `${fieldPrefix}.${serverName}`;
          if (!cfg || typeof cfg !== "object") {
            errors.push({ field: pathStr, message: `${pathStr} must be an object`, value: cfg });
            continue;
          }
          const { command, args, env } = cfg;
          if (typeof command !== "string" || command.trim() === "") {
            errors.push({
              field: `${pathStr}.command`,
              message: `${pathStr}.command must be a non-empty string`,
              value: command
            });
          }
          if (args !== void 0 && !Array.isArray(args)) {
            errors.push({
              field: `${pathStr}.args`,
              message: `${pathStr}.args must be an array of strings`,
              value: args
            });
          }
          if (env !== void 0) {
            if (typeof env !== "object" || env === null) {
              errors.push({
                field: `${pathStr}.env`,
                message: `${pathStr}.env must be an object of string values`,
                value: env
              });
            } else {
              for (const [k, v] of Object.entries(env)) {
                if (typeof v !== "string") {
                  errors.push({
                    field: `${pathStr}.env.${k}`,
                    message: `${pathStr}.env.${k} must be a string`,
                    value: v
                  });
                }
              }
            }
          }
        }
      }
      /**
       * Validate configuration using generated JSON Schema via Ajv, if available.
       * Adds to errors/warnings but does not throw directly.
       */
      validateWithAjvSchema(config, errors, warnings) {
        try {
          if (!__ajvValidate) {
            try {
              const jsonPath = path2.resolve(__dirname, "generated", "config-schema.json");
              const jsonSchema = __require(jsonPath);
              if (jsonSchema) {
                const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
                addFormats(ajv);
                const validate = ajv.compile(jsonSchema);
                __ajvValidate = (data) => validate(data);
                __ajvErrors = () => validate.errors;
              }
            } catch {
            }
            if (!__ajvValidate) {
              try {
                const mod = (init_config_schema(), __toCommonJS(config_schema_exports));
                const schema = mod?.configSchema || mod?.default || mod;
                if (schema) {
                  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
                  addFormats(ajv);
                  const validate = ajv.compile(schema);
                  __ajvValidate = (data) => validate(data);
                  __ajvErrors = () => validate.errors;
                } else {
                  return;
                }
              } catch {
                return;
              }
            }
          }
          const ok = __ajvValidate(config);
          const errs = __ajvErrors ? __ajvErrors() : null;
          if (!ok && Array.isArray(errs)) {
            for (const e of errs) {
              const pathStr = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";
              const msg = e.message || "Invalid configuration";
              if (e.keyword === "additionalProperties") {
                const addl = e.params && e.params.additionalProperty || "unknown";
                const fullField = pathStr ? `${pathStr}.${addl}` : addl;
                const topLevel = !pathStr;
                if (topLevel && (addl === "tests" || addl === "slack")) {
                  continue;
                }
                warnings.push({
                  field: fullField || "config",
                  message: topLevel ? `Unknown top-level key '${addl}' will be ignored.` : `Unknown key '${addl}' will be ignored`
                });
              } else {
                logger.debug(`Ajv note [${pathStr || "config"}]: ${msg}`);
              }
            }
          }
        } catch (err) {
          logger.debug(`Ajv validation skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Unknown-key warnings are fully handled by Ajv using the generated schema
      // Unknown-key hints are produced by Ajv (additionalProperties=false)
      /**
       * Validate tag filter configuration
       */
      validateTagFilter(tagFilter, errors) {
        const validTagPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;
        if (tagFilter.include !== void 0) {
          if (!Array.isArray(tagFilter.include)) {
            errors.push({
              field: "tag_filter.include",
              message: "tag_filter.include must be an array of strings",
              value: tagFilter.include
            });
          } else {
            tagFilter.include.forEach((tag, index) => {
              if (typeof tag !== "string") {
                errors.push({
                  field: `tag_filter.include[${index}]`,
                  message: `Invalid tag at index ${index}: must be a string`,
                  value: tag
                });
              } else if (!validTagPattern.test(tag)) {
                errors.push({
                  field: `tag_filter.include[${index}]`,
                  message: `Invalid tag "${tag}": tags must be alphanumeric with hyphens or underscores`,
                  value: tag
                });
              }
            });
          }
        }
        if (tagFilter.exclude !== void 0) {
          if (!Array.isArray(tagFilter.exclude)) {
            errors.push({
              field: "tag_filter.exclude",
              message: "tag_filter.exclude must be an array of strings",
              value: tagFilter.exclude
            });
          } else {
            tagFilter.exclude.forEach((tag, index) => {
              if (typeof tag !== "string") {
                errors.push({
                  field: `tag_filter.exclude[${index}]`,
                  message: `Invalid tag at index ${index}: must be a string`,
                  value: tag
                });
              } else if (!validTagPattern.test(tag)) {
                errors.push({
                  field: `tag_filter.exclude[${index}]`,
                  message: `Invalid tag "${tag}": tags must be alphanumeric with hyphens or underscores`,
                  value: tag
                });
              }
            });
          }
        }
      }
      /**
       * Validate HTTP server configuration
       */
      validateHttpServerConfig(httpServerConfig, errors) {
        if (typeof httpServerConfig.enabled !== "boolean") {
          errors.push({
            field: "http_server.enabled",
            message: "http_server.enabled must be a boolean",
            value: httpServerConfig.enabled
          });
        }
        if (httpServerConfig.enabled === true) {
          if (typeof httpServerConfig.port !== "number" || httpServerConfig.port < 1 || httpServerConfig.port > 65535) {
            errors.push({
              field: "http_server.port",
              message: "http_server.port must be a number between 1 and 65535",
              value: httpServerConfig.port
            });
          }
          if (httpServerConfig.auth) {
            const auth = httpServerConfig.auth;
            const validAuthTypes = ["bearer_token", "hmac", "basic", "none"];
            if (!auth.type || !validAuthTypes.includes(auth.type)) {
              errors.push({
                field: "http_server.auth.type",
                message: `Invalid auth type. Must be one of: ${validAuthTypes.join(", ")}`,
                value: auth.type
              });
            }
          }
          if (httpServerConfig.tls && typeof httpServerConfig.tls === "object") {
            const tls = httpServerConfig.tls;
            if (tls.enabled === true) {
              if (!tls.cert) {
                errors.push({
                  field: "http_server.tls.cert",
                  message: "TLS certificate is required when TLS is enabled"
                });
              }
              if (!tls.key) {
                errors.push({
                  field: "http_server.tls.key",
                  message: "TLS key is required when TLS is enabled"
                });
              }
            }
          }
          if (httpServerConfig.endpoints && Array.isArray(httpServerConfig.endpoints)) {
            for (let i = 0; i < httpServerConfig.endpoints.length; i++) {
              const endpoint = httpServerConfig.endpoints[i];
              if (!endpoint.path || typeof endpoint.path !== "string") {
                errors.push({
                  field: `http_server.endpoints[${i}].path`,
                  message: "Endpoint path must be a string",
                  value: endpoint.path
                });
              }
            }
          }
        }
      }
      /**
       * Validate output configuration
       */
      validateOutputConfig(outputConfig, errors) {
        if (outputConfig.pr_comment) {
          const prComment = outputConfig.pr_comment;
          if (typeof prComment.format === "string" && !this.validOutputFormats.includes(prComment.format)) {
            errors.push({
              field: "output.pr_comment.format",
              message: `Invalid output format "${prComment.format}". Must be one of: ${this.validOutputFormats.join(", ")}`,
              value: prComment.format
            });
          }
          if (typeof prComment.group_by === "string" && !this.validGroupByOptions.includes(prComment.group_by)) {
            errors.push({
              field: "output.pr_comment.group_by",
              message: `Invalid group_by option "${prComment.group_by}". Must be one of: ${this.validGroupByOptions.join(", ")}`,
              value: prComment.group_by
            });
          }
        }
      }
      /**
       * Check if remote extends are allowed
       */
      isRemoteExtendsAllowed() {
        if (process.env.VISOR_NO_REMOTE_EXTENDS === "true" || process.env.VISOR_NO_REMOTE_EXTENDS === "1") {
          return false;
        }
        return true;
      }
      /**
       * Merge configuration with default values
       */
      mergeWithDefaults(config) {
        const defaultConfig = {
          version: "1.0",
          checks: {},
          max_parallelism: 3,
          output: {
            pr_comment: {
              format: "markdown",
              group_by: "check",
              collapse: true
            }
          }
        };
        const merged = { ...defaultConfig, ...config };
        if (merged.output) {
          merged.output.pr_comment = {
            ...defaultConfig.output.pr_comment,
            ...merged.output.pr_comment
          };
        } else {
          merged.output = defaultConfig.output;
        }
        return merged;
      }
    };
    __ajvValidate = null;
    __ajvErrors = null;
  }
});

export {
  VALID_EVENT_TRIGGERS,
  ConfigManager,
  config_exports,
  init_config
};
//# sourceMappingURL=chunk-527EFLVV.mjs.map