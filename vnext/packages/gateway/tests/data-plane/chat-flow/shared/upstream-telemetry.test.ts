// vnext/packages/gateway/tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts
import { test, expect } from 'bun:test'
import { withUpstreamTelemetry } from '../../../../src/data-plane/chat-flow/shared/upstream-telemetry'
import { eventFrame, doneFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const makeStream = async function* (
  events: ReadonlyArray<ChatCompletionsStreamEvent | 'done'>,
) {
  for (const e of events) yield e === 'done' ? doneFrame() : eventFrame(e)
}

const baseTelemetryCtx = () => {
  const recordedLatencies: number[] = []
  const recordedSuccess: Array<{ usage: unknown }> = []
  const recordedFailure: Array<{ reason: string }> = []
  return {
    recorder: {
      recordFirstByteLatency: (ms: number) => recordedLatencies.push(ms),
      recordSuccess: (usage: unknown) => recordedSuccess.push({ usage }),
      recordFailure: (reason: string) => recordedFailure.push({ reason }),
    },
    recordedLatencies,
    recordedSuccess,
    recordedFailure,
  }
}

test('records first-byte latency exactly once on first frame', async () => {
  const t = baseTelemetryCtx()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any,
      'done',
    ]),
    { abortSignal: undefined },
    t.recorder,
    { protocol: 'chat_completions' },
  )

  for await (const _ of stream) { /* drain */ }
  expect(t.recordedLatencies.length).toBe(1)
})

test('accumulates usage from trailing usage chunk and records on success', async () => {
  const t = baseTelemetryCtx()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any,
      { id: 'a', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } as any,
      'done',
    ]),
    { abortSignal: undefined },
    t.recorder,
    { protocol: 'chat_completions' },
  )
  for await (const _ of stream) { /* drain */ }
  expect(t.recordedSuccess.length).toBe(1)
  expect(t.recordedSuccess[0]!.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
})

test('records failure on EOF without terminal frame', async () => {
  const t = baseTelemetryCtx()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
      // no done, no terminal
    ]),
    { abortSignal: undefined },
    t.recorder,
    { protocol: 'chat_completions' },
  )
  for await (const _ of stream) { /* drain */ }
  expect(t.recordedFailure.length).toBe(1)
  expect(t.recordedFailure[0]!.reason).toBe('eof-without-terminal')
})

test('records "client-aborted" when abortSignal already aborted at EOF', async () => {
  const t = baseTelemetryCtx()
  const ac = new AbortController()
  ac.abort()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
    ]),
    { abortSignal: ac.signal },
    t.recorder,
    { protocol: 'chat_completions' },
  )
  for await (const _ of stream) { /* drain */ }
  expect(t.recordedFailure[0]!.reason).toBe('client-aborted')
})

test('records failure with thrown error message and re-throws', async () => {
  const t = baseTelemetryCtx()
  const failing = async function* (): AsyncGenerator<any> {
    yield eventFrame({ id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'x' } }] } as any)
    throw new Error('upstream-sse-error')
  }
  const stream = withUpstreamTelemetry(failing(), { abortSignal: undefined }, t.recorder, { protocol: 'chat_completions' })
  let caught: unknown = null
  try { for await (const _ of stream) { /* drain */ } } catch (e) { caught = e }
  expect((caught as Error).message).toBe('upstream-sse-error')
  expect(t.recordedFailure[0]!.reason).toBe('upstream-sse-error')
})

test('messages protocol: message_stop is terminal-success, error is terminal-failure', async () => {
  const tOk = baseTelemetryCtx()
  const ok = withUpstreamTelemetry(
    makeStream([{ type: 'message_stop' } as any]),
    { abortSignal: undefined }, tOk.recorder, { protocol: 'messages' },
  )
  for await (const _ of ok) { /* drain */ }
  expect(tOk.recordedSuccess.length).toBe(1)

  const tErr = baseTelemetryCtx()
  const err = withUpstreamTelemetry(
    makeStream([{ type: 'error', error: { type: 'overloaded_error', message: 'x' } } as any]),
    { abortSignal: undefined }, tErr.recorder, { protocol: 'messages' },
  )
  for await (const _ of err) { /* drain */ }
  expect(tErr.recordedFailure[0]!.reason).toBe('terminal-failure-frame')
})
