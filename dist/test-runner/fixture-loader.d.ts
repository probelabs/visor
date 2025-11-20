export type BuiltinFixtureName = 'gh.pr_open.minimal' | 'gh.pr_sync.minimal' | 'gh.issue_open.minimal' | 'gh.issue_comment.standard' | 'gh.issue_comment.visor_help' | 'gh.issue_comment.visor_regenerate' | 'gh.issue_comment.edited' | 'gh.pr_closed.minimal';
export interface LoadedFixture {
    name: string;
    webhook: {
        name: string;
        action?: string;
        payload: Record<string, unknown>;
    };
    git?: {
        branch?: string;
        baseBranch?: string;
    };
    files?: Array<{
        path: string;
        content: string;
        status?: 'added' | 'modified' | 'removed' | 'renamed';
        additions?: number;
        deletions?: number;
    }>;
    diff?: string;
    env?: Record<string, string>;
    time?: {
        now?: string;
    };
}
export declare class FixtureLoader {
    load(name: BuiltinFixtureName): LoadedFixture;
    private buildUnifiedDiff;
}
//# sourceMappingURL=fixture-loader.d.ts.map