/**
 * buildImageGenerationResponse tools/tool_choice echo — port of #172
 * (fix(responses): preserve hosted tool semantics through the shim).
 *
 * vNext's image_generation shim is single-turn, so of #172's three semantic
 * fixes only the tools/tool_choice echo half applies here. Dedupe-to-last
 * validation is already implemented in validateImageGenerationConfig.
 */
import { test, expect } from 'bun:test'
import {
  buildImageGenerationResponse,
  type ImageGenerationOutcome,
} from '../src/data-plane/orchestrator/server-tools/plugins/image-generation/core.ts'

const okOutcome: ImageGenerationOutcome = { ok: true, b64: 'AAAA', echo: {}, upstreamMs: 5 }

test('echoes the last complete image_generation declaration in tools', () => {
  const env = buildImageGenerationResponse('gpt-image-2', 'a cat', okOutcome, {
    tools: [
      { type: 'image_generation', quality: 'low' },
      { type: 'image_generation', quality: 'high', size: '1024x1024' },
    ],
  })
  expect(env.tools).toEqual([{ type: 'image_generation', quality: 'high', size: '1024x1024' }])
})

test('echoes a forced hosted image_generation tool_choice', () => {
  const forced = { type: 'image_generation' as const }
  const env = buildImageGenerationResponse('gpt-image-2', 'a cat', okOutcome, {
    tools: [{ type: 'image_generation' }],
    toolChoice: forced,
  })
  expect(env.tool_choice).toEqual(forced)
})

test("defaults to tool_choice 'auto' when the client did not force hosted choice", () => {
  const env = buildImageGenerationResponse('gpt-image-2', 'a cat', okOutcome, {
    tools: [{ type: 'image_generation' }],
    toolChoice: 'auto',
  })
  expect(env.tool_choice).toBe('auto')
})

test('emits empty tools array when the request declared no image_generation entry', () => {
  const env = buildImageGenerationResponse('gpt-image-2', 'a cat', okOutcome, {
    tools: [{ type: 'function', name: 'f' }],
  })
  expect(env.tools).toEqual([])
  expect(env.tool_choice).toBe('auto')
})

test('backwards-compatible: no echo argument yields the legacy empty envelope', () => {
  const env = buildImageGenerationResponse('gpt-image-2', 'a cat', okOutcome)
  expect(env.tools).toEqual([])
  expect(env.tool_choice).toBe('auto')
})
