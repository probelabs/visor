import * as fs from 'fs';
import * as path from 'path';
import { VisorTestRunner } from '../../src/test-runner/index';

describe('VisorTestRunner co-located config with extends', () => {
  let tmpDir: string;

  beforeEach(() => {
    const root = path.join(process.cwd(), '.context');
    fs.mkdirSync(root, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(root, 'visor-tests-colocated-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs checks defined in the same tests file even when extends is present', async () => {
    const basePath = path.join(tmpDir, 'base.yaml');
    fs.writeFileSync(
      basePath,
      `version: "1.0"
tools:
  inherited-tool:
    name: inherited-tool
    description: inherited placeholder
    exec: echo ok
`
    );

    const suitePath = path.join(tmpDir, 'suite.yaml');
    fs.writeFileSync(
      suitePath,
      `version: "1.0"
extends: ./base.yaml

checks:
  ping:
    type: script
    content: |
      return { ok: true };
    on:
      - manual

tests:
  defaults:
    strict: true
  cases:
    - name: colocated-check-runs-with-extends
      event: manual
      fixture: local.minimal
      expect:
        calls:
          - step: ping
            exactly: 1
        outputs:
          - step: ping
            path: ok
            equals: true
`
    );

    const runner = new VisorTestRunner(tmpDir);
    const suite = runner.loadSuite(suitePath);
    const result = await runner.runCases(suitePath, suite, { noMocks: true });

    expect(result.failures).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].passed).toBe(true);
  });
});
