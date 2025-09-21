import { WebhookServer } from '../../src/webhook-server';
import { HttpServerConfig, VisorConfig } from '../../src/types/config';
import { CheckExecutionEngine } from '../../src/check-execution-engine';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';

// Mock modules
jest.mock('fs');
jest.mock('http');
jest.mock('https');
jest.mock('../../src/check-execution-engine');

describe('WebhookServer', () => {
  let server: WebhookServer;
  let mockConfig: HttpServerConfig;
  let mockVisorConfig: VisorConfig;
  let mockExecutionEngine: jest.Mocked<CheckExecutionEngine>;
  let mockHttpServer: {
    listen: jest.Mock;
    close: jest.Mock;
    on: jest.Mock;
  };
  let mockHttpsServer: {
    listen: jest.Mock;
    close: jest.Mock;
    on: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      enabled: true,
      port: 8080,
      host: '0.0.0.0',
      auth: {
        type: 'bearer_token',
        secret: 'test-secret',
      },
      endpoints: [
        { path: '/webhook/github', name: 'github-events' },
        { path: '/webhook/jenkins', name: 'jenkins-builds' },
      ],
    };

    mockVisorConfig = {
      version: '1.0',
      checks: {
        'github-webhook': {
          type: 'http_input',
          endpoint: '/webhook/github',
          on: ['webhook_received'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: true,
        },
      },
      http_server: mockConfig,
    };

    mockExecutionEngine = {
      executeChecks: jest.fn(),
      executeGroupedChecks: jest.fn(),
    } as unknown as jest.Mocked<CheckExecutionEngine>;

    // Mock HTTP server
    mockHttpServer = {
      listen: jest.fn((port, host, callback) => callback()),
      close: jest.fn(callback => callback()),
      on: jest.fn(),
    };

    // Mock HTTPS server
    mockHttpsServer = {
      listen: jest.fn((port, host, callback) => callback()),
      close: jest.fn(callback => callback()),
      on: jest.fn(),
    };

    (http.createServer as jest.Mock).mockReturnValue(mockHttpServer);
    (https.createServer as jest.Mock).mockReturnValue(mockHttpsServer);

    server = new WebhookServer(mockConfig, mockVisorConfig);
    server.setExecutionEngine(mockExecutionEngine);
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(server).toBeDefined();
      expect(server.getStatus()).toEqual({
        running: false,
        port: 8080,
        host: '0.0.0.0',
        endpoints: ['/webhook/github', '/webhook/jenkins'],
      });
    });

    it('should detect GitHub Actions environment', () => {
      const originalEnv = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = 'true';

      const githubServer = new WebhookServer(mockConfig, mockVisorConfig);
      expect(githubServer).toBeDefined();

      process.env.GITHUB_ACTIONS = originalEnv;
    });
  });

  describe('start', () => {
    it('should start HTTP server when enabled', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await server.start();

      expect(http.createServer).toHaveBeenCalled();
      expect(mockHttpServer.listen).toHaveBeenCalledWith(8080, '0.0.0.0', expect.any(Function));
      expect(consoleLogSpy).toHaveBeenCalledWith('🔌 HTTP server listening on http://0.0.0.0:8080');
      expect(consoleLogSpy).toHaveBeenCalledWith('📍 Registered endpoints:');

      consoleLogSpy.mockRestore();
    });

    it('should not start when disabled', async () => {
      const disabledConfig: HttpServerConfig = { ...mockConfig, enabled: false };
      const disabledServer = new WebhookServer(disabledConfig, mockVisorConfig);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await disabledServer.start();

      expect(http.createServer).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('🔌 HTTP server is disabled in configuration');

      consoleLogSpy.mockRestore();
    });

    it('should not start in GitHub Actions environment', async () => {
      const originalEnv = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = 'true';

      const githubServer = new WebhookServer(mockConfig, mockVisorConfig);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await githubServer.start();

      expect(http.createServer).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🔌 HTTP server disabled in GitHub Actions environment'
      );

      consoleLogSpy.mockRestore();
      process.env.GITHUB_ACTIONS = originalEnv;
    });

    it('should start HTTPS server when TLS is enabled', async () => {
      const tlsConfig: HttpServerConfig = {
        ...mockConfig,
        tls: {
          enabled: true,
          cert: '/path/to/cert.pem',
          key: '/path/to/key.pem',
        },
      };

      (fs.readFileSync as jest.Mock).mockImplementation(path => {
        if (path === '/path/to/cert.pem') return 'CERT_CONTENT';
        if (path === '/path/to/key.pem') return 'KEY_CONTENT';
        return '';
      });

      const tlsServer = new WebhookServer(tlsConfig, mockVisorConfig);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await tlsServer.start();

      expect(https.createServer).toHaveBeenCalledWith(
        expect.objectContaining({
          cert: 'CERT_CONTENT',
          key: 'KEY_CONTENT',
        }),
        expect.any(Function)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🔌 HTTPS server listening on https://0.0.0.0:8080'
      );

      consoleLogSpy.mockRestore();
    });

    it('should handle server start errors', async () => {
      const errorServer = {
        listen: jest.fn(),
        on: jest.fn((event, callback) => {
          if (event === 'error') {
            callback(new Error('Port already in use'));
          }
        }),
      };

      (http.createServer as jest.Mock).mockReturnValue(errorServer);
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(server.start()).rejects.toThrow('Port already in use');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Failed to start HTTP server:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('should stop the server', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await server.start();
      await server.stop();

      expect(mockHttpServer.close).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('🛑 HTTP server stopped');

      consoleLogSpy.mockRestore();
    });

    it('should handle stop when server not started', async () => {
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  describe('TLS configuration', () => {
    it('should load certificates from file paths', async () => {
      const tlsConfig: HttpServerConfig = {
        ...mockConfig,
        tls: {
          enabled: true,
          cert: '/etc/ssl/cert.pem',
          key: '/etc/ssl/key.pem',
          ca: '/etc/ssl/ca.pem',
          rejectUnauthorized: true,
        },
      };

      (fs.readFileSync as jest.Mock).mockImplementation(path => {
        if (path === '/etc/ssl/cert.pem') return 'CERT_CONTENT';
        if (path === '/etc/ssl/key.pem') return 'KEY_CONTENT';
        if (path === '/etc/ssl/ca.pem') return 'CA_CONTENT';
        return '';
      });

      const tlsServer = new WebhookServer(tlsConfig, mockVisorConfig);
      await tlsServer.start();

      expect(https.createServer).toHaveBeenCalledWith(
        expect.objectContaining({
          cert: 'CERT_CONTENT',
          key: 'KEY_CONTENT',
          ca: 'CA_CONTENT',
          rejectUnauthorized: true,
        }),
        expect.any(Function)
      );
    });

    it('should load certificates from environment variables', async () => {
      const originalEnv = { ...process.env };
      process.env.TLS_CERT = '-----BEGIN CERTIFICATE-----\nCERT_DATA\n-----END CERTIFICATE-----';
      process.env.TLS_KEY = '-----BEGIN PRIVATE KEY-----\nKEY_DATA\n-----END PRIVATE KEY-----';
      process.env.TLS_CA = '-----BEGIN CERTIFICATE-----\nCA_DATA\n-----END CERTIFICATE-----';

      const tlsConfig: HttpServerConfig = {
        ...mockConfig,
        tls: {
          enabled: true,
          cert: '${TLS_CERT}',
          key: '${TLS_KEY}',
          ca: '${TLS_CA}',
        },
      };

      const tlsServer = new WebhookServer(tlsConfig, mockVisorConfig);
      await tlsServer.start();

      expect(https.createServer).toHaveBeenCalledWith(
        expect.objectContaining({
          cert: process.env.TLS_CERT,
          key: process.env.TLS_KEY,
          ca: process.env.TLS_CA,
        }),
        expect.any(Function)
      );

      process.env = originalEnv;
    });

    it('should handle inline certificate content', async () => {
      const tlsConfig: HttpServerConfig = {
        ...mockConfig,
        tls: {
          enabled: true,
          cert: '-----BEGIN CERTIFICATE-----\nINLINE_CERT\n-----END CERTIFICATE-----',
          key: '-----BEGIN PRIVATE KEY-----\nINLINE_KEY\n-----END PRIVATE KEY-----',
        },
      };

      const tlsServer = new WebhookServer(tlsConfig, mockVisorConfig);
      await tlsServer.start();

      expect(https.createServer).toHaveBeenCalledWith(
        expect.objectContaining({
          cert: '-----BEGIN CERTIFICATE-----\nINLINE_CERT\n-----END CERTIFICATE-----',
          key: '-----BEGIN PRIVATE KEY-----\nINLINE_KEY\n-----END PRIVATE KEY-----',
        }),
        expect.any(Function)
      );
    });

    it('should throw error when TLS enabled but certificates missing', async () => {
      const invalidTlsConfig: HttpServerConfig = {
        ...mockConfig,
        tls: {
          enabled: true,
          // Missing cert and key
        },
      };

      const tlsServer = new WebhookServer(invalidTlsConfig, mockVisorConfig);
      await expect(tlsServer.start()).rejects.toThrow(
        'TLS enabled but certificate or key not provided'
      );
    });

    it('should throw error when environment variable not found', async () => {
      const tlsConfig: HttpServerConfig = {
        ...mockConfig,
        tls: {
          enabled: true,
          cert: '${MISSING_CERT}',
          key: '${MISSING_KEY}',
        },
      };

      const tlsServer = new WebhookServer(tlsConfig, mockVisorConfig);
      await expect(tlsServer.start()).rejects.toThrow(
        'TLS certificate environment variable MISSING_CERT not found'
      );
    });
  });

  describe('webhook processing', () => {
    let mockRequest: {
      method: string;
      url: string;
      headers: Record<string, string>;
      on: jest.Mock;
    };
    let mockResponse: {
      writeHead: jest.Mock;
      end: jest.Mock;
    };
    let requestHandler: Function;

    beforeEach(async () => {
      mockRequest = {
        method: 'POST',
        url: '/webhook/github',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        on: jest.fn(),
      };

      mockResponse = {
        writeHead: jest.fn(),
        end: jest.fn(),
      };

      // Capture the request handler
      (http.createServer as jest.Mock).mockImplementation(handler => {
        requestHandler = handler;
        return mockHttpServer;
      });

      await server.start();
    });

    it('should handle valid webhook request', async () => {
      const webhookData = { action: 'opened', repository: { full_name: 'test/repo' } };

      mockRequest.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          callback(Buffer.from(JSON.stringify(webhookData)));
        } else if (event === 'end') {
          callback();
        }
      });

      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await requestHandler(mockRequest, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(mockResponse.end).toHaveBeenCalledWith(
        JSON.stringify({ status: 'success', endpoint: '/webhook/github' })
      );
      expect(consoleLogSpy).toHaveBeenCalledWith('🔔 Received webhook on /webhook/github');

      consoleLogSpy.mockRestore();
    });

    it('should reject non-POST requests', async () => {
      mockRequest.method = 'GET';

      await requestHandler(mockRequest, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(405, { 'Content-Type': 'text/plain' });
      expect(mockResponse.end).toHaveBeenCalledWith('Method Not Allowed');
    });

    it('should reject unauthorized requests', async () => {
      mockRequest.headers.authorization = 'Bearer wrong-secret';

      await requestHandler(mockRequest, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'text/plain' });
      expect(mockResponse.end).toHaveBeenCalledWith('Unauthorized');
    });

    it('should reject unknown endpoints', async () => {
      mockRequest.url = '/webhook/unknown';

      mockRequest.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          callback(Buffer.from('{}'));
        } else if (event === 'end') {
          callback();
        }
      });

      await requestHandler(mockRequest, mockResponse);

      expect(mockResponse.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'text/plain' });
      expect(mockResponse.end).toHaveBeenCalledWith('Endpoint not found');
    });

    it('should trigger checks for webhook endpoint', async () => {
      const webhookData = { action: 'opened', repository: { full_name: 'test/repo' } };

      mockRequest.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          callback(Buffer.from(JSON.stringify(webhookData)));
        } else if (event === 'end') {
          callback();
        }
      });

      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await requestHandler(mockRequest, mockResponse);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '🚀 Triggering 1 checks for webhook: /webhook/github'
      );
      expect(mockExecutionEngine.executeChecks).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: ['github-webhook'],
          showDetails: true,
          outputFormat: 'json',
          config: mockVisorConfig,
        })
      );

      consoleLogSpy.mockRestore();
    });

    it('should handle basic auth', async () => {
      const basicAuthConfig: HttpServerConfig = {
        ...mockConfig,
        auth: {
          type: 'basic',
          username: 'admin',
          password: 'secret',
        },
      };

      const basicServer = new WebhookServer(basicAuthConfig, mockVisorConfig);
      (http.createServer as jest.Mock).mockImplementation(handler => {
        requestHandler = handler;
        return mockHttpServer;
      });
      await basicServer.start();

      // Valid basic auth
      mockRequest.headers.authorization = 'Basic ' + Buffer.from('admin:secret').toString('base64');
      mockRequest.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          callback(Buffer.from('{}'));
        } else if (event === 'end') {
          callback();
        }
      });

      await requestHandler(mockRequest, mockResponse);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });

      // Invalid basic auth
      mockRequest.headers.authorization = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
      await requestHandler(mockRequest, mockResponse);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'text/plain' });
    });

    it('should handle no auth configuration', async () => {
      const noAuthConfig: HttpServerConfig = {
        ...mockConfig,
        auth: undefined,
      };

      const noAuthServer = new WebhookServer(noAuthConfig, mockVisorConfig);
      (http.createServer as jest.Mock).mockImplementation(handler => {
        requestHandler = handler;
        return mockHttpServer;
      });
      await noAuthServer.start();

      delete mockRequest.headers.authorization;
      mockRequest.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          callback(Buffer.from('{}'));
        } else if (event === 'end') {
          callback();
        }
      });

      await requestHandler(mockRequest, mockResponse);
      expect(mockResponse.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
    });

    it('should apply transformation to webhook data', async () => {
      const transformConfig: HttpServerConfig = {
        ...mockConfig,
        endpoints: [
          {
            path: '/webhook/transform',
            name: 'transform-test',
            transform: '{"transformed": "{{ webhook.original }}"}',
          },
        ],
      };

      const transformServer = new WebhookServer(transformConfig, mockVisorConfig);
      (http.createServer as jest.Mock).mockImplementation(handler => {
        requestHandler = handler;
        return mockHttpServer;
      });
      await transformServer.start();

      mockRequest.url = '/webhook/transform';
      mockRequest.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          callback(Buffer.from('{"original": "data"}'));
        } else if (event === 'end') {
          callback();
        }
      });

      await requestHandler(mockRequest, mockResponse);

      const webhookData = transformServer.getWebhookData('/webhook/transform');
      expect(webhookData).toEqual({ transformed: 'data' });
    });
  });

  describe('webhook data management', () => {
    it('should store and retrieve webhook data', () => {
      server.clearWebhookData('/test');
      expect(server.getWebhookData('/test')).toBeUndefined();

      const testData = { test: 'data' };
      // Simulate storing data (normally done during webhook processing)
      (server as unknown as { webhookData: Map<string, unknown> }).webhookData.set(
        '/test',
        testData
      );

      expect(server.getWebhookData('/test')).toEqual(testData);
    });

    it('should clear webhook data', () => {
      const testData = { test: 'data' };
      (server as unknown as { webhookData: Map<string, unknown> }).webhookData.set(
        '/test',
        testData
      );

      server.clearWebhookData('/test');
      expect(server.getWebhookData('/test')).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('should return server status', () => {
      expect(server.getStatus()).toEqual({
        running: false,
        port: 8080,
        host: '0.0.0.0',
        endpoints: ['/webhook/github', '/webhook/jenkins'],
      });
    });

    it('should update running status after start', async () => {
      await server.start();
      expect(server.getStatus().running).toBe(true);
    });
  });
});
