import fs from 'fs';
import os from 'os';
import path from 'path';

describe('AIReviewService schema loading', () => {
  it('loads built-in schema from dist/src output when CWD has no output folder', async () => {
    // Use ts-node transpile-only to import TS sources
    require('ts-node/register/transpile-only');
    const { AIReviewService } = require('../../src/ai-review-service');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-ai-schema-'));
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const svc = new AIReviewService({ debug: false });
      const content: string = await (svc as any)['loadSchemaContent']('issue-assistant');
      expect(typeof content).toBe('string');
      expect(content.trim().length).toBeGreaterThan(10);
      expect(() => JSON.parse(content)).not.toThrow();
    } finally {
      process.chdir(prev);
    }
  });
});
