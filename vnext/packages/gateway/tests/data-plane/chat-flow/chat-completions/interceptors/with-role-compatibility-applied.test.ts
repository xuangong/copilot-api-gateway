import { test, expect } from 'bun:test'
import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-role-compatibility-applied'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const inv = (
  payload: Record<string, unknown>,
  enabledFlags: ReadonlySet<string> = new Set(),
): Invocation => ({
  endpoint: 'chat_completions',
  enabledFlags,
  sourceApi: 'chat_completions',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
      stubIdentity,
    ),
  )

test('cc: promote-system-to-developer rewrites leading system', async () => {
  const i = inv(
    {
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    },
    new Set(['promote-system-to-developer']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const msgs = i.payload.messages as Array<{ role: string }>
  expect(msgs[0].role).toBe('developer')
  expect(msgs[1].role).toBe('user')
})

test('cc: demote-developer-to-system rewrites developer', async () => {
  const i = inv(
    {
      messages: [
        { role: 'developer', content: 'd' },
        { role: 'user', content: 'u' },
      ],
    },
    new Set(['demote-developer-to-system']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  expect((i.payload.messages as Array<{ role: string }>)[0].role).toBe('system')
})

test('cc: demote-interleaved-system-to-user leaves leading system alone', async () => {
  const i = inv(
    {
      messages: [
        { role: 'system', content: 'lead' },
        { role: 'system', content: 'lead2' },
        { role: 'user', content: 'u' },
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: 'a' },
      ],
    },
    new Set(['demote-interleaved-system-to-user']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const roles = (i.payload.messages as Array<{ role: string }>).map((m) => m.role)
  expect(roles).toEqual(['system', 'system', 'user', 'user', 'assistant'])
})

test('cc: promote then demote-interleaved treats promoted-developer as non-system', async () => {
  // promote makes leading system into developer; interleaved-demote should
  // not rewrite it since it's no longer role:system.
  const i = inv(
    {
      messages: [
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'u' },
        { role: 'system', content: 'mid' },
      ],
    },
    new Set(['promote-system-to-developer', 'demote-interleaved-system-to-user']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const roles = (i.payload.messages as Array<{ role: string }>).map((m) => m.role)
  expect(roles).toEqual(['developer', 'user', 'developer'])
})

test('cc: no-op when no flag set', async () => {
  const i = inv({
    messages: [
      { role: 'system', content: 'lead' },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'mid' },
    ],
  })
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const roles = (i.payload.messages as Array<{ role: string }>).map((m) => m.role)
  expect(roles).toEqual(['system', 'user', 'system'])
})
