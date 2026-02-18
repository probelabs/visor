/**
 * Tests for <<<RAW_OUTPUT>>> extraction in parseAIResponse.
 *
 * When ProbeAgent appends <<<RAW_OUTPUT>>> blocks after schema JSON,
 * visor's parseAIResponse must:
 *   1. Extract the blocks before JSON parsing
 *   2. Attach them as _rawOutput on the output object
 *   3. Not include them in the parsed JSON or text fields
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIReviewService } from '../../src/ai-review-service';

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn(),
}));

describe('parseAIResponse RAW_OUTPUT extraction', () => {
  let service: AIReviewService;

  beforeEach(() => {
    service = new AIReviewService();
  });

  it('should extract RAW_OUTPUT block from schema JSON response', () => {
    const json = JSON.stringify({
      answer: { text: 'Found 3 customers using JWT' },
      references: [],
    });
    const rawContent = 'customer,auth_type\nAcme,JWT\nBeta,HMAC';
    const response = `${json}\n<<<RAW_OUTPUT>>>\n${rawContent}\n<<<END_RAW_OUTPUT>>>`;

    const result = (service as any).parseAIResponse(response, undefined, 'custom');

    // JSON should be parsed correctly
    expect(result.output.answer.text).toBe('Found 3 customers using JWT');
    // _rawOutput should contain the extracted content
    expect(result.output._rawOutput).toBe(rawContent);
  });

  it('should handle multiple RAW_OUTPUT blocks', () => {
    const json = JSON.stringify({ text: 'Report generated' });
    const block1 = 'CSV block 1';
    const block2 = 'CSV block 2';
    const response = [
      json,
      `\n<<<RAW_OUTPUT>>>\n${block1}\n<<<END_RAW_OUTPUT>>>`,
      `\n<<<RAW_OUTPUT>>>\n${block2}\n<<<END_RAW_OUTPUT>>>`,
    ].join('');

    const result = (service as any).parseAIResponse(response, undefined, 'custom');

    expect(result.output.text).toBe('Report generated');
    expect(result.output._rawOutput).toContain(block1);
    expect(result.output._rawOutput).toContain(block2);
  });

  it('should not have _rawOutput when no RAW_OUTPUT blocks present', () => {
    const json = JSON.stringify({
      answer: { text: 'No raw output here' },
      references: [],
    });

    const result = (service as any).parseAIResponse(json, undefined, 'custom');

    expect(result.output.answer.text).toBe('No raw output here');
    expect(result.output._rawOutput).toBeUndefined();
  });

  it('should preserve multiline content in RAW_OUTPUT blocks', () => {
    const json = JSON.stringify({ text: 'Done' });
    const multiline = [
      '--- report.csv ---',
      'customer,revenue,status',
      'Acme Corp,50000,active',
      'Beta Inc,30000,pending',
      'Gamma LLC,75000,active',
      '--- report.csv ---',
    ].join('\n');
    const response = `${json}\n<<<RAW_OUTPUT>>>\n${multiline}\n<<<END_RAW_OUTPUT>>>`;

    const result = (service as any).parseAIResponse(response, undefined, 'custom');

    expect(result.output._rawOutput).toBe(multiline);
    expect(result.output._rawOutput).toContain('Acme Corp,50000,active');
    expect(result.output._rawOutput).toContain('--- report.csv ---');
  });

  it('should still parse JSON correctly when RAW_OUTPUT is present', () => {
    const data = {
      answer: { text: 'Analysis complete', summary: 'Found issues' },
      references: [{ file: 'test.go', line: 42 }],
      confidence: 0.95,
    };
    const json = JSON.stringify(data);
    const response = `${json}\n<<<RAW_OUTPUT>>>\nraw data here\n<<<END_RAW_OUTPUT>>>`;

    const result = (service as any).parseAIResponse(response, undefined, 'custom');

    expect(result.output.answer.text).toBe('Analysis complete');
    expect(result.output.references).toHaveLength(1);
    expect(result.output.references[0].file).toBe('test.go');
    expect(result.output.confidence).toBe(0.95);
    expect(result.output._rawOutput).toBe('raw data here');
  });

  it('should handle RAW_OUTPUT with code-review schema (no _rawOutput on code-review)', () => {
    // Code-review schema returns { issues: [...] } without output field
    const json = JSON.stringify({
      issues: [{ file: 'test.ts', line: 1, message: 'Bug', severity: 'critical', category: 'bug' }],
    });
    const response = `${json}\n<<<RAW_OUTPUT>>>\nextra data\n<<<END_RAW_OUTPUT>>>`;

    const result = (service as any).parseAIResponse(response, undefined, 'code-review');

    // Code-review path should still parse issues correctly
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toBe('Bug');
  });

  it('should attach _rawOutput in fallback plain text path', () => {
    // Response that's not valid JSON — falls through to plain text
    const response = `Not valid JSON at all\n<<<RAW_OUTPUT>>>\nfallback raw data\n<<<END_RAW_OUTPUT>>>`;

    const result = (service as any).parseAIResponse(response, undefined, 'custom');

    // Should fall back to plain text output
    expect(result.output.text).toBeDefined();
    expect(result.output._rawOutput).toBe('fallback raw data');
    // The text should NOT contain the RAW_OUTPUT delimiters
    expect(result.output.text).not.toContain('<<<RAW_OUTPUT>>>');
  });
});
