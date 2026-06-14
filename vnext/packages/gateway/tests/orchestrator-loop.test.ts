import { test, expect } from 'bun:test'
import { runOrchestrator } from '../src/data-plane/orchestrator/loop.ts'
import { FakeProvider } from '@vnext/provider'

test('runOrchestrator dispatches once via provider', async () => {
  const provider = new FakeProvider({ text: 'orch-test' })
  const { response, attempts } = await runOrchestrator({
    provider,
    endpoint: 'responses',
    init: { method: 'POST', body: JSON.stringify({ model: 'fake-model', input: [] }) },
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
    endpoint: 'messages',
    init: { method: 'POST', body: JSON.stringify({}) },
  })
  expect(response.status).toBe(400)
})
