/**
 * MCP Tools Support for Visor
 *
 * This module provides MCP (Model Context Protocol) tools integration
 * for the Claude Code check provider, enabling custom tools and
 * in-process MCP server creation.
 */

// MCP SDK types and interfaces
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: McpTool[];
}

interface McpServerInstance {
  name: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Built-in MCP tools for Visor code analysis
 */
export class VisorMcpTools {
  /**
   * Get built-in MCP tools for code analysis
   */
  static getBuiltInTools(): McpTool[] {
    return [
      {
        name: 'analyze_file_structure',
        description: 'Analyze the structure and organization of files in a PR',
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of file paths to analyze',
            },
          },
          required: ['files'],
        },
        handler: this.analyzeFileStructure,
      },
      {
        name: 'detect_patterns',
        description: 'Detect common code patterns and anti-patterns',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Code content to analyze for patterns',
            },
            language: {
              type: 'string',
              description: 'Programming language of the code',
            },
          },
          required: ['content'],
        },
        handler: this.detectPatterns,
      },
      {
        name: 'calculate_complexity',
        description: 'Calculate code complexity metrics',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Code content to analyze',
            },
            language: {
              type: 'string',
              description: 'Programming language of the code',
            },
          },
          required: ['content'],
        },
        handler: this.calculateComplexity,
      },
      {
        name: 'suggest_improvements',
        description: 'Suggest code improvements based on best practices',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Code content to improve',
            },
            language: {
              type: 'string',
              description: 'Programming language of the code',
            },
            focus: {
              type: 'string',
              enum: ['security', 'performance', 'maintainability', 'readability'],
              description: 'Focus area for improvements',
            },
          },
          required: ['content'],
        },
        handler: this.suggestImprovements,
      },
    ];
  }

  /**
   * Analyze file structure and organization
   */
  private static async analyzeFileStructure(args: Record<string, unknown>): Promise<unknown> {
    const { files } = args as { files: string[] };

    const analysis = {
      totalFiles: files.length,
      directories: new Set<string>(),
      extensions: new Map<string, number>(),
      patterns: {
        hasTests: false,
        hasConfig: false,
        hasReadme: false,
        hasTypeScript: false,
      },
      structure: {
        depth: 0,
        organization: 'unknown',
      },
    };

    for (const file of files) {
      // Extract directory
      const dir = file.substring(0, file.lastIndexOf('/')) || '.';
      analysis.directories.add(dir);

      // Extract extension
      const ext = file.substring(file.lastIndexOf('.') + 1).toLowerCase();
      analysis.extensions.set(ext, (analysis.extensions.get(ext) || 0) + 1);

      // Detect patterns
      if (file.includes('test') || file.includes('spec')) {
        analysis.patterns.hasTests = true;
      }
      if (file.includes('config') || file.includes('.json') || file.includes('.yaml')) {
        analysis.patterns.hasConfig = true;
      }
      if (file.includes('README')) {
        analysis.patterns.hasReadme = true;
      }
      if (['ts'].includes(ext)) {
        analysis.patterns.hasTypeScript = true;
      }

      // Calculate depth
      const depth = file.split('/').length - 1;
      analysis.structure.depth = Math.max(analysis.structure.depth, depth);
    }

    // Determine organization pattern
    if (analysis.directories.has('src') || analysis.directories.has('lib')) {
      analysis.structure.organization = 'standard';
    } else if (analysis.directories.has('app') || analysis.directories.has('components')) {
      analysis.structure.organization = 'framework';
    } else {
      analysis.structure.organization = 'flat';
    }

    return {
      analysis,
      recommendations: this.generateStructureRecommendations(analysis),
    };
  }

  /**
   * Detect common code patterns and anti-patterns
   */
  private static async detectPatterns(args: Record<string, unknown>): Promise<unknown> {
    const { content } = args as { content: string; language?: string };

    const patterns = {
      designPatterns: [] as string[],
      antiPatterns: [] as string[],
      codeSmells: [] as string[],
      bestPractices: [] as string[],
    };

    // Basic pattern detection (can be extended with more sophisticated analysis)
    const lines = content.split('\n');

    // Detect design patterns
    if (content.includes('class') && content.includes('interface')) {
      patterns.designPatterns.push('Interface Segregation');
    }
    if (content.includes('factory') || content.includes('Factory')) {
      patterns.designPatterns.push('Factory Pattern');
    }
    if (content.includes('singleton') || content.includes('Singleton')) {
      patterns.designPatterns.push('Singleton Pattern');
    }

    // Detect anti-patterns
    if (lines.some(line => line.length > 120)) {
      patterns.antiPatterns.push('Long Lines');
    }
    if (content.includes('any')) {
      patterns.antiPatterns.push('Any Type Usage');
    }
    if (content.includes('console.log') || content.includes('print(')) {
      patterns.antiPatterns.push('Debug Code Left in Production');
    }

    // Detect code smells
    const functionCount = (content.match(/function|def |fn /g) || []).length;
    const classCount = (content.match(/class /g) || []).length;
    if (functionCount > 10 && classCount === 0) {
      patterns.codeSmells.push('Large Function Collection - Consider Class Organization');
    }

    // Detect best practices
    if (content.includes('const ') || content.includes('final ')) {
      patterns.bestPractices.push('Immutable Variable Usage');
    }
    if (content.includes('try') && content.includes('catch')) {
      patterns.bestPractices.push('Error Handling');
    }

    return patterns;
  }

  /**
   * Calculate code complexity metrics
   */
  private static async calculateComplexity(args: Record<string, unknown>): Promise<unknown> {
    const { content } = args as { content: string; language?: string };

    const lines = content.split('\n');
    const nonEmptyLines = lines.filter(line => line.trim().length > 0);

    const metrics = {
      linesOfCode: lines.length,
      nonEmptyLines: nonEmptyLines.length,
      cyclomaticComplexity: this.calculateCyclomaticComplexity(content),
      nestingDepth: this.calculateNestingDepth(content),
      functionCount: (content.match(/function|def |fn /g) || []).length,
      classCount: (content.match(/class /g) || []).length,
      complexity: 'low' as 'low' | 'medium' | 'high',
    };

    // Determine overall complexity
    if (metrics.cyclomaticComplexity > 10 || metrics.nestingDepth > 4) {
      metrics.complexity = 'high';
    } else if (metrics.cyclomaticComplexity > 5 || metrics.nestingDepth > 2) {
      metrics.complexity = 'medium';
    }

    return {
      metrics,
      recommendations: this.generateComplexityRecommendations(metrics),
    };
  }

  /**
   * Suggest code improvements based on best practices
   */
  private static async suggestImprovements(args: Record<string, unknown>): Promise<unknown> {
    const { content, focus } = args as {
      content: string;
      language?: string;
      focus?: string;
    };

    const suggestions = {
      security: [] as string[],
      performance: [] as string[],
      maintainability: [] as string[],
      readability: [] as string[],
    };

    // Security suggestions
    if (!focus || focus === 'security') {
      if (content.includes('eval(') || content.includes('exec(')) {
        suggestions.security.push('Avoid using eval() or exec() functions - security risk');
      }
      if (content.includes('document.write') || content.includes('innerHTML')) {
        suggestions.security.push('Consider using safer DOM manipulation methods to prevent XSS');
      }
      if (content.includes('http://') && !content.includes('localhost')) {
        suggestions.security.push('Use HTTPS instead of HTTP for external requests');
      }
    }

    // Performance suggestions
    if (!focus || focus === 'performance') {
      if (content.includes('for') && content.includes('length')) {
        suggestions.performance.push('Cache array length in loops for better performance');
      }
      if (content.includes('querySelector') && content.includes('loop')) {
        suggestions.performance.push('Consider caching DOM queries outside of loops');
      }
    }

    // Maintainability suggestions
    if (!focus || focus === 'maintainability') {
      const functionMatches = content.match(/function[^{]*{[^}]*}/g) || [];
      const longFunctions = functionMatches.filter(fn => fn.split('\n').length > 20);
      if (longFunctions.length > 0) {
        suggestions.maintainability.push(
          'Consider breaking down large functions into smaller ones'
        );
      }

      if (content.includes('// TODO') || content.includes('// FIXME')) {
        suggestions.maintainability.push('Address TODO and FIXME comments');
      }
    }

    // Readability suggestions
    if (!focus || focus === 'readability') {
      const lines = content.split('\n');
      const longLines = lines.filter(line => line.length > 100);
      if (longLines.length > 0) {
        suggestions.readability.push('Consider breaking long lines for better readability');
      }

      if (!/\/\*\*|\/\//.test(content)) {
        suggestions.readability.push('Add comments to explain complex logic');
      }
    }

    return {
      suggestions,
      focusArea: focus || 'all',
      priority: this.calculatePriority(suggestions),
    };
  }

  /**
   * Generate structure recommendations
   */
  private static generateStructureRecommendations(analysis: {
    patterns: { hasTests: boolean; hasConfig: boolean; hasReadme: boolean; hasTypeScript: boolean };
    structure: { depth: number; organization: string };
    totalFiles: number;
  }): string[] {
    const recommendations: string[] = [];

    if (!analysis.patterns.hasTests) {
      recommendations.push('Add test files to improve code reliability');
    }

    if (!analysis.patterns.hasReadme) {
      recommendations.push('Add documentation (README.md) to explain the project');
    }

    if (analysis.structure.depth > 5) {
      recommendations.push('Consider flattening deep directory structure');
    }

    if (analysis.structure.organization === 'flat' && analysis.totalFiles > 10) {
      recommendations.push('Consider organizing files into directories by feature or type');
    }

    return recommendations;
  }

  /**
   * Calculate cyclomatic complexity (simplified)
   */
  private static calculateCyclomaticComplexity(content: string): number {
    const decisionPoints = [
      /if\s*\(/g,
      /else\s+if\s*\(/g,
      /while\s*\(/g,
      /for\s*\(/g,
      /case\s+/g,
      /catch\s*\(/g,
      /\?\s*:/g, // ternary operator
    ];

    let complexity = 1; // base complexity

    for (const pattern of decisionPoints) {
      const matches = content.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  /**
   * Calculate nesting depth
   */
  private static calculateNestingDepth(content: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of content) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth--;
      }
    }

    return maxDepth;
  }

  /**
   * Generate complexity recommendations
   */
  private static generateComplexityRecommendations(metrics: {
    cyclomaticComplexity: number;
    nestingDepth: number;
    linesOfCode: number;
    nonEmptyLines: number;
  }): string[] {
    const recommendations: string[] = [];

    if (metrics.cyclomaticComplexity > 10) {
      recommendations.push('High cyclomatic complexity - consider breaking down functions');
    }

    if (metrics.nestingDepth > 4) {
      recommendations.push('Deep nesting detected - consider extracting nested logic');
    }

    if (metrics.nonEmptyLines > 500) {
      recommendations.push('Large file size - consider splitting into smaller modules');
    }

    return recommendations;
  }

  /**
   * Calculate priority based on suggestions
   */
  private static calculatePriority(
    suggestions: Record<string, string[]>
  ): 'low' | 'medium' | 'high' {
    const totalSuggestions = Object.values(suggestions).flat().length;
    const securityIssues = suggestions.security?.length || 0;

    if (securityIssues > 0 || totalSuggestions > 10) {
      return 'high';
    } else if (totalSuggestions > 5) {
      return 'medium';
    } else {
      return 'low';
    }
  }
}

/**
 * MCP Server Manager for handling external MCP servers
 */
export class McpServerManager {
  private servers: Map<string, McpServerInstance> = new Map();

  /**
   * Create and register an MCP server
   */
  async createServer(config: McpServer): Promise<McpServerInstance> {
    try {
      let server: McpServerInstance;

      if (config.tools) {
        // In-process server with built-in tools
        server = new InProcessMcpServer(config.name, config.tools);
      } else if (config.command) {
        // External process server
        server = await this.createExternalServer(config);
      } else {
        throw new Error('Server must have either tools or command configuration');
      }

      this.servers.set(config.name, server);
      return server;
    } catch (error) {
      throw new Error(
        `Failed to create MCP server ${config.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get a registered server by name
   */
  getServer(name: string): McpServerInstance | undefined {
    return this.servers.get(name);
  }

  /**
   * List all available tools from all servers
   */
  async listAllTools(): Promise<Array<{ serverName: string; tool: McpTool }>> {
    const allTools: Array<{ serverName: string; tool: McpTool }> = [];

    for (const [serverName, server] of this.servers) {
      try {
        const tools = await server.listTools();
        tools.forEach(tool => {
          allTools.push({ serverName, tool });
        });
      } catch (error) {
        const { logger } = require('../logger');
        logger.warn(
          `Failed to list tools from server ${serverName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return allTools;
  }

  /**
   * Close all servers
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.servers.values()).map(server =>
      server.close().catch(async error => {
        const { logger } = require('../logger');
        logger.warn(
          `Error closing MCP server: ${error instanceof Error ? error.message : String(error)}`
        );
      })
    );

    await Promise.all(closePromises);
    this.servers.clear();
  }

  /**
   * Create external MCP server instance
   */
  private async createExternalServer(config: McpServer): Promise<McpServerInstance> {
    // This would be implemented using the MCP SDK to spawn external processes
    // For now, return a mock implementation
    return new ExternalMcpServer(config);
  }
}

/**
 * In-process MCP server implementation
 */
class InProcessMcpServer implements McpServerInstance {
  constructor(
    public readonly name: string,
    private tools: McpTool[]
  ) {}

  async listTools(): Promise<McpTool[]> {
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found in server ${this.name}`);
    }

    if (!tool.handler) {
      throw new Error(`Tool ${toolName} has no handler`);
    }

    return await tool.handler(args);
  }

  async close(): Promise<void> {
    // Nothing to close for in-process server
  }
}

/**
 * External MCP server implementation (placeholder)
 */
class ExternalMcpServer implements McpServerInstance {
  constructor(private config: McpServer) {}

  get name(): string {
    return this.config.name;
  }

  async listTools(): Promise<McpTool[]> {
    // This would communicate with the external process to get tools
    // For now, return empty array
    return [];
  }

  async callTool(_name: string, _args: Record<string, unknown>): Promise<unknown> {
    // This would communicate with the external process to call the tool
    // For now, throw an error
    throw new Error(`External MCP server not implemented yet`);
  }

  async close(): Promise<void> {
    // This would terminate the external process
  }
}

/**
 * Default MCP tools configuration for Visor
 */
export const DEFAULT_MCP_TOOLS_CONFIG: McpServer[] = [
  {
    name: 'visor-builtin',
    tools: VisorMcpTools.getBuiltInTools(),
  },
];
