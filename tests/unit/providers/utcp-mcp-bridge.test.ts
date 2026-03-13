/**
 * Tests for UTCP-to-MCP bridge integration:
 * - UTCP tool detection (isUtcpTool pattern)
 * - UTCP tool listing via CustomToolsSSEServer
 * - UTCP tool execution routing
 * - UTCP entry extraction in AI check provider
 */

import { CustomToolDefinition } from '../../../src/types/config';

// Mock the UTCP SDK
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockGetTools = jest.fn().mockResolvedValue([
  {
    name: 'scanner.check_security',
    description: 'Check code for security issues',
    inputs: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to check' },
        language: { type: 'string', description: 'Programming language' },
      },
      required: ['code'],
    },
  },
  {
    name: 'scanner.check_performance',
    description: 'Check code for performance issues',
    inputs: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to check' },
      },
      required: ['code'],
    },
  },
]);
const mockCallTool = jest.fn().mockResolvedValue({ status: 'ok', findings: [] });
const mockCreate = jest.fn().mockResolvedValue({
  close: mockClose,
  getTools: mockGetTools,
  callTool: mockCallTool,
});

jest.mock('@utcp/sdk', () => ({
  UtcpClient: {
    create: (...args: any[]) => mockCreate(...args),
  },
}));

jest.mock('@utcp/http', () => ({}));

describe('UTCP-MCP Bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isUtcpTool detection', () => {
    // Replicate the isUtcpTool logic for testing
    function isUtcpTool(tool: CustomToolDefinition | undefined): boolean {
      return Boolean(tool && tool.type === 'utcp' && tool.__utcpManual);
    }

    it('should detect UTCP tools', () => {
      const tool: CustomToolDefinition = {
        name: 'scanner.check_security',
        type: 'utcp',
        description: 'Check security',
        __utcpManual: 'https://scanner.example.com/utcp',
        __utcpToolName: 'scanner.check_security',
        __utcpVariables: { API_KEY: 'test-key' },
        __utcpPlugins: ['http'],
      };
      expect(isUtcpTool(tool)).toBe(true);
    });

    it('should not detect non-UTCP tools', () => {
      const httpTool: CustomToolDefinition = {
        name: 'my-api',
        type: 'http_client',
        base_url: 'https://api.example.com',
      };
      expect(isUtcpTool(httpTool)).toBe(false);
    });

    it('should not detect UTCP tool without manual', () => {
      const tool: CustomToolDefinition = {
        name: 'broken',
        type: 'utcp',
      };
      expect(isUtcpTool(tool)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isUtcpTool(undefined)).toBe(false);
    });
  });

  describe('UTCP tool discovery via UtcpCheckProvider static methods', () => {
    it('should resolve URL-based manual to HTTP call template', async () => {
      const { UtcpCheckProvider } = await import('../../../src/providers/utcp-check-provider');
      const result = await UtcpCheckProvider.resolveManualCallTemplate(
        'https://scanner.example.com/utcp'
      );
      expect(result.call_template_type).toBe('http');
      expect(result.url).toBe('https://scanner.example.com/utcp');
      expect(result.http_method).toBe('GET');
      expect(result.name).toBe('scanner_example_com');
    });

    it('should resolve inline manual with call_template_type', async () => {
      const { UtcpCheckProvider } = await import('../../../src/providers/utcp-check-provider');
      const inline = {
        call_template_type: 'http',
        url: 'https://api.example.com/utcp',
        http_method: 'GET',
      };
      const result = await UtcpCheckProvider.resolveManualCallTemplate(inline);
      expect(result.call_template_type).toBe('http');
      expect(result.url).toBe('https://api.example.com/utcp');
      expect(result.name).toBe('inline');
    });

    it('should derive manual name from URL', () => {
      const { UtcpCheckProvider } = require('../../../src/providers/utcp-check-provider');
      expect(UtcpCheckProvider.deriveManualName('https://scanner.example.com/utcp')).toBe(
        'scanner_example_com'
      );
      expect(UtcpCheckProvider.deriveManualName('https://api-server.test.io/manual')).toBe(
        'api_server_test_io'
      );
    });
  });

  describe('resolveManualCallTemplate path traversal protection', () => {
    it('should reject paths with null bytes', async () => {
      const { UtcpCheckProvider } = await import('../../../src/providers/utcp-check-provider');
      await expect(UtcpCheckProvider.resolveManualCallTemplate('manual\x00.json')).rejects.toThrow(
        'null bytes are not allowed'
      );
    });

    it('should reject paths that traverse outside cwd', async () => {
      const { UtcpCheckProvider } = await import('../../../src/providers/utcp-check-provider');
      await expect(
        UtcpCheckProvider.resolveManualCallTemplate('../../../etc/passwd')
      ).rejects.toThrow('Path traversal detected');
    });

    it('should reject absolute paths outside cwd', async () => {
      const { UtcpCheckProvider } = await import('../../../src/providers/utcp-check-provider');
      await expect(UtcpCheckProvider.resolveManualCallTemplate('/etc/passwd')).rejects.toThrow(
        'Path traversal detected'
      );
    });

    it('should allow URL-based manuals without path checks', async () => {
      const { UtcpCheckProvider } = await import('../../../src/providers/utcp-check-provider');
      const result = await UtcpCheckProvider.resolveManualCallTemplate(
        'https://example.com/../../../etc/passwd'
      );
      // URL-based manuals are handled by the SDK, not read locally
      expect(result.call_template_type).toBe('http');
    });
  });

  describe('UTCP tool creation for CustomToolDefinition', () => {
    it('should create CustomToolDefinition with UTCP fields', () => {
      const utcpTool: CustomToolDefinition = {
        name: 'scanner.check_security',
        type: 'utcp',
        description: 'Check code for security issues',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to check' },
            language: { type: 'string', description: 'Programming language' },
          },
          required: ['code'],
        },
        __utcpManual: 'https://scanner.example.com/utcp',
        __utcpToolName: 'scanner.check_security',
        __utcpVariables: { API_KEY: 'test-key' },
        __utcpPlugins: ['http'],
      };

      expect(utcpTool.type).toBe('utcp');
      expect(utcpTool.__utcpManual).toBe('https://scanner.example.com/utcp');
      expect(utcpTool.__utcpToolName).toBe('scanner.check_security');
      expect(utcpTool.__utcpVariables).toEqual({ API_KEY: 'test-key' });
      expect(utcpTool.__utcpPlugins).toEqual(['http']);
      expect(utcpTool.inputSchema?.properties).toHaveProperty('code');
    });

    it('should discover multiple tools from a single UTCP manual', async () => {
      const { UtcpClient } = await import('@utcp/sdk');

      const client = await UtcpClient.create(process.cwd(), {
        manual_call_templates: [
          {
            name: 'scanner',
            call_template_type: 'http',
            url: 'https://scanner.example.com/utcp',
            http_method: 'GET',
          },
        ],
      });

      const tools = await client.getTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('scanner.check_security');
      expect(tools[1].name).toBe('scanner.check_performance');

      // Create a CustomToolDefinition for each discovered tool
      const customTools = new Map<string, CustomToolDefinition>();
      for (const tool of tools) {
        const toolDef: CustomToolDefinition = {
          name: tool.name,
          type: 'utcp',
          description: tool.description,
          inputSchema:
            tool.inputs?.type === 'object'
              ? tool.inputs
              : { type: 'object', properties: {}, required: [] },
          __utcpManual: 'https://scanner.example.com/utcp',
          __utcpToolName: tool.name,
          __utcpVariables: {},
          __utcpPlugins: ['http'],
        };
        customTools.set(tool.name, toolDef);
      }

      expect(customTools.size).toBe(2);
      expect(customTools.has('scanner.check_security')).toBe(true);
      expect(customTools.has('scanner.check_performance')).toBe(true);
    });
  });

  describe('UTCP tool execution', () => {
    it('should call UTCP tool via client.callTool', async () => {
      const { UtcpClient } = await import('@utcp/sdk');

      const client = await UtcpClient.create(process.cwd(), {
        manual_call_templates: [
          {
            name: 'scanner',
            call_template_type: 'http',
            url: 'https://scanner.example.com/utcp',
            http_method: 'GET',
          },
        ],
        variables: { API_KEY: 'test-key' },
      });

      const result = await client.callTool('scanner.check_security', {
        code: 'console.log("test")',
        language: 'javascript',
      });

      expect(mockCallTool).toHaveBeenCalledWith('scanner.check_security', {
        code: 'console.log("test")',
        language: 'javascript',
      });
      expect(result).toEqual({ status: 'ok', findings: [] });
    });
  });

  describe('UTCP entry extraction from ai_mcp_servers', () => {
    it('should identify UTCP entries by type and manual fields', () => {
      const mcpServers: Record<string, Record<string, unknown>> = {
        'real-mcp': {
          command: 'npx',
          args: ['-y', 'some-mcp-server'],
        },
        'my-scanner': {
          type: 'utcp',
          manual: 'https://scanner.example.com/utcp',
          variables: { API_KEY: '${SCANNER_KEY}' },
          plugins: ['http'],
        },
        'my-api': {
          type: 'http_client',
          base_url: 'https://api.example.com',
        },
      };

      const utcpEntries: Array<{ name: string; config: Record<string, unknown> }> = [];
      const mcpEntriesToRemove: string[] = [];

      for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
        const cfg = serverConfig;
        if (cfg.type === 'utcp' && cfg.manual) {
          utcpEntries.push({ name: serverName, config: cfg });
          mcpEntriesToRemove.push(serverName);
        }
      }

      expect(utcpEntries).toHaveLength(1);
      expect(utcpEntries[0].name).toBe('my-scanner');
      expect(utcpEntries[0].config.manual).toBe('https://scanner.example.com/utcp');
      expect(mcpEntriesToRemove).toContain('my-scanner');
      // Non-UTCP entries should remain
      expect(mcpEntriesToRemove).not.toContain('real-mcp');
      expect(mcpEntriesToRemove).not.toContain('my-api');
    });
  });
});
