## 🤖 AI Configuration

Visor supports multiple AI providers. Configure one via environment variables.

### Supported Providers

| Provider | Env Var | Example Models |
|----------|---------|----------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash-exp`, `gemini-1.5-pro` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-3-opus`, `claude-3-sonnet` |
| OpenAI GPT | `OPENAI_API_KEY` | `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` |

### GitHub Actions Setup
Add the provider key as a secret (Settings → Secrets → Actions), then expose it:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: probelabs/visor@v1
    env:
      GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
      # or ANTHROPIC_API_KEY / OPENAI_API_KEY
```

### Local Development

```bash
export GOOGLE_API_KEY="your-api-key"   # or ANTHROPIC/OPENAI
export MODEL_NAME="gemini-2.0-flash-exp"
```

### Fallback Behavior

If no key is configured, Visor falls back to fast, heuristic checks (simple patterns, basic style/perf). For best results, set a provider.

### MCP (Tools) Support
See docs/mcp.md for adding MCP servers (Probe, Jira, Filesystem, etc.).

