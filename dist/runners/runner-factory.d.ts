import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import type { CliOptions } from '../types/cli';
import type { StateMachineExecutionEngine } from '../state-machine-execution-engine';
/**
 * Create a Runner instance by name.
 *
 * Each case encapsulates the config-extraction logic previously duplicated
 * in cli-main.ts (reading config sub-objects, env vars, defaults).
 */
export declare function createRunner(name: string, engine: StateMachineExecutionEngine, config: VisorConfig, options: CliOptions): Promise<Runner>;
//# sourceMappingURL=runner-factory.d.ts.map