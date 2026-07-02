import { test, expect } from 'bun:test'
import { CopilotProvider } from '../src/provider'

test('fetch accepts ProviderRequest object form', async () => {
  const provider = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  // Patch the global fetch the forward layer uses; we just want to confirm the
  // new shape doesn't throw at the type/runtime boundary. Real network is
  // covered by integration tests.
  //
  // Branch on URL so the variant-filtering interceptor's `/models` lookup gets
  // a well-formed (empty) catalog instead of falling through to the
  // count-tokens response — otherwise `models.data.find(...)` throws inside
  // the try/catch and pollutes stderr.
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/models')) {
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{"input_tokens":1}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const res = await provider.fetch({
      endpoint: 'messages_count_tokens',
      payload: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers({ 'content-type': 'application/json' }),
      sourceApi: 'anthropic',
      flags: { isStreaming: false },
    })
    expect(res.status).toBe(200)
    expect(res.headers).toBeInstanceOf(Headers)
  } finally {
    globalThis.fetch = orig
  }
})
