## 🎯 GitHub Action Reference

### Inputs (selected)

| Input | Description | Default |
|-------|-------------|---------|
| `max-parallelism` | Maximum number of checks in parallel | `3` |
| `fail-fast` | Stop on first failure | `false` |
| `config-path` | Path to config file | `.visor.yaml` |

### Outputs (selected)

| Output | Description |
|--------|-------------|
| `issues-found` | Total number of issues found |
| `critical-issues` | Number of critical issues |

See README Quick Start for minimal workflow. For full list, open `action.yml`.

