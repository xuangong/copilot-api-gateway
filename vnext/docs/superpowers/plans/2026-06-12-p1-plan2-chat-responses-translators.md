# P1 Plan 2 — chat↔responses translator pair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two missing translator pairs — `chat_completions ⇄ responses` — so that a `chat_completions` client can be served by a Responses-only model and a `responses` client can be served by a ChatCompletions-only model. Closes the last two edges in the pairwise translator mesh.

**Architecture:** Two new sibling directories under `packages/translate/src/` mirroring the existing pair convention (`request.ts` / `events.ts` / `body.ts` / `index.ts`). Each pair exports three pure functions wrapped uniformly into a `PairTranslator` in `apps/gateway/.../dispatch/translator-registry.ts`. No new dependencies. No state. Pair selector PREFERENCE table is unchanged — the registry simply gains two TABLE entries.

**Tech Stack:** TypeScript, Bun test, `@vnext/protocols/chat`, `@vnext/protocols/responses`. Reference templates: `messages-via-responses/` and `responses-via-messages/` for shape, `chat-completions-via-messages/` for the chat side.

---

## Spec mapping

This plan covers the spec section "3. 新翻译对子" (`chat-completions-via-responses/` and `responses-via-chat-completions/`) and the registry registration step under "注册". The store, bridge, routes wiring, and verbatim-error envelope are deferred to Plan 3. The store package itself is Plan 1.

## File structure

New translator files (all under `vnext/packages/translate/`):

- `src/chat-completions-via-responses/index.ts` — re-exports
- `src/chat-completions-via-responses/request.ts` — `translateChatToResponses(payload, options)` → `{ target: ResponsesPayload }`
- `src/chat-completions-via-responses/events.ts` — `translateResponsesToChatSSE(events)` async generator
- `src/chat-completions-via-responses/body.ts` — `translateResponsesToChatBody(body)` non-streaming JSON
- `src/responses-via-chat-completions/index.ts` — re-exports
- `src/responses-via-chat-completions/request.ts` — `translateResponsesToChat(payload)` → `{ target: ChatPayload }`
- `src/responses-via-chat-completions/events.ts` — `translateChatToResponsesEvents(events)` async generator
- `src/responses-via-chat-completions/body.ts` — `translateChatToResponsesBody(body)` non-streaming JSON

Tests (one file per source, mirroring `tests/messages-via-responses/`):

- `tests/chat-completions-via-responses/request.test.ts`
- `tests/chat-completions-via-responses/events.test.ts`
- `tests/chat-completions-via-responses/body.test.ts`
- `tests/responses-via-chat-completions/request.test.ts`
- `tests/responses-via-chat-completions/events.test.ts`
- `tests/responses-via-chat-completions/body.test.ts`

Modified:

- `vnext/packages/translate/package.json` — add 2 new entries under `exports`
- `vnext/apps/gateway/src/data-plane/dispatch/translator-registry.ts` — add 2 wrappers + 2 TABLE entries

---

## Task 1: Scaffold `chat-completions-via-responses` package directory

**Files:**
- Create: `vnext/packages/translate/src/chat-completions-via-responses/index.ts`
- Create: `vnext/packages/translate/src/chat-completions-via-responses/request.ts` (stub)
- Create: `vnext/packages/translate/src/chat-completions-via-responses/events.ts` (stub)
- Create: `vnext/packages/translate/src/chat-completions-via-responses/body.ts` (stub)
- Modify: `vnext/packages/translate/package.json`

- [ ] **Step 1: Add export entry to package.json**

Add under `"exports"`:

```json
"./chat-completions-via-responses": "./src/chat-completions-via-responses/index.ts",
```

(Preserve trailing-comma style of the surrounding map.)

- [ ] **Step 2: Write `index.ts`**

```ts
export { translateChatToResponses, type TranslateChatToResponsesOptions } from './request.ts'
export { translateResponsesToChatSSE } from './events.ts'
export { translateResponsesToChatBody } from './body.ts'
```

- [ ] **Step 3: Write stubs that throw**

`request.ts`:

```ts
import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface TranslateChatToResponsesOptions {
  fallbackMaxOutputTokens?: number
}

export interface ChatToResponsesRequestResult {
  target: ResponsesPayload
}

export function translateChatToResponses(
  _payload: ChatPayload,
  _options?: TranslateChatToResponsesOptions,
): ChatToResponsesRequestResult {
  throw new Error('translateChatToResponses: not implemented')
}
```

`events.ts`:

```ts
export async function* translateResponsesToChatSSE(
  _events: AsyncIterable<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  throw new Error('translateResponsesToChatSSE: not implemented')
}
```

`body.ts`:

```ts
export function translateResponsesToChatBody(_body: unknown): unknown {
  throw new Error('translateResponsesToChatBody: not implemented')
}
```

- [ ] **Step 4: Verify workspace typechecks**

Run: `cd vnext/packages/translate && bun run typecheck`
Expected: PASS (stubs are well-typed).

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/package.json \
        vnext/packages/translate/src/chat-completions-via-responses/
git commit -m "feat(translate): scaffold chat-completions-via-responses pair"
```

---

## Task 2: `chat-completions-via-responses/request.ts` — translate Chat payload → Responses payload

**Files:**
- Modify: `vnext/packages/translate/src/chat-completions-via-responses/request.ts`
- Test: `vnext/packages/translate/tests/chat-completions-via-responses/request.test.ts`

**Translation contract (faithful, minimal):**

| Chat field | Responses field | Notes |
|---|---|---|
| `model` | `model` | passthrough |
| `messages[role=system]` (one or many) | `instructions` (joined `\n\n`) | strip from input |
| `messages[role=user]` (string) | input item `{type:'message', role:'user', content: string}` | |
| `messages[role=user]` (array of parts) | input item `{type:'message', role:'user', content: [...]}` | `text` parts → `{type:'input_text', text}`; `image_url` parts → `{type:'input_image', text: url}` |
| `messages[role=assistant]` (string) | input item `{type:'message', role:'assistant', content: string}` | |
| `messages[role=assistant]` with `tool_calls[]` | series of `{type:'function_call', call_id, name, arguments}` | `arguments` is the original JSON string (already a string in Chat) |
| `messages[role=tool]` | `{type:'function_call_output', call_id, output: content}` | `tool_call_id` → `call_id`; content stringified if object |
| `tools[]` (chat function) | `tools[]` `{type:'function', name, description?, parameters, strict:false}` | preserve order |
| `tool_choice` | `tool_choice` | `'auto'/'required'/'none'` passthrough; object `{type:'function', function:{name}}` → `{type:'function', name}` |
| `temperature`, `top_p`, `metadata` | passthrough | omit when undefined |
| `max_tokens` (or option fallback) | `max_output_tokens` | fallback applied only when caller omits |
| `stream` | `stream` | default true if absent (matches existing translator family convention) |

Out of scope: `logprobs`, `n`, `seed`, `response_format`, `stop` (drop with no synthesis — matches messages-via-responses faithfulness).

- [ ] **Step 1: Write failing tests**

`tests/chat-completions-via-responses/request.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { translateChatToResponses } from '../../src/chat-completions-via-responses/index.ts'

describe('translateChatToResponses', () => {
  test('user-only string message produces single input message', () => {
    const out = translateChatToResponses({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hello' }],
    } as never)
    expect(out.target.model).toBe('gpt-x')
    expect(out.target.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])
    expect(out.target.stream).toBe(true)
    expect(out.target.instructions).toBeUndefined()
  })

  test('multiple system messages merge into instructions', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    } as never)
    expect(out.target.instructions).toBe('A\n\nB')
    expect(out.target.input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
    ])
  })

  test('image_url part becomes input_image', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        ],
      }],
    } as never)
    expect(out.target.input).toEqual([{
      type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: 'see' },
        { type: 'input_image', text: 'https://x/y.png' },
      ],
    }])
  })

  test('assistant tool_calls become function_call items', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      ],
    } as never)
    expect(out.target.input).toEqual([
      { type: 'message', role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ])
  })

  test('tools[] become function tools with strict:false', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    } as never)
    expect(out.target.tools).toEqual([
      { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: false },
    ])
    expect(out.target.tool_choice).toBe('auto')
  })

  test('tool_choice object → function-name shape', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    } as never)
    expect(out.target.tool_choice).toEqual({ type: 'function', name: 'f' })
  })

  test('max_tokens forwarded to max_output_tokens; fallback used only when absent', () => {
    const a = translateChatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'q' }], max_tokens: 100 } as never,
      { fallbackMaxOutputTokens: 4096 },
    )
    expect(a.target.max_output_tokens).toBe(100)
    const b = translateChatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'q' }] } as never,
      { fallbackMaxOutputTokens: 4096 },
    )
    expect(b.target.max_output_tokens).toBe(4096)
    const c = translateChatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'q' }] } as never,
    )
    expect(c.target.max_output_tokens).toBeUndefined()
  })

  test('stream:false passes through verbatim', () => {
    const out = translateChatToResponses({
      model: 'm', stream: false,
      messages: [{ role: 'user', content: 'q' }],
    } as never)
    expect(out.target.stream).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests; confirm fail with stub error**

Run: `cd vnext/packages/translate && bun test tests/chat-completions-via-responses/request.test.ts`
Expected: 8 tests fail with "translateChatToResponses: not implemented".

- [ ] **Step 3: Implement `request.ts`**

```ts
import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface TranslateChatToResponsesOptions {
  fallbackMaxOutputTokens?: number
}
export interface ChatToResponsesRequestResult { target: ResponsesPayload }

type ChatMessage = ChatPayload['messages'][number]

interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string }>
}
interface ResponsesFunctionCallItem { type: 'function_call'; call_id: string; name: string; arguments: string }
interface ResponsesFunctionCallOutputItem { type: 'function_call_output'; call_id: string; output: string }
type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem

type ResponsesTool =
  | { type: 'function'; name: string; description?: string; parameters?: unknown; strict: boolean }

type ResponsesToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; name: string }

function partsToContent(parts: unknown[]): Array<{ type: string; text?: string }> {
  const out: Array<{ type: string; text?: string }> = []
  for (const p of parts) {
    const part = p as { type?: string; text?: string; image_url?: { url?: string } }
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'image_url' && part.image_url?.url) {
      out.push({ type: 'input_image', text: part.image_url.url })
    }
  }
  return out
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  try { return JSON.stringify(content) } catch { return '' }
}

function translateInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') continue // hoisted to instructions
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ type: 'message', role: 'user', content: m.content })
      } else if (Array.isArray(m.content)) {
        out.push({ type: 'message', role: 'user', content: partsToContent(m.content) })
      }
      continue
    }
    if (m.role === 'assistant') {
      const am = m as ChatMessage & { tool_calls?: Array<{ id: string; function: { name: string; arguments?: string } }> }
      if (typeof am.content === 'string' && am.content.length > 0) {
        out.push({ type: 'message', role: 'assistant', content: am.content })
      }
      if (am.tool_calls) {
        for (const tc of am.tool_calls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? '{}',
          })
        }
      }
      continue
    }
    if (m.role === 'tool') {
      const tm = m as ChatMessage & { tool_call_id: string; content: unknown }
      out.push({
        type: 'function_call_output',
        call_id: tm.tool_call_id,
        output: stringifyToolContent(tm.content),
      })
    }
  }
  return out
}

function joinSystem(messages: ChatMessage[]): string | undefined {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((s) => s.length > 0)
  if (sys.length === 0) return undefined
  return sys.join('\n\n')
}

function translateTools(tools: ChatPayload['tools']): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ResponsesTool[] = []
  for (const t of tools) {
    if (t.type !== 'function') continue
    const fn = t.function
    const tool: ResponsesTool = {
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters,
      strict: false,
    }
    out.push(tool)
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(choice: ChatPayload['tool_choice']): ResponsesToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object' && choice !== null && 'function' in choice) {
    const c = choice as { type?: string; function: { name: string } }
    return { type: 'function', name: c.function.name }
  }
  return undefined
}

export function translateChatToResponses(
  payload: ChatPayload,
  options?: TranslateChatToResponsesOptions,
): ChatToResponsesRequestResult {
  const messages = payload.messages
  const target: Record<string, unknown> = {
    model: payload.model,
    input: translateInput(messages),
    stream: payload.stream ?? true,
  }
  const instructions = joinSystem(messages)
  if (instructions !== undefined) target.instructions = instructions
  if (payload.temperature !== undefined) target.temperature = payload.temperature
  if (payload.top_p !== undefined) target.top_p = payload.top_p
  const ext = payload as ChatPayload & { metadata?: Record<string, string> }
  if (ext.metadata) target.metadata = { ...ext.metadata }
  const tools = translateTools(payload.tools)
  if (tools) target.tools = tools
  const tc = translateToolChoice(payload.tool_choice)
  if (tc !== undefined) target.tool_choice = tc
  const cap = payload.max_tokens ?? options?.fallbackMaxOutputTokens
  if (cap !== undefined) target.max_output_tokens = cap
  return { target: target as unknown as ResponsesPayload }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `cd vnext/packages/translate && bun test tests/chat-completions-via-responses/request.test.ts`
Expected: PASS 8/8.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/src/chat-completions-via-responses/request.ts \
        vnext/packages/translate/tests/chat-completions-via-responses/request.test.ts
git commit -m "feat(translate): chat→responses request translator"
```

---

## Task 3: `chat-completions-via-responses/events.ts` — Responses SSE → Chat SSE

**Files:**
- Modify: `vnext/packages/translate/src/chat-completions-via-responses/events.ts`
- Test: `vnext/packages/translate/tests/chat-completions-via-responses/events.test.ts`

**Translation contract:**

Hub emits typed Responses events (see `parseResponsesSSEStream` in `provider-copilot`). Map them onto OpenAI Chat SSE chunk objects (one chunk per delta, terminated by a final chunk with `finish_reason` and the `[DONE]` sentinel handled by `encodeClientSSE`).

| Responses event | Chat chunk emitted |
|---|---|
| `response.created` | first chunk: `{id, object:'chat.completion.chunk', created, model, choices:[{index:0, delta:{role:'assistant'}, finish_reason:null}]}` (assistant role chunk) |
| `response.output_text.delta` | `choices[0].delta.content = delta` |
| `response.output_item.added` (function_call) | `choices[0].delta.tool_calls = [{index, id, type:'function', function:{name, arguments:''}}]` |
| `response.function_call_arguments.delta` | `choices[0].delta.tool_calls = [{index, function:{arguments: delta}}]` |
| `response.completed` (or `response.output_item.done`) with stop | final chunk `{choices:[{index:0, delta:{}, finish_reason}]}` then end |

`finish_reason`: map Responses `stop_reason` → `'stop' | 'length' | 'tool_calls'` using:
- `end_turn` / `stop` → `'stop'`
- `max_output_tokens` / `length` → `'length'`
- presence of any `function_call` items → `'tool_calls'`
- otherwise `'stop'`

The function returns `AsyncIterable<ChatSSEChunk>` whose objects the dispatch layer encodes as SSE via `encodeClientSSE` (it injects `data: ` framing and `[DONE]` terminator).

- [ ] **Step 1: Write failing tests**

`tests/chat-completions-via-responses/events.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { translateResponsesToChatSSE } from '../../src/chat-completions-via-responses/index.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

async function* feed(items: unknown[]): AsyncIterable<unknown> {
  for (const i of items) yield i
}

describe('translateResponsesToChatSSE', () => {
  test('text-only response emits assistant role + content + finish:stop', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r1', model: 'gpt-x', created_at: 1 } },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { id: 'r1', status: 'completed' } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>
      id: string; model: string
    }>
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' })
    expect(chunks[0].id).toBe('r1')
    expect(chunks[0].model).toBe('gpt-x')
    expect(chunks[1].choices[0].delta).toEqual({ content: 'hel' })
    expect(chunks[2].choices[0].delta).toEqual({ content: 'lo' })
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop')
  })

  test('function_call streams id+name first, then incremental arguments, finish:tool_calls', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r2', model: 'm', created_at: 2 } },
      { type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.completed', response: { id: 'r2', status: 'completed' } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{
      choices: Array<{ delta: { tool_calls?: Array<{ index: number; id?: string; type?: string; function: { name?: string; arguments?: string } }> }; finish_reason: string | null }>
    }>
    const added = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id === 'call_a')!
    expect(added.choices[0].delta.tool_calls![0]).toEqual({
      index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' },
    })
    const argDeltas = chunks.filter((c) =>
      c.choices[0].delta.tool_calls && c.choices[0].delta.tool_calls[0].id === undefined,
    )
    expect(argDeltas[0].choices[0].delta.tool_calls![0]).toEqual({ index: 0, function: { arguments: '{"x":' } })
    expect(argDeltas[1].choices[0].delta.tool_calls![0]).toEqual({ index: 0, function: { arguments: '1}' } })
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('tool_calls')
  })

  test('length stop_reason → finish_reason:length', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r', model: 'm', created_at: 3 } },
      { type: 'response.output_text.delta', delta: 'x' },
      { type: 'response.completed', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{ choices: Array<{ finish_reason: string | null }> }>
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('length')
  })
})
```

- [ ] **Step 2: Run tests; confirm fail**

Run: `cd vnext/packages/translate && bun test tests/chat-completions-via-responses/events.test.ts`
Expected: 3 tests fail.

- [ ] **Step 3: Implement `events.ts`**

```ts
interface ChatChoiceDelta {
  role?: 'assistant'
  content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function: { name?: string; arguments?: string }
  }>
}

export interface ChatSSEChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{ index: 0; delta: ChatChoiceDelta; finish_reason: 'stop' | 'length' | 'tool_calls' | null }>
}

interface ResponsesEvent {
  type: string
  response?: { id?: string; model?: string; created_at?: number; status?: string; incomplete_details?: { reason?: string } }
  delta?: string
  output_index?: number
  item?: { type?: string; call_id?: string; name?: string; arguments?: string }
}

function makeChunk(id: string, model: string, created: number, delta: ChatChoiceDelta, finish: ChatSSEChunk['choices'][number]['finish_reason'] = null): ChatSSEChunk {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export async function* translateResponsesToChatSSE(
  events: AsyncIterable<unknown>,
): AsyncGenerator<ChatSSEChunk, void, unknown> {
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let sawToolCall = false
  let finish: ChatSSEChunk['choices'][number]['finish_reason'] = 'stop'
  let started = false

  for await (const ev of events as AsyncIterable<ResponsesEvent>) {
    if (ev.type === 'response.created') {
      id = ev.response?.id ?? id
      model = ev.response?.model ?? model
      if (ev.response?.created_at) created = ev.response.created_at
      yield makeChunk(id, model, created, { role: 'assistant' })
      started = true
      continue
    }
    if (!started) {
      // Some upstreams emit deltas without a preceding response.created; synthesize role chunk.
      yield makeChunk(id, model, created, { role: 'assistant' })
      started = true
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      yield makeChunk(id, model, created, { content: ev.delta })
      continue
    }
    if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
      sawToolCall = true
      yield makeChunk(id, model, created, {
        tool_calls: [{
          index: ev.output_index ?? 0,
          id: ev.item.call_id ?? '',
          type: 'function',
          function: { name: ev.item.name ?? '', arguments: ev.item.arguments ?? '' },
        }],
      })
      continue
    }
    if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
      yield makeChunk(id, model, created, {
        tool_calls: [{ index: ev.output_index ?? 0, function: { arguments: ev.delta } }],
      })
      continue
    }
    if (ev.type === 'response.completed') {
      const reason = ev.response?.incomplete_details?.reason
      if (reason === 'max_output_tokens') finish = 'length'
      else if (sawToolCall) finish = 'tool_calls'
      else finish = 'stop'
      break
    }
  }

  yield makeChunk(id, model, created, {}, finish)
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `cd vnext/packages/translate && bun test tests/chat-completions-via-responses/events.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/src/chat-completions-via-responses/events.ts \
        vnext/packages/translate/tests/chat-completions-via-responses/events.test.ts
git commit -m "feat(translate): chat→responses event translator"
```

---

## Task 4: `chat-completions-via-responses/body.ts` — Responses JSON → Chat JSON

**Files:**
- Modify: `vnext/packages/translate/src/chat-completions-via-responses/body.ts`
- Test: `vnext/packages/translate/tests/chat-completions-via-responses/body.test.ts`

**Translation contract:**

Map a non-streaming Responses object to a Chat Completion object. Aggregate output items into a single `choices[0].message`.

| Responses field | Chat field |
|---|---|
| `id` | `id` |
| `model` | `model` |
| `created_at` | `created` |
| `output[].type=='message'` text parts → joined | `choices[0].message.content` (string; `null` if no text and tool_calls present) |
| `output[].type=='function_call'` items | `choices[0].message.tool_calls[]` (`{id:call_id, type:'function', function:{name, arguments}}`) |
| `usage.input_tokens` / `usage.output_tokens` | `usage.prompt_tokens` / `usage.completion_tokens` (+ total) |
| `status:'completed'` + tool_calls present | `finish_reason:'tool_calls'` |
| `status:'incomplete' + reason:'max_output_tokens'` | `finish_reason:'length'` |
| else | `finish_reason:'stop'` |

- [ ] **Step 1: Write failing tests**

`tests/chat-completions-via-responses/body.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { translateResponsesToChatBody } from '../../src/chat-completions-via-responses/index.ts'

describe('translateResponsesToChatBody', () => {
  test('plain text response → chat completion with content + finish:stop', () => {
    const out = translateResponsesToChatBody({
      id: 'r1', model: 'gpt-x', created_at: 100, status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }) as { id: string; model: string; created: number; choices: Array<{ message: { role: string; content: string | null; tool_calls?: unknown[] }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
    expect(out.id).toBe('r1')
    expect(out.created).toBe(100)
    expect(out.model).toBe('gpt-x')
    expect(out.choices[0].message).toEqual({ role: 'assistant', content: 'hello' })
    expect(out.choices[0].finish_reason).toBe('stop')
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
  })

  test('tool_calls present → message.tool_calls + finish:tool_calls + content null', () => {
    const out = translateResponsesToChatBody({
      id: 'r2', model: 'm', created_at: 1, status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
      ],
    }) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; finish_reason: string }> }
    expect(out.choices[0].message.content).toBeNull()
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
    ])
    expect(out.choices[0].finish_reason).toBe('tool_calls')
  })

  test('max_output_tokens → finish:length', () => {
    const out = translateResponsesToChatBody({
      id: 'r3', model: 'm', created_at: 1,
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }],
    }) as { choices: Array<{ finish_reason: string }> }
    expect(out.choices[0].finish_reason).toBe('length')
  })
})
```

- [ ] **Step 2: Run tests; confirm fail**

Run: `cd vnext/packages/translate && bun test tests/chat-completions-via-responses/body.test.ts`

- [ ] **Step 3: Implement `body.ts`**

```ts
interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  role?: string
  content?: Array<{ type: string; text?: string }>
  call_id?: string
  name?: string
  arguments?: string
}

interface ResponsesBody {
  id: string
  model?: string
  created_at?: number
  status?: string
  incomplete_details?: { reason?: string }
  output?: ResponsesOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: 0
    message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
    finish_reason: 'stop' | 'length' | 'tool_calls'
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export function translateResponsesToChatBody(body: unknown): ChatCompletion {
  const r = body as ResponsesBody
  const text: string[] = []
  const toolCalls: ChatToolCall[] = []
  for (const item of r.output ?? []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') text.push(part.text)
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? '',
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
      })
    }
  }

  let finish: 'stop' | 'length' | 'tool_calls' = 'stop'
  if (r.incomplete_details?.reason === 'max_output_tokens') finish = 'length'
  else if (toolCalls.length > 0) finish = 'tool_calls'

  const content = text.length > 0 ? text.join('') : (toolCalls.length > 0 ? null : '')
  const message: ChatCompletion['choices'][number]['message'] = { role: 'assistant', content }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const out: ChatCompletion = {
    id: r.id,
    object: 'chat.completion',
    created: r.created_at ?? Math.floor(Date.now() / 1000),
    model: r.model ?? '',
    choices: [{ index: 0, message, finish_reason: finish }],
  }
  if (r.usage) {
    const p = r.usage.input_tokens ?? 0
    const c = r.usage.output_tokens ?? 0
    out.usage = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
  }
  return out
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `cd vnext/packages/translate && bun test tests/chat-completions-via-responses/body.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/src/chat-completions-via-responses/body.ts \
        vnext/packages/translate/tests/chat-completions-via-responses/body.test.ts
git commit -m "feat(translate): chat→responses body translator"
```

---

## Task 5: Scaffold `responses-via-chat-completions` package directory

**Files:**
- Create: `vnext/packages/translate/src/responses-via-chat-completions/index.ts`
- Create: `vnext/packages/translate/src/responses-via-chat-completions/request.ts` (stub)
- Create: `vnext/packages/translate/src/responses-via-chat-completions/events.ts` (stub)
- Create: `vnext/packages/translate/src/responses-via-chat-completions/body.ts` (stub)
- Modify: `vnext/packages/translate/package.json`

- [ ] **Step 1: Add export entry to package.json**

```json
"./responses-via-chat-completions": "./src/responses-via-chat-completions/index.ts",
```

- [ ] **Step 2: Write `index.ts`**

```ts
export { translateResponsesToChat } from './request.ts'
export { translateChatToResponsesEvents } from './events.ts'
export { translateChatToResponsesBody } from './body.ts'
```

- [ ] **Step 3: Write stubs that throw**

`request.ts`:

```ts
import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface ResponsesToChatRequestResult { target: ChatPayload }

export function translateResponsesToChat(_payload: ResponsesPayload): ResponsesToChatRequestResult {
  throw new Error('translateResponsesToChat: not implemented')
}
```

`events.ts`:

```ts
export async function* translateChatToResponsesEvents(
  _events: AsyncIterable<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  throw new Error('translateChatToResponsesEvents: not implemented')
}
```

`body.ts`:

```ts
export function translateChatToResponsesBody(_body: unknown): unknown {
  throw new Error('translateChatToResponsesBody: not implemented')
}
```

- [ ] **Step 4: Verify typecheck**

Run: `cd vnext/packages/translate && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/package.json \
        vnext/packages/translate/src/responses-via-chat-completions/
git commit -m "feat(translate): scaffold responses-via-chat-completions pair"
```

---

## Task 6: `responses-via-chat-completions/request.ts` — Responses payload → Chat payload

**Files:**
- Modify: `vnext/packages/translate/src/responses-via-chat-completions/request.ts`
- Test: `vnext/packages/translate/tests/responses-via-chat-completions/request.test.ts`

**Translation contract:**

| Responses field | Chat field |
|---|---|
| `model` | `model` |
| `instructions` (string) | prepend `{role:'system', content}` |
| `input[]` `{type:'message', role:'user'|'assistant', content: string}` | `{role, content: string}` |
| `input[]` `{type:'message', role:'user', content: [parts]}` | `{role:'user', content: [chat parts]}` (input_text → text; input_image → image_url with `text` as URL) |
| `input[]` `{type:'function_call', call_id, name, arguments}` | merged into preceding assistant message's `tool_calls[]` (or new assistant message if none) |
| `input[]` `{type:'function_call_output', call_id, output}` | `{role:'tool', tool_call_id: call_id, content: output}` |
| `tools[].type=='function'` | `{type:'function', function:{name, description?, parameters}}` |
| `tools[].type=='web_search'` | drop (chat upstream has no native web_search; faithful-minimal: caller can't request what chat backend can't serve) |
| `tool_choice` | `'auto'`/`'required'`/`'none'` passthrough; `{type:'function', name}` → `{type:'function', function:{name}}` |
| `temperature`, `top_p`, `metadata` | passthrough |
| `max_output_tokens` | `max_tokens` |
| `stream` | `stream` |
| `reasoning`, `text.format`, `instructions[]` (non-string) | drop (faithful-minimal) |

- [ ] **Step 1: Write failing tests**

`tests/responses-via-chat-completions/request.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { translateResponsesToChat } from '../../src/responses-via-chat-completions/index.ts'

describe('translateResponsesToChat', () => {
  test('instructions prepended as system; input message becomes chat user', () => {
    const out = translateResponsesToChat({
      model: 'm',
      instructions: 'You are helpful.',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    } as never)
    expect(out.target.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('input_image part → image_url part', () => {
    const out = translateResponsesToChat({
      model: 'm',
      input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: 'see' },
          { type: 'input_image', text: 'https://x/y.png' },
        ],
      }],
    } as never)
    expect(out.target.messages[0].content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ])
  })

  test('function_call + function_call_output → assistant.tool_calls + role:tool', () => {
    const out = translateResponsesToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'result' },
      ],
    } as never)
    expect(out.target.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: 'result' },
    ])
  })

  test('tools + tool_choice translation', () => {
    const out = translateResponsesToChat({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: 'q' }],
      tools: [
        { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: false },
        { type: 'web_search' },
      ],
      tool_choice: { type: 'function', name: 'f' },
    } as never)
    expect(out.target.tools).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
    ])
    expect(out.target.tool_choice).toEqual({ type: 'function', function: { name: 'f' } })
  })

  test('max_output_tokens → max_tokens; stream passthrough', () => {
    const out = translateResponsesToChat({
      model: 'm', max_output_tokens: 256, stream: false,
      input: [{ type: 'message', role: 'user', content: 'q' }],
    } as never)
    expect(out.target.max_tokens).toBe(256)
    expect(out.target.stream).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests; confirm fail**

Run: `cd vnext/packages/translate && bun test tests/responses-via-chat-completions/request.test.ts`
Expected: 5 tests fail.

- [ ] **Step 3: Implement `request.ts`**

```ts
import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface ResponsesToChatRequestResult { target: ChatPayload }

interface ResponsesInputMessage {
  type: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | Array<{ type: string; text?: string }>
}
interface ResponsesFunctionCall { type: 'function_call'; call_id: string; name: string; arguments?: string }
interface ResponsesFunctionCallOutput { type: 'function_call_output'; call_id: string; output?: string }
type ResponsesInputItem = ResponsesInputMessage | ResponsesFunctionCall | ResponsesFunctionCallOutput

interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMsgUser { role: 'user'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }
interface ChatMsgAssistant { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
interface ChatMsgTool { role: 'tool'; tool_call_id: string; content: string }
interface ChatMsgSystem { role: 'system'; content: string }
type ChatMessage = ChatMsgUser | ChatMsgAssistant | ChatMsgTool | ChatMsgSystem

function partsToChat(parts: Array<{ type: string; text?: string }>): ChatMsgUser['content'] {
  const out: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const p of parts) {
    if (p.type === 'input_text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text })
    else if (p.type === 'input_image' && typeof p.text === 'string') out.push({ type: 'image_url', image_url: { url: p.text } })
  }
  return out
}

function translateInput(items: ResponsesInputItem[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const item of items) {
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        const text = typeof item.content === 'string' ? item.content : item.content.map((p) => p.text ?? '').join('')
        if (text) out.push({ role: 'system', content: text })
        continue
      }
      if (item.role === 'user') {
        if (typeof item.content === 'string') out.push({ role: 'user', content: item.content })
        else out.push({ role: 'user', content: partsToChat(item.content) })
        continue
      }
      if (item.role === 'assistant') {
        const text = typeof item.content === 'string'
          ? item.content
          : item.content.map((p) => p.text ?? '').join('')
        out.push({ role: 'assistant', content: text })
        continue
      }
    }
    if (item.type === 'function_call') {
      // Merge into the previous assistant message if it has no tool_calls yet,
      // otherwise create a new assistant message with content:null.
      const prev = out[out.length - 1]
      const tc: ChatToolCall = {
        id: item.call_id, type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      }
      if (prev && prev.role === 'assistant') {
        const a = prev as ChatMsgAssistant
        if (!a.tool_calls) a.tool_calls = []
        a.tool_calls.push(tc)
      } else {
        out.push({ role: 'assistant', content: null, tool_calls: [tc] })
      }
      continue
    }
    if (item.type === 'function_call_output') {
      out.push({ role: 'tool', tool_call_id: item.call_id, content: item.output ?? '' })
    }
  }
  return out
}

function translateTools(tools: ResponsesPayload['tools']): ChatPayload['tools'] | undefined {
  if (!tools) return undefined
  const out: NonNullable<ChatPayload['tools']> = []
  for (const t of tools as Array<{ type: string; name?: string; description?: string; parameters?: unknown }>) {
    if (t.type !== 'function' || !t.name) continue
    out.push({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      },
    } as NonNullable<ChatPayload['tools']>[number])
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(choice: ResponsesPayload['tool_choice']): ChatPayload['tool_choice'] | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object' && (choice as { type?: string }).type === 'function') {
    const c = choice as { name: string }
    return { type: 'function', function: { name: c.name } } as NonNullable<ChatPayload['tool_choice']>
  }
  return undefined
}

export function translateResponsesToChat(payload: ResponsesPayload): ResponsesToChatRequestResult {
  const messages: ChatMessage[] = []
  if (typeof payload.instructions === 'string' && payload.instructions.length > 0) {
    messages.push({ role: 'system', content: payload.instructions })
  }
  const inputArr = (payload.input ?? []) as unknown as ResponsesInputItem[]
  messages.push(...translateInput(inputArr))

  const target: Record<string, unknown> = {
    model: payload.model,
    messages,
    stream: payload.stream ?? true,
  }
  if (payload.temperature !== undefined) target.temperature = payload.temperature
  if (payload.top_p !== undefined) target.top_p = payload.top_p
  const ext = payload as ResponsesPayload & { metadata?: Record<string, string> }
  if (ext.metadata) target.metadata = { ...ext.metadata }
  if (payload.max_output_tokens !== undefined) target.max_tokens = payload.max_output_tokens
  const tools = translateTools(payload.tools)
  if (tools) target.tools = tools
  const tc = translateToolChoice(payload.tool_choice)
  if (tc !== undefined) target.tool_choice = tc

  return { target: target as unknown as ChatPayload }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `cd vnext/packages/translate && bun test tests/responses-via-chat-completions/request.test.ts`
Expected: PASS 5/5.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/src/responses-via-chat-completions/request.ts \
        vnext/packages/translate/tests/responses-via-chat-completions/request.test.ts
git commit -m "feat(translate): responses→chat request translator"
```

---

## Task 7: `responses-via-chat-completions/events.ts` — Chat SSE → Responses events

**Files:**
- Modify: `vnext/packages/translate/src/responses-via-chat-completions/events.ts`
- Test: `vnext/packages/translate/tests/responses-via-chat-completions/events.test.ts`

**Translation contract:**

Hub emits `ChatCompletionChunk` events (typed by `parseChatSSEStream`). Map onto Responses event objects.

Sequence (text):
1. First chunk → `{type:'response.created', response: {id, model, created_at, status:'in_progress'}}`
2. First content delta → `{type:'response.output_item.added', output_index:0, item:{type:'message', role:'assistant', content:[]}}`
3. Each `delta.content` → `{type:'response.output_text.delta', output_index:0, content_index:0, delta}`
4. Final chunk with `finish_reason` → `{type:'response.output_item.done', output_index:0, item:{...}}` + `{type:'response.completed', response:{id, status:'completed' | 'incomplete'}}`

Sequence (tool_calls): when chunks contain `delta.tool_calls`, route them as `function_call` items:
- First time we see a tool_call at `index=N` with `id` → emit `response.output_item.added` with `{type:'function_call', call_id:id, name, arguments:''}` at `output_index=N+message_offset`
- Subsequent `function.arguments` increments → emit `response.function_call_arguments.delta`
- On final chunk → `response.output_item.done` for each tool call, then `response.completed`

`finish_reason` mapping:
- `'stop'`, `'tool_calls'`, `'function_call'` → `status:'completed'`
- `'length'` → `status:'incomplete', incomplete_details:{reason:'max_output_tokens'}`

- [ ] **Step 1: Write failing tests**

`tests/responses-via-chat-completions/events.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { translateChatToResponsesEvents } from '../../src/responses-via-chat-completions/index.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}
async function* feed(items: unknown[]): AsyncIterable<unknown> {
  for (const i of items) yield i
}

describe('translateChatToResponsesEvents', () => {
  test('text-only stream emits created → message added → text deltas → completed', async () => {
    const chunks = [
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }] },
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    const events = await collect(translateChatToResponsesEvents(feed(chunks))) as Array<{ type: string; delta?: string; response?: { id?: string; status?: string }; item?: { type?: string } }>
    expect(events[0].type).toBe('response.created')
    expect(events[0].response?.id).toBe('r1')
    expect(events[1].type).toBe('response.output_item.added')
    expect(events[1].item?.type).toBe('message')
    expect(events[2].type).toBe('response.output_text.delta')
    expect(events[2].delta).toBe('hel')
    expect(events[3].type).toBe('response.output_text.delta')
    expect(events[3].delta).toBe('lo')
    expect(events.at(-2)?.type).toBe('response.output_item.done')
    expect(events.at(-1)?.type).toBe('response.completed')
    expect(events.at(-1)?.response?.status).toBe('completed')
  })

  test('tool_calls: added → arguments delta → done → completed', async () => {
    const chunks = [
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } }],
      }, finish_reason: null }] },
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
      }, finish_reason: null }] },
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const events = await collect(translateChatToResponsesEvents(feed(chunks))) as Array<{ type: string; item?: { type?: string; call_id?: string; name?: string }; delta?: string; response?: { status?: string } }>
    const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call')!
    expect(added.item?.call_id).toBe('call_a')
    expect(added.item?.name).toBe('f')
    const argDelta = events.find((e) => e.type === 'response.function_call_arguments.delta')!
    expect(argDelta.delta).toBe('{"x":1}')
    expect(events.at(-1)?.response?.status).toBe('completed')
  })

  test('finish:length → incomplete with reason', async () => {
    const chunks = [
      { id: 'r3', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'r3', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
      { id: 'r3', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ]
    const events = await collect(translateChatToResponsesEvents(feed(chunks))) as Array<{ type: string; response?: { status?: string; incomplete_details?: { reason?: string } } }>
    const completed = events.at(-1)!
    expect(completed.type).toBe('response.completed')
    expect(completed.response?.status).toBe('incomplete')
    expect(completed.response?.incomplete_details?.reason).toBe('max_output_tokens')
  })
})
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Implement `events.ts`**

```ts
interface ChatChunk {
  id?: string
  model?: string
  created?: number
  choices?: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'function_call' | null
  }>
}

interface ToolCallState { outputIndex: number; id: string; name: string }

export async function* translateChatToResponsesEvents(
  events: AsyncIterable<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let createdEmitted = false
  let messageOpened = false
  let nextOutputIndex = 0
  let messageOutputIndex = -1
  const toolCalls = new Map<number, ToolCallState>() // chunk index → state
  let finish: 'stop' | 'length' | 'tool_calls' | 'function_call' | null = null

  for await (const raw of events as AsyncIterable<ChatChunk>) {
    if (raw.id && !id) id = raw.id
    if (raw.model && !model) model = raw.model
    if (raw.created && !createdEmitted) created = raw.created

    if (!createdEmitted) {
      yield { type: 'response.created', response: { id, model, created_at: created, status: 'in_progress' } }
      createdEmitted = true
    }

    const choice = raw.choices?.[0]
    if (!choice) continue
    const delta = choice.delta
    if (delta.content && delta.content.length > 0) {
      if (!messageOpened) {
        messageOutputIndex = nextOutputIndex++
        yield {
          type: 'response.output_item.added',
          output_index: messageOutputIndex,
          item: { type: 'message', role: 'assistant', content: [] },
        }
        messageOpened = true
      }
      yield {
        type: 'response.output_text.delta',
        output_index: messageOutputIndex,
        content_index: 0,
        delta: delta.content,
      }
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let state = toolCalls.get(tc.index)
        if (!state) {
          state = {
            outputIndex: nextOutputIndex++,
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
          }
          toolCalls.set(tc.index, state)
          yield {
            type: 'response.output_item.added',
            output_index: state.outputIndex,
            item: {
              type: 'function_call',
              call_id: state.id,
              name: state.name,
              arguments: '',
            },
          }
        }
        const argDelta = tc.function?.arguments
        if (typeof argDelta === 'string' && argDelta.length > 0) {
          yield {
            type: 'response.function_call_arguments.delta',
            output_index: state.outputIndex,
            delta: argDelta,
          }
        }
      }
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason
      break
    }
  }

  if (messageOpened) {
    yield {
      type: 'response.output_item.done',
      output_index: messageOutputIndex,
      item: { type: 'message', role: 'assistant' },
    }
  }
  for (const state of toolCalls.values()) {
    yield {
      type: 'response.output_item.done',
      output_index: state.outputIndex,
      item: { type: 'function_call', call_id: state.id, name: state.name },
    }
  }

  const status = finish === 'length' ? 'incomplete' : 'completed'
  const completed: Record<string, unknown> = {
    type: 'response.completed',
    response: {
      id, model, created_at: created, status,
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    },
  }
  yield completed
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `cd vnext/packages/translate && bun test tests/responses-via-chat-completions/events.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/src/responses-via-chat-completions/events.ts \
        vnext/packages/translate/tests/responses-via-chat-completions/events.test.ts
git commit -m "feat(translate): responses→chat event translator"
```

---

## Task 8: `responses-via-chat-completions/body.ts` — Chat JSON → Responses JSON

**Files:**
- Modify: `vnext/packages/translate/src/responses-via-chat-completions/body.ts`
- Test: `vnext/packages/translate/tests/responses-via-chat-completions/body.test.ts`

**Translation contract:**

| Chat field | Responses field |
|---|---|
| `id` | `id` |
| `model` | `model` |
| `created` | `created_at` |
| `choices[0].message.content` (string) | output item `{type:'message', role:'assistant', content:[{type:'output_text', text}]}` |
| `choices[0].message.tool_calls[]` | output items `{type:'function_call', call_id:id, name, arguments}` |
| `choices[0].finish_reason=='length'` | `status:'incomplete', incomplete_details:{reason:'max_output_tokens'}` |
| else | `status:'completed'` |
| `usage.prompt_tokens` / `completion_tokens` | `usage.input_tokens` / `output_tokens` |

- [ ] **Step 1: Write failing tests**

`tests/responses-via-chat-completions/body.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { translateChatToResponsesBody } from '../../src/responses-via-chat-completions/index.ts'

describe('translateChatToResponsesBody', () => {
  test('text-only chat completion → responses with output_text item', () => {
    const out = translateChatToResponsesBody({
      id: 'c1', model: 'm', created: 100,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }) as { id: string; model: string; created_at: number; status: string; output: Array<{ type: string; content?: Array<{ type: string; text: string }> }>; usage: { input_tokens: number; output_tokens: number } }
    expect(out.id).toBe('c1')
    expect(out.created_at).toBe(100)
    expect(out.status).toBe('completed')
    expect(out.output[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } as never)
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 1 })
  })

  test('tool_calls produce function_call output items', () => {
    const out = translateChatToResponsesBody({
      id: 'c2', model: 'm', created: 1,
      choices: [{ index: 0, message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
      }, finish_reason: 'tool_calls' }],
    }) as { output: Array<{ type: string; call_id?: string; name?: string; arguments?: string }> }
    expect(out.output).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
    ] as never)
  })

  test('finish:length → status:incomplete', () => {
    const out = translateChatToResponsesBody({
      id: 'c3', model: 'm', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }],
    }) as { status: string; incomplete_details: { reason: string } }
    expect(out.status).toBe('incomplete')
    expect(out.incomplete_details.reason).toBe('max_output_tokens')
  })
})
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Implement `body.ts`**

```ts
interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
interface ChatBody {
  id: string
  model?: string
  created?: number
  choices: Array<{ index: number; message: ChatMessage; finish_reason: 'stop' | 'length' | 'tool_calls' | 'function_call' | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  role?: 'assistant'
  content?: Array<{ type: 'output_text'; text: string }>
  call_id?: string
  name?: string
  arguments?: string
}

interface ResponsesBody {
  id: string
  object: 'response'
  model: string
  created_at: number
  status: 'completed' | 'incomplete'
  incomplete_details?: { reason: string }
  output: ResponsesOutputItem[]
  usage?: { input_tokens: number; output_tokens: number }
}

export function translateChatToResponsesBody(body: unknown): ResponsesBody {
  const c = body as ChatBody
  const choice = c.choices[0]
  const output: ResponsesOutputItem[] = []
  if (choice && typeof choice.message.content === 'string' && choice.message.content.length > 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: choice.message.content }],
    })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  const status: 'completed' | 'incomplete' = choice?.finish_reason === 'length' ? 'incomplete' : 'completed'
  const out: ResponsesBody = {
    id: c.id,
    object: 'response',
    model: c.model ?? '',
    created_at: c.created ?? Math.floor(Date.now() / 1000),
    status,
    output,
  }
  if (status === 'incomplete') out.incomplete_details = { reason: 'max_output_tokens' }
  if (c.usage) {
    out.usage = {
      input_tokens: c.usage.prompt_tokens ?? 0,
      output_tokens: c.usage.completion_tokens ?? 0,
    }
  }
  return out
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `cd vnext/packages/translate && bun test tests/responses-via-chat-completions/body.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/translate/src/responses-via-chat-completions/body.ts \
        vnext/packages/translate/tests/responses-via-chat-completions/body.test.ts
git commit -m "feat(translate): responses→chat body translator"
```

---

## Task 9: Register both pairs in dispatch translator-registry

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/dispatch/translator-registry.ts`

- [ ] **Step 1: Add imports**

After existing imports, add:

```ts
// Pair 7: client = chat_completions, hub = responses
import {
  translateChatToResponses,
  translateResponsesToChatSSE,
  translateResponsesToChatBody,
} from '@vnext/translate/chat-completions-via-responses'

// Pair 8: client = responses, hub = chat_completions
import {
  translateResponsesToChat,
  translateChatToResponsesEvents,
  translateChatToResponsesBody,
} from '@vnext/translate/responses-via-chat-completions'
```

- [ ] **Step 2: Add wrapper objects**

After `PAIR_GEMINI_TO_MESSAGES`:

```ts
/** Pair 7: Chat Completions client → Responses hub. */
const PAIR_CHAT_TO_RESPONSES: PairTranslator = {
  translateRequest: (payload, ctx) => {
    const result = translateChatToResponses(payload as never, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    })
    return result.target
  },
  translateEvents: (events) => translateResponsesToChatSSE(events as never),
  translateBody: (body) => translateResponsesToChatBody(body),
}

/** Pair 8: Responses client → Chat Completions hub. */
const PAIR_RESPONSES_TO_CHAT: PairTranslator = {
  translateRequest: (payload) => {
    const result = translateResponsesToChat(payload as never)
    return result.target
  },
  translateEvents: (events) => translateChatToResponsesEvents(events as never),
  translateBody: (body) => translateChatToResponsesBody(body),
}
```

- [ ] **Step 3: Add TABLE entries**

In the `TABLE` object, after the existing `'gemini->messages'` entry:

```ts
  // Pair 7
  'chat_completions->responses': PAIR_CHAT_TO_RESPONSES,
  // Pair 8
  'responses->chat_completions': PAIR_RESPONSES_TO_CHAT,
```

- [ ] **Step 4: Run gateway typecheck**

Run: `cd vnext/apps/gateway && bun run typecheck` (or root `bun run typecheck` per workspace setup)
Expected: PASS.

- [ ] **Step 5: Add registry sanity test**

Test file: `vnext/apps/gateway/tests/dispatch/translator-registry-pairs.test.ts` (extend if exists; otherwise create).

```ts
import { describe, test, expect } from 'bun:test'
import { getTranslator } from '../../src/data-plane/dispatch/translator-registry.ts'

describe('translator-registry: chat↔responses pairs', () => {
  test('chat_completions→responses returns a translator', () => {
    const t = getTranslator('chat_completions', 'responses')
    expect(t).not.toBeNull()
    expect(typeof t!.translateRequest).toBe('function')
  })
  test('responses→chat_completions returns a translator', () => {
    const t = getTranslator('responses', 'chat_completions')
    expect(t).not.toBeNull()
  })
})
```

Run: `cd vnext/apps/gateway && bun test tests/dispatch/translator-registry-pairs.test.ts`
Expected: PASS 2/2.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/dispatch/translator-registry.ts \
        vnext/apps/gateway/tests/dispatch/translator-registry-pairs.test.ts
git commit -m "feat(gateway): register chat↔responses translator pairs in dispatch"
```

---

## Task 10: Round-trip integration check + workspace tests

Verify the new pairs compose correctly end-to-end at the translator level.

**Files:**
- Test: `vnext/packages/translate/tests/chat-responses-roundtrip.test.ts`

- [ ] **Step 1: Write round-trip test**

```ts
import { describe, test, expect } from 'bun:test'
import { translateChatToResponses } from '../src/chat-completions-via-responses/index.ts'
import { translateResponsesToChat } from '../src/responses-via-chat-completions/index.ts'

describe('chat ↔ responses round-trip', () => {
  test('chat → responses → chat preserves text + tools', () => {
    const original = {
      model: 'm',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }
    const r = translateChatToResponses(original as never).target
    const back = translateResponsesToChat(r as never).target
    expect(back.model).toBe('m')
    expect(back.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(back.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(back.tools).toEqual([{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] as never)
    expect(back.tool_choice).toBe('auto')
  })

  test('responses → chat → responses preserves function_call/output', () => {
    const original = {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'r' },
      ],
    }
    const c = translateResponsesToChat(original as never).target
    const back = translateChatToResponses(c as never).target
    expect(back.input).toEqual([
      { type: 'message', role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'r' },
    ] as never)
  })
})
```

- [ ] **Step 2: Run all translate tests**

Run: `cd vnext/packages/translate && bun test`
Expected: all suites pass (existing + 7 new files).

- [ ] **Step 3: Run workspace typecheck**

Run from repo root: `bun run typecheck` (or whichever workspace command runs `tsc --noEmit` across packages).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/translate/tests/chat-responses-roundtrip.test.ts
git commit -m "test(translate): chat↔responses round-trip integration"
```

---

## Out-of-scope (deferred to Plan 3)

- `responses-store-bridge.ts` (`expandPreviousResponseId`, `savePostTurnSnapshot`)
- `errors/repackage.ts` verbatim `previous_response_not_found` envelope
- `routes.ts` `/v1/responses` integration (calling expand/save)
- `apps/gateway/src/app.ts` `Env.responsesStore` wiring (CFW D1 vs local sqlite)
- E2E previous_response_id test
- openai-node SDK multi-turn integration test

These all depend on Plan 1 (the store package) being merged AND the Plan 2 translator pairs registered, so they cleanly belong in Plan 3.

---

## Self-review

- ✅ Spec coverage: all of "3. 新翻译对子" + "注册" subsections covered (Tasks 1–9). Tests strategy row "翻译对单测" covered (Tasks 2–4 and 6–8).
- ✅ No placeholders: every step has either a complete code block or an exact command with expected outcome.
- ✅ Type consistency: `translateChatToResponses` / `translateResponsesToChat` return `{target}` everywhere; the registry strips that envelope per the existing `PAIR_RESPONSES_TO_MESSAGES` precedent. Event functions are async generators with named exports matching imports.
- ✅ Faithfulness: every translator drops fields it can't represent rather than fabricating; matches the existing pair convention (`messages-via-responses/request.ts` precedent).
