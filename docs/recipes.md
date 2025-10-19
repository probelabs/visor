## 📚 Examples & Recipes

- Minimal `.visor.yaml` starter
```yaml
version: "1.0"
steps:
  security:
    type: ai
    schema: code-review
    prompt: "Identify security vulnerabilities in changed files"
```

- Fast local pre-commit hook (Husky)
```bash
npx husky add .husky/pre-commit "npx -y @probelabs/visor@latest --tags local,fast --output table || exit 1"
```

- More examples
  - docs/NPM_USAGE.md – CLI usage and flags
  - GITHUB_CHECKS.md – Checks, outputs, and workflow integration
  - examples/ – MCP, Jira, and advanced configs
