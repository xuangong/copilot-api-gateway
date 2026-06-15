# Spec 3 Part 1 — Shared helpers + protocols types (no endpoint migration)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the type-level contract (extended `EventResult`, telemetry types) and shared helpers (`attempt-helpers.ts`, `respond-telemetry.ts`, `telemetry-ctx.ts`, rewritten `upstream-telemetry.ts`, platform `getRuntimeLocation()`) without migrating any endpoint. After this part, all four endpoints still go through legacy `dispatch()` for telemetry persistence; helpers are present and unit-tested but not wired.

**Architecture:** Pure additive extension to `@vnext/protocols/common` + `@vnext/platform`. New shared modules live in `data-plane/chat-flow/shared/`. The `withUpstreamTelemetry` recorder interface is replaced by a pure terminal-frame classifier returning `{ events, finalMetadata }`. The single existing recorder call site (`chat-completions/attempt.ts:135`) is updated to drop the recorder argument and discard `finalMetadata` (Part 2 wires it).

**Tech Stack:** Bun + TypeScript, `@vnext/protocols/common` types, `@vnext/platform` background executor + new `getRuntimeLocation`.

---

## Spec reference

`vnext/docs/superpowers/specs/2026-06-16-spec3-telemetry-channel.md` §4.1, §4.4–§4.7

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `vnext/packages/platform/src/runtime-location.ts` | Create | `RuntimeLocation` type + `getRuntimeLocation()` getter, `initRuntimeLocation()` setter |
| `vnext/packages/platform/src/index.ts` | Modify | Re-export `runtime-location.ts` |
| `vnext/packages/platform/src/reset.ts` | Modify | Reset runtime location alongside other platform globals |
| `vnext/apps/platform-bun/src/bootstrap.ts` | Modify | Call `initRuntimeLocation('bun')` |
| `vnext/apps/platform-cloudflare/src/bootstrap.ts` | Modify | Call `initRuntimeLocation('cloudflare')` |
| `vnext/packages/gateway/tests/_setup-platform.ts` | Modify | Call `initRuntimeLocation('bun')` so gateway tests pass |
| `vnext/packages/protocols/src/common/result.ts` | Modify | Add `TelemetryModelIdentity`, `PerformanceTelemetryContext`, `EventResultMetadata`; extend `EventResult<T>`, `UpstreamErrorResult`, `InternalErrorResult`; new factory signatures |
| `vnext/packages/protocols/tests/common/result.test.ts` | Create | Unit tests for new factories + type-level checks |
| `vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts` | Create | `TelemetryRequestContext` interface |
| `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts` | Create | `telemetryModelIdentity`, `upstreamPerformanceContext`, `providerResponseToExecuteResult` |
| `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts` | Rewrite | Pure terminal-frame classifier returning `{ events, finalMetadata }` |
| `vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts` | Create | `eventResultMetadata`, `recordUsage`, `recordPerformance`, `SourceStreamState` class |
| `vnext/packages/gateway/tests/chat-flow/shared/attempt-helpers.test.ts` | Create | Unit tests |
| `vnext/packages/gateway/tests/chat-flow/shared/upstream-telemetry.test.ts` | Modify (rewrite) | Drop recorder-shape tests; assert classifier outputs |
| `vnext/packages/gateway/tests/chat-flow/shared/respond-telemetry.test.ts` | Create | Unit tests for `eventResultMetadata`, `recordUsage`, `recordPerformance`, `SourceStreamState` |
| `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts` | Modify | Drop recorder argument from `withUpstreamTelemetry` call site; discard `finalMetadata` |

---

## Task 1 — Add `getRuntimeLocation()` to `@vnext/platform`

**Files:**
- Create: `vnext/packages/platform/src/runtime-location.ts`
- Modify: `vnext/packages/platform/src/index.ts`
- Modify: `vnext/packages/platform/src/reset.ts`
- Test: `vnext/packages/platform/tests/runtime-location.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// vnext/packages/platform/tests/runtime-location.test.ts
import { test, expect, beforeEach } from 'bun:test'
import {
  __resetPlatformForTests,
  initRuntimeLocation,
  getRuntimeLocation,
} from '@vnext/platform'

beforeEach(() => __resetPlatformForTests())

test('getRuntimeLocation throws when not initialized', () => {
  expect(() => getRuntimeLocation()).toThrow(/not initialized/i)
})

test('initRuntimeLocation("bun") makes getRuntimeLocation return "bun"', () => {
  initRuntimeLocation('bun')
  expect(getRuntimeLocation()).toBe('bun')
})

test('initRuntimeLocation("cloudflare") makes getRuntimeLocation return "cloudflare"', () => {
  initRuntimeLocation('cloudflare')
  expect(getRuntimeLocation()).toBe('cloudflare')
})

test('reset clears the runtime location', () => {
  initRuntimeLocation('bun')
  __resetPlatformForTests()
  expect(() => getRuntimeLocation()).toThrow()
})
```

Run: `cd vnext && bun test packages/platform/tests/runtime-location.test.ts`
Expected: FAIL — module exports missing.

- [ ] **Step 2: Implement**

```ts
// vnext/packages/platform/src/runtime-location.ts
import { __registerPlatformReset } from "./reset.ts"

export type RuntimeLocation = 'bun' | 'cloudflare'

let _loc: RuntimeLocation | null = null
__registerPlatformReset(() => { _loc = null })

export function initRuntimeLocation(loc: RuntimeLocation): void {
  _loc = loc
}

export function getRuntimeLocation(): RuntimeLocation {
  if (!_loc) throw new Error("Runtime location not initialized; call bootstrap*Platform() first")
  return _loc
}
```

```ts
// vnext/packages/platform/src/index.ts
export * from "./sql-database.ts"
export * from "./file-provider.ts"
export * from "./image-processor.ts"
export * from "./env.ts"
export * from "./background.ts"
export * from "./runtime-location.ts"
export { __resetPlatformForTests, __registerPlatformReset } from "./reset.ts"
```

(`reset.ts` already iterates registered resetters via `__registerPlatformReset` — no edit needed if that pattern is used. Verify; if `reset.ts` lists modules explicitly, append a line.)

- [ ] **Step 3: Run test, expect PASS**

Run: `cd vnext && bun test packages/platform/tests/runtime-location.test.ts`

- [ ] **Step 4: Wire bootstraps**

```ts
// vnext/apps/platform-bun/src/bootstrap.ts (add import + call after initBackground)
import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
  initRuntimeLocation,
} from "@vnext/platform"
// ...
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
```

```ts
// vnext/apps/platform-cloudflare/src/bootstrap.ts (similar)
import { initRuntimeLocation } from "@vnext/platform"
// inside bootstrapCloudflarePlatform, after initBackground:
  initRuntimeLocation('cloudflare')
```

```ts
// vnext/packages/gateway/tests/_setup-platform.ts (add)
import { initRuntimeLocation } from '@vnext/platform'
// after initBackground call:
  initRuntimeLocation('bun')
```

- [ ] **Step 5: Run gateway tests, expect no regressions**

Run: `cd vnext && bun test packages/gateway/tests`
Expected: same baseline as before this part (pre-Spec-3); no new failures.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/platform/src/runtime-location.ts \
        vnext/packages/platform/src/index.ts \
        vnext/packages/platform/tests/runtime-location.test.ts \
        vnext/apps/platform-bun/src/bootstrap.ts \
        vnext/apps/platform-cloudflare/src/bootstrap.ts \
        vnext/packages/gateway/tests/_setup-platform.ts
git commit -m "feat(platform): add getRuntimeLocation() with bun/cloudflare bootstraps (spec3 part1)"
```

---

## Task 2 — Extend `protocols/common/result.ts` with telemetry types

**Files:**
- Modify: `vnext/packages/protocols/src/common/result.ts`
- Test: `vnext/packages/protocols/tests/common/result.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// vnext/packages/protocols/tests/common/result.test.ts
import { test, expect } from 'bun:test'
import {
  eventResult,
  internalErrorResult,
  readUpstreamError,
  type TelemetryModelIdentity,
  type PerformanceTelemetryContext,
  type EventResultMetadata,
  type EventResult,
} from '@vnext/protocols/common'

const identity = (): TelemetryModelIdentity => ({
  model: 'gpt-4',
  upstream: 'openai-prod',
  modelKey: 'gpt-4',
  cost: null,
})
const perf = (): PerformanceTelemetryContext => ({
  keyId: 'k1',
  model: 'gpt-4',
  upstream: 'openai-prod',
  modelKey: 'gpt-4',
  stream: true,
  runtimeLocation: 'bun',
})

async function* empty(): AsyncGenerator<number> { /* yields nothing */ }

test('eventResult requires modelIdentity, accepts performance + finalMetadata', () => {
  const r = eventResult(empty(), identity(), perf(), Promise.resolve({ modelIdentity: identity() }))
  expect(r.type).toBe('events')
  expect(r.modelIdentity.model).toBe('gpt-4')
  expect(r.performance?.keyId).toBe('k1')
  expect(r.finalMetadata).toBeInstanceOf(Promise)
})

test('eventResult without performance/finalMetadata leaves them undefined', () => {
  const r = eventResult(empty(), identity())
  expect(r.performance).toBeUndefined()
  expect(r.finalMetadata).toBeUndefined()
})

test('internalErrorResult accepts optional performance', () => {
  const r = internalErrorResult(502, new Error('boom'), perf())
  expect(r.performance?.keyId).toBe('k1')
  const r2 = internalErrorResult(404, new Error('nope'))
  expect(r2.performance).toBeUndefined()
})

test('readUpstreamError accepts optional performance', async () => {
  const resp = new Response('body', { status: 401 })
  const r = await readUpstreamError(resp, perf())
  expect(r.status).toBe(401)
  expect(r.performance?.keyId).toBe('k1')
})

test('EventResultMetadata shape', () => {
  const md: EventResultMetadata = { modelIdentity: identity(), performance: perf() }
  expect(md.modelIdentity.upstream).toBe('openai-prod')
})
```

Run: `cd vnext && bun test packages/protocols/tests/common/result.test.ts`
Expected: FAIL — types/factories missing.

- [ ] **Step 2: Implement**

Replace `vnext/packages/protocols/src/common/result.ts` with:

```ts
// packages/protocols/src/common/result.ts
import type { ModelPricing } from '@vnext/provider'

export interface TelemetryModelIdentity {
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  readonly cost: ModelPricing | null
}

export interface PerformanceTelemetryContext {
  readonly keyId: string
  readonly model: string
  readonly upstream: string | null
  readonly modelKey: string
  readonly stream: boolean
  readonly runtimeLocation: 'bun' | 'cloudflare'
}

export interface EventResultMetadata {
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
}

export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
  readonly finalMetadata?: Promise<EventResultMetadata>
}

export interface UpstreamErrorResult {
  readonly type: 'upstream-error'
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  readonly performance?: PerformanceTelemetryContext
}

export interface InternalErrorResult {
  readonly type: 'internal-error'
  readonly status: number
  readonly error: Error
  readonly performance?: PerformanceTelemetryContext
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
): EventResult<T> => ({
  type: 'events',
  events,
  modelIdentity,
  performance,
  finalMetadata,
})

export const internalErrorResult = (
  status: number,
  error: Error,
  performance?: PerformanceTelemetryContext,
): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  performance,
})

export const readUpstreamError = async (
  response: Response,
  performance?: PerformanceTelemetryContext,
): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
  performance,
})

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  })

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string =>
  new TextDecoder().decode(error.body)
```

- [ ] **Step 3: Run test, expect PASS**

Run: `cd vnext && bun test packages/protocols/tests/common/result.test.ts`

- [ ] **Step 4: Fix all existing `eventResult(...)` call sites**

The signature change (modelIdentity now required) is a compile-time break. Run:

```bash
cd vnext && grep -rn "eventResult(" packages --include="*.ts" | grep -v "test\|spec\|result.ts"
```

For each call site **temporarily** pass a stub identity (these will be filled in properly by Parts 2–4):

```ts
import { eventResult } from '@vnext/protocols/common'
const STUB_IDENTITY = { model: '<unknown>', upstream: '<unknown>', modelKey: '<unknown>', cost: null }
return eventResult(events, STUB_IDENTITY)
```

Document each touched file in the commit message. Add a `// FIXME(spec3-part2/3/4): real identity` comment next to each stub. Expected sites: chat-completions/attempt.ts, messages/attempt.ts, responses/attempt.ts, gemini attempt(s) if they exist, plus any test fixtures.

- [ ] **Step 5: Run typecheck**

Run: `cd vnext && bun x tsc --noEmit`
Expected: clean across `gateway`, `protocols`, `interceptor`, `provider*`.

- [ ] **Step 6: Run full gateway test suite**

Run: `cd vnext && bun test packages/gateway/tests`
Expected: same baseline as before — stub identities flow through, no behavior change.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/protocols/src/common/result.ts \
        vnext/packages/protocols/tests/common/result.test.ts \
        vnext/packages/gateway/src/data-plane/chat-flow # all touched attempt files
git commit -m "feat(protocols/common): add telemetry types + extend ExecuteResult (spec3 part1)"
```

---

## Task 3 — Create `telemetry-ctx.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts`

- [ ] **Step 1: Write the file**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts
/**
 * Telemetry-only request context, distinct from `@vnext/interceptor`'s
 * minimal `RequestContext`. Built once per request in serve.ts and threaded
 * through attempt + respond so persistence helpers (`recordUsage`,
 * `recordPerformance`) can write usage rows without touching `RequestContext`.
 */
import type { RuntimeLocation } from '@vnext/platform'

export interface TelemetryRequestContext {
  readonly apiKeyId: string
  /** Matches legacy DispatchObsCtx — null when the inbound `User-Agent` header is absent. */
  readonly userAgent: string | null
  readonly requestId: string
  readonly isStreaming: boolean
  readonly runtimeLocation: RuntimeLocation
  readonly requestStartedAt: number
}
```

(No test — pure interface.)

- [ ] **Step 2: Typecheck**

Run: `cd vnext && bun x tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts
git commit -m "feat(gateway/chat-flow): add TelemetryRequestContext (spec3 part1)"
```

---

## Task 4 — Create `attempt-helpers.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts`
- Test: `vnext/packages/gateway/tests/chat-flow/shared/attempt-helpers.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// vnext/packages/gateway/tests/chat-flow/shared/attempt-helpers.test.ts
import { test, expect } from 'bun:test'
import {
  telemetryModelIdentity,
  upstreamPerformanceContext,
} from '../../../src/data-plane/chat-flow/shared/attempt-helpers.ts'
import type { TelemetryRequestContext } from '../../../src/data-plane/chat-flow/shared/telemetry-ctx.ts'

const fakeBinding = {
  upstream: { name: 'openai-prod' },
  upstreamModel: { id: 'gpt-4' },
  provider: {
    getPricingForModelKey: (k: string) => k === 'gpt-4' ? { inputPerM: 1, outputPerM: 2 } : null,
  },
} as const

const ctx = (over: Partial<TelemetryRequestContext> = {}): TelemetryRequestContext => ({
  apiKeyId: 'k1', userAgent: null, requestId: 'r1',
  isStreaming: true, runtimeLocation: 'bun', requestStartedAt: 0,
  ...over,
})

test('telemetryModelIdentity uses bareModel as initial modelKey + resolves cost', () => {
  const id = telemetryModelIdentity(fakeBinding as never, 'gpt-4')
  expect(id.model).toBe('gpt-4')
  expect(id.upstream).toBe('openai-prod')
  expect(id.modelKey).toBe('gpt-4')
  expect(id.cost).toEqual({ inputPerM: 1, outputPerM: 2 })
})

test('telemetryModelIdentity tolerates unknown modelKey (cost null)', () => {
  const id = telemetryModelIdentity(fakeBinding as never, 'gpt-unknown')
  expect(id.cost).toBeNull()
})

test('upstreamPerformanceContext mirrors telemetryCtx + binding', () => {
  const perf = upstreamPerformanceContext(ctx(), fakeBinding as never, 'gpt-4')
  expect(perf.keyId).toBe('k1')
  expect(perf.model).toBe('gpt-4')
  expect(perf.upstream).toBe('openai-prod')
  expect(perf.modelKey).toBe('gpt-4')
  expect(perf.stream).toBe(true)
  expect(perf.runtimeLocation).toBe('bun')
})
```

Run: `cd vnext && bun test packages/gateway/tests/chat-flow/shared/attempt-helpers.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts
/**
 * Pure helpers for constructing telemetry payloads inside `attempt.ts`.
 * Kept free of I/O so unit tests can drive them with stub bindings.
 */
import {
  eventResult,
  parseTargetStreamFrames,
  type EventResult,
  type PerformanceTelemetryContext,
  type ProtocolFrame,
  type TelemetryModelIdentity,
} from '@vnext/protocols/common'
import type { ProviderResponse } from '@vnext/provider'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'
import { withUpstreamTelemetry } from './upstream-telemetry.ts'

export interface AttemptBindingShape {
  readonly upstream: { readonly name: string }
  readonly upstreamModel: { readonly id: string }
  readonly provider: {
    readonly getPricingForModelKey: (k: string) => unknown | null
  }
}

export function telemetryModelIdentity(
  binding: AttemptBindingShape,
  modelKey: string,
): TelemetryModelIdentity {
  return {
    model: binding.upstreamModel.id,
    upstream: binding.upstream.name,
    modelKey,
    cost: (binding.provider.getPricingForModelKey(modelKey) ?? null) as TelemetryModelIdentity['cost'],
  }
}

export function upstreamPerformanceContext(
  telemetryCtx: TelemetryRequestContext,
  binding: AttemptBindingShape,
  modelKey: string,
): PerformanceTelemetryContext {
  return {
    keyId: telemetryCtx.apiKeyId,
    model: binding.upstreamModel.id,
    upstream: binding.upstream.name,
    modelKey,
    stream: telemetryCtx.isStreaming,
    runtimeLocation: telemetryCtx.runtimeLocation,
  }
}

export interface ProviderResponseToExecuteResultArgs<T> {
  readonly providerResp: ProviderResponse
  readonly binding: AttemptBindingShape
  readonly telemetryCtx: TelemetryRequestContext
  readonly bareModel: string
  readonly toEvents: (body: ReadableStream<Uint8Array>) => AsyncIterable<ProtocolFrame<T>>
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
  readonly abortSignal?: AbortSignal
}

/**
 * 2xx provider response → `EventResult` populated with telemetry channel.
 * Wraps the body via the rewritten `withUpstreamTelemetry` so a `finalMetadata`
 * promise (for downstream interceptors that DON'T replace the stream — but
 * may want to read the terminal-frame state) is exposed; pass-through callers
 * leave `finalMetadata` undefined unless they explicitly intend replacement
 * semantics.
 */
export function providerResponseToExecuteResult<T>(
  args: ProviderResponseToExecuteResultArgs<T>,
): EventResult<ProtocolFrame<T>> {
  if (!args.providerResp.body) throw new Error('upstream returned empty body')
  const events = args.toEvents(args.providerResp.body)
  const { events: decorated } = withUpstreamTelemetry(events, {
    abortSignal: args.abortSignal,
    protocol: args.protocol,
  })
  return eventResult(
    decorated,
    telemetryModelIdentity(args.binding, args.bareModel),
    upstreamPerformanceContext(args.telemetryCtx, args.binding, args.bareModel),
    // No finalMetadata: pass-through path. Interceptors that replace the stream
    // construct their own EventResult with their own finalMetadata.
  )
}

export { parseTargetStreamFrames }
```

- [ ] **Step 3: Run test, expect PASS**

Run: `cd vnext && bun test packages/gateway/tests/chat-flow/shared/attempt-helpers.test.ts`

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts \
        vnext/packages/gateway/tests/chat-flow/shared/attempt-helpers.test.ts
git commit -m "feat(gateway/chat-flow): add attempt-helpers (telemetry identity/perf factories) (spec3 part1)"
```

---

## Task 5 — Rewrite `upstream-telemetry.ts` to pure classifier

**Files:**
- Modify (rewrite): `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts`
- Modify: `vnext/packages/gateway/tests/chat-flow/shared/upstream-telemetry.test.ts`

- [ ] **Step 1: Rewrite the test to assert classifier semantics**

```ts
// vnext/packages/gateway/tests/chat-flow/shared/upstream-telemetry.test.ts
import { test, expect } from 'bun:test'
import { withUpstreamTelemetry } from '../../../src/data-plane/chat-flow/shared/upstream-telemetry.ts'
import type { ProtocolFrame } from '@vnext/protocols/common'

async function* gen<T>(items: ProtocolFrame<T>[]): AsyncGenerator<ProtocolFrame<T>> {
  for (const f of items) yield f
}

test('chat_completions: [DONE] is terminal, success', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { choices: [{ delta: { content: 'hi' } }] } },
    { type: 'event', event: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } } },
    { type: 'done' },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'chat_completions' })
  for await (const _ of events) { /* drain */ }
  const md = await finalMetadata
  expect(md.failed).toBe(false)
  expect(md.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2 })
})

test('messages: error event marks failed', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { type: 'error', message: 'boom' } },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'messages' })
  for await (const _ of events) { /* drain */ }
  const md = await finalMetadata
  expect(md.failed).toBe(true)
})

test('responses: response.completed terminal-success', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { type: 'response.created', response: { model: 'gpt-4' } } },
    { type: 'event', event: { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } } },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'responses' })
  for await (const _ of events) { /* drain */ }
  const md = await finalMetadata
  expect(md.failed).toBe(false)
  expect(md.usage).toMatchObject({ input_tokens: 3, output_tokens: 4 })
})

test('eof without terminal frame → failed=true', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { choices: [{ delta: { content: 'partial' } }] } },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'chat_completions' })
  for await (const _ of events) { /* drain */ }
  const md = await finalMetadata
  expect(md.failed).toBe(true)
})
```

Run: `cd vnext && bun test packages/gateway/tests/chat-flow/shared/upstream-telemetry.test.ts`
Expected: FAIL — old recorder shape doesn't match new contract.

- [ ] **Step 2: Rewrite the module**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts
/**
 * Pure terminal-frame classifier. Wraps an upstream protocol-frame stream
 * and exposes a `finalMetadata` promise that resolves to the terminal-state
 * snapshot (`failed`, accumulated `usage`) once the stream drains.
 *
 * No callbacks, no I/O. Replaces the Spec-2 recorder interface.
 */
import type { ProtocolFrame } from '@vnext/protocols/common'

export interface UpstreamTelemetryCtx {
  readonly abortSignal?: AbortSignal
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
}

export interface UpstreamTerminalState {
  readonly failed: boolean
  readonly usage: unknown
  readonly firstByteLatencyMs: number | null
  readonly totalLatencyMs: number
}

export interface UpstreamTelemetryOutput<T> {
  readonly events: AsyncGenerator<ProtocolFrame<T>>
  readonly finalMetadata: Promise<UpstreamTerminalState>
}

const isTerminalFrame = <T>(
  frame: ProtocolFrame<T>,
  protocol: UpstreamTelemetryCtx['protocol'],
): { terminal: boolean; failed: boolean } => {
  if (frame.type === 'done') return { terminal: protocol === 'chat_completions', failed: false }
  const ev = frame.event as Record<string, unknown>
  if (protocol === 'messages') {
    if (ev.type === 'message_stop') return { terminal: true, failed: false }
    if (ev.type === 'error') return { terminal: true, failed: true }
  }
  if (protocol === 'responses') {
    if (ev.type === 'response.completed' || ev.type === 'response.incomplete') return { terminal: true, failed: false }
    if (ev.type === 'response.failed') return { terminal: true, failed: true }
  }
  return { terminal: false, failed: false }
}

const extractUsage = <T>(frame: ProtocolFrame<T>): unknown => {
  if (frame.type !== 'event') return null
  const ev = frame.event as { usage?: unknown; choices?: unknown[]; response?: { usage?: unknown }; message?: { usage?: unknown } }
  if (Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage) return ev.usage
  if (ev.response?.usage) return ev.response.usage
  if (ev.message?.usage) return ev.message.usage
  if (ev.usage && (ev.type === 'message_delta' || ev.type === 'message_start')) return ev.usage
  return null
}

export function withUpstreamTelemetry<T>(
  stream: AsyncIterable<ProtocolFrame<T>>,
  ctx: UpstreamTelemetryCtx,
): UpstreamTelemetryOutput<T> {
  let resolveMeta!: (s: UpstreamTerminalState) => void
  const finalMetadata = new Promise<UpstreamTerminalState>((res) => { resolveMeta = res })
  const startedAt = performance.now()

  async function* run(): AsyncGenerator<ProtocolFrame<T>> {
    let firstByteLatencyMs: number | null = null
    let accumulatedUsage: unknown = null
    let resolved = false
    const settle = (failed: boolean): void => {
      if (resolved) return
      resolved = true
      resolveMeta({
        failed,
        usage: accumulatedUsage,
        firstByteLatencyMs,
        totalLatencyMs: performance.now() - startedAt,
      })
    }
    try {
      for await (const frame of stream) {
        if (firstByteLatencyMs === null) firstByteLatencyMs = performance.now() - startedAt
        const usage = extractUsage(frame)
        if (usage) accumulatedUsage = usage
        const { terminal, failed } = isTerminalFrame(frame, ctx.protocol)
        yield frame
        if (terminal) { settle(failed); return }
      }
      settle(ctx.abortSignal?.aborted ? true : true) // eof without terminal = failed
    } catch (err) {
      settle(true)
      throw err
    }
  }

  return { events: run(), finalMetadata }
}
```

- [ ] **Step 3: Run test, expect PASS**

Run: `cd vnext && bun test packages/gateway/tests/chat-flow/shared/upstream-telemetry.test.ts`

- [ ] **Step 4: Update the lone production caller (chat-completions/attempt.ts)**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts
// Replace the existing withUpstreamTelemetry call (around line 132-137):
const { events: decorated } = withUpstreamTelemetry(stream, {
  abortSignal: args.ctx.downstreamAbortSignal,
  protocol: 'chat_completions',
})
return eventResult(
  decorated,
  // FIXME(spec3-part2): real identity from telemetryModelIdentity(sel.binding, sel.bareModel)
  { model: '<unknown>', upstream: '<unknown>', modelKey: '<unknown>', cost: null },
)
```

Drop the `recordFirstByteLatency: () => {}` etc. stubs and the `UpstreamTelemetryRecorder` import.

- [ ] **Step 5: Typecheck + full gateway test run**

Run: `cd vnext && bun x tsc --noEmit && bun test packages/gateway/tests`
Expected: typecheck clean; gateway tests still match baseline (the chat-completions migration in Part 2 will replace the FIXME).

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts \
        vnext/packages/gateway/tests/chat-flow/shared/upstream-telemetry.test.ts \
        vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts
git commit -m "refactor(gateway/chat-flow): rewrite withUpstreamTelemetry as pure classifier (spec3 part1)"
```

---

## Task 6 — Create `respond-telemetry.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts`
- Test: `vnext/packages/gateway/tests/chat-flow/shared/respond-telemetry.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// vnext/packages/gateway/tests/chat-flow/shared/respond-telemetry.test.ts
import { test, expect, beforeEach } from 'bun:test'
import { setupTestPlatform } from '../../_setup-platform.ts'
import {
  SourceStreamState,
  eventResultMetadata,
  recordUsage,
  recordPerformance,
} from '../../../src/data-plane/chat-flow/shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../../../src/data-plane/chat-flow/shared/telemetry-ctx.ts'
import type { EventResult, TelemetryModelIdentity, PerformanceTelemetryContext } from '@vnext/protocols/common'

const identity = (modelKey = 'gpt-4'): TelemetryModelIdentity => ({
  model: 'gpt-4', upstream: 'openai-prod', modelKey, cost: null,
})
const perf = (): PerformanceTelemetryContext => ({
  keyId: 'k1', model: 'gpt-4', upstream: 'openai-prod', modelKey: 'gpt-4',
  stream: true, runtimeLocation: 'bun',
})
const ctx: TelemetryRequestContext = {
  apiKeyId: 'k1', userAgent: null, requestId: 'r1',
  isStreaming: true, runtimeLocation: 'bun', requestStartedAt: Date.now(),
}

beforeEach(() => setupTestPlatform())

test('eventResultMetadata prefers finalMetadata when present', async () => {
  const replaced: EventResult<unknown> = {
    type: 'events',
    events: (async function*() {})(),
    modelIdentity: identity('gpt-4'),
    finalMetadata: Promise.resolve({ modelIdentity: identity('gpt-4-turbo') }),
  }
  const md = await eventResultMetadata(replaced)
  expect(md.modelIdentity.modelKey).toBe('gpt-4-turbo')
})

test('eventResultMetadata falls back to result.modelIdentity + performance', async () => {
  const r: EventResult<unknown> = {
    type: 'events',
    events: (async function*() {})(),
    modelIdentity: identity('gpt-4'),
    performance: perf(),
  }
  const md = await eventResultMetadata(r)
  expect(md.modelIdentity.modelKey).toBe('gpt-4')
  expect(md.performance?.keyId).toBe('k1')
})

test('SourceStreamState.rememberModelKey accepts only non-empty differing values', () => {
  const s = new SourceStreamState('gpt-4')
  expect(s.modelKey).toBe('gpt-4')
  s.rememberModelKey('')
  expect(s.modelKey).toBe('gpt-4')
  s.rememberModelKey('gpt-4')
  expect(s.modelKey).toBe('gpt-4')
  s.rememberModelKey('gpt-4-turbo-2025')
  expect(s.modelKey).toBe('gpt-4-turbo-2025')
})

test('SourceStreamState accumulates usage via applyStreamEvent', () => {
  const s = new SourceStreamState('gpt-4')
  s.rememberUsage({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })
  expect(s.usage.tokens.input).toBe(1)
  expect(s.usage.tokens.output).toBe(2)
})

test('recordUsage writes one row when usage non-zero, zero when usage empty', async () => {
  const { repo } = setupTestPlatform()
  const calls: unknown[] = []
  const stub = { ...repo, usage: { record: async (row: unknown) => { calls.push(row) } }, apiKeys: { touchLastUsed: async () => {} } }
  // initRepo to stub: in actual implementation respond-telemetry uses getRepo()
  // Test pattern shown for clarity; consult repo accessor in implementation.
  await recordUsage(ctx, identity('gpt-4'), { input: 0, output: 0 } as never, stub as never)
  expect(calls.length).toBe(0)
  await recordUsage(ctx, identity('gpt-4'), { input: 5, output: 7 } as never, stub as never)
  expect(calls.length).toBe(1)
})

test('recordPerformance no-ops when performance undefined', async () => {
  const calls: unknown[] = []
  const stub = { upstreams: { recordPerformance: async (r: unknown) => { calls.push(r) } } }
  await recordPerformance(ctx, undefined, false, stub as never)
  expect(calls.length).toBe(0)
})

test('recordPerformance writes one row with failed flag', async () => {
  const calls: { failed: boolean }[] = []
  const stub = { upstreams: { recordPerformance: async (r: { failed: boolean }) => { calls.push(r) } } }
  await recordPerformance(ctx, perf(), true, stub as never)
  expect(calls).toHaveLength(1)
  expect(calls[0].failed).toBe(true)
})
```

Run: `cd vnext && bun test packages/gateway/tests/chat-flow/shared/respond-telemetry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement** (consult `copilot-gateway/packages/gateway/src/data-plane/shared/telemetry/{performance,usage}.ts` for the legacy row shape — copy field-for-field)

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts
/**
 * Centralised telemetry persistence for the data-plane chat-flow.
 * `respond.ts` of every endpoint funnels its `EventResult` through these
 * helpers exactly once, replacing the legacy `runConversationAttempt` triple.
 */
import { logger } from '../../../shared/logger.ts'
import { getRepo } from '../../../shared/repo/index.ts'
import { applyStreamEvent, extractFromJson, type UsageInfo } from '../../../shared/observability/usage-extractor.ts'
import type {
  EventResult,
  EventResultMetadata,
  ExecuteResult,
  PerformanceTelemetryContext,
  TelemetryModelIdentity,
} from '@vnext/protocols/common'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'
import type { Repo, TokenUsage } from '../../../shared/repo/types.ts'

/**
 * Resolve the metadata to persist. Prefers `finalMetadata` (interceptor-replaced
 * streams) over `result.modelIdentity` + `result.performance` (pass-through).
 */
export async function eventResultMetadata<T>(
  result: EventResult<T>,
): Promise<EventResultMetadata> {
  if (result.finalMetadata) {
    const md = await result.finalMetadata
    // Drift detection: a normal pass-through should NOT set finalMetadata.
    // We can't enforce by type; emit a warn so dev catches accidental sets.
    if (!('__interceptorReplaced' in (result as object))) {
      logger.warn('eventResultMetadata: finalMetadata set without __interceptorReplaced provenance flag')
    }
    return md
  }
  return { modelIdentity: result.modelIdentity, performance: result.performance }
}

export class SourceStreamState {
  modelKey: string
  failed = false
  usage: UsageInfo

  constructor(initialModelKey: string) {
    this.modelKey = initialModelKey
    this.usage = { model: undefined, tokens: {} }
  }

  rememberUsage(parsedEvent: unknown): void {
    applyStreamEvent(parsedEvent, this.usage)
  }

  rememberUsageFromJson(json: unknown): void {
    const u = extractFromJson(json)
    if (u) this.usage = u
  }

  rememberModelKey(key: unknown): void {
    if (typeof key !== 'string') return
    if (key.length === 0) return
    if (key === this.modelKey) return
    this.modelKey = key
  }

  failedAfter(): void {
    this.failed = true
  }
}

function nonZeroUsage(tokens: TokenUsage): boolean {
  for (const k in tokens) {
    if ((tokens as Record<string, number | undefined>)[k]) return true
  }
  return false
}

/**
 * Persist a usage row keyed by `modelIdentity` + `telemetryCtx.apiKeyId`.
 * No-ops when usage is empty (spec §6.2 — failed paths write zero usage rows).
 * Also calls `repo.apiKeys.touchLastUsed` to mirror legacy dispatch behavior.
 */
export async function recordUsage(
  telemetryCtx: TelemetryRequestContext,
  modelIdentity: TelemetryModelIdentity,
  tokens: TokenUsage,
  repo: Repo = getRepo(),
): Promise<void> {
  if (!nonZeroUsage(tokens)) return
  await repo.usage.record({
    apiKeyId: telemetryCtx.apiKeyId,
    upstream: modelIdentity.upstream,
    model: modelIdentity.model,
    modelKey: modelIdentity.modelKey,
    tokens,
    pricing: modelIdentity.cost ?? undefined,
    requestId: telemetryCtx.requestId,
    userAgent: telemetryCtx.userAgent ?? undefined,
    streamed: telemetryCtx.isStreaming,
    occurredAt: new Date().toISOString(),
  } as Parameters<Repo['usage']['record']>[0])
  await repo.apiKeys.touchLastUsed(telemetryCtx.apiKeyId)
}

/**
 * Persist a performance row. No-op when `performance` is undefined (e.g.
 * `internal-error` raised before binding selection — model-not-found etc.).
 */
export async function recordPerformance(
  telemetryCtx: TelemetryRequestContext,
  performance: PerformanceTelemetryContext | undefined,
  failed: boolean,
  repo: Repo = getRepo(),
): Promise<void> {
  if (!performance) {
    logger.debug?.('recordPerformance: skipping (no performance context — pre-binding error)')
    return
  }
  const durationMs = Date.now() - telemetryCtx.requestStartedAt
  await repo.upstreams.recordPerformance({
    apiKeyId: performance.keyId,
    upstream: performance.upstream,
    model: performance.model,
    modelKey: performance.modelKey,
    stream: performance.stream,
    runtimeLocation: performance.runtimeLocation,
    failed,
    durationMs,
    occurredAt: new Date().toISOString(),
  } as Parameters<Repo['upstreams']['recordPerformance']>[0])
}

export type { EventResult, ExecuteResult }
```

NOTE: real shapes for `repo.usage.record` and `repo.upstreams.recordPerformance` MUST match the existing Repo interface — read `vnext/packages/gateway/src/shared/repo/types.ts` and copy the row literals from the legacy `usage-tracker.ts` and `data-plane/observability/attempts/conversation-attempt.ts` so the wire format is identical. This task includes a sub-step to verify.

- [ ] **Step 3: Run test, expect PASS**

Run: `cd vnext && bun test packages/gateway/tests/chat-flow/shared/respond-telemetry.test.ts`

- [ ] **Step 4: Diff legacy row shapes vs new helpers**

```bash
# Compare row literals
grep -A 20 "usage.record\|recordPerformance" \
  vnext/packages/gateway/src/shared/observability/usage-tracker.ts \
  vnext/packages/gateway/src/data-plane/observability/attempts/conversation-attempt.ts
```

Confirm the new `recordUsage` and `recordPerformance` payloads are field-equivalent. Adjust if any field is missing.

- [ ] **Step 5: Typecheck + full test pass**

Run: `cd vnext && bun x tsc --noEmit && bun test packages/gateway/tests`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts \
        vnext/packages/gateway/tests/chat-flow/shared/respond-telemetry.test.ts
git commit -m "feat(gateway/chat-flow): add respond-telemetry helpers + SourceStreamState (spec3 part1)"
```

---

## Task 7 — Final verification

- [ ] **Step 1: Typecheck**

Run: `cd vnext && bun x tsc --noEmit`
Expected: clean across `gateway`, `protocols`, `interceptor`, `provider*`.

- [ ] **Step 2: Full test pass**

Run: `cd vnext && bun test`
Expected: same baseline as before this part. The 6 preexisting dispatch-related failures are still present (will be fixed in Part 4). No NEW failures.

- [ ] **Step 3: Confirm acceptance gate**

- [ ] All new helpers have unit tests (Tasks 4, 5, 6).
- [ ] No endpoint behaviour changed — chat-completions/attempt.ts still produces an EventResult with a stub identity (FIXME comment).
- [ ] `dispatch.ts`, `conversation-attempt.ts`, `usage-tracker.ts` are still on disk; not touched.

- [ ] **Step 4: Tag commit message marker**

Verify `git log --oneline | head -10` shows the commits from Tasks 1–6 with the `(spec3 part1)` suffix.

---

## Acceptance criteria (Part 1)

- `bun x tsc --noEmit` clean across gateway/protocols/interceptor/provider*.
- New unit tests pass: `runtime-location.test.ts`, `result.test.ts`, `attempt-helpers.test.ts`, `upstream-telemetry.test.ts` (rewritten), `respond-telemetry.test.ts`.
- Existing test baseline preserved (no new regressions; 6 preexisting dispatch failures still present).
- No endpoint migration — `dispatch.ts` and friends still own real persistence.
- `withUpstreamTelemetry` recorder argument is gone everywhere (only call site is `chat-completions/attempt.ts`, which now drops the recorder and stubs `modelIdentity`).
