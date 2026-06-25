import { test, expect } from 'bun:test'
import { withUpstreamTelemetry } from '../../../../src/data-plane/chat-flow/shared/upstream-telemetry.ts'
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
  for await (const _ of events) {}
  const md = await finalMetadata
  expect(md.failed).toBe(false)
})

test('eof without terminal frame → failed=true', async () => {
  const frames: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { choices: [{ delta: { content: 'partial' } }] } },
  ]
  const { events, finalMetadata } = withUpstreamTelemetry(gen(frames), { protocol: 'chat_completions' })
  for await (const _ of events) {}
  const md = await finalMetadata
  expect(md.failed).toBe(true)
})
