export type EnvOverrides = Record<string, string> | undefined;
export declare class EnvironmentManager {
    private prevRepo?;
    private saved;
    apply(caseEnv?: EnvOverrides): void;
    restore(): void;
}
//# sourceMappingURL=environment.d.ts.map