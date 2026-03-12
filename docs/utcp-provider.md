# UTCP Provider

The UTCP (Universal Tool Calling Protocol) provider lets you call external tools directly via their native protocols (HTTP, CLI, SSE) without intermediate servers. Tools publish JSON "manuals" that describe how to call them, and the UTCP client makes direct calls.

Unlike MCP which requires a running server process, UTCP is a **client-side protocol** — the client reads a tool's manual and calls the tool's real API directly.

## Quick Start

```yaml
steps:
  api-check:
    type: utcp
    manual: https://api.example.com/utcp
    method: analyze
    methodArgs:
      files: "{{ files | map: 'filename' | join: ',' }}"
```

## Prerequisites

Install the UTCP SDK:

```bash
npm install @utcp/sdk @utcp/http
```

The SDK is an optional dependency — the provider gracefully handles its absence.

## Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"utcp"` | Yes | — | Provider type |
| `manual` | `string \| object` | Yes | — | Manual source: URL, file path, or inline call template |
| `method` | `string` | Yes | — | Tool name to call |
| `methodArgs` | `object` | No | `{}` | Arguments to pass (supports Liquid templates) |
| `argsTransform` | `string` | No | — | Liquid template that produces JSON args (overrides `methodArgs`) |
| `variables` | `object` | No | `{}` | UTCP variables for authentication/config |
| `plugins` | `string[]` | No | `["http"]` | UTCP plugins to load |
| `transform` | `string` | No | — | Liquid template to transform output |
| `transform_js` | `string` | No | — | JavaScript expression to transform output |
| `timeout` | `number` | No | `60` | Timeout in seconds |

## Manual Sources

The `manual` field supports three formats:

### URL Discovery

Point to a URL that returns a UTCP manual or OpenAPI spec. The provider creates an HTTP call template automatically:

```yaml
steps:
  petstore:
    type: utcp
    manual: https://petstore3.swagger.io/api/v3/openapi.json
    method: findPetsByStatus
    methodArgs:
      status: available
```

### File-Based Manual

Point to a local JSON file containing a UTCP manual:

```yaml
steps:
  local-tool:
    type: utcp
    manual: ./tools/my-manual.json
    method: analyze
```

Example manual file:

```json
{
  "utcp_version": "1.0.0",
  "manual_version": "1.0.0",
  "tools": [
    {
      "name": "analyze",
      "description": "Analyze code for issues",
      "inputs": {
        "type": "object",
        "properties": {
          "code": { "type": "string", "description": "Code to analyze" }
        }
      },
      "tool_call_template": {
        "call_template_type": "http",
        "url": "https://api.example.com/analyze",
        "http_method": "POST"
      }
    }
  ]
}
```

### Inline Call Template

Define the call template directly in the config:

```yaml
steps:
  inline-check:
    type: utcp
    manual:
      call_template_type: http
      url: https://api.example.com/utcp
      http_method: GET
    method: check
```

## Tool Name Resolution

The provider supports flexible tool name matching:

- **Exact match**: `method: manual_name.tool_name` — matches the fully qualified name
- **Suffix match**: `method: tool_name` — automatically resolves to `manual_name.tool_name`

This means you can use short names like `get_ip` instead of `httpbin.get_ip`.

## Liquid Templates in Arguments

Method arguments support Liquid templates for dynamic values:

```yaml
steps:
  scan:
    type: utcp
    manual: https://scanner.example.com/utcp
    method: scan_code
    methodArgs:
      files: "{{ files | map: 'filename' | join: ',' }}"
      pr_title: "{{ pr.title }}"
      branch: "{{ pr.branch }}"
```

## Variables

Pass authentication tokens or configuration via `variables`:

```yaml
steps:
  secure-scan:
    type: utcp
    manual: https://scanner.example.com/utcp
    method: scan
    variables:
      API_KEY: "${SCANNER_API_KEY}"
      WORKSPACE: "${GITHUB_WORKSPACE}"
```

Variables are resolved through the environment resolver, supporting `${ENV_VAR}` syntax.

## Output Transforms

### Liquid Transform

```yaml
steps:
  check:
    type: utcp
    manual: ./tools/manual.json
    method: analyze
    transform: |
      {% assign results = output.findings %}
      {{ results | json }}
```

### JavaScript Transform

```yaml
steps:
  check:
    type: utcp
    manual: ./tools/manual.json
    method: analyze
    transform_js: |
      return output.results.map(r => ({
        file: r.file,
        line: r.line,
        message: r.msg,
        severity: 'warning',
        category: 'logic',
        ruleId: 'utcp/' + r.rule
      }));
```

## Issue Extraction

The provider automatically extracts issues from structured output. If the tool returns data matching the Visor issue format, issues are detected automatically:

```json
{
  "issues": [
    {
      "file": "src/index.ts",
      "line": 42,
      "message": "Potential null dereference",
      "severity": "warning",
      "category": "logic",
      "ruleId": "null-check"
    }
  ]
}
```

Supported field aliases:
- **message**: `message`, `text`, `description`, `summary`
- **severity**: `severity`, `level`, `priority`
- **file**: `file`, `path`, `filename`
- **line**: `line`, `startLine`, `lineNumber`

## UTCP vs MCP

| Feature | UTCP | MCP |
|---------|------|-----|
| **Architecture** | Client-side, no server needed | Requires running server process |
| **Transport** | Direct HTTP/CLI/SSE calls | stdio, SSE, or HTTP to MCP server |
| **Discovery** | JSON manuals at URLs or files | Server advertises tools |
| **Tool calls** | Client calls tool's real API | Client calls MCP server, server calls tool |
| **Best for** | REST APIs, CLI tools, public APIs | Complex tool servers, stateful tools |

## Examples

### Call a REST API

```yaml
steps:
  get-weather:
    type: utcp
    manual:
      name: weather
      call_template_type: http
      url: https://api.weather.com/v1
      http_method: GET
    method: get_forecast
    methodArgs:
      city: "San Francisco"
    variables:
      API_KEY: "${WEATHER_API_KEY}"
```

### Chain with Other Steps

```yaml
steps:
  fetch-data:
    type: utcp
    manual: ./tools/data-api.json
    method: get_metrics

  analyze:
    type: ai
    depends_on: [fetch-data]
    prompt: |
      Analyze these metrics:
      {{ outputs["fetch-data"] | json }}
```

### With Dependency Results

```yaml
steps:
  lint:
    type: command
    exec: npm run lint -- --format json

  external-scan:
    type: utcp
    manual: https://scanner.example.com/utcp
    method: deep_scan
    depends_on: [lint]
    methodArgs:
      lint_results: "{{ outputs['lint'] | json }}"
```

## Troubleshooting

### "Tool not found in the repository"
The method name doesn't match any discovered tool. Use `--debug` to see available tools, then check your `method` value matches.

### "@utcp/sdk not available"
Install the SDK: `npm install @utcp/sdk @utcp/http`

### "Invalid CallTemplate object"
The manual file format is incorrect. Ensure it's either a valid UTCP manual (with `utcp_version` and `tools`) or a call template (with `call_template_type`).

### Timeout errors
Increase the `timeout` value or check network connectivity to the tool endpoint.

## Learn More

- [UTCP Specification](https://utcp.io)
- [UTCP TypeScript SDK](https://github.com/anthropics/utcp-spec)
- [Example Configurations](../examples/utcp-provider-example.yaml)
- [Pluggable Architecture](./pluggable.md)
- [MCP Provider](./mcp-provider.md) (comparison)
