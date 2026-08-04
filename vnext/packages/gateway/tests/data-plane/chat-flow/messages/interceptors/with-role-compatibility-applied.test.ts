import { test, expect } from 'bun:test'
import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-role-compatibility-applied'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const inv = (
  payload: Record<string, unknown>,
  enabledFlags: ReadonlySet<string> = new Set(['demote-interleaved-system-to-user']),
): Invocation => ({
  endpoint: 'messages',
  enabledFlags,
  sourceApi: 'messages',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })() as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
      stubIdentity,
    ),
  )

test('messages: interleaved system → user when flag on', async () => {
  const i = inv({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'system', content: 'sys mid' },
      { role: 'assistant', content: 'b' },
    ],
  })
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  expect((i.payload.messages as Array<{ role: string }>)[1].role).toBe('user')
})

test('messages: no-op when flag off', async () => {
  const i = inv(
    {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'system', content: 'sys mid' },
      ],
    },
    new Set(),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  expect((i.payload.messages as Array<{ role: string }>)[1].role).toBe('system')
})

test('messages: no-op when messages missing', async () => {
  const i = inv({ model: 'x' })
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  expect(i.payload.messages).toBeUndefined()
})
