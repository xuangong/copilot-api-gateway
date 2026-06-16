# Spec 6 — Part 1: Foundation (types, errors, helper)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan part-by-part. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land all type/error scaffolding and the `traverseTranslation` helper without rewiring any attempt module. After Part 1, `bun typecheck` is clean and the helper has unit-test coverage, but `selectBinding` cross-protocol responses still 501. Zero behavior change for existing traffic.

**Architecture:** Additive optional fields on `EventResult`/`InternalErrorResult`/`TelemetryModelIdentity`; new `TranslatorValidationError` class plus a 10-pair audit; new `traverseTranslation` helper + `pickHubAttempt` dispatcher; additive optional fields on the four `*AttemptArgs` types.

**Tech Stack:** TypeScript, Bun, Bun test runner.

**Pre-flight:** `bun typecheck` clean against vNext HEAD before starting.

---

## Task 1: Extend `result.ts` types

**Spec ref:** §3.6, §3.8

**Files:**
- Modify: `vnext/packages/protocols/src/common/result.ts`
- Test: `vnext/packages/protocols/src/common/result.test.ts` (extend existing or create)

- [ ] **Step 1: Write the failing test** for new factory params

```ts
// result.test.ts (append)
import { test, expect } from 'bun:test'
import { eventResult, internalErrorResult } from './result.ts'

test('eventResult accepts translateBody', () => {
  async function* gen() { yield 1 as never }
  const id = { model: 'm', upstream: 'u', modelKey: 'k', cost: null }
  const tb = (j: unknown) => ({ ok: true, j })
  const r = eventResult(gen(), id, undefined, undefined, tb)
  expect(r.translateBody).toBe(tb)
})

test('internalErrorResult accepts reason', () => {
  const r = internalErrorResult(400, new Error('bad'), undefined, 'translator-validation')
  expect(r.reason).toBe('translator-validation')
})

test('TelemetryModelIdentity accepts translatorPair', () => {
  const id = {
    model: 'm', upstream: 'u', modelKey: 'k', cost: null,
    translatorPair: { source: 'chat_completions' as const, hub: 'responses' as const },
  }
  expect(id.translatorPair?.hub).toBe('responses')
})
```

- [ ] **Step 2: Run** `bun test vnext/packages/protocols/src/common/result.test.ts`

Expected: FAIL (translateBody / reason / translatorPair don't exist yet, or factories reject extra args).

- [ ] **Step 3: Edit `result.ts`** — add fields and extend factories.

```ts
// at top, alongside existing imports:
import type { Protocol } from './index.ts'
// (or wherever `Protocol = 'chat_completions' | 'messages' | 'responses' | 'gemini'` is exported;
// if not yet exported from index, add `export type { Protocol } from './protocols.ts'` first.)

export interface TelemetryModelIdentity {
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  readonly cost: ModelPricing | null
  readonly translatorPair?: {
    readonly source: Protocol
    readonly hub: Protocol
  }
}

export interface TranslateBodyContext {
  readonly signal?: AbortSignal
  readonly fallbackMaxOutputTokens?: number
  readonly model?: string
}

export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
  readonly finalMetadata?: Promise<EventResultMetadata>
  readonly translateBody?: (
    hubJson: unknown,
    ctx: TranslateBodyContext,
  ) => unknown | Promise<unknown>
}

export interface InternalErrorResult {
  readonly type: 'internal-error'
  readonly status: number
  readonly error: Error
  readonly performance?: PerformanceTelemetryContext
  readonly reason?: string
}

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
  translateBody?: EventResult<T>['translateBody'],
): EventResult<T> => ({
  type: 'events',
  events,
  modelIdentity,
  performance,
  finalMetadata,
  translateBody,
})

export const internalErrorResult = (
  status: number,
  error: Error,
  performance?: PerformanceTelemetryContext,
  reason?: string,
): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  performance,
  reason,
})
```

- [ ] **Step 4: Run** `bun test vnext/packages/protocols/src/common/result.test.ts`

Expected: PASS.

- [ ] **Step 5: Run** `bun typecheck`

Expected: PASS — additive optional fields don't break existing call sites.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/protocols/src/common/result.ts vnext/packages/protocols/src/common/result.test.ts
git commit -m "feat(protocols): extend ExecuteResult with translateBody/reason/translatorPair"
```

---

## Task 2: Add `TranslatorValidationError` + audit 10 translator pairs

**Spec ref:** §3.9

**Files:**
- Create: `vnext/packages/translate/src/errors.ts`
- Create: `vnext/packages/translate/src/errors.test.ts`
- Modify: 10 pairs under `vnext/packages/translate/src/<pair>/{request,events,body}.ts`

- [ ] **Step 1: Write the failing test** for the new error class

```ts
// vnext/packages/translate/src/errors.test.ts
import { test, expect } from 'bun:test'
import { TranslatorValidationError } from './errors.ts'

test('TranslatorValidationError carries kind tag and field', () => {
  const e = new TranslatorValidationError('bad payload', 'messages[0].content')
  expect(e).toBeInstanceOf(Error)
  expect(e.name).toBe('TranslatorValidationError')
  expect(e.kind).toBe('translator-validation')
  expect(e.field).toBe('messages[0].content')
})

test('TranslatorValidationError detectable via instanceof across module boundaries', async () => {
  const mod = await import('./errors.ts')
  const e = new mod.TranslatorValidationError('x')
  expect(e instanceof TranslatorValidationError).toBe(true)
})
```

- [ ] **Step 2: Run** `bun test vnext/packages/translate/src/errors.test.ts`

Expected: FAIL (module does not exist).

- [ ] **Step 3: Create `errors.ts`**

```ts
// vnext/packages/translate/src/errors.ts
export class TranslatorValidationError extends Error {
  readonly kind = 'translator-validation' as const
  constructor(message: string, public readonly field?: string) {
    super(message)
    this.name = 'TranslatorValidationError'
  }
}
```

- [ ] **Step 4: Re-export from translate package index**

```ts
// vnext/packages/translate/src/index.ts (append)
export { TranslatorValidationError } from './errors.ts'
```

- [ ] **Step 5: Run** `bun test vnext/packages/translate/src/errors.test.ts`

Expected: PASS.

- [ ] **Step 6: Audit 10 pairs**

For each directory under `vnext/packages/translate/src/`:
- `chat-completions-to-messages/`
- `chat-completions-to-responses/`
- `messages-to-chat-completions/`
- `messages-to-responses/`
- `responses-to-chat-completions/`
- `responses-to-messages/`
- `gemini-to-chat-completions/`
- `gemini-to-messages/`
- `gemini-to-responses/`
- `responses-to-gemini/` (if present; otherwise note count is 9)

In each pair, scan `request.ts`, `events.ts`, `body.ts` for `throw new Error(...)` calls. For throws caused by **client payload shape problems** (missing required field, bad enum value, wrong type), replace with `throw new TranslatorValidationError(message, fieldPath?)`. Leave gateway-internal invariants (e.g., "unexpected upstream frame", "translator state corrupted") as plain `Error`.

Heuristic: if the error message is something a client could fix by sending a different request body, it's validation. If it's something only a gateway maintainer could fix, it's internal.

- [ ] **Step 7: For one representative pair, add an audit unit test**

Pick `chat-completions-to-responses` (highest-traffic pair). Add to its existing `request.test.ts`:

```ts
import { TranslatorValidationError } from '../errors.ts'
test('translateRequest throws TranslatorValidationError on missing model', async () => {
  await expect(
    translator.translateRequest({} as never, { signal: new AbortController().signal }),
  ).rejects.toBeInstanceOf(TranslatorValidationError)
})
```

(Adjust assertion to whatever validation actually fires for that pair.)

- [ ] **Step 8: Run** `bun test vnext/packages/translate/`

Expected: PASS, including the new audit test.

- [ ] **Step 9: Run** `bun typecheck`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add vnext/packages/translate/src/
git commit -m "feat(translate): add TranslatorValidationError; audit 10 pairs for client-shape throws"
```

---

## Task 3: Add `pickHubAttempt` dispatcher

**Spec ref:** §3.4

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts`

We split this off from Task 4 because `traverseTranslation` takes the inner attempt as a function reference, not an import — the dispatcher belongs in a separate module so each source attempt picks the hub at the call site without dragging the helper into a 4-way import cycle.

- [ ] **Step 1: Create the dispatcher**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts
/**
 * Returns the hub attempt module for a given protocol. Used by source attempts
 * to construct the `innerAttempt` callback passed to `traverseTranslation`.
 *
 * Imports the four attempt modules at top level — relies on existing ESM cyclic
 * import safety (see gemini/attempt.ts ↔ messages/responses attempt.ts).
 */
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts'
import { messagesAttempt } from '../messages/attempt.ts'
import { responsesAttempt } from '../responses/attempt.ts'
import type { Protocol } from '@vnext/protocols/common'

export type HubAttemptProtocol = Exclude<Protocol, 'gemini'>

export function pickHubAttempt(p: HubAttemptProtocol) {
  switch (p) {
    case 'chat_completions':
      return chatCompletionsAttempt
    case 'messages':
      return messagesAttempt
    case 'responses':
      return responsesAttempt
    default: {
      const _exhaustive: never = p
      throw new Error(`no hub attempt for protocol: ${String(_exhaustive)}`)
    }
  }
}
```

- [ ] **Step 2: Run** `bun typecheck`

Expected: PASS. (No tests for a thin switch dispatcher; correctness covered by Part 2/3/4 integration tests.)

- [ ] **Step 3: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts
git commit -m "feat(gateway): add pickHubAttempt hub dispatcher"
```

---

## Task 4: Implement `traverseTranslation` helper

**Spec ref:** §3.3

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts`

- [ ] **Step 1: Write the helper signature + happy-path test**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts
import { test, expect } from 'bun:test'
import { traverseTranslation } from './traverse-translation.ts'
import { TranslatorValidationError } from '@vnext/translate'
import { eventResult, internalErrorResult } from '@vnext/protocols/common'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'

const fakeTelemetryCtx = {} as never

const fakeIdentity = { model: 'm', upstream: 'u', modelKey: 'k', cost: null }

function fakeTranslator(overrides: Partial<PairTranslator> = {}): PairTranslator {
  return {
    translateRequest: async (p) => p,
    translateEvents: async function* (events) { for await (const e of events) yield e as never },
    translateBody: (j) => j,
    ...overrides,
  } as PairTranslator
}

test('happy path: stamps translatorPair and forwards translateBody', async () => {
  async function* hubEvents() { yield { kind: 'hub-evt' } as never }
  const innerResult = eventResult(hubEvents(), fakeIdentity)
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => innerResult,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('events')
  if (result.type !== 'events') throw new Error('unreachable')
  expect(result.modelIdentity.translatorPair).toEqual({
    source: 'chat_completions',
    hub: 'responses',
  })
  expect(result.translateBody).toBeDefined()
})

test('TranslatorValidationError → 400 with reason translator-validation', async () => {
  const result = await traverseTranslation({
    sourcePayload: {},
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateRequest: async () => { throw new TranslatorValidationError('missing model') },
    }),
    innerAttempt: async () => { throw new Error('should not be called') },
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('internal-error')
  if (result.type !== 'internal-error') throw new Error('unreachable')
  expect(result.status).toBe(400)
  expect(result.reason).toBe('translator-validation')
})

test('generic translator throw → 500 with reason translator-internal', async () => {
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateRequest: async () => { throw new Error('boom') },
    }),
    innerAttempt: async () => { throw new Error('should not be called') },
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('internal-error')
  if (result.type !== 'internal-error') throw new Error('unreachable')
  expect(result.status).toBe(500)
  expect(result.reason).toBe('translator-internal')
})

test('upstream-error pass-through unchanged', async () => {
  const upstream = {
    type: 'upstream-error' as const,
    status: 502,
    headers: new Headers(),
    body: new Uint8Array(),
  }
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => upstream,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result).toBe(upstream)
})

test('internal-error reason is prefixed with via-translator', async () => {
  const inner = internalErrorResult(500, new Error('inner'), undefined, 'inner-cause')
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => inner,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('internal-error')
  if (result.type !== 'internal-error') throw new Error('unreachable')
  expect(result.reason).toBe('via-translator:chat_completions→responses:inner-cause')
})

test('translateEvents mid-stream error becomes terminal source-error frame, does not throw', async () => {
  async function* hubEvents() {
    yield { kind: 'hub-evt' } as never
    throw new Error('mid-stream failure')
  }
  const innerResult = eventResult(hubEvents(), fakeIdentity)
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateEvents: async function* (events) {
        for await (const e of events) yield e as never
      },
    }),
    innerAttempt: async () => innerResult,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('events')
  if (result.type !== 'events') throw new Error('unreachable')
  // Iterator must complete without throwing — wrapper swallows + emits terminal error frame.
  const collected: unknown[] = []
  for await (const f of result.events) collected.push(f)
  expect(collected.length).toBeGreaterThan(0)
})

test('header inheritance: passes inheritedHeaders into innerAttempt', async () => {
  let captured: Record<string, string> | undefined
  async function* hubEvents() { yield { kind: 'hub-evt' } as never }
  await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async (innerArgs) => {
      captured = innerArgs.inheritedHeaders
      return eventResult(hubEvents(), fakeIdentity)
    },
    inheritedHeaders: { 'x-trace-id': 'abc' },
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(captured).toEqual({ 'x-trace-id': 'abc' })
})
```

- [ ] **Step 2: Run** `bun test vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts`

Expected: FAIL (module not yet implemented).

- [ ] **Step 3: Implement the helper**

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts
/**
 * Cross-protocol attempt traversal. Calls the source translator to produce a
 * hub-protocol payload, invokes the hub attempt, then wraps the returned event
 * stream with the translator's event mapper so the source protocol sees its
 * native frames. See spec §3.3.
 */
import { TranslatorValidationError } from '@vnext/translate'
import {
  eventResult,
  internalErrorResult,
  type EventResult,
  type ExecuteResult,
  type Protocol,
  type ProtocolFrame,
} from '@vnext/protocols/common'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

export interface InnerAttemptArgs {
  payload: Record<string, unknown>
  auth: unknown
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  snapshotMode: 'none'
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
}

export interface TraverseTranslationArgs<HubFrame, SourceFrame> {
  sourcePayload: Record<string, unknown>
  sourceProtocol: Protocol
  hubProtocol: Protocol
  translator: PairTranslator
  innerAttempt: (args: InnerAttemptArgs) => Promise<ExecuteResult<ProtocolFrame<HubFrame>>>
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  auth: unknown
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
  fallbackMaxOutputTokens?: number
  model?: string
}

export async function traverseTranslation<HubFrame, SourceFrame>(
  args: TraverseTranslationArgs<HubFrame, SourceFrame>,
): Promise<ExecuteResult<ProtocolFrame<SourceFrame>>> {
  let hubPayload: Record<string, unknown>
  try {
    hubPayload = (await args.translator.translateRequest(args.sourcePayload, {
      signal: args.signal ?? new AbortController().signal,
      fallbackMaxOutputTokens: args.fallbackMaxOutputTokens,
      model: args.model,
    })) as Record<string, unknown>
  } catch (err) {
    if (err instanceof TranslatorValidationError) {
      return internalErrorResult(400, err, undefined, 'translator-validation')
    }
    return internalErrorResult(
      500,
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      'translator-internal',
    )
  }

  const inner = await args.innerAttempt({
    payload: hubPayload,
    auth: args.auth,
    inheritedHeaders: args.inheritedHeaders,
    inheritedTelemetryCtx: args.inheritedTelemetryCtx,
    snapshotMode: 'none',
    requestId: args.requestId,
    userAgent: args.userAgent,
    signal: args.signal,
  })

  if (inner.type === 'upstream-error') return inner
  if (inner.type === 'internal-error') {
    const prefix = `via-translator:${args.sourceProtocol}→${args.hubProtocol}`
    const reason = inner.reason ? `${prefix}:${inner.reason}` : prefix
    return { ...inner, reason }
  }

  // events: wrap with translator.translateEvents and protect against mid-stream throws
  async function* safeWrap(): AsyncGenerator<ProtocolFrame<SourceFrame>> {
    try {
      const translated = args.translator.translateEvents(inner.events as never, {
        signal: args.signal ?? new AbortController().signal,
        fallbackMaxOutputTokens: args.fallbackMaxOutputTokens,
        model: args.model,
      }) as AsyncIterable<ProtocolFrame<SourceFrame>>
      for await (const frame of translated) yield frame
    } catch (err) {
      // Emit a terminal source-protocol error frame instead of throwing.
      // Shape is intentionally generic — `withUpstreamTelemetry` consumers downstream
      // tolerate unknown frame kinds; consumers that need a specific shape (e.g.
      // SSE encoders) sniff `kind` and ignore.
      yield {
        kind: 'translator-error',
        protocol: args.sourceProtocol,
        error: err instanceof Error ? err.message : String(err),
      } as never
    }
  }

  const sourceModelIdentity = {
    ...inner.modelIdentity,
    translatorPair: { source: args.sourceProtocol, hub: args.hubProtocol },
  }
  return eventResult(
    safeWrap(),
    sourceModelIdentity,
    inner.performance,
    inner.finalMetadata,
    args.translator.translateBody as EventResult<ProtocolFrame<SourceFrame>>['translateBody'],
  )
}
```

- [ ] **Step 4: Run** `bun test vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts`

Expected: PASS, all 7 cases.

- [ ] **Step 5: Run** `bun typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts
git commit -m "feat(gateway): add traverseTranslation helper for cross-protocol attempt routing"
```

---

## Task 5: Extend `*AttemptArgs` with optional inherited fields

**Spec ref:** §3.5

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts` (interface only)
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts` (interface only)
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts` (interface only)
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts` (interface only)

These are **type-level only** — Part 1 does not consume the new fields. Parts 2-4 add the runtime usage.

- [ ] **Step 1: Edit each `*AttemptArgs` interface** — add two optional fields.

```ts
// chat-completions/attempt.ts → ChatCompletionsAttemptArgs
//   readonly inheritedHeaders?: Record<string, string>
//   readonly snapshotMode?: 'none'

// messages/attempt.ts → MessagesAttemptArgs (same two fields)
// responses/attempt.ts → ResponsesAttemptArgs (same two fields)
// gemini/attempt.ts → GeminiAttemptArgs (same two fields)
```

For each file, locate the `export interface <Proto>AttemptArgs { ... }` block and append:

```ts
  readonly inheritedHeaders?: Record<string, string>
  readonly snapshotMode?: 'none'
```

- [ ] **Step 2: Run** `bun typecheck`

Expected: PASS — additive optional fields don't break existing call sites or tests.

- [ ] **Step 3: Run** `bun test vnext/packages/gateway/`

Expected: PASS — no existing tests touch these fields, so all green.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts
git commit -m "feat(gateway): add inheritedHeaders/snapshotMode optional fields to AttemptArgs"
```

---

## Part 1 exit gate

- [ ] `bun typecheck` clean
- [ ] `bun test vnext/packages/protocols/ vnext/packages/translate/ vnext/packages/gateway/` all green
- [ ] Three 501 sites still present (`grep -rn 'cross-protocol attempts not yet supported' vnext/packages/gateway/` returns 3 lines) — Part 1 is intentionally pre-rewire
- [ ] No behavior change for existing data-plane traffic

Move to Part 2.
