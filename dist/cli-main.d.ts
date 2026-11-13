import './utils/child-process-error-handler';
import { type GraphJournalCheckpointV1 } from './snapshot-store';
export declare function validateArtifactPathAliases(options: import('./types/cli').CliOptions): void;
export declare function resolveGraphRetryPrefixPath(options: import('./types/cli').CliOptions): string | undefined;
export declare function validateGraphCheckpointMode(options: import('./types/cli').CliOptions): GraphJournalCheckpointV1 | undefined;
export declare function validateGraphDispatchOwner(config: import('./types/config').VisorConfig, owner: string | undefined): string | undefined;
export declare function resolveGraphRetryTarget(config: import('./types/config').VisorConfig, checkpoint: GraphJournalCheckpointV1, generationId: string): string;
/**
 * Main CLI entry point for Visor
 */
export declare function main(): Promise<void>;
