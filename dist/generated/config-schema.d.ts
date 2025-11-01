export declare const configSchema: {
    readonly $schema: "http://json-schema.org/draft-07/schema#";
    readonly $ref: "#/definitions/VisorConfigSchema";
    readonly definitions: {
        readonly VisorConfigSchema: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly hooks: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                };
                readonly version: {
                    readonly type: "string";
                    readonly description: "Configuration version";
                };
                readonly extends: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    }];
                    readonly description: "Extends from other configurations - can be file path, HTTP(S) URL, or \"default\"";
                };
                readonly steps: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CCheckConfig%3E";
                    readonly description: "Step configurations (recommended)";
                };
                readonly checks: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CCheckConfig%3E";
                    readonly description: "Check configurations (legacy, use 'steps' instead) - always populated after normalization";
                };
                readonly output: {
                    readonly $ref: "#/definitions/OutputConfig";
                    readonly description: "Output configuration";
                };
                readonly http_server: {
                    readonly $ref: "#/definitions/HttpServerConfig";
                    readonly description: "HTTP server configuration for receiving webhooks";
                };
                readonly memory: {
                    readonly $ref: "#/definitions/MemoryConfig";
                    readonly description: "Memory storage configuration";
                };
                readonly env: {
                    readonly $ref: "#/definitions/EnvConfig";
                    readonly description: "Global environment variables";
                };
                readonly ai_model: {
                    readonly type: "string";
                    readonly description: "Global AI model setting";
                };
                readonly ai_provider: {
                    readonly type: "string";
                    readonly description: "Global AI provider setting";
                };
                readonly ai_mcp_servers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E";
                    readonly description: "Global MCP servers configuration for AI checks";
                };
                readonly max_parallelism: {
                    readonly type: "number";
                    readonly description: "Maximum number of checks to run in parallel (default: 3)";
                };
                readonly fail_fast: {
                    readonly type: "boolean";
                    readonly description: "Stop execution when any check fails (default: false)";
                };
                readonly fail_if: {
                    readonly type: "string";
                    readonly description: "Simple global fail condition - fails if expression evaluates to true";
                };
                readonly failure_conditions: {
                    readonly $ref: "#/definitions/FailureConditions";
                    readonly description: "Global failure conditions - optional (deprecated, use fail_if)";
                };
                readonly tag_filter: {
                    readonly $ref: "#/definitions/TagFilter";
                    readonly description: "Tag filter for selective check execution";
                };
                readonly routing: {
                    readonly $ref: "#/definitions/RoutingDefaults";
                    readonly description: "Optional routing defaults for retry/goto/run policies";
                };
            };
            readonly required: readonly ["output", "version"];
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly 'Record<string,unknown>': {
            readonly type: "object";
            readonly additionalProperties: {};
        };
        readonly 'Record<string,CheckConfig>': {
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/CheckConfig";
            };
        };
        readonly CheckConfig: {
            readonly type: "object";
            readonly properties: {
                readonly type: {
                    readonly $ref: "#/definitions/ConfigCheckType";
                    readonly description: "Type of check to perform (defaults to 'ai' if not specified)";
                };
                readonly prompt: {
                    readonly type: "string";
                    readonly description: "AI prompt for the check - can be inline string or file path (auto-detected) - required for AI checks";
                };
                readonly appendPrompt: {
                    readonly type: "string";
                    readonly description: "Additional prompt to append when extending configurations - merged with parent prompt";
                };
                readonly exec: {
                    readonly type: "string";
                    readonly description: "Command execution with Liquid template support - required for command checks";
                };
                readonly stdin: {
                    readonly type: "string";
                    readonly description: "Stdin input for tools with Liquid template support - optional for tool checks";
                };
                readonly url: {
                    readonly type: "string";
                    readonly description: "HTTP URL - required for http output checks";
                };
                readonly body: {
                    readonly type: "string";
                    readonly description: "HTTP body template (Liquid) - required for http output checks";
                };
                readonly method: {
                    readonly type: "string";
                    readonly description: "HTTP method (defaults to POST)";
                };
                readonly headers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cstring%3E";
                    readonly description: "HTTP headers";
                };
                readonly endpoint: {
                    readonly type: "string";
                    readonly description: "HTTP endpoint path - required for http_input checks";
                };
                readonly transform: {
                    readonly type: "string";
                    readonly description: "Transform template for http_input data (Liquid) - optional";
                };
                readonly transform_js: {
                    readonly type: "string";
                    readonly description: "Transform using JavaScript expressions (evaluated in secure sandbox) - optional";
                };
                readonly content: {
                    readonly type: "string";
                    readonly description: "Script content to execute for script checks";
                };
                readonly schedule: {
                    readonly type: "string";
                    readonly description: "Cron schedule expression (e.g., \"0 2 * * *\") - optional for any check type";
                };
                readonly focus: {
                    readonly type: "string";
                    readonly description: "Focus area for the check (security/performance/style/architecture/all) - optional";
                };
                readonly command: {
                    readonly type: "string";
                    readonly description: "Command that triggers this check (e.g., \"review\", \"security-scan\") - optional";
                };
                readonly on: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/EventTrigger";
                    };
                    readonly description: "Events that trigger this check (defaults to ['manual'] if not specified)";
                };
                readonly triggers: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "File patterns that trigger this check (optional)";
                };
                readonly ai: {
                    readonly $ref: "#/definitions/AIProviderConfig";
                    readonly description: "AI provider configuration (optional)";
                };
                readonly ai_model: {
                    readonly type: "string";
                    readonly description: "AI model to use for this check - overrides global setting";
                };
                readonly ai_provider: {
                    readonly type: "string";
                    readonly description: "AI provider to use for this check - overrides global setting";
                };
                readonly ai_mcp_servers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E";
                    readonly description: "MCP servers for this AI check - overrides global setting";
                };
                readonly claude_code: {
                    readonly $ref: "#/definitions/ClaudeCodeConfig";
                    readonly description: "Claude Code configuration (for claude-code type checks)";
                };
                readonly env: {
                    readonly $ref: "#/definitions/EnvConfig";
                    readonly description: "Environment variables for this check";
                };
                readonly timeout: {
                    readonly type: "number";
                    readonly description: "Timeout in seconds for command execution (default: 60)";
                };
                readonly depends_on: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Check IDs that this check depends on (optional)";
                };
                readonly group: {
                    readonly type: "string";
                    readonly description: "Group name for comment separation (e.g., \"code-review\", \"pr-overview\") - optional";
                };
                readonly schema: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    }];
                    readonly description: "Schema type for template rendering (e.g., \"code-review\", \"markdown\") or inline JSON schema object - optional";
                };
                readonly template: {
                    readonly $ref: "#/definitions/CustomTemplateConfig";
                    readonly description: "Custom template configuration - optional";
                };
                readonly if: {
                    readonly type: "string";
                    readonly description: "Condition to determine if check should run - runs if expression evaluates to true";
                };
                readonly reuse_ai_session: {
                    readonly type: readonly ["string", "boolean"];
                    readonly description: "Check name to reuse AI session from, or true to use first dependency (only works with depends_on)";
                };
                readonly session_mode: {
                    readonly type: "string";
                    readonly enum: readonly ["clone", "append"];
                    readonly description: "How to reuse AI session: 'clone' (default, copy history) or 'append' (share history)";
                };
                readonly fail_if: {
                    readonly type: "string";
                    readonly description: "Simple fail condition - fails check if expression evaluates to true";
                };
                readonly failure_conditions: {
                    readonly $ref: "#/definitions/FailureConditions";
                    readonly description: "Check-specific failure conditions - optional (deprecated, use fail_if)";
                };
                readonly tags: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Tags for categorizing and filtering checks (e.g., [\"local\", \"fast\", \"security\"])";
                };
                readonly forEach: {
                    readonly type: "boolean";
                    readonly description: "Process output as array and run dependent checks for each item";
                };
                readonly fanout: {
                    readonly type: "string";
                    readonly enum: readonly ["map", "reduce"];
                    readonly description: "Control scheduling behavior when this check is triggered via routing (run/goto) from a forEach scope.\n- 'map': schedule once per item (fan-out) using item scopes.\n- 'reduce': schedule a single run at the parent scope (aggregation). If unset, the current default is a single run (reduce) for backward compatibility.";
                };
                readonly reduce: {
                    readonly type: "boolean";
                    readonly description: "Alias for fanout: 'reduce'";
                };
                readonly on_fail: {
                    readonly $ref: "#/definitions/OnFailConfig";
                    readonly description: "Failure routing configuration for this check (retry/goto/run)";
                };
                readonly on_success: {
                    readonly $ref: "#/definitions/OnSuccessConfig";
                    readonly description: "Success routing configuration for this check (post-actions and optional goto)";
                };
                readonly on_finish: {
                    readonly $ref: "#/definitions/OnFinishConfig";
                    readonly description: "Finish routing configuration for forEach checks (runs after ALL iterations complete)";
                };
                readonly message: {
                    readonly type: "string";
                    readonly description: "Message template for log checks";
                };
                readonly level: {
                    readonly type: "string";
                    readonly enum: readonly ["debug", "info", "warn", "error"];
                    readonly description: "Log level for log checks";
                };
                readonly include_pr_context: {
                    readonly type: "boolean";
                    readonly description: "Include PR context in log output";
                };
                readonly include_dependencies: {
                    readonly type: "boolean";
                    readonly description: "Include dependency summaries in log output";
                };
                readonly include_metadata: {
                    readonly type: "boolean";
                    readonly description: "Include execution metadata in log output";
                };
                readonly output_format: {
                    readonly type: "string";
                    readonly enum: readonly ["json", "text"];
                    readonly description: "Output parsing hint for command provider (optional) When set to 'json', command stdout is expected to be JSON. When 'text', treat as plain text. Note: command provider attempts JSON parsing heuristically; this flag mainly suppresses schema warnings and may be used by providers to alter parsing behavior in the future.";
                };
                readonly operation: {
                    readonly type: "string";
                    readonly enum: readonly ["get", "set", "append", "increment", "delete", "clear", "list"];
                    readonly description: "Memory operation to perform. Use `type: 'script'` for custom JavaScript.";
                };
                readonly key: {
                    readonly type: "string";
                    readonly description: "Key for memory operation";
                };
                readonly value: {
                    readonly description: "Value for set/append operations";
                };
                readonly value_js: {
                    readonly type: "string";
                    readonly description: "JavaScript expression to compute value dynamically";
                };
                readonly namespace: {
                    readonly type: "string";
                    readonly description: "Override namespace for this check";
                };
                readonly op: {
                    readonly type: "string";
                    readonly description: "GitHub operation to perform (e.g., 'labels.add', 'labels.remove', 'comment.create')";
                };
                readonly values: {
                    readonly anyOf: readonly [{
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    }, {
                        readonly type: "string";
                    }];
                    readonly description: "Values for GitHub operations (can be array or single value)";
                };
                readonly transport: {
                    readonly type: "string";
                    readonly enum: readonly ["stdio", "sse", "http"];
                    readonly description: "Transport type for MCP: stdio (default), sse (legacy), or http (streamable HTTP)";
                };
                readonly methodArgs: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Arguments to pass to the MCP method (supports Liquid templates)";
                };
                readonly argsTransform: {
                    readonly type: "string";
                    readonly description: "Transform template for method arguments (Liquid)";
                };
                readonly sessionId: {
                    readonly type: "string";
                    readonly description: "Session ID for HTTP transport (optional, server may generate one)";
                };
                readonly args: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Command arguments (for stdio transport in MCP checks)";
                };
                readonly workingDirectory: {
                    readonly type: "string";
                    readonly description: "Working directory (for stdio transport in MCP checks)";
                };
                readonly placeholder: {
                    readonly type: "string";
                    readonly description: "Placeholder text to show in input field";
                };
                readonly allow_empty: {
                    readonly type: "boolean";
                    readonly description: "Allow empty input (default: false)";
                };
                readonly multiline: {
                    readonly type: "boolean";
                    readonly description: "Support multiline input (default: false)";
                };
                readonly default: {
                    readonly type: "string";
                    readonly description: "Default value if timeout occurs or empty input when allow_empty is true";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Configuration for a single check";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly ConfigCheckType: {
            readonly type: "string";
            readonly enum: readonly ["ai", "command", "script", "http", "http_input", "http_client", "noop", "log", "memory", "github", "claude-code", "mcp", "human-input"];
            readonly description: "Valid check types in configuration";
        };
        readonly 'Record<string,string>': {
            readonly type: "object";
            readonly additionalProperties: {
                readonly type: "string";
            };
        };
        readonly EventTrigger: {
            readonly type: "string";
            readonly enum: readonly ["pr_opened", "pr_updated", "pr_closed", "issue_opened", "issue_comment", "manual", "schedule", "webhook_received"];
            readonly description: "Valid event triggers for checks";
        };
        readonly AIProviderConfig: {
            readonly type: "object";
            readonly properties: {
                readonly provider: {
                    readonly type: "string";
                    readonly enum: readonly ["google", "anthropic", "openai", "bedrock", "mock"];
                    readonly description: "AI provider to use";
                };
                readonly model: {
                    readonly type: "string";
                    readonly description: "Model name to use";
                };
                readonly apiKey: {
                    readonly type: "string";
                    readonly description: "API key (usually from environment variables)";
                };
                readonly timeout: {
                    readonly type: "number";
                    readonly description: "Request timeout in milliseconds";
                };
                readonly debug: {
                    readonly type: "boolean";
                    readonly description: "Enable debug mode";
                };
                readonly skip_code_context: {
                    readonly type: "boolean";
                    readonly description: "Skip adding code context (diffs, files, PR info) to the prompt";
                };
                readonly disable_tools: {
                    readonly type: "boolean";
                    readonly description: "Disable MCP tools - AI will only have access to the prompt text";
                };
                readonly mcpServers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E";
                    readonly description: "MCP servers configuration";
                };
                readonly enableDelegate: {
                    readonly type: "boolean";
                    readonly description: "Enable the delegate tool for task distribution to subagents";
                };
            };
            readonly additionalProperties: false;
            readonly description: "AI provider configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly 'Record<string,McpServerConfig>': {
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/McpServerConfig";
            };
        };
        readonly McpServerConfig: {
            readonly type: "object";
            readonly properties: {
                readonly command: {
                    readonly type: "string";
                    readonly description: "Command to execute for the MCP server";
                };
                readonly args: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Arguments to pass to the command";
                };
                readonly env: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cstring%3E";
                    readonly description: "Environment variables for the MCP server";
                };
            };
            readonly required: readonly ["command"];
            readonly additionalProperties: false;
            readonly description: "MCP Server configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly ClaudeCodeConfig: {
            readonly type: "object";
            readonly properties: {
                readonly allowedTools: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "List of allowed tools for Claude Code to use";
                };
                readonly maxTurns: {
                    readonly type: "number";
                    readonly description: "Maximum number of turns in conversation";
                };
                readonly systemPrompt: {
                    readonly type: "string";
                    readonly description: "System prompt for Claude Code";
                };
                readonly mcpServers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E";
                    readonly description: "MCP servers configuration";
                };
                readonly subagent: {
                    readonly type: "string";
                    readonly description: "Path to subagent script";
                };
                readonly enableDelegate: {
                    readonly type: "boolean";
                    readonly description: "Enable the delegate tool for task distribution to subagents";
                };
                readonly hooks: {
                    readonly type: "object";
                    readonly properties: {
                        readonly onStart: {
                            readonly type: "string";
                            readonly description: "Called when check starts";
                        };
                        readonly onEnd: {
                            readonly type: "string";
                            readonly description: "Called when check ends";
                        };
                        readonly onError: {
                            readonly type: "string";
                            readonly description: "Called when check encounters an error";
                        };
                    };
                    readonly additionalProperties: false;
                    readonly description: "Event hooks for lifecycle management";
                    readonly patternProperties: {
                        readonly '^x-': {};
                    };
                };
            };
            readonly additionalProperties: false;
            readonly description: "Claude Code configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly EnvConfig: {
            readonly type: "object";
            readonly additionalProperties: {
                readonly type: readonly ["string", "number", "boolean"];
            };
            readonly description: "Environment variable reference configuration";
        };
        readonly CustomTemplateConfig: {
            readonly type: "object";
            readonly properties: {
                readonly file: {
                    readonly type: "string";
                    readonly description: "Path to custom template file (relative to config file or absolute)";
                };
                readonly content: {
                    readonly type: "string";
                    readonly description: "Raw template content as string";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Custom template configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly FailureConditions: {
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/FailureCondition";
            };
            readonly description: "Collection of failure conditions";
        };
        readonly FailureCondition: {
            readonly anyOf: readonly [{
                readonly $ref: "#/definitions/SimpleFailureCondition";
            }, {
                readonly $ref: "#/definitions/ComplexFailureCondition";
            }];
            readonly description: "Failure condition - can be a simple expression string or complex object";
        };
        readonly SimpleFailureCondition: {
            readonly type: "string";
            readonly description: "Simple failure condition - just an expression string";
        };
        readonly ComplexFailureCondition: {
            readonly type: "object";
            readonly properties: {
                readonly condition: {
                    readonly type: "string";
                    readonly description: "Expression to evaluate using Function Constructor";
                };
                readonly message: {
                    readonly type: "string";
                    readonly description: "Human-readable message when condition is met";
                };
                readonly severity: {
                    readonly $ref: "#/definitions/FailureConditionSeverity";
                    readonly description: "Severity level of the failure";
                };
                readonly halt_execution: {
                    readonly type: "boolean";
                    readonly description: "Whether this condition should halt execution";
                };
            };
            readonly required: readonly ["condition"];
            readonly additionalProperties: false;
            readonly description: "Complex failure condition with additional metadata";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly FailureConditionSeverity: {
            readonly type: "string";
            readonly enum: readonly ["error", "warning", "info"];
            readonly description: "Failure condition severity levels";
        };
        readonly OnFailConfig: {
            readonly type: "object";
            readonly properties: {
                readonly retry: {
                    readonly $ref: "#/definitions/RetryPolicy";
                    readonly description: "Retry policy";
                };
                readonly run: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Remediation steps to run before reattempt";
                };
                readonly goto: {
                    readonly type: "string";
                    readonly description: "Jump back to an ancestor step (by id)";
                };
                readonly goto_event: {
                    readonly $ref: "#/definitions/EventTrigger";
                    readonly description: "Simulate a different event when performing goto (e.g., 'pr_updated')";
                };
                readonly goto_js: {
                    readonly type: "string";
                    readonly description: "Dynamic goto: JS expression returning step id or null";
                };
                readonly run_js: {
                    readonly type: "string";
                    readonly description: "Dynamic remediation list: JS expression returning string[]";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Failure routing configuration per check";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly RetryPolicy: {
            readonly type: "object";
            readonly properties: {
                readonly max: {
                    readonly type: "number";
                    readonly description: "Maximum retry attempts (excluding the first attempt)";
                };
                readonly backoff: {
                    readonly $ref: "#/definitions/BackoffPolicy";
                    readonly description: "Backoff policy";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Retry policy for a step";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly BackoffPolicy: {
            readonly type: "object";
            readonly properties: {
                readonly mode: {
                    readonly type: "string";
                    readonly enum: readonly ["fixed", "exponential"];
                    readonly description: "Backoff mode";
                };
                readonly delay_ms: {
                    readonly type: "number";
                    readonly description: "Initial delay in milliseconds";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Backoff policy for retries";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly OnSuccessConfig: {
            readonly type: "object";
            readonly properties: {
                readonly run: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Post-success steps to run";
                };
                readonly goto: {
                    readonly type: "string";
                    readonly description: "Optional jump back to ancestor step (by id)";
                };
                readonly goto_event: {
                    readonly $ref: "#/definitions/EventTrigger";
                    readonly description: "Simulate a different event when performing goto (e.g., 'pr_updated')";
                };
                readonly goto_js: {
                    readonly type: "string";
                    readonly description: "Dynamic goto: JS expression returning step id or null";
                };
                readonly run_js: {
                    readonly type: "string";
                    readonly description: "Dynamic post-success steps: JS expression returning string[]";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Success routing configuration per check";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly OnFinishConfig: {
            readonly type: "object";
            readonly properties: {
                readonly run: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Post-finish steps to run";
                };
                readonly goto: {
                    readonly type: "string";
                    readonly description: "Optional jump back to ancestor step (by id)";
                };
                readonly goto_event: {
                    readonly $ref: "#/definitions/EventTrigger";
                    readonly description: "Simulate a different event when performing goto (e.g., 'pr_updated')";
                };
                readonly goto_js: {
                    readonly type: "string";
                    readonly description: "Dynamic goto: JS expression returning step id or null";
                };
                readonly run_js: {
                    readonly type: "string";
                    readonly description: "Dynamic post-finish steps: JS expression returning string[]";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Finish routing configuration for forEach checks Runs once after ALL iterations of forEach and ALL dependent checks complete";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly OutputConfig: {
            readonly type: "object";
            readonly properties: {
                readonly pr_comment: {
                    readonly $ref: "#/definitions/PrCommentOutput";
                    readonly description: "PR comment configuration";
                };
                readonly file_comment: {
                    readonly $ref: "#/definitions/FileCommentOutput";
                    readonly description: "File comment configuration (optional)";
                };
                readonly github_checks: {
                    readonly $ref: "#/definitions/GitHubCheckOutput";
                    readonly description: "GitHub check runs configuration (optional)";
                };
                readonly suppressionEnabled: {
                    readonly type: "boolean";
                    readonly description: "Whether to enable issue suppression via visor-disable comments (default: true)";
                };
            };
            readonly required: readonly ["pr_comment"];
            readonly additionalProperties: false;
            readonly description: "Output configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly PrCommentOutput: {
            readonly type: "object";
            readonly properties: {
                readonly format: {
                    readonly $ref: "#/definitions/ConfigOutputFormat";
                    readonly description: "Format of the output";
                };
                readonly group_by: {
                    readonly $ref: "#/definitions/GroupByOption";
                    readonly description: "How to group the results";
                };
                readonly collapse: {
                    readonly type: "boolean";
                    readonly description: "Whether to collapse sections by default";
                };
                readonly debug: {
                    readonly $ref: "#/definitions/DebugConfig";
                    readonly description: "Debug mode configuration (optional)";
                };
            };
            readonly required: readonly ["format", "group_by", "collapse"];
            readonly additionalProperties: false;
            readonly description: "PR comment output configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly ConfigOutputFormat: {
            readonly type: "string";
            readonly enum: readonly ["table", "json", "markdown", "sarif"];
            readonly description: "Valid output formats";
        };
        readonly GroupByOption: {
            readonly type: "string";
            readonly enum: readonly ["check", "file", "severity", "group"];
            readonly description: "Valid grouping options";
        };
        readonly DebugConfig: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Enable debug mode";
                };
                readonly includePrompts: {
                    readonly type: "boolean";
                    readonly description: "Include AI prompts in debug output";
                };
                readonly includeRawResponses: {
                    readonly type: "boolean";
                    readonly description: "Include raw AI responses in debug output";
                };
                readonly includeTiming: {
                    readonly type: "boolean";
                    readonly description: "Include timing information";
                };
                readonly includeProviderInfo: {
                    readonly type: "boolean";
                    readonly description: "Include provider information";
                };
            };
            readonly required: readonly ["enabled", "includePrompts", "includeRawResponses", "includeTiming", "includeProviderInfo"];
            readonly additionalProperties: false;
            readonly description: "Debug mode configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly FileCommentOutput: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Whether file comments are enabled";
                };
                readonly inline: {
                    readonly type: "boolean";
                    readonly description: "Whether to show inline comments";
                };
            };
            readonly required: readonly ["enabled", "inline"];
            readonly additionalProperties: false;
            readonly description: "File comment output configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly GitHubCheckOutput: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Whether GitHub check runs are enabled";
                };
                readonly per_check: {
                    readonly type: "boolean";
                    readonly description: "Whether to create individual check runs per configured check";
                };
                readonly name_prefix: {
                    readonly type: "string";
                    readonly description: "Custom name prefix for check runs";
                };
            };
            readonly required: readonly ["enabled", "per_check"];
            readonly additionalProperties: false;
            readonly description: "GitHub Check Runs output configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly HttpServerConfig: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Whether HTTP server is enabled";
                };
                readonly port: {
                    readonly type: "number";
                    readonly description: "Port to listen on";
                };
                readonly host: {
                    readonly type: "string";
                    readonly description: "Host/IP to bind to (defaults to 0.0.0.0)";
                };
                readonly tls: {
                    readonly $ref: "#/definitions/TlsConfig";
                    readonly description: "TLS/SSL configuration for HTTPS";
                };
                readonly auth: {
                    readonly $ref: "#/definitions/HttpAuthConfig";
                    readonly description: "Authentication configuration";
                };
                readonly endpoints: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/HttpEndpointConfig";
                    };
                    readonly description: "HTTP endpoints configuration";
                };
            };
            readonly required: readonly ["enabled", "port"];
            readonly additionalProperties: false;
            readonly description: "HTTP server configuration for receiving webhooks";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly TlsConfig: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Enable TLS/HTTPS";
                };
                readonly cert: {
                    readonly type: "string";
                    readonly description: "Path to TLS certificate file or certificate content";
                };
                readonly key: {
                    readonly type: "string";
                    readonly description: "Path to TLS key file or key content";
                };
                readonly ca: {
                    readonly type: "string";
                    readonly description: "Path to CA certificate file or CA content (optional)";
                };
                readonly rejectUnauthorized: {
                    readonly type: "boolean";
                    readonly description: "Reject unauthorized connections (default: true)";
                };
            };
            readonly required: readonly ["enabled"];
            readonly additionalProperties: false;
            readonly description: "TLS/SSL configuration for HTTPS server";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly HttpAuthConfig: {
            readonly type: "object";
            readonly properties: {
                readonly type: {
                    readonly type: "string";
                    readonly enum: readonly ["bearer_token", "hmac", "basic", "none"];
                    readonly description: "Authentication type";
                };
                readonly secret: {
                    readonly type: "string";
                    readonly description: "Secret or token for authentication";
                };
                readonly username: {
                    readonly type: "string";
                    readonly description: "Username for basic auth";
                };
                readonly password: {
                    readonly type: "string";
                    readonly description: "Password for basic auth";
                };
            };
            readonly required: readonly ["type"];
            readonly additionalProperties: false;
            readonly description: "HTTP server authentication configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly HttpEndpointConfig: {
            readonly type: "object";
            readonly properties: {
                readonly path: {
                    readonly type: "string";
                    readonly description: "Path for the webhook endpoint";
                };
                readonly transform: {
                    readonly type: "string";
                    readonly description: "Optional transform template (Liquid) for the received data";
                };
                readonly name: {
                    readonly type: "string";
                    readonly description: "Optional name/ID for this endpoint";
                };
            };
            readonly required: readonly ["path"];
            readonly additionalProperties: false;
            readonly description: "HTTP server endpoint configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly MemoryConfig: {
            readonly type: "object";
            readonly properties: {
                readonly storage: {
                    readonly type: "string";
                    readonly enum: readonly ["memory", "file"];
                    readonly description: "Storage mode: \"memory\" (in-memory, default) or \"file\" (persistent)";
                };
                readonly format: {
                    readonly type: "string";
                    readonly enum: readonly ["json", "csv"];
                    readonly description: "Storage format (only for file storage, default: json)";
                };
                readonly file: {
                    readonly type: "string";
                    readonly description: "File path (required if storage: file)";
                };
                readonly namespace: {
                    readonly type: "string";
                    readonly description: "Default namespace (default: \"default\")";
                };
                readonly auto_load: {
                    readonly type: "boolean";
                    readonly description: "Auto-load on startup (default: true if storage: file)";
                };
                readonly auto_save: {
                    readonly type: "boolean";
                    readonly description: "Auto-save after operations (default: true if storage: file)";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Memory storage configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly TagFilter: {
            readonly type: "object";
            readonly properties: {
                readonly include: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Tags that checks must have to be included (ANY match)";
                };
                readonly exclude: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Tags that will exclude checks if present (ANY match)";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Tag filter configuration for selective check execution";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly RoutingDefaults: {
            readonly type: "object";
            readonly properties: {
                readonly max_loops: {
                    readonly type: "number";
                    readonly description: "Per-scope cap on routing transitions (success + failure)";
                };
                readonly defaults: {
                    readonly type: "object";
                    readonly properties: {
                        readonly on_fail: {
                            readonly $ref: "#/definitions/OnFailConfig";
                        };
                    };
                    readonly additionalProperties: false;
                    readonly description: "Default policies applied to checks (step-level overrides take precedence)";
                    readonly patternProperties: {
                        readonly '^x-': {};
                    };
                };
            };
            readonly additionalProperties: false;
            readonly description: "Global routing defaults";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
    };
};
export default configSchema;
//# sourceMappingURL=config-schema.d.ts.map