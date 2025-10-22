import { MemoryConfig } from './types/config';
/**
 * Memory store for persistent key-value storage across checks
 * Supports namespaces for isolation and both in-memory and file-based persistence
 */
export declare class MemoryStore {
    private static instance;
    private data;
    private config;
    private initialized;
    private constructor();
    /**
     * Get singleton instance
     */
    static getInstance(config?: MemoryConfig): MemoryStore;
    /**
     * Reset singleton instance (for testing)
     */
    static resetInstance(): void;
    /**
     * Initialize memory store (load from file if configured)
     */
    initialize(): Promise<void>;
    /**
     * Normalize and apply defaults to config
     */
    private normalizeConfig;
    /**
     * Get the default namespace
     */
    getDefaultNamespace(): string;
    /**
     * Get a value from memory
     */
    get(key: string, namespace?: string): unknown;
    /**
     * Check if a key exists in memory
     */
    has(key: string, namespace?: string): boolean;
    /**
     * Set a value in memory (override existing)
     */
    set(key: string, value: unknown, namespace?: string): Promise<void>;
    /**
     * Append a value to an array in memory
     * If key doesn't exist, creates a new array
     * If key exists but is not an array, converts it to an array
     */
    append(key: string, value: unknown, namespace?: string): Promise<void>;
    /**
     * Increment a numeric value in memory
     * If key doesn't exist, initializes to 0 before incrementing
     * If key exists but is not a number, throws an error
     */
    increment(key: string, amount?: number, namespace?: string): Promise<number>;
    /**
     * Delete a key from memory
     */
    delete(key: string, namespace?: string): Promise<boolean>;
    /**
     * Clear all keys in a namespace (or all namespaces if none specified)
     */
    clear(namespace?: string): Promise<void>;
    /**
     * List all keys in a namespace
     */
    list(namespace?: string): string[];
    /**
     * List all namespaces
     */
    listNamespaces(): string[];
    /**
     * Get all data in a namespace
     */
    getAll(namespace?: string): Record<string, unknown>;
    /**
     * Load data from file
     */
    load(): Promise<void>;
    /**
     * Save data to file
     */
    save(): Promise<void>;
    /**
     * Load data from JSON format
     */
    private loadFromJson;
    /**
     * Save data to JSON format
     */
    private saveToJson;
    /**
     * Load data from CSV format
     * CSV format: namespace,key,value,type
     */
    private loadFromCsv;
    /**
     * Save data to CSV format
     */
    private saveToCsv;
    /**
     * Parse a CSV line, handling quoted values with commas
     */
    private parseCsvLine;
    /**
     * Format a CSV line with proper escaping
     */
    private formatCsvLine;
    /**
     * Escape a CSV value
     */
    private escapeCsv;
    /**
     * Format a value for CSV storage
     */
    private formatCsvValue;
    /**
     * Parse a CSV value based on its type
     */
    private parseCsvValue;
    /**
     * Get the type of a value for CSV storage
     */
    private getValueType;
    /**
     * Get the current configuration
     */
    getConfig(): MemoryConfig;
}
