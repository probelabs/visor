import {
  transformScriptForAsync,
  buildBuiltinGlobals,
  buildToolGlobals,
  type BuildToolGlobalsOptions,
  type BuildBuiltinGlobalsOptions,
} from '../../../src/utils/script-tool-environment';

jest.mock('../../../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// ─── transformScriptForAsync ───────────────────────────────────────────────

describe('transformScriptForAsync', () => {
  describe('wrapping', () => {
    it('wraps in sync IIFE when no async functions', () => {
      const result = transformScriptForAsync('return 42;', new Set());
      expect(result).toContain('return (() => {');
      expect(result).toContain('return 42;');
      expect(result).not.toContain('async');
    });

    it('wraps in async IIFE when async functions exist', () => {
      const result = transformScriptForAsync('const x = myTool();', new Set(['myTool']));
      expect(result).toContain('return (async () => {');
      expect(result).toContain('})()');
    });
  });

  describe('await injection', () => {
    it('inserts await before async function calls', () => {
      const result = transformScriptForAsync(
        'const x = myTool({ key: 1 });',
        new Set(['myTool'])
      );
      expect(result).toContain('await myTool(');
    });

    it('does not insert await before non-async functions', () => {
      const result = transformScriptForAsync(
        'const x = normalFn(); const y = asyncFn();',
        new Set(['asyncFn'])
      );
      expect(result).toContain('await asyncFn(');
      expect(result).not.toContain('await normalFn(');
    });

    it('handles multiple async calls', () => {
      const code = 'const a = toolA(); const b = toolB();';
      const result = transformScriptForAsync(code, new Set(['toolA', 'toolB']));
      expect(result).toContain('await toolA(');
      expect(result).toContain('await toolB(');
    });
  });

  describe('auto-return of last expression', () => {
    it('auto-returns last expression statement (simple object)', () => {
      const result = transformScriptForAsync('({ ok: true })', new Set(['schedule']));
      expect(result).toContain('return ({ ok: true })');
    });

    it('auto-returns IIFE call result', () => {
      const code = '(() => { return { val: 42 }; })()';
      const result = transformScriptForAsync(code, new Set(['schedule']));
      expect(result).toContain('return (() =>');
    });

    it('auto-returns function call result', () => {
      const code = 'const x = 1;\nmyTool({ a: x })';
      const result = transformScriptForAsync(code, new Set(['myTool']));
      // The last expression (myTool call) gets both 'return' and 'await'
      expect(result).toContain('return await myTool(');
    });

    it('does not double-return when code already has return', () => {
      const code = 'const x = myTool();\nreturn x;';
      const result = transformScriptForAsync(code, new Set(['myTool']));
      // Last statement is ReturnStatement, not ExpressionStatement
      // Should not get double return
      const returnCount = (result.match(/\breturn\b/g) || []).length;
      // One from the user code 'return x', one from the outer 'return (async ...'
      expect(returnCount).toBe(2);
    });
  });

  describe('nested function marking', () => {
    it('marks enclosing arrow function as async', () => {
      const code = 'const fn = () => { return myTool(); };';
      const result = transformScriptForAsync(code, new Set(['myTool']));
      expect(result).toContain('async () =>');
    });
  });

  describe('loop guard injection', () => {
    it('injects __checkLoop in while loops', () => {
      const code = 'while (true) { break; }';
      const result = transformScriptForAsync(code, new Set(['schedule']));
      expect(result).toContain('__checkLoop()');
    });

    it('injects __checkLoop in for loops', () => {
      const code = 'for (let i = 0; i < 10; i++) { i; }';
      const result = transformScriptForAsync(code, new Set(['schedule']));
      expect(result).toContain('__checkLoop()');
    });
  });

  describe('syntax errors', () => {
    it('throws a formatted syntax error with line/column info', () => {
      expect(() => {
        transformScriptForAsync('const x = @invalid;', new Set(['schedule']));
      }).toThrow(/Syntax error at line 1/);
    });

    it('includes code snippet with pointer', () => {
      try {
        transformScriptForAsync('const x = 1;\nconst y = @bad;', new Set(['schedule']));
        fail('Expected to throw');
      } catch (e: any) {
        expect(e.message).toContain('>');
        expect(e.message).toContain('^');
        expect(e.message).toContain('line 2');
      }
    });
  });

  describe('linting', () => {
    const knownGlobals = new Set(['schedule', 'myTool', 'log', '__checkLoop']);

    it('throws on unknown function calls', () => {
      expect(() => {
        transformScriptForAsync('unknownFn();', new Set(['schedule']), { knownGlobals });
      }).toThrow(/Unknown function 'unknownFn\(\)'/);
    });

    it('suggests similar names (did you mean?)', () => {
      expect(() => {
        transformScriptForAsync('schedul();', new Set(['schedule']), { knownGlobals });
      }).toThrow(/Did you mean 'schedule'/);
    });

    it('reports gated builtins with enable instructions', () => {
      const disabledBuiltins = new Map([['bash', "Add 'enable_bash: true'"]]);
      expect(() => {
        transformScriptForAsync('bash({ command: "ls" });', new Set(['schedule']), {
          knownGlobals,
          disabledBuiltins,
        });
      }).toThrow(/is not enabled.*enable_bash/);
    });

    it('does not warn on known globals', () => {
      expect(() => {
        transformScriptForAsync('schedule(); myTool();', new Set(['schedule', 'myTool']), {
          knownGlobals,
        });
      }).not.toThrow();
    });

    it('does not warn on JS builtins', () => {
      expect(() => {
        transformScriptForAsync(
          'parseInt("10"); JSON.parse("{}"); Array.isArray([]);',
          new Set(['schedule']),
          { knownGlobals }
        );
      }).not.toThrow();
    });

    it('does not warn on user-declared functions', () => {
      expect(() => {
        transformScriptForAsync(
          'function helper() { return 1; }\nhelper();',
          new Set(['schedule']),
          { knownGlobals }
        );
      }).not.toThrow();
    });

    it('does not warn on user-declared arrow functions', () => {
      expect(() => {
        transformScriptForAsync(
          'const helper = () => 1;\nhelper();',
          new Set(['schedule']),
          { knownGlobals }
        );
      }).not.toThrow();
    });

    it('does not warn on method calls (obj.method())', () => {
      expect(() => {
        transformScriptForAsync('const arr = [1,2,3]; arr.filter(x => x > 1);', new Set(['schedule']), {
          knownGlobals,
        });
      }).not.toThrow();
    });
  });
});

// ─── buildBuiltinGlobals ──────────────────────────────────────────────────

describe('buildBuiltinGlobals', () => {
  const baseOpts: BuildBuiltinGlobalsOptions = {
    config: {},
    prInfo: { number: 1 },
  };

  it('always includes schedule()', () => {
    const { globals, asyncFunctionNames } = buildBuiltinGlobals(baseOpts);
    expect(globals.schedule).toBeDefined();
    expect(typeof globals.schedule).toBe('function');
    expect(asyncFunctionNames.has('schedule')).toBe(true);
  });

  it('does not include fetch() by default', () => {
    const { globals, asyncFunctionNames } = buildBuiltinGlobals(baseOpts);
    expect(globals.fetch).toBeUndefined();
    expect(asyncFunctionNames.has('fetch')).toBe(false);
  });

  it('includes fetch() when enable_fetch is true', () => {
    const { globals, asyncFunctionNames } = buildBuiltinGlobals({
      ...baseOpts,
      config: { enable_fetch: true },
    });
    expect(globals.fetch).toBeDefined();
    expect(typeof globals.fetch).toBe('function');
    expect(asyncFunctionNames.has('fetch')).toBe(true);
  });

  it('does not include bash() by default', () => {
    const { globals, asyncFunctionNames } = buildBuiltinGlobals(baseOpts);
    expect(globals.bash).toBeUndefined();
    expect(asyncFunctionNames.has('bash')).toBe(false);
  });

  it('includes bash() when enable_bash is true', () => {
    const { globals, asyncFunctionNames } = buildBuiltinGlobals({
      ...baseOpts,
      config: { enable_bash: true },
    });
    expect(globals.bash).toBeDefined();
    expect(typeof globals.bash).toBe('function');
    expect(asyncFunctionNames.has('bash')).toBe(true);
  });

  it('does not include github() without octokit', () => {
    const { globals, asyncFunctionNames } = buildBuiltinGlobals(baseOpts);
    expect(globals.github).toBeUndefined();
    expect(asyncFunctionNames.has('github')).toBe(false);
  });

  it('includes github() when octokit is in eventContext', () => {
    const mockOctokit = { rest: { issues: {} } };
    const { globals, asyncFunctionNames } = buildBuiltinGlobals({
      ...baseOpts,
      config: { eventContext: { octokit: mockOctokit } },
    });
    expect(globals.github).toBeDefined();
    expect(typeof globals.github).toBe('function');
    expect(asyncFunctionNames.has('github')).toBe(true);
  });

  it('bash() returns error when command is empty', async () => {
    const { globals } = buildBuiltinGlobals({
      ...baseOpts,
      config: { enable_bash: true },
    });
    const result = await (globals.bash as Function)({});
    expect(result).toBe('ERROR: command is required');
  });

  it('fetch() returns error when url is empty', async () => {
    const { globals } = buildBuiltinGlobals({
      ...baseOpts,
      config: { enable_fetch: true },
    });
    const result = await (globals.fetch as Function)({});
    expect(result).toBe('ERROR: url is required');
  });

  it('github() returns error when repo context is missing', async () => {
    const mockOctokit = { rest: { issues: {} } };
    const { globals } = buildBuiltinGlobals({
      config: { eventContext: { octokit: mockOctokit } },
      prInfo: { number: 1 },
    });
    // No GITHUB_REPOSITORY env and no repository in eventContext
    const oldEnv = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    const result = await (globals.github as Function)({ op: 'labels.add', values: ['test'] });
    expect(result).toContain('ERROR');
    if (oldEnv) process.env.GITHUB_REPOSITORY = oldEnv;
  });

  it('github() returns error for unknown op', async () => {
    const mockOctokit = {
      rest: { issues: { addLabels: jest.fn(), removeLabel: jest.fn(), createComment: jest.fn() } },
    };
    const oldEnv = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    const { globals } = buildBuiltinGlobals({
      config: { eventContext: { octokit: mockOctokit } },
      prInfo: { number: 42 },
    });
    const result = await (globals.github as Function)({ op: 'unknown.op' });
    expect(result).toContain("Unknown github op 'unknown.op'");
    if (oldEnv) process.env.GITHUB_REPOSITORY = oldEnv;
    else delete process.env.GITHUB_REPOSITORY;
  });
});

// ─── buildToolGlobals ─────────────────────────────────────────────────────

describe('buildToolGlobals', () => {
  it('creates callable functions for resolved tools', () => {
    const resolvedTools = new Map<string, any>([
      ['my-tool', { name: 'my-tool', description: 'A test tool', exec: 'echo hello' }],
    ]);

    const { globals, asyncFunctionNames } = buildToolGlobals({
      resolvedTools,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    expect(globals['my-tool']).toBeDefined();
    expect(typeof globals['my-tool']).toBe('function');
    expect(asyncFunctionNames.has('my-tool')).toBe(true);
  });

  it('provides callTool dispatcher', () => {
    const resolvedTools = new Map<string, any>([
      ['tool-a', { name: 'tool-a', exec: 'echo a' }],
    ]);

    const { globals, asyncFunctionNames } = buildToolGlobals({
      resolvedTools,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    expect(globals.callTool).toBeDefined();
    expect(typeof globals.callTool).toBe('function');
    expect(asyncFunctionNames.has('callTool')).toBe(true);
  });

  it('callTool returns error for unknown tool', async () => {
    const resolvedTools = new Map<string, any>([
      ['tool-a', { name: 'tool-a', exec: 'echo a' }],
    ]);

    const { globals } = buildToolGlobals({
      resolvedTools,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    const result = await (globals.callTool as Function)('nonexistent');
    expect(result).toContain('ERROR');
    expect(result).toContain('nonexistent');
    expect(result).toContain('not found');
  });

  it('provides listTools that returns tool info', () => {
    const resolvedTools = new Map<string, any>([
      ['tool-a', { name: 'tool-a', description: 'Tool A', exec: 'echo a' }],
      ['tool-b', { name: 'tool-b', description: 'Tool B', exec: 'echo b' }],
    ]);

    const { globals } = buildToolGlobals({
      resolvedTools,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    const list = (globals.listTools as Function)();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ name: 'tool-a', description: 'Tool A' });
    expect(list[1]).toEqual({ name: 'tool-b', description: 'Tool B' });
  });

  it('namespaces MCP tools as serverName_toolName', () => {
    const mockClient = {
      callTool: jest.fn().mockResolvedValue({ content: [{ text: '{"ok":true}' }] }),
    };
    const mcpClients = [
      {
        client: mockClient,
        serverName: 'myServer',
        tools: [{ name: 'doStuff', description: 'Does stuff' }],
      },
    ];

    const { globals, asyncFunctionNames } = buildToolGlobals({
      resolvedTools: new Map(),
      mcpClients: mcpClients as any,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    expect(globals['myServer_doStuff']).toBeDefined();
    expect(typeof globals['myServer_doStuff']).toBe('function');
    expect(asyncFunctionNames.has('myServer_doStuff')).toBe(true);
  });

  it('MCP tool function calls client and parses JSON response', async () => {
    const mockClient = {
      callTool: jest.fn().mockResolvedValue({ content: [{ text: '{"result":42}' }] }),
    };
    const mcpClients = [
      {
        client: mockClient,
        serverName: 'srv',
        tools: [{ name: 'calc', description: 'Calculator' }],
      },
    ];

    const { globals } = buildToolGlobals({
      resolvedTools: new Map(),
      mcpClients: mcpClients as any,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    const result = await (globals['srv_calc'] as Function)({ x: 1 });
    expect(mockClient.callTool).toHaveBeenCalledWith({ name: 'calc', arguments: { x: 1 } });
    expect(result).toEqual({ result: 42 });
  });

  it('MCP tool returns plain text when response is not JSON', async () => {
    const mockClient = {
      callTool: jest.fn().mockResolvedValue({ content: [{ text: 'hello world' }] }),
    };
    const mcpClients = [
      { client: mockClient, serverName: 'srv', tools: [{ name: 'echo' }] },
    ];

    const { globals } = buildToolGlobals({
      resolvedTools: new Map(),
      mcpClients: mcpClients as any,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    const result = await (globals['srv_echo'] as Function)({});
    expect(result).toBe('hello world');
  });

  it('MCP tool returns ERROR string on failure', async () => {
    const mockClient = {
      callTool: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const mcpClients = [
      { client: mockClient, serverName: 'srv', tools: [{ name: 'broken' }] },
    ];

    const { globals } = buildToolGlobals({
      resolvedTools: new Map(),
      mcpClients: mcpClients as any,
      toolContext: {},
    } as BuildToolGlobalsOptions);

    const result = await (globals['srv_broken'] as Function)({});
    expect(result).toContain('ERROR');
    expect(result).toContain('connection refused');
  });
});

// ─── Integration: transformScriptForAsync + compileAndRunAsync ────────────

describe('async script execution (integration)', () => {
  // Use the actual sandbox to verify end-to-end behavior
  let sandbox: any;
  let compileAndRunAsync: any;

  beforeAll(async () => {
    const sandboxMod = await import('../../../src/utils/sandbox');
    sandbox = sandboxMod.createSecureSandbox();
    compileAndRunAsync = sandboxMod.compileAndRunAsync;
  });

  it('returns value from simple expression', async () => {
    const code = '({ ok: true })';
    const transformed = transformScriptForAsync(code, new Set(['schedule']));
    const result = await compileAndRunAsync(sandbox, transformed, { schedule: async () => ({}) }, {
      injectLog: false,
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns value from IIFE', async () => {
    const code = '(() => { const x = 5; return { val: x }; })()';
    const transformed = transformScriptForAsync(code, new Set(['schedule']));
    const result = await compileAndRunAsync(sandbox, transformed, { schedule: async () => ({}) }, {
      injectLog: false,
    });
    expect(result).toEqual({ val: 5 });
  });

  it('returns value from explicit return', async () => {
    const code = 'const x = 10;\nreturn x * 2;';
    const transformed = transformScriptForAsync(code, new Set(['schedule']));
    const result = await compileAndRunAsync(sandbox, transformed, { schedule: async () => ({}) }, {
      injectLog: false,
    });
    expect(result).toBe(20);
  });

  it('awaits async function calls and returns result', async () => {
    const mockTool = async (args: any) => ({ doubled: args.n * 2 });
    const code = 'const r = myTool({ n: 21 });\nreturn r;';
    const transformed = transformScriptForAsync(code, new Set(['myTool']));
    const result = await compileAndRunAsync(sandbox, transformed, { myTool: mockTool }, {
      injectLog: false,
    });
    expect(result).toEqual({ doubled: 42 });
  });

  it('handles async call in last expression (no explicit return)', async () => {
    const mockTool = async (args: any) => args.val + 1;
    const code = 'myTool({ val: 99 })';
    const transformed = transformScriptForAsync(code, new Set(['myTool']));
    const result = await compileAndRunAsync(sandbox, transformed, { myTool: mockTool }, {
      injectLog: false,
    });
    expect(result).toBe(100);
  });

  it('multi-step script with async calls', async () => {
    const fetchData = async () => ({ items: [1, 2, 3] });
    const saveResult = async (args: any) => ({ saved: args.count });
    const code = `
      const data = fetchData();
      const total = data.items.length;
      saveResult({ count: total })
    `;
    const transformed = transformScriptForAsync(code, new Set(['fetchData', 'saveResult']));
    const result = await compileAndRunAsync(
      sandbox,
      transformed,
      { fetchData, saveResult },
      { injectLog: false }
    );
    expect(result).toEqual({ saved: 3 });
  });
});
