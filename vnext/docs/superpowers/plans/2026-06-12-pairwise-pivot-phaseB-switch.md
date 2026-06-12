# Pairwise Pivot — Phase B: Switch + Delete

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `vnext/docs/superpowers/specs/2026-06-12-pairwise-translation-pivot.md`
**Overview:** `vnext/docs/superpowers/plans/2026-06-12-pairwise-pivot-overview.md`
**Prerequisite:** Phase A green (all 4 X-N stages landed, 42 existing tests + new translator/attempt tests passing).

**Goal:** Single hot moment — rewrite `routes.ts dispatch()` to drive the pairwise pipeline, delete IR + old adapters in the same commit-cluster. After Phase B, `@vnext/protocols/ir` and `apps/gateway/src/data-plane/adapters/` no longer exist.

**Architecture:** Two ordered tasks (cannot run in parallel):
- **X-5** rewrite dispatch to: pick pair → translate request → call provider → translate events. Uses Phase A's `runConversationAttempt` plus the 6 translators.
- **X-6** delete `@vnext/protocols/ir` package, `apps/gateway/src/data-plane/adapters/` directory, `@vnext/translate/contract` package (the old IR-shaped adapter contract). Update workspace TypeScript config.

**Tech Stack:** TypeScript, Bun test, AsyncIterable.

**Hot moment:** X-5's commit is the switch. Until it lands, the gateway runs IR. Once it lands, IR is dead code; X-6 removes it. The 4 IR-dependent tests (listed in §"Expected test losses") will fail starting from X-5 — that is expected and they are deleted in Phase C.

---

## Task 5 (X-5): Dispatch Rewrite — Pairwise Pipeline

**Files:**
- Rewrite: `vnext/apps/gateway/src/data-plane/routes.ts` (currently 371 LOC, will shrink)
- Create: `vnext/apps/gateway/src/data-plane/dispatch/pair-selector.ts`
- Create: `vnext/apps/gateway/src/data-plane/dispatch/pair-selector.test.ts`
- Create: `vnext/apps/gateway/src/data-plane/dispatch/translator-registry.ts`
- Create: `vnext/apps/gateway/src/data-plane/dispatch/translator-registry.test.ts`
- Create: `vnext/apps/gateway/src/data-plane/dispatch/dispatch.test.ts`

**Subject:** Replace IR-pipeline `dispatch()` with a pairwise pipeline. The new flow:

```
client request
  → frontend parse (per source API: messages|chat|responses|gemini)
  → pair selector picks (sourceApi, targetEndpoint) given binding.endpoints
  → translator-registry resolves the pair → translator instance
  → translator.translateRequest(payload, ctx) → upstreamRequest
  → runConversationAttempt(binding, upstreamRequest, …) [Phase A X-4]
  → translator.translateEvents(upstreamEvents, ctx) → frontend events
  → frontend encode (SSE or JSON)
client response
```

**Messages-native fast path:** when `sourceApi === 'messages'` and `targetEndpoint === 'messages'`, skip translator (identity pass-through). Already encoded as a registered "identity" translator entry to keep the dispatch code uniform.

### - [ ] Step 5.1: Write failing test for pair selector

Create `dispatch/pair-selector.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { selectPair } from './pair-selector.ts'
import type { ModelEndpoints } from '@vnext/protocols/common'

test('messages source prefers messages target when available', () => {
  const endpoints: ModelEndpoints = { messages: true, responses: true, chat_completions: true }
  expect(selectPair('messages', endpoints)).toBe('messages')
})

test('messages source falls back to responses then chat', () => {
  expect(selectPair('messages', { responses: true, chat_completions: true })).toBe('responses')
  expect(selectPair('messages', { chat_completions: true })).toBe('chat_completions')
})

test('chat source prefers chat then messages then responses', () => {
  expect(selectPair('chat_completions', { messages: true, chat_completions: true })).toBe('chat_completions')
  expect(selectPair('chat_completions', { messages: true })).toBe('messages')
  expect(selectPair('chat_completions', { responses: true })).toBe('responses')
})

test('responses source prefers responses then messages then chat', () => {
  expect(selectPair('responses', { messages: true, responses: true })).toBe('responses')
  expect(selectPair('responses', { messages: true })).toBe('messages')
  expect(selectPair('responses', { chat_completions: true })).toBe('chat_completions')
})

test('gemini source goes through chat fallback chain (no native gemini upstream yet)', () => {
  expect(selectPair('gemini', { chat_completions: true })).toBe('chat_completions')
  expect(selectPair('gemini', { messages: true })).toBe('messages')
})

test('returns null when no compatible target', () => {
  expect(selectPair('messages', {})).toBeNull()
})
```

### - [ ] Step 5.2: Implement pair selector

Create `dispatch/pair-selector.ts`:

```ts
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'

export type SourceApi = 'messages' | 'chat_completions' | 'responses' | 'gemini'

const PREFERENCE: Record<SourceApi, EndpointKey[]> = {
  messages: ['messages', 'responses', 'chat_completions'],
  chat_completions: ['chat_completions', 'messages', 'responses'],
  responses: ['responses', 'messages', 'chat_completions'],
  gemini: ['chat_completions', 'messages', 'responses'],
}

export function selectPair(source: SourceApi, endpoints: ModelEndpoints): EndpointKey | null {
  for (const target of PREFERENCE[source]) {
    if (endpoints[target]) return target
  }
  return null
}
```

### - [ ] Step 5.3: Run pair selector test

```bash
cd vnext && bun test apps/gateway/src/data-plane/dispatch/pair-selector.test.ts
```
Expected: 6/6 pass.

### - [ ] Step 5.4: Write failing test for translator registry

Create `dispatch/translator-registry.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { getTranslator, IDENTITY_TRANSLATOR } from './translator-registry.ts'

test('identity for messages → messages', () => {
  expect(getTranslator('messages', 'messages')).toBe(IDENTITY_TRANSLATOR)
})

test('chat → messages resolves chatCompletionsViaMessages', () => {
  const t = getTranslator('chat_completions', 'messages')
  expect(t).not.toBe(IDENTITY_TRANSLATOR)
  expect(typeof t?.translateRequest).toBe('function')
  expect(typeof t?.translateEvents).toBe('function')
})

test('messages → chat resolves messagesViaChatCompletions', () => {
  const t = getTranslator('messages', 'chat_completions')
  expect(t).not.toBe(IDENTITY_TRANSLATOR)
})

test('responses ↔ messages, gemini ↔ messages all resolve', () => {
  expect(getTranslator('responses', 'messages')).not.toBeNull()
  expect(getTranslator('messages', 'responses')).not.toBeNull()
  expect(getTranslator('gemini', 'messages')).not.toBeNull()
  expect(getTranslator('messages', 'gemini')).not.toBeNull()
})

test('returns null for unsupported pair', () => {
  // chat → responses is not implemented (always pivots through messages or chat→chat direct)
  expect(getTranslator('chat_completions', 'responses')).toBeNull()
})
```

### - [ ] Step 5.5: Implement translator registry

Create `dispatch/translator-registry.ts`:

```ts
import type { EndpointKey } from '@vnext/protocols/common'
import type { SourceApi } from './pair-selector.ts'
import { chatCompletionsViaMessages } from '@vnext/translators/chat-completions-via-messages'
import { messagesViaChatCompletions } from '@vnext/translators/messages-via-chat-completions'
import { responsesViaMessages } from '@vnext/translators/responses-via-messages'
import { messagesViaResponses } from '@vnext/translators/messages-via-responses'
import { geminiViaMessages } from '@vnext/translators/gemini-via-messages'
import { messagesViaGemini } from '@vnext/translators/messages-via-gemini'

export interface PairTranslator<TFrontReq = unknown, TFrontEvt = unknown, TUpReq = unknown, TUpEvt = unknown> {
  translateRequest(payload: TFrontReq, ctx: { signal: AbortSignal }): Promise<TUpReq> | TUpReq
  translateEvents(events: AsyncIterable<TUpEvt>, ctx: { signal: AbortSignal }): AsyncIterable<TFrontEvt>
}

// Identity: source === target (messages → messages today; chat → chat / responses → responses
// could be added later if a provider serves them natively).
export const IDENTITY_TRANSLATOR: PairTranslator = {
  translateRequest: (p) => p,
  translateEvents: (events) => events,
}

const TABLE: Partial<Record<`${SourceApi}->${EndpointKey}`, PairTranslator>> = {
  'messages->messages': IDENTITY_TRANSLATOR,
  'chat_completions->messages': chatCompletionsViaMessages,
  'messages->chat_completions': messagesViaChatCompletions,
  'responses->messages': responsesViaMessages,
  'messages->responses': messagesViaResponses,
  'gemini->messages': geminiViaMessages,
  'messages->gemini': messagesViaGemini,
}

export function getTranslator(source: SourceApi, target: EndpointKey): PairTranslator | null {
  return TABLE[`${source}->${target}`] ?? null
}
```

### - [ ] Step 5.6: Run translator registry test

```bash
cd vnext && bun test apps/gateway/src/data-plane/dispatch/translator-registry.test.ts
```
Expected: 5/5 pass.

### - [ ] Step 5.7: Write failing dispatch integration test (golden path)

Create `dispatch/dispatch.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { app } from '../../app.ts' // Hono app for vnext gateway
import { resetFetch, installFetch } from '../../../../tests/helpers/fetch-mock.ts' // existing helper

// Minimal end-to-end: messages-in → messages-out (identity pair), real SqliteRepo.
// Asserts the new dispatch returns 200 with a synthesized JSON body.

beforeEach(() => {
  installFetch(async (url, init) => {
    if (String(url).includes('/v1/messages')) {
      return new Response(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  })
})
afterEach(() => resetFetch())

test('messages → messages identity pair returns 200', async () => {
  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { content: Array<{ text: string }> }
  expect(body.content[0].text).toBe('hi')
})

test('chat_completions → messages cross-pair returns 200', async () => {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { choices: Array<{ message: { content: string } }> }
  expect(body.choices[0].message.content).toBe('hi')
})
```

### - [ ] Step 5.8: Implement new `dispatch()` in `routes.ts`

Replace the existing `dispatch<TPayload>()` function (and the imports it depends on) with the pairwise version. Full code:

```ts
// New imports replace IR/adapter imports:
import { selectPair, type SourceApi } from './dispatch/pair-selector.ts'
import { getTranslator } from './dispatch/translator-registry.ts'
import { runConversationAttempt } from './attempts/conversation.ts'
import { messagesIn } from './frontend/messages-in.ts' // Phase A: relocated; see file moves below
import { chatIn } from './frontend/chat-in.ts'
import { responsesIn } from './frontend/responses-in.ts'
import { geminiIn } from './frontend/gemini-in.ts'
// REMOVED: backend/* adapters, IRRequest, IREvent, BackendAdapter

interface FrontendIn<TPayload, TFrontReq, TFrontEvt> {
  parse(raw: unknown): TPayload
  toFrontendRequest(payload: TPayload): TFrontReq
  modelOf(payload: TPayload): string
  encodeBody(events: AsyncIterable<TFrontEvt>): Promise<unknown>
  encodeSSE(events: AsyncIterable<TFrontEvt>): ReadableStream<Uint8Array>
}

async function dispatch<TPayload, TFrontReq, TFrontEvt>(
  c: HonoCtxLike,
  frontend: FrontendIn<TPayload, TFrontReq, TFrontEvt>,
  errorWrap: (status: number, body: unknown) => Response,
  auth: DataPlaneAuthCtx,
  sourceApi: SourceApi,
  obsCtx: DispatchObsCtx,
): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return errorWrap(400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } })
  }
  let payload: TPayload
  try { payload = frontend.parse(raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return errorWrap(e.status ?? 400, e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } })
  }
  const requestedModel = frontend.modelOf(payload)
  const { bareModel } = parseModelRouting(requestedModel)
  const modelForLookup = bareModel

  const { candidates, sawModel } = await enumerateBindingCandidates({
    model: requestedModel,
    pickTarget: (e) => selectPair(sourceApi, e),
    opts: { ownerId: auth.userId, copilot: auth.copilot },
  })
  if (candidates.length === 0) {
    if (sawModel) {
      return errorWrap(400, { error: { type: 'invalid_request_error', message: `Model "${requestedModel}" does not support the "${sourceApi}" client protocol.` } })
    }
    return errorWrap(404, { error: { type: 'invalid_request_error', message: `No upstream serves model "${requestedModel}". Run GET /v1/models for available ids.` } })
  }
  const { binding, targetEndpoint } = candidates[0]!

  const translator = getTranslator(sourceApi, targetEndpoint)
  if (!translator) {
    return errorWrap(500, { error: { type: 'api_error', message: `No translator for ${sourceApi} → ${targetEndpoint}` } })
  }

  const ac = new AbortController()
  const signal = ac.signal
  c.req.raw?.signal?.addEventListener?.('abort', () => ac.abort(), { once: true })

  const frontReq = frontend.toFrontendRequest(payload)
  let upstreamReq: unknown
  try { upstreamReq = await translator.translateRequest(frontReq, { signal }) }
  catch (err) {
    const message = err instanceof Error ? err.message : 'translate request failed'
    return errorWrap(400, { error: { type: 'invalid_request_error', message } })
  }

  const isStream = (frontReq as { stream?: boolean }).stream === true

  const result = await runConversationAttempt({
    binding,
    targetEndpoint,
    upstreamRequest: upstreamReq,
    isStream,
    model: modelForLookup,
    sourceApi,
    obs: { ...obsCtx, userAgent: obsCtx.userAgent },
    signal,
  })

  if (!result.ok) {
    if (result.kind === 'http') return result.response
    return errorWrap(502, { error: { type: 'api_error', message: result.message } })
  }

  if (isStream) {
    const upstreamEvents = result.events // AsyncIterable<unknown> per pair
    const frontEvents = translator.translateEvents(upstreamEvents as AsyncIterable<unknown>, { signal }) as AsyncIterable<TFrontEvt>
    const sse = frontend.encodeSSE(frontEvents)
    return new Response(sse, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }

  const upstreamEventsOnce: AsyncIterable<unknown> = (async function*() {
    for (const e of result.events as Iterable<unknown>) yield e
  })()
  const frontEvents = translator.translateEvents(upstreamEventsOnce, { signal }) as AsyncIterable<TFrontEvt>
  const body = await frontend.encodeBody(frontEvents)
  return Response.json(body)
}
```

Move adapter files to `frontend/` and rename. Per spec §"File Layout", the in-adapters relocate to `vnext/apps/gateway/src/data-plane/frontend/`. The interface changes from `toIR()` to `toFrontendRequest()` (returns `MessagesPayload | ChatCompletionsRequest | ResponsesRequest | GeminiRequest`); `decodeBody`/`decodeSSE` are dropped (decoding is the translator's job). Add `modelOf()` helper.

Concretely for `messages-in.ts`:
- `parse()` keeps current Zod parse.
- `toFrontendRequest()` returns the parsed `MessagesPayload` directly (already hub-shaped).
- `modelOf(p) → p.model`.
- `encodeBody(events)`: drains hub events into Anthropic JSON (use new `messages-encoder.ts` helper).
- `encodeSSE(events)`: pipes hub events to Anthropic SSE bytes.

Each frontend file gets a similar shape; encode/decode logic that lived in the old `adapters/` translates straight into these `encode*` helpers.

### - [ ] Step 5.9: Update the 4 route handlers to call new dispatch

Each `dataPlane.post(...)` call site loses `toIR`, `pickTarget`, gains nothing — just remove those args. Web-search and image-generation intercepts are unchanged (they still short-circuit before dispatch). The Gemini route still pre-extracts `model` + `verb` and stamps `stream` onto the parsed payload before parse, but now via `geminiIn.parseForRoute(model, verb, raw)` instead of `toIRForModel`.

### - [ ] Step 5.10: Run dispatch integration test

```bash
cd vnext && bun test apps/gateway/src/data-plane/dispatch/dispatch.test.ts
```
Expected: 2/2 pass.

### - [ ] Step 5.11: Run full vnext test suite — observe expected failures

```bash
cd vnext && bun test
```

Expected:
- 38 of 42 existing tests still pass.
- **4 IR-dependent tests FAIL** (these are removed in Phase C):
  1. `vnext/packages/protocols/tests/ir.test.ts`
  2. `vnext/packages/translate/tests/contract.test.ts`
  3. `vnext/apps/gateway/src/data-plane/adapters/backend/__tests__/responses-out.test.ts` (or equivalent)
  4. `vnext/apps/gateway/src/data-plane/adapters/frontend/__tests__/messages-in.test.ts` (or equivalent)
- New translator + attempt tests (Phase A) still pass.
- New dispatch tests (this task) pass.

If any *other* test fails, fix before moving on.

### - [ ] Step 5.12: Commit X-5

```bash
git add -A
git commit -m "feat(gateway): rewrite dispatch as pairwise pipeline (X-5)

Replaces IR-shaped dispatch with: pair selector → translator → provider call →
translator → frontend encode. The 4 IR-dependent tests now fail and are
slated for deletion in X-8; the other 38 tests + new pair/attempt tests are green."
```

---

## Task 6 (X-6): Delete IR + Old Adapter Code

**Files (all deletions):**
- Delete: `vnext/packages/protocols/src/ir/index.ts` (115 LOC)
- Delete: `vnext/packages/protocols/src/ir/` directory
- Delete: `vnext/packages/translate/` package (the old `BackendAdapter`/`FrontendAdapter` contract)
- Delete: `vnext/apps/gateway/src/data-plane/adapters/` directory (all of `backend/*`, `frontend/*` — frontends already relocated to `data-plane/frontend/` in X-5)
- Modify: `vnext/packages/protocols/package.json` (drop `./ir` export)
- Modify: `vnext/packages/protocols/src/index.ts` (drop IR re-exports)
- Modify: workspace `package.json` (drop `@vnext/translate` workspace member)
- Modify: any `tsconfig.json` `paths` referring to removed packages

**Subject:** With dispatch now driving translators directly, the IR + adapter contract are dead code. Remove them so the architecture has no "two ways to do it" ambiguity, and so future contributors can't accidentally wire a new adapter into a removed pipeline.

### - [ ] Step 6.1: Verify nothing outside the deletion set imports from IR/translate/adapters

```bash
cd vnext && grep -rn "@vnext/protocols/ir\|@vnext/translate\|data-plane/adapters" \
  --include='*.ts' --exclude-dir=node_modules .
```

Expected: matches only in files we are about to delete (the IR package itself, the translate package itself, the adapters directory itself, and the 4 IR-dependent test files which are deleted in Phase C). If any *live* code outside this set still references them, fix in X-5 — do not paper over with re-exports.

### - [ ] Step 6.2: Delete IR package

```bash
cd vnext && rm -rf packages/protocols/src/ir
```

Edit `vnext/packages/protocols/src/index.ts` to drop any `export * from './ir'` line. Edit `vnext/packages/protocols/package.json` to remove the `./ir` entry from `exports`.

### - [ ] Step 6.3: Delete translate package

```bash
cd vnext && rm -rf packages/translate
```

Edit root `vnext/package.json` (or `vnext/packages/*` workspace config) to remove `packages/translate` from `workspaces`. Run `bun install` to refresh the lockfile.

### - [ ] Step 6.4: Delete old adapters directory

```bash
cd vnext && rm -rf apps/gateway/src/data-plane/adapters
```

The 8 files under `adapters/backend` and `adapters/frontend` are gone; the 4 frontend files were relocated to `data-plane/frontend/` in X-5, so there is no functional loss.

### - [ ] Step 6.5: Type-check the workspace

```bash
cd vnext && bun run typecheck
```

Expected: zero errors. If any module still imports from a deleted path, the import is a leftover from X-5 — go fix the import there (do not resurrect the deleted code).

### - [ ] Step 6.6: Run vnext test suite

```bash
cd vnext && bun test
```

Expected:
- 4 IR-dependent test files FAIL (their imports now resolve nothing). These are slated for deletion in Phase C X-8. **Do not delete them yet** — keep the failures visible as a guardrail until X-8 lands.
- All other tests green.

### - [ ] Step 6.7: Commit X-6

```bash
git add -A
git commit -m "refactor(vnext): delete IR protocol, translate contract, old adapters (X-6)

Removes @vnext/protocols/ir, @vnext/translate, and apps/gateway/src/data-plane/adapters/.
Dispatch now runs exclusively through pairwise translators (X-5). The 4 IR-dependent
test files are intentionally left in place to fail until X-8 deletes them."
```

---

## Phase B Acceptance

- [ ] `routes.ts dispatch()` no longer references `IRRequest`, `IREvent`, `BackendAdapter`, `FrontendAdapter`.
- [ ] `@vnext/protocols/ir` does not exist.
- [ ] `@vnext/translate` does not exist.
- [ ] `apps/gateway/src/data-plane/adapters/` does not exist.
- [ ] `bun run typecheck` clean.
- [ ] `bun test` shows exactly 4 expected failures (the IR-dependent test files); 38 existing tests + Phase A's new tests + this phase's new dispatch tests pass.
- [ ] No `@vnext/protocols/ir` / `@vnext/translate` / `data-plane/adapters` strings appear in any live `.ts` file.

## Expected Test Losses (deleted in Phase C X-8)

The following 4 test files are expected to fail at the end of Phase B and will be deleted in Phase C X-8:

1. IR shape & parse tests (`packages/protocols/tests/ir.*.test.ts`)
2. Translate contract tests (`packages/translate/tests/contract.test.ts`)
3. Backend adapter unit tests (`adapters/backend/__tests__/*.test.ts`)
4. Frontend adapter unit tests (`adapters/frontend/__tests__/*.test.ts` — coverage moves to per-pair translator tests added in Phase C X-9)

Replacement coverage is the explicit charter of Phase C: per-pair (×6) + per-attempt (×3) + per-route (×6) e2e tests.
