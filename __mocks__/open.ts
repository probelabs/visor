/**
 * Mock for 'open' package
 * Used in tests to avoid actually opening browser windows
 */

export default jest.fn().mockResolvedValue(undefined);
