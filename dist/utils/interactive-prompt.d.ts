/**
 * Interactive terminal prompting with beautiful UI
 */
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
export declare function interactivePrompt(options: PromptOptions): Promise<string>;
/**
 * Simple prompt without fancy UI (for non-TTY environments)
 */
export declare function simplePrompt(prompt: string): Promise<string>;
//# sourceMappingURL=interactive-prompt.d.ts.map