import { evaluateLlmJudge } from '../../../src/test-runner/llm-judge';
import type { LlmJudgeExpectation } from '../../../src/test-runner/llm-judge';

// Mock ProbeAgent
const mockAnswer = jest.fn();
const mockInitialize = jest.fn();

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(() => ({
    answer: mockAnswer,
    initialize: mockInitialize,
  })),
}));

describe('LLM Judge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('evaluateLlmJudge', () => {
    it('should pass when LLM returns pass=true', async () => {
      mockAnswer.mockResolvedValueOnce(
        JSON.stringify({ pass: true, reason: 'Output meets criteria' })
      );

      const expectation: LlmJudgeExpectation = {
        prompt: 'Does the output contain a greeting?',
      };

      const { errors } = await evaluateLlmJudge(expectation, { text: 'Hello world' });
      expect(errors).toHaveLength(0);
    });

    it('should fail when LLM returns pass=false', async () => {
      mockAnswer.mockResolvedValueOnce(
        JSON.stringify({ pass: false, reason: 'No greeting found' })
      );

      const expectation: LlmJudgeExpectation = {
        prompt: 'Does the output contain a greeting?',
      };

      const { errors } = await evaluateLlmJudge(expectation, { text: 'Goodbye' });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('No greeting found');
    });

    it('should check custom assert fields', async () => {
      mockAnswer.mockResolvedValueOnce(
        JSON.stringify({
          pass: true,
          reason: 'OK',
          sentiment: 'positive',
          topics: ['greeting', 'weather'],
        })
      );

      const expectation: LlmJudgeExpectation = {
        prompt: 'Analyze the output',
        schema: {
          properties: {
            sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            topics: { type: 'array', items: { type: 'string' } },
          },
        },
        assert: {
          sentiment: 'positive',
          topics: ['greeting'],
        },
      };

      const { errors, result } = await evaluateLlmJudge(expectation, 'Hello, nice weather!');
      expect(errors).toHaveLength(0);
      expect(result?.sentiment).toBe('positive');
    });

    it('should fail when custom assert field does not match', async () => {
      mockAnswer.mockResolvedValueOnce(
        JSON.stringify({
          pass: true,
          reason: 'OK',
          sentiment: 'negative',
        })
      );

      const expectation: LlmJudgeExpectation = {
        prompt: 'Analyze sentiment',
        schema: {
          properties: {
            sentiment: { type: 'string' },
          },
        },
        assert: {
          sentiment: 'positive',
        },
      };

      const { errors } = await evaluateLlmJudge(expectation, 'I hate this');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('sentiment');
      expect(errors[0]).toContain('positive');
    });

    it('should handle LLM API errors gracefully', async () => {
      mockAnswer.mockRejectedValueOnce(new Error('API rate limit'));

      const expectation: LlmJudgeExpectation = {
        prompt: 'Evaluate this',
      };

      const { errors } = await evaluateLlmJudge(expectation, 'test');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('API rate limit');
    });

    it('should handle string output', async () => {
      mockAnswer.mockResolvedValueOnce(JSON.stringify({ pass: true, reason: 'Valid' }));

      const expectation: LlmJudgeExpectation = {
        prompt: 'Is this a valid response?',
      };

      const { errors } = await evaluateLlmJudge(expectation, 'plain string output');
      expect(errors).toHaveLength(0);
      // Verify ProbeAgent.answer was called with the string in the prompt
      expect(mockAnswer).toHaveBeenCalledWith(
        expect.stringContaining('plain string output'),
        undefined,
        expect.objectContaining({ schema: expect.any(String) })
      );
    });

    it('should fail assert on missing array item', async () => {
      mockAnswer.mockResolvedValueOnce(
        JSON.stringify({
          pass: true,
          reason: 'OK',
          tags: ['api', 'backend'],
        })
      );

      const expectation: LlmJudgeExpectation = {
        prompt: 'Extract tags',
        schema: {
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        assert: {
          tags: ['api', 'frontend'],
        },
      };

      const { errors } = await evaluateLlmJudge(expectation, 'API backend service');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('frontend');
    });

    it('should check boolean assert fields', async () => {
      mockAnswer.mockResolvedValueOnce(
        JSON.stringify({
          pass: true,
          reason: 'OK',
          has_code_references: false,
        })
      );

      const expectation: LlmJudgeExpectation = {
        prompt: 'Does the response include code references?',
        schema: {
          properties: {
            has_code_references: { type: 'boolean' },
          },
        },
        assert: {
          has_code_references: true,
        },
      };

      const { errors } = await evaluateLlmJudge(expectation, 'No code here');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('has_code_references');
    });

    it('should handle JSON wrapped in markdown code blocks', async () => {
      mockAnswer.mockResolvedValueOnce('```json\n{"pass": true, "reason": "Looks good"}\n```');

      const expectation: LlmJudgeExpectation = {
        prompt: 'Evaluate this',
      };

      const { errors } = await evaluateLlmJudge(expectation, 'test output');
      expect(errors).toHaveLength(0);
    });

    it('should pass schema as JSON string to ProbeAgent', async () => {
      mockAnswer.mockResolvedValueOnce(JSON.stringify({ pass: true, reason: 'OK' }));

      const expectation: LlmJudgeExpectation = {
        prompt: 'Evaluate this',
      };

      await evaluateLlmJudge(expectation, 'test');

      // Verify schema was passed as JSON string
      expect(mockAnswer).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({
          schema: expect.stringContaining('"pass"'),
        })
      );

      // Verify the schema is valid JSON
      const schemaArg = mockAnswer.mock.calls[0][2].schema;
      const parsed = JSON.parse(schemaArg);
      expect(parsed.type).toBe('object');
      expect(parsed.properties.pass.type).toBe('boolean');
      expect(parsed.properties.reason.type).toBe('string');
    });
  });
});

describe('evaluateLlmJudgeExpectations', () => {
  // This tests the integration function that resolves step/workflow outputs
  it('should resolve step output by name', async () => {
    mockAnswer.mockResolvedValueOnce(JSON.stringify({ pass: true, reason: 'OK' }));

    const { evaluateLlmJudgeExpectations } = require('../../../src/test-runner/evaluators');
    const errors = await evaluateLlmJudgeExpectations(
      {
        llm_judge: [{ step: 'my-step', prompt: 'Is this valid?' }],
      },
      { 'my-step': [{ text: 'Hello' }] }
    );
    expect(errors).toHaveLength(0);
  });

  it('should error when step has no output', async () => {
    const { evaluateLlmJudgeExpectations } = require('../../../src/test-runner/evaluators');
    const errors = await evaluateLlmJudgeExpectations(
      {
        llm_judge: [{ step: 'missing-step', prompt: 'Is this valid?' }],
      },
      {}
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('missing-step');
  });

  it('should return empty for no llm_judge expectations', async () => {
    const { evaluateLlmJudgeExpectations } = require('../../../src/test-runner/evaluators');
    const errors = await evaluateLlmJudgeExpectations({}, {});
    expect(errors).toHaveLength(0);
  });
});
