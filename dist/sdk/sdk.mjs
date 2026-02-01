import {
  StateMachineRunner,
  check_provider_registry_exports,
  init_check_provider_registry,
  init_runner
} from "./chunk-TS6BUNAI.mjs";
import {
  generateHumanId,
  init_human_id
} from "./chunk-EXFGO4FX.mjs";
import "./chunk-NAW3DB3I.mjs";
import {
  commandExecutor,
  init_command_executor
} from "./chunk-J2QWVDXK.mjs";
import "./chunk-VW2GBXQT.mjs";
import {
  ConfigManager,
  init_config
} from "./chunk-XWJPT5KQ.mjs";
import "./chunk-O5EZDNYL.mjs";
import "./chunk-HQL734ZI.mjs";
import {
  ExecutionJournal,
  init_snapshot_store
} from "./chunk-EORMDOZU.mjs";
import "./chunk-MPS4HVQI.mjs";
import "./chunk-ZYAUYXSW.mjs";
import "./chunk-S2RUE2RG.mjs";
import "./chunk-BHOKBQPB.mjs";
import "./chunk-CNX7V5JK.mjs";
import "./chunk-BOVFH3LI.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-IHZOSIF4.mjs";
import {
  init_logger,
  logger
} from "./chunk-3NMLT3YS.mjs";
import "./chunk-YSN4G6CI.mjs";
import "./chunk-3OMWVM6J.mjs";
import {
  __esm,
  __export,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/utils/workspace-manager.ts
import * as fsp from "fs/promises";
import * as path from "path";
function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
function sanitizePathComponent(name) {
  return name.replace(/\.\./g, "").replace(/[\/\\]/g, "-").replace(/^\.+/, "").trim() || "unnamed";
}
var WorkspaceManager;
var init_workspace_manager = __esm({
  "src/utils/workspace-manager.ts"() {
    "use strict";
    init_command_executor();
    init_logger();
    WorkspaceManager = class _WorkspaceManager {
      static instances = /* @__PURE__ */ new Map();
      sessionId;
      basePath;
      workspacePath;
      originalPath;
      config;
      initialized = false;
      mainProjectInfo = null;
      projects = /* @__PURE__ */ new Map();
      cleanupHandlersRegistered = false;
      usedNames = /* @__PURE__ */ new Set();
      constructor(sessionId, originalPath, config) {
        this.sessionId = sessionId;
        this.originalPath = originalPath;
        const configuredName = config?.name || process.env.VISOR_WORKSPACE_NAME;
        const configuredMainProjectName = config?.mainProjectName || process.env.VISOR_WORKSPACE_PROJECT;
        this.config = {
          enabled: true,
          basePath: process.env.VISOR_WORKSPACE_PATH || "/tmp/visor-workspaces",
          cleanupOnExit: true,
          name: configuredName,
          mainProjectName: configuredMainProjectName,
          ...config
        };
        this.basePath = this.config.basePath;
        const workspaceDirName = sanitizePathComponent(this.config.name || this.sessionId);
        this.workspacePath = path.join(this.basePath, workspaceDirName);
      }
      /**
       * Get or create a WorkspaceManager instance for a session
       */
      static getInstance(sessionId, originalPath, config) {
        if (!_WorkspaceManager.instances.has(sessionId)) {
          _WorkspaceManager.instances.set(
            sessionId,
            new _WorkspaceManager(sessionId, originalPath, config)
          );
        }
        return _WorkspaceManager.instances.get(sessionId);
      }
      /**
       * Clear all instances (for testing)
       */
      static clearInstances() {
        _WorkspaceManager.instances.clear();
      }
      /**
       * Check if workspace isolation is enabled
       */
      isEnabled() {
        return this.config.enabled;
      }
      /**
       * Get the workspace path
       */
      getWorkspacePath() {
        return this.workspacePath;
      }
      /**
       * Get the original working directory
       */
      getOriginalPath() {
        return this.originalPath;
      }
      /**
       * Get workspace info (only available after initialize)
       */
      getWorkspaceInfo() {
        return this.mainProjectInfo;
      }
      /**
       * Initialize the workspace - creates workspace directory and main project worktree
       */
      async initialize() {
        if (!this.config.enabled) {
          throw new Error("Workspace isolation is not enabled");
        }
        if (this.initialized && this.mainProjectInfo) {
          return this.mainProjectInfo;
        }
        logger.info(`Initializing workspace: ${this.workspacePath}`);
        await fsp.mkdir(this.workspacePath, { recursive: true });
        logger.debug(`Created workspace directory: ${this.workspacePath}`);
        const configuredMainProjectName = this.config.mainProjectName;
        const mainProjectName = sanitizePathComponent(
          configuredMainProjectName || this.extractProjectName(this.originalPath)
        );
        this.usedNames.add(mainProjectName);
        const mainProjectPath = path.join(this.workspacePath, mainProjectName);
        const isGitRepo = await this.isGitRepository(this.originalPath);
        if (isGitRepo) {
          await this.createMainProjectWorktree(mainProjectPath);
        } else {
          logger.debug(`Original path is not a git repo, creating symlink`);
          try {
            await fsp.symlink(this.originalPath, mainProjectPath);
          } catch (error) {
            throw new Error(`Failed to create symlink for main project: ${error}`);
          }
        }
        this.registerCleanupHandlers();
        this.mainProjectInfo = {
          sessionId: this.sessionId,
          workspacePath: this.workspacePath,
          mainProjectPath,
          mainProjectName,
          originalPath: this.originalPath
        };
        this.initialized = true;
        logger.info(`Workspace initialized: ${this.workspacePath}`);
        return this.mainProjectInfo;
      }
      /**
       * Add a project to the workspace (creates symlink to worktree)
       */
      async addProject(repository, worktreePath, description) {
        if (!this.initialized) {
          throw new Error("Workspace not initialized. Call initialize() first.");
        }
        let projectName = sanitizePathComponent(description || this.extractRepoName(repository));
        projectName = this.getUniqueName(projectName);
        this.usedNames.add(projectName);
        const workspacePath = path.join(this.workspacePath, projectName);
        await fsp.rm(workspacePath, { recursive: true, force: true });
        try {
          await fsp.symlink(worktreePath, workspacePath);
        } catch (error) {
          throw new Error(`Failed to create symlink for project ${projectName}: ${error}`);
        }
        this.projects.set(projectName, {
          name: projectName,
          path: workspacePath,
          worktreePath,
          repository
        });
        logger.info(`Added project to workspace: ${projectName} -> ${worktreePath}`);
        return workspacePath;
      }
      /**
       * List all projects in the workspace
       */
      listProjects() {
        return Array.from(this.projects.values());
      }
      /**
       * Cleanup the workspace
       */
      async cleanup() {
        logger.info(`Cleaning up workspace: ${this.workspacePath}`);
        try {
          if (this.mainProjectInfo) {
            const mainProjectPath = this.mainProjectInfo.mainProjectPath;
            try {
              const stats = await fsp.lstat(mainProjectPath);
              if (!stats.isSymbolicLink()) {
                await this.removeMainProjectWorktree(mainProjectPath);
              }
            } catch {
            }
          }
          await fsp.rm(this.workspacePath, { recursive: true, force: true });
          logger.debug(`Removed workspace directory: ${this.workspacePath}`);
          _WorkspaceManager.instances.delete(this.sessionId);
          this.initialized = false;
          this.mainProjectInfo = null;
          this.projects.clear();
          this.usedNames.clear();
          logger.info(`Workspace cleanup completed: ${this.sessionId}`);
        } catch (error) {
          logger.warn(`Failed to cleanup workspace: ${error}`);
        }
      }
      /**
       * Create worktree for the main project
       *
       * visor-disable: architecture - Not using WorktreeManager here because:
       * 1. WorktreeManager expects remote URLs and clones to bare repos first
       * 2. This operates on the LOCAL repo we're already in (no cloning needed)
       * 3. Adding a "local mode" to WorktreeManager would add complexity for minimal benefit
       * The git commands here are simpler (just rev-parse + worktree add) vs WorktreeManager's
       * full clone/bare-repo/fetch/worktree pipeline.
       */
      async createMainProjectWorktree(targetPath) {
        logger.debug(`Creating main project worktree: ${targetPath}`);
        const headResult = await commandExecutor.execute(
          `git -C ${shellEscape(this.originalPath)} rev-parse HEAD`,
          {
            timeout: 1e4
          }
        );
        if (headResult.exitCode !== 0) {
          throw new Error(`Failed to get HEAD: ${headResult.stderr}`);
        }
        const headRef = headResult.stdout.trim();
        const createCmd = `git -C ${shellEscape(this.originalPath)} worktree add --detach ${shellEscape(targetPath)} ${shellEscape(headRef)}`;
        const result = await commandExecutor.execute(createCmd, { timeout: 6e4 });
        if (result.exitCode !== 0) {
          throw new Error(`Failed to create main project worktree: ${result.stderr}`);
        }
        logger.debug(`Created main project worktree at ${targetPath}`);
      }
      /**
       * Remove main project worktree
       */
      async removeMainProjectWorktree(worktreePath) {
        logger.debug(`Removing main project worktree: ${worktreePath}`);
        const removeCmd = `git -C ${shellEscape(this.originalPath)} worktree remove ${shellEscape(worktreePath)} --force`;
        const result = await commandExecutor.execute(removeCmd, { timeout: 3e4 });
        if (result.exitCode !== 0) {
          logger.warn(`Failed to remove worktree via git: ${result.stderr}`);
        }
      }
      /**
       * Check if a path is a git repository
       */
      async isGitRepository(dirPath) {
        try {
          const result = await commandExecutor.execute(
            `git -C ${shellEscape(dirPath)} rev-parse --git-dir`,
            {
              timeout: 5e3
            }
          );
          return result.exitCode === 0;
        } catch {
          return false;
        }
      }
      /**
       * Extract project name from path
       */
      extractProjectName(dirPath) {
        return path.basename(dirPath);
      }
      /**
       * Extract repository name from owner/repo format
       */
      extractRepoName(repository) {
        if (repository.includes("://") || repository.startsWith("git@")) {
          const match = repository.match(/[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/);
          if (match) {
            return match[1].split("/").pop() || repository;
          }
        }
        if (repository.includes("/")) {
          return repository.split("/").pop() || repository;
        }
        return repository;
      }
      /**
       * Get a unique name by appending a number if needed
       */
      getUniqueName(baseName) {
        if (!this.usedNames.has(baseName)) {
          return baseName;
        }
        let counter = 2;
        let uniqueName = `${baseName}-${counter}`;
        while (this.usedNames.has(uniqueName)) {
          counter++;
          uniqueName = `${baseName}-${counter}`;
        }
        return uniqueName;
      }
      /**
       * Register cleanup handlers for process exit
       */
      registerCleanupHandlers() {
        if (this.cleanupHandlersRegistered || !this.config.cleanupOnExit) {
          return;
        }
        this.cleanupHandlersRegistered = true;
      }
    };
  }
});

// src/state-machine/context/build-engine-context.ts
var build_engine_context_exports = {};
__export(build_engine_context_exports, {
  buildEngineContextForRun: () => buildEngineContextForRun,
  initializeWorkspace: () => initializeWorkspace
});
function applyCriticalityDefaults(cfg) {
  const checks = cfg.checks || {};
  for (const id of Object.keys(checks)) {
    const c = checks[id];
    if (!c.criticality) c.criticality = "policy";
    if (c.criticality === "info" && typeof c.continue_on_failure === "undefined")
      c.continue_on_failure = true;
  }
}
function buildEngineContextForRun(workingDirectory, config, prInfo, debug, maxParallelism, failFast, requestedChecks) {
  const clonedConfig = JSON.parse(JSON.stringify(config));
  const checks = {};
  applyCriticalityDefaults(clonedConfig);
  for (const [checkId, checkConfig] of Object.entries(clonedConfig.checks || {})) {
    checks[checkId] = {
      tags: checkConfig.tags || [],
      triggers: (Array.isArray(checkConfig.on) ? checkConfig.on : [checkConfig.on]).filter(
        Boolean
      ),
      group: checkConfig.group,
      providerType: checkConfig.type || "ai",
      // Normalize depends_on to array (supports string | string[])
      dependencies: Array.isArray(checkConfig.depends_on) ? checkConfig.depends_on : checkConfig.depends_on ? [checkConfig.depends_on] : []
    };
  }
  if (requestedChecks && requestedChecks.length > 0) {
    for (const checkName of requestedChecks) {
      if (!checks[checkName] && !clonedConfig.checks?.[checkName]) {
        logger.debug(`[StateMachine] Synthesizing minimal config for legacy check: ${checkName}`);
        if (!clonedConfig.checks) {
          clonedConfig.checks = {};
        }
        clonedConfig.checks[checkName] = {
          type: "ai",
          prompt: `Perform ${checkName} analysis`
        };
        checks[checkName] = {
          tags: [],
          triggers: [],
          group: "default",
          providerType: "ai",
          dependencies: []
        };
      }
    }
  }
  const journal = new ExecutionJournal();
  const memory = MemoryStore.getInstance(clonedConfig.memory);
  return {
    mode: "state-machine",
    config: clonedConfig,
    checks,
    journal,
    memory,
    workingDirectory,
    originalWorkingDirectory: workingDirectory,
    sessionId: generateHumanId(),
    event: prInfo.eventType,
    debug,
    maxParallelism,
    failFast,
    requestedChecks: requestedChecks && requestedChecks.length > 0 ? requestedChecks : void 0,
    // Store prInfo for later access (e.g., in getOutputHistorySnapshot)
    prInfo
  };
}
async function initializeWorkspace(context) {
  const workspaceConfig = context.config.workspace;
  const isEnabled = workspaceConfig?.enabled !== false && process.env.VISOR_WORKSPACE_ENABLED !== "false";
  if (!isEnabled) {
    logger.debug("[Workspace] Workspace isolation is disabled");
    return context;
  }
  const originalPath = context.workingDirectory || process.cwd();
  try {
    const keepWorkspace = process.env.VISOR_KEEP_WORKSPACE === "true";
    const workspace = WorkspaceManager.getInstance(context.sessionId, originalPath, {
      enabled: true,
      basePath: workspaceConfig?.base_path || process.env.VISOR_WORKSPACE_PATH || "/tmp/visor-workspaces",
      cleanupOnExit: keepWorkspace ? false : workspaceConfig?.cleanup_on_exit !== false,
      name: workspaceConfig?.name || process.env.VISOR_WORKSPACE_NAME,
      mainProjectName: workspaceConfig?.main_project_name || process.env.VISOR_WORKSPACE_PROJECT
    });
    const info = await workspace.initialize();
    context.workspace = workspace;
    context.workingDirectory = info.mainProjectPath;
    context.originalWorkingDirectory = originalPath;
    try {
      process.env.VISOR_WORKSPACE_ROOT = info.workspacePath;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = info.mainProjectPath;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT_NAME = info.mainProjectName;
      process.env.VISOR_ORIGINAL_WORKDIR = originalPath;
    } catch {
    }
    logger.info(`[Workspace] Initialized workspace: ${info.workspacePath}`);
    logger.debug(`[Workspace] Main project at: ${info.mainProjectPath}`);
    if (keepWorkspace) {
      logger.info(`[Workspace] Keeping workspace after execution (--keep-workspace)`);
    }
    return context;
  } catch (error) {
    logger.warn(`[Workspace] Failed to initialize workspace: ${error}`);
    logger.debug("[Workspace] Continuing without workspace isolation");
    return context;
  }
}
var init_build_engine_context = __esm({
  "src/state-machine/context/build-engine-context.ts"() {
    "use strict";
    init_snapshot_store();
    init_memory_store();
    init_human_id();
    init_logger();
    init_workspace_manager();
  }
});

// src/state-machine/execution/summary.ts
var summary_exports = {};
__export(summary_exports, {
  convertToReviewSummary: () => convertToReviewSummary
});
function convertToReviewSummary(groupedResults, statistics) {
  const allIssues = [];
  for (const checkResults of Object.values(groupedResults)) {
    for (const checkResult of checkResults) {
      if (checkResult.issues && checkResult.issues.length > 0) {
        allIssues.push(...checkResult.issues);
      }
    }
  }
  if (statistics) {
    for (const checkStats of statistics.checks) {
      if (checkStats.errorMessage) {
        allIssues.push({
          file: "system",
          line: 0,
          endLine: void 0,
          ruleId: "system/error",
          message: checkStats.errorMessage,
          severity: "error",
          category: "logic",
          suggestion: void 0,
          replacement: void 0
        });
      }
    }
  }
  return {
    issues: allIssues
  };
}
var init_summary = __esm({
  "src/state-machine/execution/summary.ts"() {
    "use strict";
  }
});

// src/state-machine-execution-engine.ts
init_runner();
init_logger();
import * as path2 from "path";
import * as fs from "fs";
var StateMachineExecutionEngine = class _StateMachineExecutionEngine {
  workingDirectory;
  executionContext;
  debugServer;
  _lastContext;
  _lastRunner;
  constructor(workingDirectory, octokit, debugServer) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.debugServer = debugServer;
  }
  /**
   * Execute checks using the state machine engine
   *
   * Converts CheckExecutionOptions -> executeGroupedChecks() -> AnalysisResult
   */
  async executeChecks(options) {
    const startTime = Date.now();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    try {
      if (options.config?.memory) {
        const { MemoryStore: MemoryStore2 } = await import("./memory-store-RW5N2NGJ.mjs");
        const memoryStore = MemoryStore2.getInstance(options.config.memory);
        await memoryStore.initialize();
        logger.debug("Memory store initialized");
      }
      const { GitRepositoryAnalyzer } = await import("./git-repository-analyzer-HJC4MYW4.mjs");
      const gitAnalyzer = new GitRepositoryAnalyzer(options.workingDirectory);
      logger.info("Analyzing local git repository...");
      const repositoryInfo = await gitAnalyzer.analyzeRepository();
      if (!repositoryInfo.isGitRepository) {
        return this.createErrorResult(
          repositoryInfo,
          "Not a git repository or no changes found",
          startTime,
          timestamp,
          options.checks
        );
      }
      const prInfo = gitAnalyzer.toPRInfo(repositoryInfo);
      try {
        const evt = options.webhookContext?.eventType;
        if (evt) prInfo.eventType = evt;
      } catch {
      }
      const filteredChecks = this.filterChecksByTags(
        options.checks,
        options.config,
        options.tagFilter || options.config?.tag_filter
      );
      if (filteredChecks.length === 0) {
        logger.warn("No checks match the tag filter criteria");
        return this.createErrorResult(
          repositoryInfo,
          "No checks match the tag filter criteria",
          startTime,
          timestamp,
          options.checks
        );
      }
      try {
        const map = options?.webhookContext?.webhookData;
        if (map) {
          const { CheckProviderRegistry } = await import("./check-provider-registry-CVUONJ5A.mjs");
          const reg = CheckProviderRegistry.getInstance();
          const p = reg.getProvider("http_input");
          if (p && typeof p.setWebhookContext === "function") p.setWebhookContext(map);
          const prev = this.executionContext || {};
          this.setExecutionContext({ ...prev, webhookContext: { webhookData: map } });
        }
      } catch {
      }
      logger.info(`Executing checks: ${filteredChecks.join(", ")}`);
      const executionResult = await this.executeGroupedChecks(
        prInfo,
        filteredChecks,
        options.timeout,
        options.config,
        options.outputFormat,
        options.debug,
        options.maxParallelism,
        options.failFast,
        options.tagFilter
      );
      const executionTime = Date.now() - startTime;
      const reviewSummary = this.convertGroupedResultsToReviewSummary(
        executionResult.results,
        executionResult.statistics
      );
      let debugInfo;
      if (options.debug && reviewSummary.debug) {
        debugInfo = {
          provider: reviewSummary.debug.provider,
          model: reviewSummary.debug.model,
          processingTime: reviewSummary.debug.processingTime,
          parallelExecution: options.checks.length > 1,
          checksExecuted: options.checks,
          totalApiCalls: reviewSummary.debug.totalApiCalls || options.checks.length,
          apiCallDetails: reviewSummary.debug.apiCallDetails
        };
      }
      try {
        const histSnap = this.getOutputHistorySnapshot();
        reviewSummary.history = histSnap;
      } catch {
      }
      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: filteredChecks,
        executionStatistics: executionResult.statistics,
        debug: debugInfo
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error occurred";
      logger.error("Error executing checks: " + message);
      const strictEnv = process.env.VISOR_STRICT_ERRORS === "true";
      if (strictEnv) {
        throw error;
      }
      const fallbackRepositoryInfo = {
        title: "Error during analysis",
        body: `Error: ${message || "Unknown error"}`,
        author: "system",
        base: "main",
        head: "HEAD",
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        isGitRepository: false,
        workingDirectory: options.workingDirectory || process.cwd()
      };
      return this.createErrorResult(
        fallbackRepositoryInfo,
        message || "Unknown error occurred",
        startTime,
        timestamp,
        options.checks
      );
    }
  }
  /**
   * Get execution context (used by state machine to propagate hooks)
   */
  getExecutionContext() {
    return this.executionContext;
  }
  /**
   * Set execution context for external callers
   */
  setExecutionContext(context) {
    this.executionContext = context;
  }
  /**
   * Reset per-run state (no-op for state machine engine)
   *
   * The state machine engine is stateless per-run by design.
   * Each execution creates a fresh journal and context.
   * This method exists only for backward compatibility with test framework.
   *
   * @deprecated This is a no-op. State machine engine doesn't maintain per-run state.
   */
  resetPerRunState() {
  }
  /**
   * Execute grouped checks using the state machine engine
   *
   * M4: Production-ready with full telemetry and debug server support
   */
  async executeGroupedChecks(prInfo, checks, timeout, config, outputFormat, debug, maxParallelism, failFast, tagFilter, _pauseGate) {
    if (debug) {
      logger.info("[StateMachine] Using state machine engine");
    }
    if (!config) {
      const { ConfigManager: ConfigManager2 } = await import("./config-DXX64GD3.mjs");
      const configManager = new ConfigManager2();
      config = await configManager.getDefaultConfig();
      logger.debug("[StateMachine] Using default configuration (no config provided)");
    }
    const configWithTagFilter = tagFilter ? {
      ...config,
      tag_filter: tagFilter
    } : config;
    const context = this.buildEngineContext(
      configWithTagFilter,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      checks
      // Pass the explicit checks list
    );
    const { initializeWorkspace: initializeWorkspace2 } = (init_build_engine_context(), __toCommonJS(build_engine_context_exports));
    await initializeWorkspace2(context);
    context.executionContext = this.getExecutionContext();
    this._lastContext = context;
    let frontendsHost;
    if (Array.isArray(configWithTagFilter.frontends) && configWithTagFilter.frontends.length > 0) {
      try {
        const { EventBus } = await import("./event-bus-5BEVPQ6T.mjs");
        const { FrontendsHost } = await import("./host-H3AWNZ2F.mjs");
        const bus = new EventBus();
        context.eventBus = bus;
        frontendsHost = new FrontendsHost(bus, logger);
        if (process.env.VISOR_DEBUG === "true") {
          try {
            const fns = (configWithTagFilter.frontends || []).map((f) => ({
              name: f?.name,
              hasConfig: !!f?.config,
              cfg: f?.config || void 0
            }));
            logger.info(`[Frontends] Loading specs: ${JSON.stringify(fns)}`);
          } catch {
          }
        }
        await frontendsHost.load(configWithTagFilter.frontends);
        let owner;
        let name;
        let prNum;
        let headSha;
        try {
          const anyInfo = prInfo;
          owner = anyInfo?.eventContext?.repository?.owner?.login || process.env.GITHUB_REPOSITORY?.split("/")?.[0];
          name = anyInfo?.eventContext?.repository?.name || process.env.GITHUB_REPOSITORY?.split("/")?.[1];
          prNum = typeof anyInfo?.number === "number" ? anyInfo.number : void 0;
          headSha = anyInfo?.eventContext?.pull_request?.head?.sha || process.env.GITHUB_SHA;
        } catch {
        }
        const repoObj = owner && name ? { owner, name } : void 0;
        const octokit = this.executionContext?.octokit;
        if (!headSha && repoObj && prNum && octokit && typeof octokit.rest?.pulls?.get === "function") {
          try {
            const { data } = await octokit.rest.pulls.get({
              owner: repoObj.owner,
              repo: repoObj.name,
              pull_number: prNum
            });
            headSha = data && data.head && data.head.sha || headSha;
          } catch {
          }
        }
        try {
          const prev = this.getExecutionContext() || {};
          this.setExecutionContext({ ...prev, eventBus: bus });
          try {
            context.executionContext = this.getExecutionContext();
          } catch {
          }
        } catch {
        }
        await frontendsHost.startAll(() => ({
          eventBus: bus,
          logger,
          // Provide the active (possibly tag-filtered) config so frontends can read groups, etc.
          config: configWithTagFilter,
          run: {
            runId: context.sessionId,
            repo: repoObj,
            pr: prNum,
            headSha,
            event: context.event || prInfo?.eventType,
            actor: prInfo?.eventContext?.sender?.login || (typeof process.env.GITHUB_ACTOR === "string" ? process.env.GITHUB_ACTOR : void 0)
          },
          octokit,
          webhookContext: this.executionContext?.webhookContext,
          // Surface any injected test doubles for Slack as well
          slack: this.executionContext?.slack || this.executionContext?.slackClient
        }));
        try {
          bus.on("HumanInputRequested", async (envelope) => {
            try {
              const ev = envelope && envelope.payload || envelope;
              let channel = ev?.channel;
              let threadTs = ev?.threadTs;
              if (!channel || !threadTs) {
                try {
                  const anyCfg = configWithTagFilter || {};
                  const slackCfg = anyCfg.slack || {};
                  const endpoint = slackCfg.endpoint || "/bots/slack/support";
                  const map = this.executionContext?.webhookContext?.webhookData;
                  const payload = map?.get(endpoint);
                  const e = payload?.event;
                  const derivedTs = String(e?.thread_ts || e?.ts || e?.event_ts || "");
                  const derivedCh = String(e?.channel || "");
                  if (derivedCh && derivedTs) {
                    channel = channel || derivedCh;
                    threadTs = threadTs || derivedTs;
                  }
                } catch {
                }
              }
              const checkId = String(ev?.checkId || "unknown");
              const threadKey = ev?.threadKey || (channel && threadTs ? `${channel}:${threadTs}` : "session");
              const baseDir = process.env.VISOR_SNAPSHOT_DIR || path2.resolve(process.cwd(), ".visor", "snapshots");
              fs.mkdirSync(baseDir, { recursive: true });
              const filePath = path2.join(baseDir, `${threadKey}-${checkId}.json`);
              await this.saveSnapshotToFile(filePath);
              logger.info(`[Snapshot] Saved run snapshot: ${filePath}`);
              try {
                await bus.emit({
                  type: "SnapshotSaved",
                  checkId: ev?.checkId || "unknown",
                  channel,
                  threadTs,
                  threadKey,
                  filePath
                });
              } catch {
              }
            } catch (e) {
              logger.warn(
                `[Snapshot] Failed to save snapshot on HumanInputRequested: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          });
        } catch {
        }
      } catch (err) {
        logger.warn(
          `[Frontends] Failed to initialize frontends: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const runner = new StateMachineRunner(context, this.debugServer);
    this._lastRunner = runner;
    const result = await runner.run();
    if (frontendsHost && typeof frontendsHost.stopAll === "function") {
      try {
        await frontendsHost.stopAll();
      } catch {
      }
    }
    if (debug) {
      logger.info("[StateMachine] Execution complete");
    }
    try {
      const { SessionRegistry } = await import("./session-registry-4E6YRQ77.mjs");
      const sessionRegistry = SessionRegistry.getInstance();
      sessionRegistry.clearAllSessions();
    } catch (error) {
      logger.debug(`[StateMachine] Failed to cleanup sessions: ${error}`);
    }
    if (context.workspace) {
      try {
        await context.workspace.cleanup();
      } catch (error) {
        logger.debug(`[StateMachine] Failed to cleanup workspace: ${error}`);
      }
    }
    return result;
  }
  /**
   * Build the engine context for state machine execution
   */
  buildEngineContext(config, prInfo, debug, maxParallelism, failFast, requestedChecks) {
    const { buildEngineContextForRun: buildEngineContextForRun2 } = (init_build_engine_context(), __toCommonJS(build_engine_context_exports));
    return buildEngineContextForRun2(
      this.workingDirectory,
      config,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      requestedChecks
    );
  }
  /**
   * Get output history snapshot for test framework compatibility
   * Extracts output history from the journal
   */
  getOutputHistorySnapshot() {
    const journal = this._lastContext?.journal;
    if (!journal) {
      logger.debug("[StateMachine][DEBUG] getOutputHistorySnapshot: No journal found");
      return {};
    }
    const sessionId = this._lastContext?.sessionId;
    if (!sessionId) {
      logger.debug("[StateMachine][DEBUG] getOutputHistorySnapshot: No sessionId found");
      return {};
    }
    const snapshot = journal.beginSnapshot();
    const allEntries = journal.readVisible(sessionId, snapshot, void 0);
    logger.debug(
      `[StateMachine][DEBUG] getOutputHistorySnapshot: Found ${allEntries.length} journal entries`
    );
    const outputHistory = {};
    for (const entry of allEntries) {
      const checkId = entry.checkId;
      if (!outputHistory[checkId]) {
        outputHistory[checkId] = [];
      }
      try {
        if (entry && typeof entry.result === "object" && entry.result.__skipped) {
          continue;
        }
      } catch {
      }
      const payload = entry.result.output !== void 0 ? entry.result.output : entry.result;
      try {
        if (payload && typeof payload === "object" && payload.forEachItems && Array.isArray(payload.forEachItems)) {
          continue;
        }
      } catch {
      }
      if (payload !== void 0) outputHistory[checkId].push(payload);
    }
    logger.debug(
      `[StateMachine][DEBUG] getOutputHistorySnapshot result: ${JSON.stringify(Object.keys(outputHistory))}`
    );
    for (const [checkId, outputs] of Object.entries(outputHistory)) {
      logger.debug(`[StateMachine][DEBUG]   ${checkId}: ${outputs.length} outputs`);
    }
    return outputHistory;
  }
  /**
   * Save a JSON snapshot of the last run's state and journal to a file (experimental).
   * Does not include secrets. Intended for debugging and future resume support.
   */
  async saveSnapshotToFile(filePath) {
    const fs2 = await import("fs/promises");
    const ctx = this._lastContext;
    const runner = this._lastRunner;
    if (!ctx || !runner) {
      throw new Error("No prior execution context to snapshot");
    }
    const journal = ctx.journal;
    const snapshotId = journal.beginSnapshot();
    const entries = journal.readVisible(ctx.sessionId, snapshotId, void 0);
    const state = runner.getState();
    const serializableState = serializeRunState(state);
    const payload = {
      version: 1,
      sessionId: ctx.sessionId,
      event: ctx.event,
      wave: state.wave,
      state: serializableState,
      journal: entries,
      requestedChecks: ctx.requestedChecks || []
    };
    await fs2.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  /**
   * Load a snapshot JSON from file and return it. Resume support can build on this.
   */
  async loadSnapshotFromFile(filePath) {
    const fs2 = await import("fs/promises");
    const raw = await fs2.readFile(filePath, "utf8");
    return JSON.parse(raw);
  }
  /**
   * Filter checks by tag filter
   */
  filterChecksByTags(checks, config, tagFilter) {
    return checks.filter((checkName) => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        return true;
      }
      const checkTags = checkConfig.tags || [];
      if (!tagFilter || !tagFilter.include && !tagFilter.exclude) {
        return checkTags.length === 0;
      }
      if (checkTags.length === 0) {
        return true;
      }
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some((tag) => checkTags.includes(tag));
        if (hasExcludedTag) return false;
      }
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some((tag) => checkTags.includes(tag));
        if (!hasIncludedTag) return false;
      }
      return true;
    });
  }
  /**
   * Create an error result in AnalysisResult format
   */
  createErrorResult(repositoryInfo, errorMessage, startTime, timestamp, checksExecuted) {
    const executionTime = Date.now() - startTime;
    return {
      repositoryInfo,
      reviewSummary: {
        issues: [
          {
            file: "system",
            line: 0,
            endLine: void 0,
            ruleId: "system/error",
            message: errorMessage,
            severity: "error",
            category: "logic",
            suggestion: void 0,
            replacement: void 0
          }
        ]
      },
      executionTime,
      timestamp,
      checksExecuted
    };
  }
  /**
   * Convert GroupedCheckResults to ReviewSummary
   * Aggregates all check results into a single ReviewSummary
   */
  convertGroupedResultsToReviewSummary(groupedResults, statistics) {
    const { convertToReviewSummary: convertToReviewSummary2 } = (init_summary(), __toCommonJS(summary_exports));
    return convertToReviewSummary2(groupedResults, statistics);
  }
  /**
   * Evaluate failure conditions for a check result
   *
   * This method provides backward compatibility with the legacy engine by
   * delegating to the FailureConditionEvaluator.
   *
   * @param checkName - The name of the check being evaluated
   * @param reviewSummary - The review summary containing check results
   * @param config - The Visor configuration containing failure conditions
   * @param previousOutputs - Optional previous check outputs for cross-check conditions
   * @param authorAssociation - Optional GitHub author association for permission checks
   * @returns Array of failure condition evaluation results
   */
  async evaluateFailureConditions(checkName, reviewSummary, config, previousOutputs, authorAssociation) {
    const { FailureConditionEvaluator } = await import("./failure-condition-evaluator-G4HMJPXF.mjs");
    const evaluator = new FailureConditionEvaluator();
    const { addEvent } = await import("./trace-helpers-VP6QYVBX.mjs");
    const { addFailIfTriggered } = await import("./metrics-7PP3EJUH.mjs");
    const checkConfig = config.checks?.[checkName];
    if (!checkConfig) {
      return [];
    }
    const rawSchema = checkConfig.schema || "code-review";
    const checkSchema = typeof rawSchema === "string" ? rawSchema : "code-review";
    const checkGroup = checkConfig.group || "default";
    const results = [];
    if (config.fail_if) {
      const failed = await evaluator.evaluateSimpleCondition(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        config.fail_if,
        previousOutputs || {}
      );
      try {
        addEvent("fail_if.evaluated", {
          "visor.check.id": checkName,
          scope: "global",
          expression: String(config.fail_if),
          result: failed ? "triggered" : "not_triggered"
        });
        if (failed) {
          addEvent("fail_if.triggered", {
            "visor.check.id": checkName,
            scope: "global",
            expression: String(config.fail_if)
          });
          addFailIfTriggered(checkName, "global");
        }
      } catch {
      }
      results.push({
        conditionName: "global_fail_if",
        failed,
        expression: config.fail_if,
        message: failed ? `Global failure condition met: ${config.fail_if}` : void 0,
        severity: "error",
        haltExecution: false
      });
    }
    if (checkConfig.fail_if) {
      const failed = await evaluator.evaluateSimpleCondition(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        checkConfig.fail_if,
        previousOutputs || {}
      );
      try {
        addEvent("fail_if.evaluated", {
          "visor.check.id": checkName,
          scope: "check",
          expression: String(checkConfig.fail_if),
          result: failed ? "triggered" : "not_triggered"
        });
        if (failed) {
          addEvent("fail_if.triggered", {
            "visor.check.id": checkName,
            scope: "check",
            expression: String(checkConfig.fail_if)
          });
          addFailIfTriggered(checkName, "check");
        }
      } catch {
      }
      results.push({
        conditionName: `${checkName}_fail_if`,
        failed,
        expression: checkConfig.fail_if,
        message: failed ? `Check failure condition met: ${checkConfig.fail_if}` : void 0,
        severity: "error",
        haltExecution: false
      });
    }
    const globalConditions = config.failure_conditions;
    const checkConditions = checkConfig.failure_conditions;
    if (globalConditions || checkConditions) {
      const legacyResults = await evaluator.evaluateConditions(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        globalConditions,
        checkConditions,
        previousOutputs,
        authorAssociation
      );
      results.push(...legacyResults);
    }
    return results;
  }
  /**
   * Get repository status
   * @returns Repository status information
   */
  async getRepositoryStatus() {
    try {
      const { GitRepositoryAnalyzer } = await import("./git-repository-analyzer-HJC4MYW4.mjs");
      const analyzer = new GitRepositoryAnalyzer(this.workingDirectory);
      const info = await analyzer.analyzeRepository();
      return {
        isGitRepository: info.isGitRepository,
        branch: info.head,
        // Use head as branch name
        hasChanges: info.isGitRepository && (info.files?.length > 0 || false),
        filesChanged: info.isGitRepository ? info.files?.length || 0 : 0
      };
    } catch {
      return {
        isGitRepository: false,
        hasChanges: false
      };
    }
  }
  /**
   * Check if current directory is a git repository
   * @returns True if git repository, false otherwise
   */
  async isGitRepository() {
    const status = await this.getRepositoryStatus();
    return status.isGitRepository;
  }
  /**
   * Get list of available check types
   * @returns Array of check type names
   */
  static getAvailableCheckTypes() {
    const { CheckProviderRegistry } = (init_check_provider_registry(), __toCommonJS(check_provider_registry_exports));
    const registry = CheckProviderRegistry.getInstance();
    return registry.getAvailableProviders();
  }
  /**
   * Validate check types and return valid/invalid lists
   * @param checks - Array of check type names to validate
   * @returns Object with valid and invalid check types
   */
  static validateCheckTypes(checks) {
    const availableTypes = _StateMachineExecutionEngine.getAvailableCheckTypes();
    const valid = [];
    const invalid = [];
    for (const check of checks) {
      if (availableTypes.includes(check)) {
        valid.push(check);
      } else {
        invalid.push(check);
      }
    }
    return { valid, invalid };
  }
  /**
   * Format the status column for execution statistics
   * Used by execution-statistics-formatting tests
   */
  formatStatusColumn(stats) {
    if (stats.skipped) {
      if (stats.skipReason === "if_condition") {
        return "\u23ED if";
      } else if (stats.skipReason === "fail_fast") {
        return "\u23ED ff";
      } else if (stats.skipReason === "dependency_failed") {
        return "\u23ED dep";
      }
      return "\u23ED";
    }
    const totalRuns = stats.totalRuns;
    const successfulRuns = stats.successfulRuns;
    const failedRuns = stats.failedRuns;
    if (failedRuns > 0 && successfulRuns > 0) {
      return `\u2714/\u2716 ${successfulRuns}/${totalRuns}`;
    } else if (failedRuns > 0) {
      return totalRuns === 1 ? "\u2716" : `\u2716 \xD7${totalRuns}`;
    } else {
      return totalRuns === 1 ? "\u2714" : `\u2714 \xD7${totalRuns}`;
    }
  }
  /**
   * Format the details column for execution statistics
   * Used by execution-statistics-formatting tests
   */
  formatDetailsColumn(stats) {
    const parts = [];
    if (stats.outputsProduced !== void 0 && stats.outputsProduced > 0) {
      parts.push(`\u2192${stats.outputsProduced}`);
    }
    if (stats.issuesBySeverity.critical > 0) {
      parts.push(`${stats.issuesBySeverity.critical}\u{1F534}`);
    }
    if (stats.issuesBySeverity.error > 0 && stats.issuesBySeverity.critical === 0) {
      parts.push(`${stats.issuesBySeverity.error}\u274C`);
    }
    if (stats.issuesBySeverity.warning > 0) {
      parts.push(`${stats.issuesBySeverity.warning}\u26A0\uFE0F`);
    }
    if (stats.issuesBySeverity.info > 0 && stats.issuesBySeverity.critical === 0 && stats.issuesBySeverity.error === 0 && stats.issuesBySeverity.warning === 0) {
      parts.push(`${stats.issuesBySeverity.info}\u{1F4A1}`);
    }
    if (stats.errorMessage) {
      parts.push(this.truncate(stats.errorMessage, 40));
    }
    if (stats.skipCondition) {
      parts.push(this.truncate(stats.skipCondition, 40));
    }
    return parts.join(" ");
  }
  /**
   * Truncate a string to a maximum length
   * Used by formatDetailsColumn
   */
  truncate(str, maxLength) {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 3) + "...";
  }
};
function serializeRunState(state) {
  return {
    ...state,
    levelQueue: state.levelQueue,
    eventQueue: state.eventQueue,
    activeDispatches: Array.from(state.activeDispatches.entries()),
    completedChecks: Array.from(state.completedChecks.values()),
    stats: Array.from(state.stats.entries()),
    historyLog: state.historyLog,
    forwardRunGuards: Array.from(state.forwardRunGuards.values()),
    currentLevelChecks: Array.from(state.currentLevelChecks.values()),
    currentWaveCompletions: Array.from(
      state.currentWaveCompletions || []
    ),
    // failedChecks is an internal Set added by stats/dispatch layers; keep it if present
    failedChecks: Array.from(state.failedChecks || []),
    pendingRunScopes: Array.from((state.pendingRunScopes || /* @__PURE__ */ new Map()).entries()).map(([k, v]) => [
      k,
      v
    ])
  };
}

// src/sdk.ts
init_config();
async function loadConfig(configOrPath, options) {
  const cm = new ConfigManager();
  if (typeof configOrPath === "object" && configOrPath !== null) {
    cm.validateConfig(configOrPath, options?.strict ?? false);
    const defaultConfig = {
      version: "1.0",
      checks: {},
      max_parallelism: 3,
      fail_fast: false
    };
    return {
      ...defaultConfig,
      ...configOrPath,
      checks: configOrPath.checks || {}
    };
  }
  if (typeof configOrPath === "string") {
    return cm.loadConfig(configOrPath);
  }
  return cm.findAndLoadConfig();
}
function resolveChecks(checkIds, config) {
  if (!config?.checks) return Array.from(new Set(checkIds));
  const resolved = /* @__PURE__ */ new Set();
  const visiting = /* @__PURE__ */ new Set();
  const result = [];
  const dfs = (id, stack = []) => {
    if (resolved.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...stack, id].join(" -> ");
      throw new Error(`Circular dependency detected involving check: ${id} (path: ${cycle})`);
    }
    visiting.add(id);
    const deps = config.checks[id]?.depends_on || [];
    for (const d of deps) dfs(d, [...stack, id]);
    if (!result.includes(id)) result.push(id);
    visiting.delete(id);
    resolved.add(id);
  };
  for (const id of checkIds) dfs(id);
  return result;
}
async function runChecks(opts = {}) {
  const cm = new ConfigManager();
  let config;
  if (opts.config) {
    cm.validateConfig(opts.config, opts.strictValidation ?? false);
    config = opts.config;
  } else if (opts.configPath) {
    config = await cm.loadConfig(opts.configPath);
  } else {
    config = await cm.findAndLoadConfig();
  }
  const checks = opts.checks && opts.checks.length > 0 ? resolveChecks(opts.checks, config) : Object.keys(config.checks || {});
  const engine = new StateMachineExecutionEngine(opts.cwd);
  if (opts.executionContext) {
    engine.setExecutionContext(opts.executionContext);
  }
  const result = await engine.executeChecks({
    checks,
    workingDirectory: opts.cwd,
    timeout: opts.timeoutMs,
    maxParallelism: opts.maxParallelism,
    failFast: opts.failFast,
    outputFormat: opts.output?.format,
    config,
    debug: opts.debug,
    tagFilter: opts.tagFilter
  });
  return result;
}
export {
  loadConfig,
  resolveChecks,
  runChecks
};
//# sourceMappingURL=sdk.mjs.map