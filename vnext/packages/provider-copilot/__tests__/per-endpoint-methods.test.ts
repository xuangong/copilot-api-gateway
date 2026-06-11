/**
 * Per-endpoint call* methods on CopilotProvider — Phase A Task 2 (X-2).
 *
 * The methods sit alongside the existing `provider.fetch()` (Phase B retires
 * its callers). Each test mocks `globalThis.fetch` end-to-end through the
 * interceptor chain so that we exercise the full path: provider entry →
 * interceptors → callCopilotAPI → fetchWithRetry → globalThis.fetch.
 *
 * NOTE: We deliberately do not use `mock.module()` — Bun 1.3 leaks module
 * mocks across test files (see memory note `bun_mock_module_unrestorable`).
 * Save/restore globalThis.fetch is the safe pattern.
 */
import { test, expect, afterEach, describe } from 'bun:test'
import { CopilotProvider } from '../src/provider'
import type { UpstreamResponse } from '@vnext/provider'
import { HTTPError } from '@vnext/provider'
import type { MessagesEvent } from '@vnext/protocols/messages'

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

type FetchHandler = (req: Request) => Promise<Response> | Response
function installFetch(handler: FetchHandler) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}

function makeProvider() {
  return new CopilotProvider({ copilotToken: 'tkn_test', accountType: 'individual' })
}

// ── callMessages ─────────────────────────────────────────────────────────────

describe('callMessages', () => {
  test('non-streaming returns ok=true, stream=false, parsed body', async () => {
    installFetch(() => jsonResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    }))
    const provider = makeProvider()
    const out = await provider.callMessages!({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    }) as UpstreamResponse<MessagesEvent>
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.stream).toBe(false)
    expect(out.status).toBe(200)
    if (out.stream) throw new Error('expected non-streaming')
    expect((out.body as { id: string }).id).toBe('msg_1')
    expect(out.headers).toBeInstanceOf(Headers)
  })

  test('streaming returns ok=true, stream=true, AsyncIterable of events', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    installFetch(() => sseResponse(frames))
    const provider = makeProvider()
    const out = await provider.callMessages!({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
      stream: true,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.stream).toBe(true)
    if (!out.stream) throw new Error('expected streaming')
    const collected: MessagesEvent[] = []
    for await (const ev of out.body) collected.push(ev)
    expect(collected).toHaveLength(3)
    expect(collected[0]?.type).toBe('message_start')
    expect(collected[1]?.type).toBe('content_block_delta')
    expect(collected[2]?.type).toBe('message_stop')
  })

  test('upstream 4xx surfaces as ok=false with HTTPError', async () => {
    installFetch(() => new Response(JSON.stringify({ error: { message: 'bad' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const provider = makeProvider()
    const out = await provider.callMessages!({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.status).toBe(400)
    expect(out.error).toBeInstanceOf(HTTPError)
  })
})

// ── callMessagesCountTokens ──────────────────────────────────────────────────

describe('callMessagesCountTokens', () => {
  test('non-streaming returns body', async () => {
    installFetch(() => jsonResponse({ input_tokens: 42 }))
    const provider = makeProvider()
    const out = await provider.callMessagesCountTokens!({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok || out.stream) throw new Error('unreachable')
    expect((out.body as { input_tokens: number }).input_tokens).toBe(42)
  })
})

// ── callChatCompletions ──────────────────────────────────────────────────────

describe('callChatCompletions', () => {
  test('non-streaming returns ok=true, parsed JSON body', async () => {
    installFetch(() => jsonResponse({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    }))
    const provider = makeProvider()
    const out = await provider.callChatCompletions!({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok || out.stream) throw new Error('unreachable')
    expect((out.body as { id: string }).id).toBe('chatcmpl_1')
  })

  test('streaming yields raw SSE event payloads', async () => {
    const frames = [
      'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    installFetch(() => sseResponse(frames))
    const provider = makeProvider()
    const out = await provider.callChatCompletions!({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(out.ok).toBe(true)
    if (!out.ok || !out.stream) throw new Error('unreachable')
    const collected: unknown[] = []
    for await (const ev of out.body) collected.push(ev)
    expect(collected.length).toBe(1) // [DONE] is filtered
  })
})

// ── callResponses ────────────────────────────────────────────────────────────

describe('callResponses', () => {
  test('non-streaming returns parsed body', async () => {
    installFetch(() => jsonResponse({ id: 'resp_1', object: 'response' }))
    const provider = makeProvider()
    const out = await provider.callResponses!({ model: 'gpt-5-mini', input: 'hi' })
    expect(out.ok).toBe(true)
    if (!out.ok || out.stream) throw new Error('unreachable')
    expect((out.body as { id: string }).id).toBe('resp_1')
  })

  test('streaming yields response events', async () => {
    const frames = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
    ]
    installFetch(() => sseResponse(frames))
    const provider = makeProvider()
    const out = await provider.callResponses!({ model: 'gpt-5-mini', input: 'hi', stream: true })
    expect(out.ok).toBe(true)
    if (!out.ok || !out.stream) throw new Error('unreachable')
    const collected: unknown[] = []
    for await (const ev of out.body) collected.push(ev)
    expect(collected.length).toBe(2)
  })
})

// ── callEmbeddings ───────────────────────────────────────────────────────────

describe('callEmbeddings', () => {
  test('returns parsed embeddings body', async () => {
    installFetch(() => jsonResponse({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
    }))
    const provider = makeProvider()
    const out = await provider.callEmbeddings!({
      model: 'text-embedding-3-large',
      input: 'hello',
    })
    expect(out.ok).toBe(true)
    if (!out.ok || out.stream) throw new Error('unreachable')
    expect((out.body as { data: unknown[] }).data).toHaveLength(1)
  })
})

// ── callImagesGenerations / callImagesEdits ──────────────────────────────────

describe('callImagesGenerations', () => {
  test('returns ok=false because Copilot does not support images_generations endpoint', async () => {
    const provider = makeProvider()
    const out = await provider.callImagesGenerations!({ model: 'dall-e-3', prompt: 'cat' })
    // Copilot has no /images endpoint mapped; should fail-fast as ok=false.
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.error).toBeInstanceOf(HTTPError)
  })
})

describe('callImagesEdits', () => {
  test('returns ok=false because Copilot does not support images_edits endpoint', async () => {
    const provider = makeProvider()
    const out = await provider.callImagesEdits!({ model: 'dall-e-3', image: 'x', prompt: 'y' })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.error).toBeInstanceOf(HTTPError)
  })
})
