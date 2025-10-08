import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { HttpServerConfig, VisorConfig } from './types/config';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from './liquid-extensions';
import { CheckExecutionEngine } from './check-execution-engine';
import { logger } from './logger';

export interface WebhookPayload {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: string;
}

export interface WebhookContext {
  webhookData: Map<string, unknown>;
}

/**
 * HTTP/HTTPS server for receiving webhook requests
 */
export class WebhookServer {
  private server?: http.Server | https.Server;
  private config: HttpServerConfig;
  private liquid: Liquid;
  private webhookData: Map<string, unknown> = new Map();
  private executionEngine?: CheckExecutionEngine;
  private visorConfig?: VisorConfig;
  private isGitHubActions: boolean;

  constructor(config: HttpServerConfig, visorConfig?: VisorConfig) {
    this.config = config;
    this.visorConfig = visorConfig;
    this.liquid = createExtendedLiquid();

    // Detect GitHub Actions environment
    this.isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  }

  /**
   * Set the execution engine for triggering checks on webhook receipt
   */
  public setExecutionEngine(engine: CheckExecutionEngine): void {
    this.executionEngine = engine;
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('🔌 HTTP server is disabled in configuration');
      return;
    }

    // Don't start server in GitHub Actions environment
    if (this.isGitHubActions) {
      logger.info('🔌 HTTP server disabled in GitHub Actions environment');
      return;
    }

    const port = this.config.port || 8080;
    const host = this.config.host || '0.0.0.0';

    // Create HTTPS or HTTP server based on TLS configuration
    if (this.config.tls?.enabled) {
      const tlsOptions = await this.loadTlsOptions();
      this.server = https.createServer(tlsOptions, async (req, res) => {
        await this.handleRequest(req, res);
      });
    } else {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });
    }

    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        const protocol = this.config.tls?.enabled ? 'https' : 'http';
        logger.info(
          `🔌 ${protocol.toUpperCase()} server listening on ${protocol}://${host}:${port}`
        );

        if (this.config.endpoints && this.config.endpoints.length > 0) {
          logger.info('📍 Registered endpoints:');
          for (const endpoint of this.config.endpoints) {
            logger.info(`   - ${endpoint.path}${endpoint.name ? ` (${endpoint.name})` : ''}`);
          }
        }

        resolve();
      });

      this.server!.on('error', error => {
        logger.error(
          '❌ Failed to start HTTP server:',
          error instanceof Error ? error : new Error(String(error))
        );
        reject(error);
      });
    });
  }

  /**
   * Load TLS options from configuration
   */
  private async loadTlsOptions(): Promise<https.ServerOptions> {
    const tls = this.config.tls!;
    const options: https.ServerOptions = {};

    // Load certificate
    if (tls.cert) {
      if (tls.cert.startsWith('-----BEGIN')) {
        // Direct certificate content
        options.cert = tls.cert;
      } else if (tls.cert.startsWith('${')) {
        // Environment variable
        const envVar = tls.cert.slice(2, -1);
        const certContent = process.env[envVar];
        if (!certContent) {
          throw new Error(`TLS certificate environment variable ${envVar} not found`);
        }
        options.cert = certContent;
      } else {
        // File path
        options.cert = fs.readFileSync(tls.cert, 'utf8');
      }
    }

    // Load key
    if (tls.key) {
      if (tls.key.startsWith('-----BEGIN')) {
        // Direct key content
        options.key = tls.key;
      } else if (tls.key.startsWith('${')) {
        // Environment variable
        const envVar = tls.key.slice(2, -1);
        const keyContent = process.env[envVar];
        if (!keyContent) {
          throw new Error(`TLS key environment variable ${envVar} not found`);
        }
        options.key = keyContent;
      } else {
        // File path
        options.key = fs.readFileSync(tls.key, 'utf8');
      }
    }

    // Load CA certificate if provided
    if (tls.ca) {
      if (tls.ca.startsWith('-----BEGIN')) {
        // Direct CA content
        options.ca = tls.ca;
      } else if (tls.ca.startsWith('${')) {
        // Environment variable
        const envVar = tls.ca.slice(2, -1);
        const caContent = process.env[envVar];
        if (caContent) {
          options.ca = caContent;
        }
      } else {
        // File path
        options.ca = fs.readFileSync(tls.ca, 'utf8');
      }
    }

    // Set reject unauthorized
    if (tls.rejectUnauthorized !== undefined) {
      options.rejectUnauthorized = tls.rejectUnauthorized;
    }

    if (!options.cert || !options.key) {
      throw new Error('TLS enabled but certificate or key not provided');
    }

    return options;
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise(resolve => {
      this.server!.close(() => {
        logger.info('🛑 HTTP server stopped');
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Only accept POST requests
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      // Parse request body first (needed for HMAC verification)
      const body = await this.parseRequestBody(req);
      const rawBody = typeof body === 'string' ? body : JSON.stringify(body);

      // Check authentication with raw body
      if (!this.authenticateRequest(req, rawBody)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      // Find matching endpoint
      const endpoint = this.findEndpoint(req.url || '');
      if (!endpoint) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Endpoint not found');
        return;
      }

      // Process the webhook
      const payload: WebhookPayload = {
        endpoint: endpoint.path,
        headers: req.headers as Record<string, string>,
        body,
        timestamp: new Date().toISOString(),
      };

      await this.processWebhook(payload, endpoint);

      // Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', endpoint: endpoint.path }));
    } catch (error) {
      logger.error(
        '❌ Error handling webhook request:',
        error instanceof Error ? error : new Error(String(error))
      );

      // Handle request body too large errors with proper HTTP status
      if (error instanceof Error && error.message.includes('Request body too large')) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Payload Too Large');
        return;
      }

      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  /**
   * Authenticate incoming request
   */
  private authenticateRequest(req: http.IncomingMessage, rawBody: string): boolean {
    if (!this.config.auth || this.config.auth.type === 'none') {
      return true;
    }

    const auth = this.config.auth;

    switch (auth.type) {
      case 'bearer_token':
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return false;
        }
        const token = authHeader.substring(7);
        return token === auth.secret;

      case 'hmac':
        if (!auth.secret) {
          logger.warn('HMAC authentication configured but no secret provided');
          return false;
        }
        return this.verifyHmacSignature(req, rawBody, auth.secret);

      case 'basic':
        const basicAuth = req.headers.authorization;
        if (!basicAuth || !basicAuth.startsWith('Basic ')) {
          return false;
        }
        const credentials = Buffer.from(basicAuth.substring(6), 'base64').toString();
        const [username, password] = credentials.split(':');
        return username === auth.username && password === auth.password;

      default:
        return false;
    }
  }

  /**
   * Verify HMAC-SHA256 signature
   */
  private verifyHmacSignature(req: http.IncomingMessage, rawBody: string, secret: string): boolean {
    try {
      // Get signature from header
      const receivedSignature = req.headers['x-webhook-signature'] as string;
      if (!receivedSignature) {
        logger.warn('Missing x-webhook-signature header for HMAC authentication');
        return false;
      }

      // Calculate expected signature
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody, 'utf8');
      const calculatedSignature = `sha256=${hmac.digest('hex')}`;

      // Use timing-safe comparison to prevent timing attacks
      return this.timingSafeEqual(receivedSignature, calculatedSignature);
    } catch (error) {
      logger.error(
        `Error verifying HMAC signature: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Timing-safe string comparison to prevent timing attacks
   */
  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    // Use Node.js built-in timing-safe comparison
    try {
      const bufferA = Buffer.from(a, 'utf8');
      const bufferB = Buffer.from(b, 'utf8');
      return crypto.timingSafeEqual(bufferA, bufferB);
    } catch (error) {
      logger.error(
        `Timing-safe comparison failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Parse request body with size limits to prevent DoS attacks
   */
  private async parseRequestBody(req: http.IncomingMessage): Promise<unknown> {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

    return new Promise((resolve, reject) => {
      let body = '';
      let totalSize = 0;

      // Check Content-Length header first if present
      const contentLength = req.headers['content-length'];
      if (contentLength) {
        const length = parseInt(contentLength, 10);
        if (isNaN(length) || length > MAX_BODY_SIZE) {
          reject(new Error(`Request body too large. Maximum size allowed: ${MAX_BODY_SIZE} bytes`));
          return;
        }
      }

      req.on('data', chunk => {
        totalSize += chunk.length;

        // Check if we've exceeded the size limit
        if (totalSize > MAX_BODY_SIZE) {
          reject(new Error(`Request body too large. Maximum size allowed: ${MAX_BODY_SIZE} bytes`));
          return;
        }

        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          // Try to parse as JSON
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch {
          // If not JSON, return as string
          resolve(body);
        }
      });

      req.on('error', reject);
    });
  }

  /**
   * Find endpoint configuration
   */
  private findEndpoint(url: string) {
    if (!this.config.endpoints) {
      return null;
    }

    // Remove query parameters
    const path = url.split('?')[0];

    return this.config.endpoints.find(ep => ep.path === path);
  }

  /**
   * Process webhook payload
   */
  private async processWebhook(
    payload: WebhookPayload,
    endpoint: { path: string; transform?: string; name?: string }
  ): Promise<void> {
    logger.info(`🔔 Received webhook on ${endpoint.path}`);

    let processedData = payload.body;

    // Apply transformation if specified
    if (endpoint.transform) {
      try {
        const context = {
          webhook: payload.body,
          headers: payload.headers,
          timestamp: payload.timestamp,
        };
        const rendered = await this.liquid.parseAndRender(endpoint.transform, context);
        processedData = JSON.parse(rendered);
      } catch (error) {
        logger.error(
          `Failed to transform webhook data: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Store the processed data for webhook_input checks
    this.webhookData.set(endpoint.path, processedData);

    // Trigger any checks that depend on this webhook
    await this.triggerWebhookChecks(endpoint.path, processedData);
  }

  /**
   * Trigger checks that are waiting for webhook data
   */
  private async triggerWebhookChecks(endpoint: string, _data: unknown): Promise<void> {
    if (!this.executionEngine || !this.visorConfig) {
      return;
    }

    // Find all http_input checks that match this endpoint
    const checksToRun: string[] = [];

    for (const [checkName, checkConfig] of Object.entries(this.visorConfig.checks || {})) {
      if (checkConfig.type === 'http_input' && checkConfig.endpoint === endpoint) {
        checksToRun.push(checkName);
      }
    }

    if (checksToRun.length === 0) {
      logger.info(`ℹ️  No checks configured for webhook endpoint: ${endpoint}`);
      return;
    }

    logger.info(`🚀 Triggering ${checksToRun.length} checks for webhook: ${endpoint}`);

    try {
      // Execute the checks with webhook context
      await this.executionEngine.executeChecks({
        checks: checksToRun,
        showDetails: true,
        outputFormat: 'json',
        config: this.visorConfig,
        webhookContext: {
          webhookData: this.webhookData,
        },
      });

      logger.info(`Webhook checks completed for: ${endpoint}`);
    } catch (error) {
      logger.error(
        '❌ Failed to execute webhook checks:',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Get stored webhook data for an endpoint
   */
  public getWebhookData(endpoint: string): unknown {
    return this.webhookData.get(endpoint);
  }

  /**
   * Clear webhook data for an endpoint
   */
  public clearWebhookData(endpoint: string): void {
    this.webhookData.delete(endpoint);
  }

  /**
   * Get server status
   */
  public getStatus(): {
    running: boolean;
    port?: number;
    host?: string;
    endpoints?: string[];
  } {
    return {
      running: !!this.server,
      port: this.config.port,
      host: this.config.host,
      endpoints: this.config.endpoints?.map(ep => ep.path),
    };
  }
}

/**
 * Create and configure an HTTP server for webhooks
 */
export function createWebhookServer(
  config: HttpServerConfig,
  visorConfig?: VisorConfig,
  executionEngine?: CheckExecutionEngine
): WebhookServer {
  const server = new WebhookServer(config, visorConfig);

  if (executionEngine) {
    server.setExecutionEngine(executionEngine);
  }

  return server;
}
