import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { VisorConfig } from '../types/config';

/**
 * Configuration source types
 */
export enum ConfigSourceType {
  LOCAL = 'local',
  REMOTE = 'remote',
  DEFAULT = 'default',
}

/**
 * Cache entry for remote configurations
 */
interface CacheEntry {
  config: Partial<VisorConfig>;
  timestamp: number;
  ttl: number;
}

/**
 * Options for loading configurations
 */
export interface ConfigLoaderOptions {
  /** Base directory for resolving relative paths */
  baseDir?: string;
  /** Whether to allow remote extends (default: true) */
  allowRemote?: boolean;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTTL?: number;
  /** Request timeout in milliseconds (default: 30 seconds) */
  timeout?: number;
  /** Maximum recursion depth (default: 10) */
  maxDepth?: number;
  /** Allowed remote URL patterns (default: ['https://github.com/', 'https://raw.githubusercontent.com/']) */
  allowedRemotePatterns?: string[];
  /** Project root directory for path traversal protection */
  projectRoot?: string;
}

/**
 * Utility class for loading configurations from various sources
 */
export class ConfigLoader {
  private cache: Map<string, CacheEntry> = new Map();
  private loadedConfigs: Set<string> = new Set();

  constructor(private options: ConfigLoaderOptions = {}) {
    this.options = {
      allowRemote: true,
      cacheTTL: 5 * 60 * 1000, // 5 minutes
      timeout: 30 * 1000, // 30 seconds
      maxDepth: 10,
      allowedRemotePatterns: [], // Empty by default for security
      projectRoot: this.findProjectRoot(),
      ...options,
    };
  }

  /**
   * Determine the source type from a string
   */
  private getSourceType(source: string): ConfigSourceType {
    if (source === 'default') {
      return ConfigSourceType.DEFAULT;
    }
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return ConfigSourceType.REMOTE;
    }
    return ConfigSourceType.LOCAL;
  }

  /**
   * Fetch configuration from any source
   */
  public async fetchConfig(
    source: string,
    currentDepth: number = 0
  ): Promise<Partial<VisorConfig>> {
    // Check recursion depth
    if (currentDepth >= (this.options.maxDepth || 10)) {
      throw new Error(
        `Maximum extends depth (${this.options.maxDepth}) exceeded. Check for circular dependencies.`
      );
    }

    // Check for circular dependencies
    const normalizedSource = this.normalizeSource(source);
    if (this.loadedConfigs.has(normalizedSource)) {
      throw new Error(
        `Circular dependency detected: ${normalizedSource} is already in the extends chain`
      );
    }

    const sourceType = this.getSourceType(source);

    try {
      this.loadedConfigs.add(normalizedSource);

      switch (sourceType) {
        case ConfigSourceType.DEFAULT:
          return await this.fetchDefaultConfig();
        case ConfigSourceType.REMOTE:
          if (!this.options.allowRemote) {
            throw new Error(
              'Remote extends are disabled. Enable with --allow-remote-extends or remove VISOR_NO_REMOTE_EXTENDS environment variable.'
            );
          }
          return await this.fetchRemoteConfig(source);
        case ConfigSourceType.LOCAL:
          return await this.fetchLocalConfig(source);
        default:
          throw new Error(`Unknown configuration source: ${source}`);
      }
    } finally {
      this.loadedConfigs.delete(normalizedSource);
    }
  }

  /**
   * Normalize source path/URL for comparison
   */
  private normalizeSource(source: string): string {
    const sourceType = this.getSourceType(source);

    switch (sourceType) {
      case ConfigSourceType.DEFAULT:
        return 'default';
      case ConfigSourceType.REMOTE:
        return source.toLowerCase();
      case ConfigSourceType.LOCAL:
        const basePath = this.options.baseDir || process.cwd();
        return path.resolve(basePath, source);
      default:
        return source;
    }
  }

  /**
   * Load configuration from local file system
   */
  private async fetchLocalConfig(filePath: string): Promise<Partial<VisorConfig>> {
    const basePath = this.options.baseDir || process.cwd();
    const resolvedPath = path.resolve(basePath, filePath);

    // Validate against path traversal attacks
    this.validateLocalPath(resolvedPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configuration file not found: ${resolvedPath}`);
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const config = yaml.load(content) as Partial<VisorConfig>;

      if (!config || typeof config !== 'object') {
        throw new Error(`Invalid YAML in configuration file: ${resolvedPath}`);
      }

      // Update base directory for nested extends
      const previousBaseDir = this.options.baseDir;
      this.options.baseDir = path.dirname(resolvedPath);

      try {
        // Process extends if present
        if (config.extends) {
          const processedConfig = await this.processExtends(config);
          return processedConfig;
        }

        return config;
      } finally {
        // Restore previous base directory
        this.options.baseDir = previousBaseDir;
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load configuration from ${resolvedPath}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Fetch configuration from remote URL
   */
  private async fetchRemoteConfig(url: string): Promise<Partial<VisorConfig>> {
    // Validate URL protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Invalid URL: ${url}. Only HTTP and HTTPS protocols are supported.`);
    }

    // Validate against SSRF attacks
    this.validateRemoteURL(url);

    // Check cache
    const cacheEntry = this.cache.get(url);
    if (cacheEntry && Date.now() - cacheEntry.timestamp < cacheEntry.ttl) {
      // Use stderr to avoid contaminating JSON/SARIF output
      const outputFormat = process.env.VISOR_OUTPUT_FORMAT;
      const logFn =
        outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;
      logFn(`📦 Using cached configuration from: ${url}`);
      return cacheEntry.config;
    }

    // Use stderr to avoid contaminating JSON/SARIF output
    const outputFormat = process.env.VISOR_OUTPUT_FORMAT;
    const logFn = outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;
    logFn(`⬇️  Fetching remote configuration from: ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout || 30000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Visor/1.0',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.status} ${response.statusText}`);
      }

      const content = await response.text();
      const config = yaml.load(content) as Partial<VisorConfig>;

      if (!config || typeof config !== 'object') {
        throw new Error(`Invalid YAML in remote configuration: ${url}`);
      }

      // Cache the configuration
      this.cache.set(url, {
        config,
        timestamp: Date.now(),
        ttl: this.options.cacheTTL || 5 * 60 * 1000,
      });

      // Process extends if present
      if (config.extends) {
        return await this.processExtends(config);
      }

      return config;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Timeout fetching configuration from ${url} (${this.options.timeout}ms)`);
        }
        throw new Error(`Failed to fetch remote configuration from ${url}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Load bundled default configuration
   */
  private async fetchDefaultConfig(): Promise<Partial<VisorConfig>> {
    // Try different paths to find the bundled default config
    const possiblePaths = [
      // When running as GitHub Action (bundled in dist/)
      path.join(__dirname, 'defaults', '.visor.yaml'),
      // When running from source
      path.join(__dirname, '..', '..', 'defaults', '.visor.yaml'),
      // Try via package root
      this.findPackageRoot() ? path.join(this.findPackageRoot()!, 'defaults', '.visor.yaml') : '',
      // GitHub Action environment variable
      process.env.GITHUB_ACTION_PATH
        ? path.join(process.env.GITHUB_ACTION_PATH, 'defaults', '.visor.yaml')
        : '',
      process.env.GITHUB_ACTION_PATH
        ? path.join(process.env.GITHUB_ACTION_PATH, 'dist', 'defaults', '.visor.yaml')
        : '',
    ].filter(p => p); // Remove empty paths

    let defaultConfigPath: string | undefined;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        defaultConfigPath = possiblePath;
        break;
      }
    }

    if (defaultConfigPath && fs.existsSync(defaultConfigPath)) {
      // Use stderr to avoid contaminating JSON/SARIF output
      const outputFormat = process.env.VISOR_OUTPUT_FORMAT;
      const logFn =
        outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;
      logFn(`📦 Loading bundled default configuration from ${defaultConfigPath}`);
      const content = fs.readFileSync(defaultConfigPath, 'utf8');
      const config = yaml.load(content) as Partial<VisorConfig>;

      if (!config || typeof config !== 'object') {
        throw new Error('Invalid default configuration');
      }

      // Default configs shouldn't have extends, but handle it just in case
      if (config.extends) {
        return await this.processExtends(config);
      }

      return config;
    }

    // Return minimal default if bundled config not found
    console.warn('⚠️  Bundled default configuration not found, using minimal defaults');
    return {
      version: '1.0',
      checks: {},
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: true,
        },
      },
    };
  }

  /**
   * Process extends directive in a configuration
   */
  private async processExtends(config: Partial<VisorConfig>): Promise<Partial<VisorConfig>> {
    if (!config.extends) {
      return config;
    }

    const extends_ = Array.isArray(config.extends) ? config.extends : [config.extends];

    // Remove extends from the config to avoid infinite recursion
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extends: _extendsField, ...configWithoutExtends } = config;

    // Load all parent configurations
    const parentConfigs: Partial<VisorConfig>[] = [];
    for (const source of extends_) {
      const parentConfig = await this.fetchConfig(source, this.loadedConfigs.size);
      parentConfigs.push(parentConfig);
    }

    // Merge configurations (will be implemented in config-merger.ts)
    // For now, we'll import it dynamically
    const { ConfigMerger } = await import('./config-merger');
    const merger = new ConfigMerger();

    // Merge all parent configs together first
    let mergedParents: Partial<VisorConfig> = {};
    for (const parentConfig of parentConfigs) {
      mergedParents = merger.merge(mergedParents, parentConfig);
    }

    // Then merge with the current config (child overrides parent)
    return merger.merge(mergedParents, configWithoutExtends);
  }

  /**
   * Find project root directory (for security validation)
   */
  private findProjectRoot(): string {
    // Try to find git root first
    try {
      const { execSync } = require('child_process');
      const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
      if (gitRoot) return gitRoot;
    } catch {
      // Not a git repo, continue
    }

    // Fall back to finding package.json
    const packageRoot = this.findPackageRoot();
    if (packageRoot) return packageRoot;

    // Last resort: use current working directory
    return process.cwd();
  }

  /**
   * Validate remote URL against allowlist
   */
  private validateRemoteURL(url: string): void {
    // If allowlist is empty, allow all URLs (backward compatibility)
    const allowedPatterns = this.options.allowedRemotePatterns || [];
    if (allowedPatterns.length === 0) {
      return;
    }

    // Check if URL matches any allowed pattern
    const isAllowed = allowedPatterns.some(pattern => url.startsWith(pattern));
    if (!isAllowed) {
      throw new Error(
        `Security error: URL ${url} is not in the allowed list. Allowed patterns: ${allowedPatterns.join(', ')}`
      );
    }
  }

  /**
   * Validate local path against traversal attacks
   */
  private validateLocalPath(resolvedPath: string): void {
    const projectRoot = this.options.projectRoot || process.cwd();
    const normalizedPath = path.normalize(resolvedPath);
    const normalizedRoot = path.normalize(projectRoot);

    // Check if the resolved path is within the project root
    if (!normalizedPath.startsWith(normalizedRoot)) {
      throw new Error(
        `Security error: Path traversal detected. Cannot access files outside project root: ${projectRoot}`
      );
    }

    // Additional check for sensitive system files
    const sensitivePatterns = [
      '/etc/passwd',
      '/etc/shadow',
      '/.ssh/',
      '/.aws/',
      '/.env',
      '/private/',
    ];

    const lowerPath = normalizedPath.toLowerCase();
    for (const pattern of sensitivePatterns) {
      if (lowerPath.includes(pattern)) {
        throw new Error(`Security error: Cannot access potentially sensitive file: ${pattern}`);
      }
    }
  }

  /**
   * Find package root directory
   */
  private findPackageRoot(): string | null {
    let currentDir = __dirname;
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          // Check if this is the Visor package
          if (packageJson.name === '@probelabs/visor') {
            return currentDir;
          }
        } catch {
          // Continue searching
        }
      }
      currentDir = path.dirname(currentDir);
    }

    return null;
  }

  /**
   * Clear the configuration cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Reset the loaded configs tracking (for testing)
   */
  public reset(): void {
    this.loadedConfigs.clear();
    this.clearCache();
  }
}
