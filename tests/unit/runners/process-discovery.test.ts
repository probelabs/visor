import {
  findVisorProcesses,
  isProcessAlive,
  signalProcess,
} from '../../../src/runners/process-discovery';

// We can't easily mock ps/proc in unit tests, so these test the pure logic
// and basic process utilities.

describe('process-discovery', () => {
  describe('isProcessAlive', () => {
    it('returns true for current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent PID', () => {
      // PID 99999999 is unlikely to exist
      expect(isProcessAlive(99999999)).toBe(false);
    });
  });

  describe('signalProcess', () => {
    it('returns false for non-existent PID', () => {
      expect(signalProcess(99999999, 'SIGTERM')).toBe(false);
    });
  });

  describe('findVisorProcesses', () => {
    it('returns an array', () => {
      const result = findVisorProcesses();
      expect(Array.isArray(result)).toBe(true);
    });

    it('excludes current process', () => {
      const result = findVisorProcesses();
      const self = result.find(p => p.pid === process.pid);
      expect(self).toBeUndefined();
    });

    it('each result has required fields', () => {
      const result = findVisorProcesses();
      for (const proc of result) {
        expect(typeof proc.pid).toBe('number');
        expect(typeof proc.cwd).toBe('string');
        expect(typeof proc.cmd).toBe('string');
      }
    });
  });
});
