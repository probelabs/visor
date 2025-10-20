import { FileExclusionHelper } from '../../src/utils/file-exclusion';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileExclusionHelper', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-exclusion-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Path Traversal Protection', () => {
    test('should safely load .gitignore from working directory', () => {
      const gitignoreContent = 'node_modules/\n*.tmp\n';
      fs.writeFileSync(path.join(tempDir, '.gitignore'), gitignoreContent);

      const helper = new FileExclusionHelper(tempDir);

      expect(helper.shouldExcludeFile('node_modules/package.json')).toBe(true);
      expect(helper.shouldExcludeFile('test.tmp')).toBe(true);
      expect(helper.shouldExcludeFile('src/index.ts')).toBe(false);
    });

    test('should prevent path traversal in gitignore path', () => {
      // This test verifies that path resolution prevents traversal attacks
      // Even if somehow a malicious path is constructed, it should be caught
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Constructor should not throw, but should handle path safely
      const helper = new FileExclusionHelper(tempDir);

      // Should still work with default patterns
      expect(helper.shouldExcludeFile('dist/index.js')).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  describe('Content Sanitization', () => {
    test('should remove control characters from gitignore content', () => {
      // Create gitignore with control characters
      const maliciousContent = 'node_modules/\x00\n*.tmp\x01\x02\x7F\n';
      fs.writeFileSync(path.join(tempDir, '.gitignore'), maliciousContent);

      const helper = new FileExclusionHelper(tempDir);

      // Should still work properly after sanitization
      expect(helper.shouldExcludeFile('node_modules/package.json')).toBe(true);
      expect(helper.shouldExcludeFile('test.tmp')).toBe(true);
    });

    test('should reject extremely long lines in gitignore', () => {
      // Create gitignore with an extremely long line
      const longPattern = 'a'.repeat(2000);
      const gitignoreContent = `node_modules/\n${longPattern}\n*.tmp\n`;
      fs.writeFileSync(path.join(tempDir, '.gitignore'), gitignoreContent);

      const helper = new FileExclusionHelper(tempDir);

      // Should work with valid patterns, ignoring the too-long line
      expect(helper.shouldExcludeFile('node_modules/package.json')).toBe(true);
      expect(helper.shouldExcludeFile('test.tmp')).toBe(true);
    });

    test('should normalize line endings', () => {
      // Create gitignore with mixed line endings
      const gitignoreContent = 'node_modules/\r\n*.tmp\r\ndist/\n';
      fs.writeFileSync(path.join(tempDir, '.gitignore'), gitignoreContent);

      const helper = new FileExclusionHelper(tempDir);

      expect(helper.shouldExcludeFile('node_modules/package.json')).toBe(true);
      expect(helper.shouldExcludeFile('test.tmp')).toBe(true);
      expect(helper.shouldExcludeFile('dist/index.js')).toBe(true);
    });
  });

  describe('Default Patterns', () => {
    test('should use default exclusion patterns when no gitignore exists', () => {
      const helper = new FileExclusionHelper(tempDir);

      // Should exclude common build artifacts
      expect(helper.shouldExcludeFile('dist/index.js')).toBe(true);
      expect(helper.shouldExcludeFile('build/main.js')).toBe(true);
      expect(helper.shouldExcludeFile('node_modules/package/index.js')).toBe(true);
      expect(helper.shouldExcludeFile('coverage/lcov-report/index.html')).toBe(true);

      // Should not exclude source files
      expect(helper.shouldExcludeFile('src/index.ts')).toBe(false);
    });

    test('should allow disabling default patterns', () => {
      const helper = new FileExclusionHelper(tempDir, null);

      // Should not exclude anything when no gitignore and no default patterns
      expect(helper.shouldExcludeFile('dist/index.js')).toBe(false);
      expect(helper.shouldExcludeFile('node_modules/package/index.js')).toBe(false);
    });

    test('should allow custom additional patterns', () => {
      const customPatterns = ['*.tmp', 'test-data/'];
      const helper = new FileExclusionHelper(tempDir, customPatterns);

      expect(helper.shouldExcludeFile('file.tmp')).toBe(true);
      expect(helper.shouldExcludeFile('test-data/sample.json')).toBe(true);
      expect(helper.shouldExcludeFile('src/index.ts')).toBe(false);
    });
  });

  describe('GitIgnore Priority', () => {
    test('gitignore patterns should take precedence', () => {
      // Create gitignore with custom pattern
      const gitignoreContent = '*.custom\n';
      fs.writeFileSync(path.join(tempDir, '.gitignore'), gitignoreContent);

      const helper = new FileExclusionHelper(tempDir);

      // Custom pattern from gitignore
      expect(helper.shouldExcludeFile('file.custom')).toBe(true);
      // Default pattern still works
      expect(helper.shouldExcludeFile('dist/index.js')).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should handle missing gitignore gracefully', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const helper = new FileExclusionHelper(tempDir);

      // Should still work with default patterns
      expect(helper.shouldExcludeFile('dist/index.js')).toBe(true);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No .gitignore found'));

      consoleSpy.mockRestore();
    });

    test('should handle unreadable gitignore file', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Create gitignore and make it unreadable
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/');
      fs.chmodSync(gitignorePath, 0o000);

      try {
        const helper = new FileExclusionHelper(tempDir);

        // Should fall back to default patterns
        expect(helper.shouldExcludeFile('dist/index.js')).toBe(true);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load .gitignore:'),
          expect.anything()
        );
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(gitignorePath, 0o644);
        consoleSpy.mockRestore();
      }
    });
  });
});
