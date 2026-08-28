import { test, expect, describe } from 'bun:test'
import { withCopilotResponsesItemIdMembrane } from '../interceptors/responses/with-item-id-membrane'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent, ResponsesInputItem } from '@vibe-llm/protocols/responses'
import { wrapCopilotItemId, unwrapCopilotItemId } from '@vibe-llm/protocols/responses'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const inv = (input: ResponsesInputItem[]): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set(),
  sourceApi: 'responses',
  payload: { model: 'm', stream: true, input },
  headers: {},
})

const eventFrame = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> => ({
  type: 'event',
  event,
})

const runEvents = (
  ...events: ResponsesStreamEvent[]
): (() => Promise<LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>) =>
  async () =>
    llmEventResult(
      (async function* () {
        for (const e of events) yield eventFrame(e)
        yield doneFrame()
      })(),
      stubIdentity,
    )

const collectEvents = async (
  res: LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ResponsesStreamEvent[]> => {
  if (res.type !== 'events') throw new Error('expected events')
  const out: ResponsesStreamEvent[] = []
  for await (const f of res.events) {
    if (f.type === 'event') out.push(f.event)
  }
  return out
}

describe('withCopilotResponsesItemIdMembrane', () => {
  test('outbound stream: reasoning item public id + carrier wraps upstream id', async () => {
    const upstreamId = 'rs_upstream_opaque'
    const encrypted = 'encrypted_state_v1'
    const item = { type: 'reasoning', id: upstreamId, encrypted_content: encrypted, summary: [] }

    const res = await withCopilotResponsesItemIdMembrane(
      inv([]),
      baseCtx,
      runEvents(
        {
          type: 'response.output_item.added',
          output_index: 0,
          item,
        } as unknown as ResponsesStreamEvent,
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: upstreamId,
          output_index: 0,
          delta: 'thinking',
        } as unknown as ResponsesStreamEvent,
        {
          type: 'response.output_item.done',
          output_index: 0,
          item,
        } as unknown as ResponsesStreamEvent,
      ),
    )

    const events = await collectEvents(res)
    const added = events[0] as { item: { id: string; encrypted_content: string } }
    const delta = events[1] as { item_id: string }
    const done = events[2] as { item: { id: string; encrypted_content: string } }

    expect(added.item.id).toMatch(/^rs_[0-9a-f]{32}$/)
    expect(added.item.id).not.toBe(upstreamId)
    expect(delta.item_id).toBe(added.item.id)
    expect(done.item.id).toBe(added.item.id)

    const decoded = unwrapCopilotItemId(added.item.encrypted_content)
    expect(decoded.kind).toBe('owned')
    if (decoded.kind === 'owned') {
      expect(decoded.id).toBe(upstreamId)
      expect(decoded.value).toBe(encrypted)
    }
  })

  test('outbound stream: message item (no carrier) still gets stable public id', async () => {
    const item = { type: 'message', id: 'msg_upstream_1', role: 'assistant', content: [] }
    const res = await withCopilotResponsesItemIdMembrane(
      inv([]),
      baseCtx,
      runEvents(
        { type: 'response.output_item.added', output_index: 0, item } as unknown as ResponsesStreamEvent,
        { type: 'response.output_text.delta', item_id: 'msg_upstream_1', output_index: 0, delta: 'hi' } as unknown as ResponsesStreamEvent,
        { type: 'response.output_item.done', output_index: 0, item } as unknown as ResponsesStreamEvent,
      ),
    )
    const events = await collectEvents(res)
    const added = events[0] as { item: { id: string } }
    const delta = events[1] as { item_id: string }
    expect(added.item.id).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(delta.item_id).toBe(added.item.id)
  })

  test('inbound: restores upstream id from wrapped carrier before dispatch', async () => {
    const upstreamId = 'rs_original_upstream_id'
    const encrypted = 'inner_encrypted_bytes'
    const wrapped = wrapCopilotItemId(encrypted, upstreamId)

    const wrappedItem = {
      type: 'reasoning',
      id: 'rs_client_facing_public',
      encrypted_content: wrapped,
      summary: [],
    } as unknown as ResponsesInputItem

    const invocation = inv([wrappedItem])
    await withCopilotResponsesItemIdMembrane(invocation, baseCtx, runEvents())

    const restoredInput = (invocation.payload as { input: ResponsesInputItem[] }).input[0] as {
      id: string
      encrypted_content: string
    }
    expect(restoredInput.id).toBe(upstreamId)
    expect(restoredInput.encrypted_content).toBe(encrypted)
  })

  test('inbound: leaves foreign (non-carrier) values byte-for-byte unchanged', async () => {
    const foreign = 'not-a-carrier'
    const item = {
      type: 'reasoning',
      id: 'rs_x',
      encrypted_content: foreign,
      summary: [],
    } as unknown as ResponsesInputItem

    const invocation = inv([item])
    await withCopilotResponsesItemIdMembrane(invocation, baseCtx, runEvents())

    const out = (invocation.payload as { input: ResponsesInputItem[] }).input[0] as {
      id: string
      encrypted_content: string
    }
    expect(out.id).toBe('rs_x')
    expect(out.encrypted_content).toBe(foreign)
  })

  test('round-trip: outbound wrap → inbound unwrap restores original upstream id + carrier value', async () => {
    // Turn 1: upstream emits reasoning with encrypted state; membrane wraps it.
    const upstreamId = 'rs_upstream_turn1'
    const encrypted = 'state_bytes_turn1'
    const item = { type: 'reasoning', id: upstreamId, encrypted_content: encrypted, summary: [] }

    const outbound = await withCopilotResponsesItemIdMembrane(
      inv([]),
      baseCtx,
      runEvents({
        type: 'response.output_item.added',
        output_index: 0,
        item,
      } as unknown as ResponsesStreamEvent),
    )
    const events = await collectEvents(outbound)
    const added = events[0] as { item: { id: string; encrypted_content: string } }
    const clientFacingId = added.item.id
    const wrappedEncrypted = added.item.encrypted_content

    // Turn 2: client echoes the wrapped item back. Membrane should restore.
    const echoed = {
      type: 'reasoning',
      id: clientFacingId,
      encrypted_content: wrappedEncrypted,
      summary: [],
    } as unknown as ResponsesInputItem

    const turn2 = inv([echoed])
    await withCopilotResponsesItemIdMembrane(turn2, baseCtx, runEvents())
    const restored = (turn2.payload as { input: ResponsesInputItem[] }).input[0] as {
      id: string
      encrypted_content: string
    }

    expect(restored.id).toBe(upstreamId)
    expect(restored.encrypted_content).toBe(encrypted)
  })

  test('throws on unsupported output item type', async () => {
    const res = await withCopilotResponsesItemIdMembrane(
      inv([]),
      baseCtx,
      runEvents({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'totally_unknown_type', id: 'x' },
      } as unknown as ResponsesStreamEvent),
    )
    if (res.type !== 'events') throw new Error('expected events')
    await expect(async () => {
      for await (const _f of res.events) { /* drain */ }
    }).toThrow(/Unsupported Copilot Responses output item type/)
  })

  test('throws on duplicate output_item.added for same output_index', async () => {
    const item = { type: 'message', id: 'msg_x', role: 'assistant', content: [] }
    const res = await withCopilotResponsesItemIdMembrane(
      inv([]),
      baseCtx,
      runEvents(
        { type: 'response.output_item.added', output_index: 0, item } as unknown as ResponsesStreamEvent,
        { type: 'response.output_item.added', output_index: 0, item } as unknown as ResponsesStreamEvent,
      ),
    )
    if (res.type !== 'events') throw new Error('expected events')
    await expect(async () => {
      for await (const _f of res.events) { /* drain */ }
    }).toThrow(/output_item.added twice/)
  })

  test('response.completed with output array pins ids consistently with prior stream events', async () => {
    const item = { type: 'message', id: 'msg_upstream_A', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }
    const res = await withCopilotResponsesItemIdMembrane(
      inv([]),
      baseCtx,
      runEvents(
        { type: 'response.output_item.added', output_index: 0, item } as unknown as ResponsesStreamEvent,
        {
          type: 'response.completed',
          response: {
            id: 'resp_1', object: 'response', model: 'm', status: 'completed',
            output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        } as unknown as ResponsesStreamEvent,
      ),
    )
    const events = await collectEvents(res)
    const added = events[0] as { item: { id: string } }
    const completed = events[1] as { response: { output: Array<{ id: string }> } }
    expect(completed.response.output[0]?.id).toBe(added.item.id)
  })
})
