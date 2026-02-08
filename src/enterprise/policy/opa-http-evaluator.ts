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
    // Validate URL format and protocol
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`OPA HTTP evaluator: invalid URL: ${baseUrl}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(
        `OPA HTTP evaluator: url must use http:// or https:// protocol, got: ${baseUrl}`
      );
    }
    // Block cloud metadata, loopback, link-local, and private network addresses
    const hostname = parsed.hostname;
    if (this.isBlockedHostname(hostname)) {
      throw new Error(
        `OPA HTTP evaluator: url must not point to internal, loopback, or private network addresses`
      );
    }
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;
  }

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
  private isBlockedHostname(hostname: string): boolean {
    if (!hostname) return true; // block empty hostnames

    // Normalize hostname: lowercase and remove brackets for IPv6
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // Block .internal domains (cloud metadata services)
    if (normalized === 'metadata.google.internal' || normalized.endsWith('.internal')) {
      return true;
    }

    // Block localhost variants
    if (normalized === 'localhost' || normalized === 'localhost.localdomain') {
      return true;
    }

    // Block IPv6 loopback
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
      return true;
    }

    // Check IPv4 patterns
    const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const ipv4Match = normalized.match(ipv4Pattern);
    if (ipv4Match) {
      const octets = ipv4Match.slice(1, 5).map(Number);

      // Validate octets are in range [0, 255]
      if (octets.some(octet => octet > 255)) {
        return false;
      }

      const [a, b] = octets;

      // Block loopback: 127.0.0.0/8
      if (a === 127) {
        return true;
      }

      // Block 0.0.0.0/8 (this host)
      if (a === 0) {
        return true;
      }

      // Block link-local: 169.254.0.0/16
      if (a === 169 && b === 254) {
        return true;
      }

      // Block private networks
      // 10.0.0.0/8
      if (a === 10) {
        return true;
      }
      // 172.16.0.0/12 (172.16.x.x through 172.31.x.x)
      if (a === 172 && b >= 16 && b <= 31) {
        return true;
      }
      // 192.168.0.0/16
      if (a === 192 && b === 168) {
        return true;
      }
    }

    // Check IPv6 patterns
    // Block unique local addresses: fd00::/8
    if (normalized.startsWith('fd') || normalized.startsWith('fc')) {
      return true;
    }
    // Block link-local: fe80::/10
    if (normalized.startsWith('fe80:')) {
      return true;
    }

    return false;
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
    const encodedPath = rulePath
      .split('/')
      .map(s => encodeURIComponent(s))
      .join('/');
    const url = `${this.baseUrl}/v1/data/${encodedPath}`;

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

      let body: unknown;
      try {
        body = await response.json();
      } catch (jsonErr) {
        throw new Error(
          `OPA HTTP evaluator: failed to parse JSON response: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`
        );
      }
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
