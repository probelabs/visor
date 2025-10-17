## 🔧 Pluggable Architecture

Visor supports multiple provider types (ai, http, http_client, log, command, claude-code). You can also add custom providers.

### Custom Provider Skeleton (TypeScript)

```ts
class CustomCheckProvider {
  name = 'custom';
  async run(input) {
    // ... implement your logic
    return { issues: [] };
  }
}
```

