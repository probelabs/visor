export default async function open(_: string | string[], __?: unknown): Promise<void> {
  // Jest mock for the 'open' package used by the debug visualizer/CLI.
  // No-op in tests to avoid spawning external processes.
}
