import { validateJsSyntax, createSecureSandbox, compileAndRun } from '../../src/utils/sandbox';

describe('validateJsSyntax', () => {
  it('should validate correct JavaScript', () => {
    const result = validateJsSyntax('for (var i = 0; i < 10; i++) { log(i); }');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should detect missing closing brace', () => {
    const result = validateJsSyntax('for (var i = 0; i < 10; i++) { log(i);');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should detect completely broken syntax', () => {
    const result = validateJsSyntax('function {{ broken');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle empty code', () => {
    const result = validateJsSyntax('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle whitespace-only code', () => {
    const result = validateJsSyntax('   \n  ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Code cannot be empty');
  });

  it('should handle null/undefined', () => {
    const result = validateJsSyntax(null as any);
    expect(result.valid).toBe(false);
  });

  it('should validate valid multi-line code', () => {
    const code = `
      var x = 1;
      var y = 2;
      return x + y;
    `;
    const result = validateJsSyntax(code);
    expect(result.valid).toBe(true);
  });
});

describe('sandbox execution features', () => {
  it('should support continue inside if statements in loops', () => {
    const sandbox = createSecureSandbox();
    const code = `
      let sum = 0;
      for (let i = 0; i < 5; i++) {
        if (i === 2) continue;
        sum += i;
      }
      return sum;
    `;
    const result = compileAndRun<number>(sandbox, code, {});
    // 0 + 1 + 3 + 4 = 8 (skipping i=2)
    expect(result).toBe(8);
  });

  it('should support try-catch blocks', () => {
    const sandbox = createSecureSandbox();
    const code = `
      try {
        return 'success';
      } catch (e) {
        return 'error';
      }
    `;
    const result = compileAndRun<string>(sandbox, code, {});
    expect(result).toBe('success');
  });

  it('should support for...of loops', () => {
    const sandbox = createSecureSandbox();
    const code = `
      const arr = [1, 2, 3];
      let sum = 0;
      for (const x of arr) {
        sum += x;
      }
      return sum;
    `;
    const result = compileAndRun<number>(sandbox, code, {});
    expect(result).toBe(6);
  });

  it('should support break inside if statements in loops', () => {
    const sandbox = createSecureSandbox();
    const code = `
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        if (i === 3) break;
        sum += i;
      }
      return sum;
    `;
    const result = compileAndRun<number>(sandbox, code, {});
    // 0 + 1 + 2 = 3 (breaks at i=3)
    expect(result).toBe(3);
  });

  it('should support nested if statements in loops with continue', () => {
    const sandbox = createSecureSandbox();
    const code = `
      let sum = 0;
      for (let i = 0; i < 5; i++) {
        if (i > 0) {
          if (i === 2) continue;
        }
        sum += i;
      }
      return sum;
    `;
    const result = compileAndRun<number>(sandbox, code, {});
    // 0 + 1 + 3 + 4 = 8 (skipping i=2)
    expect(result).toBe(8);
  });
});
