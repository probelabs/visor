/**
 * Tests for the complete tool setup chain in AICheckProvider.
 *
 * This reproduces the failure observed in Jaeger trace 7cc943afbb7b8c3f15d03ba407f5f752
 * where the AI assistant had zero workflow tools available despite build-config
 * producing correct mcp_servers output with workflow entries.
 *
 * The chain: evaluateMcpServersJs → extract workflow entries → resolveTools
 *   → resolveWorkflowToolFromItem → WorkflowRegistry.get() → CustomToolsSSEServer
 *
 * If any link breaks silently, the AI gets no tools and loops forever.
 */

import { WorkflowRegistry } from '../../src/workflow-registry';
import { resolveTools } from '../../src/utils/tool-resolver';
import {
  resolveWorkflowToolFromItem,
  isWorkflowToolReference,
  WorkflowToolReference,
} from '../../src/providers/workflow-tool-executor';
import { WorkflowDefinition } from '../../src/types/workflow';
import { createSecureSandbox, compileAndRun } from '../../src/utils/sandbox';

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** Minimal workflow matching what tyk-assistant.yaml imports */
function makeWorkflow(id: string, description?: string): WorkflowDefinition {
  return {
    id,
    name: id,
    description: description || `The ${id} workflow`,
    steps: {
      'step-1': { type: 'ai', prompt: `Execute ${id}` },
    },
    inputs: [
      {
        name: 'query',
        description: 'The user query',
        schema: { type: 'string' },
      },
    ],
  };
}

/**
 * The exact ai_mcp_servers_js expression from assistant.yaml's generate-response step.
 * This is what runs in the sandbox to produce the tool configuration.
 */
const ASSISTANT_MCP_SERVERS_JS = `return outputs['build-config']?.mcp_servers ?? {};`;

/**
 * Simulates the build-config output from the trace.
 * build-config returns an object with mcp_servers mapping tool names to workflow refs.
 */
function makeBuildConfigOutput() {
  return {
    mcp_servers: {
      'slack-send-dm': {
        workflow: 'slack-send-dm',
        inputs: { user_id: 'U123' },
      },
      'slack-search': {
        workflow: 'slack-search',
      },
      'slack-read-thread': {
        workflow: 'slack-read-thread',
      },
      'slack-download-file': {
        workflow: 'slack-download-file',
      },
      engineer: {
        workflow: 'engineer',
        inputs: { repo_path: '/workspace/tyk' },
      },
      'code-explorer': {
        workflow: 'code-talk',
        inputs: { repo_path: '/workspace/tyk' },
      },
      'rebase-pr': {
        workflow: 'rebase-pr',
      },
    },
  };
}

/** All workflow IDs that tyk-assistant.yaml imports */
const ALL_WORKFLOW_IDS = [
  'assistant',
  'intent-router',
  'code-talk',
  'engineer',
  'refinement',
  'slack-send-dm',
  'slack-search',
  'slack-read-thread',
  'slack-download-file',
  'rebase-pr',
];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Tool setup chain (end-to-end)', () => {
  let registry: WorkflowRegistry;

  beforeEach(() => {
    // Reset singleton for clean state
    (WorkflowRegistry as any).instance = undefined;
    registry = WorkflowRegistry.getInstance();

    // Register all workflows that tyk-assistant.yaml would import
    for (const id of ALL_WORKFLOW_IDS) {
      registry.register(makeWorkflow(id));
    }
  });

  afterEach(() => {
    registry.clear();
  });

  // ── Step 1: Sandbox evaluation of ai_mcp_servers_js ──

  describe('Step 1: evaluateMcpServersJs sandbox evaluation', () => {
    it('should evaluate the assistant.yaml expression and return mcp_servers', () => {
      const sandbox = createSecureSandbox();
      const buildConfigOutput = makeBuildConfigOutput();

      // Build the same context that AICheckProvider.evaluateMcpServersJs builds
      const jsContext: Record<string, unknown> = {
        outputs: {
          'build-config': buildConfigOutput,
        },
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<unknown>(sandbox, ASSISTANT_MCP_SERVERS_JS, jsContext, {
        injectLog: true,
        wrapFunction: true,
        logPrefix: '[test]',
      });

      // Verify all server entries are returned
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      const servers = result as Record<string, unknown>;
      expect(Object.keys(servers)).toContain('engineer');
      expect(Object.keys(servers)).toContain('code-explorer');
      expect(Object.keys(servers)).toContain('slack-send-dm');
      expect(Object.keys(servers).length).toBe(7);
    });

    it('should return empty object when build-config output is missing', () => {
      const sandbox = createSecureSandbox();

      const jsContext: Record<string, unknown> = {
        outputs: {},
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<unknown>(sandbox, ASSISTANT_MCP_SERVERS_JS, jsContext, {
        injectLog: true,
        wrapFunction: true,
        logPrefix: '[test]',
      });

      expect(result).toEqual({});
    });
  });

  // ── Step 2: Workflow entry extraction from mcpServers ──

  describe('Step 2: Extract workflow entries from mcpServers', () => {
    it('should identify workflow entries and separate them from real MCP servers', () => {
      const mcpServers = makeBuildConfigOutput().mcp_servers as Record<string, any>;

      // This mirrors the extraction logic in ai-check-provider.ts lines 1210-1231
      const workflowEntries: WorkflowToolReference[] = [];
      const toolEntries: string[] = [];
      const toRemove: string[] = [];

      for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
        const cfg = serverConfig as Record<string, unknown>;

        if (cfg.workflow && typeof cfg.workflow === 'string') {
          workflowEntries.push({
            workflow: cfg.workflow as string,
            args: cfg.inputs as Record<string, unknown> | undefined,
            name: serverName,
          });
          toRemove.push(serverName);
        } else if (cfg.tool && typeof cfg.tool === 'string') {
          toolEntries.push(cfg.tool as string);
          toRemove.push(serverName);
        }
      }

      // All 7 entries should be extracted as workflow entries
      expect(workflowEntries.length).toBe(7);
      expect(toolEntries.length).toBe(0);

      // Verify specific entries
      const engineerEntry = workflowEntries.find(w => w.name === 'engineer');
      expect(engineerEntry).toBeDefined();
      expect(engineerEntry!.workflow).toBe('engineer');
      expect(engineerEntry!.args).toEqual({ repo_path: '/workspace/tyk' });

      // code-explorer maps to code-talk workflow with name override
      const codeExplorerEntry = workflowEntries.find(w => w.name === 'code-explorer');
      expect(codeExplorerEntry).toBeDefined();
      expect(codeExplorerEntry!.workflow).toBe('code-talk');

      // After removal, mcpServers should be empty (all were workflow refs)
      for (const name of toRemove) {
        delete mcpServers[name];
      }
      expect(Object.keys(mcpServers).length).toBe(0);
    });
  });

  // ── Step 3: resolveWorkflowToolFromItem ──

  describe('Step 3: resolveWorkflowToolFromItem', () => {
    it('should resolve workflow reference when workflow is registered', () => {
      const ref: WorkflowToolReference = {
        workflow: 'engineer',
        args: { repo_path: '/workspace/tyk' },
        name: 'engineer',
      };

      const tool = resolveWorkflowToolFromItem(ref);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('engineer');
      expect(tool!.__isWorkflowTool).toBe(true);
      expect(tool!.__workflowId).toBe('engineer');
    });

    it('should use name override for code-explorer → code-talk mapping', () => {
      const ref: WorkflowToolReference = {
        workflow: 'code-talk',
        args: { repo_path: '/workspace/tyk' },
        name: 'code-explorer',
      };

      const tool = resolveWorkflowToolFromItem(ref);
      expect(tool).toBeDefined();
      // The tool name should be the override, not the workflow id
      expect(tool!.name).toBe('code-explorer');
      expect(tool!.__workflowId).toBe('code-talk');
    });

    it('should return undefined when workflow is NOT registered', () => {
      // Clear registry to simulate missing workflows
      registry.clear();

      const ref: WorkflowToolReference = {
        workflow: 'engineer',
        name: 'engineer',
      };

      const tool = resolveWorkflowToolFromItem(ref);
      expect(tool).toBeUndefined();
    });
  });

  // ── Step 4: resolveTools (the critical aggregator) ──

  describe('Step 4: resolveTools', () => {
    it('should resolve all workflow tools when registry is populated', () => {
      const toolItems: Array<string | WorkflowToolReference> = [
        { workflow: 'engineer', name: 'engineer', args: { repo_path: '/workspace/tyk' } },
        { workflow: 'code-talk', name: 'code-explorer', args: { repo_path: '/workspace/tyk' } },
        { workflow: 'slack-send-dm', name: 'slack-send-dm', args: { user_id: 'U123' } },
        { workflow: 'slack-search', name: 'slack-search' },
        { workflow: 'slack-read-thread', name: 'slack-read-thread' },
        { workflow: 'slack-download-file', name: 'slack-download-file' },
        { workflow: 'rebase-pr', name: 'rebase-pr' },
      ];

      const tools = resolveTools(toolItems);

      // ALL 7 tools should resolve
      expect(tools.size).toBe(7);
      expect(tools.has('engineer')).toBe(true);
      expect(tools.has('code-explorer')).toBe(true);
      expect(tools.has('slack-send-dm')).toBe(true);
    });

    it('should resolve ZERO tools when registry is empty — reproducing the trace failure', () => {
      // This is the exact scenario from the trace:
      // WorkflowRegistry was empty when resolveTools was called
      registry.clear();

      const toolItems: Array<string | WorkflowToolReference> = [
        { workflow: 'engineer', name: 'engineer', args: { repo_path: '/workspace/tyk' } },
        { workflow: 'code-talk', name: 'code-explorer', args: { repo_path: '/workspace/tyk' } },
        { workflow: 'slack-send-dm', name: 'slack-send-dm' },
      ];

      const tools = resolveTools(toolItems);

      // When registry is empty, ALL tools fail to resolve
      expect(tools.size).toBe(0);
    });
  });

  // ── Step 5: Full chain integration test ──

  describe('Step 5: Full chain — sandbox → extraction → resolution', () => {
    it('should produce resolved tools from build-config output through full chain', () => {
      // Step 1: Sandbox evaluation
      const sandbox = createSecureSandbox();
      const buildConfigOutput = makeBuildConfigOutput();

      const jsContext: Record<string, unknown> = {
        outputs: { 'build-config': buildConfigOutput },
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const dynamicServers = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      // Step 2: Merge into mcpServers and validate entries
      const mcpServers: Record<string, any> = {};
      Object.assign(mcpServers, dynamicServers);

      const validServers: Record<string, any> = {};
      for (const [name, cfg] of Object.entries(mcpServers)) {
        if (typeof cfg !== 'object' || cfg === null) continue;
        const isValid =
          cfg.command || cfg.url || cfg.workflow || cfg.tool || Object.keys(cfg).length === 0;
        if (isValid) validServers[name] = cfg;
      }

      // Step 3: Extract workflow entries
      const workflowEntries: WorkflowToolReference[] = [];
      const entriesToRemove: string[] = [];

      for (const [serverName, serverConfig] of Object.entries(validServers)) {
        const cfg = serverConfig as Record<string, unknown>;
        if (cfg.workflow && typeof cfg.workflow === 'string') {
          workflowEntries.push({
            workflow: cfg.workflow as string,
            args: cfg.inputs as Record<string, unknown> | undefined,
            name: serverName,
          });
          entriesToRemove.push(serverName);
        }
      }

      // Remove extracted entries
      for (const name of entriesToRemove) {
        delete validServers[name];
      }

      // Step 4: Resolve tools
      const customToolsToLoad: Array<string | WorkflowToolReference> = [...workflowEntries];
      const tools = resolveTools(customToolsToLoad);

      // Step 5: Verify ALL tools resolved
      expect(tools.size).toBe(7);

      // Verify key tools
      const engineerTool = tools.get('engineer');
      expect(engineerTool).toBeDefined();
      expect((engineerTool as any).__isWorkflowTool).toBe(true);
      expect((engineerTool as any).__workflowId).toBe('engineer');

      const codeExplorerTool = tools.get('code-explorer');
      expect(codeExplorerTool).toBeDefined();
      expect((codeExplorerTool as any).__workflowId).toBe('code-talk');

      // Verify no remaining MCP servers (all were workflow refs)
      expect(Object.keys(validServers).length).toBe(0);
    });

    /**
     * KEY TEST: Reproduces the exact failure from trace 7cc943afbb7b8c3f15d03ba407f5f752.
     *
     * Hypothesis: Between the time workflows are imported (config loading) and the
     * time generate-response resolves tools, the WorkflowRegistry singleton could
     * be cleared/reset. This test simulates that scenario.
     */
    it('REGRESSION: should fail when registry is cleared between config load and tool resolution', () => {
      // Setup: workflows were registered during config loading
      expect(registry.has('engineer')).toBe(true);
      expect(registry.has('code-talk')).toBe(true);

      // Step 1: Sandbox evaluates build-config output correctly
      const sandbox = createSecureSandbox();
      const buildConfigOutput = makeBuildConfigOutput();

      const jsContext: Record<string, unknown> = {
        outputs: { 'build-config': buildConfigOutput },
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const dynamicServers = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      expect(Object.keys(dynamicServers)).toContain('engineer');

      // SIMULATE FAILURE: Registry gets cleared/reset after config loading
      // This could happen if:
      // 1. Another config load resets the singleton
      // 2. Hot-reload clears and re-imports (race condition)
      // 3. WorkflowRegistry.instance gets recreated (e.g., in worker/fork)
      registry.clear();

      // Step 2-3: Extract workflow entries (this still works — it's just data)
      const workflowEntries: WorkflowToolReference[] = [];
      for (const [serverName, serverConfig] of Object.entries(dynamicServers)) {
        const cfg = serverConfig as Record<string, unknown>;
        if (cfg.workflow && typeof cfg.workflow === 'string') {
          workflowEntries.push({
            workflow: cfg.workflow as string,
            args: cfg.inputs as Record<string, unknown> | undefined,
            name: serverName,
          });
        }
      }

      expect(workflowEntries.length).toBe(7);

      // Step 4: resolveTools — THIS IS WHERE IT FAILS
      const tools = resolveTools(workflowEntries);

      // ZERO tools resolve because registry is empty
      expect(tools.size).toBe(0);

      // This means the AI gets no workflow tools at all.
      // It can only use ProbeAgent built-in tools like `task`.
      // Exactly what we saw in the trace.
    });
  });

  // ── Edge cases ──

  describe('Edge cases', () => {
    it('should handle build-config output being a nested object (journal stores by reference)', () => {
      // The journal stores ReviewSummary by reference. The output field
      // from script-check-provider is { issues: [], output: <result> }.
      // When dependency results are built, we extract .output.
      const sandbox = createSecureSandbox();

      // Simulate the exact shape: dependencyResults → outputs extraction
      const buildConfigResult = {
        issues: [],
        output: makeBuildConfigOutput(),
      };

      // AICheckProvider extracts .output from ReviewSummary
      const extractedOutput =
        buildConfigResult.output !== undefined ? buildConfigResult.output : buildConfigResult;

      const jsContext: Record<string, unknown> = {
        outputs: { 'build-config': extractedOutput },
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      expect(Object.keys(result)).toContain('engineer');
      expect(Object.keys(result).length).toBe(7);
    });

    it('should handle build-config output being serialized/deserialized (deep clone)', () => {
      // The engine does JSON.parse(JSON.stringify(config)) for deep cloning.
      // Verify the chain works even if the object went through serialization.
      const sandbox = createSecureSandbox();
      const buildConfigOutput = JSON.parse(JSON.stringify(makeBuildConfigOutput()));

      const jsContext: Record<string, unknown> = {
        outputs: { 'build-config': buildConfigOutput },
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      expect(Object.keys(result)).toContain('engineer');
    });

    it('should handle partial registry — some workflows present, some missing', () => {
      // Only register a subset of workflows
      registry.clear();
      registry.register(makeWorkflow('engineer'));
      registry.register(makeWorkflow('code-talk'));
      // slack-* and rebase-pr NOT registered

      const toolItems: Array<string | WorkflowToolReference> = [
        { workflow: 'engineer', name: 'engineer' },
        { workflow: 'code-talk', name: 'code-explorer' },
        { workflow: 'slack-send-dm', name: 'slack-send-dm' },
        { workflow: 'slack-search', name: 'slack-search' },
      ];

      const tools = resolveTools(toolItems);

      // Only 2 out of 4 should resolve
      expect(tools.size).toBe(2);
      expect(tools.has('engineer')).toBe(true);
      expect(tools.has('code-explorer')).toBe(true);
      expect(tools.has('slack-send-dm')).toBe(false);
      expect(tools.has('slack-search')).toBe(false);
    });

    it('should handle isWorkflowToolReference for different input shapes', () => {
      // Proper workflow reference
      expect(isWorkflowToolReference({ workflow: 'engineer' })).toBe(true);
      expect(isWorkflowToolReference({ workflow: 'engineer', name: 'eng', args: {} })).toBe(true);

      // String (not a workflow reference)
      expect(isWorkflowToolReference('engineer')).toBe(false);

      // Null/undefined edge cases
      expect(isWorkflowToolReference(null as any)).toBe(false);
      expect(isWorkflowToolReference(undefined as any)).toBe(false);

      // Object without workflow key
      expect(isWorkflowToolReference({ tool: 'schedule' } as any)).toBe(false);
      expect(isWorkflowToolReference({} as any)).toBe(false);
    });
  });

  // ── Singleton identity verification ──

  describe('Singleton identity: static vs dynamic import', () => {
    it('should use the same WorkflowRegistry instance across static and dynamic imports', async () => {
      // This test verifies that the singleton is shared between:
      // - Static import (used by workflow-tool-executor.ts, tool-resolver.ts)
      // - Dynamic import (used by config.ts via await import())
      //
      // If these yield different instances, workflows registered during config
      // loading (dynamic import) would NOT be visible during tool resolution
      // (static import). This would cause exactly the failure we saw.

      // Register via the statically-imported registry
      registry.register(makeWorkflow('test-singleton'));

      // Dynamic import — should yield the same singleton
      const { WorkflowRegistry: DynRegistry } = await import('../../src/workflow-registry');
      const dynInstance = DynRegistry.getInstance();

      // Verify same instance identity
      expect(dynInstance).toBe(registry);
      expect(dynInstance.has('test-singleton')).toBe(true);

      // Verify all workflows from beforeEach are visible via dynamic import
      expect(dynInstance.has('engineer')).toBe(true);
      expect(dynInstance.has('code-talk')).toBe(true);
    });

    it('should share state between workflow-tool-executor and tool-resolver modules', () => {
      // Both modules use WorkflowRegistry.getInstance() internally.
      // Register a workflow and verify both can see it.

      // resolveWorkflowToolFromItem uses its own getInstance() call internally
      const ref: WorkflowToolReference = { workflow: 'engineer', name: 'engineer' };
      const tool = resolveWorkflowToolFromItem(ref);
      expect(tool).toBeDefined();

      // resolveTools also uses its own getInstance() call internally
      const tools = resolveTools([ref]);
      expect(tools.size).toBe(1);
      expect(tools.has('engineer')).toBe(true);
    });
  });

  // ── Large payload test (reproducing trace data) ──

  describe('Large payload: architecture string in build-config output', () => {
    it('should handle build-config output with large architecture string (10KB+)', () => {
      // Reproduce the exact scenario from trace 7cc943afbb7b8c3f15d03ba407f5f752:
      // build-config output has code-explorer with a 10KB+ architecture string in inputs
      const largeArchitecture = '# Tyk Project Architecture\n\n' + 'x'.repeat(15000);

      const buildConfigOutput = {
        mcp_servers: {
          'slack-send-dm': { workflow: 'slack-send-dm', inputs: {} },
          'slack-search': { workflow: 'slack-search', inputs: {} },
          'slack-read-thread': { workflow: 'slack-read-thread', inputs: {} },
          'slack-download-file': { workflow: 'slack-download-file', inputs: {} },
          'code-explorer': {
            workflow: 'code-talk',
            inputs: { architecture: largeArchitecture, repo_path: '/workspace/tyk' },
          },
          engineer: {
            workflow: 'engineer',
            inputs: { repo_path: '/workspace/tyk', architecture: largeArchitecture },
          },
          'rebase-pr': { workflow: 'rebase-pr', inputs: {} },
        },
        knowledge_content: 'Some knowledge\n' + 'y'.repeat(5000),
        bash_enabled: true,
      };

      const sandbox = createSecureSandbox();

      const jsContext: Record<string, unknown> = {
        outputs: { 'build-config': buildConfigOutput },
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      // Step 1: Sandbox evaluation with large payload
      const dynamicServers = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      expect(Object.keys(dynamicServers).length).toBe(7);
      expect(dynamicServers['engineer']).toBeDefined();
      expect(dynamicServers['engineer'].workflow).toBe('engineer');

      // Step 2: Extract and resolve
      const workflowEntries: WorkflowToolReference[] = [];
      for (const [name, cfg] of Object.entries(dynamicServers)) {
        if (cfg.workflow && typeof cfg.workflow === 'string') {
          workflowEntries.push({
            workflow: cfg.workflow as string,
            args: cfg.inputs as Record<string, unknown> | undefined,
            name,
          });
        }
      }

      expect(workflowEntries.length).toBe(7);

      // Step 3: Resolve tools
      const tools = resolveTools(workflowEntries);
      expect(tools.size).toBe(7);
      expect(tools.has('engineer')).toBe(true);
    });

    it('should handle build-config output wrapped in ReviewSummary with large payload', () => {
      const largeArchitecture = '# Architecture\n' + 'A'.repeat(20000);

      const buildConfigReviewSummary = {
        issues: [],
        output: {
          mcp_servers: {
            engineer: {
              workflow: 'engineer',
              inputs: { repo_path: '/workspace/tyk', architecture: largeArchitecture },
            },
            'code-explorer': {
              workflow: 'code-talk',
              inputs: { architecture: largeArchitecture },
            },
          },
        },
      };

      // Simulate dependency results extraction
      const dependencyResults = new Map<string, any>();
      dependencyResults.set('build-config', buildConfigReviewSummary);

      const outputs: Record<string, unknown> = {};
      for (const [checkId, result] of dependencyResults.entries()) {
        const summary = result as { output?: unknown };
        outputs[checkId] = summary.output !== undefined ? summary.output : summary;
      }

      const sandbox = createSecureSandbox();
      const jsContext: Record<string, unknown> = {
        outputs,
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      expect(Object.keys(result).length).toBe(2);
      expect(result['engineer'].workflow).toBe('engineer');
      // Verify the large architecture string survived
      expect(result['engineer'].inputs.architecture.length).toBeGreaterThan(20000);
    });
  });

  // ── Dependency results shape verification ──

  describe('Dependency results → outputs extraction', () => {
    it('should correctly extract .output from ReviewSummary-shaped dependency results', () => {
      // This verifies the exact data flow from dependency-gating.ts through
      // evaluateMcpServersJs to the sandbox expression.
      //
      // ReviewSummary from script-check-provider: { issues: [], output: <result> }
      // evaluateMcpServersJs extracts: summary.output !== undefined ? summary.output : summary
      // sandbox sees: outputs['build-config'] = <the extracted value>

      const sandbox = createSecureSandbox();

      // Simulate ReviewSummary from script-check-provider
      const buildConfigReviewSummary = {
        issues: [],
        output: makeBuildConfigOutput(),
        __histTracked: true,
      };

      // Simulate the extraction in evaluateMcpServersJs (lines 1958-1960)
      const dependencyResults = new Map<string, any>();
      dependencyResults.set('build-config', buildConfigReviewSummary);

      const outputs: Record<string, unknown> = {};
      for (const [checkId, result] of dependencyResults.entries()) {
        const summary = result as { output?: unknown };
        outputs[checkId] = summary.output !== undefined ? summary.output : summary;
      }

      // Verify the extraction worked
      expect(outputs['build-config']).toBe(buildConfigReviewSummary.output);
      expect((outputs['build-config'] as any).mcp_servers).toBeDefined();

      // Now run through sandbox
      const jsContext: Record<string, unknown> = {
        outputs,
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      expect(Object.keys(result).length).toBe(7);
      expect(result['engineer']).toBeDefined();
      expect(result['engineer'].workflow).toBe('engineer');
    });

    it('should handle ReviewSummary WITHOUT .output field (fallback to full summary)', () => {
      // Edge case: what if the ReviewSummary doesn't have an output field?
      // The extraction falls back to the full summary object.
      const sandbox = createSecureSandbox();

      // ReviewSummary without .output (e.g., from AI check provider or error case)
      const buildConfigReviewSummary = {
        issues: [],
        // No 'output' field — this is the key difference
        mcp_servers: makeBuildConfigOutput().mcp_servers,
      };

      const dependencyResults = new Map<string, any>();
      dependencyResults.set('build-config', buildConfigReviewSummary);

      const outputs: Record<string, unknown> = {};
      for (const [checkId, result] of dependencyResults.entries()) {
        const summary = result as { output?: unknown };
        // When output is undefined, falls back to the full summary
        outputs[checkId] = summary.output !== undefined ? summary.output : summary;
      }

      // Falls back to the full summary (which happens to have mcp_servers)
      expect(outputs['build-config']).toBe(buildConfigReviewSummary);

      const jsContext: Record<string, unknown> = {
        outputs,
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      // Should still work because the summary object itself has mcp_servers
      expect(Object.keys(result).length).toBe(7);
    });

    it('should handle ReviewSummary with .output set to null', () => {
      // Edge case from script-check-provider line 244: output can be null
      const sandbox = createSecureSandbox();

      const buildConfigReviewSummary = {
        issues: [],
        output: null, // Explicitly null
      };

      const dependencyResults = new Map<string, any>();
      dependencyResults.set('build-config', buildConfigReviewSummary);

      const outputs: Record<string, unknown> = {};
      for (const [checkId, result] of dependencyResults.entries()) {
        const summary = result as { output?: unknown };
        // null !== undefined, so this picks output (null)
        outputs[checkId] = summary.output !== undefined ? summary.output : summary;
      }

      // outputs['build-config'] is null!
      expect(outputs['build-config']).toBeNull();

      const jsContext: Record<string, unknown> = {
        outputs,
        inputs: {},
        pr: {
          number: 1,
          title: 'test',
          description: '',
          author: 'user',
          branch: 'feat',
          base: 'main',
        },
        files: [],
        env: {},
        memory: {},
      };

      const result = compileAndRun<Record<string, any>>(
        sandbox,
        ASSISTANT_MCP_SERVERS_JS,
        jsContext,
        { injectLog: true, wrapFunction: true, logPrefix: '[test]' }
      );

      // null?.mcp_servers is undefined, ?? {} returns {}
      expect(result).toEqual({});
    });
  });
});
