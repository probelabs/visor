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
    const resolved = path.resolve(cwd, explicit);

    // Not exists → throws with resolved
    mockFs.existsSync.mockReturnValue(false);
    expect(() => runner.resolveTestsPath(explicit)).toThrow(
      `Explicit tests file not found: ${explicit} (resolved to ${resolved})`
    );

    // Exists but not readable → access throws
    mockFs.existsSync.mockReturnValue(true);
    mockFs.accessSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => runner.resolveTestsPath(explicit)).toThrow(
      `Explicit tests file not readable: ${resolved}`
    );
  });

  it('discovers defaults/visor.tests.yaml', () => {
    const candidate = path.resolve(cwd, 'defaults/visor.tests.yaml');
    mockFs.existsSync.mockImplementation((p: any) => p === candidate);
    const found = runner.resolveTestsPath();
    expect(found).toBe(candidate);
  });

  it('falls back to project-local .visor.tests.yaml', () => {
    const candidate = path.resolve(cwd, '.visor.tests.yaml');
    mockFs.existsSync.mockImplementation((p: any) => p === candidate);
    const found = runner.resolveTestsPath();
    expect(found).toBe(candidate);
  });

  it('reports attempted paths on failure', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(() => runner.resolveTestsPath()).toThrow('defaults/visor.tests.yaml');
  });
});
