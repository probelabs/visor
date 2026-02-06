
// Mock for 'open' package used in tests and E2E. If Jest is present, return a jest.fn()
// so tests can assert calls; otherwise export a no-op async function.
const open: any = (globalThis as any).jest
  ? (globalThis as any).jest.fn().mockResolvedValue(undefined)
  : (async (_: string | string[], __?: unknown): Promise<void> => {});

export default open;
