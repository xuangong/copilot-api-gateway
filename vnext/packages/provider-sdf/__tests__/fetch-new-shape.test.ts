import { test, expect } from 'bun:test'
import { SdfProvider } from '../src/provider'

test('SdfProvider.fetch accepts ProviderRequest object form', async () => {
  const provider = new SdfProvider({
    name: 'sdf-test',
    substrateToken: 'sub-token',
  })
  // Patch global fetch the shared-http layer uses; we just want to confirm the
  // new shape doesn't throw at the type/runtime boundary. Real network is
  // covered by integration tests.
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"data":[{"url":"http://example.com/img.png"}]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  ) as typeof fetch
  try {
    const res = await provider.fetch({
      endpoint: 'images_generations',
      payload: { model: 'gpt-image-2', prompt: 'a cat' },
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
