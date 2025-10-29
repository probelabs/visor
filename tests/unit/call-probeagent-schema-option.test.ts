import { AIReviewService, AIDebugInfo } from '../../src/ai-review-service';

describe('callProbeAgent schema options', () => {
  it('populates debugInfo.schema for overview schema', async () => {
    const svc: any = new AIReviewService({ provider: 'google', apiKey: 'x', debug: true });
    const debugInfo: AIDebugInfo = {
      prompt: 'p',
      rawResponse: '',
      provider: 'google',
      model: 'm',
      apiKeySource: 'x',
      processingTime: 0,
      promptLength: 1,
      responseLength: 0,
      jsonParseSuccess: false,
      timestamp: new Date().toISOString(),
    };

    // Mock ProbeAgent to avoid network
    jest.mock('@probelabs/probe', () => ({
      ProbeAgent: jest.fn().mockImplementation(() => ({
        answer: jest.fn().mockResolvedValue('{"text":"ok"}')
      }))
    }));

    const { response } = await svc['callProbeAgent']('msg', 'overview', debugInfo, 'overview', undefined);
    expect(typeof response).toBe('string');
    expect(typeof (debugInfo as any).schema).toBe('string');
    const opt = JSON.parse((debugInfo as any).schema);
    expect(typeof opt.schema).toBe('string');
  });
});

