# Visor SDK for Node.js (ESM/CJS) — RFC

Status: Draft
Owner: Probe Labs
Last updated: 2025-10-03

## 1) Motivation

Visor is currently distributed primarily as a CLI and GitHub Action. Users increasingly want to:
- Call Visor programmatically from build scripts, test runners, or IDE extensions.
- Orchestrate checks dynamically (e.g., select checks at runtime, react to results, implement custom routing).
- Integrate Visor output into custom dashboards and CI pipelines without shelling out.

Delivering a first‑class SDK with proper TypeScript types and dual ESM/CJS builds unlocks these scenarios while keeping the CLI intact.

### Principles (very thin shim)
- SDK is a façade over the existing Visor engine. No new execution logic.
- No bespoke sandboxing, schedulers, or provider behavior in the SDK.
- The SDK only wires inputs/outputs, surfaces types/events, and forwards options to the core.
- All safety and behavior live in the core engine; SDK remains lightweight and stable.

## 2) Goals (MVP)
- Dual module support: native ESM and CommonJS with a single npm package `@probelabs/visor`.
- First‑class TypeScript: bundled `.d.ts` with JSDoc, no `any` in public API.
- Stable public surface for: loading config, resolving checks, executing checks, streaming events, and collecting results.
- Programmatic access to routing (on_fail/on_success) including retry/backoff and ancestor‑only `goto`.
- Reasonable defaults that mirror CLI behavior; no breaking changes to CLI or Action.
- Small, tree‑shakable entry for SDK; CLI remains bundled separately.

### Non‑Goals (for MVP)
- Browser/runtime‑agnostic build. Node 18+ only for MVP.
- Public provider/engine SPI for third‑party engines (possible in a later phase).

## 3) Public API (proposed)
Top‑level entry: `@probelabs/visor/sdk` (via package `exports`).

```ts
// ESM
import {
  createVisor,
  runChecks,
  loadConfig,
  resolveChecks,
  type Visor,
  type VisorOptions,
  type RunOptions,
  type RunSummary,
  type VisorConfig,
  type CheckResult,
  type Issue,
  type RoutingTrace,
} from '@probelabs/visor/sdk';

// CJS
const {
  createVisor,
  runChecks,
  loadConfig,
  resolveChecks,
} = require('@probelabs/visor/sdk');
```

### 3.1 Core types
- `VisorOptions`
  - `cwd?: string`
  - `logger?: LoggerLike` (info/debug/warn/error)
  - `ai?: { provider?: ProviderId; model?: string }`
  - `parallelism?: number`
  - `env?: NodeJS.ProcessEnv`
- `RunOptions`
  - `config: VisorConfig` or `configPath: string`
  - `checks?: string[]` (IDs or `['all']`)
  - `tags?: { include?: string[]; exclude?: string[] }`
  - `inputs?: Record<string, unknown>` (templating context)
  - `output?: { format?: 'table'|'markdown'|'json'|'sarif'; groupBy?: 'check'|'file' }`
- `RunSummary`
  - `checks: CheckResult[]`
  - `issues: Issue[]` (all aggregated)
  - `stats: { durationMs: number; successCount: number; failureCount: number }`
  - `routing?: RoutingTrace[]`

Public types will be exported from `src/types/*` and surfaced by the SDK bundle (`.d.ts`).

### 3.2 Instances and helpers
- `createVisor(opts?: VisorOptions): Visor`
  - Returns an instance exposing:
    - `events`: `EventEmitter` (typed)
      - `check:start`, `check:success`, `check:fail`
      - `routing:action` (run/goto/retry), `routing:loop`
      - `log` (debug/info/warn/error)
      - `done`
    - `run(opts: RunOptions): Promise<RunSummary>`
    - `stream(opts: RunOptions): AsyncIterable<VisorEvent>` (optional sugar)
- `loadConfig(path: string): Promise<VisorConfig>`
- `resolveChecks(checkIds: string[], config: VisorConfig): string[]` (dependency expansion)
- `runChecks(runOpts: RunOptions & { visor?: VisorOptions }): Promise<RunSummary>` (one‑shot convenience)

### 3.3 Routing access in SDK
- The SDK honors `on_fail`/`on_success` from the provided config.
- `RunSummary.routing` returns a concise, machine‑readable trace of routing actions (retry, goto, run_js, goto_js) including loop counters and decision metadata.
- Per‑check attempt counters exposed in trace; forEach items are isolated.

## 4) Packaging & Build
- Keep CLI bundle via `@vercel/ncc` at `dist/index.js` for `bin` and GitHub Action.
- Add SDK build via `tsup` (preferred) or Rollup:
  - Inputs: `src/sdk.ts`
  - Outputs: `dist/sdk/index.mjs` (ESM), `dist/sdk/index.cjs` (CJS), `dist/sdk/index.d.ts` (types)
  - `sideEffects: false` for tree‑shaking
  - Target: Node `>=18`
  - Sourcemaps enabled
- `package.json` changes (illustrative):
  - `exports`:
    ```json
    {
      ".": {
        "import": "./dist/sdk/index.mjs",
        "require": "./dist/sdk/index.cjs",
        "types": "./dist/sdk/index.d.ts"
      },
      "./sdk": {
        "import": "./dist/sdk/index.mjs",
        "require": "./dist/sdk/index.cjs",
        "types": "./dist/sdk/index.d.ts"
      },
      "./cli": {
        "require": "./dist/index.js"
      }
    }
    ```
  - `types`: `./dist/sdk/index.d.ts`
  - `files`: include `dist/` (SDK + CLI) and `defaults/`
  - Scripts:
    - `build:cli` (unchanged `ncc`)
    - `build:sdk` (tsup for dual build + d.ts)
    - `build` runs both

## 5) Types & Stability
- All exported types live in `src/types/` and are re‑exported from `src/sdk.ts`.
- No `any` in public API; use discriminated unions for events and results.
- Introduce `VisorError` with stable `code` (e.g., `CONFIG_NOT_FOUND`, `ROUTING_MAX_LOOPS_EXCEEDED`, `CHECK_FAILED`).
- Semver policy: public types are part of the contract; breaking changes require a major bump.

## 6) JS Sandbox Safety (run_js/goto_js)
Out of scope for the SDK. The SDK does not introduce or maintain any sandbox. Safety is enforced by the core engine. The SDK will:
- Pass through any routing/sandbox options to the core.
- Surface resulting events and traces unchanged.

If/when the core provides stricter sandbox controls (e.g., worker‑thread limits), the SDK will forward those knobs without adding behavior.

## 7) Examples (to add alongside implementation)
- `examples/sdk-basic.mjs` — load config, run checks, print table/markdown.
- `examples/sdk-cjs.cjs` — CommonJS require + run.
- `examples/sdk-types.ts` — TypeScript usage with typed events.
- `examples/sdk-routing.ts` — demonstrates routing events and traces.

## 8) Testing & CI
- Unit: type tests for public API (tsd or TypeScript compile fixtures).
- Integration:
  - ESM import works on Node 18+.
  - CJS require works on Node 18+.
  - Event stream delivers expected sequence for simple config.
  - Routing trace emitted for retry/goto; loop caps enforced deterministically.
- Workflows:
  - Add a matrix job `sdk-consume` to compile and run the three examples with `npm ci`.

## 9) Migration & Backwards Compatibility
- CLI remains at `dist/index.js` with existing `bin` and Action behavior.
- No changes required for current users. New consumers import `@probelabs/visor/sdk`.
- README will gain an “SDK Usage” section after implementation; `docs/NPM_USAGE.md` will link to it.

## 10) Phased Plan
1. RFC sign‑off (this doc).
2. Create `src/sdk.ts` façade and re‑export stable types; wire through existing engine (`CheckExecutionEngine`).
3. Add `tsup` and dual build; update `package.json` exports; keep `ncc` for CLI.
4. (Core) Harden JS sandbox in engine as a separate track; SDK simply forwards options.
5. Write examples and tests; add CI matrix for ESM/CJS/TS.
6. Docs: README section and `docs/sdk.md` (guide). Release minor version.

## 11) Open Questions
- Do we want a browser/WebWorker build later? If yes, we’ll need to abstract fs/git and remove Node‑only deps from the core.
- Should SDK expose a plugin registration API now (providers/check types), or defer until a stable SPI is designed?
- Should `run()` also return an async iterator for live consumption, or keep `.events` as the primary streaming method?

---

If accepted, implementation will proceed under branch `feat/sdk` with a draft PR for incremental review.
