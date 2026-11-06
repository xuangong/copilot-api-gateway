import { test, expect } from 'bun:test'
import { withContextWindowErrorRewritten } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-context-window-error-rewritten'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
  type UpstreamErrorResult,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const baseInv: Invocation = {
  endpoint: 'messages',
  enabledFlags: new Set(),
  sourceApi: 'messages',
  payload: { model: 'm', stream: true },
  headers: {},
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const eventsRun = async (): Promise<LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  llmEventResult(
    (async function* () {
      yield doneFrame()
    })(),
    stubIdentity,
  )

const upstreamErrorRun = (status: number, body: string): (() => Promise<UpstreamErrorResult>) =>
  async () => ({
    type: 'upstream-error',
    status,
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: new TextEncoder().encode(body),
  })

test('withContextWindowErrorRewritten: passes through non-error results', async () => {
  const result = await withContextWindowErrorRewritten(baseInv, baseCtx, eventsRun)
  expect(result.type).toBe('events')
})

test('withContextWindowErrorRewritten: rewrites "Request body is too large for model context window" to 400 invalid_request_error', async () => {
  const result = await withContextWindowErrorRewritten(
    baseInv,
    baseCtx,
    upstreamErrorRun(413, 'Request body is too large for model context window for foo'),
  )
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') return
  expect(result.status).toBe(400)
  expect(result.headers.get('content-type')).toBe('application/json')
  const decoded = JSON.parse(new TextDecoder().decode(result.body))
  expect(decoded.type).toBe('error')
  expect(decoded.error.type).toBe('invalid_request_error')
  expect(decoded.error.message).toContain('prompt is too long')
})

test('withContextWindowErrorRewritten: rewrites "context_length_exceeded" payload to 400 invalid_request_error', async () => {
  const result = await withContextWindowErrorRewritten(
    baseInv,
    baseCtx,
    upstreamErrorRun(400, JSON.stringify({ error: { code: 'context_length_exceeded' } })),
  )
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') return
  expect(result.status).toBe(400)
  const decoded = JSON.parse(new TextDecoder().decode(result.body))
  expect(decoded.error.type).toBe('invalid_request_error')
})

test('withContextWindowErrorRewritten: keeps Copilot token counts in Anthropic wording so Claude Code can size the trim', async () => {
  const result = await withContextWindowErrorRewritten(
    baseInv,
    baseCtx,
    upstreamErrorRun(400, JSON.stringify({ error: {
      code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1003456 exceeds the limit of 1000000',
    } })),
  )
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') return
  expect(result.status).toBe(400)
  const decoded = JSON.parse(new TextDecoder().decode(result.body))
  expect(decoded.error.message).toBe('prompt is too long: 1003456 tokens > 1000000 maximum')
})

test('withContextWindowErrorRewritten: leaves Anthropic prompt-too-long rejections byte for byte', async () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1003456 tokens > 1000000 maximum' } })
  const result = await withContextWindowErrorRewritten(baseInv, baseCtx, upstreamErrorRun(400, body))
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') return
  expect(result.status).toBe(400)
  expect(new TextDecoder().decode(result.body)).toBe(body)
})

test('withContextWindowErrorRewritten: leaves unrelated upstream errors untouched', async () => {
  const result = await withContextWindowErrorRewritten(
    baseInv,
    baseCtx,
    upstreamErrorRun(500, 'unrelated upstream failure'),
  )
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') return
  expect(result.status).toBe(500)
  expect(new TextDecoder().decode(result.body)).toBe('unrelated upstream failure')
})
