import { test, expect } from 'bun:test'
import { runCountTokensPrelude } from '../src/transforms/count-tokens-prelude'

test('strips context_management', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'hi' }],
    context_management: { foo: 'bar' },
  }
  runCountTokensPrelude(payload)
  expect(payload.context_management).toBeUndefined()
})

test('strips cache_control on content blocks', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
  }
  runCountTokensPrelude(payload)
  const msg = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
  // ttl extension stripped; base ephemeral marker stays
  expect((msg.content[0].cache_control as Record<string, unknown> | undefined)?.ttl).toBeUndefined()
})

test('promotes top-level cache_control then strips it', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'hi' }],
    cache_control: { type: 'ephemeral' },
  }
  runCountTokensPrelude(payload)
  expect(payload.cache_control).toBeUndefined()
})

test('repairs missing tool_result for orphan tool_use', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_abc', name: 'my_tool', input: {} }],
      },
      { role: 'user', content: [] },
    ],
  }
  runCountTokensPrelude(payload)
  // repairToolResultPairs adds a synthetic tool_result stub for the orphan tool_use
  const msgs = payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
  const userContent = msgs[1].content
  expect(Array.isArray(userContent)).toBe(true)
  const synthetic = userContent.find(
    (b) => b.type === 'tool_result' && b.tool_use_id === 'tu_abc',
  )
  expect(synthetic).toBeDefined()
})
