import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { ChatTUI } from './chat-tui';
import { ChatStateManager } from './chat-state';
import { TuiFrontend } from './tui-frontend';
export interface TuiChatRunnerConfig {
    engine?: StateMachineExecutionEngine;
    config: VisorConfig;
    stateManager?: ChatStateManager;
    endpoint?: string;
    debug?: boolean;
}
export declare class TuiChatRunner {
    private cfg;
    private stateManager;
    private chatTui?;
    private tuiFrontend?;
    private endpoint;
    private debug;
    private messageCounter;
    private isRunning;
    private currentExecution?;
    private taskStore?;
    private configPath?;
    constructor(config: TuiChatRunnerConfig);
    /** Set shared task store for execution tracking. */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    getChatTUI(): ChatTUI | undefined;
    getStateManager(): ChatStateManager;
    getTuiFrontend(): TuiFrontend | undefined;
    private handleUserMessage;
    private resumeFromWaiting;
    private executeWorkflow;
    private prepareConfigForRun;
    waitForExit(timeoutMs?: number): Promise<void>;
}
/**
 * Create and start a TuiChatRunner with the given configuration.
 */
export declare function startChatTUI(config: TuiChatRunnerConfig): Promise<TuiChatRunner>;
//# sourceMappingURL=chat-runner.d.ts.map