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

    (mockFs.statSync as any).mockImplementation((p: any) => {
      if (p === visorYaml || p === dotYaml) return { isFile: () => true } as fs.Stats;
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (p === visorYaml) {
        return 'version: "1.0"\nchecks: {}\n';
      }
      throw new Error('Should not read .visor.yaml when visor.yaml is present');
    });

    const config = await mgr.findAndLoadConfig();
    expect(config.version).toBe('1.0');
  });

  it('throws with helpful message when only legacy .visor.yaml is present', async () => {
    const prevStrict = process.env.VISOR_STRICT_CONFIG_NAME;
    process.env.VISOR_STRICT_CONFIG_NAME = 'true';
    const dotYaml = path.join(repoDir, '.visor.yaml');
    (mockFs.statSync as any).mockImplementation((p: any) => {
      if (p === dotYaml) return { isFile: () => true } as fs.Stats;
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    await expect(mgr.findAndLoadConfig()).rejects.toThrow('Legacy config detected');
    if (prevStrict === undefined) delete process.env.VISOR_STRICT_CONFIG_NAME;
    else process.env.VISOR_STRICT_CONFIG_NAME = prevStrict;
  });

  it('falls back to bundled/defaults when nothing exists (then to minimal)', async () => {
    (mockFs.statSync as any).mockImplementation(() => {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    (mockFs.existsSync as any).mockReturnValue(false);
    // Force bundled default to be null so we hit minimal default
    jest.spyOn(ConfigManager.prototype as any, 'loadBundledDefaultConfig').mockReturnValue(null);

    const config = await mgr.findAndLoadConfig();
    expect(config.version).toBe('1.0');
    expect(config.checks).toEqual({});
  });
});
