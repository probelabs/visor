/* eslint-disable @typescript-eslint/no-explicit-any */
// Use the real spawn; tests/setup mocks child_process globally
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realSpawn: typeof import('child_process').spawn = (
  jest.requireActual('child_process') as typeof import('child_process')
).spawn;
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

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

describe('Debug Visualizer Live Mode — pause/resume/stop gate', () => {
  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp');
  const configPath = path.join(tempDir, 'live-mode-e2e.yaml');
  let child: ReturnType<typeof realSpawn> | null = null;
  let port = 0;

  beforeAll(async () => {
    fs.mkdirSync(tempDir, { recursive: true });
    // Slow but deterministic commands (about 2000ms each to allow time for pause/resume tests)
    const cfg = `
version: '1.0'
max_parallelism: 1
checks:
  alpha:
    type: command
    exec: node -e "setTimeout(()=>console.log('A'), 2000)"
  beta:
    type: command
    depends_on: [alpha]
    exec: node -e "setTimeout(()=>console.log('B'), 2000)"
  gamma:
    type: command
    depends_on: [beta]
    exec: node -e "setTimeout(()=>console.log('C'), 2000)"
`;
    await fsp.writeFile(configPath, cfg, 'utf8');
  });

  afterAll(async () => {
    try {
      await fsp.unlink(configPath);
    } catch {}
    try {
      await fsp.rmdir(tempDir, { recursive: true } as any);
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

  it('honors pause/resume/stop and exposes status/spans endpoints', async () => {
    // Pick a port in 40000-50000 to reduce collisions
    port = 40000 + Math.floor(Math.random() * 10000);

    // Start CLI in debug-server mode, headless
    let logs = '';
    const env = { ...process.env } as Record<string, string>;
    delete (env as any).JEST_WORKER_ID;
    env.NODE_ENV = 'e2e';
    env.VISOR_NOBROWSER = 'true';
    env.VISOR_E2E_FORCE_RUN = 'true';

    // Use dist/index.js which bootstraps CLI under Jest via VISOR_E2E_FORCE_RUN
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
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    // Wait for server banner on stdout to ensure it is listening
    const base = `http://localhost:${port}`;
    // Also collect logs in case we need to debug
    child!.stdout?.on('data', (b: Buffer) => {
      logs += b.toString();
    });
    child!.stderr?.on('data', (b: Buffer) => {
      logs += b.toString();
    });
    child!.once('exit', (code: number | null) => {
      // helpful if it dies
      logs += `\n<PROCESS EXIT code=${code}>`;
    });

    // Wait for /api/status to respond
    {
      const deadline = Date.now() + 15000;
      let ok = false;
      while (Date.now() < deadline) {
        try {
          const status = await httpJson('GET', `${base}/api/status`);
          if (status && typeof status === 'object') {
            ok = true;
            break;
          }
        } catch {}
        await sleep(100);
      }
      if (!ok) {
        throw new Error(`Debug server did not start. Logs:\n${logs}`);
      }
    }

    // Before start, spans should be 0
    const pre = await httpJson('GET', `${base}/api/spans`);
    expect(pre.total).toBe(0);

    // Start execution
    await httpJson('POST', `${base}/api/start`);

    // Wait for state to become running
    {
      const deadline = Date.now() + 10000;
      let state = 'idle';
      while (Date.now() < deadline) {
        const st = await httpJson('GET', `${base}/api/status`);
        state = st.executionState;
        if (state === 'running') break;
        await sleep(100);
      }
      expect(state).toBe('running');
    }

    // Pause
    await httpJson('POST', `${base}/api/pause`);
    // Wait for state to reflect paused
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

    // Resume
    await httpJson('POST', `${base}/api/resume`);

    // Wait for state to become running again
    {
      const deadline = Date.now() + 5000;
      let state = 'paused';
      while (Date.now() < deadline) {
        const st = await httpJson('GET', `${base}/api/status`);
        state = st.executionState;
        if (state === 'running') break;
        await sleep(100);
      }
      expect(state).toBe('running');
    }

    await httpJson('POST', `${base}/api/stop`);

    // After stop, state should become stopped and spans endpoint should be readable
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
      const now = await httpJson('GET', `${base}/api/spans`);
      expect(typeof now.total).toBe('number');
      expect(Array.isArray(now.spans)).toBe(true);
    }
  }, 45000);
});
