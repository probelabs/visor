import fs from 'fs/promises';
import path from 'path';
import { MemoryConfig } from './types/config';
import { logger } from './logger';

/**
 * Memory store for persistent key-value storage across checks
 * Supports namespaces for isolation and both in-memory and file-based persistence
 */
export class MemoryStore {
  private static instance: MemoryStore;
  private data: Map<string, Map<string, unknown>>; // namespace -> key -> value
  private config: MemoryConfig;
  private initialized = false;

  private constructor(config?: MemoryConfig) {
    this.data = new Map();
    this.config = this.normalizeConfig(config);
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: MemoryConfig): MemoryStore {
    if (!MemoryStore.instance) {
      MemoryStore.instance = new MemoryStore(config);
    } else if (config && !MemoryStore.instance.initialized) {
      // Update config if not yet initialized
      MemoryStore.instance.config = MemoryStore.instance.normalizeConfig(config);
    }
    return MemoryStore.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    MemoryStore.instance = undefined!;
  }

  /**
   * Initialize memory store (load from file if configured)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Auto-load if file storage is configured
    if (this.config.storage === 'file' && this.config.auto_load && this.config.file) {
      try {
        await this.load();
        logger.debug(`Memory store loaded from ${this.config.file}`);
      } catch (error) {
        // If file doesn't exist, that's ok - we'll create it on first save
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(
            `Failed to load memory store from ${this.config.file}: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Normalize and apply defaults to config
   */
  private normalizeConfig(config?: MemoryConfig): MemoryConfig {
    const storage = config?.storage || 'memory';
    return {
      storage,
      format: config?.format || 'json',
      file: config?.file,
      namespace: config?.namespace || 'default',
      auto_load: config?.auto_load !== false,
      auto_save: config?.auto_save !== false,
    };
  }

  /**
   * Get the default namespace
   */
  getDefaultNamespace(): string {
    return this.config.namespace || 'default';
  }

  /**
   * Get a value from memory
   */
  get(key: string, namespace?: string): unknown {
    const ns = namespace || this.getDefaultNamespace();
    const nsData = this.data.get(ns);
    return nsData?.get(key);
  }

  /**
   * Check if a key exists in memory
   */
  has(key: string, namespace?: string): boolean {
    const ns = namespace || this.getDefaultNamespace();
    const nsData = this.data.get(ns);
    return nsData?.has(key) || false;
  }

  /**
   * Set a value in memory (override existing)
   */
  async set(key: string, value: unknown, namespace?: string): Promise<void> {
    const ns = namespace || this.getDefaultNamespace();

    // Ensure namespace exists
    if (!this.data.has(ns)) {
      this.data.set(ns, new Map());
    }

    const nsData = this.data.get(ns)!;
    nsData.set(key, value);

    // Auto-save if configured
    if (this.config.storage === 'file' && this.config.auto_save) {
      await this.save();
    }
  }

  /**
   * Append a value to an array in memory
   * If key doesn't exist, creates a new array
   * If key exists but is not an array, converts it to an array
   */
  async append(key: string, value: unknown, namespace?: string): Promise<void> {
    const ns = namespace || this.getDefaultNamespace();
    const existing = this.get(key, ns);

    let newValue: unknown[];
    if (existing === undefined) {
      // Create new array
      newValue = [value];
    } else if (Array.isArray(existing)) {
      // Append to existing array
      newValue = [...existing, value];
    } else {
      // Convert single value to array with both values
      newValue = [existing, value];
    }

    await this.set(key, newValue, ns);
  }

  /**
   * Increment a numeric value in memory
   * If key doesn't exist, initializes to 0 before incrementing
   * If key exists but is not a number, throws an error
   */
  async increment(key: string, amount = 1, namespace?: string): Promise<number> {
    const ns = namespace || this.getDefaultNamespace();
    const existing = this.get(key, ns);

    let newValue: number;
    if (existing === undefined || existing === null) {
      // Initialize to 0 and then increment
      newValue = amount;
    } else if (typeof existing === 'number') {
      // Increment existing number
      newValue = existing + amount;
    } else {
      throw new Error(
        `Cannot increment non-numeric value at key '${key}' (type: ${typeof existing})`
      );
    }

    await this.set(key, newValue, ns);
    return newValue;
  }

  /**
   * Delete a key from memory
   */
  async delete(key: string, namespace?: string): Promise<boolean> {
    const ns = namespace || this.getDefaultNamespace();
    const nsData = this.data.get(ns);

    if (!nsData) {
      return false;
    }

    const deleted = nsData.delete(key);

    // Auto-save if configured
    if (deleted && this.config.storage === 'file' && this.config.auto_save) {
      await this.save();
    }

    return deleted;
  }

  /**
   * Clear all keys in a namespace (or all namespaces if none specified)
   */
  async clear(namespace?: string): Promise<void> {
    if (namespace) {
      // Clear specific namespace
      this.data.delete(namespace);
    } else {
      // Clear all namespaces
      this.data.clear();
    }

    // Auto-save if configured
    if (this.config.storage === 'file' && this.config.auto_save) {
      await this.save();
    }
  }

  /**
   * List all keys in a namespace
   */
  list(namespace?: string): string[] {
    const ns = namespace || this.getDefaultNamespace();
    const nsData = this.data.get(ns);
    return nsData ? Array.from(nsData.keys()) : [];
  }

  /**
   * List all namespaces
   */
  listNamespaces(): string[] {
    return Array.from(this.data.keys());
  }

  /**
   * Get all data in a namespace
   */
  getAll(namespace?: string): Record<string, unknown> {
    const ns = namespace || this.getDefaultNamespace();
    const nsData = this.data.get(ns);
    if (!nsData) {
      return {};
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of nsData.entries()) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Load data from file
   */
  async load(): Promise<void> {
    if (!this.config.file) {
      throw new Error('No file path configured for memory store');
    }

    const filePath = path.resolve(process.cwd(), this.config.file);
    const content = await fs.readFile(filePath, 'utf-8');

    if (this.config.format === 'json') {
      await this.loadFromJson(content);
    } else if (this.config.format === 'csv') {
      await this.loadFromCsv(content);
    } else {
      throw new Error(`Unsupported format: ${this.config.format}`);
    }
  }

  /**
   * Save data to file
   */
  async save(): Promise<void> {
    if (!this.config.file) {
      throw new Error('No file path configured for memory store');
    }

    const filePath = path.resolve(process.cwd(), this.config.file);

    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    let content: string;
    if (this.config.format === 'json') {
      content = this.saveToJson();
    } else if (this.config.format === 'csv') {
      content = this.saveToCsv();
    } else {
      throw new Error(`Unsupported format: ${this.config.format}`);
    }

    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Load data from JSON format
   */
  private async loadFromJson(content: string): Promise<void> {
    const data = JSON.parse(content);

    // Clear existing data
    this.data.clear();

    // Load namespaces
    for (const [namespace, nsData] of Object.entries(data)) {
      if (typeof nsData === 'object' && nsData !== null && !Array.isArray(nsData)) {
        const nsMap = new Map<string, unknown>();
        for (const [key, value] of Object.entries(nsData)) {
          nsMap.set(key, value);
        }
        this.data.set(namespace, nsMap);
      }
    }
  }

  /**
   * Save data to JSON format
   */
  private saveToJson(): string {
    const result: Record<string, Record<string, unknown>> = {};

    for (const [namespace, nsData] of this.data.entries()) {
      const nsObj: Record<string, unknown> = {};
      for (const [key, value] of nsData.entries()) {
        nsObj[key] = value;
      }
      result[namespace] = nsObj;
    }

    return JSON.stringify(result, null, 2);
  }

  /**
   * Load data from CSV format
   * CSV format: namespace,key,value,type
   */
  private async loadFromCsv(content: string): Promise<void> {
    const lines = content.split('\n').filter(line => line.trim());

    // Skip header if present
    let startIndex = 0;
    if (lines[0]?.startsWith('namespace,')) {
      startIndex = 1;
    }

    // Clear existing data
    this.data.clear();

    // Track arrays (keys that have multiple values)
    const arrays = new Map<string, Map<string, unknown[]>>(); // namespace -> key -> values[]

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      const parts = this.parseCsvLine(line);

      if (parts.length < 3) {
        logger.warn(`Invalid CSV line ${i + 1}: ${line}`);
        continue;
      }

      const [namespace, key, valueStr, typeStr] = parts;
      const value = this.parseCsvValue(valueStr, typeStr);

      // Ensure namespace exists in data
      if (!this.data.has(namespace)) {
        this.data.set(namespace, new Map());
        arrays.set(namespace, new Map());
      }

      const nsData = this.data.get(namespace)!;
      const nsArrays = arrays.get(namespace)!;

      // Check if this is a duplicate key (array)
      if (nsData.has(key)) {
        // Convert to array if not already
        if (!nsArrays.has(key)) {
          const existingValue = nsData.get(key);
          nsArrays.set(key, [existingValue]);
        }
        nsArrays.get(key)!.push(value);
        nsData.set(key, nsArrays.get(key)!);
      } else {
        // First occurrence
        nsData.set(key, value);
      }
    }
  }

  /**
   * Save data to CSV format
   */
  private saveToCsv(): string {
    const lines: string[] = ['namespace,key,value,type'];

    for (const [namespace, nsData] of this.data.entries()) {
      for (const [key, value] of nsData.entries()) {
        if (Array.isArray(value)) {
          // Multiple rows for arrays
          for (const item of value) {
            lines.push(this.formatCsvLine(namespace, key, item));
          }
        } else {
          // Single row
          lines.push(this.formatCsvLine(namespace, key, value));
        }
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Parse a CSV line, handling quoted values with commas
   */
  private parseCsvLine(line: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          // Toggle quotes
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    // Add last field
    parts.push(current);

    return parts;
  }

  /**
   * Format a CSV line with proper escaping
   */
  private formatCsvLine(namespace: string, key: string, value: unknown): string {
    const type = this.getValueType(value);
    const valueStr = this.formatCsvValue(value);

    return `${this.escapeCsv(namespace)},${this.escapeCsv(key)},${valueStr},${type}`;
  }

  /**
   * Escape a CSV value
   */
  private escapeCsv(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Format a value for CSV storage
   */
  private formatCsvValue(value: unknown): string {
    if (value === null) {
      return '""';
    }
    if (value === undefined) {
      return '""';
    }
    if (typeof value === 'string') {
      return this.escapeCsv(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return this.escapeCsv(String(value));
    }
    // Objects and arrays are serialized as JSON
    return this.escapeCsv(JSON.stringify(value));
  }

  /**
   * Parse a CSV value based on its type
   */
  private parseCsvValue(valueStr: string, typeStr?: string): unknown {
    if (!typeStr || typeStr === 'string') {
      return valueStr;
    }
    if (typeStr === 'number') {
      return Number(valueStr);
    }
    if (typeStr === 'boolean') {
      return valueStr === 'true';
    }
    if (typeStr === 'object' || typeStr === 'array') {
      try {
        return JSON.parse(valueStr);
      } catch {
        return valueStr;
      }
    }
    return valueStr;
  }

  /**
   * Get the type of a value for CSV storage
   */
  private getValueType(value: unknown): string {
    if (value === null || value === undefined) {
      return 'string';
    }
    if (typeof value === 'number') {
      return 'number';
    }
    if (typeof value === 'boolean') {
      return 'boolean';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    if (typeof value === 'object') {
      return 'object';
    }
    return 'string';
  }

  /**
   * Get the current configuration
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }
}
