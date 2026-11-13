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
export declare class OpaHttpEvaluator {
    private baseUrl;
    private timeout;
    constructor(baseUrl: string, timeout?: number);
    /**
     * Check if a hostname is blocked due to SSRF concerns.
     *
     * Blocks:
     * - Loopback addresses (127.x.x.x, localhost, 0.0.0.0, ::1)
     * - Link-local addresses (169.254.x.x)
     * - Private networks (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
     * - IPv6 unique local addresses (fd00::/8)
     * - Cloud metadata services (*.internal)
     */
    private isBlockedHostname;
    /**
     * Evaluate a policy rule against an input document via OPA REST API.
     *
     * @param input - The input document to evaluate
     * @param rulePath - OPA rule path (e.g., 'visor/check/execute')
     * @returns The result object from OPA, or undefined on error
     */
    evaluate(input: object, rulePath: string): Promise<any>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=opa-http-evaluator.d.ts.map