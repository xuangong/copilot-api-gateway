import { test, expect } from 'bun:test'
import { runOrchestrator } from '../src/data-plane/orchestrator/loop.ts'
import { FakeProvider } from '@vnext-llm/provider'

test('runOrchestrator dispatches once via provider', async () => {
  const provider = new FakeProvider({ text: 'orch-test' })
  const { response, attempts } = await runOrchestrator({
    provider,
    req: {
      endpoint: 'responses',
      payload: { model: 'fake-model', input: [] },
      headers: new Headers({ 'content-type': 'application/json' }),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    },
  })
  expect(response.ok).toBe(true)
  expect(attempts).toBe(1)
  const body = await response.json() as { output_text?: string }
  expect(body.output_text).toBe('orch-test')
})

test('runOrchestrator surfaces provider error response without throwing', async () => {
  const provider = new FakeProvider()
  const { response } = await runOrchestrator({
    provider,
    req: {
      endpoint: 'messages',
      payload: {},
      headers: new Headers({ 'content-type': 'application/json' }),
      sourceApi: 'anthropic',
      flags: { isStreaming: false },
    },
  })
  expect(response.status).toBe(400)
})
