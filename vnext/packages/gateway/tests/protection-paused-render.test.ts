import { beforeEach, expect, test } from 'bun:test'
import { llmInternalErrorResult } from '@vibe-llm/protocols/common'
import { respondChatCompletions } from '../src/data-plane/chat-flow/chat-completions/respond.ts'
import { respondMessages } from '../src/data-plane/chat-flow/messages/respond.ts'
import { respondGemini } from '../src/data-plane/chat-flow/gemini/respond.ts'
import { respondResponses } from '../src/data-plane/chat-flow/responses/respond.ts'
import { chatCompletionsAttempt } from '../src/data-plane/chat-flow/chat-completions/attempt.ts'
import { messagesAttempt } from '../src/data-plane/chat-flow/messages/attempt.ts'
import { responsesAttempt } from '../src/data-plane/chat-flow/responses/attempt.ts'
import { geminiAttempt } from '../src/data-plane/chat-flow/gemini/attempt.ts'
import { setupTestPlatform } from './_setup-platform.ts'

beforeEach(() => setupTestPlatform())
const paused = () => llmInternalErrorResult(503, new Error('Upstream "A" is paused'), undefined, 'upstream-paused', { code: 'upstream_paused', retryAfterSeconds: 120 })
const plain = () => llmInternalErrorResult(502, new Error('boom'))

test('chat completions: code in the body and Retry-After on the response', async () => {
  const r = await respondChatCompletions(paused(), { wantsStream: false, includeUsageChunk: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(await r.json()).toEqual({ error: { message: 'Upstream "A" is paused', code: 'upstream_paused' } })
  const other = await respondChatCompletions(plain(), { wantsStream: false, includeUsageChunk: false })
  expect(other.headers.get('retry-after')).toBeNull()
  expect(await other.json()).toEqual({ error: { message: 'boom' } })
})

test('messages: api_error with the code and Retry-After', async () => {
  const r = await respondMessages(paused(), { wantsStream: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(await r.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'Upstream "A" is paused', code: 'upstream_paused' } })
})

test('gemini: Google RPC body unchanged, Retry-After added', async () => {
  const r = await respondGemini(paused(), { wantsStream: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(((await r.json()) as { error: { code: number } }).error.code).toBe(503)
})

test('responses: api_error with the code and Retry-After', async () => {
  const r = await respondResponses(paused(), { wantsStream: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(await r.json()).toMatchObject({ error: { type: 'api_error', code: 'upstream_paused' } })
})

test('every attempt maps an upstream-paused selection to a 503 internal error carrying code and retry seconds', async () => {
  const selection = { kind: 'upstream-paused', bareModel: 'm', message: 'Upstream "A" is paused', retryAfterSeconds: 42 }
  const common = { auth: { ownerId: 'o' }, ctx: { requestStartedAt: Date.now() }, telemetryCtx: {} as never, selectBinding: async () => selection }
  const results = await Promise.all([
    chatCompletionsAttempt.generate({ ...common, payload: { model: 'm', messages: [] } } as never),
    messagesAttempt.generate({ ...common, payload: { model: 'm', messages: [] } } as never),
    responsesAttempt.generate({ ...common, payload: { model: 'm', input: [] } } as never),
    geminiAttempt.generate({ ...common, model: 'm', payload: {} } as never),
  ])
  for (const result of results) {
    expect(result).toMatchObject({ type: 'internal-error', status: 503, reason: 'upstream-paused', code: 'upstream_paused', retryAfterSeconds: 42 })
  }
})
