import { test, expect } from 'bun:test'
import { withUpstreamTelemetry } from '../../../../src/data-plane/chat-flow/shared/upstream-telemetry.ts'
import { STREAM_TAIL_MAX_FRAMES } from "../../../../src/data-plane/chat-flow/shared/stream-tail"
import type { ProtocolFrame } from '@vibe-core/result'

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

test('chat_completions: usage is accumulated from the Zhipu/GLM vLLM fork shape', async () => {
  // The fork closes the stream with a placeholder choice instead of `choices: []`.
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { choices: [{ index: 0, delta: { content: 'hi' } }] } },
    { type: 'event', event: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    { type: 'event', event: { choices: [{ index: 0 }], usage: { prompt_tokens: 8, completion_tokens: 9 } } },
    { type: 'done' },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'chat_completions' })
  for await (const _ of events) { /* drain */ }
  const md = await finalMetadata
  expect(md.usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 9 })
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

test('messages: message_delta usage gets accumulated', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    { type: 'event', event: { type: 'message_delta', usage: { output_tokens: 7 } } },
    { type: 'event', event: { type: 'message_stop' } },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'messages' })
  for await (const frame of events) void frame
  const md = await finalMetadata
  expect(md.failed).toBe(false)
})

test('eof without terminal frame throws and marks failed=true', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { choices: [{ delta: { content: 'partial' } }] } },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'chat_completions' })
  await expect((async () => { for await (const frame of events) void frame })()).rejects.toThrow("without a terminal")
  const md = await finalMetadata
  expect(md.failed).toBe(true)
})


for (const failure of ["throw", "frames", "bytes"] as const) {
  test(`chat post-finish usage survives terminal ${failure} rejection within shared tail bounds`, async () => {
    const finish = { type: "event" as const, event: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } }
    const usage = { type: "event" as const, event: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } } }
    let closed = false
    let failures = 0
    async function* source(): AsyncGenerator<ProtocolFrame<unknown>> {
      try {
        yield finish
        yield usage
        if (failure === "throw") throw new Error("late source failure")
        if (failure === "bytes") yield { type: "event", event: { text: "x".repeat(1_100_000) } }
        else for (let i = 0; i < STREAM_TAIL_MAX_FRAMES; i++) yield { type: "event", event: {} }
      } finally { closed = true }
    }
    const output = withUpstreamTelemetry(source(), { protocol: "chat_completions", onFailure: () => { failures++ } })
    const seen: ProtocolFrame<unknown>[] = []
    await expect((async () => { for await (const frame of output.events) seen.push(frame) })()).rejects.toThrow(failure === "throw" ? "late source failure" : "terminal observation limit")
    expect(seen).toEqual([finish, usage])
    expect(await output.finalMetadata).toMatchObject({ failed: true, usage: usage.event.usage })
    expect(failures).toBe(1)
    expect(closed).toBe(true)
  })
}

test("cancellation during buffered Chat tail interrupts the pending read and consumes its late rejection", async () => {
  const abort = new AbortController()
  const pending = Promise.withResolvers<IteratorResult<ProtocolFrame<unknown>>>()
  const waiting = Promise.withResolvers<void>()
  let reads = 0
  let returned = false
  const source: AsyncIterable<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          reads++
          if (reads === 1) return { done: false, value: { type: "event", event: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } } }
          if (reads === 2) return { done: false, value: { type: "event", event: { choices: [], usage: { completion_tokens: 4 } } } }
          waiting.resolve()
          return pending.promise
        },
        async return() { returned = true; return { done: true, value: undefined } },
      }
    },
  }
  const output = withUpstreamTelemetry(source, { protocol: "chat_completions", abortSignal: abort.signal })
  await output.events.next()
  const next = output.events.next()
  await waiting.promise
  abort.abort()
  expect((await next).done).toBe(true)
  expect(await output.finalMetadata).toMatchObject({ failed: false, cancelled: true, usage: { completion_tokens: 4 } })
  expect(returned).toBe(true)
  pending.reject(new Error("late read failure"))
  await Promise.resolve()
})
