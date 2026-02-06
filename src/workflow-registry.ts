/**
 * Workflow registry for managing reusable workflow definitions
 */

import {
  WorkflowDefinition,
  WorkflowRegistryEntry,
  WorkflowValidationResult,
  WorkflowImportOptions,
  JsonSchema,
} from './types/workflow';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from './logger';
import { DependencyResolver } from './dependency-resolver';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Registry for managing workflow definitions
 */
export class WorkflowRegistry {
  private static instance: WorkflowRegistry;
  private workflows: Map<string, WorkflowRegistryEntry> = new Map();
  private ajv: Ajv;

  private constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  /**
   * Get the singleton instance of the workflow registry
   */
  public static getInstance(): WorkflowRegistry {
    if (!WorkflowRegistry.instance) {
      WorkflowRegistry.instance = new WorkflowRegistry();
    }
    return WorkflowRegistry.instance;
  }

  /**
   * Register a workflow definition
   */
  public register(
    workflow: WorkflowDefinition,
    source: string = 'inline',
    options?: { override?: boolean }
  ): WorkflowValidationResult {
    // Validate the workflow
    const validation = this.validateWorkflow(workflow);
    if (!validation.valid) {
      return validation;
    }

    // Check if workflow already exists
    if (this.workflows.has(workflow.id) && !options?.override) {
      return {
        valid: false,
        errors: [
          {
            path: 'id',
            message: `Workflow with ID '${workflow.id}' already exists`,
            value: workflow.id,
          },
        ],
      };
    }

    // Register the workflow
    this.workflows.set(workflow.id, {
      definition: workflow,
      source,
      registeredAt: new Date(),
      usage: {
        count: 0,
      },
    });

    logger.debug(`Registered workflow '${workflow.id}' from ${source}`);
    return { valid: true };
  }

  /**
   * Get a workflow by ID
   */
  public get(id: string): WorkflowDefinition | undefined {
    const entry = this.workflows.get(id);
    if (entry) {
      // Update usage statistics
      entry.usage = entry.usage || { count: 0 };
      entry.usage.count++;
      entry.usage.lastUsed = new Date();
    }
    return entry?.definition;
  }

  /**
   * Check if a workflow exists
   */
  public has(id: string): boolean {
    return this.workflows.has(id);
  }

  /**
   * List all registered workflows
   */
  public list(): WorkflowDefinition[] {
    return Array.from(this.workflows.values()).map(entry => entry.definition);
  }

  /**
   * Get workflow metadata
   */
  public getMetadata(id: string): WorkflowRegistryEntry | undefined {
    return this.workflows.get(id);
  }

  /**
   * Remove a workflow from the registry
   */
  public unregister(id: string): boolean {
    return this.workflows.delete(id);
  }

  /**
   * Clear all workflows
   */
  public clear(): void {
    this.workflows.clear();
  }

  /**
   * Import workflows from a file or URL
   */
  public async import(
    source: string,
    options?: WorkflowImportOptions
  ): Promise<WorkflowValidationResult[]> {
    return this.importInternal(source, options, new Set<string>());
  }

  private async importInternal(
    source: string,
    options: WorkflowImportOptions | undefined,
    visited: Set<string>
  ): Promise<WorkflowValidationResult[]> {
    const results: WorkflowValidationResult[] = [];

    try {
      // Load the workflow file
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

      // Process top-level imports if present
      const topImports = !Array.isArray(data) ? (data as any)?.imports : undefined;
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

      // Handle both single workflow and multiple workflows
      const workflows: WorkflowDefinition[] = Array.isArray(data) ? data : [data];

      for (const workflow of workflows) {
        const workflowImports = (workflow as any)?.imports;
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

        // Validate if requested
        if (options?.validate !== false) {
          const validation = this.validateWorkflow(workflow);
          if (!validation.valid) {
            results.push(validation);
            continue;
          }

          // Run custom validators if provided
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

        // Strip out fields before registering
        const workflowWithoutExtras = { ...workflow };
        delete (workflowWithoutExtras as any).tests;
        delete (workflowWithoutExtras as any).imports;

        // Register the workflow (without tests/imports)
        const result = this.register(workflowWithoutExtras, source, {
          override: options?.override,
        });
        results.push(result);
      }
    } catch (error) {
      results.push({
        valid: false,
        errors: [
          {
            path: 'source',
            message: `Failed to import workflows from '${source}': ${error instanceof Error ? error.message : String(error)}`,
            value: source,
          },
        ],
      });
    }

    return results;
  }

  /**
   * Import multiple workflow sources
   */
  public async importMany(
    sources: string[],
    options?: WorkflowImportOptions
  ): Promise<Map<string, WorkflowValidationResult[]>> {
    const results = new Map<string, WorkflowValidationResult[]>();

    for (const source of sources) {
      const importResults = await this.import(source, options);
      results.set(source, importResults);
    }

    return results;
  }

  /**
   * Validate a workflow definition
   */
  public validateWorkflow(workflow: WorkflowDefinition): WorkflowValidationResult {
    const errors: Array<{ path: string; message: string; value?: unknown }> = [];
    const warnings: Array<{ path: string; message: string }> = [];

    // Validate required fields
    if (!workflow.id) {
      errors.push({ path: 'id', message: 'Workflow ID is required' });
    }

    if (!workflow.name) {
      errors.push({ path: 'name', message: 'Workflow name is required' });
    }

    if (!workflow.steps || Object.keys(workflow.steps).length === 0) {
      errors.push({ path: 'steps', message: 'Workflow must have at least one step' });
    }

    // Validate input parameters
    if (workflow.inputs) {
      for (let i = 0; i < workflow.inputs.length; i++) {
        const input = workflow.inputs[i];
        if (!input.name) {
          errors.push({ path: `inputs[${i}].name`, message: 'Input parameter name is required' });
        }
        if (!input.schema) {
          warnings.push({
            path: `inputs[${i}].schema`,
            message: 'Input parameter schema is recommended',
          });
        }
      }
    }

    // Validate output parameters
    if (workflow.outputs) {
      for (let i = 0; i < workflow.outputs.length; i++) {
        const output = workflow.outputs[i];
        if (!output.name) {
          errors.push({ path: `outputs[${i}].name`, message: 'Output parameter name is required' });
        }
        if (!output.value && !output.value_js) {
          errors.push({
            path: `outputs[${i}]`,
            message: 'Output parameter must have either value or value_js',
          });
        }
      }
    }

    // Validate steps
    for (const [stepId, step] of Object.entries(workflow.steps || {})) {
      // Validate step dependencies
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          if (!workflow.steps[dep]) {
            errors.push({
              path: `steps.${stepId}.depends_on`,
              message: `Step '${stepId}' depends on non-existent step '${dep}'`,
              value: dep,
            });
          }
        }
      }

      // Validate input mappings
      if (step.inputs) {
        for (const [inputName, mapping] of Object.entries(step.inputs)) {
          if (typeof mapping === 'object' && mapping !== null && 'source' in mapping) {
            const typedMapping = mapping as any;
            if (typedMapping.source === 'step' && !typedMapping.stepId) {
              errors.push({
                path: `steps.${stepId}.inputs.${inputName}`,
                message: 'Step input mapping with source "step" must have stepId',
              });
            }
            if (typedMapping.source === 'param') {
              // Validate that the parameter exists
              const paramExists = workflow.inputs?.some(p => p.name === typedMapping.value);
              if (!paramExists) {
                errors.push({
                  path: `steps.${stepId}.inputs.${inputName}`,
                  message: `Step input references non-existent parameter '${typedMapping.value}'`,
                  value: typedMapping.value,
                });
              }
            }
          }
        }
      }
    }

    // Check for circular dependencies
    const circularDeps = this.detectCircularDependencies(workflow);
    if (circularDeps.length > 0) {
      errors.push({
        path: 'steps',
        message: `Circular dependencies detected: ${circularDeps.join(' -> ')}`,
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Validate input values against workflow input schema
   */
  public validateInputs(
    workflow: WorkflowDefinition,
    inputs: Record<string, unknown>
  ): WorkflowValidationResult {
    const errors: Array<{ path: string; message: string; value?: unknown }> = [];

    if (!workflow.inputs) {
      return { valid: true };
    }

    // Check required inputs
    for (const param of workflow.inputs) {
      if (param.required !== false && !(param.name in inputs) && param.default === undefined) {
        errors.push({
          path: `inputs.${param.name}`,
          message: `Required input '${param.name}' is missing`,
        });
      }
    }

    // Validate input schemas
    for (const param of workflow.inputs) {
      if (param.name in inputs && param.schema) {
        const value = inputs[param.name];
        const valid = this.validateAgainstSchema(value, param.schema);
        if (!valid.valid) {
          errors.push({
            path: `inputs.${param.name}`,
            message: valid.error || 'Invalid input value',
            value,
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Load workflow content from file or URL
   */
  private async loadWorkflowContent(
    source: string,
    basePath?: string
  ): Promise<{ content: string; resolvedSource: string; importBasePath?: string }> {
    const baseIsUrl = basePath?.startsWith('http://') || basePath?.startsWith('https://');

    // Handle URLs
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Failed to fetch workflow from ${source}: ${response.statusText}`);
      }
      const importBasePath = new URL('.', source).toString();
      return { content: await response.text(), resolvedSource: source, importBasePath };
    }

    // Handle relative URLs when basePath is a URL
    if (baseIsUrl) {
      const resolvedUrl = new URL(source, basePath).toString();
      const response = await fetch(resolvedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch workflow from ${resolvedUrl}: ${response.statusText}`);
      }
      const importBasePath = new URL('.', resolvedUrl).toString();
      return { content: await response.text(), resolvedSource: resolvedUrl, importBasePath };
    }

    // Handle file paths
    const filePath = path.isAbsolute(source)
      ? source
      : path.resolve(basePath || process.cwd(), source);
    const content = await fs.readFile(filePath, 'utf-8');
    return { content, resolvedSource: filePath, importBasePath: path.dirname(filePath) };
  }

  /**
   * Parse workflow content (YAML or JSON)
   */
  private parseWorkflowContent(content: string, source: string): any {
    // Try JSON first
    try {
      return JSON.parse(content);
    } catch {
      // Try YAML
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
  private detectCircularDependencies(workflow: WorkflowDefinition): string[] {
    // Build dependency map
    const dependencies: Record<string, string[]> = {};
    for (const [stepId, step] of Object.entries(workflow.steps || {})) {
      // Normalize depends_on to array (supports string | string[])
      const rawDeps = step.depends_on;
      dependencies[stepId] = Array.isArray(rawDeps) ? rawDeps : rawDeps ? [rawDeps] : [];
    }

    try {
      // Use DependencyResolver to check for cycles
      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      if (graph.hasCycles && graph.cycleNodes) {
        return graph.cycleNodes;
      }

      return [];
    } catch {
      // DependencyResolver throws error for non-existent dependencies
      // This should be caught by the dependency validation in validateWorkflow
      // Return empty array here and let the validation handle it
      return [];
    }
  }

  /**
   * Validate a value against a JSON schema
   */
  private validateAgainstSchema(
    value: unknown,
    schema: JsonSchema
  ): { valid: boolean; error?: string } {
    try {
      const validate = this.ajv.compile(schema as any);
      const valid = validate(value);
      if (!valid) {
        const errors = validate.errors
          ?.map(e => `${e.instancePath || '/'}: ${e.message}`)
          .join(', ');
        return { valid: false, error: errors };
      }
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
