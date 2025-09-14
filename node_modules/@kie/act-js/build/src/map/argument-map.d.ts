export declare class ArgumentMap<T extends string | string[]> {
    private _map;
    private prefix;
    private delimiter;
    constructor(prefix: string, delimiter?: string);
    get map(): Map<string, T>;
    /**
     * Appends prefix to each key,value to produce a string of arguments to be passed to act
     * @returns
     */
    toActArguments(): string[];
}
