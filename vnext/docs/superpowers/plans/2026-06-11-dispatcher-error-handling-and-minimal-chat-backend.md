# Dispatcher Error Handling + Minimal Chat Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the data-plane dispatcher so it picks an upstream endpoint based on the model (chat_completions / responses / messages) instead of always hitting `/responses`, repackages upstream errors into the caller's protocol shape, and ships minimal chat-out + messages-out backend adapters that cover the IR variants used by current e2e tests.

**Architecture:** A new `chooseBackendEndpoint(model)` helper performs a pure heuristic mapping from model id to `EndpointKey`. A new `repackageUpstreamError(res, sourceApi)` wraps non-2xx upstream responses into Anthropic / OpenAI Chat / OpenAI Responses / Google error envelopes. The dispatcher in `data-plane/routes.ts` selects the backend adapter (responsesOut / chatOut / messagesOut) per endpoint, wraps `provider.fetch` in try/catch, and uses `repackageUpstreamError` on both `HTTPError` throws and `upstreamRes.ok === false`. `chatOut` and `messagesOut` stubs are replaced with real `toUpstream` / `decodeBody` / `decodeSSE` implementations covering input_text / output_text / tool_use / tool_result and standard usage/finish_reason mapping. Each new module is tested in isolation, then existing e2e tests are updated to stub the per-protocol upstream endpoint instead of `/responses`.

**Tech Stack:** Bun + TypeScript, Hono, `@vnext/protocols/ir`, `@vnext/translate/contract`, `bun:test`. No new runtime dependencies.

---

## File Structure

**Created:**
- `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts` — `chooseBackendEndpoint(model)` heuristic.
- `vnext/apps/gateway/src/data-plane/errors/repackage.ts` — `repackageUpstreamError(res, sourceApi)` mapper.
- `vnext/apps/gateway/tests/backend-selector.test.ts` — table-driven model→endpoint test.
- `vnext/apps/gateway/tests/repackage-error.test.ts` — per-protocol error envelope test.
- `vnext/apps/gateway/tests/chat-out.test.ts` — chat-out toUpstream / decodeBody / decodeSSE test.
- `vnext/apps/gateway/tests/messages-out.test.ts` — messages-out toUpstream / decodeBody / decodeSSE test.

**Modified:**
- `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts` — replace stub with real implementation.
- `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts` — replace stub with real implementation.
- `vnext/apps/gateway/src/data-plane/routes.ts` — dispatcher uses `chooseBackendEndpoint`, selects backend adapter, catches `HTTPError`, calls `repackageUpstreamError`.
- `vnext/apps/gateway/tests/chat.e2e.test.ts` — stub upstream `/chat/completions` instead of `/responses`; add 4xx repackage assertion.
- `vnext/apps/gateway/tests/messages.e2e.test.ts` — stub upstream `/messages` instead of `/responses`; add 4xx repackage assertion.

---

### Task 1: `chooseBackendEndpoint(model)` helper

**Files:**
- Create: `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts`
- Test: `vnext/apps/gateway/tests/backend-selector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/apps/gateway/tests/backend-selector.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { chooseBackendEndpoint } from '../src/data-plane/routing/backend-selector.ts'

test.each([
  ['gpt-5-mini', 'responses'],
  ['gpt-5', 'responses'],
  ['o1-preview', 'responses'],
  ['o3-mini', 'responses'],
  ['o4-mini', 'responses'],
  ['claude-3-5-sonnet-20241022', 'messages'],
  ['claude-opus-4-7', 'messages'],
  ['gpt-4o-mini', 'chat_completions'],
  ['gpt-4o', 'chat_completions'],
  ['gpt-3.5-turbo', 'chat_completions'],
  ['gemini-1.5-pro', 'chat_completions'],
  ['', 'chat_completions'],
] as const)('chooseBackendEndpoint(%s) → %s', (model, expected) => {
  expect(chooseBackendEndpoint(model)).toBe(expected)
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/backend-selector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts`:

```ts
/**
 * Heuristic mapping from model id to upstream endpoint. Plan 1 (Task #29) —
 * replaced in Plan 2 (Task #27) by a `ModelEndpoints` data-model lookup.
 *
 * Rules (case-insensitive on the bare model id, no upstream pin prefix):
 *   gpt-5* | o1* | o3* | o4*  → 'responses'
 *   claude-*                  → 'messages'
 *   everything else           → 'chat_completions'
 */
import type { EndpointKey } from '@vnext/protocols/common'

export function chooseBackendEndpoint(model: string): EndpointKey {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-5') || /^o[134](-|$)/.test(m)) return 'responses'
  if (m.startsWith('claude-')) return 'messages'
  return 'chat_completions'
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/backend-selector.test.ts`
Expected: PASS — all rows green.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routing/backend-selector.ts vnext/apps/gateway/tests/backend-selector.test.ts
git commit -m "feat(vnext/data-plane): add chooseBackendEndpoint model→endpoint heuristic"
```

---

### Task 2: `repackageUpstreamError(res, sourceApi)` mapper

**Files:**
- Create: `vnext/apps/gateway/src/data-plane/errors/repackage.ts`
- Test: `vnext/apps/gateway/tests/repackage-error.test.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/apps/gateway/tests/repackage-error.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { repackageUpstreamError } from '../src/data-plane/errors/repackage.ts'

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('messages source → Anthropic error envelope (400)', async () => {
  const up = jsonRes(400, { error: { message: 'bad model' } })
  const out = await repackageUpstreamError(up, 'messages')
  expect(out.status).toBe(400)
  const body = await out.json() as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('bad model')
})

test('chat_completions source → OpenAI error envelope (500)', async () => {
  const up = jsonRes(500, { error: { message: 'boom' } })
  const out = await repackageUpstreamError(up, 'chat_completions')
  expect(out.status).toBe(500)
  const body = await out.json() as { error: { type: string; message: string; code?: string } }
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('boom')
})

test('responses source → OpenAI Responses error envelope (404)', async () => {
  const up = jsonRes(404, { error: { message: 'model not found' } })
  const out = await repackageUpstreamError(up, 'responses')
  expect(out.status).toBe(404)
  const body = await out.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('model not found')
})

test('gemini source → Google error envelope (429)', async () => {
  const up = jsonRes(429, { error: { message: 'rate limited' } })
  const out = await repackageUpstreamError(up, 'gemini')
  expect(out.status).toBe(429)
  const body = await out.json() as { error: { code: number; message: string; status: string } }
  expect(body.error.code).toBe(429)
  expect(body.error.status).toBe('RESOURCE_EXHAUSTED')
  expect(body.error.message).toContain('rate limited')
})

test('non-JSON upstream body falls back to raw text', async () => {
  const up = new Response('upstream down', { status: 502, headers: { 'content-type': 'text/plain' } })
  const out = await repackageUpstreamError(up, 'chat_completions')
  expect(out.status).toBe(502)
  const body = await out.json() as { error: { message: string } }
  expect(body.error.message).toContain('upstream down')
})

test('unknown sourceApi → generic JSON passthrough', async () => {
  const up = jsonRes(418, { error: { message: 'teapot' } })
  const out = await repackageUpstreamError(up, undefined)
  expect(out.status).toBe(418)
  const body = await out.json() as { error: { message: string } }
  expect(body.error.message).toContain('teapot')
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/repackage-error.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mapper**

Create `vnext/apps/gateway/src/data-plane/errors/repackage.ts`:

```ts
/**
 * Repackage an upstream non-2xx Response into the inbound client protocol's
 * error envelope. Plan 1 (Task #29) — stays small on purpose; the protocol-
 * specific orchestrator error rendering belongs to a later interceptor layer.
 *
 * Behavior:
 *   - Status code is preserved verbatim.
 *   - The upstream body is parsed as JSON; we lift error.message / message
 *     out if present, otherwise stringify the entire body. Non-JSON bodies
 *     fall through to the raw text.
 *   - The envelope shape matches what the client SDK expects so users see
 *     a coherent error instead of an upstream-shaped object.
 */
export type SourceApi = 'messages' | 'chat_completions' | 'responses' | 'gemini' | undefined

interface ExtractedError {
  message: string
  type?: string
  code?: string
}

async function extractUpstream(res: Response): Promise<ExtractedError> {
  const text = await res.text()
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string; type?: string; code?: string }
        message?: string
      }
      const e = parsed.error
      if (e && typeof e.message === 'string') return { message: e.message, type: e.type, code: e.code }
      if (typeof parsed.message === 'string') return { message: parsed.message }
      return { message: text }
    } catch {
      return { message: text }
    }
  }
  return { message: text || `upstream returned ${res.status}` }
}

function geminiStatus(code: number): string {
  if (code === 400) return 'INVALID_ARGUMENT'
  if (code === 401) return 'UNAUTHENTICATED'
  if (code === 403) return 'PERMISSION_DENIED'
  if (code === 404) return 'NOT_FOUND'
  if (code === 429) return 'RESOURCE_EXHAUSTED'
  if (code >= 500) return 'INTERNAL'
  return 'UNKNOWN'
}

export async function repackageUpstreamError(res: Response, sourceApi: SourceApi): Promise<Response> {
  const { message, type, code } = await extractUpstream(res)
  const status = res.status
  let body: unknown
  if (sourceApi === 'messages') {
    body = {
      type: 'error',
      error: { type: type ?? (status >= 500 ? 'api_error' : 'invalid_request_error'), message },
    }
  } else if (sourceApi === 'chat_completions' || sourceApi === 'responses') {
    body = {
      error: {
        type: type ?? (status >= 500 ? 'api_error' : 'invalid_request_error'),
        message,
        code: code ?? null,
      },
    }
  } else if (sourceApi === 'gemini') {
    body = {
      error: { code: status, message, status: geminiStatus(status) },
    }
  } else {
    body = { error: { message, code: code ?? null } }
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/repackage-error.test.ts`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/errors/repackage.ts vnext/apps/gateway/tests/repackage-error.test.ts
git commit -m "feat(vnext/data-plane): add repackageUpstreamError per-protocol envelope mapper"
```

---

### Task 3: chat-out `toUpstream(req)` — IR → OpenAI Chat Completions request

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts`
- Test: `vnext/apps/gateway/tests/chat-out.test.ts`

- [ ] **Step 1: Write the failing test (toUpstream cases only)**

Create `vnext/apps/gateway/tests/chat-out.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { chatOut } from '../src/data-plane/adapters/backend/chat-out.ts'
import type { IRRequest } from '@vnext/protocols/ir'

const meta = { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'chat_completions' as const }

test('toUpstream maps text messages + max_output_tokens → max_tokens', () => {
  const req: IRRequest = {
    model: 'gpt-4o-mini',
    stream: false,
    max_output_tokens: 64,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ],
    meta,
  }
  const out = chatOut.toUpstream(req) as { model: string; stream: boolean; max_tokens: number; temperature: number; messages: Array<{ role: string; content: string }> }
  expect(out.model).toBe('gpt-4o-mini')
  expect(out.stream).toBe(false)
  expect(out.max_tokens).toBe(64)
  expect(out.temperature).toBe(0.2)
  expect(out.messages).toEqual([
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ])
})

test('toUpstream maps tool_use → assistant.tool_calls and tool_result → role:"tool"', () => {
  const req: IRRequest = {
    model: 'gpt-4o-mini',
    stream: false,
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', arguments: { city: 'sf' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', output: '72F' }],
      },
    ],
    tools: [{ type: 'function', name: 'get_weather', description: 'lookup', parameters: { type: 'object' } }],
    tool_choice: 'auto',
    meta,
  }
  const out = chatOut.toUpstream(req) as {
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
    tools: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
    tool_choice: string
  }
  expect(out.tools[0]?.type).toBe('function')
  expect(out.tools[0]?.function.name).toBe('get_weather')
  expect(out.tool_choice).toBe('auto')
  const asst = out.messages[1]
  expect(asst?.role).toBe('assistant')
  expect(asst?.content).toBeNull()
  expect(asst?.tool_calls?.[0]?.id).toBe('call_1')
  expect(asst?.tool_calls?.[0]?.function.name).toBe('get_weather')
  expect(JSON.parse(asst?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({ city: 'sf' })
  const tool = out.messages[2]
  expect(tool?.role).toBe('tool')
  expect(tool?.tool_call_id).toBe('call_1')
  expect(tool?.content).toBe('72F')
})

test('toUpstream translates structured tool_choice', () => {
  const req: IRRequest = {
    model: 'gpt-4o-mini',
    stream: false,
    messages: [{ role: 'user', content: 'go' }],
    tool_choice: { type: 'function', name: 'do_it' },
    meta,
  }
  const out = chatOut.toUpstream(req) as { tool_choice: { type: string; function: { name: string } } }
  expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'do_it' } })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/chat-out.test.ts`
Expected: FAIL — `chatOut.toUpstream: not implemented`.

- [ ] **Step 3: Implement `toUpstream` (replace stub)**

Open `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts` and replace its entire contents:

```ts
/**
 * Backend adapter: IR → upstream Chat Completions (and back). Plan 1 minimum:
 * covers input_text / output_text / tool_use / tool_result. Wider IR coverage
 * (input_image, reasoning, opaque) and Claude-special fields are Plan 3 scope.
 */
import type { BackendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function messageText(content: IRContentItem[]): string {
  let out = ''
  for (const c of content) {
    if (c.type === 'input_text' || c.type === 'output_text') out += c.text
  }
  return out
}

function toChatMessages(messages: IRMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const toolCalls = m.content
      .filter((c): c is Extract<IRContentItem, { type: 'tool_use' }> => c.type === 'tool_use')
      .map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.name,
          arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
        },
      }))
    const toolResults = m.content.filter((c): c is Extract<IRContentItem, { type: 'tool_result' }> => c.type === 'tool_result')
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const text = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? '')
        out.push({ role: 'tool', content: text, tool_call_id: tr.tool_use_id })
      }
      continue
    }
    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: null, tool_calls: toolCalls })
      continue
    }
    out.push({ role: m.role, content: messageText(m.content) })
  }
  return out
}

function translateToolChoice(tc: IRRequest['tool_choice']): unknown {
  if (tc === undefined) return undefined
  if (typeof tc === 'string') return tc
  return { type: 'function', function: { name: tc.name } }
}

export const chatOut: BackendAdapter = {
  toUpstream(req: IRRequest) {
    return {
      model: req.model,
      stream: req.stream,
      messages: toChatMessages(req.messages),
      max_tokens: req.max_output_tokens,
      temperature: req.temperature,
      top_p: req.top_p,
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: translateToolChoice(req.tool_choice),
      parallel_tool_calls: req.parallel_tool_calls,
    }
  },
  async *decodeSSE(): AsyncIterable<IREvent> {
    throw new Error('chatOut.decodeSSE: not implemented (Task 5)')
  },
  async *decodeBody(): AsyncIterable<IREvent> {
    throw new Error('chatOut.decodeBody: not implemented (Task 4)')
  },
}
```

- [ ] **Step 4: Run test, verify the 3 toUpstream cases pass**

Run: `cd vnext && bun test apps/gateway/tests/chat-out.test.ts`
Expected: 3 toUpstream tests pass (decodeBody / decodeSSE tests don't exist yet).

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts vnext/apps/gateway/tests/chat-out.test.ts
git commit -m "feat(vnext/chat-out): implement toUpstream (IR → Chat Completions request)"
```

---

### Task 4: chat-out `decodeBody(body)` — non-streaming response → IR events

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts`
- Test: `vnext/apps/gateway/tests/chat-out.test.ts`

- [ ] **Step 1: Append the failing tests**

Append to `vnext/apps/gateway/tests/chat-out.test.ts`:

```ts
import type { IREvent } from '@vnext/protocols/ir'

async function collect(iter: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

test('decodeBody emits created → text delta → completed with usage', async () => {
  const body = {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }
  const events = await collect(chatOut.decodeBody(body))
  expect(events[0]).toEqual({ type: 'response.created', response: { id: 'chatcmpl_1' } })
  const delta = events.find((e) => e.type === 'response.output_text.delta') as Extract<IREvent, { type: 'response.output_text.delta' }>
  expect(delta?.delta).toBe('Hello world')
  const done = events[events.length - 1] as Extract<IREvent, { type: 'response.completed' }>
  expect(done.type).toBe('response.completed')
  expect(done.response.finish_reason).toBe('stop')
  expect(done.response.usage?.input_tokens).toBe(5)
  expect(done.response.usage?.output_tokens).toBe(2)
})

test('decodeBody surfaces tool_calls as tool_call.completed events', async () => {
  const body = {
    id: 'chatcmpl_2',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sf"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  }
  const events = await collect(chatOut.decodeBody(body))
  const tc = events.find((e) => e.type === 'response.tool_call.completed') as Extract<IREvent, { type: 'response.tool_call.completed' }>
  expect(tc.itemId).toBe('call_1')
  expect(tc.name).toBe('get_weather')
  expect(tc.arguments).toEqual({ city: 'sf' })
  const done = events[events.length - 1] as Extract<IREvent, { type: 'response.completed' }>
  expect(done.response.finish_reason).toBe('tool_calls')
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/chat-out.test.ts`
Expected: 2 new tests FAIL with `chatOut.decodeBody: not implemented`.

- [ ] **Step 3: Implement `decodeBody`**

In `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts`, replace the `decodeBody` method:

```ts
  async *decodeBody(body: unknown): AsyncIterable<IREvent> {
    const r = body as {
      id?: string
      choices?: Array<{
        message?: { role?: string; content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
        finish_reason?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    yield { type: 'response.created', response: { id: r.id ?? '' } }
    const choice = r.choices?.[0]
    const msg = choice?.message
    if (msg?.content && typeof msg.content === 'string') {
      yield { type: 'response.output_text.delta', delta: msg.content }
    }
    for (const tc of msg?.tool_calls ?? []) {
      let parsed: unknown = {}
      try { parsed = JSON.parse(tc.function.arguments) } catch { parsed = tc.function.arguments }
      yield {
        type: 'response.tool_call.completed',
        itemId: tc.id,
        name: tc.function.name,
        arguments: parsed,
      }
    }
    yield {
      type: 'response.completed',
      response: {
        id: r.id,
        finish_reason: choice?.finish_reason ?? 'stop',
        usage: r.usage ? {
          input_tokens: r.usage.prompt_tokens ?? 0,
          output_tokens: r.usage.completion_tokens ?? 0,
        } : undefined,
      },
    }
  },
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/chat-out.test.ts`
Expected: 2 new decodeBody tests pass.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts vnext/apps/gateway/tests/chat-out.test.ts
git commit -m "feat(vnext/chat-out): implement decodeBody (Chat Completions JSON → IR events)"
```

---

### Task 5: chat-out `decodeSSE(stream)` — streaming chunks → IR events

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts`
- Test: `vnext/apps/gateway/tests/chat-out.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `vnext/apps/gateway/tests/chat-out.test.ts`:

```ts
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

test('decodeSSE emits text deltas and completed with finish_reason', async () => {
  const chunks = [
    `data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: { content: ' world' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: [DONE]\n\n`,
  ]
  const events = await collect(chatOut.decodeSSE(sseStream(chunks)))
  expect(events[0]?.type).toBe('response.created')
  const deltas = events.filter((e) => e.type === 'response.output_text.delta') as Array<Extract<IREvent, { type: 'response.output_text.delta' }>>
  expect(deltas.map((d) => d.delta).join('')).toBe('Hello world')
  const done = events[events.length - 1] as Extract<IREvent, { type: 'response.completed' }>
  expect(done.type).toBe('response.completed')
  expect(done.response.finish_reason).toBe('stop')
})

test('decodeSSE accumulates tool_call argument fragments', async () => {
  const chunks = [
    `data: ${JSON.stringify({ id: 'cmpl_2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'do_it', arguments: '{"a":' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'cmpl_2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'cmpl_2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    `data: [DONE]\n\n`,
  ]
  const events = await collect(chatOut.decodeSSE(sseStream(chunks)))
  const tc = events.find((e) => e.type === 'response.tool_call.completed') as Extract<IREvent, { type: 'response.tool_call.completed' }>
  expect(tc.itemId).toBe('call_1')
  expect(tc.name).toBe('do_it')
  expect(tc.arguments).toEqual({ a: 1 })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/chat-out.test.ts`
Expected: 2 new tests FAIL with `chatOut.decodeSSE: not implemented (Task 5)`.

- [ ] **Step 3: Implement `decodeSSE`**

In `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts`, replace the `decodeSSE` method:

```ts
  async *decodeSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<IREvent> {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let respId = ''
    let finishReason = 'stop'
    let createdEmitted = false
    const toolAcc = new Map<number, { id: string; name: string; argsBuf: string }>()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const dataLines = f.split('\n').filter((ln) => ln.startsWith('data:'))
        if (dataLines.length === 0) continue
        const data = dataLines.map((ln) => ln.slice(5).trim()).join('')
        if (!data || data === '[DONE]') continue
        let chunk: {
          id?: string
          choices?: Array<{
            delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
            finish_reason?: string | null
          }>
        }
        try { chunk = JSON.parse(data) } catch { continue }
        if (!createdEmitted) {
          respId = chunk.id ?? ''
          yield { type: 'response.created', response: { id: respId } }
          createdEmitted = true
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) {
          yield { type: 'response.output_text.delta', delta: delta.content }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = toolAcc.get(tc.index) ?? { id: '', name: '', argsBuf: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.argsBuf += tc.function.arguments
          toolAcc.set(tc.index, slot)
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
      }
    }
    for (const slot of toolAcc.values()) {
      let parsed: unknown = {}
      try { parsed = JSON.parse(slot.argsBuf) } catch { parsed = slot.argsBuf }
      yield { type: 'response.tool_call.completed', itemId: slot.id, name: slot.name, arguments: parsed }
    }
    yield { type: 'response.completed', response: { id: respId, finish_reason: finishReason } }
  },
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/chat-out.test.ts`
Expected: all chat-out tests pass (7 total).

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts vnext/apps/gateway/tests/chat-out.test.ts
git commit -m "feat(vnext/chat-out): implement decodeSSE with tool_call argument accumulator"
```

---

### Task 6: messages-out `toUpstream(req)` — IR → Anthropic Messages request

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts`
- Test: `vnext/apps/gateway/tests/messages-out.test.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/apps/gateway/tests/messages-out.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { messagesOut } from '../src/data-plane/adapters/backend/messages-out.ts'
import type { IRRequest } from '@vnext/protocols/ir'

const meta = { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'messages' as const }

test('toUpstream concatenates system messages into top-level system field', () => {
  const req: IRRequest = {
    model: 'claude-3-5-sonnet-20241022',
    stream: false,
    max_output_tokens: 256,
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'no emojis' },
      { role: 'user', content: 'hi' },
    ],
    meta,
  }
  const out = messagesOut.toUpstream(req) as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: unknown }> }
  expect(out.model).toBe('claude-3-5-sonnet-20241022')
  expect(out.max_tokens).toBe(256)
  expect(out.system).toContain('be terse')
  expect(out.system).toContain('no emojis')
  expect(out.messages).toHaveLength(1)
  expect(out.messages[0]?.role).toBe('user')
})

test('toUpstream defaults max_tokens to 4096 when missing', () => {
  const req: IRRequest = {
    model: 'claude-3-5-sonnet-20241022',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
    meta,
  }
  const out = messagesOut.toUpstream(req) as { max_tokens: number }
  expect(out.max_tokens).toBe(4096)
})

test('toUpstream maps tool_use / tool_result content blocks', () => {
  const req: IRRequest = {
    model: 'claude-3-5-sonnet-20241022',
    stream: false,
    max_output_tokens: 64,
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', arguments: { city: 'sf' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', output: '72F' }] },
    ],
    tools: [{ type: 'function', name: 'get_weather', description: 'lookup', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'get_weather' },
    meta,
  }
  const out = messagesOut.toUpstream(req) as {
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    tools: Array<{ name: string; description?: string; input_schema?: unknown }>
    tool_choice: { type: string; name?: string }
  }
  expect(out.tools[0]?.name).toBe('get_weather')
  expect(out.tools[0]?.input_schema).toEqual({ type: 'object' })
  expect(out.tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
  expect(out.messages[1]?.content[0]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } })
  expect(out.messages[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: '72F' })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/messages-out.test.ts`
Expected: FAIL with `messagesOut.toUpstream: not implemented`.

- [ ] **Step 3: Implement `toUpstream` (replace stub)**

Open `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts` and replace its entire contents:

```ts
/**
 * Backend adapter: IR → upstream Anthropic Messages (and back). Plan 1 minimum:
 * input_text / output_text / tool_use / tool_result. Plan 3 adds thinking and
 * citations round-trip.
 */
import type { BackendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'

interface AnthropicBlock { type: string; [k: string]: unknown }
interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

function blocksFor(content: IRContentItem[]): AnthropicBlock[] {
  const out: AnthropicBlock[] = []
  for (const c of content) {
    if (c.type === 'input_text' || c.type === 'output_text') {
      out.push({ type: 'text', text: c.text })
    } else if (c.type === 'tool_use') {
      out.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} })
    } else if (c.type === 'tool_result') {
      const text = typeof c.output === 'string' ? c.output : JSON.stringify(c.output ?? '')
      out.push({ type: 'tool_result', tool_use_id: c.tool_use_id, content: text })
    }
  }
  return out
}

function toAnthropicMessages(messages: IRMessage[]): { system: string; messages: AnthropicMessage[] } {
  const sys: string[] = []
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      sys.push(typeof m.content === 'string' ? m.content : blocksFor(m.content).map((b) => (b.type === 'text' ? (b.text as string) : '')).join(''))
      continue
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
    const content = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content } as AnthropicBlock]
      : blocksFor(m.content)
    out.push({ role, content })
  }
  return { system: sys.join('\n\n'), messages: out }
}

function translateToolChoice(tc: IRRequest['tool_choice']): unknown {
  if (tc === undefined) return undefined
  if (tc === 'auto' || tc === 'none') return { type: tc }
  if (tc === 'required') return { type: 'any' }
  return { type: 'tool', name: tc.name }
}

export const messagesOut: BackendAdapter = {
  toUpstream(req: IRRequest) {
    const { system, messages } = toAnthropicMessages(req.messages)
    return {
      model: req.model,
      max_tokens: req.max_output_tokens ?? 4096,
      stream: req.stream,
      temperature: req.temperature,
      top_p: req.top_p,
      system: system || undefined,
      messages,
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      tool_choice: translateToolChoice(req.tool_choice),
    }
  },
  async *decodeSSE(): AsyncIterable<IREvent> {
    throw new Error('messagesOut.decodeSSE: not implemented (Task 8)')
  },
  async *decodeBody(): AsyncIterable<IREvent> {
    throw new Error('messagesOut.decodeBody: not implemented (Task 7)')
  },
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/messages-out.test.ts`
Expected: 3 toUpstream tests pass.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts vnext/apps/gateway/tests/messages-out.test.ts
git commit -m "feat(vnext/messages-out): implement toUpstream (IR → Anthropic Messages request)"
```

---

### Task 7: messages-out `decodeBody(body)` — Anthropic response → IR events

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts`
- Test: `vnext/apps/gateway/tests/messages-out.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `vnext/apps/gateway/tests/messages-out.test.ts`:

```ts
import type { IREvent } from '@vnext/protocols/ir'

async function collect(iter: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

test('decodeBody maps Anthropic message → created/text/tool_call/completed', async () => {
  const body = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'thinking…' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 7 },
  }
  const events = await collect(messagesOut.decodeBody(body))
  expect(events[0]).toEqual({ type: 'response.created', response: { id: 'msg_1' } })
  const delta = events.find((e) => e.type === 'response.output_text.delta') as Extract<IREvent, { type: 'response.output_text.delta' }>
  expect(delta.delta).toBe('thinking…')
  const tc = events.find((e) => e.type === 'response.tool_call.completed') as Extract<IREvent, { type: 'response.tool_call.completed' }>
  expect(tc.itemId).toBe('toolu_1')
  expect(tc.name).toBe('get_weather')
  expect(tc.arguments).toEqual({ city: 'sf' })
  const done = events[events.length - 1] as Extract<IREvent, { type: 'response.completed' }>
  expect(done.response.finish_reason).toBe('tool_use')
  expect(done.response.usage?.input_tokens).toBe(11)
  expect(done.response.usage?.output_tokens).toBe(7)
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/messages-out.test.ts`
Expected: FAIL with `messagesOut.decodeBody: not implemented (Task 7)`.

- [ ] **Step 3: Implement `decodeBody`**

In `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts`, replace the `decodeBody` method:

```ts
  async *decodeBody(body: unknown): AsyncIterable<IREvent> {
    const r = body as {
      id?: string
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
      stop_reason?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    yield { type: 'response.created', response: { id: r.id ?? '' } }
    for (const block of r.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        yield { type: 'response.output_text.delta', delta: block.text }
      } else if (block.type === 'tool_use') {
        yield {
          type: 'response.tool_call.completed',
          itemId: block.id ?? '',
          name: block.name ?? '',
          arguments: block.input ?? {},
        }
      }
    }
    yield {
      type: 'response.completed',
      response: {
        id: r.id,
        finish_reason: r.stop_reason ?? 'stop',
        usage: r.usage ? {
          input_tokens: r.usage.input_tokens ?? 0,
          output_tokens: r.usage.output_tokens ?? 0,
        } : undefined,
      },
    }
  },
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/messages-out.test.ts`
Expected: decodeBody test passes.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts vnext/apps/gateway/tests/messages-out.test.ts
git commit -m "feat(vnext/messages-out): implement decodeBody (Anthropic JSON → IR events)"
```

---

### Task 8: messages-out `decodeSSE(stream)` — Anthropic SSE → IR events

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts`
- Test: `vnext/apps/gateway/tests/messages-out.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `vnext/apps/gateway/tests/messages-out.test.ts`:

```ts
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

test('decodeSSE translates Anthropic SSE event types → IR events', async () => {
  const chunks = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ]
  const events = await collect(messagesOut.decodeSSE(sseStream(chunks)))
  expect(events[0]?.type).toBe('response.created')
  const deltas = events.filter((e) => e.type === 'response.output_text.delta') as Array<Extract<IREvent, { type: 'response.output_text.delta' }>>
  expect(deltas.map((d) => d.delta).join('')).toBe('Hello world')
  const done = events[events.length - 1] as Extract<IREvent, { type: 'response.completed' }>
  expect(done.type).toBe('response.completed')
  expect(done.response.finish_reason).toBe('end_turn')
  expect(done.response.usage?.input_tokens).toBe(5)
  expect(done.response.usage?.output_tokens).toBe(2)
})

test('decodeSSE accumulates tool_use input_json_delta into a completed tool call', async () => {
  const chunks = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2' } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'do_it', input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ]
  const events = await collect(messagesOut.decodeSSE(sseStream(chunks)))
  const tc = events.find((e) => e.type === 'response.tool_call.completed') as Extract<IREvent, { type: 'response.tool_call.completed' }>
  expect(tc.itemId).toBe('toolu_1')
  expect(tc.name).toBe('do_it')
  expect(tc.arguments).toEqual({ a: 1 })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd vnext && bun test apps/gateway/tests/messages-out.test.ts`
Expected: 2 new tests FAIL with `messagesOut.decodeSSE: not implemented (Task 8)`.

- [ ] **Step 3: Implement `decodeSSE`**

In `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts`, replace the `decodeSSE` method:

```ts
  async *decodeSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<IREvent> {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let respId = ''
    let createdEmitted = false
    let finishReason = 'stop'
    let inputTokens = 0
    let outputTokens = 0
    const blocks = new Map<number, { kind: 'text' | 'tool_use'; toolId?: string; toolName?: string; jsonBuf?: string }>()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const dataLines = f.split('\n').filter((ln) => ln.startsWith('data:'))
        if (dataLines.length === 0) continue
        const data = dataLines.map((ln) => ln.slice(5).trim()).join('')
        if (!data) continue
        let evt: {
          type?: string
          message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
          index?: number
          content_block?: { type?: string; id?: string; name?: string }
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
          usage?: { output_tokens?: number }
        }
        try { evt = JSON.parse(data) } catch { continue }
        if (evt.type === 'message_start') {
          respId = evt.message?.id ?? ''
          if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens
          if (!createdEmitted) {
            yield { type: 'response.created', response: { id: respId } }
            createdEmitted = true
          }
        } else if (evt.type === 'content_block_start' && typeof evt.index === 'number') {
          const cb = evt.content_block
          if (cb?.type === 'tool_use') {
            blocks.set(evt.index, { kind: 'tool_use', toolId: cb.id, toolName: cb.name, jsonBuf: '' })
          } else {
            blocks.set(evt.index, { kind: 'text' })
          }
        } else if (evt.type === 'content_block_delta' && typeof evt.index === 'number') {
          const slot = blocks.get(evt.index)
          if (!slot) continue
          if (evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
            yield { type: 'response.output_text.delta', delta: evt.delta.text }
          } else if (evt.delta?.type === 'input_json_delta' && typeof evt.delta.partial_json === 'string') {
            slot.jsonBuf = (slot.jsonBuf ?? '') + evt.delta.partial_json
          }
        } else if (evt.type === 'content_block_stop' && typeof evt.index === 'number') {
          const slot = blocks.get(evt.index)
          if (slot?.kind === 'tool_use') {
            let parsed: unknown = {}
            try { parsed = JSON.parse(slot.jsonBuf ?? '{}') } catch { parsed = slot.jsonBuf ?? '' }
            yield {
              type: 'response.tool_call.completed',
              itemId: slot.toolId ?? '',
              name: slot.toolName ?? '',
              arguments: parsed,
            }
          }
        } else if (evt.type === 'message_delta') {
          if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason
          if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens
        }
      }
    }
    yield {
      type: 'response.completed',
      response: {
        id: respId,
        finish_reason: finishReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }
  },
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd vnext && bun test apps/gateway/tests/messages-out.test.ts`
Expected: all 5 messages-out tests pass.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts vnext/apps/gateway/tests/messages-out.test.ts
git commit -m "feat(vnext/messages-out): implement decodeSSE with tool_use input_json accumulator"
```

---

### Task 9: Wire dispatcher — endpoint selection + error repackage

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

This task has no new isolated test — it's covered by Task 10's e2e updates.

- [ ] **Step 1: Read the current dispatcher**

Run: `cat vnext/apps/gateway/src/data-plane/routes.ts | head -100`
Confirm the current `dispatch` function hardcodes `'responses'` at line ~57 and uses `responsesOut` at line ~69.

- [ ] **Step 2: Modify imports**

In `vnext/apps/gateway/src/data-plane/routes.ts`, replace the import block at the top:

```ts
/** Data-plane routes. Plan 1 (Task #29): endpoint chosen per model; backend adapter per endpoint; HTTPError + non-2xx caught and repackaged. */
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import { messagesIn } from './adapters/frontend/messages-in.ts'
import { chatIn } from './adapters/frontend/chat-in.ts'
import { responsesIn } from './adapters/frontend/responses-in.ts'
import { geminiIn } from './adapters/frontend/gemini-in.ts'
import { responsesOut } from './adapters/backend/responses-out.ts'
import { chatOut } from './adapters/backend/chat-out.ts'
import { messagesOut } from './adapters/backend/messages-out.ts'
import type { BackendAdapter, FrontendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent } from '@vnext/protocols/ir'
import type { EndpointKey } from '@vnext/protocols/common'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { resolveBinding, parseModelRouting } from './routing/binding-resolver.ts'
import { chooseBackendEndpoint } from './routing/backend-selector.ts'
import { repackageUpstreamError, type SourceApi } from './errors/repackage.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { handleMessagesWebSearch, hasWebSearch } from './orchestrator/server-tools/plugins/web-search/index.ts'
import { handleResponsesImageGeneration, hasImageGeneration } from './orchestrator/server-tools/plugins/image-generation/index.ts'
```

- [ ] **Step 3: Replace the `dispatch` function**

In `vnext/apps/gateway/src/data-plane/routes.ts`, replace the entire `async function dispatch<TPayload>` block (currently lines ~33-90) with:

```ts
function backendForEndpoint(endpoint: EndpointKey): BackendAdapter {
  if (endpoint === 'chat_completions') return chatOut
  if (endpoint === 'messages') return messagesOut
  return responsesOut
}

async function dispatch<TPayload>(
  c: { req: { json: () => Promise<unknown> }; json: (b: unknown, s?: number) => Response; body: (b: BodyInit, s?: number, h?: Record<string, string>) => Response },
  adapter: FrontendAdapter<TPayload>,
  toIR: (payload: TPayload) => IRRequest,
  errorWrap: (status: number, body: unknown) => Response,
  auth: DataPlaneAuthCtx,
  sourceApi: SourceApi,
): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return errorWrap(400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } })
  }
  let payload: TPayload
  try { payload = adapter.parse(raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return errorWrap(e.status ?? 400, e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } })
  }
  const ir = toIR(payload)
  const requestedModel = ir.model
  const { bareModel } = parseModelRouting(requestedModel)
  if (bareModel !== requestedModel) ir.model = bareModel

  const upstreamEndpoint = chooseBackendEndpoint(bareModel)
  const backend = backendForEndpoint(upstreamEndpoint)

  const binding = await resolveBinding(requestedModel, upstreamEndpoint, {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    return errorWrap(404, {
      error: {
        type: 'invalid_request_error',
        message: `No upstream serves model "${requestedModel}" on endpoint "${upstreamEndpoint}". Run GET /v1/models for available ids.`,
      },
    })
  }
  const upstreamPayload = backend.toUpstream(ir)
  let upstreamRes: Response
  try {
    upstreamRes = await binding.provider.fetch(
      upstreamEndpoint,
      { method: 'POST', body: JSON.stringify(upstreamPayload), headers: { 'content-type': 'application/json' } },
      { operationName: 'data-plane dispatch', enabledFlags: binding.enabledFlags, sourceApi },
    )
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, sourceApi)
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return errorWrap(502, { error: { type: 'api_error', message } })
  }
  if (!upstreamRes.ok) {
    return await repackageUpstreamError(upstreamRes, sourceApi)
  }
  if (ir.stream) {
    const events = upstreamRes.body
      ? backend.decodeSSE(upstreamRes.body)
      : (async function* (): AsyncIterable<IREvent> { /* empty */ })()
    const out = adapter.encodeSSE(events)
    return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  const upstreamJson = await upstreamRes.json()
  const events = backend.decodeBody(upstreamJson)
  const body = await adapter.encodeBody(events)
  return Response.json(body)
}
```

- [ ] **Step 4: Update the gemini route's `sourceApi` argument**

Find the `/v1beta/models/:model{.+}` handler (currently passes `undefined` for sourceApi) and change the final argument from `undefined` to `'gemini'`:

```ts
  return dispatch(c, geminiIn, (p) => {
    const ir = geminiIn.toIRForModel(p, model ?? '')
    ir.stream = stream
    return ir
  }, (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx,
    'gemini',
  )
```

- [ ] **Step 5: Type-check**

Run: `cd vnext/apps/gateway && bun run typecheck || bun x tsc --noEmit`
Expected: no new errors. If `bun run typecheck` script doesn't exist, use the tsc invocation.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts
git commit -m "feat(vnext/data-plane): pick backend by model, wrap upstream errors in client protocol"
```

---

### Task 10: Update existing e2e tests for per-protocol upstream endpoints

**Files:**
- Modify: `vnext/apps/gateway/tests/chat.e2e.test.ts`
- Modify: `vnext/apps/gateway/tests/messages.e2e.test.ts`

- [ ] **Step 1: Run the failing e2e tests**

Run: `cd vnext && bun test apps/gateway/tests/chat.e2e.test.ts apps/gateway/tests/messages.e2e.test.ts`
Expected: FAIL — both stub `/responses` upstream but dispatcher now calls `/chat/completions` / `/messages`.

- [ ] **Step 2: Update `chat.e2e.test.ts` upstream stubs**

In `vnext/apps/gateway/tests/chat.e2e.test.ts`, replace `upstreamJson` and `makeUpstreamSSE` and `installCopilotFetch` (lines ~79-112) with chat-completions-shaped fixtures:

```ts
const upstreamJson = {
  id: 'chatcmpl_upstream_1',
  object: 'chat.completion',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Hello from upstream' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
}

function makeUpstreamSSE(): Response {
  const body = [
    `data: ${JSON.stringify({ id: 'chatcmpl_upstream_1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl_upstream_1', choices: [{ index: 0, delta: { content: ' from upstream' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl_upstream_1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function installCopilotFetch(opts: { stream: boolean; upstreamStatus?: number; upstreamBody?: unknown }) {
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/chat/completions')) {
      if (opts.upstreamStatus && opts.upstreamStatus >= 400) {
        return new Response(JSON.stringify(opts.upstreamBody ?? { error: { message: 'upstream sad' } }), {
          status: opts.upstreamStatus, headers: { 'content-type': 'application/json' },
        })
      }
      if (opts.stream) return makeUpstreamSSE()
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}
```

- [ ] **Step 3: Append a 4xx-repackage test to `chat.e2e.test.ts`**

Add at the end of `vnext/apps/gateway/tests/chat.e2e.test.ts`:

```ts
test('POST /v1/chat/completions surfaces upstream 400 as OpenAI error envelope', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false, upstreamStatus: 400, upstreamBody: { error: { message: 'model not allowed' } } })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('model not allowed')
})
```

- [ ] **Step 4: Update `messages.e2e.test.ts` upstream stubs**

In `vnext/apps/gateway/tests/messages.e2e.test.ts`, replace `upstreamJson`, `makeUpstreamSSE`, and `installCopilotFetch`:

```ts
const upstreamJson = {
  id: 'msg_upstream_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello from upstream' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 7 },
}

function makeUpstreamSSE(): Response {
  const body = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_upstream_1', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from upstream' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function installCopilotFetch(opts: { stream: boolean; upstreamStatus?: number; upstreamBody?: unknown }) {
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/v1/messages')) {
      if (opts.upstreamStatus && opts.upstreamStatus >= 400) {
        return new Response(JSON.stringify(opts.upstreamBody ?? { error: { message: 'upstream sad' } }), {
          status: opts.upstreamStatus, headers: { 'content-type': 'application/json' },
        })
      }
      if (opts.stream) return makeUpstreamSSE()
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}
```

- [ ] **Step 5: Append a 5xx-repackage test to `messages.e2e.test.ts`**

Add at the end of `vnext/apps/gateway/tests/messages.e2e.test.ts`:

```ts
test('POST /v1/messages surfaces upstream 503 as Anthropic error envelope', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false, upstreamStatus: 503, upstreamBody: { error: { message: 'upstream overloaded' } } })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(503)
  const body = await res.json() as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('upstream overloaded')
})
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `cd vnext && bun test apps/gateway/tests/chat.e2e.test.ts apps/gateway/tests/messages.e2e.test.ts`
Expected: all e2e tests pass (original 3+3 + 2 new = 8).

- [ ] **Step 7: Commit**

```bash
git add vnext/apps/gateway/tests/chat.e2e.test.ts vnext/apps/gateway/tests/messages.e2e.test.ts
git commit -m "test(vnext): point chat/messages e2e at per-protocol upstream + add 4xx/5xx repackage"
```

---

### Task 11: Full suite + manual T10 smoke verification

- [ ] **Step 1: Run full vnext test suite**

Run: `cd vnext && bun test`
Expected: all tests pass. If `responses.e2e.test.ts` or `gemini.e2e.test.ts` regress (they may still stub `/responses` correctly — gpt-5 routes there), fix the stubs the same way as Task 10.

- [ ] **Step 2: Smoke checklist (manual, post-merge into vNext)**

Document in commit message or PR body the manual smoke results against a live Copilot upstream:

```
- gpt-5-mini   via /v1/responses           → 200 with text                       PASS/FAIL
- gpt-4o-mini  via /v1/chat/completions    → 200 with chat.completion body       PASS/FAIL
- claude-3-5-sonnet via /v1/messages       → 200 with Anthropic message body     PASS/FAIL
- gpt-4o-mini  via /v1/responses           → 4xx repackaged as OpenAI envelope   PASS/FAIL
- unknown-model via any endpoint           → 404 with "no upstream serves..."    PASS/FAIL
```

- [ ] **Step 3: Final commit (if smoke notes go in repo)**

If documenting results in repo, save under `vnext/docs/superpowers/specs/2026-06-11-dispatcher-error-handling-and-minimal-chat-backend-design.md` as a "T10 results" appendix.

```bash
git add vnext/docs/superpowers/specs/2026-06-11-dispatcher-error-handling-and-minimal-chat-backend-design.md
git commit -m "docs(vnext): record T10 dispatcher smoke results"
```
