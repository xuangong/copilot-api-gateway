import { test, expect } from 'bun:test'
import { createPipelineRunner } from '../src/data-plane/pipeline/runner.ts'
import { bindingServesEndpoint, type ProviderBinding } from '../src/data-plane/routing/binding.ts'
import type { IRRequest } from '@vnext/protocols/ir'

const newReq = (): IRRequest => ({
  model: 'm', messages: [], stream: false, rawClientPayload: {},
  meta: { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'responses' },
})

test('pipeline runner: applies transforms in registration order per stage', async () => {
  const r = createPipelineRunner()
  const calls: string[] = []
  r.register({ name: 'a', stage: 'pre-binding', apply: (req) => { calls.push('a'); return req } })
  r.register({ name: 'b', stage: 'pre-binding', apply: (req) => { calls.push('b'); return req } })
  r.register({ name: 'c', stage: 'post-binding', apply: (req) => { calls.push('c'); return req } })
  await r.run('pre-binding', newReq())
  await r.run('post-binding', newReq())
  expect(calls).toEqual(['a', 'b', 'c'])
})

test('pipeline runner: when=false skips transform', async () => {
  const r = createPipelineRunner()
  let ran = false
  r.register({
    name: 's', stage: 'pre-binding',
    when: () => false,
    apply: (req) => { ran = true; return req },
  })
  await r.run('pre-binding', newReq())
  expect(ran).toBe(false)
})

test('binding: bindingServesEndpoint reads model.endpoints map', () => {
  const fakeProvider = { kind: 'fake', id: 'p', fetch: async () => new Response() }
  const b: ProviderBinding = {
    upstream: 'u1', kind: 'copilot',
    model: { id: 'm', endpoints: { chat_completions: {}, responses: {} } },
    enabledFlags: new Set(),
    provider: fakeProvider,
  }
  expect(bindingServesEndpoint(b, 'chat_completions')).toBe(true)
  expect(bindingServesEndpoint(b, 'embeddings')).toBe(false)
  expect(bindingServesEndpoint(b, 'responses')).toBe(true)
})
