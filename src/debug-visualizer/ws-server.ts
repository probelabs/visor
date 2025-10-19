/**
 * HTTP Server for Live Debug Visualization
 *
 * Provides HTTP endpoints for polling OpenTelemetry spans,
 * enabling live visualization of visor execution via simple HTTP requests.
 *
 * Milestone 4: Live Streaming Server (Updated to HTTP polling)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

export interface ProcessedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: [number, number];
  endTime: [number, number];
  duration: number;
  attributes: Record<string, any>;
  events: Array<{
    name: string;
    time: [number, number];
    timestamp?: string;
    attributes?: Record<string, any>;
  }>;
  status: 'ok' | 'error';
}

/**
 * HTTP server for polling OTEL spans to debug visualizer UI
 */
export class DebugVisualizerServer {
  private httpServer: http.Server | null = null;
  private port: number = 3456;
  private isRunning: boolean = false;
  private config: any = null;
  private spans: ProcessedSpan[] = [];
  private results: any = null;
  private startExecutionPromise: Promise<void> | null = null;
  private startExecutionResolver: (() => void) | null = null;

  /**
   * Start the HTTP server
   */
  async start(port: number = 3456): Promise<void> {
    this.port = port;

    // Create HTTP server to serve UI and API endpoints
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Start HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, () => {
        this.isRunning = true;
        console.log(`[debug-server] Debug Visualizer running at http://localhost:${port}`);
        resolve();
      });

      this.httpServer!.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          console.log('[debug-server] HTTP server closed');
          resolve();
        });
      });
    }

    this.isRunning = false;
  }

  /**
   * Wait for the user to click "Start Execution" in the UI
   */
  async waitForStartSignal(): Promise<void> {
    console.log('[debug-server] Waiting for user to click "Start Execution"...');

    // Create a promise that will be resolved when /api/start is called
    this.startExecutionPromise = new Promise<void>((resolve) => {
      this.startExecutionResolver = resolve;
    });

    await this.startExecutionPromise;
    console.log('[debug-server] Start signal received, continuing execution');
  }

  /**
   * Clear spans for a new run (but keep server alive)
   */
  clearSpans(): void {
    console.log('[debug-server] Clearing spans for new run');
    this.spans = [];
  }

  /**
   * Store a span for HTTP polling clients
   */
  emitSpan(span: ProcessedSpan): void {
    if (!this.isRunning) {
      return;
    }

    // Store span for HTTP polling
    this.spans.push(span);
    console.log(`[debug-server] Received span: ${span.name} (total: ${this.spans.length})`);
  }

  /**
   * Set the configuration to be sent to clients
   */
  setConfig(config: any): void {
    this.config = config;
    console.log('[debug-server] Config set');
  }

  /**
   * Set the execution results to be sent to clients
   */
  setResults(results: any): void {
    this.results = results;
    console.log('[debug-server] Results set');
  }

  /**
   * Handle HTTP requests (serve UI and API endpoints)
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';

    // API endpoint: Get all spans
    if (url === '/api/spans') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        spans: this.spans,
        total: this.spans.length,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // API endpoint: Get config
    if (url === '/api/config' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        config: this.config,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // API endpoint: Update config (POST)
    if (url === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          console.log('[debug-server] Received config update request');

          // For now, just parse the YAML and update the config
          // In a real implementation, you'd use a proper YAML parser
          // For this POC, we'll accept the YAML string and the user can edit it
          console.log('[debug-server] New config YAML received (length:', data.yaml?.length, ')');

          // TODO: Parse YAML to JSON and update this.config
          // For now, just acknowledge receipt

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: true, message: 'Config update received (parsing not yet implemented)' }));
        } catch (error) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
        }
      });
      return;
    }

    // API endpoint: Get status
    if (url === '/api/status') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        isRunning: this.isRunning,
        spanCount: this.spans.length,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // API endpoint: Get results
    if (url === '/api/results') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        results: this.results,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // API endpoint: Start execution (called when user clicks "Start")
    if (url === '/api/start' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      console.log('[debug-server] Received start signal from UI');

      // Resolve the waiting promise to allow execution to continue
      if (this.startExecutionResolver) {
        this.startExecutionResolver();
        this.startExecutionResolver = null;
      }

      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // Serve index.html at root
    if (url === '/' || url === '/index.html') {
      this.serveUI(res);
      return;
    }

    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Serve the UI HTML file
   */
  private serveUI(res: http.ServerResponse): void {
    // When bundled by ncc, __dirname points to dist/
    // UI is at dist/debug-visualizer/ui/index.html
    const uiPath = path.join(__dirname, 'debug-visualizer', 'ui', 'index.html');

    // Check if UI file exists
    if (!fs.existsSync(uiPath)) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('UI file not found. Please ensure src/debug-visualizer/ui/index.html exists.');
      return;
    }

    // Read and serve UI file
    fs.readFile(uiPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading UI: ' + err.message);
        return;
      }

      // Inject HTTP server URL into HTML (at the beginning of head for early execution)
      const serverUrl = `http://localhost:${this.port}`;
      const modifiedHtml = data.replace(
        '<head>',
        `<head><script>window.DEBUG_SERVER_URL = '${serverUrl}'; console.log('[server] Injected DEBUG_SERVER_URL:', window.DEBUG_SERVER_URL);</script>`
      );

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(modifiedHtml);
    });
  }

  /**
   * Check if server is running
   */
  isServerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get span count
   */
  getSpanCount(): number {
    return this.spans.length;
  }
}

/**
 * Create and start a debug visualizer server
 */
export async function startDebugServer(port: number = 3456): Promise<DebugVisualizerServer> {
  const server = new DebugVisualizerServer();
  await server.start(port);
  return server;
}
