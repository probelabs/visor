import {
  CheckExecutionEngine
} from "./chunk-BVFNRCHT.mjs";
import "./chunk-TUTOLSFV.mjs";
import {
  init_logger,
  logger
} from "./chunk-B5QBV2QJ.mjs";
import "./chunk-U7X54EMV.mjs";
import {
  ConfigMerger
} from "./chunk-U5D2LY66.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

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
      $ref: "#/definitions/VisorConfig",
      definitions: {
        VisorConfig: {
          type: "object",
          properties: {
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
            }
          },
          required: ["version", "output"],
          additionalProperties: false,
          description: "Main Visor configuration",
          patternProperties: {
            "^x-": {}
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
            ai_mcp_servers: {
              $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E",
              description: "MCP servers for this AI check - overrides global setting"
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
            forEach: {
              type: "boolean",
              description: "Process output as array and run dependent checks for each item"
            },
            on_fail: {
              $ref: "#/definitions/OnFailConfig",
              description: "Failure routing configuration for this check (retry/goto/run)"
            },
            on_success: {
              $ref: "#/definitions/OnSuccessConfig",
              description: "Success routing configuration for this check (post-actions and optional goto)"
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
            operation: {
              type: "string",
              enum: ["get", "set", "append", "increment", "delete", "clear", "list", "exec_js"],
              description: "Memory operation to perform"
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
            memory_js: {
              type: "string",
              description: "JavaScript code for exec_js operation with full memory access"
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
            args: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Command arguments (for stdio transport in MCP checks)"
            },
            workingDirectory: {
              type: "string",
              description: "Working directory (for stdio transport in MCP checks)"
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
            "http",
            "http_input",
            "http_client",
            "noop",
            "log",
            "memory",
            "github",
            "claude-code",
            "mcp",
            "human-input"
          ],
          description: "Valid check types in configuration"
        },
        "Record<string,string>": {
          type: "object",
          additionalProperties: {
            type: "string"
          }
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
            mcpServers: {
              $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E",
              description: "MCP servers configuration"
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
        "Record<string,unknown>": {
          type: "object",
          additionalProperties: {}
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
            }
          },
          additionalProperties: false,
          description: "Success routing configuration per check",
          patternProperties: {
            "^x-": {}
          }
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
        }
      }
    };
    config_schema_default = configSchema;
  }
});

// src/config.ts
init_logger();
import * as yaml2 from "js-yaml";
import * as fs2 from "fs";
import * as path2 from "path";
import simpleGit from "simple-git";

// src/utils/config-loader.ts
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
var ConfigLoader = class {
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
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configuration file not found: ${resolvedPath}`);
    }
    try {
      const content = fs.readFileSync(resolvedPath, "utf8");
      const config = yaml.load(content);
      if (!config || typeof config !== "object") {
        throw new Error(`Invalid YAML in configuration file: ${resolvedPath}`);
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
      // When running as GitHub Action (bundled in dist/)
      path.join(__dirname, "defaults", ".visor.yaml"),
      // When running from source
      path.join(__dirname, "..", "..", "defaults", ".visor.yaml"),
      // Try via package root
      this.findPackageRoot() ? path.join(this.findPackageRoot(), "defaults", ".visor.yaml") : "",
      // GitHub Action environment variable
      process.env.GITHUB_ACTION_PATH ? path.join(process.env.GITHUB_ACTION_PATH, "defaults", ".visor.yaml") : "",
      process.env.GITHUB_ACTION_PATH ? path.join(process.env.GITHUB_ACTION_PATH, "dist", "defaults", ".visor.yaml") : ""
    ].filter((p) => p);
    let defaultConfigPath;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        defaultConfigPath = possiblePath;
        break;
      }
    }
    if (defaultConfigPath && fs.existsSync(defaultConfigPath)) {
      console.error(`\u{1F4E6} Loading bundled default configuration from ${defaultConfigPath}`);
      const content = fs.readFileSync(defaultConfigPath, "utf8");
      let config = yaml.load(content);
      if (!config || typeof config !== "object") {
        throw new Error("Invalid default configuration");
      }
      config = this.normalizeStepsAndChecks(config);
      if (config.extends) {
        return await this.processExtends(config);
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
    const { ConfigMerger: ConfigMerger2 } = await import("./config-merger-TWUBWFC2.mjs");
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
      config.checks = config.steps;
    } else if (config.steps && !config.checks) {
      config.checks = config.steps;
    } else if (config.checks && !config.steps) {
      config.steps = config.checks;
    }
    return config;
  }
};

// src/config.ts
import Ajv from "ajv";
import addFormats from "ajv-formats";
var VALID_EVENT_TRIGGERS = [
  "pr_opened",
  "pr_updated",
  "pr_closed",
  "issue_opened",
  "issue_comment",
  "manual",
  "schedule",
  "webhook_received"
];
var ConfigManager = class {
  validCheckTypes = [
    "ai",
    "claude-code",
    "mcp",
    "command",
    "http",
    "http_input",
    "http_client",
    "memory",
    "noop",
    "log",
    "memory",
    "github",
    "human-input"
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
      if (!fs2.existsSync(resolvedPath)) {
        throw new Error(`Configuration file not found: ${resolvedPath}`);
      }
      const configContent = fs2.readFileSync(resolvedPath, "utf8");
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
      if (parsedConfig.extends) {
        const loaderOptions = {
          baseDir: path2.dirname(resolvedPath),
          allowRemote: this.isRemoteExtendsAllowed(),
          maxDepth: 10,
          allowedRemotePatterns
        };
        const loader = new ConfigLoader(loaderOptions);
        const merger = new ConfigMerger();
        const extends_ = Array.isArray(parsedConfig.extends) ? parsedConfig.extends : [parsedConfig.extends];
        const { extends: _extendsField, ...configWithoutExtends } = parsedConfig;
        let mergedConfig = {};
        for (const source of extends_) {
          console.log(`\u{1F4E6} Extending from: ${source}`);
          const parentConfig = await loader.fetchConfig(source);
          mergedConfig = merger.merge(mergedConfig, parentConfig);
        }
        parsedConfig = merger.merge(mergedConfig, configWithoutExtends);
        parsedConfig = merger.removeDisabledChecks(parsedConfig);
      }
      parsedConfig = this.normalizeStepsAndChecks(parsedConfig);
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
   * Find and load configuration from default locations
   */
  async findAndLoadConfig(options = {}) {
    const gitRoot = await this.findGitRepositoryRoot();
    const searchDirs = [gitRoot, process.cwd()].filter(Boolean);
    for (const baseDir of searchDirs) {
      const possiblePaths = [path2.join(baseDir, ".visor.yaml"), path2.join(baseDir, ".visor.yml")];
      for (const configPath of possiblePaths) {
        if (fs2.existsSync(configPath)) {
          return this.loadConfig(configPath, options);
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
          path2.join(__dirname, "defaults", ".visor.yaml"),
          path2.join(__dirname, "..", "defaults", ".visor.yaml")
        );
      }
      const pkgRoot = this.findPackageRoot();
      if (pkgRoot) {
        possiblePaths.push(path2.join(pkgRoot, "defaults", ".visor.yaml"));
      }
      if (process.env.GITHUB_ACTION_PATH) {
        possiblePaths.push(
          path2.join(process.env.GITHUB_ACTION_PATH, "defaults", ".visor.yaml"),
          path2.join(process.env.GITHUB_ACTION_PATH, "dist", "defaults", ".visor.yaml")
        );
      }
      let bundledConfigPath;
      for (const possiblePath of possiblePaths) {
        if (fs2.existsSync(possiblePath)) {
          bundledConfigPath = possiblePath;
          break;
        }
      }
      if (bundledConfigPath && fs2.existsSync(bundledConfigPath)) {
        console.error(`\u{1F4E6} Loading bundled default configuration from ${bundledConfigPath}`);
        const configContent = fs2.readFileSync(bundledConfigPath, "utf8");
        let parsedConfig = yaml2.load(configContent);
        if (!parsedConfig || typeof parsedConfig !== "object") {
          return null;
        }
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
   * Normalize 'checks' and 'steps' keys for backward compatibility
   * Ensures both keys are present and contain the same data
   */
  normalizeStepsAndChecks(config) {
    if (config.steps && config.checks) {
      config.checks = config.steps;
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
        this.validateCheckConfig(checkName, checkConfig, errors, config);
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
  validateCheckConfig(checkName, checkConfig, errors, config) {
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
var __ajvValidate = null;
var __ajvErrors = null;

// src/sdk.ts
async function loadConfig(configOrPath, options) {
  const cm = new ConfigManager();
  if (typeof configOrPath === "object" && configOrPath !== null) {
    cm.validateConfig(configOrPath, options?.strict ?? false);
    const defaultConfig = {
      version: "1.0",
      checks: {},
      max_parallelism: 3,
      fail_fast: false
    };
    return {
      ...defaultConfig,
      ...configOrPath,
      checks: configOrPath.checks || {}
    };
  }
  if (typeof configOrPath === "string") {
    return cm.loadConfig(configOrPath);
  }
  return cm.findAndLoadConfig();
}
function resolveChecks(checkIds, config) {
  if (!config?.checks) return Array.from(new Set(checkIds));
  const resolved = /* @__PURE__ */ new Set();
  const visiting = /* @__PURE__ */ new Set();
  const result = [];
  const dfs = (id, stack = []) => {
    if (resolved.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...stack, id].join(" -> ");
      throw new Error(`Circular dependency detected involving check: ${id} (path: ${cycle})`);
    }
    visiting.add(id);
    const deps = config.checks[id]?.depends_on || [];
    for (const d of deps) dfs(d, [...stack, id]);
    if (!result.includes(id)) result.push(id);
    visiting.delete(id);
    resolved.add(id);
  };
  for (const id of checkIds) dfs(id);
  return result;
}
async function runChecks(opts = {}) {
  const cm = new ConfigManager();
  let config;
  if (opts.config) {
    cm.validateConfig(opts.config, opts.strictValidation ?? false);
    config = opts.config;
  } else if (opts.configPath) {
    config = await cm.loadConfig(opts.configPath);
  } else {
    config = await cm.findAndLoadConfig();
  }
  const checks = opts.checks && opts.checks.length > 0 ? resolveChecks(opts.checks, config) : Object.keys(config.checks || {});
  const engine = new CheckExecutionEngine(opts.cwd);
  if (opts.executionContext) {
    engine.setExecutionContext(opts.executionContext);
  }
  const result = await engine.executeChecks({
    checks,
    workingDirectory: opts.cwd,
    timeout: opts.timeoutMs,
    maxParallelism: opts.maxParallelism,
    failFast: opts.failFast,
    outputFormat: opts.output?.format,
    config,
    debug: opts.debug,
    tagFilter: opts.tagFilter
  });
  return result;
}
export {
  loadConfig,
  resolveChecks,
  runChecks
};
//# sourceMappingURL=sdk.mjs.map