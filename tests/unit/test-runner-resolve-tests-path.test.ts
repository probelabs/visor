/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import { VisorTestRunner } from '../../src/test-runner/index';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('VisorTestRunner.resolveTestsPath', () => {
  const cwd = '/work';
  let runner: VisorTestRunner;

  beforeEach(() => {
    jest.clearAllMocks();
    runner = new VisorTestRunner(cwd);
  });

  it('validates explicit path existence and readability', () => {
    const explicit = 'suite.yaml';
    // const resolved = path.resolve(cwd, explicit);

    // Not exists → throws with resolved
    (mockFs.statSync as any).mockImplementation(() => {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    expect(() => runner.resolveTestsPath(explicit)).toThrow('Explicit tests file not accessible');

    // Exists but not readable → access throws
    (mockFs.statSync as any).mockImplementation(() => ({ isFile: () => true }));
    (mockFs.openSync as any).mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => runner.resolveTestsPath(explicit)).toThrow('Explicit tests file not accessible');
  });

  it('rejects explicit paths that escape the working directory (path traversal)', () => {
    const explicit = '../outside.yaml';
    // existsSync shouldn't even matter; traversal should be caught first
    mockFs.existsSync.mockReturnValue(true);
    expect(() => runner.resolveTestsPath(explicit)).toThrow(
      'Security error: Path traversal detected.'
    );
  });

  it('discovers defaults/visor.tests.yaml', () => {
    const candidate = path.resolve(cwd, 'defaults/visor.tests.yaml');
    (mockFs.statSync as any).mockImplementation((p: any) => {
      if (p === candidate) return { isFile: () => true } as fs.Stats;
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    const found = runner.resolveTestsPath();
    expect(found).toBe(candidate);
  });

  it('falls back to project-local .visor.tests.yaml', () => {
    const candidate = path.resolve(cwd, '.visor.tests.yaml');
    (mockFs.statSync as any).mockImplementation((p: any) => {
      if (p === candidate) return { isFile: () => true } as fs.Stats;
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    const found = runner.resolveTestsPath();
    expect(found).toBe(candidate);
  });

  it('reports attempted paths on failure', () => {
    (mockFs.statSync as any).mockImplementation(() => {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    expect(() => runner.resolveTestsPath()).toThrow('defaults/visor.tests.yaml');
  });
});
