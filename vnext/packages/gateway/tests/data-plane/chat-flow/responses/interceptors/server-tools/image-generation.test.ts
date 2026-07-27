/**
 * Unit tests for image_generation server-tool plugin pure helpers (Spec 13-D-7).
 *
 * Ported from copilot-gateway
 * `packages/gateway/src/data-plane/chat/responses/interceptors/server-tools/image-generation_test.ts`.
 *
 * Scope: pure-function coverage only — validators, decoders, transformers,
 * imageTerminal, parseImageStreamEvent, parseRetryAfterMs, and the
 * inspect/resolve pair (which take a plain input list). The reference file
 * additionally exercises `imageGenerationServerTool` end-to-end through
 * `mockChatGatewayCtx` / `stubModelCandidate` / `initExternalResourceFetcher`
 * — vNext does not have equivalents of those helpers yet, and the shared
 * `external-image-loader` uses `globalThis.fetch` instead of a swappable
 * fetcher, so those integration tests are deferred until either helpers land
 * or the fetcher becomes injectable. Message text (`Gateway cannot ...` vs
 * reference `Floway cannot ...`) reflects vNext string adaptations.
 */
import { test, expect } from 'bun:test'
import {
  buildImageGenerationFunctionTool,
  createImageSourceInspector,
  DEFAULT_IMAGE_MODEL,
  type ImageGenerationConfig,
  type ImageOutcome,
  imageTerminal,
  inspectImageSources,
  isHostedImageGenerationTool,
  parseImageStreamEvent,
  parseRetryAfterMs,
  prepareImageGenerationConfig,
  resolveImageOperation,
  SHIM_TOOL_NAME,
  synthesizeImageGenerationCallId,
  transformInputItemsForImageGeneration,
} from '../../../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation'
import type {
  ResponsesInputItem,
  ResponsesTool,
} from '../../../../../../src/data-plane/orchestrator/server-tools/types'
import type { ResponsesInputImage } from '@vibe-llm/protocols/responses'

const PNG_B64 = 'aGVsbG8=' // "hello" — any decodable base64.

const imageInputContainers = {
  message: (image: ResponsesInputImage): ResponsesInputItem =>
    ({ type: 'message', role: 'user', content: [image] }) as unknown as ResponsesInputItem,
  function_output: (image: ResponsesInputImage): ResponsesInputItem =>
    ({ type: 'function_call_output', call_id: 'call_function', output: [image] }) as unknown as ResponsesInputItem,
  custom_output: (image: ResponsesInputImage): ResponsesInputItem =>
    ({ type: 'custom_tool_call_output', call_id: 'call_custom', output: [image] }) as unknown as ResponsesInputItem,
}

// ── isHostedImageGenerationTool ──

test('isHostedImageGenerationTool matches only the hosted image_generation type', () => {
  expect(isHostedImageGenerationTool({ type: 'image_generation' } as ResponsesTool)).toBe(true)
  expect(isHostedImageGenerationTool({ type: 'custom', name: 'x' } as ResponsesTool)).toBe(false)
  expect(
    isHostedImageGenerationTool({ type: 'function', name: 'x', parameters: {}, strict: false } as ResponsesTool),
  ).toBe(false)
})

// ── prepareImageGenerationConfig ──

test('prepareImageGenerationConfig accepts a valid hosted entry and defaults the model', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', quality: 'low', size: '1024x1024' } as ResponsesTool,
  ])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.config.model).toBe(DEFAULT_IMAGE_MODEL)
  expect(result.config.quality).toBe('low')
  expect(result.config.size).toBe('1024x1024')
  expect(result.config.action).toBe('auto')
})

test('prepareImageGenerationConfig honors an explicit model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', model: 'gpt-image-1.5' } as ResponsesTool])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.config.model).toBe('gpt-image-1.5')
})

test('prepareImageGenerationConfig rejects any client-supplied n, including n:1', () => {
  for (const n of [2, 1, 0]) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', n } as ResponsesTool])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('unknown_parameter')
    expect(result.error.param).toBe('tools[0].n')
  }
})

test('prepareImageGenerationConfig rejects output_format webp', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', output_format: 'webp' } as ResponsesTool])
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.code).toBe('invalid_value')
  expect(result.error.param).toBe('tools[0].output_format')
})

test('prepareImageGenerationConfig rejects an arbitrary size', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', size: '512x512' } as ResponsesTool])
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.code).toBe('invalid_value')
  expect(result.error.param).toBe('tools[0].size')
})

test('prepareImageGenerationConfig accepts auto for size/quality/background', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', size: 'auto', quality: 'auto', background: 'auto' } as ResponsesTool,
  ])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.config.size).toBe('auto')
  expect(result.config.quality).toBe('auto')
  expect(result.config.background).toBe('auto')
})

test('prepareImageGenerationConfig rejects an invalid action', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', action: 'morph' } as ResponsesTool])
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.code).toBe('invalid_value')
  expect(result.error.param).toBe('tools[0].action')
})

test('prepareImageGenerationConfig takes the last hosted entry when several are present', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', quality: 'low' } as ResponsesTool,
    { type: 'image_generation', quality: 'high' } as ResponsesTool,
  ])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.config.quality).toBe('high')
})

test('prepareImageGenerationConfig reports the concrete tool index in error.param', () => {
  const result = prepareImageGenerationConfig([
    { type: 'function', name: 'x', parameters: {}, strict: false } as ResponsesTool,
    { type: 'image_generation', size: '99x99' } as ResponsesTool,
  ])
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.param).toBe('tools[1].size')
})

test('prepareImageGenerationConfig accepts output_compression in range and passes it through', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: 80 } as ResponsesTool])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.config.output_compression).toBe(80)
})

test('prepareImageGenerationConfig rejects out-of-range output_compression', () => {
  const cases: [number, string][] = [
    [-1, 'integer_below_min_value'],
    [101, 'integer_above_max_value'],
    [50.5, 'invalid_value'],
  ]
  for (const [v, code] of cases) {
    const result = prepareImageGenerationConfig([
      { type: 'image_generation', output_compression: v } as ResponsesTool,
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe(code)
    expect(result.error.param).toBe('tools[0].output_compression')
  }
})

test('prepareImageGenerationConfig rejects unknown tool fields (Azure-strict)', () => {
  for (const field of ['seed', 'thinking', 'made_up_field']) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', [field]: 1 } as ResponsesTool])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('unknown_parameter')
    expect(result.error.param).toBe(`tools[0].${field}`)
  }
})

test('prepareImageGenerationConfig validates input_fidelity and partial_images', () => {
  const okFidelity = prepareImageGenerationConfig([
    { type: 'image_generation', input_fidelity: 'high' } as ResponsesTool,
  ])
  expect(okFidelity.ok).toBe(true)
  if (!okFidelity.ok) throw new Error('unreachable')
  expect(okFidelity.config.input_fidelity).toBe('high')

  const badFidelity = prepareImageGenerationConfig([
    { type: 'image_generation', input_fidelity: 'ultra' } as ResponsesTool,
  ])
  expect(badFidelity.ok).toBe(false)
  if (badFidelity.ok) throw new Error('unreachable')
  expect(badFidelity.error.param).toBe('tools[0].input_fidelity')

  const okPartial = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: 2 } as ResponsesTool])
  expect(okPartial.ok).toBe(true)
  if (!okPartial.ok) throw new Error('unreachable')
  expect(okPartial.config.partial_images).toBe(2)

  const badPartial = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: 9 } as ResponsesTool])
  expect(badPartial.ok).toBe(false)
  if (badPartial.ok) throw new Error('unreachable')
  expect(badPartial.error.param).toBe('tools[0].partial_images')
})

test('prepareImageGenerationConfig decodes image_url masks and reports file_id as a gateway limitation', () => {
  const ok = prepareImageGenerationConfig([
    { type: 'image_generation', input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` } } as ResponsesTool,
  ])
  expect(ok.ok).toBe(true)
  if (!ok.ok) throw new Error('unreachable')
  expect(ok.config.mask !== undefined && !('wireUrl' in ok.config.mask)).toBe(true)
  const mask = ok.config.mask as { mimeType: string; bytes: Uint8Array }
  expect(mask.mimeType).toBe('image/png')
  expect(mask.bytes.byteLength).toBe(5)

  const expectedFileIdError = {
    message: 'Gateway cannot resolve input_image_mask.file_id; remove file_id and provide image_url alone.',
    param: 'tools[0].input_image_mask.file_id',
    code: 'unsupported_image_source',
  }
  const fileId = prepareImageGenerationConfig([
    { type: 'image_generation', input_image_mask: { file_id: 'file_123' } } as ResponsesTool,
  ])
  expect(fileId.ok).toBe(false)
  if (fileId.ok) throw new Error('unreachable')
  expect(fileId.error).toEqual(expectedFileIdError)

  const inlineBoth = prepareImageGenerationConfig([
    {
      type: 'image_generation',
      input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}`, file_id: 'file_123' },
    } as ResponsesTool,
  ])
  expect(inlineBoth.ok).toBe(false)
  if (inlineBoth.ok) throw new Error('unreachable')
  expect(inlineBoth.error).toEqual(expectedFileIdError)

  const remoteBoth = prepareImageGenerationConfig([
    {
      type: 'image_generation',
      input_image_mask: { file_id: 'file_123', image_url: 'https://example.com/mask.png' },
    } as ResponsesTool,
  ])
  expect(remoteBoth.ok).toBe(true)
  if (!remoteBoth.ok) throw new Error('unreachable')
  expect(remoteBoth.config.mask !== undefined && 'wireUrl' in remoteBoth.config.mask).toBe(true)
  const remoteMask = remoteBoth.config.mask as { afterMaterializationError?: unknown }
  expect(remoteMask.afterMaterializationError).toEqual(expectedFileIdError)
})

test('prepareImageGenerationConfig rejects a present-but-invalid model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', model: '' } as ResponsesTool])
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.code).toBe('invalid_value')
  expect(result.error.param).toBe('tools[0].model')
})

test('prepareImageGenerationConfig validates every hosted entry, not just the last', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', n: 2 } as ResponsesTool,
    { type: 'image_generation', quality: 'low' } as ResponsesTool,
  ])
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.code).toBe('unknown_parameter')
  expect(result.error.param).toBe('tools[0].n')
})

test('prepareImageGenerationConfig uses Azure integer-range codes', () => {
  const below = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: -1 } as ResponsesTool])
  expect(below.ok).toBe(false)
  if (below.ok) throw new Error('unreachable')
  expect(below.error.code).toBe('integer_below_min_value')
  const above = prepareImageGenerationConfig([
    { type: 'image_generation', output_compression: 200 } as ResponsesTool,
  ])
  expect(above.ok).toBe(false)
  if (above.ok) throw new Error('unreachable')
  expect(above.error.code).toBe('integer_above_max_value')
})

test('prepareImageGenerationConfig preserves a remote mask for materialization', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', input_image_mask: { image_url: 'https://example.com/m.png' } } as ResponsesTool,
  ])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.config.mask !== undefined && 'wireUrl' in result.config.mask).toBe(true)
  const remote = result.config.mask as { wireUrl: string; invalidUrlParam: string }
  expect(remote.wireUrl).toBe('https://example.com/m.png')
  expect(remote.invalidUrlParam).toBe('tools[0].input_image_mask.image_url')
})

// ── buildImageGenerationFunctionTool ──

test('buildImageGenerationFunctionTool exposes only an optional prompt and is non-strict', () => {
  const tool = buildImageGenerationFunctionTool({ type: 'image_generation' }, SHIM_TOOL_NAME)
  expect(tool.type).toBe('function')
  expect(tool.name).toBe(SHIM_TOOL_NAME)
  expect(tool.strict).toBe(false)
  const params = tool.parameters as {
    properties: Record<string, unknown>
    required: unknown[]
    additionalProperties: unknown
  }
  expect(Object.keys(params.properties)).toEqual(['prompt'])
  expect(params.required.length).toBe(0)
  expect(params.additionalProperties).toBe(false)
})

// ── inspectImageSources ──

test('inspectImageSources reads input_image blocks and image_generation_call results', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'edit this' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}`, detail: 'auto' },
      ],
    } as unknown as ResponsesInputItem,
    { type: 'image_generation_call', id: 'ig_prev', status: 'completed', result: PNG_B64 } as unknown as ResponsesInputItem,
  ]
  const { sources, issue } = inspectImageSources(input)
  expect(sources.length).toBe(2)
  expect(issue).toBeUndefined()
})

test('inspectImageSources preserves valid remote image urls for materialization', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' }],
    } as unknown as ResponsesInputItem,
  ]
  const { sources, issue } = inspectImageSources(input)
  expect(sources.length).toBe(1)
  const first = sources[0]!
  expect('wireUrl' in first).toBe(true)
  expect((first as { wireUrl: string }).wireUrl).toBe('https://example.com/a.png')
  expect(issue).toBeUndefined()
})

test('inspectImageSources rejects bare base64 with the native input_image error', () => {
  const inspection = inspectImageSources([
    imageInputContainers.message({ type: 'input_image', image_url: 'AAAA', detail: 'auto' } as ResponsesInputImage),
  ])
  expect(inspection.issue).toEqual({
    kind: 'native',
    error: {
      message:
        "Invalid 'input[0].content[0].image_url'. Expected a valid URL, but got a value with an invalid format.",
      errorType: 'invalid_request_error',
      param: 'input[0].content[0].image_url',
      code: 'invalid_value',
    },
  })
})

test('inspectImageSources mirrors the native error when input_image has no source field', () => {
  const inspection = inspectImageSources([
    imageInputContainers.message({ type: 'input_image', detail: 'auto' } as ResponsesInputImage),
  ])
  expect(inspection.issue).toEqual({
    kind: 'native',
    error: {
      message:
        "Missing mutually exclusive parameters: 'input[0].content[0]'. Ensure you are providing exactly one of: 'file_id' or 'image_url'.",
      errorType: 'invalid_request_error',
      param: 'input[0].content[0]',
      code: 'missing_mutually_exclusive_parameters',
    },
  })
})

for (const [container, wrap] of Object.entries(imageInputContainers)) {
  test(`inspectImageSources mirrors the native mutually-exclusive error in ${container}`, () => {
    const inspection = inspectImageSources([
      wrap({
        type: 'input_image',
        image_url: `data:image/png;base64,${PNG_B64}`,
        file_id: 'assistant-file_1',
        detail: 'auto',
      } as ResponsesInputImage),
    ])
    const path = `input[0].${container === 'message' ? 'content' : 'output'}[0]`
    expect(inspection.issue).toEqual({
      kind: 'native',
      error: {
        message: `Mutually exclusive parameters: '${path}'. Ensure you are only providing one of: 'file_id' or 'image_url'.`,
        errorType: 'invalid_request_error',
        param: path,
        code: 'mutually_exclusive_parameters',
      },
    })
  })
}

test('inspectImageSources reads tool-result images and preserves forward order', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'function_call_output',
      call_id: 'c1',
      output: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}`, detail: 'auto' }],
    } as unknown as ResponsesInputItem,
    {
      type: 'custom_tool_call_output',
      call_id: 'c2',
      output: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${PNG_B64}`, detail: 'auto' }],
    } as unknown as ResponsesInputItem,
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: `data:image/webp;base64,${PNG_B64}`, detail: 'auto' }],
    } as unknown as ResponsesInputItem,
  ]
  const { sources } = inspectImageSources(input)
  expect(sources.length).toBe(3)
  const [first, second, third] = sources
  expect(first !== undefined && !('wireUrl' in first)).toBe(true)
  expect(second !== undefined && !('wireUrl' in second)).toBe(true)
  expect(third !== undefined && !('wireUrl' in third)).toBe(true)
  expect((first as { mimeType: string }).mimeType).toBe('image/png')
  expect((second as { mimeType: string }).mimeType).toBe('image/jpeg')
  expect((third as { mimeType: string }).mimeType).toBe('image/webp')
})

test('resolveImageOperation exposes a malformed replayed result as an invariant failure', () => {
  const inspection = inspectImageSources([
    { type: 'image_generation_call', id: 'ig_bad', status: 'completed', result: '%%%' } as unknown as ResponsesInputItem,
  ])
  expect(inspection.sources).toEqual([])
  expect(() => resolveImageOperation({ model: DEFAULT_IMAGE_MODEL, action: 'auto' }, inspection)).toThrow(
    'Stored image_generation_call at input[0] contains invalid result bytes.',
  )
})

test('a request inspector reuses decoded bytes after generated results become replay images', () => {
  const inspect = createImageSourceInspector()
  const generated: ResponsesInputItem = {
    type: 'image_generation_call',
    id: 'ig_cached',
    status: 'completed',
    result: PNG_B64,
    output_format: 'jpeg',
  } as unknown as ResponsesInputItem
  const initial = inspect([generated])
  const replay = inspect(transformInputItemsForImageGeneration([generated], SHIM_TOOL_NAME))
  expect(initial.sources[0]).toBe(replay.sources[0]!)
})

test('auto generation pivots to edit when a generated image is fed back', () => {
  const config: ImageGenerationConfig = { model: DEFAULT_IMAGE_MODEL, action: 'auto' }
  const inspect = createImageSourceInspector()
  const initial = resolveImageOperation(config, inspect([]))
  expect(initial.ok).toBe(true)
  if (!initial.ok) throw new Error('unreachable')
  expect(initial.action).toBe('generate')

  const replayInput = transformInputItemsForImageGeneration(
    [
      {
        type: 'image_generation_call',
        id: 'ig_replay',
        status: 'completed',
        result: PNG_B64,
      } as unknown as ResponsesInputItem,
    ],
    SHIM_TOOL_NAME,
  )
  const replay = resolveImageOperation(config, inspect(replayInput))
  expect(replay.ok).toBe(true)
  if (!replay.ok) throw new Error('unreachable')
  expect(replay.action).toBe('edit')
  expect(replay.sources.length).toBe(1)
})

// mask-only action resolution — three parameter combinations.
for (const { requested, resolved, sourceCount } of [
  { requested: 'generate' as const, resolved: 'generate' as const, sourceCount: 0 },
  { requested: 'auto' as const, resolved: 'edit' as const, sourceCount: 1 },
  { requested: 'edit' as const, resolved: 'edit' as const, sourceCount: 1 },
]) {
  test(`mask-only action ${requested} resolves to ${resolved}`, () => {
    const prepared = prepareImageGenerationConfig([
      {
        type: 'image_generation',
        action: requested,
        input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` },
      } as ResponsesTool,
    ])
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('unreachable')
    const operation = resolveImageOperation(prepared.config, inspectImageSources([]))
    expect(operation.ok).toBe(true)
    if (!operation.ok) throw new Error('unreachable')
    expect(operation.action).toBe(resolved)
    expect(operation.sources.length).toBe(sourceCount)
  })
}

// ── transformInputItemsForImageGeneration ──

test('transformInputItemsForImageGeneration rewrites a completed call into a function_call + output pair and feeds the image back', () => {
  const out = transformInputItemsForImageGeneration(
    [
      {
        type: 'image_generation_call',
        id: 'ig_1',
        status: 'completed',
        result: PNG_B64,
        revised_prompt: 'a red dot',
        output_format: 'jpeg',
      } as unknown as ResponsesInputItem,
    ],
    'image_generation',
  )
  expect(out.length).toBe(3)
  const first = out[0] as { type: string; name?: string; call_id?: string; arguments?: string }
  expect(first.type).toBe('function_call')
  expect(first.name).toBe('image_generation')
  expect(first.call_id).toBe('cc_from_ig_1')
  expect(first.arguments).toContain('a red dot')
  const second = out[1] as { type: string; call_id?: string; output?: unknown }
  expect(second.type).toBe('function_call_output')
  expect(second.call_id).toBe('cc_from_ig_1')
  expect(typeof second.output).toBe('string')
  expect(second.output as string).toContain('"ok":true')
  const third = out[2] as { type: string; content?: unknown }
  expect(third.type).toBe('message')
  expect(Array.isArray(third.content)).toBe(true)
  const content = third.content as Array<{ type: string; image_url?: string }>
  const imageBlock = content.find((b) => b.type === 'input_image')
  expect(imageBlock).toBeDefined()
  expect(imageBlock!.image_url).toBe(`data:image/jpeg;base64,${PNG_B64}`)
})

test('transformInputItemsForImageGeneration does not feed back an image for a failed call', () => {
  const out = transformInputItemsForImageGeneration(
    [
      {
        type: 'image_generation_call',
        id: 'ig_f',
        status: 'failed',
        error: { message: 'x', code: 'server_error' },
      } as unknown as ResponsesInputItem,
    ],
    'image_generation',
  )
  expect(out.length).toBe(2)
  expect(out.some((i) => i.type === 'message')).toBe(false)
})

test('transformInputItemsForImageGeneration encodes a failed call as ok:false with error detail', () => {
  const out = transformInputItemsForImageGeneration(
    [
      {
        type: 'image_generation_call',
        id: 'ig_2',
        status: 'failed',
        revised_prompt: 'x',
        error: { message: 'overloaded', code: 'EngineOverloaded' },
      } as unknown as ResponsesInputItem,
    ],
    'image_generation',
  )
  const second = out[1] as { type: string; output?: unknown }
  expect(second.type).toBe('function_call_output')
  expect(typeof second.output).toBe('string')
  const parsed = JSON.parse(second.output as string) as {
    ok: boolean
    error: { code: string; message: string; retryable: boolean }
  }
  expect(parsed.ok).toBe(false)
  expect(parsed.error.code).toBe('EngineOverloaded')
  expect(parsed.error.message).toBe('overloaded')
  expect(parsed.error.retryable).toBe(true)
})

test('transformInputItemsForImageGeneration passes non-image items through untouched', () => {
  const message: ResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: 'hi',
  } as unknown as ResponsesInputItem
  const out = transformInputItemsForImageGeneration([message], 'image_generation')
  expect(out.length).toBe(1)
  expect(out[0]).toEqual(message)
})

test('transformInputItemsForImageGeneration preserves error type and retryability on replay', () => {
  const out = transformInputItemsForImageGeneration(
    [
      {
        type: 'image_generation_call',
        id: 'ig_3',
        status: 'failed',
        error: { message: 'blocked', code: 'content_filter', type: 'image_generation_user_error' },
      } as unknown as ResponsesInputItem,
    ],
    'image_generation',
  )
  const second = out[1] as { type: string; output?: unknown }
  expect(second.type).toBe('function_call_output')
  expect(typeof second.output).toBe('string')
  const parsed = JSON.parse(second.output as string) as {
    error: { type: string; code: string; retryable: boolean }
  }
  expect(parsed.error.type).toBe('image_generation_user_error')
  expect(parsed.error.code).toBe('content_filter')
  expect(parsed.error.retryable).toBe(false)
})

// ── imageTerminal ──

test('imageTerminal on success echoes the backend-resolved fields and closes with a single completed event', () => {
  const outcome: ImageOutcome = {
    ok: true,
    b64: PNG_B64,
    echo: { size: '1024x1024', quality: 'high', output_format: 'png', background: 'opaque' },
  }
  const { item, endEvents } = imageTerminal('a red dot', 'generate', outcome)
  expect((item as { status?: string }).status).toBe('completed')
  expect((item as { result?: string }).result).toBe(PNG_B64)
  expect((item as { revised_prompt?: string }).revised_prompt).toBe('a red dot')
  expect((item as { action?: string }).action).toBe('generate')
  expect((item as { quality?: string }).quality).toBe('high')
  expect((item as { size?: string }).size).toBe('1024x1024')
  expect((item as { output_format?: string }).output_format).toBe('png')
  expect((item as { background?: string }).background).toBe('opaque')
  expect(endEvents.length).toBe(1)
  expect(endEvents[0]!.type).toBe('response.image_generation_call.completed')
})

test('imageTerminal on failure emits a failed item and no closing events', () => {
  const outcome: ImageOutcome = {
    ok: false,
    error: {
      type: 'image_generation_user_error',
      message: 'overloaded',
      code: 'EngineOverloaded',
      retryable: true,
    },
  }
  const { item, endEvents } = imageTerminal('a red dot', 'generate', outcome)
  expect((item as { status?: string }).status).toBe('failed')
  expect((item as { error?: { code: string } }).error?.code).toBe('EngineOverloaded')
  expect((item as { error?: { type?: string } }).error?.type).toBe('image_generation_user_error')
  expect('result' in item).toBe(false)
  expect(endEvents.length).toBe(0)
})

test('imageTerminal omits fields the backend did not echo', () => {
  const { item } = imageTerminal('p', 'generate', { ok: true, b64: PNG_B64, echo: { output_format: 'png' } })
  expect('size' in item).toBe(false)
  expect('quality' in item).toBe(false)
  expect('background' in item).toBe(false)
  expect((item as { output_format?: string }).output_format).toBe('png')
})

// ── parseImageStreamEvent ──

test('parseImageStreamEvent maps generations and edits partial/completed/error with backend echo', () => {
  const genPartial = parseImageStreamEvent(
    JSON.stringify({
      type: 'image_generation.partial_image',
      partial_image_index: 1,
      b64_json: PNG_B64,
      background: 'opaque',
      output_format: 'png',
      quality: 'low',
      size: '1024x1024',
    }),
  )
  expect(genPartial?.kind).toBe('partial')
  if (genPartial?.kind !== 'partial') throw new Error('unreachable')
  expect(genPartial.index).toBe(1)
  expect(genPartial.b64).toBe(PNG_B64)
  expect(genPartial.echo).toEqual({
    background: 'opaque',
    output_format: 'png',
    quality: 'low',
    size: '1024x1024',
  })

  const editPartial = parseImageStreamEvent(
    JSON.stringify({ type: 'image_edit.partial_image', partial_image_index: 0, b64_json: PNG_B64 }),
  )
  expect(editPartial?.kind).toBe('partial')
  if (editPartial?.kind !== 'partial') throw new Error('unreachable')
  expect(editPartial.echo).toEqual({})

  const completed = parseImageStreamEvent(
    JSON.stringify({
      type: 'image_generation.completed',
      b64_json: PNG_B64,
      usage: { total_tokens: 1 },
      quality: 'high',
    }),
  )
  expect(completed?.kind).toBe('completed')
  if (completed?.kind !== 'completed') throw new Error('unreachable')
  expect(completed.b64).toBe(PNG_B64)
  expect(completed.echo.quality).toBe('high')

  const err = parseImageStreamEvent(
    JSON.stringify({
      type: 'error',
      error: { type: 'image_generation_server_error', code: 'image_generation_failed', message: 'boom' },
    }),
  )
  expect(err?.kind).toBe('error')
  if (err?.kind !== 'error') throw new Error('unreachable')
  expect(err.error.code).toBe('image_generation_failed')
  expect(err.error.retryable).toBe(true)
})

test('parseImageStreamEvent returns null for non-JSON or unrelated events', () => {
  expect(parseImageStreamEvent('[DONE]')).toBeNull()
  expect(parseImageStreamEvent(JSON.stringify({ type: 'image_generation.queued' }))).toBeNull()
})

// ── parseRetryAfterMs ──

test('parseRetryAfterMs prefers retry-after-ms over Retry-After', () => {
  const h = new Headers({ 'retry-after-ms': '2500', 'retry-after': '7' })
  expect(parseRetryAfterMs(h)).toBe(2500)
})

test('parseRetryAfterMs falls back to x-ms-retry-after-ms when retry-after-ms absent', () => {
  const h = new Headers({ 'x-ms-retry-after-ms': '1800', 'retry-after': '7' })
  expect(parseRetryAfterMs(h)).toBe(1800)
})

test('parseRetryAfterMs reads Retry-After as integer seconds → milliseconds', () => {
  const h = new Headers({ 'retry-after': '5' })
  expect(parseRetryAfterMs(h)).toBe(5000)
})

test('parseRetryAfterMs parses Retry-After fractional seconds', () => {
  const h = new Headers({ 'retry-after': '0.5' })
  expect(parseRetryAfterMs(h)).toBe(500)
})

test('parseRetryAfterMs interprets Retry-After HTTP-date as delta from now', () => {
  const future = new Date(Date.now() + 10_000).toUTCString()
  const h = new Headers({ 'retry-after': future })
  const result = parseRetryAfterMs(h)
  expect(result).not.toBeNull()
  expect(result! > 0 && result! <= 11_000).toBe(true)
})

test('parseRetryAfterMs returns null for missing headers', () => {
  expect(parseRetryAfterMs(new Headers())).toBeNull()
})

test('parseRetryAfterMs returns null for zero / negative values (gpt-image-1 "0.0s" hint)', () => {
  expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '0' }))).toBeNull()
  expect(parseRetryAfterMs(new Headers({ 'retry-after': '0' }))).toBeNull()
  expect(parseRetryAfterMs(new Headers({ 'retry-after': '-5' }))).toBeNull()
})

test('parseRetryAfterMs returns null for non-numeric, non-HTTP-date Retry-After', () => {
  expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeNull()
})

test('parseRetryAfterMs skips an unparseable retry-after-ms and falls through to Retry-After', () => {
  const h = new Headers({ 'retry-after-ms': 'nope', 'retry-after': '3' })
  expect(parseRetryAfterMs(h)).toBe(3000)
})

// ── synthesizeImageGenerationCallId ──

test('synthesizeImageGenerationCallId produces a canonical image-generation id', () => {
  const id = synthesizeImageGenerationCallId()
  expect(/^ig_[0-9a-f]{32}$/.test(id)).toBe(true)
})
