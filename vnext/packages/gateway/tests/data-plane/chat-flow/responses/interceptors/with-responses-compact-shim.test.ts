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
import { responsesResultToEvents, type ResponsesStreamEvent, type CanonicalResponsesPayload, type ResponsesInputItem, type ResponsesResult } from '@vibe-llm/protocols/responses'

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
  // Cache-sharing shape (#616): preserved user first, summarizer prompt as the
  // final user message, no system head. compaction_trigger stripped.
  expect(input.length).toBe(2)
  expect((input[0] as { role: string }).role).toBe('user')
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

test('flag off still expands a legacy own compaction_summary before native Responses dispatch', async () => {
  const inner: ResponsesInputItem = {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nlegacy summary` }],
  }
  const own = {
    type: 'compaction_summary', encrypted_content: encodeBase64UrlJson([inner]), id: 'cmp_legacy',
  } as unknown as ResponsesInputItem
  const i = mkInv(basePayload([own, { type: 'compaction_trigger' } as unknown as ResponsesInputItem]))
  await withResponsesCompactShim(i, baseCtx, okRun)
  expect((i.payload as unknown as CanonicalResponsesPayload).input).toEqual([
    inner, { type: 'compaction_trigger' },
  ])
  expect(i.action).toBe('generate')
})

test('flag off preserves foreign opaque compaction fields and bytes', async () => {
  const foreign = {
    type: 'compaction_summary', encrypted_content: encodeBase64UrlJson({ foreign: true }),
    id: 'cmp_foreign', provider_metadata: { untouched: 'yes' },
  } as unknown as ResponsesInputItem
  const payload = basePayload([foreign])
  const i = mkInv(payload)
  await withResponsesCompactShim(i, baseCtx, okRun)
  expect(i.payload).toBe(payload)
  expect((i.payload as unknown as CanonicalResponsesPayload).input[0]).toBe(foreign)
})

for (const type of ['compaction', 'compaction_summary'] as const) {
  test(`flag off preserves foreign typed-array ${type} bytes and provider fields`, async () => {
    const encryptedContent = encodeBase64UrlJson([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'foreign summary' }] },
    ])
    const foreign = {
      type, encrypted_content: encryptedContent, id: `cmp_foreign_${type}`,
      provider_metadata: { marker: 'retain-me' },
    } as unknown as ResponsesInputItem
    const payload = basePayload([foreign])
    const i = mkInv(payload)
    await withResponsesCompactShim(i, baseCtx, okRun)
    expect(i.payload).toBe(payload)
    expect((i.payload as unknown as CanonicalResponsesPayload).input).toEqual([foreign])
    expect((i.payload as unknown as CanonicalResponsesPayload).input[0]).toBe(foreign)
  })
}

test('expandShimCompactionItems: foreign encrypted_content round-trips untouched', () => {
  const foreign = { type: 'compaction', encrypted_content: 'not-base64url-json' } as unknown as ResponsesInputItem
  const p = basePayload([foreign])
  const out = expandShimCompactionItems(p)
  // Same reference — no changes made.
  expect(out).toBe(p)
})

// ── Cache-sharing compaction ─────────────────────────────────────────────────
// Adapted from reference copilot-gateway ad6fa3ffa (#616): the summarizer
// prompt must come AFTER the unchanged system/tools/history prefix as a final
// user message, so an upstream can reuse the prompt cache written by the
// ordinary agent turn. A textless (tool-only) reply is a cache-sharing failure:
// warn, retry once with the system-prompt variant, and bill both attempts.

type Usage = { input_tokens: number; output_tokens: number; total_tokens: number }
const resultOf = (output: unknown[], usage: Usage): ResponsesResult =>
  ({ id: 'resp_x', object: 'response', model: 'x', status: 'completed', output, error: null, incomplete_details: null, usage }) as unknown as ResponsesResult
const messageOutput = (text: string) => [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]
const toolOnlyOutput = [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}', status: 'completed' }]
const resultRun = (response: ResponsesResult) => llmEventResult(
  (async function* () { for (const frame of responsesResultToEvents(response)) yield frame })() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  stubIdentity,
)
const historyInput: ResponsesInputItem[] = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } as unknown as ResponsesInputItem,
  { type: 'compaction_trigger' } as unknown as ResponsesInputItem,
]
const textOf = (item: ResponsesInputItem): string => ((item as { content: Array<{ text: string }> }).content[0]!).text

test('compaction appends the summarizer prompt as a final user message after the unchanged history', async () => {
  const i = mkInv(basePayload(historyInput))
  const sent: ResponsesInputItem[][] = []
  const result = await withResponsesCompactShim(i, { ...baseCtx, targetEndpoint: 'messages' }, async () => {
    sent.push([...(i.payload as unknown as CanonicalResponsesPayload).input])
    return resultRun(resultOf(messageOutput('the summary'), { input_tokens: 10, output_tokens: 2, total_tokens: 12 }))
  })
  expect(result.type).toBe('events')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.slice(0, 2)).toEqual(historyInput.slice(0, 2))
  const last = sent[0]![2]!
  expect(sent[0]).toHaveLength(3)
  expect((last as { role: string }).role).toBe('user')
  expect(textOf(last)).toContain('CONTEXT CHECKPOINT COMPACTION')
  expect(textOf(last)).toContain('Do not call any tools')
  expect(sent[0]!.some(item => (item as { role?: string }).role === 'system')).toBe(false)
})

test('a tool-only reply warns, retries once with the system-prompt variant, and sums usage', async () => {
  const i = mkInv(basePayload(historyInput))
  const sent: ResponsesInputItem[][] = []
  const attempts = [
    resultOf(toolOnlyOutput, { input_tokens: 100, output_tokens: 5, total_tokens: 105 }),
    resultOf(messageOutput('fallback summary'), { input_tokens: 30, output_tokens: 7, total_tokens: 37 }),
  ]
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  let result: Awaited<ReturnType<typeof withResponsesCompactShim>>
  try {
    result = await withResponsesCompactShim(i, { ...baseCtx, targetEndpoint: 'messages' }, async () => {
      sent.push([...(i.payload as unknown as CanonicalResponsesPayload).input])
      return resultRun(attempts[sent.length - 1]!)
    })
  } finally { console.warn = originalWarn }
  expect(sent).toHaveLength(2)
  expect((sent[1]![0] as { role: string }).role).toBe('system')
  expect(warnings).toHaveLength(1)
  if (result.type !== 'events') throw new Error('expected events')
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = []
  for await (const frame of result.events as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>) frames.push(frame)
  const terminal = frames.map(f => f.type === 'event' ? f.event : undefined).find(e => e?.type === 'response.completed') as { response: ResponsesResult } | undefined
  expect(terminal?.response.usage).toMatchObject({ input_tokens: 130, output_tokens: 12, total_tokens: 142 })
})

test('containsCompactionTrigger detects the marker item', () => {
  const t = { type: 'compaction_trigger' } as unknown as ResponsesInputItem
  expect(containsCompactionTrigger([t])).toBe(true)
  expect(containsCompactionTrigger([])).toBe(false)
})
