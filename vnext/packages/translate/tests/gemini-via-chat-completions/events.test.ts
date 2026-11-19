import { describe, it, expect } from 'bun:test'
import { translateChatToGeminiEvents } from '@vibe-llm/translate/gemini-via-chat-completions'

async function* fromArray<T>(items: T[]): AsyncGenerator<T> { for (const it of items) yield it }

const chunk = (tool_calls: unknown[], finish_reason: string | null = null) => ({
  id: 'c', model: 'm', choices: [{ index: 0, delta: { tool_calls }, finish_reason }],
})

describe('gemini-via-chat-completions :: events', () => {
  // Adapted from reference copilot-gateway ef887e4dc (#702): some upstreams repeat `name: ""` on
  // later fragments; that must not erase the name (which would drop the whole functionCall).
  it('keeps a tool call name when later fragments repeat an empty name', async () => {
    const out: Array<{ candidates?: Array<{ content?: { parts?: unknown[] } }> }> = []
    for await (const e of translateChatToGeminiEvents(fromArray([
      chunk([{ index: 0, id: 'call_bash', type: 'function', function: { name: 'bash', arguments: '' } }]),
      chunk([{ index: 0, function: { name: '', arguments: '{"command"' } }]),
      chunk([{ index: 0, function: { name: '', arguments: ':"ls"}' } }], 'tool_calls'),
    ]))) out.push(e as never)
    const calls = out.flatMap((e) => e.candidates?.[0]?.content?.parts ?? []).filter((p) => 'functionCall' in (p as object))
    expect(calls).toEqual([{ functionCall: { id: 'call_bash', name: 'bash', args: { command: 'ls' } } }])
  })
})
