/**
 * Interactive terminal prompting (minimal TTY UI)
 */

import * as readline from 'readline';

export interface PromptOptions {
  /** The prompt text to display */
  prompt: string;
  /** Placeholder text (shown in dim color) */
  placeholder?: string;
  /** Allow multiline input (Ctrl+D to finish) */
  multiline?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Default value if timeout occurs */
  defaultValue?: string;
  /** Allow empty input */
  allowEmpty?: boolean;
}
/**
 * Prompt user for input with a beautiful interactive UI
 */
export async function interactivePrompt(options: PromptOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const allowEmpty = options.allowEmpty ?? false;
    const multiline = options.multiline ?? false;
    const defaultValue = options.defaultValue;

    let timeoutId: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        rl.removeAllListeners();
      } catch {}
      try {
        rl.close();
      } catch {}
      // Hardening: make sure no stray listeners remain on stdin between loops
      try {
        const input: any = (rl as any).input || process.stdin;
        if (input && typeof input.removeAllListeners === 'function') {
          input.removeAllListeners('data');
          input.removeAllListeners('keypress');
          input.removeAllListeners('readable');
          input.removeAllListeners('close');
        }
      } catch {}
      try {
        if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
          (process.stdin as any).setRawMode(false);
        }
      } catch {}
      try {
        process.stdin.pause();
      } catch {}
    };
    const finish = (value: string) => {
      cleanup();
      resolve(value);
    };

    // Optional timeout (no default)
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        if (defaultValue !== undefined) return resolve(defaultValue);
        return reject(new Error('Input timeout'));
      }, options.timeout);
    }

    // Print minimal header with dashed separators
    const header: string[] = [];
    if (options.prompt && options.prompt.trim()) header.push(options.prompt.trim());
    if (multiline) header.push('(Ctrl+D to submit)');
    if (options.placeholder && !multiline) header.push(options.placeholder);
    const width = Math.max(
      20,
      Math.min((process.stdout && (process.stdout as any).columns) || 80, 100)
    );
    const dash = '-'.repeat(width);
    try {
      console.log('\n' + dash);
      if (header.length) console.log(header.join('\n'));
      console.log(dash);
    } catch {}

    if (multiline) {
      let buf = '';
      process.stdout.write('> ');
      rl.on('line', line => {
        buf += (buf ? '\n' : '') + line;
        process.stdout.write('> ');
      });
      rl.on('close', () => {
        const trimmed = buf.trim();
        if (!trimmed && !allowEmpty && defaultValue === undefined) {
          return reject(new Error('Empty input not allowed'));
        }
        return finish(trimmed || defaultValue || '');
      });
      rl.on('SIGINT', () => {
        try {
          // Print a clean newline and exit immediately with 130 (SIGINT)
          process.stdout.write('\n');
        } catch {}
        cleanup();
        process.exit(130);
      });
    } else {
      rl.question('> ', answer => {
        const trimmed = (answer || '').trim();
        if (!trimmed && !allowEmpty && defaultValue === undefined) {
          cleanup();
          return reject(new Error('Empty input not allowed'));
        }
        return finish(trimmed || defaultValue || '');
      });
      rl.on('SIGINT', () => {
        try {
          process.stdout.write('\n');
        } catch {}
        cleanup();
        process.exit(130);
      });
    }
  });
}

/**
 * Simple prompt without fancy UI (for non-TTY environments)
 */
export async function simplePrompt(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('SIGINT', () => {
      try {
        process.stdout.write('\n');
      } catch {}
      rl.close();
      process.exit(130);
    });

    rl.question(`${prompt}\n> `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
