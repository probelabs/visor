// Stub mock for @utcp/sdk — tests override via jest.mock()
export const UtcpClient = {
  create: async () => ({
    close: async () => {},
    getTools: async () => [],
    callTool: async () => ({}),
  }),
};
