import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { VisorConfig } from '../../src/types/config';
import { CheckProvider } from '../../src/providers/check-provider.interface';
import { ReviewSummary } from '../../src/reviewer';

describe('forEach with transform_js integration', () => {
  let registry: CheckProviderRegistry;

  beforeEach(() => {
    registry = CheckProviderRegistry.getInstance();
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Clean up registry after each test
    (registry as any).providers.clear();
    (registry as any).instance = null;
  });

  it('should properly propagate forEach items to dependent checks when using transform_js', async () => {
    // Track what the dependent check receives
    const capturedOutputs: any[] = [];

    // Create a mock provider for the forEach check that returns an array
    const forEachProvider: CheckProvider = {
      getName: () => 'forEach-provider',
      getDescription: () => 'Mock forEach provider',
      getSupportedConfigKeys: () => ['type', 'transform_js', 'forEach'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async () => {
        // Return an array that will be processed by forEach
        return {
          issues: [],
          output: [
            { id: 1, name: 'item1' },
            { id: 2, name: 'item2' },
          ],
        } as ReviewSummary;
      }),
    };

    // Create a mock provider to capture dependency results
    const dependentProvider: CheckProvider = {
      getName: () => 'dependent-provider',
      getDescription: () => 'Mock dependent provider',
      getSupportedConfigKeys: () => ['type', 'depends_on'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async (prInfo, config, dependencyResults) => {
        // Capture what this check receives from dependencies
        if (dependencyResults && dependencyResults.has('fetch-items')) {
          const result = dependencyResults.get('fetch-items');
          // The forEach logic should provide individual items wrapped in output field
          const output = (result as any).output;
          capturedOutputs.push(output);
        }
        return { issues: [] } as ReviewSummary;
      }),
    };

    // Register the providers
    (registry as any).providers.set('forEach-provider', forEachProvider);
    (registry as any).providers.set('dependent-provider', dependentProvider);

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-items': {
          type: 'forEach-provider' as any,
          transform_js: 'output', // Just return the output as-is
          forEach: true,
        },
        'process-items': {
          type: 'dependent-provider' as any,
          depends_on: ['fetch-items'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    const engine = new CheckExecutionEngine();

    // Execute the checks
    await engine.executeChecks({
      checks: ['fetch-items', 'process-items'],
      config,
    });

    // Verify the dependent check was called twice (once for each forEach item)
    expect(dependentProvider.execute).toHaveBeenCalledTimes(2);

    // Verify each call received the individual item
    expect(capturedOutputs).toHaveLength(2);
    expect(capturedOutputs[0]).toEqual({ id: 1, name: 'item1' });
    expect(capturedOutputs[1]).toEqual({ id: 2, name: 'item2' });
  });

  it('should provide raw array access via <checkName>-raw key', async () => {
    // Track what the dependent check receives
    const capturedOutputs: any[] = [];
    const capturedRawArrays: any[] = [];

    // Create a mock provider for the forEach check
    const forEachProvider: CheckProvider = {
      getName: () => 'forEach-provider',
      getDescription: () => 'Mock forEach provider',
      getSupportedConfigKeys: () => ['type', 'forEach'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async () => {
        return {
          issues: [],
          output: [
            { id: 1, value: 10 },
            { id: 2, value: 20 },
            { id: 3, value: 30 },
          ],
        } as ReviewSummary;
      }),
    };

    // Create a mock provider to capture dependency results
    const dependentProvider: CheckProvider = {
      getName: () => 'dependent-provider',
      getDescription: () => 'Mock dependent provider',
      getSupportedConfigKeys: () => ['type', 'depends_on'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async (prInfo, config, dependencyResults) => {
        if (dependencyResults) {
          // Check for individual item
          if (dependencyResults.has('fetch-data')) {
            const result = dependencyResults.get('fetch-data');
            capturedOutputs.push((result as any).output);
          }
          // Check for raw array access
          if (dependencyResults.has('fetch-data-raw')) {
            const rawResult = dependencyResults.get('fetch-data-raw');
            capturedRawArrays.push((rawResult as any).output);
          }
        }
        return { issues: [] } as ReviewSummary;
      }),
    };

    // Register the providers
    (registry as any).providers.set('forEach-provider', forEachProvider);
    (registry as any).providers.set('dependent-provider', dependentProvider);

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-data': {
          type: 'forEach-provider' as any,
          forEach: true,
        },
        'process-data': {
          type: 'dependent-provider' as any,
          depends_on: ['fetch-data'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    const engine = new CheckExecutionEngine();

    await engine.executeChecks({
      checks: ['fetch-data', 'process-data'],
      config,
    });

    // Verify the dependent check was called 3 times (once for each item)
    expect(dependentProvider.execute).toHaveBeenCalledTimes(3);

    // Verify individual items were received
    expect(capturedOutputs).toHaveLength(3);
    expect(capturedOutputs[0]).toEqual({ id: 1, value: 10 });
    expect(capturedOutputs[1]).toEqual({ id: 2, value: 20 });
    expect(capturedOutputs[2]).toEqual({ id: 3, value: 30 });

    // Verify raw array was accessible in each iteration
    expect(capturedRawArrays).toHaveLength(3);
    const expectedRawArray = [
      { id: 1, value: 10 },
      { id: 2, value: 20 },
      { id: 3, value: 30 },
    ];
    expect(capturedRawArrays[0]).toEqual(expectedRawArray);
    expect(capturedRawArrays[1]).toEqual(expectedRawArray);
    expect(capturedRawArrays[2]).toEqual(expectedRawArray);
  });

  it('should handle empty arrays from forEach checks', async () => {
    const forEachProvider: CheckProvider = {
      getName: () => 'forEach-provider',
      getDescription: () => 'Mock forEach provider',
      getSupportedConfigKeys: () => ['type', 'forEach'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async () => {
        return {
          issues: [],
          output: [], // Empty array
        } as ReviewSummary;
      }),
    };

    const dependentProvider: CheckProvider = {
      getName: () => 'dependent-provider',
      getDescription: () => 'Mock dependent provider',
      getSupportedConfigKeys: () => ['type', 'depends_on'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async () => {
        return { issues: [] } as ReviewSummary;
      }),
    };

    (registry as any).providers.set('forEach-provider', forEachProvider);
    (registry as any).providers.set('dependent-provider', dependentProvider);

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-empty': {
          type: 'forEach-provider' as any,
          forEach: true,
        },
        'process-empty': {
          type: 'dependent-provider' as any,
          depends_on: ['fetch-empty'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    const engine = new CheckExecutionEngine();

    await engine.executeChecks({
      checks: ['fetch-empty', 'process-empty'],
      config,
    });

    // Dependent check should not be executed for empty array
    expect(dependentProvider.execute).toHaveBeenCalledTimes(0);
  });

  it('should wrap non-array outputs in array when forEach is enabled', async () => {
    const capturedOutputs: any[] = [];

    const forEachProvider: CheckProvider = {
      getName: () => 'forEach-provider',
      getDescription: () => 'Mock forEach provider',
      getSupportedConfigKeys: () => ['type', 'forEach'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async () => {
        return {
          issues: [],
          output: { id: 42, name: 'single-item' }, // Single object, not array
        } as ReviewSummary;
      }),
    };

    const dependentProvider: CheckProvider = {
      getName: () => 'dependent-provider',
      getDescription: () => 'Mock dependent provider',
      getSupportedConfigKeys: () => ['type', 'depends_on'],
      validateConfig: async () => true,
      isAvailable: async () => true,
      getRequirements: () => [],
      execute: jest.fn(async (prInfo, config, dependencyResults) => {
        if (dependencyResults && dependencyResults.has('fetch-single')) {
          const result = dependencyResults.get('fetch-single');
          capturedOutputs.push((result as any).output);
        }
        return { issues: [] } as ReviewSummary;
      }),
    };

    (registry as any).providers.set('forEach-provider', forEachProvider);
    (registry as any).providers.set('dependent-provider', dependentProvider);

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-single': {
          type: 'forEach-provider' as any,
          forEach: true,
        },
        'process-single': {
          type: 'dependent-provider' as any,
          depends_on: ['fetch-single'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    const engine = new CheckExecutionEngine();

    await engine.executeChecks({
      checks: ['fetch-single', 'process-single'],
      config,
    });

    // Should be called once for the single item
    expect(dependentProvider.execute).toHaveBeenCalledTimes(1);
    expect(capturedOutputs).toHaveLength(1);
    expect(capturedOutputs[0]).toEqual({ id: 42, name: 'single-item' });
  });
});
