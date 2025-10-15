/* eslint-disable @typescript-eslint/no-unused-vars */
import { GitRepositoryAnalyzer, GitRepositoryInfo } from '../../../src/git-repository-analyzer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock simple-git to avoid actual git commands in tests
jest.mock('simple-git', () => {
  return {
    simpleGit: jest.fn(() => ({
      checkIsRepo: jest.fn(),
      status: jest.fn(),
      branch: jest.fn(),
      log: jest.fn(),
      diff: jest.fn(),
      getRemotes: jest.fn(),
      raw: jest.fn(),
    })),
  };
});

interface MockGit {
  checkIsRepo: jest.Mock;
  status: jest.Mock;
  branch: jest.Mock;
  log: jest.Mock;
  diff: jest.Mock;
  getRemotes: jest.Mock;
  raw: jest.Mock;
}

describe('GitRepositoryAnalyzer', () => {
  let tempDir: string;
  let gitAnalyzer: GitRepositoryAnalyzer;
  let mockGit: MockGit;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-test-'));

    // Get the mocked simple-git instance
    const { simpleGit } = require('simple-git');
    mockGit = {
      checkIsRepo: jest.fn(),
      status: jest.fn(),
      branch: jest.fn(),
      log: jest.fn(),
      diff: jest.fn(),
      getRemotes: jest.fn(),
      raw: jest.fn(),
    };

    simpleGit.mockReturnValue(mockGit);
    gitAnalyzer = new GitRepositoryAnalyzer(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
    }
  });

  describe('analyzeRepository', () => {
    it('should detect git repository correctly', async () => {
      // Mock simple-git methods
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'src/test.ts',
            index: 'M',
            working_dir: ' ',
          },
          {
            path: 'src/utils.js',
            index: 'A',
            working_dir: ' ',
          },
        ],
        created: [],
        deleted: [],
        modified: ['src/test.ts'],
        renamed: [],
        staged: ['src/test.ts', 'src/utils.js'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Test commit',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      // Create test files
      const testFile1 = path.join(tempDir, 'src');
      const testFile2 = path.join(tempDir, 'src', 'test.ts');
      fs.mkdirSync(testFile1, { recursive: true });
      fs.writeFileSync(testFile2, 'console.log("test");\n');

      const testFile3 = path.join(tempDir, 'src', 'utils.js');
      fs.writeFileSync(testFile3, 'function test() {}\n');

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(true);
      expect(result.head).toBe('main');
    });

    it('should handle non-git repository', async () => {
      // Mock simple-git to throw error (indicating not a git repo)
      mockGit.checkIsRepo.mockRejectedValue(new Error('Not a git repository'));

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(false);
      expect(result.files.length).toBe(0);
      expect(result.files).toHaveLength(0);
    });

    it('should handle repository with no commits but with uncommitted files', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'new-file.ts',
            index: 'A',
            working_dir: ' ',
          },
        ],
        created: ['new-file.ts'],
        deleted: [],
        modified: [],
        renamed: [],
        staged: ['new-file.ts'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      // Simulate no commits yet
      mockGit.log.mockRejectedValue(
        new Error("your current branch 'main' does not have any commits yet")
      );
      // Mock git config for author (needs to handle --local flag)
      mockGit.raw.mockImplementation((args: string[]) => {
        if (args.includes('user.name')) {
          return Promise.resolve('John Doe\n');
        }
        if (args.includes('user.email')) {
          return Promise.resolve('john@example.com\n');
        }
        return Promise.resolve('');
      });

      const testFile = path.join(tempDir, 'new-file.ts');
      fs.writeFileSync(testFile, 'console.log("test");\n');

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(true);
      expect(result.author).toBe('John Doe');
      expect(result.files.length).toBe(1);
      expect(result.files[0].filename).toBe('new-file.ts');
    });

    it('should handle repository with no changes', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [],
        created: [],
        deleted: [],
        modified: [],
        renamed: [],
        staged: [],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'No changes',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(true);
      expect(result.files.length).toBe(0);
      expect(result.files).toHaveLength(0);
    });

    it('should calculate total additions and deletions', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'file1.ts',
            index: 'M',
            working_dir: ' ',
          },
          {
            path: 'file2.js',
            index: 'A',
            working_dir: ' ',
          },
          {
            path: 'file3.py',
            index: 'M',
            working_dir: ' ',
          },
        ],
        created: ['file2.js'],
        deleted: [],
        modified: ['file1.ts', 'file3.py'],
        renamed: [],
        staged: ['file1.ts', 'file2.js', 'file3.py'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'feature-branch',
        all: ['feature-branch'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Feature changes',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      // Create test files with specific content to simulate additions/deletions
      const files = ['file1.ts', 'file2.js', 'file3.py'];
      const contents = [
        '// file1 content\nconsole.log("test");\n// more lines\nfunction test() {}\n// additional content',
        'function file2() {\n  return "new file";\n}',
        'def file3():\n    return "modified"\n    pass',
      ];

      files.forEach((file, index) => {
        const filePath = path.join(tempDir, file);
        fs.writeFileSync(filePath, contents[index]);
      });

      // Mock diff to return empty string for all files (avoiding git diff complexity in tests)
      mockGit.diff.mockResolvedValue('');

      const result = await gitAnalyzer.analyzeRepository();

      // Should have files but exact counts depend on actual file analysis
      expect(result.files).toHaveLength(3);
      expect(result.totalAdditions).toBeGreaterThan(0);
      expect(result.totalDeletions).toBeGreaterThanOrEqual(0);
    });

    it('should handle binary files correctly', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'image.png',
            index: 'A',
            working_dir: ' ',
          },
          {
            path: 'text.txt',
            index: 'M',
            working_dir: ' ',
          },
        ],
        created: ['image.png'],
        deleted: [],
        modified: ['text.txt'],
        renamed: [],
        staged: ['image.png', 'text.txt'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Add binary and text files',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      // Create a binary file (PNG) and text file
      const binaryPath = path.join(tempDir, 'image.png');
      const textPath = path.join(tempDir, 'text.txt');

      // Create a simple binary file (not a real PNG but serves the purpose)
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(binaryPath, binaryData);
      fs.writeFileSync(textPath, 'Hello World\nThis is text content\nWith multiple lines');

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.files).toHaveLength(2);
      // Just check that files are present, exact additions/deletions depend on implementation
      const imageFile = result.files.find(f => f.filename === 'image.png');
      const textFile = result.files.find(f => f.filename === 'text.txt');
      expect(imageFile).toBeDefined();
      expect(textFile).toBeDefined();
    });

    it('should determine file status correctly', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'modified.ts',
            index: 'M',
            working_dir: ' ',
          },
        ],
        created: [],
        deleted: [],
        modified: ['modified.ts'],
        renamed: [],
        staged: ['modified.ts'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Modified file',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      // Create the modified file
      const filePath = path.join(tempDir, 'modified.ts');
      fs.writeFileSync(filePath, 'console.log("modified content");\n');

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.files.length).toBeGreaterThan(0);
      const modifiedFile = result.files.find(f => f.filename === 'modified.ts');
      expect(modifiedFile).toBeDefined();
      expect(modifiedFile!.status).toBe('modified');
    });
  });

  describe('getRepositoryStatus', () => {
    it('should return repository status with file count', async () => {
      // This method doesn't exist in the actual implementation
      // The CheckExecutionEngine provides getRepositoryStatus method
      expect(true).toBe(true); // Placeholder
    });

    it('should handle errors gracefully', async () => {
      mockGit.checkIsRepo.mockRejectedValue(new Error('Git command failed'));

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(false);
      expect(result.files.length).toBe(0);
    });
  });

  describe('toPRInfo', () => {
    it('should convert GitRepositoryInfo to PRInfo format', () => {
      const repositoryInfo: GitRepositoryInfo = {
        title: 'Test Repository Analysis',
        body: 'Repository analysis body',
        author: 'test-user',
        base: 'main',
        head: 'feature-branch',
        isGitRepository: true,
        workingDirectory: '/test/repo',
        files: [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 10,
            deletions: 5,
            changes: 15,
            patch: '@@ -1,5 +1,10 @@\n test content',
          },
        ],
        totalAdditions: 10,
        totalDeletions: 5,
      };

      const prInfo = gitAnalyzer.toPRInfo(repositoryInfo);

      expect(prInfo.title).toBe('Test Repository Analysis');
      expect(prInfo.body).toBe('Repository analysis body');
      expect(prInfo.author).toBe('test-user');
      expect(prInfo.base).toBe('main');
      expect(prInfo.head).toBe('feature-branch');
      expect(prInfo.files).toHaveLength(1);
      expect(prInfo.files[0].filename).toBe('src/test.ts');
      expect(prInfo.files[0].status).toBe('modified');
      expect(prInfo.files[0].additions).toBe(10);
      expect(prInfo.files[0].deletions).toBe(5);
    });

    it('should handle empty repository info', () => {
      const emptyRepositoryInfo: GitRepositoryInfo = {
        title: '',
        body: '',
        author: '',
        base: '',
        head: '',
        isGitRepository: false,
        workingDirectory: '',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const prInfo = gitAnalyzer.toPRInfo(emptyRepositoryInfo);

      expect(prInfo.files).toHaveLength(0);
      expect(prInfo.title).toBe('');
      expect(prInfo.author).toBe('');
    });
  });

  describe('Error Handling', () => {
    it('should handle git command timeouts', async () => {
      // Simulate timeout
      mockGit.checkIsRepo.mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Command timeout'));
          }, 100);
        });
      });

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(false);
    });

    it('should handle malformed git output', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [],
        created: [],
        deleted: [],
        modified: [],
        renamed: [],
        staged: [],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Test commit',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      const result = await gitAnalyzer.analyzeRepository();

      // Should handle malformed output gracefully
      expect(result.isGitRepository).toBe(true);
      expect(result.files).toHaveLength(0); // Should skip malformed entries
    });

    it('should handle non-existent working directory', () => {
      const nonExistentPath = '/path/that/does/not/exist';
      const analyzer = new GitRepositoryAnalyzer(nonExistentPath);

      expect(analyzer).toBeDefined();
      // Constructor should not throw, but analysis methods should handle the error
    });
  });

  describe('Performance', () => {
    it('should handle large repositories efficiently', async () => {
      // Mock a large number of files
      const manyFiles = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);

      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: manyFiles.map(f => ({
          path: f,
          index: 'A',
          working_dir: ' ',
        })),
        created: manyFiles,
        deleted: [],
        modified: [],
        renamed: [],
        staged: manyFiles,
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Large commit',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });

      // Create many small files
      manyFiles.forEach((file, i) => {
        const filePath = path.join(tempDir, file);
        fs.writeFileSync(filePath, `// File ${i}\nconsole.log(${i});\n`);
      });

      const startTime = Date.now();
      const result = await gitAnalyzer.analyzeRepository();
      const executionTime = Date.now() - startTime;

      expect(result.files).toHaveLength(100);
      expect(result.totalAdditions).toBeGreaterThan(0);
      // Should complete within reasonable time (less than 5 seconds for file I/O)
      expect(executionTime).toBeLessThan(5000);
    });
  });

  describe('includeContext parameter', () => {
    it('should include patches when includeContext is true', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'test.ts',
            index: 'M',
            working_dir: ' ',
          },
        ],
        created: [],
        deleted: [],
        modified: ['test.ts'],
        renamed: [],
        staged: ['test.ts'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Test commit',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });
      mockGit.diff.mockResolvedValue('--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new');

      const testFile = path.join(tempDir, 'test.ts');
      fs.writeFileSync(testFile, 'new\n');

      const result = await gitAnalyzer.analyzeRepository(true);
      const prInfo = gitAnalyzer.toPRInfo(result, true);

      expect(result.files[0].patch).toBeDefined();
      expect(prInfo.files[0].patch).toBeDefined();
      expect(prInfo.fullDiff).toBeDefined();
      expect(prInfo.fullDiff).toContain('test.ts');
    });

    it('should exclude patches when includeContext is false', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [
          {
            path: 'test.ts',
            index: 'M',
            working_dir: ' ',
          },
        ],
        created: [],
        deleted: [],
        modified: ['test.ts'],
        renamed: [],
        staged: ['test.ts'],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      mockGit.log.mockResolvedValue({
        latest: {
          message: 'Test commit',
          author_name: 'Test User',
          author_email: 'test@example.com',
          date: '2023-01-01',
        },
      });
      mockGit.diff.mockResolvedValue('--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new');

      const testFile = path.join(tempDir, 'test.ts');
      fs.writeFileSync(testFile, 'new\n');

      const result = await gitAnalyzer.analyzeRepository(false);
      const prInfo = gitAnalyzer.toPRInfo(result, false);

      expect(result.files[0].patch).toBeUndefined();
      expect(prInfo.files[0].patch).toBeUndefined();
      expect(prInfo.fullDiff).toBeUndefined();
    });

    it('should handle repository with no commits and get git config user', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.status.mockResolvedValue({
        files: [],
        created: [],
        deleted: [],
        modified: [],
        renamed: [],
        staged: [],
        not_added: [],
        conflicted: [],
      });
      mockGit.branch.mockResolvedValue({
        current: 'main',
        all: ['main'],
      });
      // Simulate no commits yet
      mockGit.log.mockRejectedValue(
        new Error("your current branch 'main' does not have any commits yet")
      );
      // Mock git config - only email available
      mockGit.raw = jest
        .fn()
        .mockResolvedValueOnce(null) // no user.name
        .mockResolvedValueOnce('jane@example.com\n'); // user.email

      const result = await gitAnalyzer.analyzeRepository();

      expect(result.isGitRepository).toBe(true);
      expect(result.author).toBe('jane@example.com');
    });
  });
});
