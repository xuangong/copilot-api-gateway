// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/state-bridge.test.ts
/**
 * Coverage for `gemini/state-bridge.ts` — `consumeWithState` observes each
 * bare `GeminiStreamEvent` to:
 *   - feed `state.rememberUsage(evt)` so the gemini `usageMetadata` branch of
 *     `applyStreamEvent` folds the terminal frame into `state.usage`
 *   - feed `state.rememberModelKey(evt.modelVersion ?? evt.model)` so the
 *     corrected model key (e.g. `gemini-2.5-pro-corrected` instead of the
 *     selected `gemini-2.5-pro`) overrides the binding-time guess for the
 *     usage row
 *
 * Failure path: a thrown error during the iteration sets `state.failed = true`
 * BEFORE the throw propagates, so respond-telemetry's `recordPerformance`
 * persists `isError=true`. We assert this via `failedAfter()` being called.
 */
import { test, expect } from 'bun:test'
import { consumeWithState } from '../../../../src/data-plane/chat-flow/gemini/state-bridge.ts'
import { SourceStreamState } from '../../../../src/data-plane/chat-flow/shared/respond-telemetry.ts'

const drain = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const v of iter) out.push(v)
  return out
}

test('consumeWithState observes modelVersion and gemini usageMetadata', async () => {
  const state = new SourceStreamState('gemini-2.5-pro')
  const events = [
    { candidates: [{ content: { parts: [{ text: 'a' }] } }], modelVersion: 'gemini-2.5-pro-corrected' },
    {
      candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      modelVersion: 'gemini-2.5-pro-corrected',
    },
  ]
  async function* source() { for (const e of events) yield e }
  const collected = await drain(consumeWithState(source(), state))
  expect(collected.length).toBe(2)
  expect(state.modelKey).toBe('gemini-2.5-pro-corrected')
  expect(state.usage.tokens.input).toBe(4)
  expect(state.usage.tokens.output).toBe(2)
  expect(state.failed).toBe(false)
})

test('consumeWithState falls back to `model` when `modelVersion` is absent', async () => {
  const state = new SourceStreamState('gemini-2.5-pro')
  async function* source() {
    yield { candidates: [{ content: { parts: [{ text: 'x' }] } }], model: 'gemini-2.5-pro-via-model-field' }
  }
  await drain(consumeWithState(source(), state))
  expect(state.modelKey).toBe('gemini-2.5-pro-via-model-field')
})

test('consumeWithState sets failed=true on iteration error before re-throwing', async () => {
  const state = new SourceStreamState('gemini-2.5-pro')
  async function* source() {
    yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }], modelVersion: 'gemini-2.5-pro' }
    throw new Error('boom')
  }
  let caught: Error | null = null
  try {
    await drain(consumeWithState(source(), state))
  } catch (err) {
    caught = err as Error
  }
  expect(caught?.message).toBe('boom')
  expect(state.failed).toBe(true)
})
