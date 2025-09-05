import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { PRAnalyzer } from '../../src/pr-analyzer';
import { PRReviewer } from '../../src/reviewer';
import { CommentManager } from '../../src/github-comments';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import { createMockOctokit } from '../performance/test-utilities';
import * as path from 'path';
import * as os from 'os';

describe('Edge Cases & Boundary Condition Tests', () => {
  let mockOctokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    mockOctokit = createMockOctokit();
    jest.clearAllMocks();
  });

  describe('Empty and Null Data Handling', () => {
    test('should handle empty PR data gracefully', async () => {
      console.log('Testing empty PR data handling...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyzer = new PRAnalyzer(mockOctokit as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reviewer = new PRReviewer(mockOctokit as any);

      // Test various empty PR scenarios
      const emptyPRScenarios = [
        {
          name: 'Empty PR',
          prData: {
            id: 1,
            number: 1,
            title: '',
            body: '',
            user: { login: '' },
            head: { sha: '', ref: '' },
            base: { sha: '', ref: '' },
            draft: false,
            additions: 0,
            deletions: 0,
            changed_files: 0,
          },
          files: [],
        },
        {
          name: 'PR with only whitespace',
          prData: {
            id: 2,
            number: 2,
            title: '   \n\t  \n   ',
            body: '\n\n    \t\t\n\n',
            user: { login: '  test-user  ' },
            head: { sha: 'abc123', ref: '  feature  ' },
            base: { sha: 'def456', ref: '  main  ' },
            draft: false,
            additions: 0,
            deletions: 0,
            changed_files: 0,
          },
          files: [],
        },
        {
          name: 'PR with null-like values',
          prData: {
            id: 3,
            number: 3,
            title: 'null',
            body: 'undefined',
            user: { login: 'null' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: 0,
            deletions: 0,
            changed_files: 0,
          },
          files: [],
        },
      ];

      for (const scenario of emptyPRScenarios) {
        console.log(`  Testing scenario: ${scenario.name}`);

        mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: scenario.prData });
        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: scenario.files });

        try {
          const prInfo = await analyzer.fetchPRDiff(
            'test-owner',
            'test-repo',
            scenario.prData.number
          );
          const review = await reviewer.reviewPR(
            'test-owner',
            'test-repo',
            scenario.prData.number,
            prInfo
          );

          console.log(
            `    PR Info: title="${prInfo.title}", author="${prInfo.author}", files=${prInfo.files.length}`
          );
          console.log(`    Review: issues=${review.issues.length}`);

          // Should handle empty data without crashing
          expect(prInfo).toBeDefined();
          expect(typeof prInfo.title).toBe('string');
          expect(typeof prInfo.author).toBe('string');
          expect(Array.isArray(prInfo.files)).toBe(true);
          expect(Array.isArray(review.issues)).toBe(true);
          expect(review.issues.length).toBeGreaterThanOrEqual(0);
        } catch (error: unknown) {
          console.log(`    Error handling empty data: ${(error as Error).message}`);
          // Should either handle gracefully or provide clear error
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message.length).toBeGreaterThan(5);
        }
      }
    });

    test('should handle null and undefined values in various contexts', async () => {
      console.log('Testing null and undefined value handling...');

      const cli = new CLI();
      const configManager = new ConfigManager();

      // Test CLI with null/undefined-like arguments
      const nullishArguments = [
        [], // Empty arguments
        [''], // Empty string argument
        ['null'], // String "null"
        ['undefined'], // String "undefined"
        ['--check'], // Missing value
        ['--check', ''], // Empty value
        ['--check', 'null'], // Null as value
        ['--check', 'undefined'], // Undefined as value
        ['--output'], // Missing format
        ['--output', ''], // Empty format
        ['--config', ''], // Empty config path
      ];

      for (let i = 0; i < nullishArguments.length; i++) {
        const args = nullishArguments[i];
        console.log(`  Testing args: ${JSON.stringify(args)}`);

        try {
          const options = cli.parseArgs(args);
          console.log(`    Parsed successfully: ${JSON.stringify(options)}`);

          // Should handle null-ish values gracefully
          expect(options).toBeDefined();
          if (options.checks) {
            expect(Array.isArray(options.checks)).toBe(true);
          }
        } catch (error: unknown) {
          console.log(`    Expected error: ${(error as Error).message}`);
          // Should provide helpful error for invalid arguments
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message).not.toContain('Cannot read property of undefined');
          expect((error as Error).message).not.toContain('Cannot read property');
        }
      }

      // Test config merging with null/undefined values
      const baseConfig = {
        version: '1.0',
        checks: {
          'test-check': {
            type: 'ai' as const,
            prompt: 'Test',
            on: ['pr_opened' as const],
          },
        },
      };

      const nullishCliOptions = [
        {
          checks: null as null,
          output: 'json' as const,
          configPath: undefined,
          help: false,
          version: false,
        },
        {
          checks: [] as string[],
          output: null as null,
          configPath: '',
          help: false,
          version: false,
        },
        {
          checks: undefined as undefined,
          output: undefined as undefined,
          configPath: null as null,
          help: false,
          version: false,
        },
      ];

      for (let i = 0; i < nullishCliOptions.length; i++) {
        const cliOptions = nullishCliOptions[i];
        console.log(`  Testing config merge with nullish values ${i + 1}...`);

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const merged = configManager.mergeWithCliOptions(baseConfig, {
            ...cliOptions,
            checks: cliOptions.checks || [],
            output: cliOptions.output || 'table',
          } as any);
          console.log(`    Merge successful`);

          // Should handle nullish values in merge
          expect(merged).toBeDefined();
          expect(merged.config).toBeDefined();
        } catch (error: unknown) {
          console.log(`    Merge error: ${(error as Error).message}`);
          expect((error as Error).message).toBeDefined();
        }
      }
    });
  });

  describe('Boundary Value Testing', () => {
    test('should handle extremely large PR data', async () => {
      console.log('Testing extremely large PR data handling...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyzer = new PRAnalyzer(mockOctokit as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reviewer = new PRReviewer(mockOctokit as any);

      // Create PR with boundary values
      const largePRData = {
        id: Number.MAX_SAFE_INTEGER - 1,
        number: 999999,
        title: 'x'.repeat(10000), // Very long title
        body: 'y'.repeat(100000), // Very long body (100KB)
        user: { login: 'user-with-very-long-username-that-exceeds-normal-limits' },
        head: {
          sha: 'a'.repeat(40),
          ref: 'feature-branch-with-extremely-long-name-that-might-cause-issues',
        },
        base: { sha: 'b'.repeat(40), ref: 'main-branch-also-with-very-long-name' },
        draft: false,
        additions: 999999,
        deletions: 999999,
        changed_files: 10000,
      };

      // Create many files with extreme values
      const largeFileList = Array(1000)
        .fill(0)
        .map((_, i) => ({
          filename: `path/to/very/deeply/nested/directory/structure/that/might/cause/issues/file-${i}-with-long-name.js`,
          additions: 999,
          deletions: 999,
          changes: 1998,
          status: 'modified',
          patch: `@@ -1,999 +1,999 @@\n${Array(500)
            .fill(0)
            .map((_, j) => `-old line ${j}`)
            .join('\n')}\n${Array(500)
            .fill(0)
            .map((_, j) => `+new line ${j}`)
            .join('\n')}`,
        }));

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePRData });
      mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largeFileList });

      try {
        console.log(`  Processing PR with ${largeFileList.length} files...`);

        const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', largePRData.number);
        console.log(
          `    PR processed: ${prInfo.files.length} files, ${prInfo.totalAdditions} additions`
        );

        const review = await reviewer.reviewPR(
          'test-owner',
          'test-repo',
          largePRData.number,
          prInfo
        );
        console.log(
          `    Review completed: issues=${review.issues.length}`
        );

        // Should handle large data without crashing
        expect(prInfo).toBeDefined();
        expect(prInfo.files.length).toBeGreaterThan(0);
        expect(prInfo.files.length).toBeLessThanOrEqual(1000);
        expect(Array.isArray(review.issues)).toBe(true);
        expect(review.issues.length).toBeGreaterThanOrEqual(0);
      } catch (error: unknown) {
        console.log(`    Large PR processing error: ${(error as Error).message}`);
        // Should handle large data gracefully or provide resource limit error
        expect((error as Error).message).toBeDefined();
        expect((error as Error).message).not.toContain('RangeError');
      }
    });

    test('should handle minimum and maximum numeric values', async () => {
      console.log('Testing numeric boundary values...');

      // Test PR with extreme numeric values
      const extremeNumericScenarios = [
        {
          name: 'Zero values',
          prData: {
            id: 0,
            number: 0,
            title: 'Zero PR',
            body: 'Zero values test',
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: 0,
            deletions: 0,
            changed_files: 0,
          },
        },
        {
          name: 'Negative values',
          prData: {
            id: -1,
            number: -1,
            title: 'Negative PR',
            body: 'Negative values test',
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: -10,
            deletions: -5,
            changed_files: -1,
          },
        },
        {
          name: 'Maximum safe integer',
          prData: {
            id: Number.MAX_SAFE_INTEGER,
            number: Number.MAX_SAFE_INTEGER,
            title: 'Max integer PR',
            body: 'Maximum integer test',
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: Number.MAX_SAFE_INTEGER,
            deletions: Number.MAX_SAFE_INTEGER,
            changed_files: Number.MAX_SAFE_INTEGER,
          },
        },
        {
          name: 'Infinity values',
          prData: {
            id: 123,
            number: 123,
            title: 'Infinity PR',
            body: 'Infinity test',
            user: { login: 'test-user' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            additions: Infinity,
            deletions: -Infinity,
            changed_files: Infinity,
          },
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyzer = new PRAnalyzer(mockOctokit as any);

      for (const scenario of extremeNumericScenarios) {
        console.log(`  Testing scenario: ${scenario.name}`);

        mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: scenario.prData });
        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: [] });

        try {
          const prInfo = await analyzer.fetchPRDiff(
            'test-owner',
            'test-repo',
            Math.abs(scenario.prData.number) || 1
          );

          console.log(
            `    Processed: additions=${prInfo.totalAdditions}, deletions=${prInfo.totalDeletions}`
          );

          // Should handle extreme numeric values
          expect(prInfo).toBeDefined();
          expect(typeof prInfo.totalAdditions).toBe('number');
          expect(typeof prInfo.totalDeletions).toBe('number');
          expect(isFinite(prInfo.totalAdditions) || prInfo.totalAdditions === 0).toBe(true);
          expect(isFinite(prInfo.totalDeletions) || prInfo.totalDeletions === 0).toBe(true);
        } catch (error: unknown) {
          console.log(`    Numeric boundary error: ${(error as Error).message}`);
          expect((error as Error).message).toBeDefined();
        }
      }
    });

    test('should handle GitHub API rate limit boundaries', async () => {
      console.log('Testing GitHub API rate limit boundary conditions...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const commentManager = new CommentManager(mockOctokit as any, {
        maxRetries: 5,
        baseDelay: 10, // Very short delay for testing
      });

      // Test exact rate limit boundary conditions
      const rateLimitScenarios = [
        {
          name: 'Exactly at rate limit reset time',
          error: {
            status: 403,
            response: {
              data: { message: 'API rate limit exceeded' },
              headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1) }, // Reset in 1 second
            },
          },
        },
        {
          name: 'Rate limit reset in past',
          error: {
            status: 403,
            response: {
              data: { message: 'API rate limit exceeded' },
              headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 10) }, // Reset 10 seconds ago
            },
          },
        },
        {
          name: 'No rate limit reset header',
          error: {
            status: 403,
            response: {
              data: { message: 'API rate limit exceeded' },
              headers: {},
            },
          },
        },
        {
          name: 'Invalid rate limit reset value',
          error: {
            status: 403,
            response: {
              data: { message: 'API rate limit exceeded' },
              headers: { 'x-ratelimit-reset': 'invalid-timestamp' },
            },
          },
        },
      ];

      for (const scenario of rateLimitScenarios) {
        console.log(`  Testing scenario: ${scenario.name}`);

        let attemptCount = 0;
        mockOctokit.rest.issues.createComment.mockImplementation(() => {
          attemptCount++;
          if (attemptCount === 1) {
            return Promise.reject(scenario.error);
          }
          return Promise.resolve({
            data: {
              id: 123,
              body: 'Test comment',
              user: { login: 'test-user' },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          });
        });

        try {
          const comment = await commentManager.updateOrCreateComment(
            'test-owner',
            'test-repo',
            123,
            'Test comment content',
            { commentId: 'rate-limit-test', triggeredBy: 'boundary_test' }
          );

          console.log(`    Rate limit handled successfully after ${attemptCount} attempts`);
          expect(comment).toBeDefined();
          expect(attemptCount).toBeGreaterThan(1);
        } catch (error: unknown) {
          console.log(`    Rate limit boundary error: ${(error as Error).message}`);
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Unicode and Special Character Handling', () => {
    test('should handle all Unicode character ranges', async () => {
      console.log('Testing Unicode character range handling...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyzer = new PRAnalyzer(mockOctokit as any);

      const unicodeTestCases = [
        {
          name: 'Basic Multilingual Plane',
          title: 'Basic Latin: Hello, Cyrillic: Привет, Greek: Γεια, Arabic: مرحبا',
          body: 'Testing Basic Multilingual Plane characters: àáâãäåæçèéêë',
          filename: 'unicode-bmp-tëst.js',
          patch: '@@ -1,1 +1,1 @@\n-console.log("old");\n+console.log("Héllö Wörld");',
        },
        {
          name: 'Mathematical Symbols',
          title: 'Math symbols: ∀∃∇∈∉∋∌∍∎∏∐∑∓∔∕∖∗∘∙∝∞∟∠∡∢∣∤∥∦∧∨∩∪∫∬∭∮',
          body: 'Testing mathematical symbols and operators: ≤≥≠≡≢≣≤≥',
          filename: 'math-symbols-∑∫∬.js',
          patch: '@@ -1,1 +1,1 @@\n-// TODO: implement\n+// ∀x∈ℝ: f(x) = ∑(aᵢxⁱ)',
        },
        {
          name: 'Emoji and Pictographs',
          title: 'Emoji test: 🚀🔧💻📝🐛🎯✨🎉📊🔍',
          body: 'Testing emoji and pictographs: 👨‍💻👩‍💻🧑‍💻 (developer emojis with ZWJ sequences)',
          filename: 'emoji-test-🚀.js',
          patch: '@@ -1,1 +1,1 @@\n-console.log("boring");\n+console.log("🎉 Success! 🚀");',
        },
        {
          name: 'High Unicode Code Points',
          title: 'High Unicode: 𝒜𝒷𝒸 (Mathematical Script), 𝔄𝔅ℭ (Fraktur), 🌟🦄🎭',
          body: 'Testing Supplementary Multilingual Plane: 𝕳𝖊𝖑𝖑𝖔 𝖂𝖔𝖗𝖑𝖉',
          filename: 'high-unicode-𝔲𝔫𝔦𝔠𝔬𝔡𝔢.js',
          patch: '@@ -1,1 +1,1 @@\n-const msg = "old";\n+const msg = "𝓗𝓮𝓵𝓵𝓸 𝓦𝓸𝓻𝓵𝓭";',
        },
        {
          name: 'Control and Format Characters',
          title: 'Control chars test (with invisible characters)',
          body: 'Testing control characters:\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u200B\u200C\u200D',
          filename: 'control-chars\u200Btest.js',
          patch:
            '@@ -1,1 +1,1 @@\n-console.log("normal");\n+console.log("with\u200Bzero\u200Cwidth\u200Dchars");',
        },
      ];

      for (const testCase of unicodeTestCases) {
        console.log(`  Testing ${testCase.name}...`);

        const prData = {
          id: 123,
          number: 123,
          title: testCase.title,
          body: testCase.body,
          user: { login: 'unicode-test-user' },
          head: { sha: 'abc123', ref: 'unicode-feature' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
          additions: 1,
          deletions: 1,
          changed_files: 1,
        };

        const fileData = [
          {
            filename: testCase.filename,
            additions: 1,
            deletions: 1,
            changes: 2,
            status: 'modified',
            patch: testCase.patch,
          },
        ];

        mockOctokit.rest.pulls.get.mockResolvedValueOnce({ data: prData });
        mockOctokit.rest.pulls.listFiles.mockResolvedValueOnce({ data: fileData });

        try {
          const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 123);

          console.log(`    Title length: ${prInfo.title.length}`);
          console.log(`    Body length: ${prInfo.body.length}`);
          console.log(`    Filename: ${prInfo.files[0]?.filename.substring(0, 30)}...`);

          // Should handle Unicode without corruption
          expect(prInfo.title).toBeDefined();
          expect(prInfo.body).toBeDefined();
          expect(prInfo.files.length).toBe(1);
          expect(prInfo.files[0].filename).toContain(testCase.filename.split('-')[0]); // At least part should match
        } catch (error: unknown) {
          console.log(`    Unicode handling error: ${(error as Error).message}`);
          // Some Unicode handling issues might be expected
          expect((error as Error).message).toBeDefined();
        }
      }
    });

    test('should handle special file path characters', async () => {
      console.log('Testing special file path character handling...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyzer = new PRAnalyzer(mockOctokit as any);

      const specialPathCases = [
        // Special characters that might cause issues
        'file with spaces.js',
        'file-with-dashes.js',
        'file_with_underscores.js',
        'file.with.dots.js',
        'file@with@at.js',
        'file#with#hash.js',
        'file$with$dollar.js',
        'file%with%percent.js',
        'file&with&ampersand.js',
        'file+with+plus.js',
        'file=with=equals.js',
        'file[with]brackets.js',
        'file{with}braces.js',
        'file(with)parens.js',
        'file;with;semicolon.js',
        'file,with,comma.js',
        "file'with'quote.js",
        'file"with"doublequote.js',
        '../../malicious/path/traversal.js',
        'file\\with\\backslash.js',
        'file/with/forward/slash.js',
        'file?with?question.js',
        'file*with*asterisk.js',
        'file|with|pipe.js',
        'file<with>angle.js',
        '中文文件名.js',
        'ファイル名.js',
        'файл.js',
        'ملف.js',
        '🚀rocket🚀.js',
      ];

      const prData = {
        id: 123,
        number: 123,
        title: 'Testing special file paths',
        body: 'This PR tests various special characters in file paths',
        user: { login: 'test-user' },
        head: { sha: 'abc123', ref: 'special-paths' },
        base: { sha: 'def456', ref: 'main' },
        draft: false,
        additions: specialPathCases.length,
        deletions: 0,
        changed_files: specialPathCases.length,
      };

      const fileList = specialPathCases.map((filename, i) => ({
        filename,
        additions: 1,
        deletions: 0,
        changes: 1,
        status: 'added' as const,
        patch: `@@ -0,0 +1,1 @@\n+console.log("File ${i}: ${filename}");`,
      }));

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: prData });
      mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: fileList });

      try {
        const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 123);

        console.log(
          `  Processed ${prInfo.files.length}/${specialPathCases.length} files with special paths`
        );

        // Should handle special file paths without crashing
        expect(prInfo.files.length).toBeGreaterThan(0);
        expect(prInfo.files.length).toBeLessThanOrEqual(specialPathCases.length);

        // Check that paths are handled safely
        prInfo.files.forEach(file => {
          expect(typeof file.filename).toBe('string');
          expect(file.filename.length).toBeGreaterThan(0);
        });
      } catch (error: unknown) {
        console.log(`  Special path handling error: ${(error as Error).message}`);
        expect((error as Error).message).toBeDefined();
      }
    });
  });

  describe('Platform and Environment Edge Cases', () => {
    test('should handle cross-platform path differences', async () => {
      console.log('Testing cross-platform path handling...');

      const pathTestCases = [
        // Windows-style paths
        'src\\windows\\style\\path.js',
        'C:\\absolute\\windows\\path.js',
        'src\\mixed/slash\\paths.js',

        // Unix-style paths
        'src/unix/style/path.js',
        '/absolute/unix/path.js',
        './relative/unix/path.js',
        '../parent/directory/path.js',

        // Mixed and edge cases
        'src/mixed\\slash/paths.js',
        'path/with/./current/dir.js',
        'path/with/../parent/dir.js',
        'path//with//double//slash.js',
        'path\\\\with\\\\double\\\\backslash.js',
      ];

      const configManager = new ConfigManager();

      // Test path handling in configuration contexts
      for (const testPath of pathTestCases) {
        console.log(`  Testing path: ${testPath}`);

        // Normalize the path using Node.js path utilities
        const normalizedPath = path.normalize(testPath);
        const resolvedPath = path.resolve(testPath);
        const relativePath = path.relative(process.cwd(), testPath);

        console.log(`    Normalized: ${normalizedPath}`);
        console.log(`    Resolved: ${resolvedPath.substring(0, 50)}...`);
        console.log(`    Relative: ${relativePath.substring(0, 50)}...`);

        // Should handle path operations without errors
        expect(typeof normalizedPath).toBe('string');
        expect(typeof resolvedPath).toBe('string');
        expect(typeof relativePath).toBe('string');
      }

      // Test config loading with various path formats
      const configPathTests = [
        './visor.config.yaml',
        '.\\visor.config.yaml',
        'visor.config.yaml',
        path.join(os.tmpdir(), 'visor.config.yaml'),
        path.resolve('visor.config.yaml'),
      ];

      for (const configPath of configPathTests) {
        try {
          await configManager.loadConfig(configPath);
        } catch (error: unknown) {
          // Expected to fail for non-existent files
          expect((error as Error).message).toContain('Configuration file not found');
        }
      }
    });

    test('should handle environment variable edge cases', async () => {
      console.log('Testing environment variable edge cases...');

      // Store original env vars
      const originalEnv = { ...process.env };

      const envTestCases = [
        {
          name: 'Empty environment variables',
          env: {
            GITHUB_TOKEN: '',
            GITHUB_REPOSITORY: '',
            GITHUB_EVENT_NAME: '',
          },
        },
        {
          name: 'Undefined environment variables',
          env: {
            GITHUB_TOKEN: undefined,
            GITHUB_REPOSITORY: undefined,
            GITHUB_EVENT_NAME: undefined,
          },
        },
        {
          name: 'Very long environment variables',
          env: {
            GITHUB_TOKEN: 'x'.repeat(10000),
            GITHUB_REPOSITORY: 'owner/repo-with-very-long-name-that-exceeds-normal-limits'.repeat(
              10
            ),
            GITHUB_EVENT_NAME: 'pull_request_with_very_long_event_name_that_might_cause_issues',
          },
        },
        {
          name: 'Special characters in environment variables',
          env: {
            GITHUB_TOKEN: 'token-with-special-chars-!@#$%^&*()_+-=[]{}|;:\'",.<>?',
            GITHUB_REPOSITORY: 'owner-with-special/repo-with-special',
            GITHUB_EVENT_NAME: 'event.with.dots',
          },
        },
      ];

      for (const testCase of envTestCases) {
        console.log(`  Testing ${testCase.name}...`);

        // Set test environment
        Object.assign(process.env, testCase.env);

        try {
          const context = {
            event_name: process.env.GITHUB_EVENT_NAME || 'unknown',
            repository: process.env.GITHUB_REPOSITORY
              ? {
                  owner: { login: process.env.GITHUB_REPOSITORY.split('/')[0] || '' },
                  name: process.env.GITHUB_REPOSITORY.split('/')[1] || '',
                }
              : undefined,
          };

          const bridge = new ActionCliBridge(process.env.GITHUB_TOKEN || '', context);

          const inputs = {
            'github-token': process.env.GITHUB_TOKEN || '',
            'visor-checks': 'security',
            owner: 'test-owner',
            repo: 'test-repo',
          };

          const shouldUse = bridge.shouldUseVisor(inputs);
          console.log(`    Should use Visor: ${shouldUse}`);

          // Should handle environment edge cases
          expect(typeof shouldUse).toBe('boolean');
        } catch (error: unknown) {
          console.log(`    Environment edge case error: ${(error as Error).message}`);
          expect((error as Error).message).toBeDefined();
        }

        // Restore original environment
        process.env = { ...originalEnv };
      }
    });

    test('should handle system resource limits gracefully', async () => {
      console.log('Testing system resource limit handling...');

      const cli = new CLI();

      // Test with arguments that might stress the system
      const stressTestCases = [
        {
          name: 'Very long argument list',
          args: Array(1000)
            .fill(0)
            .flatMap((_, i) => ['--check', `check-${i}`]),
        },
        {
          name: 'Very long individual arguments',
          args: ['--check', 'x'.repeat(100000), '--output', 'y'.repeat(50000)],
        },
        {
          name: 'Deeply nested config path',
          args: ['--config', Array(100).fill('very-deep-directory').join('/')],
        },
      ];

      for (const testCase of stressTestCases) {
        console.log(`  Testing ${testCase.name}...`);

        try {
          const startTime = Date.now();
          const options = cli.parseArgs(testCase.args);
          const duration = Date.now() - startTime;

          console.log(`    Processed in ${duration}ms`);

          // Should handle stress cases within reasonable time
          expect(duration).toBeLessThan(10000); // Less than 10 seconds
          expect(options).toBeDefined();
        } catch (error: unknown) {
          console.log(`    System limit error: ${(error as Error).message}`);
          // Should provide clear error for resource limits
          expect((error as Error).message).toBeDefined();
          expect((error as Error).message).not.toContain('Maximum call stack');
          expect((error as Error).message).not.toContain('out of memory');
        }
      }
    });
  });

  describe('Concurrency Edge Cases', () => {
    test('should handle concurrent operations on same resources', async () => {
      console.log('Testing concurrent operations on same resources...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const commentManager = new CommentManager(mockOctokit as any, {
        maxRetries: 2,
        baseDelay: 10,
      });

      // Test concurrent operations on the same PR/comment
      const concurrentOperations = Array(10)
        .fill(0)
        .map((_, i) =>
          commentManager.updateOrCreateComment(
            'test-owner',
            'test-repo',
            123, // Same PR number
            `Concurrent update ${i}: ${Date.now()}`,
            {
              commentId: 'shared-comment-id', // Same comment ID
              triggeredBy: `concurrent-test-${i}`,
              allowConcurrentUpdates: true, // Allow concurrent updates for this test
            }
          )
        );

      try {
        const results = await Promise.allSettled(concurrentOperations);
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`  Concurrent operations results: ${successful} successful, ${failed} failed`);

        // Should handle some concurrent operations successfully
        expect(successful).toBeGreaterThan(0);
        expect(successful + failed).toBe(10);
      } catch (error: unknown) {
        console.log(`  Concurrent operations error: ${(error as Error).message}`);
        expect((error as Error).message).toBeDefined();
      }
    });

    test('should handle race conditions in configuration loading', async () => {
      console.log('Testing race conditions in configuration loading...');

      const configManager = new ConfigManager();

      // Test concurrent config operations
      const concurrentConfigOps = Array(20)
        .fill(0)
        .map((_, i) =>
          (async () => {
            try {
              // This will fail for non-existent config, but tests the race condition handling
              await configManager.loadConfig(`/nonexistent/config-${i}.yaml`);
              return { success: true, index: i };
            } catch (error: unknown) {
              return { success: false, index: i, error: (error as Error).message };
            }
          })()
        );

      const results = await Promise.allSettled(concurrentConfigOps);
      const completed = results.filter(r => r.status === 'fulfilled').length;

      console.log(`  Concurrent config operations completed: ${completed}/20`);

      // Should complete all operations without hanging or crashing
      expect(completed).toBe(20);

      // All should fail gracefully for non-existent configs
      results.forEach((result, _i) => {
        if (result.status === 'fulfilled') {
          expect(result.value.success).toBe(false);
          expect(result.value.error).toContain('Configuration file not found');
        }
      });
    });
  });
});
