## 🤖 AI Configuration

Visor supports multiple AI providers. Configure one via environment variables.

### Supported Providers

| Provider | Env Var | Example Models |
|----------|---------|----------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash-exp`, `gemini-1.5-pro` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-3-opus`, `claude-3-sonnet` |
| OpenAI GPT | `OPENAI_API_KEY` | `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` |
| AWS Bedrock | AWS credentials (see below) | `anthropic.claude-sonnet-4-20250514-v1:0` (default) |

### GitHub Actions Setup
Add the provider key as a secret (Settings → Secrets → Actions), then expose it:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: probelabs/visor@v1
    env:
      GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
      # or ANTHROPIC_API_KEY / OPENAI_API_KEY
      # For AWS Bedrock:
      # AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
      # AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      # AWS_REGION: us-east-1
```

### Local Development

```bash
# Google Gemini
export GOOGLE_API_KEY="your-api-key"
export MODEL_NAME="gemini-2.0-flash-exp"

# AWS Bedrock
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="us-east-1"
# Optional: Use specific model
export MODEL_NAME="anthropic.claude-sonnet-4-20250514-v1:0"
```

### AWS Bedrock Configuration

Bedrock supports multiple authentication methods:

1. **IAM Credentials** (recommended):
   ```bash
   export AWS_ACCESS_KEY_ID="your-access-key"
   export AWS_SECRET_ACCESS_KEY="your-secret-key"
   export AWS_REGION="us-east-1"
   ```

2. **Temporary Session Credentials**:
   ```bash
   export AWS_ACCESS_KEY_ID="your-access-key"
   export AWS_SECRET_ACCESS_KEY="your-secret-key"
   export AWS_SESSION_TOKEN="your-session-token"
   export AWS_REGION="us-east-1"
   ```

3. **API Key Authentication** (if configured):
   ```bash
   export AWS_BEDROCK_API_KEY="your-api-key"
   export AWS_BEDROCK_BASE_URL="https://your-custom-endpoint.com"  # Optional
   ```

To force Bedrock provider:
```bash
export FORCE_PROVIDER=bedrock
```

### YAML Configuration

#### Global Provider Settings

Configure a default AI provider in `.visor.yaml`:

```yaml
# Global configuration for all checks
ai_provider: bedrock  # or google, anthropic, openai
ai_model: anthropic.claude-sonnet-4-20250514-v1:0  # Optional, uses default if not specified

steps:
  security-review:
    type: ai
    prompt: "Analyze code for security vulnerabilities"
```

#### Per-Check Provider Configuration

Override the provider for specific checks:

```yaml
# Use different providers for different checks
steps:
  security-review:
    type: ai
    ai_provider: bedrock
    ai_model: anthropic.claude-sonnet-4-20250514-v1:0
    prompt: "Analyze code for security vulnerabilities using AWS Bedrock"

  performance-review:
    type: ai
    ai_provider: google
    ai_model: gemini-2.0-flash-exp
    prompt: "Analyze code for performance issues using Gemini"

  style-review:
    type: ai
    ai:
      provider: openai
      model: gpt-4-turbo
    prompt: "Review code style and best practices"
```

#### AWS Bedrock Specific Configuration

Complete example for Bedrock with all options:

```yaml
version: "1.0"

# Global Bedrock settings
ai_provider: bedrock
ai_model: anthropic.claude-sonnet-4-20250514-v1:0

# Environment variables can be referenced
env:
  AWS_REGION: us-east-1
  # AWS credentials should be set as environment variables, not in config

steps:
  comprehensive-review:
    type: ai
    ai_provider: bedrock
    prompt: |
      Perform a comprehensive code review including:
      - Security vulnerabilities
      - Performance optimizations
      - Code quality and best practices
      - Architectural concerns
    schema: code-review  # Use structured output format

  custom-bedrock-model:
    type: ai
    ai:
      provider: bedrock
      model: anthropic.claude-3-opus-20240229  # Use a different Bedrock model
      timeout: 120000  # 2 minute timeout for complex analysis
    prompt: "Perform deep architectural analysis"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: true
```

### Advanced AI Configuration

#### File Editing (`allowEdit`)

Enable Edit and Create tools to allow AI agents to modify files directly. This feature is disabled by default for security and requires explicit opt-in.

```yaml
steps:
  auto-fix-security:
    type: ai
    prompt: "Fix the security vulnerabilities found in the code"
    ai:
      provider: anthropic
      model: claude-3-opus
      allowEdit: true  # Enable Edit and Create tools

  read-only-review:
    type: ai
    prompt: "Review code for security issues"
    ai:
      provider: google
      allowEdit: false  # Disable editing (default)
```

**When to enable editing:**
- Automated fix workflows where the AI should apply changes
- Code refactoring tasks
- Auto-formatting or style correction
- When working in a sandboxed or test environment

**When to disable editing:**
- Review-only workflows (default behavior)
- Production environments without proper safeguards
- When you want to review suggested changes before applying them

**Security Note:** Edit tools respect existing `allowedFolders` configuration and perform exact string matching to prevent unintended modifications. Always review changes before merging.

#### Tool Filtering (`allowedTools`, `disableTools`)

Control which tools the AI agent can access during execution. This feature supports three filtering modes for fine-grained control over agent capabilities.

**Filtering Modes:**

1. **Allow All Tools (default)**: No filtering applied, agent has access to all available tools
2. **Whitelist Mode**: Specify exact tools the agent can use (e.g., `['Read', 'Grep']`)
3. **Exclusion Mode**: Block specific tools using `!` prefix (e.g., `['!Edit', '!Write']`)
4. **Raw AI Mode**: Disable all tools for pure conversational interactions

```yaml
steps:
  # Whitelist specific tools only
  restricted-analysis:
    type: ai
    prompt: "Analyze the codebase structure"
    ai:
      provider: anthropic
      allowedTools: ['Read', 'Grep', 'Glob']  # Only these tools allowed

  # Exclude specific tools
  safe-review:
    type: ai
    prompt: "Review code without making changes"
    ai:
      provider: google
      allowedTools: ['!Edit', '!Write', '!Delete']  # Block modification tools

  # Raw AI mode - no tools
  conversational:
    type: ai
    prompt: "Explain the architecture"
    ai:
      provider: openai
      disableTools: true  # Pure conversation, no tool access

  # Alternative raw AI mode
  conversational-alt:
    type: ai
    prompt: "Explain the architecture"
    ai:
      provider: anthropic
      allowedTools: []  # Empty array also disables all tools
```

**MCP Tool Filtering:**

Filter external Model Context Protocol tools using the `mcp__` prefix pattern:

```yaml
steps:
  mcp-filtered:
    type: ai
    prompt: "Search the codebase"
    ai:
      provider: anthropic
      allowedTools: ['mcp__code-search__*']  # Allow all code-search MCP tools
      mcpServers:
        code-search:
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-code-search"]
```

**When to use tool filtering:**
- Restrict agent capabilities for security-sensitive tasks
- Prevent unintended file modifications
- Create specialized agents with limited toolsets
- Testing and debugging specific tool interactions
- Compliance requirements that limit agent autonomy

**Security Note:** Tool filtering is enforced at runtime through system message filtering. Always combine with other security measures like `allowedFolders` for defense in depth.

#### Task Delegation (`enableDelegate`)

Enable the delegate tool to allow AI agents to break down complex tasks and distribute them to specialized subagents for parallel processing. This feature is available when using Probe as the AI provider (Google Gemini, Anthropic Claude, OpenAI GPT, AWS Bedrock).

```yaml
steps:
  comprehensive-security-audit:
    type: ai
    prompt: |
      Perform a comprehensive security audit including:
      - SQL injection vulnerabilities
      - XSS attack vectors
      - Authentication bypass risks
      - Authorization flaws
      - Cryptographic weaknesses
    ai:
      provider: anthropic
      model: claude-3-opus
      enableDelegate: true  # Enable task delegation to subagents

  focused-sql-injection-check:
    type: ai
    prompt: "Check for SQL injection vulnerabilities"
    ai:
      provider: google
      enableDelegate: false  # Disable delegation for focused check
```

**When to enable delegation:**
- Complex multi-step analysis requiring different expertise areas (e.g., security + performance + architecture)
- Large codebases where parallel processing speeds up review
- Comprehensive audits that benefit from specialized subagents

**When to disable delegation:**
- Simple, focused checks (e.g., "check for SQL injection")
- Time-sensitive reviews where speed is critical
- Resource-constrained environments
- Default behavior (delegation is disabled by default)

**Note:** Task delegation increases execution time and token usage, but can provide more thorough analysis for complex tasks.

#### Bash Command Execution (`allowBash` / `bashConfig`)

Enable secure bash command execution for AI agents to run read-only commands and analyze system state. This feature is disabled by default for security and requires explicit opt-in.

**Simple Configuration:**

Use `allowBash: true` for basic bash command execution with default safe commands:

```yaml
steps:
  # Simple: Enable bash with default safe commands
  git-status-analysis:
    type: ai
    prompt: "Analyze the project structure and git status"
    ai:
      provider: anthropic
      model: claude-3-opus
      allowBash: true  # Simple one-line enable
```

**Advanced Configuration:**

Use `bashConfig` for fine-grained control over bash command execution:

```yaml
steps:
  # Advanced: Custom allow/deny lists
  custom-bash-config:
    type: ai
    prompt: "Run custom analysis commands"
    ai:
      provider: google
      allowBash: true  # Enable bash execution
      bashConfig:
        allow: ['npm test', 'npm run lint']  # Additional allowed commands
        deny: ['npm install']  # Additional blocked commands
        timeout: 30000  # 30 second timeout per command
        workingDirectory: './src'  # Default working directory

  # Advanced: Disable default filters (expert mode)
  advanced-bash:
    type: ai
    prompt: "Run advanced system commands"
    ai:
      provider: anthropic
      allowBash: true
      bashConfig:
        noDefaultAllow: true  # Disable default safe command list
        noDefaultDeny: false  # Keep default dangerous command blocklist
        allow: ['specific-command-1', 'specific-command-2']
```

**Configuration Options:**

- **`allowBash`** (boolean): Simple toggle to enable bash command execution. Default: `false`
- **`allow`** (string[]): Additional permitted command patterns (e.g., `['ls', 'git status']`)
- **`deny`** (string[]): Additional blocked command patterns (e.g., `['rm -rf', 'sudo']`)
- **`noDefaultAllow`** (boolean): Disable default safe command list (~235 commands). Default: `false`
- **`noDefaultDeny`** (boolean): Disable default dangerous command blocklist (~191 patterns). Default: `false`
- **`timeout`** (number): Execution timeout in milliseconds. Default: varies by ProbeAgent
- **`workingDirectory`** (string): Base directory for command execution

**Default Security:**

ProbeAgent includes comprehensive security by default:
- **Safe Commands** (~235): Read-only operations like `ls`, `cat`, `git status`, `npm list`, `grep`
- **Blocked Commands** (~191): Dangerous operations like `rm -rf`, `sudo`, `npm install`, `curl`, system modifications

**When to enable bash commands:**
- System state analysis (git status, file listings, environment info)
- Running read-only diagnostic commands
- Executing test suites or linters
- Analyzing build outputs or logs

**When to keep bash disabled (default):**
- Security-sensitive environments
- Untrusted AI prompts or inputs
- Code review without system access needs
- Compliance requirements that prohibit command execution

**Security Best Practices:**
1. Always use the default allow/deny lists unless you have specific requirements
2. Set reasonable timeouts to prevent long-running commands
3. Use `workingDirectory` to restrict command execution scope
4. Audit command patterns in your allow list regularly
5. Test configuration in a safe environment first
6. Review AI-generated commands before enabling in production

**Example: Git Status Analysis**

```yaml
steps:
  git-status-review:
    type: ai
    prompt: |
      Analyze the current git status and provide insights:
      - Check for uncommitted changes
      - Review branch state
      - Identify any potential issues
    ai:
      provider: anthropic
      allowBash: true  # Simple enable
      bashConfig:
        allow: ['git log --oneline']  # Add custom git command
        workingDirectory: '.'
```

**Security Note:** Bash command execution respects existing security boundaries and permissions. Commands run with the same privileges as the Visor process. Always review and test bash configurations before deploying to production environments.

### Fallback Behavior

If no key is configured, Visor falls back to fast, heuristic checks (simple patterns, basic style/perf). For best results, set a provider.

### MCP (Tools) Support
See docs/mcp.md for adding MCP servers (Probe, Jira, Filesystem, etc.).

