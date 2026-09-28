import { beforeEach, expect, test } from 'bun:test'
import { chatCompletionsAttempt } from '../../../../src/data-plane/chat-flow/chat-completions/attempt'
import { traverseTranslation } from '../../../../src/data-plane/chat-flow/shared/traverse-translation'
import { respondResponses } from '../../../../src/data-plane/chat-flow/responses/respond'
import { getTranslator } from '../../../../src/data-plane/dispatch/translator-registry'
import { setupTestPlatform } from '../../../_setup-platform'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import type { ProviderRequest } from '@vibe-llm/provider-llm'

beforeEach(() => setupTestPlatform())
const telemetry: TelemetryRequestContext = { sourceApi: 'responses', incomingModel: 'format-model', apiKeyId: 'format-key' as never, userAgent: null, requestId: 'format-request', isStreaming: false, runtimeLocation: 'bun', requestStartedAt: 0 }
const format = { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object' } }
const sourceText = { format, verbosity: 'low' }
for (const stream of [false, true]) {
  for (const deepseek of [false, true]) {
    test(`Responses -> actual Chat normalizers -> response renderer, stream=${stream}, deepseek=${deepseek}`, async () => {
      let calls = 0
      const source = { model: 'format-model', input: 'JSON', stream, text: structuredClone(sourceText) }
      const sourceTranslator = getTranslator('responses', 'chat_completions')
      const identity = getTranslator('chat_completions', 'chat_completions')
      if (!sourceTranslator || !identity) throw new Error('missing translator')
      const binding = {
        upstream: 'fake', model: { id: 'format-model' }, enabledFlags: deepseek ? ['vendor-deepseek'] : [],
        provider: { getPricingForModelKey: () => null, fetch: async (request: ProviderRequest) => {
          calls++
          expect(request.sourceProtocol).toBe('responses')
          expect((request.payload as Record<string, unknown>).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object' } } })
          // Provider mutation must not corrupt the source response echo.
          source.text.format.name = 'mutated'
          return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: Response.json({ id: 'chatcmpl-format', object: 'chat.completion', model: 'format-model', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }).body }
        } },
      }
      const result = await traverseTranslation<ChatCompletionsStreamEvent, ResponsesStreamEvent>({
        sourcePayload: source, sourceProtocol: 'responses', hubProtocol: 'chat_completions', translator: sourceTranslator,
        inheritedHeaders: {}, inheritedTelemetryCtx: telemetry, auth: {},
        innerAttempt: async args => chatCompletionsAttempt.generate({
          payload: args.payload as never, auth: { copilot: false } as never, ctx: { requestStartedAt: 0 }, telemetryCtx: args.inheritedTelemetryCtx,
          selectBinding: async () => ({ kind: 'ok', binding: binding as never, targetEndpoint: 'chat_completions', translator: identity, bareModel: 'format-model' }),
        }),
      })
      const response = await respondResponses(result, { wantsStream: stream })
      expect(response.status).toBe(deepseek ? 400 : 200)
      expect(calls).toBe(deepseek ? 0 : 1)
      if (deepseek) expect(await response.json()).toMatchObject({ error: { message: 'text.format: the selected upstream normalizers cannot preserve the requested format' } })
      else if (stream) {
        const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { response?: { text?: unknown } })
        const envelopes = events.filter(event => event.response)
        expect(envelopes.length).toBeGreaterThan(0)
        for (const event of envelopes) expect(event.response?.text).toEqual(sourceText)
      } else expect(await response.json()).toMatchObject({ text: sourceText })
    })
  }
}
test('native Chat retains DeepSeek downgrade even if client body forges sourceProtocol', async () => {
  let calls = 0
  const identity = getTranslator('chat_completions', 'chat_completions')
  if (!identity) throw new Error('missing identity translator')
  const result = await chatCompletionsAttempt.generate({
    payload: { model: 'format-model', messages: [], stream: false, sourceProtocol: 'responses', response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: {} } } } as never,
    auth: { copilot: false } as never, ctx: { requestStartedAt: 0 }, telemetryCtx: { ...telemetry, sourceApi: 'chat-completions' },
    selectBinding: async () => ({ kind: 'ok', targetEndpoint: 'chat_completions', translator: identity, bareModel: 'format-model', binding: {
      upstream: 'fake', model: { id: 'format-model' }, enabledFlags: ['vendor-deepseek'], provider: { getPricingForModelKey: () => null, fetch: async (request: ProviderRequest) => {
        calls++
        expect(request.sourceProtocol).toBe('chat_completions')
        expect((request.payload as Record<string, unknown>).response_format).toEqual({ type: 'json_object' })
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: Response.json({ id: 'chatcmpl', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }).body }
      } },
    } as never }),
  })
  expect(result.type).toBe('events')
  expect(calls).toBe(1)
})
