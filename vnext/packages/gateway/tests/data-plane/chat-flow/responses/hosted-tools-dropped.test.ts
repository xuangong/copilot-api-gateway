/**
 * Hosted tools that reach a Chat/Messages target unserved are dropped (Codex
 * attaches web_search by default) — but visibly: one structured warning names
 * the request, model, target and dropped types.
 */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { warnDroppedHostedTools } from '../../../../src/data-plane/chat-flow/responses/attempt'

afterEach(() => { (console.warn as unknown as { mockRestore?: () => void }).mockRestore?.() })

test('dropped hosted tools are logged once with their types', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  warnDroppedHostedTools({ tools: [{ type: 'web_search' }, { type: 'function', name: 'f' }, { type: 'file_search' }, { type: 'web_search' }] },
    { requestId: 'req_1', model: 'claude-x', target: 'messages' })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ evt: 'hosted_tools_dropped', request_id: 'req_1', model: 'claude-x', target: 'messages', tools: ['web_search', 'file_search'] })
})

test('nothing is logged when only callable tools remain', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  warnDroppedHostedTools({ tools: [{ type: 'function', name: 'f' }, { type: 'namespace', name: 'n', tools: [] }] }, { model: 'm', target: 'chat_completions' })
  warnDroppedHostedTools({}, { model: 'm', target: 'chat_completions' })
  expect(warn).not.toHaveBeenCalled()
})
