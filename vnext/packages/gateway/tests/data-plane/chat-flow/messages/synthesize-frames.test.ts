/**
 * `synthesizeMessagesFramesFromJson` + `collectMessagesProtocolEventsToResult`
 * are inverses: the first fakes an SSE feed out of a non-streaming upstream
 * body so respond.ts can run one telemetry path over both branches, the second
 * folds a feed back into a body. A block that survives the round trip intact is
 * the whole contract, so that is what these tests assert.
 *
 * They exist because it used to be false for everything except text. The
 * synthesiser opened every block with `{ type, text: '' }` regardless of type,
 * which is right for text — the payload arrives on a delta, and seeding it at
 * start would double-count — and silently fatal for anything else. A `tool_use`
 * came out the far end as `{ type: 'tool_use', text: '', input: {} }`: no `id`,
 * no `name`, no arguments, wearing a `text` field that a tool_use has no
 * business carrying.
 *
 * Downstream that is not a cosmetic defect. Claude Code read the nameless tool
 * call, reported "No such tool available: undefined", and replied with a
 * `tool_result` that had no `tool_use_id` to point at. Both blocks then lived in
 * the transcript and were replayed on every subsequent turn of that
 * conversation, forever.
 *
 * Worth knowing while reading these: the path is not reserved for clients that
 * asked for a non-streaming answer. attempt.ts takes it whenever the *upstream*
 * replies with JSON, which happens behind a streaming client too.
 */
import { test, expect } from 'bun:test'
import { synthesizeMessagesFramesFromJson } from '../../../../src/data-plane/chat-flow/messages/attempt'
import { collectMessagesProtocolEventsToResult } from '../../../../src/data-plane/chat-flow/messages/events/reassemble'

const roundTrip = async (content: unknown[]) => {
  const result = await collectMessagesProtocolEventsToResult(
    synthesizeMessagesFramesFromJson({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus',
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    } as never),
  )
  return result.content as unknown[]
}

test('a tool_use block keeps its id, name and input across the round trip', async () => {
  const block = {
    type: 'tool_use',
    id: 'toolu_01ABC',
    name: 'Bash',
    input: { command: 'ls -la', timeout: 5000 },
  }
  expect(await roundTrip([block])).toEqual([block])
})

test('a tool_use block never acquires a text field', async () => {
  // The exact shape that poisoned a session. `text` on a tool_use is the
  // fingerprint of this bug: nothing legitimate ever puts it there.
  const [out] = await roundTrip([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]) as [Record<string, unknown>]
  expect(out).not.toHaveProperty('text')
  expect(out.id).toBe('t1')
  expect(out.name).toBe('Read')
})

test('an empty tool input survives as {} rather than being lost', async () => {
  // Guards the `input_json_delta` payload: the reassembler tests `if
  // (block.inputJson)`, so sending an empty string here would fall through to a
  // default that happens to look the same for `{}` and would be wrong the
  // moment anything else needs the same code path.
  expect(await roundTrip([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]))
    .toEqual([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])
})

test('a server_tool_use block is treated like a tool_use, not like text', async () => {
  const block = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'bun test' } }
  expect(await roundTrip([block])).toEqual([block])
})

test('a thinking block keeps its text and signature', async () => {
  const block = { type: 'thinking', thinking: 'let me work through this', signature: 'sig_abc123' }
  expect(await roundTrip([block])).toEqual([block])
})

test('a text block still round-trips, and its text is not double-counted', async () => {
  // The one case the old code did get right; the delta must stay the only
  // source of the body, or reassembly concatenates it on top of the start.
  expect(await roundTrip([{ type: 'text', text: 'hello' }]))
    .toEqual([{ type: 'text', text: 'hello' }])
})

test('a block type this code has never heard of passes through untouched', async () => {
  // New content-block types ship on the model vendor's schedule. Flattening the
  // unknown ones is how the tool_use bug happened; the default has to be to
  // carry them.
  const block = { type: 'some_block_invented_next_quarter', payload: { a: 1 }, id: 'x' }
  expect(await roundTrip([block])).toEqual([block])
})

test('mixed content keeps every block distinct and in order', async () => {
  const content = [
    { type: 'text', text: 'I will run that.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/tmp/a' } },
  ]
  expect(await roundTrip(content)).toEqual(content)
})
