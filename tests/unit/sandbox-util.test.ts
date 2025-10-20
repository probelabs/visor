import { createSecureSandbox, compileAndRun } from '../../src/utils/sandbox';

describe('sandbox util', () => {
  test('injects log() helper and returns value', () => {
    const sandbox = createSecureSandbox();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = compileAndRun<number>(
        sandbox,
        "log('hello', 123); return 7;",
        {},
        { injectLog: true, wrapFunction: true, logPrefix: '[_test_]' }
      );
      expect(result).toBe(7);

      // Ensure our injected log helper emitted with the prefix
      const calls = spy.mock.calls.map(args => args.join(' '));
      const hasPrefixed = calls.some(s => s.includes('[_test_] hello 123'));
      expect(hasPrefixed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('passes scope values into user code', () => {
    const sandbox = createSecureSandbox();
    const scope = { foo: 5, obj: { x: 'y' } };
    const sum = compileAndRun<number>(sandbox, 'return foo + (obj.x === "y" ? 2 : 0);', scope, {
      injectLog: false,
      wrapFunction: true,
    });
    expect(sum).toBe(7);
  });
});
