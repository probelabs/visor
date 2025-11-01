/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import { ConfigLoader } from '../../src/utils/config-loader';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('ConfigLoader default config (non-dot only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetchConfig('default') loads defaults/visor.yaml and not .visor.yaml", async () => {
    const loader = new ConfigLoader();

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('/defaults/.visor.yaml')) {
        // If code still probes legacy path, keep it false
        return false;
      }
      // Succeed when non-dot defaults is probed
      return s.includes('/defaults/visor.yaml');
    });
    mockFs.readFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (!s.includes('/defaults/visor.yaml')) {
        throw new Error('Should only read defaults/visor.yaml');
      }
      return 'version: "1.0"\nchecks: {}\n';
    });

    const cfg = await loader.fetchConfig('default');
    expect(cfg).toBeTruthy();
    expect((cfg as any).version).toBe('1.0');

    // Ensure we never attempted to read legacy dot path
    const badProbe = mockFs.existsSync.mock.calls.find(call =>
      String(call[0]).includes('/defaults/.visor.yaml')
    );
    expect(badProbe).toBeUndefined();
  });
});
