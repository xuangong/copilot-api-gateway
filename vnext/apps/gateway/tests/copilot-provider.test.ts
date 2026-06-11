/**
 * CopilotProvider dispatcher tests — validates the interceptor-runner
 * integration without hitting the real Copilot API.
 *
 * Strategy: stub globalThis.fetch (per memory: bun_mock_module_unrestorable).
 * The provider's terminal is callCopilotAPI → fetch; stubbing here keeps
 * the test deterministic and exercises the runInterceptors → terminal
 * boundary that the contract guarantees.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { CopilotProvider } from '@vnext/provider-copilot'

const origFetch = globalThis.fetch

interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}
let captured: CapturedCall[] = []

beforeEach(() => {
  captured = []
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    let body: unknown = init?.body
    try { if (typeof init?.body === 'string') body = JSON.parse(init.body) } catch { /* keep raw */ }
    captured.push({ url, method: init?.method ?? 'GET', headers, body })
    return Response.json({ id: 'cmpl_stub', object: 'response', output: [] })
  }) as typeof fetch
})

afterEach(() => { globalThis.fetch = origFetch })

test('CopilotProvider.fetch dispatches /responses to Copilot base url', async () => {
  const provider = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  const res = await provider.fetch('responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4o', input: [], stream: false }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.ok).toBe(true)
  expect(captured).toHaveLength(1)
  expect(captured[0]!.url).toMatch(/\/responses$/)
  expect(captured[0]!.method).toBe('POST')
  const body = captured[0]!.body as { model: string }
  expect(body.model).toBe('gpt-4o')
})

test('CopilotProvider rejects unsupported endpoints', async () => {
  const provider = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  await expect(
    provider.fetch('images_generations', { method: 'POST', body: JSON.stringify({}) }),
  ).rejects.toThrow(/does not support endpoint/)
})

test('CopilotProvider requires JSON string body', async () => {
  const provider = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  await expect(
    provider.fetch('responses', { method: 'POST', body: new Uint8Array() as unknown as BodyInit }),
  ).rejects.toThrow(/body must be a JSON string/)
})

test('CopilotProvider merges extraHeaders into outbound request', async () => {
  const provider = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  await provider.fetch(
    'responses',
    { method: 'POST', body: JSON.stringify({ model: 'gpt-4o' }), headers: { 'x-base': 'b' } },
    { extraHeaders: { 'x-extra': 'e' } },
  )
  expect(captured[0]!.headers['x-base']).toBe('b')
  expect(captured[0]!.headers['x-extra']).toBe('e')
})
