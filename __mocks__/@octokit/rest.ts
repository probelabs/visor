// Mock for @octokit/rest to work around ESM module issues in Jest
// (universal-user-agent and other ESM transitive deps aren't transformed)
export const Octokit = jest.fn().mockImplementation(() => ({
  rest: {
    apps: { getRepoInstallation: jest.fn() },
    issues: {
      addLabels: jest.fn(),
      removeLabel: jest.fn(),
      createComment: jest.fn(),
    },
    pulls: {
      get: jest.fn(),
      list: jest.fn(),
      listFiles: jest.fn(),
    },
    repos: {
      getContent: jest.fn(),
    },
  },
  auth: jest.fn().mockResolvedValue({ type: 'token', token: 'mock-token' }),
  request: jest.fn(),
  paginate: jest.fn(),
}));
