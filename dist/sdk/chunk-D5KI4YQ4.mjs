import {
  init_logger,
  logger
} from "./chunk-PO7X5XI7.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/dependency-resolver.ts
var DependencyResolver;
var init_dependency_resolver = __esm({
  "src/dependency-resolver.ts"() {
    "use strict";
    DependencyResolver = class {
      /**
       * Build dependency graph from check dependencies
       */
      static buildDependencyGraph(checkDependencies) {
        const nodes = /* @__PURE__ */ new Map();
        for (const checkId of Object.keys(checkDependencies)) {
          nodes.set(checkId, {
            id: checkId,
            dependencies: checkDependencies[checkId] || [],
            dependents: [],
            depth: 0
          });
        }
        for (const [checkId, dependencies] of Object.entries(checkDependencies)) {
          for (const depId of dependencies || []) {
            if (!nodes.has(depId)) {
              throw new Error(`Check "${checkId}" depends on "${depId}" but "${depId}" is not defined`);
            }
            const depNode = nodes.get(depId);
            depNode.dependents.push(checkId);
          }
        }
        const cycleDetection = this.detectCycles(nodes);
        if (cycleDetection.hasCycles) {
          return {
            nodes,
            executionOrder: [],
            hasCycles: true,
            cycleNodes: cycleDetection.cycleNodes
          };
        }
        const executionOrder = this.topologicalSort(nodes);
        return {
          nodes,
          executionOrder,
          hasCycles: false
        };
      }
      /**
       * Detect cycles in the dependency graph using DFS
       */
      static detectCycles(nodes) {
        const visited = /* @__PURE__ */ new Set();
        const recursionStack = /* @__PURE__ */ new Set();
        const cycleNodes = [];
        const dfs = (nodeId) => {
          if (recursionStack.has(nodeId)) {
            cycleNodes.push(nodeId);
            return true;
          }
          if (visited.has(nodeId)) {
            return false;
          }
          visited.add(nodeId);
          recursionStack.add(nodeId);
          const node = nodes.get(nodeId);
          if (node) {
            for (const depId of node.dependencies) {
              if (dfs(depId)) {
                cycleNodes.push(nodeId);
                return true;
              }
            }
          }
          recursionStack.delete(nodeId);
          return false;
        };
        for (const nodeId of nodes.keys()) {
          if (!visited.has(nodeId)) {
            if (dfs(nodeId)) {
              return { hasCycles: true, cycleNodes: [...new Set(cycleNodes)] };
            }
          }
        }
        return { hasCycles: false };
      }
      /**
       * Perform topological sort to determine execution order
       * Groups checks that can run in parallel at each level
       */
      static topologicalSort(nodes) {
        const remainingNodes = new Map(nodes);
        const executionGroups = [];
        let level = 0;
        while (remainingNodes.size > 0) {
          const readyNodes = [];
          for (const [nodeId, node] of remainingNodes.entries()) {
            const unmetDependencies = node.dependencies.filter((depId) => remainingNodes.has(depId));
            if (unmetDependencies.length === 0) {
              readyNodes.push(nodeId);
            }
          }
          if (readyNodes.length === 0) {
            throw new Error("Unable to resolve dependencies - possible circular dependency detected");
          }
          executionGroups.push({
            parallel: readyNodes,
            level
          });
          for (const nodeId of readyNodes) {
            remainingNodes.delete(nodeId);
          }
          level++;
        }
        return executionGroups;
      }
      /**
       * Validate that all dependencies exist
       */
      static validateDependencies(checkIds, dependencies) {
        const errors = [];
        const checkIdSet = new Set(checkIds);
        for (const [checkId, deps] of Object.entries(dependencies)) {
          if (!checkIdSet.has(checkId)) {
            errors.push(`Check "${checkId}" is not in the list of available checks`);
            continue;
          }
          for (const depId of deps || []) {
            if (!checkIdSet.has(depId)) {
              errors.push(`Check "${checkId}" depends on "${depId}" which is not available`);
            }
          }
        }
        return {
          valid: errors.length === 0,
          errors
        };
      }
      /**
       * Get all transitive dependencies (ancestors) for a given check
       * This returns all checks that must complete before the given check can run,
       * not just the direct dependencies.
       *
       * For example, if A -> B -> C, then:
       * - getAllDependencies(C) returns [A, B]
       * - getAllDependencies(B) returns [A]
       * - getAllDependencies(A) returns []
       *
       * @param checkId The check to find dependencies for
       * @param nodes The dependency graph nodes
       * @returns Array of all transitive dependency IDs
       */
      static getAllDependencies(checkId, nodes) {
        const allDeps = /* @__PURE__ */ new Set();
        const visited = /* @__PURE__ */ new Set();
        const collectDependencies = (currentId) => {
          if (visited.has(currentId)) {
            return;
          }
          visited.add(currentId);
          const node = nodes.get(currentId);
          if (!node) {
            return;
          }
          for (const depId of node.dependencies) {
            allDeps.add(depId);
            collectDependencies(depId);
          }
        };
        collectDependencies(checkId);
        return Array.from(allDeps);
      }
      /**
       * Get execution statistics for debugging
       */
      static getExecutionStats(graph) {
        const totalChecks = graph.nodes.size;
        const parallelLevels = graph.executionOrder.length;
        const maxParallelism = Math.max(...graph.executionOrder.map((group) => group.parallel.length));
        const averageParallelism = totalChecks / parallelLevels;
        const checksWithDependencies = Array.from(graph.nodes.values()).filter(
          (node) => node.dependencies.length > 0
        ).length;
        return {
          totalChecks,
          parallelLevels,
          maxParallelism,
          averageParallelism,
          checksWithDependencies
        };
      }
    };
  }
});

// src/workflow-registry.ts
import { promises as fs } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
var WorkflowRegistry;
var init_workflow_registry = __esm({
  "src/workflow-registry.ts"() {
    init_logger();
    init_dependency_resolver();
    WorkflowRegistry = class _WorkflowRegistry {
      static instance;
      workflows = /* @__PURE__ */ new Map();
      ajv;
      constructor() {
        this.ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(this.ajv);
      }
      /**
       * Get the singleton instance of the workflow registry
       */
      static getInstance() {
        if (!_WorkflowRegistry.instance) {
          _WorkflowRegistry.instance = new _WorkflowRegistry();
        }
        return _WorkflowRegistry.instance;
      }
      /**
       * Register a workflow definition
       */
      register(workflow, source = "inline", options) {
        const validation = this.validateWorkflow(workflow);
        if (!validation.valid) {
          return validation;
        }
        if (this.workflows.has(workflow.id) && !options?.override) {
          return {
            valid: false,
            errors: [
              {
                path: "id",
                message: `Workflow with ID '${workflow.id}' already exists`,
                value: workflow.id
              }
            ]
          };
        }
        this.workflows.set(workflow.id, {
          definition: workflow,
          source,
          registeredAt: /* @__PURE__ */ new Date(),
          usage: {
            count: 0
          }
        });
        logger.debug(`Registered workflow '${workflow.id}' from ${source}`);
        return { valid: true };
      }
      /**
       * Get a workflow by ID
       */
      get(id) {
        const entry = this.workflows.get(id);
        if (entry) {
          entry.usage = entry.usage || { count: 0 };
          entry.usage.count++;
          entry.usage.lastUsed = /* @__PURE__ */ new Date();
        }
        return entry?.definition;
      }
      /**
       * Check if a workflow exists
       */
      has(id) {
        return this.workflows.has(id);
      }
      /**
       * List all registered workflows
       */
      list() {
        return Array.from(this.workflows.values()).map((entry) => entry.definition);
      }
      /**
       * Get workflow metadata
       */
      getMetadata(id) {
        return this.workflows.get(id);
      }
      /**
       * Remove a workflow from the registry
       */
      unregister(id) {
        return this.workflows.delete(id);
      }
      /**
       * Clear all workflows
       */
      clear() {
        this.workflows.clear();
      }
      /**
       * Import workflows from a file or URL
       */
      async import(source, options) {
        return this.importInternal(source, options, /* @__PURE__ */ new Set());
      }
      async importInternal(source, options, visited) {
        const results = [];
        try {
          const { content, resolvedSource, importBasePath } = await this.loadWorkflowContent(
            source,
            options?.basePath
          );
          const visitKey = resolvedSource || source;
          if (visited.has(visitKey)) {
            return results;
          }
          visited.add(visitKey);
          const data = this.parseWorkflowContent(content, resolvedSource || source);
          const topImports = !Array.isArray(data) ? data?.imports : void 0;
          if (Array.isArray(topImports)) {
            for (const childSource of topImports) {
              const childResults = await this.importInternal(
                childSource,
                { ...options, basePath: importBasePath },
                visited
              );
              results.push(...childResults);
            }
          }
          const workflows = Array.isArray(data) ? data : [data];
          for (const workflow of workflows) {
            const workflowImports = workflow?.imports;
            if (Array.isArray(workflowImports)) {
              for (const childSource of workflowImports) {
                const childResults = await this.importInternal(
                  childSource,
                  { ...options, basePath: importBasePath },
                  visited
                );
                results.push(...childResults);
              }
            }
            if (options?.validate !== false) {
              const validation = this.validateWorkflow(workflow);
              if (!validation.valid) {
                results.push(validation);
                continue;
              }
              if (options?.validators) {
                for (const validator of options.validators) {
                  const customValidation = validator(workflow);
                  if (!customValidation.valid) {
                    results.push(customValidation);
                    continue;
                  }
                }
              }
            }
            const workflowWithoutExtras = { ...workflow };
            delete workflowWithoutExtras.tests;
            delete workflowWithoutExtras.imports;
            const result = this.register(workflowWithoutExtras, source, {
              override: options?.override
            });
            results.push(result);
          }
        } catch (error) {
          results.push({
            valid: false,
            errors: [
              {
                path: "source",
                message: `Failed to import workflows from '${source}': ${error instanceof Error ? error.message : String(error)}`,
                value: source
              }
            ]
          });
        }
        return results;
      }
      /**
       * Import multiple workflow sources
       */
      async importMany(sources, options) {
        const results = /* @__PURE__ */ new Map();
        for (const source of sources) {
          const importResults = await this.import(source, options);
          results.set(source, importResults);
        }
        return results;
      }
      /**
       * Validate a workflow definition
       */
      validateWorkflow(workflow) {
        const errors = [];
        const warnings = [];
        if (!workflow.id) {
          errors.push({ path: "id", message: "Workflow ID is required" });
        }
        if (!workflow.name) {
          errors.push({ path: "name", message: "Workflow name is required" });
        }
        if (!workflow.steps || Object.keys(workflow.steps).length === 0) {
          errors.push({ path: "steps", message: "Workflow must have at least one step" });
        }
        if (workflow.inputs) {
          for (let i = 0; i < workflow.inputs.length; i++) {
            const input = workflow.inputs[i];
            if (!input.name) {
              errors.push({ path: `inputs[${i}].name`, message: "Input parameter name is required" });
            }
            if (!input.schema) {
              warnings.push({
                path: `inputs[${i}].schema`,
                message: "Input parameter schema is recommended"
              });
            }
          }
        }
        if (workflow.outputs) {
          for (let i = 0; i < workflow.outputs.length; i++) {
            const output = workflow.outputs[i];
            if (!output.name) {
              errors.push({ path: `outputs[${i}].name`, message: "Output parameter name is required" });
            }
            if (!output.value && !output.value_js) {
              errors.push({
                path: `outputs[${i}]`,
                message: "Output parameter must have either value or value_js"
              });
            }
          }
        }
        for (const [stepId, step] of Object.entries(workflow.steps || {})) {
          if (step.depends_on) {
            for (const dep of step.depends_on) {
              if (!workflow.steps[dep]) {
                errors.push({
                  path: `steps.${stepId}.depends_on`,
                  message: `Step '${stepId}' depends on non-existent step '${dep}'`,
                  value: dep
                });
              }
            }
          }
          if (step.inputs) {
            for (const [inputName, mapping] of Object.entries(step.inputs)) {
              if (typeof mapping === "object" && mapping !== null && "source" in mapping) {
                const typedMapping = mapping;
                if (typedMapping.source === "step" && !typedMapping.stepId) {
                  errors.push({
                    path: `steps.${stepId}.inputs.${inputName}`,
                    message: 'Step input mapping with source "step" must have stepId'
                  });
                }
                if (typedMapping.source === "param") {
                  const paramExists = workflow.inputs?.some((p) => p.name === typedMapping.value);
                  if (!paramExists) {
                    errors.push({
                      path: `steps.${stepId}.inputs.${inputName}`,
                      message: `Step input references non-existent parameter '${typedMapping.value}'`,
                      value: typedMapping.value
                    });
                  }
                }
              }
            }
          }
        }
        const circularDeps = this.detectCircularDependencies(workflow);
        if (circularDeps.length > 0) {
          errors.push({
            path: "steps",
            message: `Circular dependencies detected: ${circularDeps.join(" -> ")}`
          });
        }
        return {
          valid: errors.length === 0,
          errors: errors.length > 0 ? errors : void 0,
          warnings: warnings.length > 0 ? warnings : void 0
        };
      }
      /**
       * Validate input values against workflow input schema
       */
      validateInputs(workflow, inputs) {
        const errors = [];
        if (!workflow.inputs) {
          return { valid: true };
        }
        for (const param of workflow.inputs) {
          if (param.required !== false && !(param.name in inputs) && param.default === void 0) {
            errors.push({
              path: `inputs.${param.name}`,
              message: `Required input '${param.name}' is missing`
            });
          }
        }
        for (const param of workflow.inputs) {
          if (param.name in inputs && param.schema) {
            const value = inputs[param.name];
            const valid = this.validateAgainstSchema(value, param.schema);
            if (!valid.valid) {
              errors.push({
                path: `inputs.${param.name}`,
                message: valid.error || "Invalid input value",
                value
              });
            }
          }
        }
        return {
          valid: errors.length === 0,
          errors: errors.length > 0 ? errors : void 0
        };
      }
      /**
       * Load workflow content from file or URL
       */
      async loadWorkflowContent(source, basePath) {
        const baseIsUrl = basePath?.startsWith("http://") || basePath?.startsWith("https://");
        if (source.startsWith("http://") || source.startsWith("https://")) {
          const response = await fetch(source);
          if (!response.ok) {
            throw new Error(`Failed to fetch workflow from ${source}: ${response.statusText}`);
          }
          const importBasePath = new URL(".", source).toString();
          return { content: await response.text(), resolvedSource: source, importBasePath };
        }
        if (baseIsUrl) {
          const resolvedUrl = new URL(source, basePath).toString();
          const response = await fetch(resolvedUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch workflow from ${resolvedUrl}: ${response.statusText}`);
          }
          const importBasePath = new URL(".", resolvedUrl).toString();
          return { content: await response.text(), resolvedSource: resolvedUrl, importBasePath };
        }
        const filePath = path.isAbsolute(source) ? source : path.resolve(basePath || process.cwd(), source);
        const content = await fs.readFile(filePath, "utf-8");
        return { content, resolvedSource: filePath, importBasePath: path.dirname(filePath) };
      }
      /**
       * Parse workflow content (YAML or JSON)
       */
      parseWorkflowContent(content, source) {
        try {
          return JSON.parse(content);
        } catch {
          try {
            return yaml.load(content);
          } catch (error) {
            throw new Error(
              `Failed to parse workflow file ${source}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      /**
       * Detect circular dependencies in workflow steps using DependencyResolver
       */
      detectCircularDependencies(workflow) {
        const dependencies = {};
        for (const [stepId, step] of Object.entries(workflow.steps || {})) {
          const rawDeps = step.depends_on;
          dependencies[stepId] = Array.isArray(rawDeps) ? rawDeps : rawDeps ? [rawDeps] : [];
        }
        try {
          const graph = DependencyResolver.buildDependencyGraph(dependencies);
          if (graph.hasCycles && graph.cycleNodes) {
            return graph.cycleNodes;
          }
          return [];
        } catch {
          return [];
        }
      }
      /**
       * Validate a value against a JSON schema
       */
      validateAgainstSchema(value, schema) {
        try {
          const validate = this.ajv.compile(schema);
          const valid = validate(value);
          if (!valid) {
            const errors = validate.errors?.map((e) => `${e.instancePath || "/"}: ${e.message}`).join(", ");
            return { valid: false, error: errors };
          }
          return { valid: true };
        } catch (error) {
          return { valid: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
    };
  }
});

export {
  DependencyResolver,
  init_dependency_resolver,
  WorkflowRegistry,
  init_workflow_registry
};
//# sourceMappingURL=chunk-D5KI4YQ4.mjs.map