import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../../src/config';
import { logger } from '../../src/logger';

describe('Config validation warnings and MCP shape checks', () => {
  let tmpDir: string;
  const writeConfig = (yaml: string): string => {
    const p = path.join(tmpDir, 'test.visor.yaml');
    fs.writeFileSync(p, yaml, 'utf8');
    return p;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-config-test-'));
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (logger.warn as jest.Mock).mockRestore?.();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('warns on unknown top-level keys', async () => {
    const yaml = `
version: "1.0"
checks: {}
unknown_root: 123
`;
    const cm = new ConfigManager();
    await cm.loadConfig(writeConfig(yaml));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown top-level key 'unknown_root'")
    );
  });

  it('warns on unknown keys within a check (typo preserved)', async () => {
    const yaml = `
version: "1.0"
checks:
  mycheck:
    type: ai
    prompt: "ok"
    promt: "typo"
`;
    const cm = new ConfigManager();
    await cm.loadConfig(writeConfig(yaml));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('checks.mycheck.promt'));
  });

  it('warns when both ai_mcp_servers and ai.mcpServers are present and overlapping', async () => {
    const yaml = `
version: "1.0"
checks:
  overlap:
    type: ai
    prompt: "ok"
    ai_mcp_servers:
      logoscope:
        command: "npx"
        args: ["-y", "@probelabs/logoscope@latest", "mcp"]
    ai:
      mcpServers:
        logoscope:
          command: "npx"
          args: ["-y", "@probelabs/logoscope@latest", "mcp"]
`;
    const cm = new ConfigManager();
    await cm.loadConfig(writeConfig(yaml));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('overrides these servers: logoscope')
    );
  });

  it("errors when MCP server 'args' is not an array", async () => {
    const yaml = `
version: "1.0"
checks:
  bad:
    type: ai
    prompt: "ok"
    ai:
      mcpServers:
        logoscope:
          command: "npx"
          args: "-y @probelabs/logoscope@latest mcp"
`;
    const cm = new ConfigManager();
    await expect(cm.loadConfig(writeConfig(yaml))).rejects.toThrow(
      /args must be an array of strings/i
    );
  });

  it("warns when 'npx' command is used without args for MCP server", async () => {
    const yaml = `
version: "1.0"
checks:
  warn_npx:
    type: ai
    prompt: "ok"
    ai_mcp_servers:
      someServer:
        command: "npx"
`;
    const cm = new ConfigManager();
    await cm.loadConfig(writeConfig(yaml));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("uses 'npx' without args"));
  });

  it('warns on unknown keys inside ai object', async () => {
    const yaml = `
version: "1.0"
checks:
  ai_unknown:
    type: ai
    prompt: "ok"
    ai:
      provider: anthropic
      mcpSevers: {}
`;
    const cm = new ConfigManager();
    await cm.loadConfig(writeConfig(yaml));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('checks.ai_unknown.ai.mcpSevers')
    );
  });
});
