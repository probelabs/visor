/**
 * Environment variable resolution utilities
 * Supports GitHub Actions-like syntax for referencing environment variables
 */

import { EnvConfig } from '../types/config';

/**
 * Resolves environment variables in configuration values
 * Supports the following syntaxes:
 * - ${{ env.VARIABLE_NAME }} (GitHub Actions style)
 * - ${VARIABLE_NAME} (shell style)
 * - $VARIABLE_NAME (simple shell style)
 * - Direct environment variable names
 */
export class EnvironmentResolver {
  /**
   * Resolves a single configuration value that may contain environment variable references
   */
  static resolveValue(value: string | number | boolean): string | number | boolean {
    if (typeof value !== 'string') {
      return value;
    }

    // GitHub Actions style: ${{ env.VARIABLE_NAME }}
    let resolved = value.replace(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, envVar) => {
      return process.env[envVar] || match;
    });

    // Shell style: ${VARIABLE_NAME}
    resolved = resolved.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, envVar) => {
      return process.env[envVar] || match;
    });

    // Simple shell style: $VARIABLE_NAME
    resolved = resolved.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, envVar) => {
      return process.env[envVar] || match;
    });

    return resolved;
  }

  /**
   * Resolves all environment variables in an EnvConfig object
   */
  static resolveEnvConfig(envConfig: EnvConfig): EnvConfig {
    const resolved: EnvConfig = {};

    for (const [key, value] of Object.entries(envConfig)) {
      resolved[key] = this.resolveValue(value);
    }

    return resolved;
  }

  /**
   * Applies environment configuration to the process environment
   * This allows checks to access their specific environment variables
   */
  static applyEnvConfig(envConfig: EnvConfig): void {
    const resolved = this.resolveEnvConfig(envConfig);

    for (const [key, value] of Object.entries(resolved)) {
      if (value !== undefined) {
        process.env[key] = String(value);
      }
    }
  }

  /**
   * Creates a temporary environment for a specific check execution
   * Returns a cleanup function to restore the original environment
   */
  static withTemporaryEnv<T>(envConfig: EnvConfig, callback: () => T | Promise<T>): T | Promise<T> {
    const resolved = this.resolveEnvConfig(envConfig);
    const originalValues: Record<string, string | undefined> = {};

    // Store original values and apply new ones
    for (const [key, value] of Object.entries(resolved)) {
      originalValues[key] = process.env[key];
      if (value !== undefined) {
        process.env[key] = String(value);
      }
    }

    try {
      const result = callback();

      // If callback returns a promise, handle cleanup after it resolves
      if (result instanceof Promise) {
        return result.finally(() => {
          // Restore original values
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
        });
      }

      // Restore original values immediately for sync callbacks
      for (const [key, originalValue] of Object.entries(originalValues)) {
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }

      return result;
    } catch (error) {
      // Restore original values on error
      for (const [key, originalValue] of Object.entries(originalValues)) {
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
      throw error;
    }
  }

  /**
   * Validates that all required environment variables are available
   */
  static validateRequiredEnvVars(envConfig: EnvConfig, requiredVars: string[]): string[] {
    const resolved = this.resolveEnvConfig(envConfig);
    const missing: string[] = [];

    for (const varName of requiredVars) {
      const value = resolved[varName] || process.env[varName];
      if (!value) {
        missing.push(varName);
      }
    }

    return missing;
  }
}
