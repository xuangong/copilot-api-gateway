// packages/gateway/tests/data-plane/chat-flow/shared/protection-recording.test.ts
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { HTTPError } from '@vibe-llm/provider-llm'
import { chatCompletionsAttempt } from '../../../../src/data-plane/chat-flow/chat-completions/attempt'
import { messagesAttempt } from '../../../../src/data-plane/chat-flow/messages/attempt'
import { responsesAttempt } from '../../../../src/data-plane/chat-flow/responses/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import { ProtectionRuntime, setProtectionForTests, type UpstreamOutcome } from '../../../../src/protection/runtime'
import { __resetPlatformForTests } from '@vibe-core/platform'

const recorded: Array<UpstreamOutcome | Promise<UpstreamOutcome>> = []
beforeEach(() => {
  recorded.length = 0
  setProtectionForTests({ record: (o: UpstreamOutcome | Promise<UpstreamOutcome>) => { recorded.push(o) } } as unknown as ProtectionRuntime)
})
afterEach(() => __resetPlatformForTests())

const telemetry: TelemetryRequestContext = {
  incomingModel: 'alias', apiKeyId: 'key_test_1' as never, userAgent: 'ua', requestId: 'rid', isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(),
}
const identityTranslator = { translateRequest: (p: unknown) => p } as never
const ctx = { requestStartedAt: Date.now() }
const auth = { ownerId: 'o', copilot: false }
const json = (status: number, body: unknown) => ({ status, headers: new Headers({ 'content-type': 'application/json' }), body: new Response(JSON.stringify(body)).body })

const flows = [
  { name: 'chat_completions', model: 'gpt-x', endpoint: 'chat_completions', run: (args: any) => chatCompletionsAttempt.generate({ payload: { model: 'gpt-x', messages: [], stream: false }, ...args }) },
  { name: 'messages', model: 'claude-x', endpoint: 'messages', run: (args: any) => messagesAttempt.generate({ payload: { model: 'claude-x', messages: [], stream: false }, ...args }) },
  { name: 'responses', model: 'gpt-4o', endpoint: 'responses', run: (args: any) => responsesAttempt.generate({ payload: { model: 'gpt-4o', input: [], stream: false }, ...args }) },
] as const

for (const flow of flows) {
  const select = (fetch: unknown) => async () => ({
    kind: 'ok', targetEndpoint: flow.endpoint, translator: identityTranslator, bareModel: flow.model,
    binding: { upstream: 'up_test_fake', model: { id: flow.model }, provider: { getPricingForModelKey: () => null, fetch } },
  })

  test(`${flow.name}: a provider 429 is recorded once with upstream, key and model`, async () => {
    const fetch = mock(async () => json(429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }))
    const res = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: select(fetch) })
    expect(res.type).toBe('upstream-error')
    expect(await Promise.all(recorded)).toEqual([
      { upstreamId: 'up_test_fake', keyId: 'key_test_1', model: flow.model, cls: 'rate_limited', status: 429, code: 'rate_limit_exceeded', message: 'slow down' }])
  })

  test(`${flow.name}: a thrown HTTPError and a network failure are recorded, and the error surfaces as before`, async () => {
    const httpError = mock(async () => { throw new HTTPError('nope', new Response(JSON.stringify({ error: { message: 'filtered' } }), { status: 400 })) })
    const res = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: select(httpError) })
    expect(res.type).toBe('upstream-error')
    const net = mock(async () => { throw new TypeError('fetch failed') })
    const res2 = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: select(net) })
    expect(res2.type).toBe('internal-error')
    const outcomes = await Promise.all(recorded)
    expect(outcomes.map(o => [o.cls, o.status])).toEqual([['rejected', 400], ['network', 0]])
  })

  test(`${flow.name}: gateway-side rejections before the upstream call record nothing`, async () => {
    for (const kind of ['model-not-found', 'no-eligible-binding', 'catalog-unavailable']) {
      const res = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: async () => ({ kind, bareModel: flow.model }) })
      expect(res.type).toBe('internal-error')
    }
    expect(recorded).toHaveLength(0)
  })
}

test('a provider that retries internally: every reported attempt plus the final response is recorded once', async () => {
  const flow = flows[0]
  const fetch = mock(async (req: { onRetriedAttempt?: (a: { status?: number }) => void }) => {
    req.onRetriedAttempt?.({ status: 429 })
    req.onRetriedAttempt?.({ status: 429 })
    return json(200, { id: 'x', object: 'chat.completion', created: 1, model: 'gpt-x', choices: [] })
  })
  await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: async () => ({
    kind: 'ok', targetEndpoint: flow.endpoint, translator: identityTranslator, bareModel: flow.model,
    binding: { upstream: 'up_test_fake', model: { id: flow.model }, provider: { getPricingForModelKey: () => null, fetch } },
  }) }).catch(() => undefined)
  expect((await Promise.all(recorded)).map(o => [o.upstreamId, o.cls])).toEqual([['up_test_fake', 'rate_limited'], ['up_test_fake', 'rate_limited'], ['up_test_fake', 'ok']])
})
