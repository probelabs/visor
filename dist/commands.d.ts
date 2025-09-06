export interface Command {
    type: string;
    args?: string[];
}
export declare function parseComment(body: string): Command | null;
export declare function getHelpText(): string;
//# sourceMappingURL=commands.d.ts.map