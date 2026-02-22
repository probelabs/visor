import fs from 'fs/promises';
import path from 'path';
import YAML from 'js-yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import deepmerge from 'deepmerge';
import { JSONPath } from 'jsonpath-plus';
import { minimatch } from 'minimatch';
import { logger } from '../logger';
import type { CustomToolDefinition } from '../types/config';

type JsonSchemaObject = Record<string, unknown>;
type OverlaySource = string | Record<string, unknown>;

interface ApiToolConfig {
  customHeaders: Record<string, string>;
  disableXMcp: boolean;
  apiKey?: string;
  securitySchemeName?: string;
  securityCredentials: Record<string, string>;
  requestTimeoutMs: number;
}

interface ApiCallDetails {
  method: string;
  pathTemplate: string;
  serverUrl: string;
  parameters: Array<Record<string, any>>;
  requestBody?: Record<string, any>;
  securityRequirements: Array<Record<string, string[]>> | null;
  securitySchemes?: Record<string, Record<string, any>>;
  apiToolConfig: ApiToolConfig;
}

export interface ApiMappedTool {
  sourceToolName: string;
  mcpToolDefinition: {
    name: string;
    description: string;
    inputSchema: JsonSchemaObject;
    outputSchema?: JsonSchemaObject;
  };
  apiCallDetails: ApiCallDetails;
}

interface JsonPathMatch {
  parent: any;
  parentProperty: string | number;
  value: any;
}

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function toStringArray(value: string[] | string | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toOverlaySourceArray(
  value: string | Record<string, unknown> | Array<string | Record<string, unknown>> | undefined
): OverlaySource[] {
  if (!value) return [];
  if (typeof value === 'string' || isPlainObject(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(
      item => typeof item === 'string' || isPlainObject(item)
    ) as OverlaySource[];
  }
  return [];
}

function resolvePathOrUrl(candidate: string, baseDir: string): string {
  if (isHttpUrl(candidate)) return candidate;
  if (path.isAbsolute(candidate)) return candidate;
  if (isHttpUrl(baseDir)) {
    return new URL(candidate, baseDir).toString();
  }
  return path.resolve(baseDir, candidate);
}

async function readTextFromPathOrUrl(location: string): Promise<string> {
  if (isHttpUrl(location)) {
    const res = await fetch(location);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${location}: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  }
  return await fs.readFile(location, 'utf8');
}

function parseJsonOrYaml(raw: string, location: string): any {
  const ext = path.extname(location).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return YAML.load(raw);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return YAML.load(raw);
  }
}

function parseOverlayTargetPath(pathValue: Array<string | number>): string {
  if (!Array.isArray(pathValue) || pathValue.length === 0) return '$';
  return pathValue
    .map((segment, index) => {
      if (index === 0) return '$';
      if (typeof segment === 'number') return `[${segment}]`;
      if (/^[A-Za-z_][\w$]*$/.test(segment)) return `.${segment}`;
      return `['${segment.replace(/'/g, "\\'")}']`;
    })
    .join('');
}

function applyOverlayActions(target: any, overlay: any): any {
  const cloned = JSON.parse(JSON.stringify(target));

  if (!overlay || typeof overlay !== 'object') return cloned;

  const actions = Array.isArray(overlay.actions) ? overlay.actions : [];
  if (actions.length === 0) {
    return deepmerge(cloned, overlay as Record<string, unknown>, {
      arrayMerge: (dst, src) => dst.concat(src),
    });
  }

  for (const action of actions) {
    const targetExpr = action?.target;
    if (!targetExpr || typeof targetExpr !== 'string') continue;

    let matches: JsonPathMatch[] = [];
    try {
      matches = JSONPath({
        path: targetExpr,
        json: cloned,
        resultType: 'all',
      }) as JsonPathMatch[];
    } catch (error) {
      logger.warn(`[ApiToolExecutor] Invalid overlay target "${targetExpr}": ${error}`);
      continue;
    }

    if (matches.length === 0) {
      continue;
    }

    for (const match of matches) {
      if (!match || typeof match !== 'object') continue;
      const parent = match.parent;
      const key = match.parentProperty;
      if (parent === undefined || key === undefined) {
        const jsonPath = parseOverlayTargetPath(
          (match as unknown as { path?: Array<string | number> }).path || []
        );
        logger.debug(`[ApiToolExecutor] Overlay target has no writable parent: ${jsonPath}`);
        continue;
      }

      if (action.remove === true) {
        if (Array.isArray(parent)) {
          parent.splice(Number(key), 1);
        } else if (parent && typeof parent === 'object') {
          delete parent[key as keyof typeof parent];
        }
        continue;
      }

      if (action.update === undefined) {
        continue;
      }

      const current = match.value;
      if (Array.isArray(current)) {
        current.push(action.update);
      } else if (current && typeof current === 'object') {
        const merged = deepmerge(current as Record<string, unknown>, action.update, {
          arrayMerge: (dst, src) => dst.concat(src),
        });
        if (Array.isArray(parent)) {
          parent[Number(key)] = merged;
        } else {
          parent[key as keyof typeof parent] = merged;
        }
      } else if (Array.isArray(parent)) {
        parent[Number(key)] = action.update;
      } else {
        parent[key as keyof typeof parent] = action.update;
      }
    }
  }

  return cloned;
}

function isRefObject(value: any): boolean {
  return Boolean(value && typeof value === 'object' && '$ref' in value);
}

function isSchemaObject(value: any): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !isRefObject(value));
}

function getSchemaFromContent(content: unknown): unknown {
  if (!content || typeof content !== 'object') return undefined;
  const entries = Object.values(content as Record<string, unknown>) as Array<Record<string, any>>;
  const withSchema = entries.find(entry => entry && typeof entry === 'object' && entry.schema);
  return withSchema?.schema;
}

function mapOpenApiTypeToJsonType(
  schema: Record<string, any> | undefined
): { type: string; format?: string; nullable?: boolean } {
  if (!schema || !schema.type) return { type: 'string' };
  const openApiType = String(schema.type);
  const nullable = schema.nullable === true;
  switch (openApiType) {
    case 'integer':
    case 'number':
    case 'boolean':
    case 'string':
    case 'array':
    case 'object':
      return { type: openApiType, format: schema.format, nullable };
    default:
      return { type: 'string', format: schema.format, nullable };
  }
}

function openApiSchemaToJsonSchema(schema: Record<string, any> | undefined): JsonSchemaObject {
  if (!schema) {
    return { type: 'string' };
  }

  const mapped = mapOpenApiTypeToJsonType(schema);
  const result: JsonSchemaObject = {
    type: mapped.nullable ? [mapped.type, 'null'] : mapped.type,
  };

  if (mapped.format) result.format = mapped.format;
  if (schema.description !== undefined) result.description = schema.description;
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.enum !== undefined) result.enum = schema.enum;
  if (schema.example !== undefined) (result as any).example = schema.example;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.minLength !== undefined) result.minLength = schema.minLength;
  if (schema.maxLength !== undefined) result.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) result.pattern = schema.pattern;
  if (schema.multipleOf !== undefined) result.multipleOf = schema.multipleOf;
  if (schema.minItems !== undefined) result.minItems = schema.minItems;
  if (schema.maxItems !== undefined) result.maxItems = schema.maxItems;
  if (schema.uniqueItems !== undefined) result.uniqueItems = schema.uniqueItems;

  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (isSchemaObject(propSchema)) {
        props[propName] = openApiSchemaToJsonSchema(propSchema);
      }
    }
    result.properties = props;
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      result.required = schema.required;
    }
    if (schema.additionalProperties === true || schema.additionalProperties === false) {
      result.additionalProperties = schema.additionalProperties;
    } else if (isSchemaObject(schema.additionalProperties)) {
      result.additionalProperties = openApiSchemaToJsonSchema(schema.additionalProperties);
    }
  }

  if (schema.type === 'array' && isSchemaObject(schema.items)) {
    result.items = openApiSchemaToJsonSchema(schema.items);
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith('x-')) {
      (result as any)[key] = value;
    }
  }

  return result;
}

function shouldIncludeOperation(
  operationId: string | undefined,
  pathValue: string,
  method: string,
  whitelist: string[],
  blacklist: string[]
): boolean {
  const methodPath = `${method.toUpperCase()}:${pathValue}`;
  const opKey = operationId || methodPath;

  if (whitelist.length > 0) {
    return whitelist.some(pattern => minimatch(opKey, pattern) || minimatch(methodPath, pattern));
  }

  if (blacklist.length > 0) {
    return !blacklist.some(pattern => minimatch(opKey, pattern) || minimatch(methodPath, pattern));
  }

  return true;
}

function getApiToolConfig(tool: CustomToolDefinition): ApiToolConfig {
  return {
    customHeaders: tool.headers || {},
    disableXMcp: Boolean(tool.disableXMcp ?? tool.disable_x_mcp ?? false),
    apiKey: tool.apiKey ?? tool.api_key,
    securitySchemeName: tool.securitySchemeName ?? tool.security_scheme_name,
    securityCredentials: tool.securityCredentials || tool.security_credentials || {},
    requestTimeoutMs: tool.requestTimeoutMs ?? tool.request_timeout_ms ?? tool.timeout ?? 30000,
  };
}

function buildOutputSchema(operation: Record<string, any>): JsonSchemaObject | undefined {
  const responses = operation.responses;
  if (!responses || typeof responses !== 'object') return undefined;

  const successCode = Object.keys(responses).find(code => code.startsWith('2'));
  if (!successCode) return undefined;

  const response = responses[successCode];
  if (!response || typeof response !== 'object' || isRefObject(response)) return undefined;

  const jsonSchema = response.content?.['application/json']?.schema || getSchemaFromContent(response.content);

  if (!isSchemaObject(jsonSchema)) return undefined;

  const mapped = openApiSchemaToJsonSchema(jsonSchema);
  if (response.description && typeof response.description === 'string') {
    mapped.description = response.description;
  }
  return mapped;
}

function getToolName(
  operationId: string,
  operation: Record<string, any>,
  pathItem: Record<string, any>,
  tool: CustomToolDefinition
): string {
  let toolName = operationId;

  const opExtension = operation['x-mcp'];
  const pathExtension = pathItem['x-mcp'];

  if (opExtension && typeof opExtension === 'object' && typeof opExtension.name === 'string') {
    toolName = opExtension.name;
  } else if (
    pathExtension &&
    typeof pathExtension === 'object' &&
    typeof pathExtension.name === 'string'
  ) {
    toolName = pathExtension.name;
  }

  const prefix = tool.namePrefix || tool.name_prefix;
  if (prefix) {
    return `${prefix}${toolName}`;
  }
  return toolName;
}

function getToolDescription(
  operation: Record<string, any>,
  pathItem: Record<string, any>
): string {
  const opExtension = operation['x-mcp'];
  const pathExtension = pathItem['x-mcp'];
  if (
    opExtension &&
    typeof opExtension === 'object' &&
    typeof opExtension.description === 'string'
  ) {
    return opExtension.description;
  }
  if (
    pathExtension &&
    typeof pathExtension === 'object' &&
    typeof pathExtension.description === 'string'
  ) {
    return pathExtension.description;
  }
  return (
    (typeof operation.description === 'string' && operation.description) ||
    (typeof operation.summary === 'string' && operation.summary) ||
    (typeof pathItem.summary === 'string' && pathItem.summary) ||
    'No description available.'
  );
}

export function isApiToolDefinition(tool: CustomToolDefinition | undefined): boolean {
  return Boolean(tool && tool.type === 'api');
}

async function loadOpenApiDocument(tool: CustomToolDefinition): Promise<any> {
  if (!tool.spec) {
    throw new Error(`API tool '${tool.name}' is missing required field: spec`);
  }

  const configuredBaseDir = (tool as any).__baseDir as string | undefined;
  const baseDir = (() => {
    if (tool.cwd) {
      if (path.isAbsolute(tool.cwd) || isHttpUrl(tool.cwd)) {
        return tool.cwd;
      }
      if (configuredBaseDir) {
        return resolvePathOrUrl(tool.cwd, configuredBaseDir);
      }
      return path.resolve(tool.cwd);
    }
    return configuredBaseDir || process.cwd();
  })();
  const dereferenceWithContext = async (
    source: string,
    spec: any
  ): Promise<any> => {
    try {
      return await SwaggerParser.dereference(spec);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to dereference OpenAPI spec for API tool '${tool.name}' from ${source}: ${errorMessage}`
      );
    }
  };

  let openapi: any;
  if (typeof tool.spec === 'string') {
    const specLocation = resolvePathOrUrl(tool.spec, baseDir);
    if (isHttpUrl(specLocation)) {
      const raw = await readTextFromPathOrUrl(specLocation);
      const parsed = parseJsonOrYaml(raw, specLocation);
      openapi = await dereferenceWithContext(specLocation, parsed);
    } else {
      openapi = await dereferenceWithContext(specLocation, specLocation);
    }
  } else if (isPlainObject(tool.spec)) {
    openapi = await dereferenceWithContext(
      'inline spec',
      JSON.parse(JSON.stringify(tool.spec))
    );
  } else {
    throw new Error(
      `API tool '${tool.name}' has invalid spec field (expected string path/URL or object)`
    );
  }

  const overlays = toOverlaySourceArray(tool.overlays);
  let working = openapi;
  for (const overlaySource of overlays) {
    let overlay: any = overlaySource;
    if (typeof overlaySource === 'string') {
      const resolved = resolvePathOrUrl(overlaySource, baseDir);
      const raw = await readTextFromPathOrUrl(resolved);
      overlay = parseJsonOrYaml(raw, resolved);
    }
    working = applyOverlayActions(working, overlay);
  }

  return working;
}

function mapOpenApiToTools(openapi: any, tool: CustomToolDefinition): ApiMappedTool[] {
  const paths = openapi?.paths;
  if (!paths || typeof paths !== 'object') {
    return [];
  }

  const targetUrl = tool.targetUrl || tool.target_url;
  const baseServerUrl = String(targetUrl || openapi?.servers?.[0]?.url || '').replace(/\/$/, '');
  if (!baseServerUrl) {
    throw new Error(
      `API tool '${tool.name}' cannot determine target API URL. Set targetUrl/target_url or provide OpenAPI servers[].`
    );
  }

  const whitelist = toStringArray(tool.whitelist);
  const blacklist = toStringArray(tool.blacklist);
  const globalSecurity = Array.isArray(openapi?.security) ? openapi.security : null;
  const securitySchemes = openapi?.components?.securitySchemes;
  const mapped: ApiMappedTool[] = [];
  const apiToolConfig = getApiToolConfig(tool);

  for (const [pathValue, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    const pathItem = pathItemRaw as Record<string, any>;
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const [method, operationRaw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;

      const operation = operationRaw as Record<string, any>;
      if (!operation || typeof operation !== 'object') continue;

      const operationId =
        typeof operation.operationId === 'string' ? String(operation.operationId) : undefined;
      if (!operationId) {
        logger.debug(
          `[ApiToolExecutor] Skipping ${method.toUpperCase()} ${pathValue} (missing operationId)`
        );
        continue;
      }

      if (!shouldIncludeOperation(operationId, pathValue, method, whitelist, blacklist)) {
        continue;
      }

      const toolName = getToolName(operationId, operation, pathItem, tool);
      const toolDescription = getToolDescription(operation, pathItem);
      const inputSchema: JsonSchemaObject = {
        type: 'object',
        properties: {},
      };
      const requiredNames = new Set<string>();

      const allParameters = [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ].filter(param => param && typeof param === 'object' && !isRefObject(param));

      for (const param of allParameters) {
        const paramObj = param as Record<string, any>;
        const paramName = typeof paramObj.name === 'string' ? paramObj.name : '';
        if (!paramName) continue;
        if (!isSchemaObject(paramObj.schema)) continue;

        const schema = openApiSchemaToJsonSchema(paramObj.schema);
        if (typeof paramObj.description === 'string') {
          schema.description = paramObj.description;
        }
        schema['x-parameter-location'] = paramObj.in || 'query';
        if (paramObj.example !== undefined) schema.example = paramObj.example;
        if (paramObj.deprecated === true) schema.deprecated = true;

        (inputSchema.properties as Record<string, unknown>)[paramName] = schema;
        if (paramObj.required === true) requiredNames.add(paramName);
      }

      const requestBody = !isRefObject(operation.requestBody) ? operation.requestBody : undefined;
      if (requestBody && typeof requestBody === 'object') {
        const reqSchema =
          requestBody.content?.['application/json']?.schema || getSchemaFromContent(requestBody.content);
        if (isSchemaObject(reqSchema)) {
          const bodySchema = openApiSchemaToJsonSchema(reqSchema);
          if (typeof requestBody.description === 'string') {
            bodySchema.description = requestBody.description;
          }
          const contentTypes = Object.keys(requestBody.content || {});
          if (contentTypes.length > 0) {
            bodySchema['x-content-types'] = contentTypes;
          }
          (inputSchema.properties as Record<string, unknown>).requestBody = bodySchema;
          if (requestBody.required === true) {
            requiredNames.add('requestBody');
          }
        }
      }

      if (requiredNames.size > 0) {
        inputSchema.required = Array.from(requiredNames);
      }

      const securityRequirements = Array.isArray(operation.security)
        ? (operation.security as Array<Record<string, string[]>>)
        : globalSecurity;

      mapped.push({
        sourceToolName: tool.name,
        mcpToolDefinition: {
          name: toolName,
          description: toolDescription,
          inputSchema,
          outputSchema: buildOutputSchema(operation),
        },
        apiCallDetails: {
          method: method.toUpperCase(),
          pathTemplate: pathValue,
          serverUrl: baseServerUrl,
          parameters: allParameters as Array<Record<string, any>>,
          requestBody,
          securityRequirements,
          securitySchemes,
          apiToolConfig,
        },
      });
    }
  }

  return mapped;
}

function validateParameterValue(value: unknown, paramDef: Record<string, any>): string | null {
  const schema = paramDef.schema;
  if (!schema || typeof schema !== 'object') return null;

  const schemaType = schema.type;
  if (schemaType === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return 'must be an integer';
    }
  } else if (schemaType === 'number') {
    if (typeof value !== 'number') {
      return `expected number, got ${typeof value}`;
    }
  } else if (schemaType === 'boolean') {
    if (typeof value !== 'boolean') {
      return `expected boolean, got ${typeof value}`;
    }
  } else if (schemaType === 'string') {
    if (typeof value !== 'string') {
      return `expected string, got ${typeof value}`;
    }
  } else if (schemaType === 'array') {
    if (!Array.isArray(value)) {
      return `expected array, got ${typeof value}`;
    }
  } else if (schemaType === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return `expected object, got ${Array.isArray(value) ? 'array' : typeof value}`;
    }
  }

  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    return `must be >= ${schema.minimum}`;
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    return `must be <= ${schema.maximum}`;
  }
  if (
    schema.minLength !== undefined &&
    typeof value === 'string' &&
    value.length < schema.minLength
  ) {
    return `length must be >= ${schema.minLength}`;
  }
  if (
    schema.maxLength !== undefined &&
    typeof value === 'string' &&
    value.length > schema.maxLength
  ) {
    return `length must be <= ${schema.maxLength}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `must be one of: ${schema.enum.join(', ')}`;
  }

  return null;
}

function applySecurityToRequest(
  details: ApiCallDetails,
  headers: Record<string, string>,
  queryParams: URLSearchParams
): void {
  const requirements = details.securityRequirements;
  if (!requirements || requirements.length === 0) {
    return;
  }

  const schemes = details.securitySchemes || {};
  const cfg = details.apiToolConfig;

  const tryResolveCredential = (schemeName: string): string | undefined => {
    if (cfg.securityCredentials[schemeName]) {
      return cfg.securityCredentials[schemeName];
    }
    if (cfg.securitySchemeName && cfg.securitySchemeName !== schemeName) {
      return undefined;
    }
    return cfg.apiKey;
  };

  for (const requirement of requirements) {
    const schemeNames = Object.keys(requirement);
    if (schemeNames.length === 0) return;

    const tempHeaders = { ...headers };
    const tempQuery = new URLSearchParams(queryParams);
    let satisfied = true;

    for (const schemeName of schemeNames) {
      const scheme = schemes[schemeName];
      if (!scheme || typeof scheme !== 'object') {
        satisfied = false;
        break;
      }

      const credential = tryResolveCredential(schemeName);
      if (!credential) {
        satisfied = false;
        break;
      }

      switch (scheme.type) {
        case 'apiKey':
          if (scheme.in === 'header') {
            tempHeaders[String(scheme.name)] = credential;
          } else if (scheme.in === 'query') {
            tempQuery.set(String(scheme.name), credential);
          } else if (scheme.in === 'cookie') {
            const cookieName = String(scheme.name);
            const existing = tempHeaders['Cookie'];
            tempHeaders['Cookie'] = existing
              ? `${existing}; ${cookieName}=${credential}`
              : `${cookieName}=${credential}`;
          } else {
            satisfied = false;
          }
          break;
        case 'http':
          if (typeof scheme.scheme !== 'string') {
            satisfied = false;
            break;
          }
          if (scheme.scheme.toLowerCase() === 'bearer') {
            tempHeaders['Authorization'] = `Bearer ${credential}`;
          } else if (scheme.scheme.toLowerCase() === 'basic') {
            tempHeaders['Authorization'] = `Basic ${Buffer.from(credential).toString('base64')}`;
          } else {
            satisfied = false;
          }
          break;
        case 'oauth2':
        case 'openIdConnect':
          tempHeaders['Authorization'] = `Bearer ${credential}`;
          break;
        default:
          satisfied = false;
      }

      if (!satisfied) {
        break;
      }
    }

    if (satisfied) {
      Object.assign(headers, tempHeaders);
      queryParams.forEach((_value, key) => queryParams.delete(key));
      tempQuery.forEach((value, key) => queryParams.append(key, value));
      return;
    }
  }
}

function responseBodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export async function executeMappedApiTool(
  mappedTool: ApiMappedTool,
  args: Record<string, unknown>
): Promise<unknown> {
  const { apiCallDetails } = mappedTool;
  const { method, pathTemplate, serverUrl, parameters, requestBody, apiToolConfig } = apiCallDetails;

  const urlPath = pathTemplate.replace(/{([^}]+)}/g, (_token: string, rawName: string) => {
    const value = args[rawName];
    if (value === undefined || value === null) {
      return `{${rawName}}`;
    }
    return encodeURIComponent(String(value));
  });

  if (urlPath.includes('{') || urlPath.includes('}')) {
    throw new Error(`Missing required path parameters for ${method} ${pathTemplate}`);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(`${serverUrl}${urlPath}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to construct endpoint URL for API tool '${mappedTool.sourceToolName}' operation '${mappedTool.mcpToolDefinition.name}' (${method} ${pathTemplate}) with serverUrl '${serverUrl}': ${errorMessage}`
    );
  }
  const queryParams = new URLSearchParams(endpoint.search);
  const headers: Record<string, string> = { ...apiToolConfig.customHeaders };
  let requestBodyValue: unknown;

  for (const param of parameters) {
    const name = String(param.name || '');
    if (!name) continue;

    const value = args[name];
    if (value === undefined || value === null) {
      if (param.required) {
        throw new Error(`Missing required parameter: ${name}`);
      }
      continue;
    }

    const validationError = validateParameterValue(value, param);
    if (validationError) {
      throw new Error(`Parameter '${name}' ${validationError}`);
    }

    switch (param.in) {
      case 'query':
        if (Array.isArray(value)) {
          for (const item of value) {
            queryParams.append(name, String(item));
          }
        } else {
          queryParams.set(name, String(value));
        }
        break;
      case 'header':
        headers[name] = String(value);
        break;
      case 'path':
        // Already substituted in path template.
        break;
      case 'cookie': {
        const existing = headers['Cookie'];
        headers['Cookie'] = existing ? `${existing}; ${name}=${String(value)}` : `${name}=${String(value)}`;
        break;
      }
      default:
        break;
    }
  }

  if (requestBody && requestBody.required && args.requestBody === undefined) {
    throw new Error('Missing required requestBody parameter');
  }

  if (args.requestBody !== undefined) {
    requestBodyValue = args.requestBody;
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  if (!apiToolConfig.disableXMcp) {
    headers['X-MCP'] = '1';
  }

  applySecurityToRequest(apiCallDetails, headers, queryParams);
  endpoint.search = queryParams.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiToolConfig.requestTimeoutMs);

  try {
    const response = await fetch(endpoint.toString(), {
      method,
      headers,
      body:
        requestBodyValue === undefined
          ? undefined
          : headers['Content-Type']?.includes('application/json')
            ? JSON.stringify(requestBodyValue)
            : String(requestBodyValue),
      signal: controller.signal,
    });

    const raw = await response.text();
    let body: unknown = raw;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json') && raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else {
      body = null;
    }

    if (response.ok) {
      return body;
    }

    throw new Error(`API Error ${response.status}: ${responseBodyToString(body)}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`API request timed out after ${apiToolConfig.requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class ApiToolRegistry {
  private bundleCache = new Map<string, ApiMappedTool[]>();
  private operationCache = new Map<string, ApiMappedTool>();

  private registerMappedTools(sourceToolName: string, mappedTools: ApiMappedTool[]): void {
    this.bundleCache.set(sourceToolName, mappedTools);
    for (const mapped of mappedTools) {
      const existing = this.operationCache.get(mapped.mcpToolDefinition.name);
      if (existing && existing.sourceToolName !== sourceToolName) {
        logger.warn(
          `[ApiToolExecutor] Tool name collision: '${mapped.mcpToolDefinition.name}' from '${sourceToolName}' overrides '${existing.sourceToolName}'. Use namePrefix to avoid collisions.`
        );
      }
      this.operationCache.set(mapped.mcpToolDefinition.name, mapped);
    }
  }

  async ensureBundle(sourceToolName: string, tool: CustomToolDefinition): Promise<ApiMappedTool[]> {
    const cached = this.bundleCache.get(sourceToolName);
    if (cached) return cached;

    if (!isApiToolDefinition(tool)) {
      return [];
    }

    const openapi = await loadOpenApiDocument(tool);
    const mapped = mapOpenApiToTools(openapi, tool);
    this.registerMappedTools(sourceToolName, mapped);
    return mapped;
  }

  async ensureAll(toolMap: Map<string, CustomToolDefinition>): Promise<void> {
    for (const [sourceToolName, tool] of toolMap.entries()) {
      if (!isApiToolDefinition(tool)) continue;
      await this.ensureBundle(sourceToolName, tool);
    }
  }

  async listMappedTools(toolMap: Map<string, CustomToolDefinition>): Promise<ApiMappedTool[]> {
    await this.ensureAll(toolMap);
    return Array.from(this.operationCache.values());
  }

  async getMappedTool(
    toolName: string,
    toolMap: Map<string, CustomToolDefinition>
  ): Promise<ApiMappedTool | undefined> {
    const cached = this.operationCache.get(toolName);
    if (cached) return cached;

    for (const [sourceToolName, tool] of toolMap.entries()) {
      if (!isApiToolDefinition(tool)) continue;
      await this.ensureBundle(sourceToolName, tool);
      const resolved = this.operationCache.get(toolName);
      if (resolved) return resolved;
    }

    return undefined;
  }
}
