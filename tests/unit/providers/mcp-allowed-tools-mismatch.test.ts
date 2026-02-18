/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the MCP tool name vs allowedTools server name mismatch bug.
 *
 * Bug: When workflow tools are configured via ai_mcp_servers_js, the server
 * entry name (e.g. "code-explorer") differs from the actual MCP tool name
 * which comes from workflow.id (e.g. "tyk-code-talk"). A whitelist-based
 * allowedTools that includes the server name will NOT match the real tool name,
 * causing the MCP tool to be filtered out and unavailable to the AI agent.
 *
 * The wildcard-with-exclusions pattern (["*", "!search", "!delegate"]) avoids
 * the mismatch because it allows everything by default.
 */

import {
  resolveWorkflowToolFromItem,
  WorkflowToolReference,
} from '../../../src/providers/workflow-tool-executor';
import { WorkflowRegistry } from '../../../src/workflow-registry';

describe('MCP tool allowedTools name mismatch', () => {
  /**
   * Replicate Probe's _parseAllowedTools logic (from ProbeAgent.js:431-468)
   * so we can test the filtering behavior without instantiating ProbeAgent.
   */
  function parseAllowedTools(allowedTools: string[] | null) {
    const matchesPattern = (toolName: string, pattern: string) => {
      if (!pattern.includes('*')) {
        return toolName === pattern;
      }
      const regexPattern = pattern.replace(/\*/g, '.*');
      return new RegExp(`^${regexPattern}$`).test(toolName);
    };

    // Default: all tools allowed
    if (!allowedTools || (Array.isArray(allowedTools) && allowedTools.includes('*'))) {
      const exclusions = Array.isArray(allowedTools)
        ? allowedTools.filter(t => t.startsWith('!')).map(t => t.slice(1))
        : [];

      return {
        mode: 'all' as const,
        exclusions,
        isEnabled: (toolName: string) =>
          !exclusions.some(pattern => matchesPattern(toolName, pattern)),
      };
    }

    // Empty array: no tools
    if (Array.isArray(allowedTools) && allowedTools.length === 0) {
      return {
        mode: 'none' as const,
        isEnabled: () => false,
      };
    }

    // Specific tools allowed (whitelist)
    const allowedPatterns = allowedTools.filter(t => !t.startsWith('!'));
    return {
      mode: 'whitelist' as const,
      allowed: allowedPatterns,
      isEnabled: (toolName: string) =>
        allowedPatterns.some(pattern => matchesPattern(toolName, pattern)),
    };
  }

  /**
   * Replicate Probe's _isMcpToolAllowed logic (from ProbeAgent.js:478-480)
   */
  function isMcpToolAllowed(toolName: string, allowedTools: ReturnType<typeof parseAllowedTools>) {
    const mcpToolName = `mcp__${toolName}`;
    return allowedTools.isEnabled(mcpToolName) || allowedTools.isEnabled(toolName);
  }

  describe('bug: whitelist allowedTools uses server name, not workflow.id', () => {
    // Simulate the real scenario:
    // - ai_mcp_servers_js returns: { "code-explorer": { workflow: "code-talk", inputs: {...} } }
    // - ai_allowed_tools_js returns: ["readImage", "code-explorer", "slack-send-dm"]
    // - But the SSE server registers the tool under workflow.id, e.g. "tyk-code-talk"

    const serverName = 'code-explorer'; // name in ai_mcp_servers / ai_allowed_tools
    const workflowToolName = 'tyk-code-talk'; // actual tool name from workflow.id

    it('whitelist with server name should NOT match the actual MCP tool name', () => {
      // This is the buggy behavior: ai_allowed_tools_js builds a whitelist
      // using the server names from build-config output
      const allowedTools = parseAllowedTools(['readImage', serverName, 'slack-send-dm']);

      expect(allowedTools.mode).toBe('whitelist');

      // The server name passes...
      expect(isMcpToolAllowed(serverName, allowedTools)).toBe(true);

      // ...but the ACTUAL MCP tool name (workflow.id) does NOT pass!
      expect(isMcpToolAllowed(workflowToolName, allowedTools)).toBe(false);
    });

    it('wildcard-with-exclusions should match ANY MCP tool name', () => {
      // The fix: use ["*", "!search", "!delegate", ...] instead of explicit whitelist
      const allowedTools = parseAllowedTools([
        '*',
        '!search',
        '!query',
        '!extract',
        '!listFiles',
        '!searchFiles',
        '!delegate',
      ]);

      expect(allowedTools.mode).toBe('all');

      // Both names pass because * allows everything not excluded
      expect(isMcpToolAllowed(serverName, allowedTools)).toBe(true);
      expect(isMcpToolAllowed(workflowToolName, allowedTools)).toBe(true);

      // Native Probe tools are properly excluded
      expect(allowedTools.isEnabled('search')).toBe(false);
      expect(allowedTools.isEnabled('query')).toBe(false);
      expect(allowedTools.isEnabled('extract')).toBe(false);
      expect(allowedTools.isEnabled('delegate')).toBe(false);

      // readImage and other non-excluded tools pass
      expect(allowedTools.isEnabled('readImage')).toBe(true);
      expect(allowedTools.isEnabled('bash')).toBe(true);
    });
  });

  describe('workflow tool name comes from workflow.id, not server entry name', () => {
    const registry = WorkflowRegistry.getInstance();

    afterEach(() => {
      registry.unregister('my-code-talk');
      registry.unregister('customer-insights-talk');
    });

    it('without name override: tool uses workflow.id as its name', () => {
      // Register a mock workflow with required fields
      const result = registry.register({
        id: 'my-code-talk',
        name: 'Code Explorer',
        description: 'Explore code',
        steps: { 'step-1': { type: 'ai', prompt: 'test' } },
      } as any);
      expect(result.valid).toBe(true);

      // Without name override, the tool name is workflow.id
      const ref: WorkflowToolReference = { workflow: 'my-code-talk' };
      const tool = resolveWorkflowToolFromItem(ref);

      expect(tool).toBeDefined();
      expect(tool!.name).toBe('my-code-talk');
    });

    it('with name override: tool uses the server entry name', () => {
      const result = registry.register({
        id: 'customer-insights-talk',
        name: 'Customer Insights Explorer',
        description: 'Find customer insights',
        steps: { 'step-1': { type: 'ai', prompt: 'test' } },
      } as any);
      expect(result.valid).toBe(true);

      // With name override (as ai_mcp_servers extraction now does),
      // the tool is registered under the server entry name
      const serverEntryName = 'code-explorer';
      const ref: WorkflowToolReference = {
        workflow: 'customer-insights-talk',
        name: serverEntryName,
      };
      const tool = resolveWorkflowToolFromItem(ref);

      // Tool name matches the server entry name, not workflow.id
      expect(tool!.name).toBe(serverEntryName);
      // But __workflowId still points to the actual workflow for execution
      expect(tool!.__workflowId).toBe('customer-insights-talk');

      // Now whitelist-based allowedTools works correctly
      const whitelist = parseAllowedTools(['readImage', serverEntryName]);
      expect(isMcpToolAllowed(tool!.name, whitelist)).toBe(true);
    });

    it('without name override: whitelist fails when names differ (the original bug)', () => {
      const result = registry.register({
        id: 'customer-insights-talk',
        name: 'Customer Insights Explorer',
        description: 'Find customer insights',
        steps: { 'step-1': { type: 'ai', prompt: 'test' } },
      } as any);
      expect(result.valid).toBe(true);

      // Without name override (old behavior), tool name = workflow.id
      const serverEntryName = 'code-explorer';
      const ref: WorkflowToolReference = { workflow: 'customer-insights-talk' };
      const tool = resolveWorkflowToolFromItem(ref);

      expect(tool!.name).toBe('customer-insights-talk');
      expect(tool!.name).not.toBe(serverEntryName);

      // Whitelist with server name does NOT match the workflow.id tool name
      const whitelist = parseAllowedTools(['readImage', serverEntryName]);
      expect(isMcpToolAllowed(tool!.name, whitelist)).toBe(false);
    });
  });

  describe('ai_allowed_tools_js patterns', () => {
    it('whitelist pattern: only listed tools pass', () => {
      // Simulates: const tools = ['readImage']; ... tools.push(name); return tools;
      const tools = parseAllowedTools(['readImage', 'code-explorer', 'slack-send-dm']);

      expect(tools.isEnabled('readImage')).toBe(true);
      expect(tools.isEnabled('code-explorer')).toBe(true);
      expect(tools.isEnabled('slack-send-dm')).toBe(true);
      // Everything else blocked
      expect(tools.isEnabled('search')).toBe(false);
      expect(tools.isEnabled('delegate')).toBe(false);
      expect(tools.isEnabled('bash')).toBe(false);
      expect(tools.isEnabled('some-unknown-tool')).toBe(false);
    });

    it('exclusion pattern: everything except excluded tools pass', () => {
      // Simulates: return ['*', ...excluded.map(t => '!' + t)];
      const tools = parseAllowedTools([
        '*',
        '!search',
        '!query',
        '!extract',
        '!listFiles',
        '!searchFiles',
        '!delegate',
        '!bash',
      ]);

      // Excluded tools blocked
      expect(tools.isEnabled('search')).toBe(false);
      expect(tools.isEnabled('query')).toBe(false);
      expect(tools.isEnabled('delegate')).toBe(false);
      expect(tools.isEnabled('bash')).toBe(false);

      // Everything else allowed — including MCP tools regardless of naming
      expect(tools.isEnabled('readImage')).toBe(true);
      expect(tools.isEnabled('code-explorer')).toBe(true);
      expect(tools.isEnabled('tyk-code-talk')).toBe(true);
      expect(tools.isEnabled('slack-send-dm')).toBe(true);
      expect(tools.isEnabled('any-future-mcp-tool')).toBe(true);
    });

    it('exclusion pattern with bash enabled: bash not excluded', () => {
      // When a skill enables bash, it should NOT be in the exclusion list
      const tools = parseAllowedTools([
        '*',
        '!search',
        '!query',
        '!extract',
        '!listFiles',
        '!searchFiles',
        '!delegate',
        // bash NOT excluded because bashEnabled === true
      ]);

      expect(tools.isEnabled('bash')).toBe(true);
      expect(tools.isEnabled('search')).toBe(false);
    });

    it('null allowedTools: everything allowed (no filtering)', () => {
      const tools = parseAllowedTools(null);
      expect(tools.mode).toBe('all');
      expect(tools.isEnabled('anything')).toBe(true);
      expect(tools.isEnabled('search')).toBe(true);
      expect(tools.isEnabled('delegate')).toBe(true);
    });
  });

  describe('AICheckProvider.intersectAllowedTools (policy intersection)', () => {
    // Import the real static method from AICheckProvider
    let intersectAllowedTools: (
      configTools: string[] | undefined,
      policyTools: string[]
    ) => string[];

    beforeAll(async () => {
      // Dynamic import to avoid pulling in full provider dependencies at module level
      const { AICheckProvider } = await import('../../../src/providers/ai-check-provider');
      intersectAllowedTools = AICheckProvider.intersectAllowedTools;
    });

    it('glob patterns pass through unchanged (ProbeAgent handles them)', () => {
      const result = intersectAllowedTools(['*', '!search', '!delegate'], ['readImage', 'bash']);
      // Glob patterns must survive — Probe resolves them, not Visor
      expect(result).toEqual(['*', '!search', '!delegate']);
    });

    it('literal whitelist is intersected with policy', () => {
      const result = intersectAllowedTools(
        ['readImage', 'code-explorer', 'slack-send-dm'],
        ['readImage', 'slack-send-dm']
      );
      expect(result).toEqual(['readImage', 'slack-send-dm']);
    });

    it('undefined configTools adopts policy tools', () => {
      const result = intersectAllowedTools(undefined, ['readImage', 'bash']);
      expect(result).toEqual(['readImage', 'bash']);
    });

    it('empty configTools intersected with policy yields empty', () => {
      const result = intersectAllowedTools([], ['readImage', 'bash']);
      expect(result).toEqual([]);
    });

    it('policy with exclusion patterns also passes through when config has globs', () => {
      const result = intersectAllowedTools(['*', '!search'], ['*', '!bash']);
      // Config has globs → pass through unchanged
      expect(result).toEqual(['*', '!search']);
    });

    it('single "!" entry triggers glob passthrough', () => {
      // Even without "*", a "!" prefix indicates pattern syntax
      const result = intersectAllowedTools(['readImage', '!search'], ['readImage']);
      // Has glob-like entry ("!search") → pass through unchanged
      expect(result).toEqual(['readImage', '!search']);
    });

    it('real-world scenario: assistant.yaml whitelist vs policy restriction', () => {
      // Simulates: ai_allowed_tools_js returns explicit tool names,
      // policy allows a subset
      const fromAssistantYaml = ['readImage', 'atlassian', 'code-explorer', 'bash'];
      const fromPolicy = ['readImage', 'atlassian', 'code-explorer'];
      const result = intersectAllowedTools(fromAssistantYaml, fromPolicy);
      // bash is removed by policy
      expect(result).toEqual(['readImage', 'atlassian', 'code-explorer']);
    });

    it('real-world scenario: wildcard-exclusion pattern survives policy', () => {
      // Simulates: ai_allowed_tools_js returns ["*", "!search", "!delegate"],
      // policy tries to restrict to specific tools
      const fromConfig = ['*', '!search', '!query', '!delegate'];
      const fromPolicy = ['readImage', 'bash'];
      const result = intersectAllowedTools(fromConfig, fromPolicy);
      // Pattern must survive intact — Probe handles the resolution
      expect(result).toEqual(['*', '!search', '!query', '!delegate']);
    });
  });
});
