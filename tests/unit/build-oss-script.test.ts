import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

describe('build-oss script', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const scriptPath = path.join(repoRoot, 'scripts/build-oss.sh');

  function makeTempRepo(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-build-oss-test-'));
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src/enterprise/license'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src/debug-visualizer/ui'), { recursive: true });
    fs.copyFileSync(scriptPath, path.join(tempDir, 'scripts/build-oss.sh'));
    fs.writeFileSync(
      path.join(tempDir, 'src/enterprise/license/validator.ts'),
      'export const ok = true;\n'
    );
    fs.writeFileSync(path.join(tempDir, 'src/sdk.ts'), 'export {};\n');
    fs.writeFileSync(path.join(tempDir, 'src/index.ts'), 'export {};\n');
    return tempDir;
  }

  function runBuildScript(tempDir: string, cliCmd: string, sdkCmd: string): void {
    execFileSync('bash', [path.join(tempDir, 'scripts/build-oss.sh')], {
      cwd: tempDir,
      env: {
        ...process.env,
        VISOR_OSS_BUILD_CLI_CMD: cliCmd,
        VISOR_OSS_BUILD_SDK_CMD: sdkCmd,
      },
      stdio: 'pipe',
    });
  }

  it('does not mutate enterprise sources in the working tree on success', () => {
    const tempDir = makeTempRepo();

    runBuildScript(
      tempDir,
      "mkdir -p dist && printf 'cli' > dist/index.js",
      "mkdir -p dist/sdk && printf 'sdk' > dist/sdk/sdk.js"
    );

    expect(fs.existsSync(path.join(tempDir, 'src/enterprise/license/validator.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.enterprise-stash'))).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, 'dist/index.js'), 'utf8')).toBe('cli');
    expect(fs.readFileSync(path.join(tempDir, 'dist/sdk/sdk.js'), 'utf8')).toBe('sdk');
  });

  it('does not strand enterprise files or a stash dir when the build fails', () => {
    const tempDir = makeTempRepo();

    expect(() =>
      runBuildScript(
        tempDir,
        "mkdir -p dist && printf 'partial' > dist/index.js && exit 7",
        "mkdir -p dist/sdk && printf 'sdk' > dist/sdk/sdk.js"
      )
    ).toThrow();

    expect(fs.existsSync(path.join(tempDir, 'src/enterprise/license/validator.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.enterprise-stash'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'dist'))).toBe(false);
  });
});
