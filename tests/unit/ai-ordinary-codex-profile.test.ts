/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AIReviewService } from '../../src/ai-review-service';
import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { ProbeAgent } from '@probelabs/probe';
import type { PRInfo } from '../../src/pr-analyzer';

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn(),
}));

const PROFILE = 'luna-xhigh-readonly-v1' as const;
const TOOLS = ['search', 'extract', 'listFiles'] as const;

const prInfo: PRInfo = {
  number: 1,
  title: 'ordinary profile test',
  body: '',
  author: 'test',
  base: 'main',
  head: 'feature',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

function mockAgent(answer = JSON.stringify({ issues: [] })): void {
  (ProbeAgent as jest.Mock).mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    answer: jest.fn().mockResolvedValue(answer),
  }));
}

describe('ordinary Luna Codex execution profile', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-luna-profile-'));
    jest.clearAllMocks();
    delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDE_CODE_API_KEY;
    delete process.env.MODEL_NAME;
    delete process.env.USE_CLAUDE_CODE;
    delete process.env.VISOR_DEBUG;
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.USE_CLAUDE_CODE;
    delete process.env.VISOR_DEBUG;
  });

  it('passes an exact governed profile to ordinary ProbeAgent.answer', async () => {
    mockAgent();
    const service = new AIReviewService({
      codexExecutionProfile: PROFILE,
      path: cwd,
      allowedFolders: [cwd],
    });

    await service.executeReview(prInfo, 'Read the project and report findings');

    const options = (ProbeAgent as jest.Mock).mock.calls[0][0];
    expect(options).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-luna',
      path: fs.realpathSync(cwd),
      cwd: fs.realpathSync(cwd),
      allowedFolders: [fs.realpathSync(cwd)],
      allowEdit: false,
      enableBash: false,
      enableDelegate: false,
      enableTasks: false,
      enableExecutePlan: false,
      searchDelegate: false,
      allowedTools: [...TOOLS],
      governedCodexProfile: {
        version: 'probe.governed-codex-profile/v1',
        profileId: PROFILE,
        engine: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        cwd: fs.realpathSync(cwd),
        probeTools: [...TOOLS],
        fallback: false,
        retries: 0,
      },
    });
    expect(options.governedCodexProfile).toEqual(
      expect.objectContaining({
        probeTools: [...TOOLS],
        fallback: false,
        retries: 0,
      })
    );
    expect((ProbeAgent as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('keeps ordinary AI defaults unchanged when the profile is omitted', async () => {
    mockAgent();
    const service = new AIReviewService({ provider: 'google', apiKey: 'test-key' });

    await service.executeReview(prInfo, 'Review normally');

    const options = (ProbeAgent as jest.Mock).mock.calls[0][0];
    expect(options.provider).toBe('google');
    expect(options.allowEdit).toBe(false);
    expect(options).not.toHaveProperty('governedCodexProfile');
    expect(options).not.toHaveProperty('model');
    expect(options).not.toHaveProperty('allowedTools');
  });

  it.each([
    ['provider', { provider: 'openai' }],
    ['model', { model: 'gpt-5.2' }],
    ['fallback', { fallback: { auto: true } }],
    ['retry', { retry: { maxRetries: 1 } }],
    ['edit', { allowEdit: true }],
    ['bash', { allowBash: true }],
    ['delegation', { enableDelegate: true }],
    ['tasks', { enableTasks: true }],
    ['execute plan', { enableExecutePlan: true }],
    ['tools', { allowedTools: ['search'] }],
    ['disable tools', { disableTools: true }],
    ['extra folders', { allowedFolders: [cwd, os.tmpdir()] }],
  ])('rejects conflicting %s configuration', (_label, conflict) => {
    expect(
      () =>
        new AIReviewService({
          codexExecutionProfile: PROFILE,
          path: cwd,
          ...conflict,
        } as any)
    ).toThrow(/codex_execution_profile/);
  });

  it('rejects session reuse before touching the session registry', async () => {
    const service = new AIReviewService({ codexExecutionProfile: PROFILE, path: cwd });
    await expect(
      service.executeReviewWithSessionReuse(prInfo, 'reuse this', 'parent-session')
    ).rejects.toThrow('rejects session reuse');
  });

  it('does not register a profile session for later cloning', async () => {
    mockAgent();
    const service = new AIReviewService({
      codexExecutionProfile: PROFILE,
      path: cwd,
    });
    const result = await service.executeReview(prInfo, 'read only', undefined, 'profile-check');
    const sessionId = (result as any).sessionId;
    expect(typeof sessionId).toBe('string');
    expect((service as any).sessionRegistry.hasSession(sessionId)).toBe(false);
  });

  it('rejects USE_CLAUDE_CODE before Probe construction', () => {
    process.env.USE_CLAUDE_CODE = 'true';
    expect(() => new AIReviewService({ codexExecutionProfile: PROFILE, path: cwd })).toThrow(
      'conflicts with USE_CLAUDE_CODE=true'
    );
    expect(ProbeAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['explicit debug', { debug: true }],
    ['VISOR_DEBUG', {}],
  ])('does not convert profile runtime failures into %s summaries', async (_label, options) => {
    if (_label === 'VISOR_DEBUG') process.env.VISOR_DEBUG = 'true';
    (ProbeAgent as jest.Mock).mockImplementation(() => ({
      initialize: jest.fn().mockRejectedValue(new Error('profile runtime failure')),
      answer: jest.fn(),
    }));
    const service = new AIReviewService({
      codexExecutionProfile: PROFILE,
      path: cwd,
      ...(options as any),
    });
    await expect(service.executeReview(prInfo, 'read only')).rejects.toThrow(
      'profile runtime failure'
    );
  });

  it('constructs the real Probe profile and previews dispatch without a model call', async () => {
    // Bypass Jest's package mapper intentionally: this checks the installed
    // patched SDK, not the unit-test ProbeAgent double above.
    const realProbe = require(
      path.resolve(process.cwd(), 'node_modules/@probelabs/probe/cjs/index.cjs')
    );
    const realAgent = new realProbe.ProbeAgent({
      provider: 'codex',
      path: cwd,
      cwd,
      allowEdit: false,
      enableBash: false,
      enableDelegate: false,
      enableTasks: false,
      enableExecutePlan: false,
      searchDelegate: false,
      allowedTools: [...TOOLS],
      governedCodexProfile: {
        version: 'probe.governed-codex-profile/v1',
        profileId: PROFILE,
        engine: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        cwd,
        probeTools: [...TOOLS],
        fallback: false,
        retries: 0,
      },
    });

    expect(realAgent.governedCodexProfile.profileId).toBe(PROFILE);
    const dispatch = await realAgent.previewGovernedAnswerDispatch('inspect only', {
      schema: JSON.stringify({ type: 'object', properties: {} }),
    });
    expect(dispatch).toMatchObject({ source: 'probe-host-tools-call', tool: 'codex' });

    // Exercise ordinary answer() with a zero-model fake engine. The real
    // ProbeAgent still owns the governed profile and passes its abort signal
    // through the regular answer path; no Codex process or paid model runs.
    let queryOptions: any;
    realAgent.getEngine = async () => ({
      query: async function* (_message: string, options: any) {
        queryOptions = options;
        yield { type: 'text', content: 'ordinary profile answer' };
      },
      close: async () => undefined,
    });
    await expect(realAgent.answer('read only')).resolves.toBe('ordinary profile answer');
    expect(queryOptions).toEqual(expect.objectContaining({ abortSignal: expect.any(Object) }));
  });
});

describe('AICheckProvider ordinary profile wiring', () => {
  const MockService = jest.fn();
  let provider: AICheckProvider;
  let captured: any[];

  beforeEach(() => {
    jest.resetModules();
    captured = [];
    MockService.mockImplementation((config: any) => {
      captured.push(config);
      return {
        executeReview: jest.fn().mockResolvedValue({ issues: [] }),
      };
    });
    // The provider imports this constructor through the module namespace.
    jest.doMock('../../src/ai-review-service', () => ({ AIReviewService: MockService }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AICheckProvider: LoadedProvider } = require('../../src/providers/ai-check-provider');
    provider = new LoadedProvider();
  });

  afterEach(() => {
    jest.dontMock('../../src/ai-review-service');
    jest.resetModules();
  });

  it('reads ai.codex_execution_profile and scopes it to the run directory', async () => {
    const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-run-'));
    try {
      await provider.execute(
        prInfo,
        {
          type: 'ai',
          prompt: 'inspect',
          ai: { codex_execution_profile: PROFILE },
        } as any,
        undefined,
        { _parentContext: { workingDirectory: runDirectory } } as any
      );

      const config = captured[captured.length - 1];
      expect(config.codexExecutionProfile).toBe(PROFILE);
      expect(config.path).toBe(runDirectory);
      expect(config.cwd).toBe(runDirectory);
      expect(config.allowedFolders).toEqual([runDirectory]);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('validates the closed profile and rejects static conflicts early', async () => {
    await expect(
      provider.validateConfig({
        type: 'ai',
        prompt: 'inspect',
        ai: { codex_execution_profile: PROFILE },
      } as any)
    ).resolves.toBe(true);
    await expect(
      provider.validateConfig({
        type: 'ai',
        prompt: 'inspect',
        ai: { codex_execution_profile: PROFILE, allowedTools: ['search'] },
      } as any)
    ).resolves.toBe(false);
  });

  it('rejects profile conflicts at the provider boundary', async () => {
    await expect(
      provider.execute(prInfo, {
        type: 'ai',
        prompt: 'inspect',
        ai: { codex_execution_profile: PROFILE, allowEdit: true },
      } as any)
    ).rejects.toThrow('rejects edit/create/bash capabilities');

    await expect(
      provider.execute(prInfo, {
        type: 'ai',
        prompt: 'inspect',
        ai: { codex_execution_profile: PROFILE, provider: 'openai' },
      } as any)
    ).rejects.toThrow('conflicts with provider');
  });
});
