# Using Visor via npm/npx

## Quick Start (No Installation Required)

Run Visor directly using npx:

```bash
npx -y @probelabs/visor@latest --help
```

## Global Installation

Install globally for frequent use:

```bash
npm install -g @probelabs/visor
```

Then use the `visor` command:

```bash
visor --check all --output table
```

## Local Project Installation

Add to your project as a dev dependency:

```bash
npm install --save-dev @probelabs/visor
```

Add to your package.json scripts:

```json
{
  "scripts": {
    "review": "visor --check all",
    "review:security": "visor --check security --output json"
  }
}
```

## Usage Examples

### Validate configuration
```bash
# Validate config in current directory (searches for .visor.yaml)
npx -y @probelabs/visor validate

# Validate specific config file
npx -y @probelabs/visor validate --config .visor.yaml

# Validate before committing
npx -y @probelabs/visor validate --config examples/my-config.yaml
```

The `validate` command checks your configuration for:
- Missing required fields (e.g., `version`)
- Invalid check types or event triggers
- Incorrect field names and values
- Schema compliance

It provides detailed error messages with helpful hints to fix issues.

### Run all checks
```bash
npx -y @probelabs/visor@latest --check all
```

### Security check with JSON output
```bash
npx -y @probelabs/visor@latest --check security --output json
```

### Multiple checks with custom config
```bash
npx -y @probelabs/visor@latest --check performance --check architecture --config .visor.yaml
```

### Generate SARIF report for CI/CD
```bash
npx -y @probelabs/visor@latest --check security --output sarif --output-file results.sarif
```

### Save JSON to a file (recommended)
```bash
npx -y @probelabs/visor@latest --check all --output json --output-file visor-results.json
```

## Configuration

Create a `.visor.yaml` file in your project root:

```yaml
project:
  name: my-project
  language: typescript

checks:
  - type: ai
    prompt: security
    
  - type: ai
    prompt: performance
    
output:
  format: table
  verbose: false
```

## Environment Variables

Set API keys for AI-powered reviews:

```bash
export GOOGLE_API_KEY=your-key-here
# or
export ANTHROPIC_API_KEY=your-key-here
# or
export OPENAI_API_KEY=your-key-here
```

## CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
- name: Run Visor Code Review
  run: npx -y @probelabs/visor@latest --check all --output markdown
  env:
    GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```
