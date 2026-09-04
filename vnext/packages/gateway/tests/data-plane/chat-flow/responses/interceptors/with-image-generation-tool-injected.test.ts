import { test, expect } from 'bun:test'
import { withImageGenerationToolInjected } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-image-generation-tool-injected'
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

const FLAG = 'responses-image-generation-inject'

const inv = (
  payload: Record<string, unknown>,
  enabledFlags: ReadonlySet<string> = new Set([FLAG]),
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

const toolsOf = (i: Invocation) => i.payload.tools as { type: string }[] | undefined

test('appends the hosted tool when the request declares none', async () => {
  const i = inv({ model: 'gpt-5.5' })
  await withImageGenerationToolInjected(i, baseCtx, okRun)
  expect(toolsOf(i)).toEqual([{ type: 'image_generation' }])
})

test('appends alongside the caller-declared tools, preserving order', async () => {
  const i = inv({ tools: [{ type: 'function', name: 'lookup' }] })
  await withImageGenerationToolInjected(i, baseCtx, okRun)
  expect(toolsOf(i)).toEqual([{ type: 'function', name: 'lookup' }, { type: 'image_generation' }])
})

test('no-op without the flag', async () => {
  const i = inv({ model: 'gpt-5.5' }, new Set())
  await withImageGenerationToolInjected(i, baseCtx, okRun)
  expect(toolsOf(i)).toBeUndefined()
})

// Declaring a second copy would make the shim's canonicalization ambiguous and
// waste prompt tokens; the caller's own tool (with its quality/size options)
// must win.
test('no-op when the caller already declared the hosted tool', async () => {
  const declared = [{ type: 'image_generation', quality: 'low', size: '1024x1024' }]
  const i = inv({ tools: declared })
  await withImageGenerationToolInjected(i, baseCtx, okRun)
  expect(toolsOf(i)).toEqual(declared)
})

// `none` is an explicit "call nothing this turn" — injecting there is pure
// prompt pollution, since the model could not call the tool anyway.
test('no-op when tool_choice is "none"', async () => {
  const i = inv({ tool_choice: 'none' })
  await withImageGenerationToolInjected(i, baseCtx, okRun)
  expect(toolsOf(i)).toBeUndefined()
})

// Declaring is not forcing: a caller that pinned a different tool keeps its
// pin, and the injected tool simply never gets called that turn.
test('leaves a forced tool_choice untouched', async () => {
  const i = inv({ tool_choice: { type: 'function', name: 'lookup' }, tools: [{ type: 'function', name: 'lookup' }] })
  await withImageGenerationToolInjected(i, baseCtx, okRun)
  expect(i.payload.tool_choice).toEqual({ type: 'function', name: 'lookup' })
  expect(toolsOf(i)).toHaveLength(2)
})
