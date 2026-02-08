/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

/**
 * OPA HTTP Evaluator - evaluates policies via an external OPA server's REST API.
 *
 * Uses the built-in `fetch` API (Node 18+), so no extra dependencies are needed.
 */
export class OpaHttpEvaluator {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout: number = 5000) {
    // Validate protocol — only allow http:// and https://
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(
        `OPA HTTP evaluator: url must use http:// or https:// protocol, got: ${baseUrl}`
      );
    }
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;
  }

  /**
   * Evaluate a policy rule against an input document via OPA REST API.
   *
   * @param input - The input document to evaluate
   * @param rulePath - OPA rule path (e.g., 'visor/check/execute')
   * @returns The result object from OPA, or undefined on error
   */
  async evaluate(input: object, rulePath: string): Promise<any> {
    // OPA Data API: POST /v1/data/<path>
    const url = `${this.baseUrl}/v1/data/${rulePath}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OPA HTTP ${response.status}: ${response.statusText}`);
      }

      const body = await response.json();
      // OPA returns { result: { ... } }
      return (body as any)?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    // No persistent connections to close
  }
}
