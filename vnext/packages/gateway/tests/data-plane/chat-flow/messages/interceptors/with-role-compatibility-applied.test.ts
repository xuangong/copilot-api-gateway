import { test, expect } from 'bun:test'
import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-role-compatibility-applied'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

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

// Adapted from reference copilot-gateway c117da8df (#614): Claude models that support inline
// system turns accept them only at a turn boundary (after a user turn or a server-tool
// result, before an assistant turn or the end). Rewriting every system turn (the old
// flag) discards valid instructions, so the selective flag downgrades only the
// content-bearing turns that sit in a disallowed position.
// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
const DISALLOWED = new Set(['demote-disallowed-system-to-user'])
const roles = async (messages: unknown[], flags: ReadonlySet<string> = DISALLOWED) => {
  const i = inv({ messages }, flags)
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  return i.payload.messages as Array<Record<string, unknown>>
}

test('messages: disallowed-only flag rewrites a system turn after an assistant turn and keeps a valid boundary', async () => {
  const afterAssistant = await roles([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'system', content: 'late rules' },
  ])
  expect(afterAssistant[2]).toEqual({ role: 'user', content: 'late rules' })
  const validBoundary = [
    { role: 'user', content: 'q' },
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'a' },
  ]
  expect(await roles(validBoundary)).toEqual(validBoundary)
  const atEnd = [{ role: 'user', content: 'q' }, { role: 'system', content: 'rules' }]
  expect(await roles(atEnd)).toEqual(atEnd)
  const afterServerTool = [
    { role: 'assistant', content: [{ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] }] },
    { role: 'system', content: 'updated context' },
  ]
  expect(await roles(afterServerTool)).toEqual(afterServerTool)
})

test('messages: disallowed-only flag treats a leading system turn as invalid and keeps directive-only turns', async () => {
  const directive = { role: 'system', content: [], output_config: { effort: 'high' } }
  const result = await roles([
    { role: 'system', content: 'leading inline rules' },
    { role: 'assistant', content: 'a' },
    directive,
    { role: 'user', content: 'q' },
    directive,
    { role: 'system', content: [{ type: 'text', text: 'skills' }] },
    { role: 'user', content: 'current' },
  ])
  expect(result[0]).toEqual({ role: 'user', content: 'leading inline rules' })
  expect(result[2]).toBe(directive)
  expect(result[4]).toBe(directive)
  // A group is judged as a whole: this content turn follows a user turn but precedes a user turn.
  expect(result[5]).toEqual({ role: 'user', content: [{ type: 'text', text: 'skills' }] })
  // The all-system flag still rewrites everything, including a valid boundary.
  const all = await roles([{ role: 'user', content: 'q' }, { role: 'system', content: 'rules' }, { role: 'assistant', content: 'a' }], new Set(['demote-interleaved-system-to-user']))
  expect(all[1]).toEqual({ role: 'user', content: 'rules' })
})

test('messages: no-op when messages missing', async () => {
  const i = inv({ model: 'x' })
  await withRoleCompatibilityApplied(i, baseCtx, okRun)
  expect(i.payload.messages).toBeUndefined()
})
