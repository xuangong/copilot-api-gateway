import { test, expect } from 'bun:test'
import {
  withResponsesCompactShim,
  expandShimCompactionItems,
  containsCompactionTrigger,
  SUMMARY_PREFIX,
} from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-responses-compact-shim'
import { encodeBase64UrlJson } from '../../../../../src/data-plane/shared/base64url-json.ts'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import type { ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent, CanonicalResponsesPayload, ResponsesInputItem } from '@vibe-llm/protocols/responses'

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
  model: '<unknown>', upstream: '<unknown>', modelKey: '<unknown>', cost: null,
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const mkInv = (
  payload: CanonicalResponsesPayload,
  opts: { flags?: string[]; action?: 'generate' | 'compact' } = {},
): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set(opts.flags ?? []),
  sourceApi: 'responses',
  action: opts.action ?? 'generate',
  payload: payload as unknown as Record<string, unknown>,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () { /* empty stream */ })() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
      stubIdentity,
    ),
  )

const basePayload = (input: ResponsesInputItem[]): CanonicalResponsesPayload =>
  ({ model: 'x', input } as unknown as CanonicalResponsesPayload)

test('flag off + Responses target → no engagement (payload untouched, no compact-shape rewrite)', async () => {
  const trigger = { type: 'compaction_trigger' } as unknown as ResponsesInputItem
  const i = mkInv(basePayload([trigger]))
  await withResponsesCompactShim(i, baseCtx, okRun)
  // Payload MUST be untouched — no expansion, no summarization pivot.
  const input = (i.payload as unknown as CanonicalResponsesPayload).input
  expect(input).toHaveLength(1)
  expect((input[0] as { type: string }).type).toBe('compaction_trigger')
  expect(i.action).toBe('generate')
})

test('flag off + non-Responses target → structurally required, pivots + strips trigger', async () => {
  const userMsg: ResponsesInputItem = {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'hello' }],
  }
  const trigger = { type: 'compaction_trigger' } as unknown as ResponsesInputItem
  const i = mkInv(basePayload([userMsg, trigger]))
  const ctx: RequestContext = { ...baseCtx, targetEndpoint: 'messages' }
  // run yields nothing → summaryText empty → shim throws. That's fine; we only
  // want to prove the shim engaged (mutated payload) before running.
  await expect(withResponsesCompactShim(i, ctx, okRun)).rejects.toThrow()
  const input = (i.payload as unknown as CanonicalResponsesPayload).input
  // Head: SUMMARIZATION_PROMPT system message; middle: preserved user; tail:
  // synthetic user nudge. compaction_trigger stripped.
  expect(input.length).toBe(3)
  expect((input[0] as { role: string }).role).toBe('system')
  expect((input[input.length - 1] as { role: string }).role).toBe('user')
  expect(input.some(it => (it as { type: string }).type === 'compaction_trigger')).toBe(false)
  expect((i.payload as { store?: boolean }).store).toBe(false)
})

test('flag on + Responses target + no trigger → no compact-shape rewrite', async () => {
  const userMsg: ResponsesInputItem = {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  }
  const i = mkInv(basePayload([userMsg]), { flags: ['responses-compact-shim'] })
  await withResponsesCompactShim(i, baseCtx, okRun)
  const input = (i.payload as unknown as CanonicalResponsesPayload).input
  expect(input).toHaveLength(1)
  expect(i.action).toBe('generate')
})

test('expandShimCompactionItems: shim-encoded compaction expands inline', () => {
  const inner: ResponsesInputItem = {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nsummary` }],
  }
  const shimBlob = encodeBase64UrlJson([inner])
  const compaction = { type: 'compaction', encrypted_content: shimBlob } as unknown as ResponsesInputItem
  const out = expandShimCompactionItems(basePayload([compaction]))
  expect(out.input).toHaveLength(1)
  expect((out.input[0] as { role: string }).role).toBe('user')
})

test('expandShimCompactionItems: foreign encrypted_content round-trips untouched', () => {
  const foreign = { type: 'compaction', encrypted_content: 'not-base64url-json' } as unknown as ResponsesInputItem
  const p = basePayload([foreign])
  const out = expandShimCompactionItems(p)
  // Same reference — no changes made.
  expect(out).toBe(p)
})

test('containsCompactionTrigger detects the marker item', () => {
  const t = { type: 'compaction_trigger' } as unknown as ResponsesInputItem
  expect(containsCompactionTrigger([t])).toBe(true)
  expect(containsCompactionTrigger([])).toBe(false)
})
