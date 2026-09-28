import { expect, test, beforeEach } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { ResponsesResult, ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import { respondResponses } from '../../../../src/data-plane/chat-flow/responses/respond.ts'
import { setupTestPlatform } from '../../../_setup-platform.ts'

const identity: TelemetryModelIdentity = {
  incomingModel: 'gpt-5.6-sol-fast',
  model: 'gpt-5.6-sol-fast', upstream: 'test', modelKey: 'gpt-5.6-sol-fast', cost: null,
}

beforeEach(() => setupTestPlatform())

const frames = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const response: ResponsesResult = { id: 'resp_1', object: 'response', model: 'gpt-5.6-sol', output: [], status: 'completed', error: null, incomplete_details: null }
  yield eventFrame({ type: 'response.created', response } as ResponsesStreamEvent)
  yield eventFrame({ type: 'response.completed', response } as ResponsesStreamEvent)
}

test('Responses stream and JSON retain mapped destination when upstream echoes base', async () => {
  const stream = await respondResponses(llmEventResult(frames(), identity), { wantsStream: true })
  expect(await stream.text()).toContain('"model":"gpt-5.6-sol-fast"')
  const json = await respondResponses(llmEventResult(frames(), identity), { wantsStream: false })
  expect((await json.json() as { model: string }).model).toBe('gpt-5.6-sol-fast')
})

test('Responses stream keeps public model for a modelVersion provider revision', async () => {
  async function* source(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', modelVersion: 'gpt-4-turbo-2025', response: { id: 'x', object: 'response', model: 'gpt-4-turbo-2025', output: [], status: 'completed', error: null, incomplete_details: null } } as never)
  }
  const response = await respondResponses(llmEventResult(source(), { ...identity, model: 'gpt-4-turbo', modelKey: 'gpt-4-turbo' }), { wantsStream: true })
  expect(await response.text()).toContain('"modelVersion":"gpt-4-turbo"')
})

test('Responses response.failed records failed performance without usage', async () => {
  const { repo } = setupTestPlatform()
  const failedIdentity: TelemetryModelIdentity = {
    incomingModel: 'public-response-model',
    model: 'public-response-model', upstream: 'test', modelKey: 'provider-response-model', cost: null,
  }
  async function* failedFrames(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({
      type: 'response.failed',
      response: {
        id: 'resp_failed', object: 'response', model: 'provider-response-model', output: [],
        status: 'failed', error: { code: 'server_error', message: 'upstream unavailable' }, incomplete_details: null,
      },
    } as ResponsesStreamEvent)
  }
  const response = await respondResponses(
    llmEventResult(failedFrames(), failedIdentity, {
      keyId: 'response-failed-key', model: failedIdentity.model, modelKey: failedIdentity.modelKey,
      upstream: 'test', stream: false, runtimeLocation: 'bun',
    }),
    {
      wantsStream: false,
      telemetryCtx: {
        incomingModel: 'test-model',
        apiKeyId: 'response-failed-key' as never, userAgent: null, requestId: 'response-failed-request',
        isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'responses',
      },
    },
  )
  expect((await response.json() as { status: string }).status).toBe('failed')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await repo.usage.query({
    keyId: 'response-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })).toEqual([])
  const performance = await repo.performance.query({
    keyId: 'response-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary[0]).toMatchObject({ model: 'public-response-model', errors: 1 })
})

test('Responses translated stream receives and outputs the mapped destination', async () => {
  let contextModel = ''
  const result = llmEventResult(
    frames() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
    identity,
    undefined,
    undefined,
    undefined,
    async function* (_events, context) {
      contextModel = context.model ?? ''
      const response: ResponsesResult = { id: 'translated', object: 'response', model: 'gpt-5.6-sol', output: [], status: 'completed', error: null, incomplete_details: null }
      yield { type: 'response.completed', response }
    },
  )
  const response = await respondResponses(result, { wantsStream: true })
  expect(await response.text()).toContain('"model":"gpt-5.6-sol-fast"')
  expect(contextModel).toBe('gpt-5.6-sol-fast')
})

test('Responses persistence honors authoritative finalMetadata over observed resolver', async () => {
  let persisted: TelemetryModelIdentity | undefined
  const dump = {
    frame: () => {}, failed: () => {}, success: (value: TelemetryModelIdentity) => { persisted = value },
  }
  const authoritative = { ...identity, model: 'authoritative', modelKey: 'authoritative', cost: { inputPerM: 8 } as never }
  const result = llmEventResult(
    frames(), identity, undefined, Promise.resolve({ modelIdentity: authoritative }), undefined, undefined,
    (modelKey) => ({ ...identity, model: modelKey, modelKey, cost: { inputPerM: 1 } as never }),
  )
  const response = await respondResponses(result, { wantsStream: false, dump: dump as never })
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(persisted).toBe(authoritative)
})

test('Responses translateBody receives the observed effective model', async () => {
  let model = ''
  const result = llmEventResult(frames(), identity, undefined, undefined, async (body, ctx) => {
    model = ctx.model ?? ''
    return body
  })
  await (await respondResponses(result, { wantsStream: false })).json()
  expect(model).toBe('gpt-5.6-sol-fast')
})

test('Responses caller cancellation records dump and observed usage without awaiting finalMetadata', async () => {
  const abort = new AbortController()
  let cancelled = 0
  let failed = 0
  let tokens: unknown
  const dump = { frame: () => {}, cancelled: () => { cancelled++ }, failed: () => { failed++ }, success: (_identity: unknown, usage: unknown) => { tokens = usage } }
  async function* source(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.incomplete', response: { id: 'cancel', object: 'response', model: identity.model, output: [], status: 'in_progress', error: null, incomplete_details: null, usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } })
    await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('abort reason must not be an upstream failure')
  }
  const result = { ...llmEventResult(source(), identity), finalMetadata: new Promise<never>(() => {}) }
  const response = await respondResponses(result, { wantsStream: true, downstreamAbortController: abort, dump: dump as never })
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  await reader?.read()
  await reader?.cancel('private caller reason')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cancelled).toBeGreaterThan(0)
  expect(failed).toBe(0)
  expect(tokens).toMatchObject({ input: 7, output: 2 })
})

for (const wantsStream of [true, false]) {
  test(`Responses ${wantsStream ? 'SSE' : 'JSON'} terminal merges closed outputs and keeps richer terminal values`, async () => {
    const item = (id: string, text = id) => ({ type: 'message' as const, id, role: 'assistant' as const, content: [{ type: 'output_text' as const, text }] })
    async function* source(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: item('b', 'old') })
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: item('a') })
      yield eventFrame({ type: 'response.completed', response: { id: 'merged', object: 'response', model: identity.model, output: [item('b', 'final'), item('extra')], status: 'completed', error: null, incomplete_details: null } })
    }
    const response = await respondResponses(llmEventResult(source(), identity), { wantsStream })
    const text = await response.text()
    const terminal: ResponsesResult = wantsStream
      ? (JSON.parse(text.split('\n').filter((line) => line.startsWith('data: ')).at(-1)?.slice(6) ?? '{}') as { response: ResponsesResult }).response
      : JSON.parse(text) as ResponsesResult
    expect(terminal.output).toEqual([item('a'), item('b', 'final'), item('extra')])
  })
}

for (const bridge of [false, true]) {
  for (const wantsStream of [true, false]) {
    const label = `${bridge ? 'bridged' : 'event'} ${wantsStream ? 'SSE' : 'JSON'}`
    const input = async () => {
      if (!bridge) return llmEventResult(frames(), identity)
      const response = wantsStream
        ? new Response((await Array.fromAsync(frames())).map((f) => f.type === 'event' ? `event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n` : '').join(''), { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ id: 'resp_1', output: [], status: 'completed', model: identity.model })
      return { kind: 'bridged-response' as const, response }
    }
    test(`${label} waits for snapshot before exposing completed success`, async () => {
      const gate = Promise.withResolvers<void>()
      let called = false
      let settled = false
      let text = ''
      const pending = respondResponses(await input(), {
        wantsStream,
        onCompleted: async () => { called = true; await gate.promise },
      }).then(async (res) => { text = await res.text(); settled = true })
      await new Promise((resolve) => setTimeout(resolve, 10))
      try {
        expect(called).toBe(true)
        expect(settled).toBe(false)
      } finally { gate.resolve(); await pending }
      expect(text).toContain('completed')
    })
    test(`${label} rejects snapshot failures without exposing private storage errors or success`, async () => {
      const res = await respondResponses(await input(), {
        wantsStream,
        onCompleted: async () => { throw new Error('private prompt and sqlite credentials') },
      })
      const text = await res.text()
      if (wantsStream) expect(text).toContain('event: error')
      else expect(res.status).toBe(502)
      expect(text).not.toContain('response.completed')
      expect(text).not.toContain('private prompt')
    })
  }
}

test('abort during snapshot save suppresses terminal and stops consuming subsequent frames', async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const abort = new AbortController()
  let drained = false
  async function* source(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield* frames()
    drained = true
  }
  const res = await respondResponses(llmEventResult(source(), identity), {
    wantsStream: true, downstreamAbortController: abort,
    onCompleted: async () => { entered.resolve(); await gate.promise },
  })
  const textPromise = res.text()
  await Promise.race([entered.promise, new Promise((resolve) => setTimeout(resolve, 10))])
  abort.abort()
  gate.resolve()
  expect(await textPromise).not.toContain('response.completed')
  expect(drained).toBe(false)
})

for (const wantsStream of [true, false]) {
  test(`interceptor replacement cannot bypass ${wantsStream ? "SSE" : "JSON"} persistence failure`, async () => {
    const result = { ...llmEventResult(frames(), identity), __interceptorReplaced: true as const, finalMetadata: Promise.resolve({ modelIdentity: identity }) }
    const response = await respondResponses(result, { wantsStream, onCompleted: async () => { throw new Error("private shortcut data") } })
    const body = await response.text()
    if (wantsStream) { expect(body).toContain("event: error"); expect(body).not.toContain("response.completed") }
    else expect(response.status).toBe(502)
    expect(body).not.toContain("private shortcut data")
  })
}

for (const wantsStream of [true, false]) {
  test(`request abort releases pending ${wantsStream ? "SSE" : "JSON"} save without waiting for storage`, async () => {
    const entered = Promise.withResolvers<void>()
    const save = Promise.withResolvers<void>()
    const abort = new AbortController()
    const result = respondResponses(llmEventResult(frames(), identity), {
      wantsStream, downstreamAbortController: abort,
      onCompleted: async () => { entered.resolve(); await save.promise },
    }).then(async (response) => ({ status: response.status, body: await response.text() }))
    await entered.promise
    abort.abort()
    try {
      const output = await Promise.race([result, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30))])
      expect(output).not.toBeNull()
      expect(output?.body).not.toContain("response.completed")
      if (!wantsStream) expect(output?.status).toBe(502)
    } finally { save.resolve(); await result }
  })
}

test('bridged SSE abort closes downstream while both snapshot save and source cancellation remain pending', async () => {
  const abort = new AbortController()
  const entered = Promise.withResolvers<void>()
  let cancellations = 0
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'pending_bridge', status: 'completed', output: [] } })}\n\n`))
    },
    cancel() { cancellations++; return new Promise<void>(() => {}) },
  })
  const response = await respondResponses({
    kind: 'bridged-response', response: new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  }, {
    wantsStream: true, downstreamAbortController: abort,
    onCompleted: () => { entered.resolve(); return new Promise<void>(() => {}) },
  })
  const text = response.text()
  await entered.promise
  abort.abort()
  const output = await Promise.race([text, Bun.sleep(30).then(() => null)])
  expect(output).toBe('')
  expect(cancellations).toBe(1)
  expect(source.locked).toBe(false)
})
