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
                readonly include: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    }];
                    readonly description: "Alias for extends - include from other configurations (backward compatibility)";
                };
                readonly tools: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CCustomToolDefinition%3E";
                    readonly description: "Custom tool definitions that can be used in MCP blocks";
                };
                readonly imports: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Import workflow definitions from external files or URLs";
                };
                readonly inputs: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/WorkflowInput";
                    };
                    readonly description: "Workflow inputs (for standalone reusable workflows)";
                };
                readonly outputs: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/WorkflowOutput";
                    };
                    readonly description: "Workflow outputs (for standalone reusable workflows)";
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
                    readonly description: "Output configuration (optional - defaults provided)";
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
                readonly limits: {
                    readonly $ref: "#/definitions/LimitsConfig";
                    readonly description: "Global execution limits";
                };
                readonly frontends: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "object";
                        readonly properties: {
                            readonly name: {
                                readonly type: "string";
                                readonly description: "Frontend name, e.g., 'ndjson-sink', 'github'";
                            };
                            readonly config: {
                                readonly description: "Frontend-specific configuration";
                            };
                        };
                        readonly required: readonly ["name"];
                        readonly additionalProperties: false;
                    };
                    readonly description: "Optional integrations: event-driven frontends (e.g., ndjson-sink, github)";
                };
                readonly workspace: {
                    readonly $ref: "#/definitions/WorkspaceConfig";
                    readonly description: "Workspace isolation configuration for sandboxed execution";
                };
                readonly slack: {
                    readonly $ref: "#/definitions/SlackConfig";
                    readonly description: "Slack configuration";
                };
            };
            readonly required: readonly ["version"];
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly 'Record<string,unknown>': {
            readonly type: "object";
            readonly additionalProperties: {};
        };
        readonly 'Record<string,CustomToolDefinition>': {
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/CustomToolDefinition";
            };
        };
        readonly CustomToolDefinition: {
            readonly type: "object";
            readonly properties: {
                readonly name: {
                    readonly type: "string";
                    readonly description: "Tool name - used to reference the tool in MCP blocks";
                };
                readonly description: {
                    readonly type: "string";
                    readonly description: "Description of what the tool does";
                };
                readonly inputSchema: {
                    readonly type: "object";
                    readonly properties: {
                        readonly type: {
                            readonly type: "string";
                            readonly const: "object";
                        };
                        readonly properties: {
                            readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                        };
                        readonly required: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly additionalProperties: {
                            readonly type: "boolean";
                        };
                    };
                    readonly required: readonly ["type"];
                    readonly additionalProperties: false;
                    readonly description: "Input schema for the tool (JSON Schema format)";
                    readonly patternProperties: {
                        readonly '^x-': {};
                    };
                };
                readonly exec: {
                    readonly type: "string";
                    readonly description: "Command to execute - supports Liquid template";
                };
                readonly stdin: {
                    readonly type: "string";
                    readonly description: "Optional stdin input - supports Liquid template";
                };
                readonly transform: {
                    readonly type: "string";
                    readonly description: "Transform the raw output - supports Liquid template";
                };
                readonly transform_js: {
                    readonly type: "string";
                    readonly description: "Transform the output using JavaScript - alternative to transform";
                };
                readonly cwd: {
                    readonly type: "string";
                    readonly description: "Working directory for command execution";
                };
                readonly env: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cstring%3E";
                    readonly description: "Environment variables for the command";
                };
                readonly timeout: {
                    readonly type: "number";
                    readonly description: "Timeout in milliseconds";
                };
                readonly parseJson: {
                    readonly type: "boolean";
                    readonly description: "Whether to parse output as JSON automatically";
                };
                readonly outputSchema: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Expected output schema for validation";
                };
            };
            readonly required: readonly ["name", "exec"];
            readonly additionalProperties: false;
            readonly description: "Custom tool definition for use in MCP blocks";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly 'Record<string,string>': {
            readonly type: "object";
            readonly additionalProperties: {
                readonly type: "string";
            };
        };
        readonly WorkflowInput: {
            readonly type: "object";
            readonly properties: {
                readonly name: {
                    readonly type: "string";
                    readonly description: "Input parameter name";
                };
                readonly schema: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "JSON Schema for the input";
                };
                readonly required: {
                    readonly type: "boolean";
                    readonly description: "Whether this input is required";
                };
                readonly default: {
                    readonly description: "Default value if not provided";
                };
                readonly description: {
                    readonly type: "string";
                    readonly description: "Human-readable description";
                };
            };
            readonly required: readonly ["name"];
            readonly additionalProperties: false;
            readonly description: "Workflow input definition for standalone reusable workflows";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly WorkflowOutput: {
            readonly type: "object";
            readonly properties: {
                readonly name: {
                    readonly type: "string";
                    readonly description: "Output name";
                };
                readonly description: {
                    readonly type: "string";
                    readonly description: "Human-readable description";
                };
                readonly value: {
                    readonly type: "string";
                    readonly description: "Value using Liquid template syntax (references step outputs)";
                };
                readonly value_js: {
                    readonly type: "string";
                    readonly description: "Value using JavaScript expression (alternative to value)";
                };
            };
            readonly required: readonly ["name"];
            readonly additionalProperties: false;
            readonly description: "Workflow output definition for standalone reusable workflows";
            readonly patternProperties: {
                readonly '^x-': {};
            };
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
                readonly ai_persona: {
                    readonly type: "string";
                    readonly description: "Optional persona hint, prepended to the prompt as 'Persona: <value>'";
                };
                readonly ai_prompt_type: {
                    readonly type: "string";
                    readonly description: "Probe promptType for this check (underscore style)";
                };
                readonly ai_system_prompt: {
                    readonly type: "string";
                    readonly description: "System prompt for this check (underscore style)";
                };
                readonly ai_custom_prompt: {
                    readonly type: "string";
                    readonly description: "Legacy customPrompt (underscore style) — deprecated, use ai_system_prompt";
                };
                readonly ai_mcp_servers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E";
                    readonly description: "MCP servers for this AI check - overrides global setting";
                };
                readonly ai_custom_tools: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "List of custom tool names to expose to this AI check via ephemeral SSE MCP server";
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
                    readonly description: "Timeout in milliseconds for command execution (default: 60000, i.e., 60 seconds)";
                };
                readonly depends_on: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    }];
                    readonly description: "Check IDs that this check depends on (optional). Accepts single string or array.";
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
                readonly output_schema: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Optional JSON Schema to validate the produced output. If omitted and `schema` is an object, the engine will treat that object as the output_schema for validation purposes while still using string schemas (e.g., 'code-review') for template selection.";
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
                readonly criticality: {
                    readonly type: "string";
                    readonly enum: readonly ["external", "internal", "policy", "info"];
                    readonly description: "Operational criticality of this step. Drives default safety policies (contracts, retries, loop budgets) at load time. Behavior can still be overridden explicitly per step via on_*, fail_if, assume/guarantee, etc.\n\n- 'external': interacts with external systems (side effects). Highest safety.\n- 'internal': modifies CI/config/state but not prod. High safety.\n- 'policy': organizational checks (linting, style, doc). Moderate safety.\n- 'info': informational checks. Lowest safety.";
                };
                readonly continue_on_failure: {
                    readonly type: "boolean";
                    readonly description: "Allow dependents to run even if this step fails. Defaults to false (dependents are gated when this step fails). Similar to GitHub Actions' continue-on-error.";
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
                readonly on_init: {
                    readonly $ref: "#/definitions/OnInitConfig";
                    readonly description: "Init routing configuration for this check (runs before execution/preprocessing)";
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
                readonly assume: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    }];
                    readonly description: "Preconditions that must hold before executing the check. If any expression evaluates to false, the check is skipped (skipReason='assume').";
                };
                readonly guarantee: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    }];
                    readonly description: "Postconditions that should hold after executing the check. Expressions are evaluated against the produced result/output; violations are recorded as error issues with ruleId \"contract/guarantee_failed\".";
                };
                readonly max_runs: {
                    readonly type: "number";
                    readonly description: "Hard cap on how many times this check may execute within a single engine run. Overrides global limits.max_runs_per_check. Set to 0 or negative to disable for this step.";
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
                readonly command_args: {
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
                readonly workflow: {
                    readonly type: "string";
                    readonly description: "Workflow ID or path to workflow file";
                };
                readonly args: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Arguments/inputs for the workflow";
                };
                readonly overrides: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CPartial%3Cinterface-src_types_config.ts-11359-23582-src_types_config.ts-0-41281%3E%3E";
                    readonly description: "Override specific step configurations in the workflow";
                };
                readonly output_mapping: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cstring%3E";
                    readonly description: "Map workflow outputs to check outputs";
                };
                readonly workflow_inputs: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Alias for args - workflow inputs (backward compatibility)";
                };
                readonly config: {
                    readonly type: "string";
                    readonly description: "Config file path - alternative to workflow ID (loads a Visor config file as workflow)";
                };
                readonly workflow_overrides: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CPartial%3Cinterface-src_types_config.ts-11359-23582-src_types_config.ts-0-41281%3E%3E";
                    readonly description: "Alias for overrides - workflow step overrides (backward compatibility)";
                };
                readonly ref: {
                    readonly type: "string";
                    readonly description: "Git reference to checkout (branch, tag, commit SHA) - supports templates";
                };
                readonly repository: {
                    readonly type: "string";
                    readonly description: "Repository URL or owner/repo format (defaults to current repository)";
                };
                readonly token: {
                    readonly type: "string";
                    readonly description: "GitHub token for private repositories (defaults to GITHUB_TOKEN env)";
                };
                readonly fetch_depth: {
                    readonly type: "number";
                    readonly description: "Number of commits to fetch (0 for full history, default: 1)";
                };
                readonly fetch_tags: {
                    readonly type: "boolean";
                    readonly description: "Whether to fetch tags (default: false)";
                };
                readonly submodules: {
                    readonly anyOf: readonly [{
                        readonly type: "boolean";
                    }, {
                        readonly type: "string";
                        readonly const: "recursive";
                    }];
                    readonly description: "Checkout submodules: false, true, or 'recursive'";
                };
                readonly working_directory: {
                    readonly type: "string";
                    readonly description: "Working directory for the checkout (defaults to temp directory)";
                };
                readonly use_worktree: {
                    readonly type: "boolean";
                    readonly description: "Use git worktree for efficient parallel checkouts (default: true)";
                };
                readonly clean: {
                    readonly type: "boolean";
                    readonly description: "Clean the working directory before checkout (default: true)";
                };
                readonly sparse_checkout: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Sparse checkout paths - only checkout specific directories/files";
                };
                readonly lfs: {
                    readonly type: "boolean";
                    readonly description: "Enable Git LFS (Large File Storage)";
                };
                readonly clone_timeout_ms: {
                    readonly type: "number";
                    readonly description: "Timeout in ms for cloning the bare repository (default: 300000 = 5 min)";
                };
                readonly cleanup_on_failure: {
                    readonly type: "boolean";
                    readonly description: "Clean up worktree on failure (default: true)";
                };
                readonly persist_worktree: {
                    readonly type: "boolean";
                    readonly description: "Keep worktree after workflow completion (default: false)";
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
            readonly enum: readonly ["ai", "command", "script", "http", "http_input", "http_client", "noop", "log", "memory", "github", "claude-code", "mcp", "human-input", "workflow", "git-checkout"];
            readonly description: "Valid check types in configuration";
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
                readonly prompt_type: {
                    readonly type: "string";
                    readonly description: "Probe promptType to use (e.g., engineer, code-review, architect)";
                };
                readonly system_prompt: {
                    readonly type: "string";
                    readonly description: "System prompt (baseline preamble). Replaces legacy custom_prompt.";
                };
                readonly custom_prompt: {
                    readonly type: "string";
                    readonly description: "Probe customPrompt (baseline/system prompt) — deprecated, use system_prompt";
                };
                readonly skip_code_context: {
                    readonly type: "boolean";
                    readonly description: "Skip adding code context (diffs, files, PR info) to the prompt";
                };
                readonly skip_slack_context: {
                    readonly type: "boolean";
                    readonly description: "Skip adding Slack conversation context to the prompt (when running under Slack)";
                };
                readonly skip_transport_context: {
                    readonly type: "boolean";
                    readonly description: "Skip adding transport-specific context (e.g., GitHub PR/issue XML, Slack conversation XML) to the prompt. When true, this behaves like setting both skip_code_context and skip_slack_context to true, unless those are explicitly overridden.";
                };
                readonly mcpServers: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CMcpServerConfig%3E";
                    readonly description: "MCP servers configuration";
                };
                readonly enableDelegate: {
                    readonly type: "boolean";
                    readonly description: "Enable the delegate tool for task distribution to subagents";
                };
                readonly retry: {
                    readonly $ref: "#/definitions/AIRetryConfig";
                    readonly description: "Retry configuration for this provider";
                };
                readonly fallback: {
                    readonly $ref: "#/definitions/AIFallbackConfig";
                    readonly description: "Fallback configuration for provider failures";
                };
                readonly allowEdit: {
                    readonly type: "boolean";
                    readonly description: "Enable Edit and Create tools for file modification (disabled by default for security)";
                };
                readonly allowedTools: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Filter allowed tools - supports whitelist, exclusion (!prefix), or raw AI mode (empty array)";
                };
                readonly disableTools: {
                    readonly type: "boolean";
                    readonly description: "Disable all tools for raw AI mode (alternative to allowedTools: [])";
                };
                readonly allowBash: {
                    readonly type: "boolean";
                    readonly description: "Enable bash command execution (shorthand for bashConfig.enabled)";
                };
                readonly bashConfig: {
                    readonly $ref: "#/definitions/BashConfig";
                    readonly description: "Advanced bash command execution configuration";
                };
                readonly completion_prompt: {
                    readonly type: "string";
                    readonly description: "Completion prompt for post-completion validation/review (runs after attempt_completion)";
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
        readonly AIRetryConfig: {
            readonly type: "object";
            readonly properties: {
                readonly maxRetries: {
                    readonly type: "number";
                    readonly description: "Maximum retry attempts (0-50)";
                };
                readonly initialDelay: {
                    readonly type: "number";
                    readonly description: "Initial delay in milliseconds (0-60000)";
                };
                readonly maxDelay: {
                    readonly type: "number";
                    readonly description: "Maximum delay cap in milliseconds (0-300000)";
                };
                readonly backoffFactor: {
                    readonly type: "number";
                    readonly description: "Exponential backoff multiplier (1-10)";
                };
                readonly retryableErrors: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Custom error patterns to retry on";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Retry configuration for AI provider calls";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly AIFallbackConfig: {
            readonly type: "object";
            readonly properties: {
                readonly strategy: {
                    readonly type: "string";
                    readonly enum: readonly ["same-model", "same-provider", "any", "custom"];
                    readonly description: "Fallback strategy: 'same-model', 'same-provider', 'any', or 'custom'";
                };
                readonly providers: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/AIFallbackProviderConfig";
                    };
                    readonly description: "Array of fallback provider configurations";
                };
                readonly maxTotalAttempts: {
                    readonly type: "number";
                    readonly description: "Maximum total attempts across all providers";
                };
                readonly auto: {
                    readonly type: "boolean";
                    readonly description: "Enable automatic fallback using available environment variables";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Fallback configuration for AI providers";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly AIFallbackProviderConfig: {
            readonly type: "object";
            readonly properties: {
                readonly provider: {
                    readonly type: "string";
                    readonly enum: readonly ["google", "anthropic", "openai", "bedrock"];
                    readonly description: "AI provider to use";
                };
                readonly model: {
                    readonly type: "string";
                    readonly description: "Model name to use";
                };
                readonly apiKey: {
                    readonly type: "string";
                    readonly description: "API key for this provider";
                };
                readonly maxRetries: {
                    readonly type: "number";
                    readonly description: "Per-provider retry override";
                };
                readonly region: {
                    readonly type: "string";
                    readonly description: "AWS region (for Bedrock)";
                };
                readonly accessKeyId: {
                    readonly type: "string";
                    readonly description: "AWS access key ID (for Bedrock)";
                };
                readonly secretAccessKey: {
                    readonly type: "string";
                    readonly description: "AWS secret access key (for Bedrock)";
                };
            };
            readonly required: readonly ["provider", "model"];
            readonly additionalProperties: false;
            readonly description: "Fallback provider configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly BashConfig: {
            readonly type: "object";
            readonly properties: {
                readonly allow: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Array of permitted command patterns (e.g., ['ls', 'git status'])";
                };
                readonly deny: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "Array of blocked command patterns (e.g., ['rm -rf', 'sudo'])";
                };
                readonly noDefaultAllow: {
                    readonly type: "boolean";
                    readonly description: "Disable default safe command list (use with caution)";
                };
                readonly noDefaultDeny: {
                    readonly type: "boolean";
                    readonly description: "Disable default dangerous command blocklist (use with extreme caution)";
                };
                readonly timeout: {
                    readonly type: "number";
                    readonly description: "Execution timeout in milliseconds";
                };
                readonly workingDirectory: {
                    readonly type: "string";
                    readonly description: "Default working directory for command execution";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Bash command execution configuration for ProbeAgent Note: Use 'allowBash: true' in AIProviderConfig to enable bash execution";
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
        readonly OnInitConfig: {
            readonly type: "object";
            readonly properties: {
                readonly run: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/OnInitRunItem";
                    };
                    readonly description: "Items to run before this check executes";
                };
                readonly run_js: {
                    readonly type: "string";
                    readonly description: "Dynamic init items: JS expression returning OnInitRunItem[]";
                };
                readonly transitions: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/TransitionRule";
                    };
                    readonly description: "Declarative transitions (optional, for advanced use cases)";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Init routing configuration per check Runs BEFORE the check executes (preprocessing/setup)";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly OnInitRunItem: {
            readonly anyOf: readonly [{
                readonly $ref: "#/definitions/OnInitToolInvocation";
            }, {
                readonly $ref: "#/definitions/OnInitStepInvocation";
            }, {
                readonly $ref: "#/definitions/OnInitWorkflowInvocation";
            }, {
                readonly type: "string";
            }];
            readonly description: "Unified on_init run item - can be tool, step, workflow, or plain string";
        };
        readonly OnInitToolInvocation: {
            readonly type: "object";
            readonly properties: {
                readonly tool: {
                    readonly type: "string";
                    readonly description: "Tool name (must exist in tools: section)";
                };
                readonly with: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Arguments to pass to the tool (Liquid templates supported)";
                };
                readonly as: {
                    readonly type: "string";
                    readonly description: "Custom output name (defaults to tool name)";
                };
            };
            readonly required: readonly ["tool"];
            readonly additionalProperties: false;
            readonly description: "Invoke a custom tool (from tools: section)";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly OnInitStepInvocation: {
            readonly type: "object";
            readonly properties: {
                readonly step: {
                    readonly type: "string";
                    readonly description: "Step name (must exist in steps: section)";
                };
                readonly with: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Arguments to pass to the step (Liquid templates supported)";
                };
                readonly as: {
                    readonly type: "string";
                    readonly description: "Custom output name (defaults to step name)";
                };
            };
            readonly required: readonly ["step"];
            readonly additionalProperties: false;
            readonly description: "Invoke a helper step (regular check)";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly OnInitWorkflowInvocation: {
            readonly type: "object";
            readonly properties: {
                readonly workflow: {
                    readonly type: "string";
                    readonly description: "Workflow ID or path";
                };
                readonly with: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cunknown%3E";
                    readonly description: "Workflow inputs (Liquid templates supported)";
                };
                readonly as: {
                    readonly type: "string";
                    readonly description: "Custom output name (defaults to workflow name)";
                };
                readonly overrides: {
                    readonly $ref: "#/definitions/Record%3Cstring%2CPartial%3Cinterface-src_types_config.ts-11359-23582-src_types_config.ts-0-41281%3E%3E";
                    readonly description: "Step overrides";
                };
                readonly output_mapping: {
                    readonly $ref: "#/definitions/Record%3Cstring%2Cstring%3E";
                    readonly description: "Output mapping";
                };
            };
            readonly required: readonly ["workflow"];
            readonly additionalProperties: false;
            readonly description: "Invoke a reusable workflow";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly 'Record<string,Partial<interface-src_types_config.ts-11359-23582-src_types_config.ts-0-41281>>': {
            readonly type: "object";
            readonly additionalProperties: {
                readonly $ref: "#/definitions/Partial%3Cinterface-src_types_config.ts-11359-23582-src_types_config.ts-0-41281%3E";
            };
        };
        readonly 'Partial<interface-src_types_config.ts-11359-23582-src_types_config.ts-0-41281>': {
            readonly type: "object";
            readonly additionalProperties: false;
        };
        readonly TransitionRule: {
            readonly type: "object";
            readonly properties: {
                readonly when: {
                    readonly type: "string";
                    readonly description: "JavaScript expression evaluated in the same sandbox as goto_js; truthy enables the rule.";
                };
                readonly to: {
                    readonly type: readonly ["string", "null"];
                    readonly description: "Target step ID, or null to explicitly prevent goto.";
                };
                readonly goto_event: {
                    readonly $ref: "#/definitions/EventTrigger";
                    readonly description: "Optional event override when performing goto.";
                };
            };
            readonly required: readonly ["when"];
            readonly additionalProperties: false;
            readonly description: "Declarative transition rule for on_* blocks.";
            readonly patternProperties: {
                readonly '^x-': {};
            };
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
                readonly transitions: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/TransitionRule";
                    };
                    readonly description: "Declarative transitions. Evaluated in order; first matching rule wins. If a rule's `to` is null, no goto occurs. When omitted or none match, the engine falls back to goto_js/goto for backward compatibility.";
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
                readonly transitions: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/TransitionRule";
                    };
                    readonly description: "Declarative transitions (see OnFailConfig.transitions).";
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
                readonly transitions: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/definitions/TransitionRule";
                    };
                    readonly description: "Declarative transitions (see OnFailConfig.transitions).";
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
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Whether PR comments are enabled";
                };
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
        readonly LimitsConfig: {
            readonly type: "object";
            readonly properties: {
                readonly max_runs_per_check: {
                    readonly type: "number";
                    readonly description: "Maximum number of executions per check within a single engine run. Applies to each distinct scope independently for forEach item executions. Set to 0 or negative to disable. Default: 50.";
                };
                readonly max_workflow_depth: {
                    readonly type: "number";
                    readonly description: "Maximum nesting depth for workflows executed by the state machine engine. Nested workflows are invoked by the workflow provider; this limit prevents accidental infinite recursion. Default: 3.";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Global engine limits";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly WorkspaceConfig: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Enable workspace isolation (default: true when config present)";
                };
                readonly base_path: {
                    readonly type: "string";
                    readonly description: "Base path for workspaces (default: /tmp/visor-workspaces)";
                };
                readonly name: {
                    readonly type: "string";
                    readonly description: "Workspace directory name (defaults to session id)";
                };
                readonly main_project_name: {
                    readonly type: "string";
                    readonly description: "Main project folder name inside the workspace (defaults to original directory name)";
                };
                readonly cleanup_on_exit: {
                    readonly type: "boolean";
                    readonly description: "Clean up workspace on exit (default: true)";
                };
                readonly include_main_project: {
                    readonly type: "boolean";
                    readonly description: "Include main project worktree in AI allowed folders (default: false)";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Workspace isolation configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly SlackConfig: {
            readonly type: "object";
            readonly properties: {
                readonly version: {
                    readonly type: "string";
                    readonly description: "Slack API version";
                };
                readonly mentions: {
                    readonly type: "string";
                    readonly description: "Mention handling: 'all', 'direct', etc.";
                };
                readonly threads: {
                    readonly type: "string";
                    readonly description: "Thread handling: 'required', 'optional', etc.";
                };
                readonly allow_bot_messages: {
                    readonly type: "boolean";
                    readonly description: "Allow bot_message events to trigger runs (default: false)";
                };
                readonly show_raw_output: {
                    readonly type: "boolean";
                    readonly description: "Show raw output in Slack responses";
                };
                readonly telemetry: {
                    readonly $ref: "#/definitions/SlackTelemetryConfig";
                    readonly description: "Append telemetry identifiers to Slack replies.";
                };
            };
            readonly additionalProperties: false;
            readonly description: "Slack configuration";
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
        readonly SlackTelemetryConfig: {
            readonly type: "object";
            readonly properties: {
                readonly enabled: {
                    readonly type: "boolean";
                    readonly description: "Enable telemetry ID suffix in Slack messages";
                };
            };
            readonly additionalProperties: false;
            readonly patternProperties: {
                readonly '^x-': {};
            };
        };
    };
};
export default configSchema;
//# sourceMappingURL=config-schema.d.ts.map