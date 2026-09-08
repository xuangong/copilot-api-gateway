/** Exercise real key mapping and protocol routing against each upstream's
 * output-budget contract, keeping authentication and SQLite persistence real. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { initBackground, __resetPlatformForTests } from '@vibe-core/platform'
import { responsesResultToEvents, type ResponsesResult } from '@vibe-llm/protocols/responses'
import { app } from '../../src/app.ts'
import { setupTestPlatform } from '../_setup-platform.ts'

const KEY = 'small-budget-test-key'
const MODEL = 'small-budget-target'
const ALIAS = 'claude-haiku-4.5'
const originalFetch = globalThis.fetch
let platform: ReturnType<typeof setupTestPlatform>
let pending: Promise<unknown>[]
let outbound: Array<{ path: string; payload: Record<string, unknown> }>

beforeEach(async () => {
  platform = setupTestPlatform()
  pending = []
  outbound = []
  initBackground({ waitUntil: (promise) => { pending.push(promise) } })
  await platform.repo.apiKeys.save({
    id: 'small-budget-key-id', name: 'small budget', key: KEY,
    createdAt: '2026-09-07T00:00:00Z',
    modelMappingsEnabled: true, modelMappings: [{ source: ALIAS, destination: MODEL }],
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path.endsWith('/models')) {
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
    }
    const payload = await request.json() as Record<string, unknown>
    outbound.push({ path, payload })
    if (path.endsWith('/responses')) {
      if (typeof payload.max_output_tokens === 'number' && payload.max_output_tokens < 16) {
        return Response.json({ error: {
          message: "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16.",
          code: 'invalid_request_body',
        } }, { status: 400 })
      }
      const snapshot = {
        id: 'resp_small_budget', object: 'response', model: MODEL, status: 'completed',
        output: [{ type: 'message', id: 'msg_small_budget', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } as unknown as ResponsesResult
      if (!payload.stream) return Response.json(snapshot)
      return new Response(responsesResultToEvents(snapshot).map(frame => `data: ${JSON.stringify(frame.event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    if (path.endsWith('/messages')) {
      return Response.json({
        id: 'msg_small_budget', type: 'message', role: 'assistant', model: MODEL,
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
})

afterEach(async () => {
  await Promise.allSettled(pending)
  globalThis.fetch = originalFetch
  platform.db.close()
  __resetPlatformForTests()
})

for (const endpoint of ['responses', 'messages'] as const) {
  for (const stream of [false, true]) {
    test(`a mapped Messages one-token probe succeeds via ${endpoint} (stream=${stream})`, async () => {
      await platform.repo.upstreams.save({
        id: 'small-budget-upstream', provider: 'custom', name: 'small budget',
        enabled: true, sortOrder: 0,
        config: { name: 'small budget', baseUrl: 'https://small-budget.test/v1', apiKey: 'fixture-key', endpoints: [endpoint] },
        flagOverrides: {}, disabledPublicModelIds: [], state: null,
        proxyFallbackList: [{ id: 'direct_fetch' }],
        createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
      })
      const response = await app.request('/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ model: ALIAS, max_tokens: 1, stream, messages: [{ role: 'user', content: 'Reply OK.' }] }),
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('OK')
      expect(body).not.toContain('invalid_request_body')
      expect(outbound).toHaveLength(1)
      expect(outbound[0]?.path).toBe(`/v1/${endpoint}`)
      expect(outbound[0]?.payload.model).toBe(MODEL)
      expect(outbound[0]?.payload[endpoint === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(endpoint === 'responses' ? 16 : 1)
      if (stream) {
        expect(body).toContain('"type":"message_stop"')
      } else {
        expect(JSON.parse(body)).toMatchObject({ type: 'message', role: 'assistant', usage: { output_tokens: 1 } })
      }
    })
  }
}
