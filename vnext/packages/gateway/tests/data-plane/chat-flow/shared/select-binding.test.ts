// vnext/packages/gateway/tests/data-plane/chat-flow/shared/select-binding.test.ts
import { test, expect, mock } from 'bun:test'
import { selectBindingForChatCompletions } from '../../../../src/data-plane/chat-flow/shared/select-binding'

const fakeAuth = { ownerId: 'owner-1', pin: undefined } as any
const fakeBinding = (target: 'chat_completions' | 'messages' | 'responses') => ({
  provider: { fetch: mock(async () => new Response('ok')) },
  upstreamModel: 'gpt-x',
  endpoints: { [target]: { /* target-specific config */ } },
} as any)

test('returns same-protocol binding when chat_completions endpoint exists', async () => {
  const res = await selectBindingForChatCompletions({
    model: 'gpt-4o',
    auth: fakeAuth,
    enumerate: async () => ({
      candidates: [{ binding: fakeBinding('chat_completions'), targetEndpoint: 'chat_completions' as const }],
      sawModel: true, bareModel: 'gpt-4o', upstreamPin: undefined,
    }),
  })
  expect(res.kind).toBe('ok')
  if (res.kind === 'ok') {
    expect(res.targetEndpoint).toBe('chat_completions')
    expect(res.translator).toBeDefined()
  }
})

test('returns cross-protocol selection when only messages endpoint available', async () => {
  const res = await selectBindingForChatCompletions({
    model: 'claude-sonnet',
    auth: fakeAuth,
    enumerate: async () => ({
      candidates: [{ binding: fakeBinding('messages'), targetEndpoint: 'messages' as const }],
      sawModel: true, bareModel: 'claude-sonnet', upstreamPin: undefined,
    }),
  })
  expect(res.kind).toBe('ok')
  if (res.kind === 'ok') expect(res.targetEndpoint).toBe('messages')
})

test('returns model-not-found when sawModel is false', async () => {
  const res = await selectBindingForChatCompletions({
    model: 'made-up-model',
    auth: fakeAuth,
    enumerate: async () => ({ candidates: [], sawModel: false, bareModel: 'made-up-model', upstreamPin: undefined }),
  })
  expect(res.kind).toBe('model-not-found')
  if (res.kind === 'model-not-found') expect(res.bareModel).toBe('made-up-model')
})

test('returns no-eligible-binding when sawModel but no candidates', async () => {
  const res = await selectBindingForChatCompletions({
    model: 'gpt-4o',
    auth: fakeAuth,
    enumerate: async () => ({ candidates: [], sawModel: true, bareModel: 'gpt-4o', upstreamPin: undefined }),
  })
  expect(res.kind).toBe('no-eligible-binding')
})

test('returns no-translator when targetEndpoint has no chat_completions translator', async () => {
  const res = await selectBindingForChatCompletions({
    model: 'embed-model',
    auth: fakeAuth,
    enumerate: async () => ({
      candidates: [{ binding: fakeBinding('chat_completions'), targetEndpoint: 'embeddings' as const }],
      sawModel: true, bareModel: 'embed-model', upstreamPin: undefined,
    }),
  })
  expect(res.kind).toBe('no-translator')
  if (res.kind === 'no-translator') {
    expect(res.bareModel).toBe('embed-model')
    expect(res.targetEndpoint).toBe('embeddings')
  }
})
