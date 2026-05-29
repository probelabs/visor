import {
  formatUserFacingExecutionError,
  formatUserFacingExecutionMessage,
  summarizeUserFacingIssues,
} from '../../src/utils/user-facing-error';

describe('user-facing execution errors', () => {
  it('maps no-output model failures to a friendly provider message', () => {
    expect(
      formatUserFacingExecutionError(
        new Error('Error: Failed to get response from AI model. No output generated.')
      )
    ).toBe(
      'The AI provider failed before generating any response. This is usually caused by a provider-side limit, rate limit, or outage. Please retry.'
    );
  });

  it('maps budget failures to a friendly budget message', () => {
    expect(
      formatUserFacingExecutionError({
        message: 'Forbidden',
        responseBody: '{"message":"Budget limit exceeded for streaming"}',
        statusCode: 403,
      })
    ).toBe(
      'The AI provider budget limit was exceeded before a response could be generated. Please retry later or switch model/provider.'
    );
  });

  it('strips internal wrapper prefixes from surfaced messages', () => {
    expect(
      formatUserFacingExecutionMessage(
        'AI analysis failed: ProbeAgent execution failed: Error: Request timed out'
      )
    ).toBe('The AI request timed out before a response could be generated. Please retry.');
  });

  it('maps high-demand provider failures to a friendly retry message', () => {
    expect(
      formatUserFacingExecutionError(
        new Error(
          'Failed after 3 attempts. Last error: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
        )
      )
    ).toBe(
      'The AI provider is currently experiencing high demand and did not generate a response. Please retry shortly.'
    );
  });

  it('maps empty assistant text guarantee failures to a user-facing response failure', () => {
    expect(
      summarizeUserFacingIssues([
        {
          ruleId: 'contract/guarantee_failed',
          message: "Guarantee failed: (output?.text ?? '').length > 0",
          severity: 'error',
        },
      ])
    ).toBe(
      'The assistant failed to produce a response. This is usually caused by a provider-side limit, outage, or invalid structured output. Please retry.'
    );
  });
});
