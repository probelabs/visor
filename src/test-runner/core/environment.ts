export type EnvOverrides = Record<string, string> | undefined;

export class EnvironmentManager {
  private prevRepo?: string;
  private saved: Record<string, string | undefined> = {};

  apply(caseEnv?: EnvOverrides): void {
    this.prevRepo = process.env.GITHUB_REPOSITORY;
    if (!process.env.GITHUB_REPOSITORY) {
      process.env.GITHUB_REPOSITORY = 'owner/repo';
    }
    if (caseEnv) {
      for (const [k, v] of Object.entries(caseEnv)) {
        this.saved[k] = process.env[k];
        process.env[k] = String(v);
      }
    }
  }

  restore(): void {
    if (this.prevRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = this.prevRepo;
    for (const [k, v] of Object.entries(this.saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    this.saved = {};
  }
}
