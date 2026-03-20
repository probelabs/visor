/**
 * Tests for task-evaluator.ts
 */

// Mock ProbeAgent before any imports
const mockAnswer = jest.fn();
const mockInitialize = jest.fn();
jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(() => ({
    answer: mockAnswer,
    initialize: mockInitialize,
  })),
}));

// Mock trace-serializer
jest.mock('../../../src/agent-protocol/trace-serializer', () => ({
  findTraceFile: jest.fn().mockResolvedValue(null),
  fetchTraceSpans: jest.fn().mockResolvedValue([]),
  serializeTraceForPrompt: jest.fn().mockResolvedValue('(no trace data available)'),
}));

import {
  evaluateTask,
  evaluateAndStore,
  type TaskEvaluationResult,
} from '../../../src/agent-protocol/task-evaluator';
import { serializeTraceForPrompt } from '../../../src/agent-protocol/trace-serializer';

// ---------------------------------------------------------------------------
// Mock task store
// ---------------------------------------------------------------------------

function createMockStore(taskData: {
  id: string;
  state: string;
  requestMessage: string;
  responseText?: string;
  metadata?: Record<string, unknown>;
  artifacts?: any[];
}) {
  const rawRow = {
    id: taskData.id,
    context_id: 'ctx-1',
    state: taskData.state,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    claimed_by: null,
    claimed_at: null,
    workflow_id: null,
    run_id: null,
    request_message: taskData.requestMessage,
    source: 'cli',
    metadata: taskData.metadata || {},
  };

  const fullTask = {
    id: taskData.id,
    context_id: 'ctx-1',
    status: {
      state: taskData.state,
      message: taskData.responseText
        ? { message_id: 'msg-1', role: 'agent', parts: [{ text: taskData.responseText }] }
        : undefined,
      timestamp: '2026-01-01T00:01:00Z',
    },
    artifacts: taskData.artifacts || [],
    history: [],
  };

  const addedArtifacts: any[] = [];

  return {
    listTasksRaw: jest.fn().mockReturnValue({ rows: [rawRow], total: 1 }),
    getTask: jest.fn().mockReturnValue(fullTask),
    addArtifact: jest.fn().mockImplementation((_id: string, artifact: any) => {
      addedArtifacts.push(artifact);
    }),
    _addedArtifacts: addedArtifacts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (serializeTraceForPrompt as jest.Mock).mockResolvedValue('(no trace data available)');
  });

  const sampleEvalResult: TaskEvaluationResult = {
    response_quality: {
      rating: 4,
      category: 'good',
      relevance: true,
      completeness: true,
      actionable: true,
      reasoning: 'The response addresses the request well.',
    },
    overall_rating: 4,
    summary: 'Good response that addresses the user request.',
  };

  it('evaluates a completed task', async () => {
    mockAnswer.mockResolvedValue(JSON.stringify(sampleEvalResult));

    const store = createMockStore({
      id: 'task-001',
      state: 'completed',
      requestMessage: 'How do I configure auth?',
      responseText: 'You can configure auth by editing config.yaml...',
    });

    const result = await evaluateTask('task-001', store as any);

    expect(result.overall_rating).toBe(4);
    expect(result.response_quality.category).toBe('good');
    expect(result.summary).toContain('Good response');
    expect(mockAnswer).toHaveBeenCalledTimes(1);

    // Verify prompt uses XML tags with request and response
    const prompt = mockAnswer.mock.calls[0][0];
    expect(prompt).toContain('<user_request>');
    expect(prompt).toContain('How do I configure auth?');
    expect(prompt).toContain('</user_request>');
    // No trace — response is in <agent_response> tags
    expect(prompt).toContain('<agent_response>');
    expect(prompt).toContain('You can configure auth by editing config.yaml');
    expect(prompt).toContain('</agent_response>');
  });

  it('returns shortcut result for failed tasks with no response', async () => {
    const store = createMockStore({
      id: 'task-002',
      state: 'failed',
      requestMessage: 'Do something',
    });

    const result = await evaluateTask('task-002', store as any);

    expect(result.overall_rating).toBe(1);
    expect(result.response_quality.category).toBe('error');
    // No LLM call should be made
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('includes trace in prompt when available', async () => {
    (serializeTraceForPrompt as jest.Mock).mockResolvedValue(
      'visor.run (5.0s)\n└── check-a (2.0s)'
    );

    const evalWithExec: TaskEvaluationResult = {
      ...sampleEvalResult,
      execution_quality: {
        rating: 4,
        category: 'efficient',
        reasoning: 'Good tool usage.',
      },
    };
    mockAnswer.mockResolvedValue(JSON.stringify(evalWithExec));

    const store = createMockStore({
      id: 'task-003',
      state: 'completed',
      requestMessage: 'Find auth issues',
      responseText: 'Found 3 issues...',
      metadata: { trace_id: 'trace-abc' },
    });

    const result = await evaluateTask('task-003', store as any);

    // Verify serializeTraceForPrompt called with full mode and task response
    expect(serializeTraceForPrompt).toHaveBeenCalledWith(
      'trace-abc',
      1_000_000,
      expect.objectContaining({}),
      'Found 3 issues...',
      'trace-abc'
    );

    expect(result.execution_quality).toBeDefined();
    expect(result.execution_quality!.category).toBe('efficient');

    // Verify trace is in XML tags, no separate agent_response
    const prompt = mockAnswer.mock.calls[0][0];
    expect(prompt).toContain('<execution_trace>');
    expect(prompt).toContain('visor.run (5.0s)');
    expect(prompt).toContain('</execution_trace>');
    expect(prompt).not.toContain('<agent_response>');
  });

  it('handles JSON wrapped in markdown code blocks', async () => {
    mockAnswer.mockResolvedValue('```json\n' + JSON.stringify(sampleEvalResult) + '\n```');

    const store = createMockStore({
      id: 'task-004',
      state: 'completed',
      requestMessage: 'Test',
      responseText: 'Test response',
    });

    const result = await evaluateTask('task-004', store as any);
    expect(result.overall_rating).toBe(4);
  });

  it('handles JSON embedded in text response', async () => {
    mockAnswer.mockResolvedValue(
      'Here is my evaluation:\n' + JSON.stringify(sampleEvalResult) + '\nDone.'
    );

    const store = createMockStore({
      id: 'task-005',
      state: 'completed',
      requestMessage: 'Test',
      responseText: 'Test response',
    });

    const result = await evaluateTask('task-005', store as any);
    expect(result.overall_rating).toBe(4);
  });

  it('throws when task not found', async () => {
    const store = {
      listTasksRaw: jest.fn().mockReturnValue({ rows: [], total: 0 }),
    };

    await expect(evaluateTask('nonexistent', store as any)).rejects.toThrow('Task not found');
  });

  it('supports prefix matching for task IDs', async () => {
    mockAnswer.mockResolvedValue(JSON.stringify(sampleEvalResult));

    const store = createMockStore({
      id: 'task-full-id-123',
      state: 'completed',
      requestMessage: 'Test',
      responseText: 'Done',
    });

    const result = await evaluateTask('task-full', store as any);
    expect(result.overall_rating).toBe(4);
  });
});

describe('evaluateAndStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (serializeTraceForPrompt as jest.Mock).mockResolvedValue('(no trace data available)');
  });

  it('stores evaluation result as artifact', async () => {
    const evalResult: TaskEvaluationResult = {
      response_quality: {
        rating: 5,
        category: 'excellent',
        relevance: true,
        completeness: true,
        actionable: true,
        reasoning: 'Perfect.',
      },
      overall_rating: 5,
      summary: 'Excellent response.',
    };
    mockAnswer.mockResolvedValue(JSON.stringify(evalResult));

    const store = createMockStore({
      id: 'task-010',
      state: 'completed',
      requestMessage: 'Help me',
      responseText: 'Here is the help...',
    });

    const result = await evaluateAndStore('task-010', store as any);

    // No trace available → overall rating capped at 4
    expect(result.overall_rating).toBe(4);
    expect(result.trace_available).toBe(false);
    expect(store.addArtifact).toHaveBeenCalledTimes(1);

    const artifactCall = store.addArtifact.mock.calls[0];
    expect(artifactCall[0]).toBe('task-010');
    expect(artifactCall[1].name).toBe('evaluation');
    const storedResult = JSON.parse(artifactCall[1].parts[0].text);
    expect(storedResult.overall_rating).toBe(4);
  });
});

describe('provider/model resolution', () => {
  const { ProbeAgent } = require('@probelabs/probe');
  const sampleResult: TaskEvaluationResult = {
    response_quality: {
      rating: 3,
      category: 'adequate',
      relevance: true,
      completeness: false,
      actionable: true,
      reasoning: 'OK.',
    },
    overall_rating: 3,
    summary: 'Adequate.',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (serializeTraceForPrompt as jest.Mock).mockResolvedValue('(no trace data available)');
    mockAnswer.mockResolvedValue(JSON.stringify(sampleResult));
    delete process.env.VISOR_EVAL_MODEL;
    delete process.env.VISOR_EVAL_PROVIDER;
    delete process.env.VISOR_JUDGE_MODEL;
  });

  it('uses explicit config.model', async () => {
    const store = createMockStore({
      id: 'task-020',
      state: 'completed',
      requestMessage: 'Test',
      responseText: 'Response',
    });

    await evaluateTask('task-020', store as any, { model: 'gpt-4o' });

    const opts = ProbeAgent.mock.calls[0][0];
    expect(opts.model).toBe('gpt-4o');
  });

  it('falls back to VISOR_EVAL_MODEL env', async () => {
    process.env.VISOR_EVAL_MODEL = 'claude-sonnet';

    const store = createMockStore({
      id: 'task-021',
      state: 'completed',
      requestMessage: 'Test',
      responseText: 'Response',
    });

    await evaluateTask('task-021', store as any);

    const opts = ProbeAgent.mock.calls[0][0];
    expect(opts.model).toBe('claude-sonnet');
  });

  it('falls back to VISOR_JUDGE_MODEL env', async () => {
    process.env.VISOR_JUDGE_MODEL = 'gemini-pro';

    const store = createMockStore({
      id: 'task-022',
      state: 'completed',
      requestMessage: 'Test',
      responseText: 'Response',
    });

    await evaluateTask('task-022', store as any);

    const opts = ProbeAgent.mock.calls[0][0];
    expect(opts.model).toBe('gemini-pro');
  });
});
