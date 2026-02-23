import {
  createAuthenticatedOctokit,
  resolveAuthFromEnvironment,
  resolvePrivateKey,
  injectGitHubCredentials,
} from '../../src/github-auth';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock @octokit/rest
jest.mock('@octokit/rest', () => {
  const MockOctokit = jest.fn().mockImplementation((opts: any) => ({
    auth: jest.fn().mockResolvedValue({ token: 'ghs_mock_installation_token', type: 'token' }),
    rest: {
      apps: {
        getRepoInstallation: jest.fn().mockResolvedValue({
          data: { id: 12345 },
        }),
      },
    },
    _opts: opts,
  }));
  return { Octokit: MockOctokit };
});

// Mock @octokit/auth-app
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue('mock-auth-strategy'),
}));

describe('github-auth', () => {
  describe('createAuthenticatedOctokit', () => {
    it('should return undefined when no credentials provided', async () => {
      const result = await createAuthenticatedOctokit({});
      expect(result).toBeUndefined();
    });

    it('should create token-authenticated Octokit', async () => {
      const result = await createAuthenticatedOctokit({ token: 'ghp_test123' });
      expect(result).toBeDefined();
      expect(result!.authType).toBe('token');
      expect(result!.token).toBe('ghp_test123');
      expect(result!.octokit).toBeDefined();
    });

    it('should create app-authenticated Octokit with installation ID', async () => {
      const result = await createAuthenticatedOctokit({
        appId: '123',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '456',
      });
      expect(result).toBeDefined();
      expect(result!.authType).toBe('github-app');
      expect(result!.token).toBe('ghs_mock_installation_token');
      expect(result!.octokit).toBeDefined();
    });

    it('should auto-detect installation ID when owner/repo provided', async () => {
      const result = await createAuthenticatedOctokit({
        appId: '123',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        owner: 'myorg',
        repo: 'myrepo',
      });
      expect(result).toBeDefined();
      expect(result!.authType).toBe('github-app');
      expect(result!.token).toBe('ghs_mock_installation_token');
    });

    it('should throw on invalid installation ID', async () => {
      await expect(
        createAuthenticatedOctokit({
          appId: '123',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
          installationId: 'not-a-number',
        })
      ).rejects.toThrow('Invalid installation-id');
    });

    it('should throw on negative installation ID', async () => {
      await expect(
        createAuthenticatedOctokit({
          appId: '123',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
          installationId: '-1',
        })
      ).rejects.toThrow('Invalid installation-id');
    });

    it('should throw when app auth has no installation ID and no owner/repo', async () => {
      await expect(
        createAuthenticatedOctokit({
          appId: '123',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        })
      ).rejects.toThrow('installation ID is required');
    });

    it('should prefer app auth over token when both provided', async () => {
      const result = await createAuthenticatedOctokit({
        token: 'ghp_test123',
        appId: '123',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '456',
      });
      expect(result!.authType).toBe('github-app');
    });
  });

  describe('resolveAuthFromEnvironment', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should resolve GITHUB_TOKEN', () => {
      process.env.GITHUB_TOKEN = 'ghp_from_env';
      const result = resolveAuthFromEnvironment();
      expect(result.token).toBe('ghp_from_env');
    });

    it('should resolve GH_TOKEN as fallback', () => {
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'ghp_from_gh';
      const result = resolveAuthFromEnvironment();
      expect(result.token).toBe('ghp_from_gh');
    });

    it('should resolve GitHub App env vars', () => {
      process.env.GITHUB_APP_ID = '999';
      process.env.GITHUB_APP_PRIVATE_KEY = 'pem-content';
      process.env.GITHUB_APP_INSTALLATION_ID = '888';
      const result = resolveAuthFromEnvironment();
      expect(result.appId).toBe('999');
      expect(result.privateKey).toBe('pem-content');
      expect(result.installationId).toBe('888');
    });

    it('should resolve owner/repo from GITHUB_REPOSITORY', () => {
      delete process.env.GITHUB_REPOSITORY_OWNER;
      process.env.GITHUB_REPOSITORY = 'myorg/myrepo';
      const result = resolveAuthFromEnvironment();
      expect(result.owner).toBe('myorg');
      expect(result.repo).toBe('myrepo');
    });

    it('should prefer GITHUB_REPOSITORY_OWNER', () => {
      process.env.GITHUB_REPOSITORY_OWNER = 'owner-override';
      process.env.GITHUB_REPOSITORY = 'myorg/myrepo';
      const result = resolveAuthFromEnvironment();
      expect(result.owner).toBe('owner-override');
    });

    it('should return empty options when no env vars set', () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_REPOSITORY_OWNER;
      const result = resolveAuthFromEnvironment();
      expect(result.token).toBeUndefined();
      expect(result.appId).toBeUndefined();
    });
  });

  describe('resolvePrivateKey', () => {
    it('should return PEM content as-is', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----';
      expect(resolvePrivateKey(pem)).toBe(pem);
    });

    it('should read from file path', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-private-key.pem');
      const pemContent = '-----BEGIN RSA PRIVATE KEY-----\nfromfile\n-----END RSA PRIVATE KEY-----';
      fs.writeFileSync(tmpFile, pemContent);
      try {
        expect(resolvePrivateKey(tmpFile)).toBe(pemContent);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should return non-PEM non-file string as-is', () => {
      expect(resolvePrivateKey('not-a-file-or-pem')).toBe('not-a-file-or-pem');
    });
  });

  describe('injectGitHubCredentials', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      // Clear any existing GIT_CONFIG_* vars
      delete process.env.GIT_CONFIG_COUNT;
      for (let i = 0; i < 10; i++) {
        delete process.env[`GIT_CONFIG_KEY_${i}`];
        delete process.env[`GIT_CONFIG_VALUE_${i}`];
      }
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should set GITHUB_TOKEN and GH_TOKEN', () => {
      injectGitHubCredentials('ghp_test');
      expect(process.env.GITHUB_TOKEN).toBe('ghp_test');
      expect(process.env.GH_TOKEN).toBe('ghp_test');
    });

    it('should configure git URL rewriting via GIT_CONFIG_COUNT', () => {
      injectGitHubCredentials('ghp_test');
      expect(process.env.GIT_CONFIG_COUNT).toBe('2');
      expect(process.env.GIT_CONFIG_KEY_0).toContain('insteadOf');
      expect(process.env.GIT_CONFIG_KEY_0).toContain('x-access-token:ghp_test@github.com');
      expect(process.env.GIT_CONFIG_VALUE_0).toBe('https://github.com/');
      expect(process.env.GIT_CONFIG_KEY_1).toContain('insteadOf');
      expect(process.env.GIT_CONFIG_VALUE_1).toBe('git@github.com:');
    });

    it('should preserve existing GIT_CONFIG_COUNT entries', () => {
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'some.existing.config';
      process.env.GIT_CONFIG_VALUE_0 = 'value';

      injectGitHubCredentials('ghp_test');

      expect(process.env.GIT_CONFIG_COUNT).toBe('3');
      // Existing entry preserved
      expect(process.env.GIT_CONFIG_KEY_0).toBe('some.existing.config');
      expect(process.env.GIT_CONFIG_VALUE_0).toBe('value');
      // New entries at index 1 and 2
      expect(process.env.GIT_CONFIG_KEY_1).toContain('x-access-token:ghp_test@github.com');
      expect(process.env.GIT_CONFIG_VALUE_1).toBe('https://github.com/');
      expect(process.env.GIT_CONFIG_KEY_2).toContain('x-access-token:ghp_test@github.com');
      expect(process.env.GIT_CONFIG_VALUE_2).toBe('git@github.com:');
    });
  });

  describe('CLI option parsing', () => {
    it('should parse --github-token', () => {
      const { CLI } = require('../../src/cli');
      const cli = new CLI();
      const result = cli.parseArgs(['--github-token', 'ghp_test']);
      expect(result.githubToken).toBe('ghp_test');
    });

    it('should parse --github-app-id and --github-private-key', () => {
      const { CLI } = require('../../src/cli');
      const cli = new CLI();
      const result = cli.parseArgs([
        '--github-app-id',
        '123',
        '--github-private-key',
        'pemcontent',
      ]);
      expect(result.githubAppId).toBe('123');
      expect(result.githubPrivateKey).toBe('pemcontent');
    });

    it('should parse --github-installation-id', () => {
      const { CLI } = require('../../src/cli');
      const cli = new CLI();
      const result = cli.parseArgs(['--github-installation-id', '456']);
      expect(result.githubInstallationId).toBe('456');
    });

    it('should leave github options undefined when not provided', () => {
      const { CLI } = require('../../src/cli');
      const cli = new CLI();
      const result = cli.parseArgs(['--check', 'test']);
      expect(result.githubToken).toBeUndefined();
      expect(result.githubAppId).toBeUndefined();
      expect(result.githubPrivateKey).toBeUndefined();
      expect(result.githubInstallationId).toBeUndefined();
    });
  });
});
