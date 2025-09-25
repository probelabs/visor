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

### Fallback Behavior

If no key is configured, Visor falls back to fast, heuristic checks (simple patterns, basic style/perf). For best results, set a provider.

### MCP (Tools) Support
See docs/mcp.md for adding MCP servers (Probe, Jira, Filesystem, etc.).

