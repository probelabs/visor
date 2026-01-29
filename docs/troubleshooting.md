# Troubleshooting

This guide covers common issues and their solutions when using Visor.

For in-depth debugging techniques including JavaScript expression debugging, Liquid template inspection, and OpenTelemetry tracing, see the [Debugging Guide](./debugging.md).

## Quick Diagnostics

```bash
# Enable debug mode for detailed output
visor --check all --debug

# Validate configuration before running
visor validate --config .visor.yaml
```

## Common Issues

### Configuration Not Found

**Symptoms**: Visor runs but uses default configuration instead of your custom config.

**Solutions**:
1. Ensure your config file is named `.visor.yaml` (with leading dot) in the project root
2. Explicitly specify the config path: `visor --config path/to/.visor.yaml`
3. Check for YAML syntax errors: `visor validate --config .visor.yaml`

### GitHub Check Runs Not Appearing

**Symptoms**: PR comments work but GitHub Check runs are missing.

**Solutions**:
1. Verify workflow permissions include `checks: write`:
   ```yaml
   permissions:
     contents: read
     pull-requests: write
     issues: write
     checks: write
   ```
2. For fork PRs, check runs require `pull_request_target` trigger - see [Fork PR Support](./GITHUB_CHECKS.md#fork-pr-support)
3. Ensure `create-check: 'true'` in action inputs (default)
4. Check action logs for permission errors (403)

### Annotations Not Appearing on Files

**Symptoms**: Check runs exist but no inline annotations on PR files.

**Solutions**:
1. Confirm the check uses `schema: code-review`
2. Ensure issues include `file` and `line` properties
3. Verify the file paths match the PR diff (relative paths from repo root)

### AI Provider Errors

**Symptoms**: Checks fail with API errors or return no results.

**Solutions**:
1. Verify API key is set correctly:
   - `GOOGLE_API_KEY` for Gemini
   - `ANTHROPIC_API_KEY` for Claude
   - `OPENAI_API_KEY` for OpenAI
2. Check API key permissions and quotas
3. Enable debug mode to see full API responses: `--debug`
4. For rate limiting, reduce `--max-parallelism` or add delays between checks

### Fork PR Permission Errors (403)

**Symptoms**: `Resource not accessible by integration` errors for fork PRs.

**Cause**: GitHub restricts write permissions for workflows triggered by fork PRs.

**Solutions**:
1. **Accept comment-only mode**: Visor automatically falls back to PR comments
2. **Enable full fork support**: Use `pull_request_target` trigger (see [GITHUB_CHECKS.md](./GITHUB_CHECKS.md#fork-pr-support))

### Remote Extends Not Loading

**Symptoms**: Configuration fails to load remote URLs in `extends` field.

**Solutions**:
1. Allow specific URL patterns: `--allowed-remote-patterns "https://github.com/,https://raw.githubusercontent.com/"`
2. Or disable remote extends entirely: `--no-remote-extends`
3. Check network connectivity and URL accessibility

### Timeout Errors

**Symptoms**: Checks fail with timeout messages.

**Solutions**:
1. Increase timeout: `--timeout 300000` (5 minutes in ms)
2. Reduce check complexity or split into smaller checks
3. Check for slow network or API responses
4. See [Timeouts Guide](./timeouts.md) for detailed configuration

### Output Access Issues in Checks

**Symptoms**: `outputs is undefined` or `Cannot read property` errors.

**Solutions**:
1. Ensure `depends_on` is set for checks that need outputs from other checks:
   ```yaml
   steps:
     my-check:
       type: command
       depends_on: [previous-check]  # Required to access outputs
       exec: echo "{{ outputs['previous-check'] }}"
   ```
2. Use optional chaining for safe access: `outputs?.['check-name']?.property`
3. Debug output structure with the `log()` function - see [Debugging Guide](./debugging.md#debugging-javascript-expressions)

### forEach Not Iterating

**Symptoms**: Check with `forEach: true` runs once instead of iterating.

**Solutions**:
1. Ensure the output is an array (not a single object)
2. Use `transform_js` to convert output to array format if needed
3. Debug with `log()` to inspect the actual output structure

## GitHub Actions Permissions

Required permissions for full functionality:

```yaml
permissions:
  contents: read        # Read repository content
  pull-requests: write  # Post PR comments
  issues: write         # Post issue comments
  checks: write         # Create check runs and annotations
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `VISOR_TELEMETRY_ENABLED` | Enable OpenTelemetry tracing |
| `VISOR_TELEMETRY_SINK` | Trace output: `file`, `otlp`, or `console` |
| `DEBUG=1` or `VERBOSE=1` | Enable verbose internal logging |
| `VISOR_NOBROWSER=true` | Skip auto-opening browser (CI/headless) |

## Increasing Verbosity

Different verbosity levels for troubleshooting:

```bash
# Standard verbose mode
visor --check all --verbose

# Full debug mode (includes AI interactions)
visor --check all --debug

# Debug mode in GitHub Action
- uses: probelabs/visor@v1
  with:
    debug: 'true'
```

## Validating Configuration

Always validate your configuration before running:

```bash
# Validate config syntax and schema
visor validate --config .visor.yaml

# Test locally with a specific check
visor --check security --config .visor.yaml --output table
```

## Further Reading

- [Debugging Guide](./debugging.md) - Comprehensive debugging techniques
- [Configuration Reference](./configuration.md) - Full configuration options
- [GitHub Checks Integration](./GITHUB_CHECKS.md) - Check runs and annotations
- [Telemetry Setup](./telemetry-setup.md) - OpenTelemetry tracing
- [Timeouts Guide](./timeouts.md) - Timeout configuration
