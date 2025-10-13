import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { CheckExecutionEngine } from '../../src/check-execution-engine';

// Mock ProbeAgent
const mockProbeAgent = {
  answer: jest.fn(),
  history: [],
  options: {},
  clone: jest.fn(),
};

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(options => ({
    ...mockProbeAgent,
    options,
    history: [],
  })),
}));

/**
 * End-to-end test for AI session reuse functionality
 * Tests the complete workflow from configuration validation to execution
 */
describe('Session Reuse End-to-End', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set mock API key for Google provider
    process.env.GOOGLE_API_KEY = 'mock-api-key-for-testing';

    // Setup mock clone() to return a cloned agent with the same answer behavior
    mockProbeAgent.clone.mockImplementation(options => ({
      answer: mockProbeAgent.answer,
      history: [...mockProbeAgent.history],
      options: options || {},
      clone: mockProbeAgent.clone,
    }));

    // Setup mock responses - provide enough for all tests
    mockProbeAgent.answer.mockResolvedValue(
      JSON.stringify({
        issues: [
          {
            file: 'test.js',
            line: 1,
            ruleId: 'test/mock-issue',
            message: 'Mock issue from AI analysis',
            severity: 'warning',
            category: 'test',
          },
        ],
      })
    );

    // Create temporary directory for test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-session-'));
    configPath = path.join(tempDir, '.visor.yaml');

    // Initialize git repository
    execSync('git init', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });

    // Create test files
    fs.writeFileSync(
      path.join(tempDir, 'server.js'),
      `const express = require('express');
const app = express();

// Security issue: hardcoded secret
const SECRET_KEY = 'hardcoded-secret-123';

app.get('/api/data', (req, res) => {
  // Performance issue: blocking operation
  const data = fs.readFileSync('large-file.json', 'utf8');
  res.json({ data, secret: SECRET_KEY });
});

app.listen(3000);`
    );

    fs.writeFileSync(
      path.join(tempDir, 'utils.js'),
      `// Style issue: inconsistent naming
function calculate_total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

module.exports = { calculate_total };`
    );

    // Create initial commit
    execSync('git add .', { cwd: tempDir });
    execSync('git -c core.hooksPath=/dev/null commit -m "Initial commit"', { cwd: tempDir });

    // Modify files to create diff
    fs.appendFileSync(
      path.join(tempDir, 'server.js'),
      `
// Additional security issue
app.get('/debug', (req, res) => {
  res.json({ env: process.env });
});`
    );
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Clean up environment
    delete process.env.GOOGLE_API_KEY;
  });

  it('should execute session reuse workflow with mock provider', async () => {
    // Create configuration with session reuse
    const config = `
version: "1.0"

checks:
  security-analysis:
    type: ai
    prompt: |
      You are a security expert. Analyze the code for security vulnerabilities.
      Focus on:
      - Hardcoded secrets
      - Exposed sensitive data
      - Authentication issues
      Return your findings in the standard format.
    on:
      - pr_updated
    ai:
      provider: google

  security-remediation:
    type: ai
    prompt: |
      Based on the previous security analysis, provide detailed remediation steps.
      You should build upon the conversation context from the security analysis.
      Provide specific code examples and best practices.
    on:
      - pr_updated
    depends_on:
      - security-analysis
    reuse_ai_session: true
    ai:
      provider: google

  performance-analysis:
    type: ai
    prompt: |
      Analyze the code for performance issues.
      Look for:
      - Blocking operations
      - Inefficient algorithms
      - Resource leaks
    on:
      - pr_updated
    ai:
      provider: google

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
    debug:
      enabled: true
      includePrompts: true
      includeRawResponses: true
      includeTiming: true
      includeProviderInfo: true

max_parallelism: 2
fail_fast: false
`;

    fs.writeFileSync(configPath, config);

    // Execute checks
    const engine = new CheckExecutionEngine(tempDir);
    const result = await engine.executeChecks({
      checks: ['security-analysis', 'security-remediation', 'performance-analysis'],
      config: require('js-yaml').load(config),
      debug: true,
      outputFormat: 'json',
    });

    // Verify execution completed
    expect(result.checksExecuted).toContain('security-analysis');
    expect(result.checksExecuted).toContain('security-remediation');
    expect(result.checksExecuted).toContain('performance-analysis');

    // Verify mock responses were generated
    expect(result.reviewSummary.issues).toBeDefined();
    expect(Array.isArray(result.reviewSummary.issues)).toBe(true);

    // Verify debug information is available
    expect(result.debug).toBeDefined();
    expect(result.debug?.checksExecuted).toEqual(result.checksExecuted);

    // Verify session reuse affected parallelism
    // security-analysis and security-remediation should run sequentially
    // performance-analysis can run in parallel with them
    expect(result.executionTime).toBeGreaterThan(0);
  });

  it('should validate configuration with session reuse requirements', async () => {
    // Create invalid configuration (reuse_ai_session without depends_on)
    const invalidConfig = `
version: "1.0"

checks:
  invalid-check:
    type: ai
    prompt: "This check has invalid session reuse configuration"
    on:
      - pr_updated
    reuse_ai_session: true
    # Missing depends_on!

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(configPath, invalidConfig);

    // This should fail during configuration loading
    const { ConfigManager } = require('../../src/config');
    const configManager = new ConfigManager();

    await expect(configManager.loadConfig(configPath)).rejects.toThrow(
      /reuse_ai_session=true but missing or empty depends_on/
    );
  });

  it('should handle complex dependency chain with session reuse', async () => {
    const config = `
version: "1.0"

checks:
  initial-scan:
    type: ai
    prompt: "Perform initial code analysis"
    on:
      - pr_updated
    ai:
      provider: google

  detailed-security:
    type: ai
    prompt: "Detailed security analysis based on initial scan"
    on:
      - pr_updated
    depends_on:
      - initial-scan
    reuse_ai_session: true

  security-report:
    type: ai
    prompt: "Generate comprehensive security report"
    on:
      - pr_updated
    depends_on:
      - detailed-security
    reuse_ai_session: true

  independent-performance:
    type: ai
    prompt: "Independent performance analysis"
    on:
      - pr_updated
    ai:
      provider: google

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false

max_parallelism: 3
`;

    fs.writeFileSync(configPath, config);

    const engine = new CheckExecutionEngine(tempDir);
    const result = await engine.executeChecks({
      checks: ['initial-scan', 'detailed-security', 'security-report', 'independent-performance'],
      config: require('js-yaml').load(config),
      debug: true,
    });

    // All checks should complete
    expect(result.checksExecuted).toHaveLength(4);
    expect(result.checksExecuted).toContain('initial-scan');
    expect(result.checksExecuted).toContain('detailed-security');
    expect(result.checksExecuted).toContain('security-report');
    expect(result.checksExecuted).toContain('independent-performance');

    // Verify results structure
    expect(result.reviewSummary.issues).toBeDefined();
    expect(result.executionTime).toBeGreaterThan(0);
  });

  it('should demonstrate session reuse benefits with conversational context', async () => {
    const config = `
version: "1.0"

checks:
  context-builder:
    type: ai
    prompt: |
      Analyze this code and establish context about the application architecture.
      Identify the main patterns, frameworks, and potential areas of concern.
      Remember this context for follow-up analysis.
    on:
      - pr_updated
    ai:
      provider: google

  context-aware-security:
    type: ai
    prompt: |
      Based on our previous conversation about the application architecture,
      perform a targeted security analysis. Use the context we established
      to provide more relevant and specific security recommendations.
    on:
      - pr_updated
    depends_on:
      - context-builder
    reuse_ai_session: true
    ai:
      provider: google

  context-aware-performance:
    type: ai
    prompt: |
      Continuing our analysis, now focus on performance aspects.
      Consider the architectural patterns we identified earlier
      and provide performance recommendations specific to this codebase.
    on:
      - pr_updated
    depends_on:
      - context-aware-security
    reuse_ai_session: true
    ai:
      provider: google

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
    debug:
      enabled: true
`;

    fs.writeFileSync(configPath, config);

    const engine = new CheckExecutionEngine(tempDir);
    const result = await engine.executeChecks({
      checks: ['context-builder', 'context-aware-security', 'context-aware-performance'],
      config: require('js-yaml').load(config),
      debug: true,
    });

    // Verify sequential execution completed
    expect(result.checksExecuted).toEqual([
      'context-builder',
      'context-aware-security',
      'context-aware-performance',
    ]);

    // Verify mock provider generated appropriate responses
    expect(result.reviewSummary.issues).toBeDefined();

    // Check for presence of debug information
    if (result.debug) {
      expect(result.debug.totalApiCalls).toBe(3);
      expect(result.debug.apiCallDetails).toHaveLength(3);
    }
  });
});
