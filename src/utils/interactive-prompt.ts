/**
 * Interactive terminal prompting with beautiful UI
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

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

// Box drawing characters (with ASCII fallback)
const supportsUnicode = process.env.LANG?.includes('UTF-8') || process.platform === 'darwin';

const box = supportsUnicode
  ? {
      topLeft: '┌',
      topRight: '┐',
      bottomLeft: '└',
      bottomRight: '┘',
      horizontal: '─',
      vertical: '│',
      leftT: '├',
      rightT: '┤',
    }
  : {
      topLeft: '+',
      topRight: '+',
      bottomLeft: '+',
      bottomRight: '+',
      horizontal: '-',
      vertical: '|',
      leftT: '+',
      rightT: '+',
    };

/**
 * Format time in mm:ss
 */
function formatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Clear the current line and move cursor to beginning
 */
function clearLine() {
  process.stdout.write('\r\x1b[K');
}

/**
 * Draw a horizontal line
 */
function drawLine(char: string, width: number): string {
  return char.repeat(width);
}

/**
 * Wrap text to fit within a given width
 */
function wrapText(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Display the prompt UI
 */
function displayPromptUI(options: PromptOptions, remainingMs?: number): void {
  const width = Math.min(process.stdout.columns || 80, 80) - 4;
  const icon = supportsUnicode ? '💬' : '>';

  console.log('\n'); // Add some spacing

  // Top border
  console.log(
    `${box.topLeft}${drawLine(box.horizontal, width + 2)}${box.topRight}`
  );

  // Title
  console.log(
    `${box.vertical} ${colors.bold}${icon} Human Input Required${colors.reset}${' '.repeat(
      width - 22
    )} ${box.vertical}`
  );

  // Separator
  console.log(
    `${box.leftT}${drawLine(box.horizontal, width + 2)}${box.rightT}`
  );

  // Empty line
  console.log(`${box.vertical} ${' '.repeat(width)} ${box.vertical}`);

  // Prompt text (wrapped)
  const promptLines = wrapText(options.prompt, width - 2);
  for (const line of promptLines) {
    console.log(
      `${box.vertical} ${colors.cyan}${line}${colors.reset}${' '.repeat(
        width - line.length
      )} ${box.vertical}`
    );
  }

  // Empty line
  console.log(`${box.vertical} ${' '.repeat(width)} ${box.vertical}`);

  // Instructions
  const instruction = options.multiline
    ? '(Type your response, press Ctrl+D when done)'
    : '(Type your response and press Enter)';
  console.log(
    `${box.vertical} ${colors.dim}${instruction}${colors.reset}${' '.repeat(
      width - instruction.length
    )} ${box.vertical}`
  );

  // Placeholder if provided
  if (options.placeholder && !options.multiline) {
    console.log(
      `${box.vertical} ${colors.dim}${options.placeholder}${colors.reset}${' '.repeat(
        width - options.placeholder.length
      )} ${box.vertical}`
    );
  }

  // Empty line
  console.log(`${box.vertical} ${' '.repeat(width)} ${box.vertical}`);

  // Timeout indicator
  if (remainingMs !== undefined && options.timeout) {
    const timeIcon = supportsUnicode ? '⏱ ' : 'Time: ';
    const timeStr = `${timeIcon} ${formatTime(remainingMs)} remaining`;
    console.log(
      `${box.vertical} ${colors.yellow}${timeStr}${colors.reset}${' '.repeat(
        width - timeStr.length
      )} ${box.vertical}`
    );
  }

  // Bottom border
  console.log(
    `${box.bottomLeft}${drawLine(box.horizontal, width + 2)}${box.bottomRight}`
  );

  console.log(''); // Empty line before input
  process.stdout.write(`${colors.green}>${colors.reset} `);
}

/**
 * Prompt user for input with a beautiful interactive UI
 */
export async function interactivePrompt(
  options: PromptOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = '';
    let timeoutId: NodeJS.Timeout | undefined;
    let countdownInterval: NodeJS.Timeout | undefined;
    let remainingMs = options.timeout;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Display initial UI
    displayPromptUI(options, remainingMs);

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (countdownInterval) clearInterval(countdownInterval);
      rl.close();
    };

    const finish = (value: string) => {
      cleanup();
      console.log(''); // New line after input
      resolve(value);
    };

    // Setup timeout if specified
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        cleanup();
        console.log(
          `\n${colors.yellow}⏱  Timeout reached${colors.reset}`
        );
        if (options.defaultValue !== undefined) {
          console.log(
            `${colors.gray}Using default value: ${options.defaultValue}${colors.reset}\n`
          );
          resolve(options.defaultValue);
        } else {
          reject(new Error('Input timeout'));
        }
      }, options.timeout);

      // Update countdown every second
      if (remainingMs) {
        countdownInterval = setInterval(() => {
          remainingMs = remainingMs! - 1000;
          if (remainingMs <= 0) {
            if (countdownInterval) clearInterval(countdownInterval);
          }
        }, 1000);
      }
    }

    if (options.multiline) {
      // Multiline mode: collect lines until EOF (Ctrl+D)
      rl.on('line', (line) => {
        input += (input ? '\n' : '') + line;
      });

      rl.on('close', () => {
        cleanup();
        const trimmed = input.trim();
        if (!trimmed && !options.allowEmpty) {
          console.log(
            `${colors.yellow}⚠  Empty input not allowed${colors.reset}`
          );
          reject(new Error('Empty input not allowed'));
        } else {
          finish(trimmed);
        }
      });
    } else {
      // Single line mode
      rl.question('', (answer) => {
        const trimmed = answer.trim();
        if (!trimmed && !options.allowEmpty && !options.defaultValue) {
          cleanup();
          console.log(
            `${colors.yellow}⚠  Empty input not allowed${colors.reset}`
          );
          reject(new Error('Empty input not allowed'));
        } else {
          finish(trimmed || options.defaultValue || '');
        }
      });
    }

    // Handle Ctrl+C
    rl.on('SIGINT', () => {
      cleanup();
      console.log('\n\n' + colors.yellow + '⚠  Cancelled by user' + colors.reset);
      reject(new Error('Cancelled by user'));
    });
  });
}

/**
 * Simple prompt without fancy UI (for non-TTY environments)
 */
export async function simplePrompt(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${prompt}\n> `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
