import { test, expect } from 'bun:test'
import { AzureProvider } from '../src/provider'

test('AzureProvider.fetch accepts ProviderRequest object form', async () => {
  const provider = new AzureProvider({
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'],
  })
  // Patch global fetch the shared-http layer uses; we just want to confirm the
  // new shape doesn't throw at the type/runtime boundary. Real network is
  // covered by integration tests.
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"id":"chat_1","object":"chat.completion"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  ) as typeof fetch
  try {
    const res = await provider.fetch({
      endpoint: 'chat_completions',
      payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers({ 'content-type': 'application/json' }),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    })
    expect(res.status).toBe(200)
    expect(res.headers).toBeInstanceOf(Headers)
  } finally {
    globalThis.fetch = orig
  }
})
