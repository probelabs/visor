/**
 * Interactive terminal prompting (minimal TTY UI)
 */

import * as readline from 'readline';

// Global, process-wide guard to ensure we never open two readline prompts at once.
// This is crucial because the engine may (due to routing) attempt to schedule
// a second human-input step while the first is still waiting. Two concurrent
// readline instances on the same TTY cause duplicated keystrokes and other
// erratic behavior. We serialize prompts with a tiny async mutex.
let activePrompt = false;
const waiters: Array<() => void> = [];

async function acquirePromptLock(): Promise<void> {
  if (!activePrompt) {
    activePrompt = true;
    return;
  }
  await new Promise<void>(resolve => waiters.push(resolve));
  activePrompt = true;
}

function releasePromptLock(): void {
  activePrompt = false;
  const next = waiters.shift();
  if (next) next();
}

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
  await acquirePromptLock();
  return new Promise((resolve, reject) => {
    const dbg = process.env.VISOR_DEBUG === 'true';
    try {
      if (dbg) {
        const counts: Record<string, number> = {
          data: process.stdin.listenerCount('data'),
          end: process.stdin.listenerCount('end'),
          error: process.stdin.listenerCount('error'),
          readable: process.stdin.listenerCount('readable'),
          close: process.stdin.listenerCount('close'),
        } as any;
        console.error(
          `[human-input] starting prompt: isTTY=${!!process.stdin.isTTY} active=${activePrompt} waiters=${waiters.length} listeners=${JSON.stringify(counts)}`
        );
      }
    } catch {}
    // Ensure stdin is in a sane state for a fresh interactive session
    try {
      if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
        // We use line-based input; disable raw mode just in case
        (process.stdin as any).setRawMode(false);
      }
      // Always resume stdin before creating the interface
      process.stdin.resume();
    } catch {}

    // Ensure encoding is set for predictable behavior
    try {
      process.stdin.setEncoding('utf8');
    } catch {}

    let rl: readline.Interface | undefined;

    const allowEmpty = options.allowEmpty ?? false;
    const multiline = options.multiline ?? false;
    const defaultValue = options.defaultValue;

    let timeoutId: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        rl?.removeAllListeners();
      } catch {}
      try {
        rl?.close();
      } catch {}
      // Hardening: make sure no stray listeners remain on stdin between loops
      // Do not blanket-remove listeners from process.stdin; a fresh readline
      // instance will manage its own listeners. Over-removing here can leave
      // the next interface in a bad state (no keypress events).
      try {
        if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
          (process.stdin as any).setRawMode(false);
        }
      } catch {}
      try {
        process.stdin.pause();
      } catch {}
      // Release the global lock so a queued prompt (if any) may proceed
      try {
        releasePromptLock();
      } catch {}
      // If stdout/stderr were temporarily wrapped by the question handler, restore them now
      try {
        if ((process.stdout as any).__restoreWrites) {
          (process.stdout as any).__restoreWrites();
        }
      } catch {}
      try {
        if ((process.stderr as any).__restoreWrites) {
          (process.stderr as any).__restoreWrites();
        }
      } catch {}
      try {
        if (dbg) {
          const counts: Record<string, number> = {
            data: process.stdin.listenerCount('data'),
            end: process.stdin.listenerCount('end'),
            error: process.stdin.listenerCount('error'),
            readable: process.stdin.listenerCount('readable'),
            close: process.stdin.listenerCount('close'),
          } as any;
          console.error(
            `[human-input] cleanup: isTTY=${!!process.stdin.isTTY} active=false waiters=${waiters.length} listeners=${JSON.stringify(counts)}`
          );
        }
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

    // No echo-suppression hacks — we fix the root cause below by using raw-mode
    // input for single-line prompts, so the terminal never replays the line.

    if (multiline) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
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
      // Root cause fix: raw-mode single-line input without readline echo.
      const readLineRaw = async (): Promise<string> => {
        return new Promise<string>(resolveRaw => {
          let buf = '';
          const onData = (chunk: Buffer) => {
            const s = chunk.toString('utf8');
            for (let i = 0; i < s.length; i++) {
              const ch = s[i];
              const code = s.charCodeAt(i);
              if (ch === '\n' || ch === '\r') {
                try {
                  process.stdout.write('\n');
                } catch {}
                teardown();
                resolveRaw(buf);
                return;
              }
              if (ch === '\b' || code === 127) {
                if (buf.length > 0) {
                  buf = buf.slice(0, -1);
                  try {
                    process.stdout.write('\b \b');
                  } catch {}
                }
                continue;
              }
              if (code === 3) {
                // Ctrl+C
                try {
                  process.stdout.write('\n');
                } catch {}
                teardown();
                process.exit(130);
              }
              if (code >= 32) {
                buf += ch;
                try {
                  process.stdout.write(ch);
                } catch {}
              }
            }
          };
          const teardown = () => {
            try {
              process.stdin.off('data', onData);
            } catch {}
            try {
              if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
                (process.stdin as any).setRawMode(false);
              }
            } catch {}
          };
          try {
            if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
              (process.stdin as any).setRawMode(true);
            }
          } catch {}
          process.stdin.on('data', onData);
          try {
            process.stdout.write('> ');
          } catch {}
        });
      };
      (async () => {
        const answer = await readLineRaw();
        const trimmed = (answer || '').trim();
        if (!trimmed && !allowEmpty && defaultValue === undefined) {
          cleanup();
          return reject(new Error('Empty input not allowed'));
        }
        return finish(trimmed || defaultValue || '');
      })().catch(err => {
        cleanup();
        reject(err);
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
