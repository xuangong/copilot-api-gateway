import { test, expect, mock } from 'bun:test'
import { runInterceptors } from '@vnext/interceptor'
import { withCountTokensPrelude } from '../src/interceptors/messages-count-tokens/with-count-tokens-prelude'

test('count-tokens prelude strips context_management before terminal', async () => {
  const inv = {
    endpoint: 'messages_count_tokens' as const,
    enabledFlags: new Set<string>(),
    sourceApi: 'messages' as const,
    payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }], context_management: { foo: 'bar' } },
    headers: new Headers(),
  }
  const ctx = { requestStartedAt: Date.now() }
  let captured: unknown = null
  const terminal = mock(async () => {
    captured = JSON.parse(JSON.stringify(inv.payload))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  await runInterceptors(inv, ctx, [withCountTokensPrelude], terminal)
  expect((captured as { context_management?: unknown }).context_management).toBeUndefined()
})
