import path from 'path';
import fs from 'fs';

// Capture schema passed to ProbeAgent.answer
let lastAnswerArgs: { message?: string; images?: unknown; options?: any } = {};

jest.mock('@probelabs/probe', () => {
  return {
    // Minimal stub that records arguments and returns schema-shaped JSON
    ProbeAgent: jest.fn().mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn().mockImplementation((message: string, images?: unknown, options?: any) => {
        lastAnswerArgs = { message, images, options };
        // Return JSON that is valid for text/overview schemas by default
        return Promise.resolve('{"text":"ok"}');
      }),
    })),
  };
});

describe('AI schema resolution (built-in and custom paths)', () => {
  const makePR = () => ({
    number: 1,
    title: 'T',
    body: 'B',
    author: 'user',
    base: 'main',
    head: 'feature',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    eventType: 'pr_opened',
    isIssue: false,
    eventContext: {},
  });

  beforeEach(() => {
    lastAnswerArgs = {};
    jest.resetModules();
  });

  it('loads built-in overview schema from bundled output and passes it to ProbeAgent', async () => {
    const { AIReviewService } = require('../../src/ai-review-service');
    const svc = new AIReviewService({ provider: 'mock', debug: false });

    await svc.executeReview(makePR(), 'prompt', 'overview', 'check1');

    expect(lastAnswerArgs.options).toBeDefined();
    expect(typeof lastAnswerArgs.options.schema).toBe('string');
    const parsed = JSON.parse(lastAnswerArgs.options.schema);
    // Basic shape check: should be a JSON schema object with type/object or properties
    expect(typeof parsed).toBe('object');
    expect(parsed.type || parsed.properties).toBeDefined();
  });

  it('loads custom relative file schema (./output/overview/schema.json) and passes exact content', async () => {
    const customPath = './output/overview/schema.json';
    const expected = fs.readFileSync(path.resolve(process.cwd(), customPath), 'utf-8').trim();
    const { AIReviewService } = require('../../src/ai-review-service');
    const svc = new AIReviewService({ provider: 'mock', debug: false });

    await svc.executeReview(makePR(), 'prompt', customPath, 'check2');

    expect(lastAnswerArgs.options).toBeDefined();
    expect(lastAnswerArgs.options.schema).toBeDefined();
    expect(lastAnswerArgs.options.schema.trim()).toBe(expected);
  });

  it('falls back to CWD when dist (__dirname) path is unavailable', async () => {
    // Monkey-patch fs.promises.readFile to fail for __dirname/output first, then allow CWD
    const realRead = fs.promises.readFile;
    const badPrefix = path.join(path.resolve(__dirname, '../../src'), 'output') + path.sep;
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (p: any, enc?: any) => {
      const sp = String(p);
      if (sp.startsWith(badPrefix)) {
        const err: any = new Error('ENOENT');
        (err as any).code = 'ENOENT';
        throw err;
      }
      // Delegate to real readFile for everything else
      // @ts-ignore
      return realRead(p, enc as any);
    });

    const { AIReviewService } = require('../../src/ai-review-service');
    const svc = new AIReviewService({ provider: 'mock', debug: false });

    await svc.executeReview(makePR(), 'prompt', 'overview', 'check3');
    expect(lastAnswerArgs.options).toBeDefined();
    expect(typeof lastAnswerArgs.options.schema).toBe('string');
    // If we got here, loader successfully fell back to CWD
  });
});
