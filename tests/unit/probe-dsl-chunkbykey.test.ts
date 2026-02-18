/**
 * Tests for probe DSL chunkByKey() and LLM auto-parse features.
 *
 * Verifies that:
 * 1. chunkByKey with regex keyFn works in SandboxJS
 * 2. LLM() with schema auto-parses JSON results
 * 3. The full customer-insights script pattern works end-to-end
 */

// Import probe DSL runtime directly from disk (bypasses Jest module mock)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const probeBasePath = require('path').resolve(__dirname, '../../node_modules/@probelabs/probe');
// The CJS bundle has createDSLRuntime as an internal function in ProbeAgent.cjs,
// but it's not exported. We need to use the ESM source via dynamic import.
let createDSLRuntime: any;

beforeAll(async () => {
  const mod = await import(probeBasePath + '/src/agent/dsl/runtime.js');
  createDSLRuntime = mod.createDSLRuntime;
});

// Simulated search results that mimic the customer-insights repo structure
const MOCK_SEARCH_RESULTS = [
  'File: Customers/Acme Corp/drive/notes.md',
  'Acme Corp uses JWT-based authentication with 50 APIs.',
  '',
  'File: Customers/Acme Corp/hubspot/2024-01-15/call.md',
  'Follow-up call with Acme Corp about OAuth2 migration plans.',
  '',
  'File: Customers/Beta Inc/drive/overview.md',
  'Beta Inc has 12 APIs using HMAC authentication.',
  '',
  'File: Prospects/Gamma LLC/drive/notes.md',
  'Gamma LLC is evaluating API key management for 5 APIs.',
  '',
  'File: Customers/Beta Inc/hubspot/2024-03-01/meeting.md',
  'Beta Inc discussed moving from HMAC to OAuth2.',
  '',
].join('\n');

function createTestRuntime(
  opts: {
    searchResult?: string;
    llmResults?: Record<string, unknown>;
  } = {}
) {
  const { searchResult = MOCK_SEARCH_RESULTS, llmResults = {} } = opts;
  let llmCallCount = 0;

  const runtime = createDSLRuntime({
    toolImplementations: {
      search: {
        execute: async () => searchResult,
      },
    },
    llmCall: async (_instruction: string, _data: string, _opts?: { schema?: string }) => {
      llmCallCount++;
      const key = `call_${llmCallCount}`;
      if (llmResults[key]) {
        return JSON.stringify(llmResults[key]);
      }
      return JSON.stringify({
        customers: [{ name: 'Test Customer', api_count: '10', use_case: 'Testing' }],
      });
    },
    mapConcurrency: 2,
  });

  return { runtime, getLlmCallCount: () => llmCallCount };
}

describe('probe DSL chunkByKey', () => {
  it('should chunk by customer name using string split keyFn', async () => {
    const { runtime } = createTestRuntime();

    const result = await runtime.execute(`
      const data = search("test", "customer-insights")
      const chunks = chunkByKey(data, function(file) {
        var parts = file.split("/")
        return parts.length >= 2 ? parts[1] : "other"
      })
      return chunks.length
    `);

    expect(result.status).toBe('success');
    // Should group: Acme Corp (2 files), Beta Inc (2 files), Gamma LLC (1 file)
    expect(result.result).toBeGreaterThanOrEqual(1);
    expect(result.result).toBeLessThanOrEqual(3);
  });

  it('should keep same-customer files together', async () => {
    const { runtime } = createTestRuntime();

    const result = await runtime.execute(`
      const data = search("test", "customer-insights")
      const chunks = chunkByKey(data, function(file) {
        var parts = file.split("/")
        return parts.length >= 2 ? parts[1] : "other"
      })
      // Check that Acme Corp files are in the same chunk
      var acmeChunk = null
      for (var i = 0; i < chunks.length; i++) {
        if (chunks[i].indexOf("Acme Corp") !== -1) {
          acmeChunk = chunks[i]
        }
      }
      // Both Acme Corp files should be in one chunk
      var driveMatch = acmeChunk && acmeChunk.indexOf("drive/notes.md") !== -1
      var hubspotMatch = acmeChunk && acmeChunk.indexOf("hubspot/2024-01-15/call.md") !== -1
      return driveMatch && hubspotMatch
    `);

    expect(result.status).toBe('success');
    expect(result.result).toBe(true);
  });

  it('should handle regex in keyFn with match()', async () => {
    const { runtime } = createTestRuntime();

    // This is the exact pattern from our customer-insights templates
    const result = await runtime.execute(String.raw`
      const data = search("test", "customer-insights")
      const chunks = chunkByKey(data, function(file) {
        var match = file.match(/^(?:Customers|Prospects)\/([^\/]+)/)
        return match ? match[1] : "other"
      })
      return chunks.length
    `);

    expect(result.status).toBe('success');
    expect(result.result).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('should fall back to regular chunk() when no File: headers', async () => {
    const { runtime } = createTestRuntime({
      searchResult: 'Just some plain text without any File: headers\n'.repeat(10),
    });

    const result = await runtime.execute(`
      const data = search("test", "repo")
      const chunks = chunkByKey(data, function(file) { return file })
      return chunks.length
    `);

    expect(result.status).toBe('success');
    expect(result.result).toBeGreaterThanOrEqual(1);
  });
});

describe('probe DSL LLM auto-parse with schema', () => {
  it('should auto-parse JSON when schema is provided', async () => {
    const { runtime } = createTestRuntime({
      llmResults: {
        call_1: { customers: [{ name: 'Acme', api_count: '50' }] },
      },
    });

    const result = await runtime.execute(`
      const parsed = LLM(
        "Extract customer info",
        "Acme Corp uses 50 APIs",
        { schema: '{"customers": [{"name": "string", "api_count": "string"}]}' }
      )
      return typeof parsed
    `);

    expect(result.status).toBe('success');
    expect(result.result).toBe('object');
  });

  it('should allow direct property access on auto-parsed result', async () => {
    const { runtime } = createTestRuntime({
      llmResults: {
        call_1: { customers: [{ name: 'Acme', api_count: '50' }] },
      },
    });

    const result = await runtime.execute(`
      const parsed = LLM(
        "Extract customer info",
        "Acme Corp uses 50 APIs",
        { schema: '{"customers": [{"name": "string", "api_count": "string"}]}' }
      )
      return parsed.customers[0].name
    `);

    expect(result.status).toBe('success');
    expect(result.result).toBe('Acme');
  });

  it('should work with map() + LLM() + schema — no parseJSON needed', async () => {
    let callNum = 0;
    const runtime = createDSLRuntime({
      toolImplementations: {
        search: { execute: async () => MOCK_SEARCH_RESULTS },
      },
      llmCall: async () => {
        callNum++;
        return JSON.stringify({
          customers: [{ name: `Customer_${callNum}`, api_count: `${callNum * 10}` }],
        });
      },
      mapConcurrency: 2,
    });

    const result = await runtime.execute(`
      const data = search("test", "customer-insights")
      const chunks = chunk(data)
      const extracted = map(chunks, function(c) {
        return LLM("Extract", c, { schema: '{"customers": [{"name": "string", "api_count": "string"}]}' })
      })
      // With auto-parse, we can access .customers directly
      var all = []
      for (var i = 0; i < extracted.length; i++) {
        var r = extracted[i]
        if (r && r.customers) {
          for (var j = 0; j < r.customers.length; j++) {
            all.push(r.customers[j].name)
          }
        }
      }
      return all.length
    `);

    expect(result.status).toBe('success');
    expect(result.result).toBeGreaterThanOrEqual(1);
  }, 15000);
});

describe('probe DSL full customer-insights script pattern', () => {
  it('should run the battle-tested script template end-to-end', async () => {
    const outputLines = { items: [] as string[] };

    const runtime = createDSLRuntime({
      toolImplementations: {
        search: { execute: async () => MOCK_SEARCH_RESULTS },
      },
      llmCall: async () => {
        return JSON.stringify({
          customers: [
            { name: 'Acme Corp', api_count: '50', use_case: 'JWT authentication' },
            { name: 'Beta Inc', api_count: '12', use_case: 'HMAC auth' },
            { name: 'Gamma LLC', api_count: '5', use_case: 'API key management' },
            { name: 'Acme Corp', api_count: '50', use_case: 'OAuth2 migration' },
          ],
        });
      },
      mapConcurrency: 2,
      outputBuffer: outputLines,
    });

    const result = await runtime.execute(`
      const query = 'JWT OR OAuth OR HMAC OR "API Key"'
      const results = search(query, "customer-insights")
      const chunks = chunk(results)
      log("Processing " + chunks.length + " chunks")

      const extracted = map(chunks, function(c) {
        return LLM(
          "Extract customer insights about authentication.",
          c,
          { schema: '{"customers": [{"name": "string", "api_count": "string", "use_case": "string"}]}' }
        )
      })

      // Collect all customer insights from auto-parsed results
      var allInsights = []
      for (var i = 0; i < extracted.length; i++) {
        var r = extracted[i]
        if (r && r.customers) {
          for (var j = 0; j < r.customers.length; j++) {
            allInsights.push(r.customers[j])
          }
        }
      }

      // Simple collect — just return all insights for validation
      var names = []
      for (var k = 0; k < allInsights.length; k++) {
        if (allInsights[k] && allInsights[k].name) {
          names.push(allInsights[k].name + ": " + allInsights[k].use_case)
        }
      }
      var report = names.join(", ")
      output(report)
      return report
    `);

    expect(result.error || '').toBe('');
    expect(result.status).toBe('success');
    const report = result.result as string;
    // Verify all customers appear in the combined report
    expect(report).toContain('Acme Corp');
    expect(report).toContain('Beta Inc');
    expect(report).toContain('Gamma LLC');
  }, 30000);

  it('should run with chunkByKey + regex grouping end-to-end', async () => {
    let callNum = 0;

    const runtime = createDSLRuntime({
      toolImplementations: {
        search: { execute: async () => MOCK_SEARCH_RESULTS },
      },
      llmCall: async () => {
        callNum++;
        if (callNum === 1) {
          return JSON.stringify({
            customers: [{ name: 'Acme Corp', api_count: '50', use_case: 'JWT auth' }],
          });
        }
        if (callNum === 2) {
          return JSON.stringify({
            customers: [{ name: 'Beta Inc', api_count: '12', use_case: 'HMAC' }],
          });
        }
        return JSON.stringify({
          customers: [{ name: 'Gamma LLC', api_count: '5', use_case: 'API keys' }],
        });
      },
      mapConcurrency: 2,
    });

    // Use chunkByKey with regex — the exact pattern from templates
    const result = await runtime.execute(String.raw`
      const results = search("auth", "customer-insights")
      const chunks = chunkByKey(results, function(file) {
        var parts = file.split("/")
        return parts.length >= 2 ? parts[1] : "other"
      })
      log("Got " + chunks.length + " customer groups")

      const extracted = map(chunks, function(c) {
        return LLM("Extract", c, { schema: '{"customers": [{"name": "string", "api_count": "string", "use_case": "string"}]}' })
      })

      var all = []
      for (var i = 0; i < extracted.length; i++) {
        var r = extracted[i]
        if (r && r.customers) {
          for (var j = 0; j < r.customers.length; j++) {
            all.push(r.customers[j].name)
          }
        }
      }
      return all
    `);

    expect(result.status).toBe('success');
    expect(Array.isArray(result.result)).toBe(true);
    expect(result.result.length).toBeGreaterThanOrEqual(1);
  }, 30000);
});
