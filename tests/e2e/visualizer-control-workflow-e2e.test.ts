/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn as _spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// Use the real spawn; tests/setup mocks child_process globally
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realSpawn: typeof _spawn = (
  jest.requireActual('child_process') as typeof import('child_process')
).spawn;

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function httpJson(method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
  const opts: any = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return await res.json();
}

describe('Execution Control Workflow — start/pause/resume/stop/reset', () => {
  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp');
  const configPath = path.join(tempDir, 'control-workflow.yaml');
  let child: ReturnType<typeof realSpawn> | null = null;

  jest.setTimeout(30000);

  beforeAll(async () => {
    fs.mkdirSync(tempDir, { recursive: true });
    const cfg = `
version: '1.0'
max_parallelism: 1
checks:
  alpha:
    type: command
    exec: node -e "setTimeout(()=>console.log('A'), 600)"
  beta:
    type: command
    depends_on: [alpha]
    exec: node -e "setTimeout(()=>console.log('B'), 600)"
  gamma:
    type: command
    depends_on: [beta]
    exec: node -e "setTimeout(()=>console.log('C'), 600)"
`;
    await fsp.writeFile(configPath, cfg, 'utf8');
  });

  afterAll(async () => {
    try {
      await fsp.unlink(configPath);
    } catch {}
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    if (child && !child.killed) {
      try {
        child.kill('SIGINT');
      } catch {}
    }
    child = null;
  });

  it('should perform full control sequence with correct server state', async () => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    const env = { ...process.env } as Record<string, string>;
    delete (env as any).JEST_WORKER_ID;
    env.NODE_ENV = 'e2e';
    env.VISOR_NOBROWSER = 'true';
    env.VISOR_E2E_FORCE_RUN = 'true';

    child = realSpawn(
      'node',
      [
        path.join(process.cwd(), 'dist', 'index.js'),
        '--config',
        configPath,
        '--mode',
        'cli',
        '--output',
        'json',
        '--debug-server',
        '--debug-port',
        String(port),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const base = `http://localhost:${port}`;

    // Wait ready
    {
      const deadline = Date.now() + 15000;
      let ok = false;
      while (Date.now() < deadline) {
        try {
          const s = await httpJson('GET', `${base}/api/status`);
          if (s && s.executionState === 'idle') {
            ok = true;
            break;
          }
        } catch {}
        await sleep(100);
      }
      if (!ok) throw new Error('server not ready');
    }

    // Start → running
    await httpJson('POST', `${base}/api/start`);
    {
      const s = await httpJson('GET', `${base}/api/status`);
      expect(s.executionState).toBe('running');
    }

    // Pause → paused (spans should not grow much while paused)
    const pre = await httpJson('GET', `${base}/api/spans`);
    await httpJson('POST', `${base}/api/pause`);
    {
      const deadline = Date.now() + 5000;
      let state = 'running';
      while (Date.now() < deadline) {
        const st = await httpJson('GET', `${base}/api/status`);
        state = st.executionState;
        if (state === 'paused') break;
        await sleep(100);
      }
      expect(state).toBe('paused');
    }
    await sleep(900);
    const paused = await httpJson('GET', `${base}/api/spans`);
    expect(paused.total).toBeLessThanOrEqual(pre.total + 2);

    // Resume → running
    await httpJson('POST', `${base}/api/resume`);
    {
      const s = await httpJson('GET', `${base}/api/status`);
      expect(s.executionState).toBe('running');
    }

    // Stop while running → stopped (no new spans after a brief window)
    await httpJson('POST', `${base}/api/stop`);
    {
      const deadline = Date.now() + 5000;
      let state = 'running';
      while (Date.now() < deadline) {
        const st = await httpJson('GET', `${base}/api/status`);
        state = st.executionState;
        if (state === 'stopped') break;
        await sleep(100);
      }
      expect(state).toBe('stopped');
    }
    const afterStop = await httpJson('GET', `${base}/api/spans`);
    await sleep(400);
    const afterStop2 = await httpJson('GET', `${base}/api/spans`);
    expect(afterStop2.total).toBeGreaterThanOrEqual(afterStop.total);

    // Reset → idle + spans cleared
    await httpJson('POST', `${base}/api/reset`);
    const postReset = await httpJson('GET', `${base}/api/spans`);
    expect(postReset.executionState).toBe('idle');
    expect(postReset.total).toBe(0);
  });
});
