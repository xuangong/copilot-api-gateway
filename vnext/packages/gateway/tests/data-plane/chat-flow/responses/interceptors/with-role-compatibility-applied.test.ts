import { test, expect } from 'bun:test'
import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-role-compatibility-applied'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'

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
  endpoint: 'responses',
  enabledFlags,
  sourceApi: 'responses',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
      stubIdentity,
    ),
  )

test('responses: promote-system-to-developer on message items', async () => {
  const i = inv(
    {
      input: [
        { type: 'message', role: 'system', content: 'lead' },
        { type: 'message', role: 'user', content: 'u' },
      ],
    },
    new Set(['promote-system-to-developer']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const input = i.payload.input as Array<{ type: string; role?: string }>
  expect(input[0].role).toBe('developer')
})

test('responses: demote-developer-to-system on message items', async () => {
  const i = inv(
    {
      input: [
        { type: 'message', role: 'developer', content: 'd' },
      ],
    },
    new Set(['demote-developer-to-system']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const input = i.payload.input as Array<{ role?: string }>
  expect(input[0].role).toBe('system')
})

test('responses: demote-interleaved-system-to-user leaves leading system alone', async () => {
  const i = inv(
    {
      input: [
        { type: 'message', role: 'system', content: 'lead' },
        { type: 'message', role: 'system', content: 'lead2' },
        { type: 'message', role: 'user', content: 'u' },
        { type: 'message', role: 'system', content: 'mid' },
      ],
    },
    new Set(['demote-interleaved-system-to-user']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const roles = (i.payload.input as Array<{ role?: string }>).map((m) => m.role)
  expect(roles).toEqual(['system', 'system', 'user', 'user'])
})

test('responses: function_call items pass through untouched', async () => {
  const i = inv(
    {
      input: [
        { type: 'message', role: 'system', content: 'lead' },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
        { type: 'message', role: 'user', content: 'u' },
      ],
    },
    new Set(['promote-system-to-developer', 'demote-interleaved-system-to-user']),
  )
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const input = i.payload.input as Array<{ type: string; role?: string }>
  expect(input[0].role).toBe('developer')
  expect(input[1].type).toBe('function_call')
  expect(input[1].role).toBeUndefined()
})

test('responses: no-op when no flag set', async () => {
  const i = inv({
    input: [
      { type: 'message', role: 'system', content: 'lead' },
      { type: 'message', role: 'user', content: 'u' },
      { type: 'message', role: 'system', content: 'mid' },
    ],
  })
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  const roles = (i.payload.input as Array<{ role?: string }>).map((m) => m.role)
  expect(roles).toEqual(['system', 'user', 'system'])
})
