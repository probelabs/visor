/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigManager } from '../../src/config';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('Config discovery variants (visor.yaml vs .visor.yaml)', () => {
  let mgr: ConfigManager;
  const repoDir = '/repo';

  beforeEach(() => {
    mgr = new ConfigManager();
    jest.clearAllMocks();
    jest.spyOn(process, 'cwd').mockReturnValue(repoDir as any);
  });

  it('prefers visor.yaml when both visor.yaml and .visor.yaml exist', async () => {
    const visorYaml = path.join(repoDir, 'visor.yaml');
    const dotYaml = path.join(repoDir, '.visor.yaml');

    mockFs.existsSync.mockImplementation((p: any) => p === visorYaml || p === dotYaml);
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (p === visorYaml) {
        return 'version: "1.0"\nchecks: {}\n';
      }
      throw new Error('Should not read .visor.yaml when visor.yaml is present');
    });

    const config = await mgr.findAndLoadConfig();
    expect(config.version).toBe('1.0');
    // Ensure we attempted visor.yaml (first candidate) and did not read .visor.yaml
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect((mockFs.readFileSync.mock.calls[0][0] as string).endsWith('visor.yaml')).toBe(true);
  });

  it('throws with helpful message when only legacy .visor.yaml is present', async () => {
    const dotYaml = path.join(repoDir, '.visor.yaml');
    mockFs.existsSync.mockImplementation((p: any) => p === dotYaml);
    await expect(mgr.findAndLoadConfig()).rejects.toThrow('Legacy config detected');
  });

  it('falls back to bundled/defaults when nothing exists (then to minimal)', async () => {
    mockFs.existsSync.mockReturnValue(false);
    // Force bundled default to be null so we hit minimal default
    jest.spyOn(ConfigManager.prototype as any, 'loadBundledDefaultConfig').mockReturnValue(null);

    const config = await mgr.findAndLoadConfig();
    expect(config.version).toBe('1.0');
    expect(config.checks).toEqual({});
  });
});
