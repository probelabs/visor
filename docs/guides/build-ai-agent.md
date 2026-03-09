# Build an AI Agent with Tools

This guide walks you through building an AI agent that can use shell commands, MCP tools, and multi-step reasoning. By the end you'll have a working agent that can explore code, run commands, and answer questions.

## Prerequisites

- Node.js 18+
- An AI provider API key (Google, Anthropic, or OpenAI)

## Step 1: Basic AI step with bash

The simplest agent is an AI step with bash access:

```yaml
version: "1.0"
ai_provider: google

steps:
  agent:
    type: ai
    prompt: "Find all TODO comments in the codebase and summarize them."
    enable_bash: true
```

With `enable_bash: true`, the AI can run shell commands to explore the filesystem, run grep, read files, etc.

Run it: `npx visor`

## Step 2: Add custom tools

Define tools the AI can call. Tools are shell commands with typed inputs:

```yaml
version: "1.0"
ai_provider: google

# Define reusable tools at the top level
tools:
  count-lines:
    description: "Count lines in a file"
    exec: "wc -l {{ args.file }}"
    args:
      file:
        type: string
        description: "Path to the file"

  list-files:
    description: "List files matching a pattern"
    exec: "find . -name '{{ args.pattern }}' -type f"
    args:
      pattern:
        type: string
        description: "Glob pattern"

steps:
  agent:
    type: ai
    prompt: "Analyze the project structure. Which files are the largest?"
    ai_custom_tools: [count-lines, list-files]
```

## Step 3: Configure the AI persona

Use `system_prompt` inside the `ai:` block (not at step level):

```yaml
steps:
  agent:
    type: ai
    prompt: "{{ conversation.current.text }}"  # available in --tui and --message modes
    ai_custom_tools: [count-lines, list-files]
    ai:
      system_prompt: |
        You are a senior software engineer. You can use tools to explore
        the codebase. Always verify your assumptions by reading actual code.
        Be concise and cite file paths.
      max_iterations: 20     # allow up to 20 tool calls
```

## Step 4: Multi-step agent pipeline

Chain multiple agent steps for complex tasks:

```yaml
version: "1.0"
ai_provider: anthropic
ai_model: claude-sonnet-4-20250514

steps:
  # Step 1: Gather context
  explore:
    type: ai
    prompt: "Explore the project and identify the main modules and their responsibilities."
    enable_bash: true
    ai:
      system_prompt: "You are a code archaeologist. Map the codebase structure."

  # Step 2: Analyze with context from step 1
  analyze:
    type: ai
    prompt: |
      Based on this codebase map:
      {{ outputs["explore"] | json }}

      Identify the top 3 areas that need refactoring and explain why.
    depends_on: [explore]
    ai:
      system_prompt: "You are a software architect focused on code quality."

  # Step 3: Generate a report
  report:
    type: ai
    prompt: |
      Create a markdown report from this analysis:
      {{ outputs["analyze"] | json }}
    depends_on: [analyze]
```

## Step 5: Add MCP tools

Connect external MCP servers for specialized capabilities:

```yaml
steps:
  agent:
    type: ai
    prompt: "Check the repository for security issues using Semgrep."
    ai_mcp_servers:
      semgrep:
        command: npx
        args: ["-y", "@semgrep/mcp@latest"]
    ai:
      system_prompt: "You are a security analyst. Use Semgrep to scan the code."
```

Or use the MCP provider directly for non-AI tool calls:

```yaml
steps:
  scan:
    type: mcp
    transport: stdio
    command: npx
    command_args: ["-y", "@semgrep/mcp@latest"]
    method: scan
    methodArgs:
      path: "."
```

## Step 6: Run as a Slack bot

The same config works as a conversational Slack bot:

```bash
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... npx visor --slack --config agent.yaml
```

Or interactively in the terminal:

```bash
npx visor --tui --config agent.yaml
```

## Configuration quick reference

```yaml
version: "1.0"

# ── Global defaults ─────────────────────────────────
ai_provider: google              # default for all AI steps
ai_model: gemini-2.5-flash       # default model

# ── Tools (top level) ───────────────────────────────
tools:
  my-tool:
    description: "..."
    exec: "..."
    args: { ... }

# ── Steps ────────────────────────────────────────────
steps:
  my-step:
    type: ai
    prompt: "..."

    # AI config goes in the ai: block
    ai:
      system_prompt: "..."       # NOT at step level
      provider: anthropic        # override global
      model: claude-sonnet-4-20250514      # override global
      max_iterations: 20

    # OR use shorthand at step level (same effect)
    ai_system_prompt: "..."
    ai_provider: anthropic
    ai_model: claude-sonnet-4-20250514

    # Tool access
    enable_bash: true            # allow shell commands
    ai_custom_tools: [tool-name] # reference top-level tools
    ai_mcp_servers:              # connect MCP servers
      server-name:
        command: "..."
        args: [...]
```

## Complete examples

- [ai-custom-tools-simple.yaml](../../examples/ai-custom-tools-simple.yaml) — AI with custom tools
- [ai-with-bash.yaml](../../examples/ai-with-bash.yaml) — AI with bash access
- [claude-code-config.yaml](../../examples/claude-code-config.yaml) — Claude Code with MCP tools
- [mcp-provider-example.yaml](../../examples/mcp-provider-example.yaml) — Direct MCP tool calls

## Common mistakes

| Mistake | Fix |
|---------|-----|
| `system_prompt` at step level | Put inside `ai:` block, or use `ai_system_prompt` |
| Top-level `ai:` block | Use `ai_provider`/`ai_model` at top level |
| `model:` or `provider:` at step level | Use `ai_model`/`ai_provider` or put inside `ai:` |

Run `npx visor validate` to catch config errors.

## Next steps

- [AI Configuration](../ai-configuration.md) — providers, retry, fallback
- [AI Custom Tools](../ai-custom-tools.md) — tool definition reference
- [MCP Provider](../mcp-provider.md) — MCP transport options
- [Failure Routing](../failure-routing.md) — retry and auto-remediation
- [Session Reuse](../advanced-ai.md) — multi-turn conversations
