import { type GraphJournalCheckpointV1 } from './snapshot-store';
export declare const GRAPH_CHECKPOINT_READ_FLAGS: number;
/** Read a checkpoint file without granting it any authority. */
export declare function readGraphCheckpointFile(target: string): GraphJournalCheckpointV1;
/** Validate an input path before the engine is constructed or providers run. */
export declare function validateGraphCheckpointInputFile(target: string): GraphJournalCheckpointV1;
/** Validate an output path before the engine is constructed or providers run. */
export declare function validateGraphCheckpointOutputTarget(target: string): void;
/**
 * Publish a canonical checkpoint atomically to an absent 0600 file.
 * Hard-linking the private temporary file makes the final path an atomic
 * create operation and prevents an existing target or symlink from being
 * replaced.
 */
export declare function publishGraphCheckpointFile(checkpoint: GraphJournalCheckpointV1, target: string): void;
