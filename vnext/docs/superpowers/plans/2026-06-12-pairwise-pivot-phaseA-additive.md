# Pairwise Pivot — Phase A: Additive Build

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `vnext/docs/superpowers/specs/2026-06-12-pairwise-translation-pivot.md`
**Overview:** `vnext/docs/superpowers/plans/2026-06-12-pairwise-pivot-overview.md`

**Goal:** Land all the **new** building blocks of the pairwise architecture without changing dispatch behavior. After Phase A, the gateway still routes via the IR pipeline; new code coexists, fully tested, ready for Phase B to wire in.

**Architecture:** Four independent additive workstreams: (X-1) hub protocol vocabulary, (X-2) `ModelProvider` per-endpoint methods, (X-3) six pairwise translators, (X-4) gateway-layer attempt modules. None of these are wired into `routes.ts dispatch()` yet — that switch is Phase B.

**Tech Stack:** TypeScript, Bun test, Zod (existing), AsyncIterable generators.

**Parallelism:** Tasks 1, 2, 3, 4 (the X-N sub-stages) are mutually independent and can be implemented by parallel subagents. Their internal sub-tasks are sequential.

---

## Task 1 (X-1): Hub Protocol Vocabulary

**Files:**
- Modify: `vnext/packages/protocols/src/messages/index.ts` (current 61 LOC — extend)
- Create: `vnext/packages/protocols/src/messages/events.ts`
- Create: `vnext/packages/protocols/src/messages/version.ts`
- Create: `vnext/packages/protocols/tests/messages-events.test.ts`

**Subject:** Extend `@vnext/protocols/messages` from a request-only schema to the **full hub vocabulary** — request types, all content blocks (incl. `thinking` / `redacted_thinking` with explicit fields), all SSE event types, response body shape, and a `HUB_VERSION` constant.

### - [ ] Step 1.1: Audit current Messages schema

Read `vnext/packages/protocols/src/messages/index.ts` (61 lines). Note what exists: `TextBlock`, `ImageBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock` (loose), `MessagesPayloadSchema`. Gaps for hub use:
- `ThinkingBlock` is currently a single loose union of `thinking | redacted_thinking` — needs split with explicit fields per spec §2.1.
- No event/SSE types exported.
- No response body type.
- No version constant.

### - [ ] Step 1.2: Write failing test for explicit Thinking variants

Create `vnext/packages/protocols/tests/messages-events.test.ts`:

```ts
import { test, expect } from 'bun:test'
import {
  MessagesThinkingBlockSchema,
  MessagesRedactedThinkingBlockSchema,
  HUB_VERSION,
} from '@vnext/protocols/messages'

test('thinking block carries text + signature + id + encryptedContent', () => {
  const parsed = MessagesThinkingBlockSchema.parse({
    type: 'thinking',
    thinking: 'reasoning trace',
    signature: 'sig@id',
    id: 'rs_1',
    encryptedContent: 'enc',
  })
  expect(parsed.thinking).toBe('reasoning trace')
  expect(parsed.signature).toBe('sig@id')
})

test('redacted_thinking block carries data', () => {
  const parsed = MessagesRedactedThinkingBlockSchema.parse({
    type: 'redacted_thinking',
    data: 'opaque',
  })
  expect(parsed.data).toBe('opaque')
})

test('HUB_VERSION is a non-empty string', () => {
  expect(typeof HUB_VERSION).toBe('string')
  expect(HUB_VERSION.length).toBeGreaterThan(0)
})
```

Run: `cd vnext && bun test packages/protocols/tests/messages-events.test.ts`. Expected: FAIL with import errors.

### - [ ] Step 1.3: Add explicit Thinking variants + version constant

Edit `vnext/packages/protocols/src/messages/index.ts`:

```ts
// Replace the existing single ThinkingBlock with two explicit variants
export const MessagesThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
  id: z.string().optional(),
  encryptedContent: z.string().optional(),
}).loose()

export const MessagesRedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
}).loose()

// Update ContentBlock union
const ContentBlock = z.union([
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  MessagesThinkingBlockSchema,
  MessagesRedactedThinkingBlockSchema,
])

export type MessagesThinkingBlock = z.infer<typeof MessagesThinkingBlockSchema>
export type MessagesRedactedThinkingBlock = z.infer<typeof MessagesRedactedThinkingBlockSchema>
```

Create `vnext/packages/protocols/src/messages/version.ts`:

```ts
/**
 * Hub Messages vocabulary version. Bumped deliberately when we widen the
 * hub schema (new content blocks, new event types). Recorded in latency
 * metadata so traces can be correlated to a hub vocabulary.
 */
export const HUB_VERSION = '2026-06-12.1'
```

Re-export from `vnext/packages/protocols/src/messages/index.ts`:

```ts
export { HUB_VERSION } from './version'
```

Run the test from 1.2: PASS.

### - [ ] Step 1.4: Add SSE event vocabulary

Create `vnext/packages/protocols/src/messages/events.ts`:

```ts
import { z } from 'zod'

/**
 * Anthropic Messages SSE event vocabulary. Pairwise translators consume and
 * emit these as AsyncIterable<MessagesEvent>; HTTP boundary code converts
 * to/from `event: ...\ndata: ...\n\n` text frames.
 */

export const MessageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string(),
    content: z.array(z.unknown()),
    stop_reason: z.string().nullable(),
    stop_sequence: z.string().nullable(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    }).loose(),
  }).loose(),
}).loose()

export const ContentBlockStartEventSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number(),
  content_block: z.unknown(),
}).loose()

export const ContentBlockDeltaEventSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number(),
  delta: z.unknown(),
}).loose()

export const ContentBlockStopEventSchema = z.object({
  type: z.literal('content_block_stop'),
  index: z.number(),
}).loose()

export const MessageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
  }).loose(),
  usage: z.object({}).loose().optional(),
}).loose()

export const MessageStopEventSchema = z.object({ type: z.literal('message_stop') }).loose()
export const PingEventSchema = z.object({ type: z.literal('ping') }).loose()
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string(), message: z.string() }).loose(),
}).loose()

export const MessagesEventSchema = z.union([
  MessageStartEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
  PingEventSchema,
  ErrorEventSchema,
])

export type MessagesEvent = z.infer<typeof MessagesEventSchema>
```

Re-export from `index.ts`: `export * from './events'`.

### - [ ] Step 1.5: Add response body type

Append to `vnext/packages/protocols/src/messages/index.ts`:

```ts
export const MessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(ContentBlock),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }).loose(),
}).loose()

export type MessagesResponse = z.infer<typeof MessagesResponseSchema>
```

### - [ ] Step 1.6: Run all protocols tests + commit

```bash
cd vnext && bun test packages/protocols/
```

Expected: PASS (existing + new tests).

```bash
git add vnext/packages/protocols/src/messages/ vnext/packages/protocols/tests/messages-events.test.ts
git commit -m "feat(protocols): extend Messages with hub vocabulary (events, thinking variants, version)"
```

---

## Task 2 (X-2): ModelProvider Per-Endpoint Methods

**Files:**
- Modify: `vnext/packages/provider/src/types.ts` (add per-endpoint methods to `ModelProvider`)
- Create: `vnext/packages/provider/src/upstream-response.ts`
- Modify: `vnext/packages/provider-copilot/src/provider.ts` (implement per-endpoint methods alongside existing `fetch()`)
- Create: `vnext/packages/provider-copilot/__tests__/per-endpoint-methods.test.ts`

**Subject:** Add per-endpoint `call*` methods (`callMessages`, `callChatCompletions`, `callResponses`, `callMessagesCountTokens`, `callEmbeddings`, `callImagesGenerations`, `callImagesEdits`) to `ModelProvider`. Implement on `CopilotProvider` by delegating to existing `fetch()` and parsing into `UpstreamResponse`. Existing `fetch()` stays untouched — Phase B will retire its callers.

### - [ ] Step 2.1: Define UpstreamResponse type

Create `vnext/packages/provider/src/upstream-response.ts`:

```ts
import type { HTTPError } from './errors'  // existing in provider package

/**
 * Discriminated result of a per-endpoint provider call.
 *
 * - `body` is `AsyncIterable<RawEvent>` for streaming endpoints; the iterable
 *   owns the upstream reader and respects `signal` cancellation between chunks.
 * - `body` is the parsed JSON for non-streaming.
 * - `error` carries upstream HTTP error details — gateway repackages it into
 *   the client's protocol-specific error shape.
 */
export type UpstreamResponse<TStream = unknown, TBody = unknown> =
  | { ok: true; status: number; stream: true; body: AsyncIterable<TStream>; headers: Headers }
  | { ok: true; status: number; stream: false; body: TBody; headers: Headers }
  | { ok: false; status: number; error: HTTPError }
```

(If `HTTPError` isn't already in `@vnext/provider`, re-export from `@vnext/provider-copilot/src/lib/error` — discover during impl. Add it to the provider package types if missing.)

### - [ ] Step 2.2: Write failing test for `callMessages`

Create `vnext/packages/provider-copilot/__tests__/per-endpoint-methods.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { CopilotProvider } from '../src/provider'

const originalFetch = globalThis.fetch

test('callMessages non-streaming returns parsed body', async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))) as typeof fetch
  try {
    const p = new CopilotProvider({ copilotToken: 't', accountType: 'individual' })
    const r = await p.callMessages({ model: 'm', messages: [], max_tokens: 100, stream: false })
    expect(r.ok).toBe(true)
    if (r.ok && r.stream === false) {
      expect((r.body as { id: string }).id).toBe('msg_1')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('callMessages streaming returns AsyncIterable<MessagesEvent>', async () => {
  const sse =
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`
  globalThis.fetch = (() => Promise.resolve(new Response(sse, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))) as typeof fetch
  try {
    const p = new CopilotProvider({ copilotToken: 't', accountType: 'individual' })
    const r = await p.callMessages({ model: 'x', messages: [], max_tokens: 100, stream: true })
    expect(r.ok).toBe(true)
    if (r.ok && r.stream === true) {
      const out: unknown[] = []
      for await (const ev of r.body) out.push(ev)
      expect(out.length).toBe(2)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
```

Run: `cd vnext && bun test packages/provider-copilot/__tests__/per-endpoint-methods.test.ts`. Expected: FAIL (`callMessages` not defined).

### - [ ] Step 2.3: Add `callMessages` to interface + impl

Edit `vnext/packages/provider/src/types.ts` — add to `ModelProvider`:

```ts
import type { UpstreamResponse } from './upstream-response'
import type { MessagesEvent } from '@vnext/protocols/messages'

export interface ModelProvider {
  // ... existing kind/name/supportedEndpoints/getModels/probe/fetch ...

  // Per-endpoint methods (Phase A — additive). Optional; presence determined
  // by supportedEndpoints. Phase B switches dispatch to these and retires fetch().
  callMessages?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<MessagesEvent>>
  callMessagesCountTokens?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
  callChatCompletions?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<unknown>>
  callResponses?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<unknown>>
  callEmbeddings?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
  callImagesGenerations?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
  callImagesEdits?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
}

export interface PerEndpointCallOptions {
  signal?: AbortSignal
  enabledFlags?: ReadonlySet<string>
  sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  extraHeaders?: Record<string, string>
  operationName?: string
  /** Anthropic only. Used by callMessages / callMessagesCountTokens. */
  anthropicBeta?: string
}
```

Edit `vnext/packages/provider-copilot/src/provider.ts` — implement `callMessages`:

```ts
import type { UpstreamResponse, PerEndpointCallOptions } from '@vnext/provider'
import { parseSSEStream, type MessagesEvent } from './parse/messages-sse'  // new helper, Step 2.4

async callMessages(
  payload: unknown,
  opts: PerEndpointCallOptions = {},
): Promise<UpstreamResponse<MessagesEvent>> {
  const init: RequestInit = {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: opts.extraHeaders,
    signal: opts.signal,
  }
  const fetchOpts = {
    enabledFlags: opts.enabledFlags,
    sourceApi: opts.sourceApi ?? 'messages' as const,
    operationName: opts.operationName ?? 'callMessages',
  }
  let res: Response
  try {
    res = await this.fetch('messages', init, fetchOpts)
  } catch (err) {
    if (err instanceof HTTPError) return { ok: false, status: err.response.status, error: err }
    throw err
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: new HTTPError('upstream error', res) }
  }
  const stream = (payload as { stream?: boolean }).stream === true
  if (stream) {
    return { ok: true, status: res.status, stream: true, body: parseSSEStream(res.body, opts.signal), headers: res.headers }
  }
  return { ok: true, status: res.status, stream: false, body: await res.json(), headers: res.headers }
}
```

### - [ ] Step 2.4: Add SSE parser helper

Create `vnext/packages/provider-copilot/src/parse/messages-sse.ts`:

```ts
import { MessagesEventSchema, type MessagesEvent } from '@vnext/protocols/messages'

/**
 * Parse Anthropic Messages SSE bytes into a typed AsyncIterable.
 * Honors AbortSignal between chunks; releases the upstream reader on
 * cancellation, on error, and on natural completion (try/finally).
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<MessagesEvent> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const json = dataLine.slice(6).trim()
        if (!json || json === '[DONE]') continue
        try {
          const parsed = MessagesEventSchema.parse(JSON.parse(json))
          yield parsed
        } catch {
          // unknown event shape — drop. Hub Versioning §4: opaque pass-through is
          // the messages-native fast path's job; here we only emit typed events.
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

export type { MessagesEvent }
```

Run test from 2.2: PASS.

### - [ ] Step 2.5: Add the other six per-endpoint methods

Repeat the pattern of 2.3 for `callChatCompletions`, `callResponses`, `callMessagesCountTokens`, `callEmbeddings`, `callImagesGenerations`, `callImagesEdits`. Each delegates to `this.fetch(endpoint, ...)`. The streaming/non-streaming split:
- `callChatCompletions`, `callResponses`: streaming via per-protocol parsers (chat-sse, responses-sse) — create them in `parse/`.
- `callMessagesCountTokens`, `callEmbeddings`, `callImagesGenerations`, `callImagesEdits`: non-streaming only.

Add one focused test per method (1 streaming + 1 non-streaming where applicable). Use the same `globalThis.fetch` override pattern.

### - [ ] Step 2.6: Run + commit

```bash
cd vnext && bun test packages/provider-copilot/
git add vnext/packages/provider/src/ vnext/packages/provider-copilot/src/ vnext/packages/provider-copilot/__tests__/per-endpoint-methods.test.ts
git commit -m "feat(provider): add per-endpoint call* methods to ModelProvider; impl in CopilotProvider"
```

---

## Task 3 (X-3): Pairwise Translators

**Files (per pair):**
- Create: `vnext/packages/translate/src/<pair>/index.ts`
- Create: `vnext/packages/translate/src/<pair>/request.ts` — payload translator
- Create: `vnext/packages/translate/src/<pair>/events.ts` — AsyncIterable event translator
- Create: `vnext/packages/translate/src/<pair>/body.ts` — non-streaming body translator
- Create: `vnext/packages/translate/tests/<pair>/<scenario>.test.ts`

**Six pair directories:**
- `chat-completions-via-messages/`
- `messages-via-chat-completions/`
- `responses-via-messages/`
- `messages-via-responses/`
- `gemini-via-messages/`
- `messages-via-gemini/`

Plus shared:
- Create: `vnext/packages/translate/src/shared/cache-breakpoints.ts`
- Create: `vnext/packages/translate/src/shared/reasoning-pack.ts`
- Create: `vnext/packages/translate/src/shared/citations.ts`

**Subject:** Pure functions / generators that translate **client protocol ↔ Messages hub**. No HTTP, no `fetch`, no observability. Each module exports `translateRequest`, `translateEvents` (AsyncIterable → AsyncIterable), `translateBody`. Behavior must be parity with current IR-mediated logic; port from existing translate package and reference project's pairwise modules.

### - [ ] Step 3.1: Scaffold pair directories

```bash
cd vnext/packages/translate/src
mkdir -p chat-completions-via-messages messages-via-chat-completions \
         responses-via-messages messages-via-responses \
         gemini-via-messages messages-via-gemini \
         shared
mkdir -p ../tests/chat-completions-via-messages \
         ../tests/messages-via-chat-completions \
         ../tests/responses-via-messages \
         ../tests/messages-via-responses \
         ../tests/gemini-via-messages \
         ../tests/messages-via-gemini
```

### - [ ] Step 3.2: Pair-by-pair TDD

For each of the 6 pairs, follow this loop. **Do them sequentially within a single subagent** (each pair touches the same shared modules); parallelizing them risks merge conflicts. Subagents may parallelize across the **6 different pairs** only if shared modules are stable.

For each pair:

1. **Step 3.2.1: Write request translation test** (failing). Use a small representative payload covering: text, tool definitions, tool result, image, system prompt.
2. **Step 3.2.2: Implement `request.ts`**. Reference: corresponding existing IR-mediated adapter in `vnext/packages/translate/src/{chat,messages,responses,gemini}.ts` and reference project's `packages/translate/src/<pair>/`. Port logic verbatim where applicable.
3. **Step 3.2.3: Run request test** — PASS.
4. **Step 3.2.4: Write event translation test** (failing). Use inline programmatic SSE source — small async generator emitting hub or client events. Assert output sequence.
5. **Step 3.2.5: Implement `events.ts`** as an `async function* translateEvents(input: AsyncIterable<...>, opts?): AsyncIterable<...>` that handles cancellation via `try/finally` (per spec §3).
6. **Step 3.2.6: Write cancellation test** — start an upstream generator that yields one event then awaits a never-resolving promise; consumer breaks after one yielded; assert upstream finally block ran.
7. **Step 3.2.7: Implement non-streaming `body.ts`**.
8. **Step 3.2.8: Write body test**.
9. **Step 3.2.9: Wire up `index.ts`**:
   ```ts
   export { translateRequest } from './request'
   export { translateEvents } from './events'
   export { translateBody } from './body'
   ```
10. **Step 3.2.10: Commit per pair.**

```bash
git commit -m "feat(translate): pairwise translator <pair>"
```

### - [ ] Step 3.3: Shared modules (cache breakpoints, reasoning-pack, citations)

These accumulate as pairs need them. Reference: `packages/translate/src/shared/messages-and-responses/reasoning.ts`, `cache-breakpoints.ts` in the reference project.

- `shared/reasoning-pack.ts`:
  - `packReasoningSignature(id, encrypted) → "${encrypted}@${id}"` (verbatim from reference)
  - `unpackReasoningSignature(signature) → { id, encrypted }`
  - `responsesReasoningToMessagesBlock(reasoning)` — emits thinking vs redacted_thinking based on summary length
- `shared/cache-breakpoints.ts`: synthetic `cache_control` injection for chat/responses → messages translations
- `shared/citations.ts`: `citations_delta → url_citation annotations` (responses-via-messages); blanket-drop helper for chat-via-messages with comment "Permanent limitation"

### - [ ] Step 3.4: Run full translate suite + commit

```bash
cd vnext && bun test packages/translate/
git add vnext/packages/translate/
git commit -m "feat(translate): six pairwise translators + shared utilities"
```

---

## Task 4 (X-4): Gateway-Layer Attempt Modules

**Files:**
- Create: `vnext/apps/gateway/src/data-plane/observability/attempts/conversation-attempt.ts`
- Create: `vnext/apps/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts`
- Create: `vnext/apps/gateway/src/data-plane/observability/attempts/images-attempt.ts`
- Create: `vnext/apps/gateway/tests/observability/attempts/conversation-attempt.test.ts`
- Create: `vnext/apps/gateway/tests/observability/attempts/embeddings-attempt.test.ts`
- Create: `vnext/apps/gateway/tests/observability/attempts/images-attempt.test.ts`

**Subject:** Extract the observability scaffolding (quota, latency, usage tracking, client-detect) from `routes.ts dispatch()` into reusable per-endpoint attempt modules. Phase A keeps `dispatch()` calling them as a refactor (no behavior change); Phase B and C reuse them for pairwise dispatch and server-tools.

### - [ ] Step 4.1: Define `ConversationAttempt` shape

Create `vnext/apps/gateway/src/data-plane/observability/attempts/conversation-attempt.ts`:

```ts
import { checkQuota } from '../quota'
import { recordLatency, startTimer, type SourceApiInput, type TargetApiInput } from '../latency-tracker'
import { trackNonStreamingUsage, trackStreamingUsage } from '../usage-tracker'
import { detectClient } from '../client-detect'

export interface ConversationAttemptInput {
  apiKeyId: string | undefined
  model: string
  sourceApi: SourceApiInput
  targetApi: TargetApiInput
  upstream: 'github_copilot'
  userAgent: string | undefined
  requestId: string | undefined
  /** Caller decides streaming up-front (it shapes the upstream request). */
  stream: boolean
  /**
   * Wraps the upstream call. Returns either a streaming Response (whose body
   * is the upstream raw SSE — caller is expected to consume / re-emit) or a
   * non-streaming JSON Response object. We only wrap for usage-tracking.
   */
  call: () => Promise<Response>
}

export type ConversationAttemptResult =
  | { ok: true; status: number; stream: true; response: Response }
  | { ok: true; status: number; stream: false; response: Response; json: unknown }
  | { ok: false; status: 429; rateLimit: { reason: string; retryAfterSeconds?: number } }
  | { ok: false; status: number; response: Response }

export async function runConversationAttempt(
  input: ConversationAttemptInput,
): Promise<ConversationAttemptResult> {
  const client = detectClient(input.userAgent)
  if (input.apiKeyId) {
    const quota = await checkQuota(input.apiKeyId)
    if (!quota.allowed) {
      return {
        ok: false,
        status: 429,
        rateLimit: {
          reason: quota.reason ?? 'Daily quota exceeded.',
          retryAfterSeconds: quota.retryAfterSeconds ?? undefined,
        },
      }
    }
  }
  const elapsed = startTimer()
  const upstreamStart = Date.now()
  let res: Response
  try {
    res = await input.call()
  } catch (err) {
    const upstreamMs = Date.now() - upstreamStart
    if (input.apiKeyId) {
      await recordLatency(input.apiKeyId, input.model, 'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        input.requestId, { isError: true, upstream: input.upstream, userAgent: input.userAgent },
      )
    }
    throw err
  }
  const upstreamMs = Date.now() - upstreamStart
  if (!res.ok) {
    if (input.apiKeyId) {
      await recordLatency(input.apiKeyId, input.model, 'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        input.requestId, { isError: true, upstream: input.upstream, userAgent: input.userAgent },
      )
    }
    return { ok: false, status: res.status, response: res }
  }
  if (input.stream) {
    let response = res
    if (input.apiKeyId) {
      response = trackStreamingUsage(res, input.apiKeyId, input.model, client, input.upstream)
    }
    if (input.apiKeyId) {
      await recordLatency(input.apiKeyId, input.model, 'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        input.requestId, {
          stream: true,
          sourceApi: input.sourceApi, targetApi: input.targetApi,
          upstream: input.upstream, userAgent: input.userAgent,
        })
    }
    return { ok: true, status: res.status, stream: true, response }
  }
  const json = await res.json()
  if (input.apiKeyId) {
    await trackNonStreamingUsage(json, input.apiKeyId, input.model, client, input.upstream)
    await recordLatency(input.apiKeyId, input.model, 'local',
      { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
      input.requestId, {
        stream: false,
        sourceApi: input.sourceApi, targetApi: input.targetApi,
        upstream: input.upstream, userAgent: input.userAgent,
      })
  }
  return { ok: true, status: res.status, stream: false, response: res, json }
}
```

(Note: the attempt module **currently still consumes `Response` not `UpstreamResponse`** — Phase A keeps backward compat with `dispatch()`'s existing call shape. Phase B will introduce a parallel overload taking the per-endpoint `UpstreamResponse` once translators land. Keeping it `Response`-shaped now avoids touching `dispatch()` in Phase A.)

### - [ ] Step 4.2: Test conversation-attempt

Create `vnext/apps/gateway/tests/observability/attempts/conversation-attempt.test.ts`. Use the canonical SqliteRepo + auth-shim pattern from `tests/observability/dispatch-quota.test.ts`. Cover:
- non-streaming success path → records latency + usage, returns `{ ok: true, stream: false, json }`
- streaming success path → records latency, wraps response for usage tap
- upstream 5xx → returns `{ ok: false, status, response }`, records error latency
- thrown HTTPError → records error latency, rethrows
- quota exceeded → returns `{ ok: false, status: 429, rateLimit }` without calling upstream
- no apiKeyId → skips all observability hooks, still calls upstream

Run: `cd vnext && bun test apps/gateway/tests/observability/attempts/conversation-attempt.test.ts`. PASS.

### - [ ] Step 4.3: Embeddings attempt module

Mirror conversation-attempt but simplified (no streaming, no client-detect-influenced source/target — embeddings is point-to-point):

```ts
export async function runEmbeddingsAttempt(input: EmbeddingsAttemptInput): Promise<EmbeddingsAttemptResult>
```

Refactor the body of `apps/gateway/src/data-plane/embeddings/routes.ts:34-122` (the `handle` function) to call this module. Test using the same patterns as 4.2.

Commit: `git commit -m "refactor(observability): extract runEmbeddingsAttempt; routes/embeddings uses it"`.

### - [ ] Step 4.4: Images attempt module

Same as 4.3 for `apps/gateway/src/data-plane/images/routes.ts`. Two endpoints (`images_generations`, `images_edits`) both use the same attempt shape.

Commit: `git commit -m "refactor(observability): extract runImagesAttempt; routes/images uses it"`.

### - [ ] Step 4.5: Refactor `dispatch()` to use `runConversationAttempt`

Edit `apps/gateway/src/data-plane/routes.ts:75-230` (`dispatch` function). Replace the inline observability scaffolding with a call to `runConversationAttempt`:

```ts
const attempt = await runConversationAttempt({
  apiKeyId: obsCtx.apiKeyId,
  model: ir.model,
  sourceApi: sourceApi as SourceApiInput,
  targetApi: upstreamEndpoint as TargetApiInput,
  upstream: 'github_copilot',
  userAgent: obsCtx.userAgent,
  requestId: obsCtx.requestId,
  stream: ir.stream,
  call: () => binding.provider.fetch(
    upstreamEndpoint,
    { method: 'POST', body: JSON.stringify(upstreamPayload), headers: { 'content-type': 'application/json' } },
    { operationName: 'data-plane dispatch', enabledFlags: binding.enabledFlags, sourceApi },
  ),
})
if (!attempt.ok && attempt.status === 429) {
  return errorWrap(429, { error: { type: 'rate_limit_error', message: attempt.rateLimit.reason, ...(attempt.rateLimit.retryAfterSeconds != null ? { retry_after_seconds: attempt.rateLimit.retryAfterSeconds } : {}) } })
}
if (!attempt.ok) {
  if ('response' in attempt) return await repackageUpstreamError(attempt.response, sourceApi)
  // shouldn't reach
  return errorWrap(502, { error: { type: 'api_error', message: 'upstream error' } })
}
// attempt.ok === true
if (attempt.stream) {
  const events = attempt.response.body
    ? backend.decodeSSE(attempt.response.body)
    : (async function* (): AsyncIterable<IREvent> { /* empty */ })()
  const out = adapter.encodeSSE(events)
  return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}
const events = backend.decodeBody(attempt.json)
const body = await adapter.encodeBody(events)
return Response.json(body)
```

Wrap the `try/catch` for `HTTPError` in `repackageUpstreamError`-handling appropriately.

### - [ ] Step 4.6: Run full gateway suite

```bash
cd vnext && bun test apps/gateway/
```

Expected: PASS (all 42 existing tests + 3 new attempt-module test files). The IR pipeline behavior is unchanged.

### - [ ] Step 4.7: Commit

```bash
git add vnext/apps/gateway/src/data-plane/observability/ \
        vnext/apps/gateway/src/data-plane/routes.ts \
        vnext/apps/gateway/src/data-plane/embeddings/routes.ts \
        vnext/apps/gateway/src/data-plane/images/routes.ts \
        vnext/apps/gateway/tests/observability/attempts/
git commit -m "refactor(observability): gateway-layer attempt modules; dispatch + embeddings + images use them"
```

---

## Phase A Acceptance

After all four tasks:

- [ ] `cd vnext && bun test` — workspace-wide green (existing 42 tests + new translator/attempt-module tests)
- [ ] `cd vnext && tsc -b` (or bun's typecheck) — no type errors workspace-wide
- [ ] `vnext/packages/protocols/src/messages/events.ts` exists with `MessagesEventSchema` exported
- [ ] `HUB_VERSION` exported from `@vnext/protocols/messages`
- [ ] `CopilotProvider.callMessages` (and 6 sibling methods) implemented and tested
- [ ] All 6 `vnext/packages/translate/src/<pair>/` directories exist with passing per-pair tests + cancellation tests
- [ ] `runConversationAttempt`, `runEmbeddingsAttempt`, `runImagesAttempt` exist; `dispatch()` and `embeddings/routes.ts` and `images/routes.ts` use them
- [ ] No existing test was deleted; gateway dispatch behavior unchanged

If acceptance passes, proceed to Phase B (`2026-06-12-pairwise-pivot-phaseB-switch.md`).
