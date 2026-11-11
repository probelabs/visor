/**
 * Policy-check CLI subcommand implementation.
 *
 * Validates Rego policy files for syntax and WASM compatibility.
 * Optionally evaluates against sample input JSON.
 *
 * MIT License — this is an OSS module.
 */
export interface PolicyCheckArgs {
    rulesPath: string | string[] | undefined;
    inputFile: string | undefined;
    verbose: boolean;
    configPath: string | undefined;
}
/**
 * Parse raw CLI argv into structured PolicyCheckArgs.
 * Does NOT resolve rulesPath from config — that is a separate async step.
 */
export declare function parsePolicyCheckArgs(argv: string[]): PolicyCheckArgs;
/**
 * If no positional rules path was provided, try to resolve it from config.
 */
export declare function resolveRulesPathFromConfig(args: PolicyCheckArgs): Promise<string | string[] | undefined>;
export interface ExecFileSync {
    (file: string, args: string[], options?: {
        stdio?: string;
        timeout?: number;
    }): Buffer;
}
/**
 * Check that `opa` CLI is available on PATH and print its version.
 * Returns the execFileSync function for subsequent use, or calls process.exit(1).
 */
export declare function verifyOpaCli(verbose: boolean): Promise<ExecFileSync>;
/**
 * Resolve all .rego files from the provided path(s).
 * If a .wasm file is encountered, prints a message and exits with 0.
 * Returns the list of resolved .rego file paths.
 */
export declare function resolveRegoFiles(rulesPath: string | string[]): string[];
/**
 * Run `opa check` on each .rego file. Returns true if all files pass.
 */
export declare function validateSyntax(regoFiles: string[], execFileSync: ExecFileSync, verbose: boolean): boolean;
/**
 * Attempt to compile the .rego files into a WASM bundle via `opa build`.
 * Returns true if compilation succeeds.
 */
export declare function checkWasmCompilation(regoFiles: string[], execFileSync: ExecFileSync, verbose: boolean): Promise<boolean>;
/**
 * Evaluate the policy against a sample input JSON file.
 * Returns true if evaluation ran without errors.
 */
export declare function evaluateSampleInput(inputFile: string, regoFiles: string[], execFileSync: ExecFileSync): boolean;
/**
 * Handle the policy-check subcommand.
 *
 * Validates Rego policy files for syntax and WASM compatibility.
 * Optionally evaluates against sample input JSON.
 *
 * Usage:
 *   visor policy-check [path] [--config <config>] [--input <json-file>]
 */
export declare function handlePolicyCheckCommand(argv: string[]): Promise<void>;
//# sourceMappingURL=policy-check-command.d.ts.map