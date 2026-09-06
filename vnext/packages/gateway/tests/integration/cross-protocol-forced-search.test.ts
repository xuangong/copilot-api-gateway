/** Real key authentication, mapping, SQLite routing, and Messages → Responses
 * translation; only the upstream HTTP and search engine boundaries are fakes. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { initBackground, __resetPlatformForTests } from '@vibe-core/platform'
import { responsesResultToEvents, type ResponsesResult } from '@vibe-llm/protocols/responses'
import { app } from '../../src/app.ts'
import { setupTestPlatform } from '../_setup-platform.ts'
import type { UpstreamRecord } from '../../src/repo/types.ts'

const KEY = 'forced-search-test-key'
const MODEL = 'forced-search-responses-target'
const ALIAS = 'claude-forced-search-alias'
const originalFetch = globalThis.fetch
let platform: ReturnType<typeof setupTestPlatform>
let pending: Promise<unknown>[]
let outbound: Array<Record<string, unknown>>
let searches: number

function upstream(shim: boolean): UpstreamRecord {
  return {
    id: 'forced-search-upstream', provider: 'custom', name: 'forced search',
    enabled: true, sortOrder: 0,
    config: {
      name: 'forced search', baseUrl: 'https://forced-search.test/v1',
      apiKey: 'fixture-upstream-key', endpoints: ['responses'],
    },
    flagOverrides: { 'responses-web-search-shim': shim },
    disabledPublicModelIds: [], state: null,
    proxyFallbackList: [{ id: 'direct_fetch' }],
    createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
  }
}

beforeEach(async () => {
  platform = setupTestPlatform()
  pending = []
  outbound = []
  searches = 0
  initBackground({ waitUntil: (promise) => { pending.push(promise) } })
  await platform.repo.apiKeys.save({
    id: 'forced-search-key-id', name: 'forced search', key: KEY,
    createdAt: '2026-09-07T00:00:00Z',
    modelMappingsEnabled: true, modelMappings: [{ source: ALIAS, destination: MODEL }],
    webSearchEnabled: true, webSearchPriority: ['tavily'], webSearchTavilyKey: 'fixture-search-key',
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'api.tavily.com') {
      searches++
      return Response.json({ results: [{ title: 'Weather', url: 'https://weather.test/beijing', content: 'Weather forecast' }] })
    }
    if (url.pathname.endsWith('/models')) {
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
    }
    if (url.pathname.endsWith('/responses')) {
      const payload = await request.json() as Record<string, unknown>
      outbound.push(payload)
      const tools = payload.tools as Array<{ type: string; name?: string }>
      const choice = payload.tool_choice as string | { type: string; name?: string }
      // The same contract rejected by the real upstream in the reported 400.
      if (typeof choice === 'object' && !tools.some((tool) =>
        tool.type === choice.type && (choice.type !== 'function' || tool.name === choice.name),
      )) {
        return Response.json({ error: { message: "Tool choice 'function' not found in 'tools' parameter.", code: 'invalid_request_body' } }, { status: 400 })
      }
      const output = typeof choice === 'object' && choice.type === 'function'
        ? [{ type: 'function_call', id: 'fc_search', call_id: 'call_search', name: choice.name, arguments: '{"search_query":[{"q":"Beijing weather"}]}' }]
        : [{ type: 'message', id: 'msg_answer', role: 'assistant', content: [{ type: 'output_text', text: 'Weather search complete.' }] }]
      const snapshot = {
        id: `resp_search_${outbound.length}`, object: 'response', model: MODEL,
        status: 'completed', output, usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
      } as unknown as ResponsesResult
      if (!payload.stream) return Response.json(snapshot)
      const frames = responsesResultToEvents(snapshot)
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame.event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
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

for (const shim of [false, true]) {
  for (const stream of [false, true]) {
    test(`forced Messages search reaches Responses with matching tools (shim=${shim}, stream=${stream})`, async () => {
      await platform.repo.upstreams.save(upstream(shim))
      const response = await app.request('/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({
          model: ALIAS, max_tokens: 1024, stream,
          messages: [{ role: 'user', content: 'Search the Beijing weather forecast.' }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          tool_choice: { type: 'tool', name: 'web_search' },
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('Weather search complete.')
      expect(body).not.toContain('invalid_request_body')
      expect(outbound[0]?.model).toBe(MODEL)
      expect(outbound[0]?.tool_choice).toEqual(shim
        ? { type: 'function', name: 'web_search' }
        : { type: 'web_search' })
      expect(searches).toBe(shim ? 1 : 0)
      expect(outbound.length).toBe(shim ? 2 : 1)
      if (shim) expect(outbound[1]?.tool_choice).toBe('auto')
      if (stream) {
        expect(body).toContain('"type":"message_stop"')
        expect(body).not.toContain('response.completed')
        if (shim) expect(body).toContain('web_search_tool_result')
      } else {
        expect(JSON.parse(body)).toMatchObject({ type: 'message', role: 'assistant', stop_reason: 'end_turn' })
      }
    })
  }
}
