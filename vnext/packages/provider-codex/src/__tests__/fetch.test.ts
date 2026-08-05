// Unit tests for pure helpers exported from fetch.ts. The main entry points
// (callCodexResponses / …Compact / …AlphaSearch) are covered end-to-end by
// provider.integration.test.ts against a fake Fetcher; this file focuses on
// the pure `toCompactPayloadShape` wire-shape adapter that provider.ts uses
// to build the /codex/responses/compact body.
//
// Contract we lock in:
//   - `input` is passed through as ResponsesInputItem[] (typed cast).
//   - `store` and `model` never appear in the output (they're stripped by
//     the caller upstream — the shape's `Omit` guarantees it at the type
//     level, and this test guards the runtime behavior).
//   - Every optional field (`instructions`, `previous_response_id`,
//     `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_retention`,
//     `service_tier`) is conditionally spread — absent iff `undefined` on
//     the input, present-with-null when caller explicitly sends `null`.

import { describe, expect, test } from 'bun:test'
import { toCompactPayloadShape } from '../fetch'
import type { CanonicalResponsesPayload } from '@vibe-llm/protocols/responses'

const inputItems = [{ type: 'message', role: 'user', content: 'hi' }] as unknown as CanonicalResponsesPayload['input']

const baseInput = (): Omit<CanonicalResponsesPayload, 'model'> =>
  ({ input: inputItems }) as Omit<CanonicalResponsesPayload, 'model'>

describe('toCompactPayloadShape', () => {
  test('emits only `input` when no optional fields are provided', () => {
    const out = toCompactPayloadShape(baseInput())
    expect(out).toEqual({ input: inputItems as never })
    expect(Object.keys(out).sort()).toEqual(['input'])
  })

  test('never carries `model` or `store`, even when the caller passed them', () => {
    const withExtras = {
      ...baseInput(),
      // Force-cast: the exported type Omits these, but callers can arrive
      // with a broader shape at runtime — we guard the strip.
      model: 'gpt-5',
      store: true,
    } as unknown as Omit<CanonicalResponsesPayload, 'model'>
    const out = toCompactPayloadShape(withExtras)
    expect((out as Record<string, unknown>).model).toBeUndefined()
    expect((out as Record<string, unknown>).store).toBeUndefined()
  })

  test('spreads instructions when defined (including explicit null)', () => {
    const str = toCompactPayloadShape({ ...baseInput(), instructions: 'be brief' } as never)
    expect(str.instructions).toBe('be brief')
    const nul = toCompactPayloadShape({ ...baseInput(), instructions: null } as never)
    expect('instructions' in nul).toBe(true)
    expect(nul.instructions).toBeNull()
  })

  test('spreads previous_response_id + prompt_cache_key when defined', () => {
    const out = toCompactPayloadShape({
      ...baseInput(),
      previous_response_id: 'resp_prev',
      prompt_cache_key: 'thread_42',
    } as never)
    expect(out.previous_response_id).toBe('resp_prev')
    expect(out.prompt_cache_key).toBe('thread_42')
  })

  test('spreads `prompt_cache_options` / `prompt_cache_retention` / `service_tier` opaquely', () => {
    const cacheOptions = { ttl_seconds: 3600 }
    const retention = 'ephemeral'
    const out = toCompactPayloadShape({
      ...baseInput(),
      prompt_cache_options: cacheOptions,
      prompt_cache_retention: retention,
      service_tier: 'priority',
    } as never)
    expect(out.prompt_cache_options).toBe(cacheOptions)
    expect(out.prompt_cache_retention).toBe(retention)
    expect(out.service_tier).toBe('priority')
  })

  test('omits fields set to `undefined` (distinguishing undefined vs null)', () => {
    const out = toCompactPayloadShape({
      ...baseInput(),
      instructions: undefined,
      previous_response_id: undefined,
      prompt_cache_key: undefined,
      prompt_cache_options: undefined,
      prompt_cache_retention: undefined,
      service_tier: undefined,
    } as never)
    // Only `input` should remain — undefined means "caller did not set it".
    expect(Object.keys(out).sort()).toEqual(['input'])
  })

  test('preserves `input` reference identity (no cloning)', () => {
    const src = baseInput()
    const out = toCompactPayloadShape(src)
    // Wire adapter should be a shallow shape reduction, not a deep copy.
    expect(out.input).toBe(src.input as never)
  })
})
