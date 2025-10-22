// Mock for 'open' package
// Used to prevent actual browser opening during tests

const open = jest.fn().mockResolvedValue(undefined);

export default open;