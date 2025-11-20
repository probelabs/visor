export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose' | 'debug';
declare class Logger {
    private level;
    private isJsonLike;
    private isTTY;
    private showTimestamps;
    configure(opts?: {
        outputFormat?: string;
        level?: LogLevel;
        debug?: boolean;
        verbose?: boolean;
        quiet?: boolean;
    }): void;
    private shouldLog;
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
