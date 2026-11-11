/**
 * YAML config validation tests for negotiated timeout settings.
 *
 * These tests would have caught the original bug: engineer.yaml lacked
 * timeout_behavior: negotiated and the associated negotiated_timeout_* fields,
 * causing the engineer sub-workflow's ProbeAgent to default to 'graceful'
 * timeout behavior. The AI would hit the 30-minute limit and refuse to continue,
 * claiming it was a "hard infrastructure ceiling."
 *
 * Also validates that assistant.yaml's generate-response step has matching config.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const DEFAULTS_DIR = path.resolve(__dirname, '..', 'defaults');

/**
 * Parse a YAML file and return the document.
 */
function loadYaml(filename: string): any {
  const filePath = path.join(DEFAULTS_DIR, filename);
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(content);
}

/**
 * All required negotiated timeout fields under the ai: block,
 * plus the step-level timeout field.
 */
const REQUIRED_NEGOTIATED_FIELDS = {
  stepLevel: ['timeout'],
  aiLevel: [
    'timeout_behavior',
    'ai_timeout',
    'negotiated_timeout_budget',
    'negotiated_timeout_max_requests',
    'negotiated_timeout_max_per_request',
    'graceful_stop_deadline',
  ],
};

/**
 * Returns the Visor hard kill timeout for a step.
 * This can live at the step level (engineer.yaml) or inside ai: (assistant.yaml).
 */
function getHardTimeout(step: any): number | undefined {
  if (typeof step.timeout === 'number') return step.timeout;
  if (typeof step.ai?.timeout === 'number') return step.ai.timeout;
  return undefined;
}

/**
 * Validates that a step's ai block has complete negotiated timeout configuration.
 * Returns an array of error strings (empty = pass).
 */
function validateNegotiatedTimeoutConfig(
  step: any,
  stepName: string,
  workflowName: string
): string[] {
  const errors: string[] = [];

  if (!step) {
    errors.push(`${workflowName}: step '${stepName}' not found`);
    return errors;
  }

  // Check that a hard kill timeout exists (at step level or inside ai:)
  const hardTimeout = getHardTimeout(step);
  if (hardTimeout === undefined) {
    errors.push(
      `${workflowName}.${stepName}: missing timeout (Visor hard kill) at step level or in ai:`
    );
  } else if (hardTimeout <= 0) {
    errors.push(
      `${workflowName}.${stepName}: timeout must be a positive number, got ${hardTimeout}`
    );
  }

  const ai = step.ai;
  if (!ai) {
    errors.push(`${workflowName}.${stepName}: missing 'ai' block entirely`);
    return errors;
  }

  // Check timeout_behavior is 'negotiated'
  if (ai.timeout_behavior !== 'negotiated') {
    errors.push(
      `${workflowName}.${stepName}.ai: timeout_behavior must be 'negotiated', ` +
        `got '${ai.timeout_behavior ?? '(undefined - defaults to graceful)'}'`
    );
  }

  // Check all required ai-level fields exist and are positive numbers
  for (const field of REQUIRED_NEGOTIATED_FIELDS.aiLevel) {
    if (field === 'timeout_behavior') continue; // Already checked above
    if (ai[field] === undefined) {
      errors.push(`${workflowName}.${stepName}.ai: missing '${field}'`);
    } else if (typeof ai[field] !== 'number' || ai[field] <= 0) {
      errors.push(
        `${workflowName}.${stepName}.ai: '${field}' must be a positive number, got ${ai[field]}`
      );
    }
  }

  return errors;
}

describe('Negotiated Timeout YAML Config Validation', () => {
  describe('engineer.yaml - engineer-task step', () => {
    let doc: any;

    beforeAll(() => {
      doc = loadYaml('engineer.yaml');
    });

    it('should parse engineer.yaml without errors', () => {
      expect(doc).toBeDefined();
      expect(doc.id).toBe('engineer');
    });

    it('should have engineer-task step with type ai', () => {
      const step = doc.steps?.['engineer-task'];
      expect(step).toBeDefined();
      expect(step.type).toBe('ai');
    });

    it('should have timeout_behavior set to negotiated', () => {
      const ai = doc.steps?.['engineer-task']?.ai;
      expect(ai).toBeDefined();
      expect(ai.timeout_behavior).toBe('negotiated');
    });

    it('should have all required negotiated timeout fields', () => {
      const step = doc.steps?.['engineer-task'];
      const errors = validateNegotiatedTimeoutConfig(step, 'engineer-task', 'engineer.yaml');
      expect(errors).toEqual([]);
    });

    it('should have step-level timeout >= ai_timeout', () => {
      const step = doc.steps?.['engineer-task'];
      // The step-level timeout (Visor hard kill) must be larger than
      // the ai_timeout (Probe soft timeout) to leave room for extensions.
      expect(step.timeout).toBeGreaterThanOrEqual(step.ai.ai_timeout);
    });

    it('should have negotiated_timeout_budget that allows meaningful extensions', () => {
      const ai = doc.steps?.['engineer-task']?.ai;
      // Budget should allow at least one full extension
      expect(ai.negotiated_timeout_budget).toBeGreaterThanOrEqual(
        ai.negotiated_timeout_max_per_request
      );
    });

    it('should have budget + ai_timeout not exceeding step timeout', () => {
      const step = doc.steps?.['engineer-task'];
      // Total possible time (ai_timeout + full budget) must not exceed the Visor hard kill
      const maxPossibleTime = step.ai.ai_timeout + step.ai.negotiated_timeout_budget;
      expect(maxPossibleTime).toBeLessThanOrEqual(step.timeout);
    });

    it('should have max_requests * max_per_request >= budget', () => {
      const ai = doc.steps?.['engineer-task']?.ai;
      // The max requests * max per request should cover the budget
      const maxGrantable =
        ai.negotiated_timeout_max_requests * ai.negotiated_timeout_max_per_request;
      expect(maxGrantable).toBeGreaterThanOrEqual(ai.negotiated_timeout_budget);
    });

    it('should have graceful_stop_deadline set', () => {
      const ai = doc.steps?.['engineer-task']?.ai;
      expect(ai.graceful_stop_deadline).toBeDefined();
      expect(ai.graceful_stop_deadline).toBeGreaterThan(0);
      // Should be short relative to extensions (typically 30-60s)
      expect(ai.graceful_stop_deadline).toBeLessThanOrEqual(120000);
    });
  });

  describe('assistant.yaml - generate-response step', () => {
    let doc: any;

    beforeAll(() => {
      doc = loadYaml('assistant.yaml');
    });

    it('should parse assistant.yaml without errors', () => {
      expect(doc).toBeDefined();
      expect(doc.id).toBe('assistant');
    });

    it('should have generate-response step with type ai', () => {
      const step = doc.steps?.['generate-response'];
      expect(step).toBeDefined();
      expect(step.type).toBe('ai');
    });

    it('should have timeout_behavior set to negotiated', () => {
      const ai = doc.steps?.['generate-response']?.ai;
      expect(ai).toBeDefined();
      expect(ai.timeout_behavior).toBe('negotiated');
    });

    it('should have all required negotiated timeout fields', () => {
      const step = doc.steps?.['generate-response'];
      const errors = validateNegotiatedTimeoutConfig(step, 'generate-response', 'assistant.yaml');
      expect(errors).toEqual([]);
    });

    it('should have hard kill timeout >= ai_timeout', () => {
      // generate-response has its timeout inside the ai: block
      const step = doc.steps?.['generate-response'];
      const hardTimeout = getHardTimeout(step);
      expect(hardTimeout).toBeDefined();
      expect(hardTimeout).toBeGreaterThanOrEqual(step.ai.ai_timeout);
    });

    it('should have negotiated_timeout_budget that allows meaningful extensions', () => {
      const ai = doc.steps?.['generate-response']?.ai;
      expect(ai.negotiated_timeout_budget).toBeGreaterThanOrEqual(
        ai.negotiated_timeout_max_per_request
      );
    });
  });

  describe('Cross-workflow consistency', () => {
    let engineerDoc: any;
    let assistantDoc: any;

    beforeAll(() => {
      engineerDoc = loadYaml('engineer.yaml');
      assistantDoc = loadYaml('assistant.yaml');
    });

    it('should use the same timeout_behavior in both workflows', () => {
      const engineerBehavior = engineerDoc.steps?.['engineer-task']?.ai?.timeout_behavior;
      const assistantBehavior = assistantDoc.steps?.['generate-response']?.ai?.timeout_behavior;
      expect(engineerBehavior).toBe('negotiated');
      expect(assistantBehavior).toBe('negotiated');
    });

    it('should use matching negotiated_timeout_max_requests', () => {
      const engineerMax = engineerDoc.steps?.['engineer-task']?.ai?.negotiated_timeout_max_requests;
      const assistantMax =
        assistantDoc.steps?.['generate-response']?.ai?.negotiated_timeout_max_requests;
      // They should be configured (may differ, but both must exist)
      expect(engineerMax).toBeDefined();
      expect(assistantMax).toBeDefined();
      expect(typeof engineerMax).toBe('number');
      expect(typeof assistantMax).toBe('number');
    });
  });
});
