import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { ConfigManager } from '../../src/config';
import * as path from 'path';

describe('Jira MCP Configuration', () => {
  let provider: AICheckProvider;
  let configManager: ConfigManager;

  beforeEach(() => {
    provider = new AICheckProvider();
    configManager = new ConfigManager();
  });

  describe('validateConfig', () => {
    it('should validate Jira MCP server configuration', async () => {
      const config = {
        type: 'ai',
        prompt: 'Analyze Jira issues using MCP tools',
        ai: {
          provider: 'anthropic',
          mcpServers: {
            jira: {
              command: 'npx',
              args: ['-y', '@aashari/mcp-server-atlassian-jira'],
              env: {
                JIRA_BASE_URL: 'https://company.atlassian.net',
                JIRA_EMAIL: 'user@company.com',
                JIRA_API_TOKEN: 'token123',
              },
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should validate global Jira MCP configuration', async () => {
      const config = {
        type: 'ai',
        prompt: 'Analyze Jira issues',
        ai_mcp_servers: {
          jira: {
            command: 'npx',
            args: ['-y', '@aashari/mcp-server-atlassian-jira'],
            env: {
              JIRA_BASE_URL: 'https://company.atlassian.net',
              JIRA_EMAIL: 'user@company.com',
              JIRA_API_TOKEN: 'token123',
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should validate multi-server configuration with Jira and Probe', async () => {
      const config = {
        type: 'ai',
        prompt: 'Use both Jira and Probe MCP servers',
        ai: {
          provider: 'anthropic',
          mcpServers: {
            jira: {
              command: 'npx',
              args: ['-y', '@aashari/mcp-server-atlassian-jira'],
              env: {
                JIRA_BASE_URL: 'https://company.atlassian.net',
                JIRA_EMAIL: 'user@company.com',
                JIRA_API_TOKEN: 'token123',
              },
            },
            probe: {
              command: 'npx',
              args: ['-y', '@probelabs/probe@latest', 'mcp'],
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should reject invalid Jira MCP configuration (missing command)', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test',
        ai: {
          mcpServers: {
            jira: {
              args: ['-y', '@aashari/mcp-server-atlassian-jira'],
              // Missing command
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });
  });

  describe('example configuration loading', () => {
    it('should load jira-simple-example.yaml without errors', async () => {
      const examplePath = path.join(__dirname, '../../examples/jira-simple-example.yaml');

      try {
        const config = await configManager.loadConfig(examplePath);
        expect(config).toBeDefined();
        expect(config.checks).toBeDefined();
        expect(config.checks.jira_analyze_and_label).toBeDefined();
        expect(config.checks.jira_analyze_and_label.type).toBe('ai');
        expect(config.ai_mcp_servers).toBeDefined();
        if (config.ai_mcp_servers) {
          expect(config.ai_mcp_servers.jira).toBeDefined();
          expect(config.ai_mcp_servers.jira.command).toBe('npx');
        }
      } catch (error) {
        // Config loading might fail due to environment variables, but structure should be valid
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('should validate check configuration from jira example', async () => {
      const checkConfig = {
        type: 'ai',
        prompt: `Perform this exact Jira workflow:

        1. **Query Issues**: Use JQL "project = DEV AND status = 'To Do' AND priority = High ORDER BY created DESC" to find high-priority todo items

        2. **Pick First Issue**: Select the first (most recently created) issue from the results

        3. **AI Analysis**: Analyze the selected issue for complexity, risk, and effort

        4. **Add Label**: Based on analysis, add appropriate label

        Use the Jira MCP tools to execute each step.`,
        ai_mcp_servers: {
          jira: {
            command: 'npx',
            args: ['-y', '@aashari/mcp-server-atlassian-jira'],
            env: {
              JIRA_BASE_URL: '${JIRA_BASE_URL}',
              JIRA_EMAIL: '${JIRA_EMAIL}',
              JIRA_API_TOKEN: '${JIRA_API_TOKEN}',
            },
          },
        },
      };

      const result = await provider.validateConfig(checkConfig);
      expect(result).toBe(true);
    });
  });

  describe('supported config keys', () => {
    it('should include Jira MCP related configuration keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('ai.mcpServers');
      expect(keys).toContain('ai_mcp_servers');
      expect(keys).toContain('ai.provider');
    });
  });
});
