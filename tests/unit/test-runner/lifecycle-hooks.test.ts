/**
 * Tests for test framework lifecycle hooks (before_all, after_all, before_each, after_each, before, after)
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Test lifecycle hooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-hooks-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validator', () => {
    it('should accept suite-level hooks in tests block', () => {
      const { validateTestsDoc } = require('../../../src/test-runner/validator');
      const doc = {
        tests: {
          hooks: {
            before_all: { exec: 'echo setup' },
            after_all: { exec: 'echo teardown' },
            before_each: { exec: 'echo before-case' },
            after_each: { exec: 'echo after-case' },
          },
          cases: [{ name: 'test-1', event: 'manual' }],
        },
      };
      const result = validateTestsDoc(doc);
      expect(result.ok).toBe(true);
    });

    it('should accept case-level hooks', () => {
      const { validateTestsDoc } = require('../../../src/test-runner/validator');
      const doc = {
        tests: {
          cases: [
            {
              name: 'test-1',
              event: 'manual',
              hooks: {
                before: { exec: 'echo seed-data' },
                after: { exec: 'echo cleanup', timeout: 5000 },
              },
            },
          ],
        },
      };
      const result = validateTestsDoc(doc);
      expect(result.ok).toBe(true);
    });

    it('should reject invalid hook properties', () => {
      const { validateTestsDoc } = require('../../../src/test-runner/validator');
      const doc = {
        tests: {
          hooks: {
            before_all: { cmd: 'echo nope' }, // wrong key, missing 'exec'
          },
          cases: [{ name: 'test-1', event: 'manual' }],
        },
      };
      const result = validateTestsDoc(doc);
      expect(result.ok).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('VisorTestRunner.runHook', () => {
    it('should execute a shell command and return ok', async () => {
      const { VisorTestRunner } = require('../../../src/test-runner/index');
      const runner = new VisorTestRunner(tmpDir);
      const marker = path.join(tmpDir, 'hook-ran');
      const result = await (runner as any).runHook(
        { exec: `touch ${marker}` },
        'test-hook',
        tmpDir
      );
      expect(result.ok).toBe(true);
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('should return error on non-zero exit', async () => {
      const { VisorTestRunner } = require('../../../src/test-runner/index');
      const runner = new VisorTestRunner(tmpDir);
      const result = await (runner as any).runHook({ exec: 'exit 1' }, 'test-hook', tmpDir);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('test-hook failed');
    });

    it('should return ok when hook is undefined', async () => {
      const { VisorTestRunner } = require('../../../src/test-runner/index');
      const runner = new VisorTestRunner(tmpDir);
      const result = await (runner as any).runHook(undefined, 'noop', tmpDir);
      expect(result.ok).toBe(true);
    });

    it('should inherit environment variables', async () => {
      const { VisorTestRunner } = require('../../../src/test-runner/index');
      const runner = new VisorTestRunner(tmpDir);
      const marker = path.join(tmpDir, 'env-check');
      process.env.VISOR_HOOK_TEST_VAR = 'hello-hooks';
      try {
        const result = await (runner as any).runHook(
          { exec: `bash -c 'echo $VISOR_HOOK_TEST_VAR > ${marker}'` },
          'env-hook',
          tmpDir
        );
        expect(result.ok).toBe(true);
        const content = fs.readFileSync(marker, 'utf8').trim();
        expect(content).toBe('hello-hooks');
      } finally {
        delete process.env.VISOR_HOOK_TEST_VAR;
      }
    });
  });
});
