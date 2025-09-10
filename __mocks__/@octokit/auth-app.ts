// Mock for @octokit/auth-app to work around ESM module issues in Jest
export const createAppAuth = jest.fn(() => {
  return jest.fn(() => Promise.resolve({
    type: 'installation',
    token: 'mock-installation-token',
    tokenType: 'installation',
    expiresAt: new Date(Date.now() + 3600000).toISOString()
  }));
});