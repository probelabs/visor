export interface Command {
    type: string;
    args?: string[];
}
export interface CommandRegistry {
    [command: string]: string[];
}
export declare function parseComment(body: string, supportedCommands?: string[]): Command | null;
export declare function getHelpText(customCommands?: CommandRegistry): string;
