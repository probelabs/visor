export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose' | 'debug';
declare class Logger {
    private readonly taskContextStorage;
    private level;
    private isJsonLike;
    private isTTY;
    private showTimestamps;
    private sink?;
    private sinkPassthrough;
    private sinkErrorMode;
    private sinkErrorHandler?;
    private otelLogger;
    private otelLoggerAttempted;
    configure(opts?: {
        outputFormat?: string;
        level?: LogLevel;
        debug?: boolean;
        verbose?: boolean;
        quiet?: boolean;
    }): void;
    setSink(sink?: (msg: string, level: LogLevel) => void, opts?: {
        passthrough?: boolean;
        errorMode?: 'throw' | 'warn' | 'silent';
        onError?: (error: unknown) => void;
    }): void;
    private shouldLog;
    withTaskContext<T>(taskId: string, fn: () => T): T;
    getCurrentTaskId(): string | undefined;
    private getContextSuffix;
    private emitOtelLog;
    private write;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    verbose(msg: string): void;
    debug(msg: string): void;
    step(msg: string): void;
    success(msg: string): void;
}
export declare const logger: Logger;
export declare function configureLoggerFromCli(options: {
    output?: string;
    debug?: boolean;
    verbose?: boolean;
    quiet?: boolean;
}): void;
export {};
