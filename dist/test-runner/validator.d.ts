export type ValidationResult = {
    ok: true;
} | {
    ok: false;
    errors: string[];
};
export declare function validateTestsDoc(doc: unknown): ValidationResult;
//# sourceMappingURL=validator.d.ts.map