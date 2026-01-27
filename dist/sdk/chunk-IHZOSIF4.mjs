import {
  init_logger,
  logger
} from "./chunk-3NMLT3YS.mjs";
import {
  __esm,
  __export
} from "./chunk-WMJKH4XE.mjs";

// src/memory-store.ts
var memory_store_exports = {};
__export(memory_store_exports, {
  MemoryStore: () => MemoryStore
});
import fs from "fs/promises";
import path from "path";
var MemoryStore;
var init_memory_store = __esm({
  "src/memory-store.ts"() {
    init_logger();
    MemoryStore = class _MemoryStore {
      static instance;
      data;
      // namespace -> key -> value
      config;
      initialized = false;
      constructor(config) {
        this.data = /* @__PURE__ */ new Map();
        this.config = this.normalizeConfig(config);
      }
      /**
       * Get singleton instance
       */
      static getInstance(config) {
        if (!_MemoryStore.instance) {
          _MemoryStore.instance = new _MemoryStore(config);
        } else if (config && !_MemoryStore.instance.initialized) {
          _MemoryStore.instance.config = _MemoryStore.instance.normalizeConfig(config);
        }
        return _MemoryStore.instance;
      }
      /**
       * Create a new isolated MemoryStore instance that does not affect the
       * process-wide singleton. Useful for nested workflows or tests where
       * state must not leak between runs.
       */
      static createIsolated(config) {
        return new _MemoryStore(config);
      }
      /**
       * Reset singleton instance (for testing)
       */
      static resetInstance() {
        _MemoryStore.instance = void 0;
      }
      /**
       * Initialize memory store (load from file if configured)
       */
      async initialize() {
        if (this.initialized) {
          return;
        }
        if (this.config.storage === "file" && this.config.auto_load && this.config.file) {
          try {
            await this.load();
            logger.debug(`Memory store loaded from ${this.config.file}`);
          } catch (error) {
            if (error.code !== "ENOENT") {
              logger.warn(
                `Failed to load memory store from ${this.config.file}: ${error instanceof Error ? error.message : "Unknown error"}`
              );
            }
          }
        }
        this.initialized = true;
      }
      /**
       * Normalize and apply defaults to config
       */
      normalizeConfig(config) {
        const storage = config?.storage || "memory";
        return {
          storage,
          format: config?.format || "json",
          file: config?.file,
          namespace: config?.namespace || "default",
          auto_load: config?.auto_load !== false,
          auto_save: config?.auto_save !== false
        };
      }
      /**
       * Get the default namespace
       */
      getDefaultNamespace() {
        return this.config.namespace || "default";
      }
      /**
       * Get a value from memory
       */
      get(key, namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const nsData = this.data.get(ns);
        return nsData?.get(key);
      }
      /**
       * Check if a key exists in memory
       */
      has(key, namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const nsData = this.data.get(ns);
        return nsData?.has(key) || false;
      }
      /**
       * Set a value in memory (override existing)
       */
      async set(key, value, namespace) {
        const ns = namespace || this.getDefaultNamespace();
        if (!this.data.has(ns)) {
          this.data.set(ns, /* @__PURE__ */ new Map());
        }
        const nsData = this.data.get(ns);
        nsData.set(key, value);
        try {
          if (process.env.VISOR_DEBUG === "true" || process.env.JEST_WORKER_ID !== void 0) {
            if (ns === "fact-validation" && (key === "total_validations" || key === "all_valid")) {
              console.log("[MemoryStore] SET " + ns + "." + key + " = " + JSON.stringify(value));
            }
          }
        } catch {
        }
        try {
          if (process.env.VISOR_DEBUG === "true" || process.env.JEST_WORKER_ID !== void 0) {
            if (ns === "fact-validation" && (key === "total_validations" || key === "all_valid")) {
              console.log();
            }
          }
        } catch {
        }
        if (this.config.storage === "file" && this.config.auto_save) {
          await this.save();
        }
      }
      /**
       * Append a value to an array in memory
       * If key doesn't exist, creates a new array
       * If key exists but is not an array, converts it to an array
       */
      async append(key, value, namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const existing = this.get(key, ns);
        let newValue;
        if (existing === void 0) {
          newValue = [value];
        } else if (Array.isArray(existing)) {
          newValue = [...existing, value];
        } else {
          newValue = [existing, value];
        }
        await this.set(key, newValue, ns);
      }
      /**
       * Increment a numeric value in memory
       * If key doesn't exist, initializes to 0 before incrementing
       * If key exists but is not a number, throws an error
       */
      async increment(key, amount = 1, namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const existing = this.get(key, ns);
        let newValue;
        if (existing === void 0 || existing === null) {
          newValue = amount;
        } else if (typeof existing === "number") {
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
      async delete(key, namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const nsData = this.data.get(ns);
        if (!nsData) {
          return false;
        }
        const deleted = nsData.delete(key);
        if (deleted && this.config.storage === "file" && this.config.auto_save) {
          await this.save();
        }
        return deleted;
      }
      /**
       * Clear all keys in a namespace (or all namespaces if none specified)
       */
      async clear(namespace) {
        if (namespace) {
          this.data.delete(namespace);
        } else {
          this.data.clear();
        }
        if (this.config.storage === "file" && this.config.auto_save) {
          await this.save();
        }
      }
      /**
       * List all keys in a namespace
       */
      list(namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const nsData = this.data.get(ns);
        return nsData ? Array.from(nsData.keys()) : [];
      }
      /**
       * List all namespaces
       */
      listNamespaces() {
        return Array.from(this.data.keys());
      }
      /**
       * Get all data in a namespace
       */
      getAll(namespace) {
        const ns = namespace || this.getDefaultNamespace();
        const nsData = this.data.get(ns);
        if (!nsData) {
          return {};
        }
        const result = {};
        for (const [key, value] of nsData.entries()) {
          result[key] = value;
        }
        return result;
      }
      /**
       * Load data from file
       */
      async load() {
        if (!this.config.file) {
          throw new Error("No file path configured for memory store");
        }
        const filePath = path.resolve(process.cwd(), this.config.file);
        const content = await fs.readFile(filePath, "utf-8");
        if (this.config.format === "json") {
          await this.loadFromJson(content);
        } else if (this.config.format === "csv") {
          await this.loadFromCsv(content);
        } else {
          throw new Error(`Unsupported format: ${this.config.format}`);
        }
      }
      /**
       * Save data to file
       */
      async save() {
        if (!this.config.file) {
          throw new Error("No file path configured for memory store");
        }
        const filePath = path.resolve(process.cwd(), this.config.file);
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        let content;
        if (this.config.format === "json") {
          content = this.saveToJson();
        } else if (this.config.format === "csv") {
          content = this.saveToCsv();
        } else {
          throw new Error(`Unsupported format: ${this.config.format}`);
        }
        await fs.writeFile(filePath, content, "utf-8");
      }
      /**
       * Load data from JSON format
       */
      async loadFromJson(content) {
        const data = JSON.parse(content);
        this.data.clear();
        for (const [namespace, nsData] of Object.entries(data)) {
          if (typeof nsData === "object" && nsData !== null && !Array.isArray(nsData)) {
            const nsMap = /* @__PURE__ */ new Map();
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
      saveToJson() {
        const result = {};
        for (const [namespace, nsData] of this.data.entries()) {
          const nsObj = {};
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
      async loadFromCsv(content) {
        const lines = content.split("\n").filter((line) => line.trim());
        let startIndex = 0;
        if (lines[0]?.startsWith("namespace,")) {
          startIndex = 1;
        }
        this.data.clear();
        const arrays = /* @__PURE__ */ new Map();
        for (let i = startIndex; i < lines.length; i++) {
          const line = lines[i];
          const parts = this.parseCsvLine(line);
          if (parts.length < 3) {
            logger.warn(`Invalid CSV line ${i + 1}: ${line}`);
            continue;
          }
          const [namespace, key, valueStr, typeStr] = parts;
          const value = this.parseCsvValue(valueStr, typeStr);
          if (!this.data.has(namespace)) {
            this.data.set(namespace, /* @__PURE__ */ new Map());
            arrays.set(namespace, /* @__PURE__ */ new Map());
          }
          const nsData = this.data.get(namespace);
          const nsArrays = arrays.get(namespace);
          if (nsData.has(key)) {
            if (!nsArrays.has(key)) {
              const existingValue = nsData.get(key);
              nsArrays.set(key, [existingValue]);
            }
            nsArrays.get(key).push(value);
            nsData.set(key, nsArrays.get(key));
          } else {
            nsData.set(key, value);
          }
        }
      }
      /**
       * Save data to CSV format
       */
      saveToCsv() {
        const lines = ["namespace,key,value,type"];
        for (const [namespace, nsData] of this.data.entries()) {
          for (const [key, value] of nsData.entries()) {
            if (Array.isArray(value)) {
              for (const item of value) {
                lines.push(this.formatCsvLine(namespace, key, item));
              }
            } else {
              lines.push(this.formatCsvLine(namespace, key, value));
            }
          }
        }
        return lines.join("\n") + "\n";
      }
      /**
       * Parse a CSV line, handling quoted values with commas
       */
      parseCsvLine(line) {
        const parts = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
              current += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (char === "," && !inQuotes) {
            parts.push(current);
            current = "";
          } else {
            current += char;
          }
        }
        parts.push(current);
        return parts;
      }
      /**
       * Format a CSV line with proper escaping
       */
      formatCsvLine(namespace, key, value) {
        const type = this.getValueType(value);
        const valueStr = this.formatCsvValue(value);
        return `${this.escapeCsv(namespace)},${this.escapeCsv(key)},${valueStr},${type}`;
      }
      /**
       * Escape a CSV value
       */
      escapeCsv(value) {
        if (value.includes(",") || value.includes('"') || value.includes("\n")) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }
      /**
       * Format a value for CSV storage
       */
      formatCsvValue(value) {
        if (value === null) {
          return '""';
        }
        if (value === void 0) {
          return '""';
        }
        if (typeof value === "string") {
          return this.escapeCsv(value);
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return this.escapeCsv(String(value));
        }
        return this.escapeCsv(JSON.stringify(value));
      }
      /**
       * Parse a CSV value based on its type
       */
      parseCsvValue(valueStr, typeStr) {
        if (!typeStr || typeStr === "string") {
          return valueStr;
        }
        if (typeStr === "number") {
          return Number(valueStr);
        }
        if (typeStr === "boolean") {
          return valueStr === "true";
        }
        if (typeStr === "object" || typeStr === "array") {
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
      getValueType(value) {
        if (value === null || value === void 0) {
          return "string";
        }
        if (typeof value === "number") {
          return "number";
        }
        if (typeof value === "boolean") {
          return "boolean";
        }
        if (Array.isArray(value)) {
          return "array";
        }
        if (typeof value === "object") {
          return "object";
        }
        return "string";
      }
      /**
       * Get the current configuration
       */
      getConfig() {
        return { ...this.config };
      }
    };
  }
});

export {
  MemoryStore,
  memory_store_exports,
  init_memory_store
};
//# sourceMappingURL=chunk-IHZOSIF4.mjs.map