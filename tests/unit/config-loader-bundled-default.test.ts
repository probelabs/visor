import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigLoader } from '../../src/utils/config-loader';

describe('ConfigLoader bundled default extends', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-project-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('loads bundled default includes when project config extends default outside the package root', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'visor.yaml'),
      yaml.dump({
        extends: 'default',
        checks: {
          'custom-project-check': {
            type: 'ai',
            prompt: 'Project-specific check',
            on: ['pr_opened'],
          },
        },
      })
    );

    const loader = new ConfigLoader({
      baseDir: projectRoot,
      projectRoot,
    });

    const config = await loader.fetchConfig('./visor.yaml');

    expect(config.steps).toBeDefined();
    expect(config.steps?.overview).toBeDefined();
    expect(config.checks).toBeDefined();
    expect(config.checks?.['custom-project-check']).toBeDefined();
  });
});
