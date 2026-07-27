// Unit tests for the vNext-native web-search provider adapters
// (Spec 13-C-5 Q1c). Each adapter is exercised via injected fetch;
// tests cover success mapping + error surface behavior.

import { test, expect } from 'bun:test'
import { createBingWebSearchProvider } from '../../../../src/data-plane/tools/web-search/providers/bing.ts'
import { createCopilotWebSearchProvider } from '../../../../src/data-plane/tools/web-search/providers/copilot.ts'
import { createLangSearchWebSearchProvider } from '../../../../src/data-plane/tools/web-search/providers/langsearch.ts'

// ------------- Bing -------------

test('bing: parses b_algo blocks and maps to WebSearchProviderResult', async () => {
  const html = `<html><body>
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://react.dev/learn">Learn React</a></h2>
        <div class="b_caption"><p>React docs are here.</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="https://example.com/x">Ex</a></h2>
        <p class="b_lineclamp">Example snippet</p>
      </li>
    </ol>
  </body></html>`
  const fakeFetch = async () => new Response(html, { status: 200 })
  const provider = createBingWebSearchProvider('', { fetch: fakeFetch as typeof fetch })
  const result = await provider.search({ query: 'react' })
  expect(result.type).toBe('ok')
  if (result.type !== 'ok') return
  expect(result.results.length).toBe(2)
  expect(result.results[0]!.source).toBe('https://react.dev/learn')
  expect(result.results[0]!.title).toBe('Learn React')
  expect(result.results[0]!.content[0]!.text).toBe('React docs are here.')
})

test('bing: honors allowedDomains filter', async () => {
  const html = `<li class="b_algo"><h2><a href="https://react.dev/x">A</a></h2><p class="b_lineclamp">a</p></li>
                <li class="b_algo"><h2><a href="https://other.com/y">B</a></h2><p class="b_lineclamp">b</p></li>`
  const fakeFetch = async () => new Response(html, { status: 200 })
  const provider = createBingWebSearchProvider('', { fetch: fakeFetch as typeof fetch })
  const result = await provider.search({ query: 'x', allowedDomains: ['react.dev'] })
  expect(result.type).toBe('ok')
  if (result.type !== 'ok') return
  expect(result.results.map(r => r.source)).toEqual(['https://react.dev/x'])
})

test('bing: 429 -> too_many_requests, other error -> unavailable', async () => {
  const p429 = createBingWebSearchProvider('', { fetch: (async () => new Response('', { status: 429 })) as typeof fetch })
  const r429 = await p429.search({ query: 'x' })
  expect(r429.type).toBe('error')
  if (r429.type === 'error') expect(r429.errorCode).toBe('too_many_requests')

  const p500 = createBingWebSearchProvider('', { fetch: (async () => new Response('', { status: 500 })) as typeof fetch })
  const r500 = await p500.search({ query: 'x' })
  if (r500.type === 'error') expect(r500.errorCode).toBe('unavailable')
})

test('bing: fetchPage returns unavailable', async () => {
  const provider = createBingWebSearchProvider('')
  const result = await provider.fetchPage({ urls: ['https://x'] })
  expect(result.type).toBe('error')
  if (result.type === 'error') expect(result.errorCode).toBe('unavailable')
})

// ------------- LangSearch -------------

test('langsearch: sends bearer + summary flag, maps webPages.value', async () => {
  let req: Request | undefined
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    req = new Request(url, init)
    return new Response(
      JSON.stringify({
        code: 200,
        msg: 'ok',
        data: {
          webPages: {
            value: [
              { name: 'React', url: 'https://react.dev', snippet: 'S', summary: 'Full' },
            ],
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const provider = createLangSearchWebSearchProvider('ls-key', { fetch: fakeFetch })
  const result = await provider.search({ query: 'react' })

  expect(req?.headers.get('authorization')).toBe('Bearer ls-key')
  const body = await req!.json() as { query: string; summary: boolean; count: number }
  expect(body.query).toBe('react')
  expect(body.summary).toBe(true)

  expect(result.type).toBe('ok')
  if (result.type !== 'ok') return
  expect(result.results[0]!.source).toBe('https://react.dev')
  expect(result.results[0]!.content[0]!.text).toBe('Full')
})

test('langsearch: code !== 200 -> unavailable with msg', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ code: 401, msg: 'bad key' }), { status: 200 })) as typeof fetch
  const provider = createLangSearchWebSearchProvider('x', { fetch: fakeFetch })
  const result = await provider.search({ query: 'x' })
  expect(result.type).toBe('error')
  if (result.type === 'error') {
    expect(result.errorCode).toBe('unavailable')
    expect(result.message).toBe('bad key')
  }
})

test('langsearch: HTTP 429 -> too_many_requests', async () => {
  const fakeFetch = (async () => new Response('rate', { status: 429 })) as typeof fetch
  const provider = createLangSearchWebSearchProvider('x', { fetch: fakeFetch })
  const result = await provider.search({ query: 'x' })
  if (result.type === 'error') expect(result.errorCode).toBe('too_many_requests')
})

test('langsearch: fetchPage returns unavailable', async () => {
  const provider = createLangSearchWebSearchProvider('x')
  const result = await provider.fetchPage({ urls: ['https://x'] })
  if (result.type === 'error') expect(result.errorCode).toBe('unavailable')
})

// ------------- Copilot MCP -------------

test('copilot: parses plain-JSON JSON-RPC envelope', async () => {
  const mcpResult = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          text: {
            value: 'React is a UI library. See react.dev for docs.',
            annotations: [
              { start_index: 30, end_index: 45, url_citation: { title: 'React docs', url: 'https://react.dev' } },
            ],
          },
        }),
      },
    ],
  }
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: mcpResult }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  const provider = createCopilotWebSearchProvider('ghp_x', { fetch: fakeFetch })
  const result = await provider.search({ query: 'react' })
  expect(result.type).toBe('ok')
  if (result.type !== 'ok') return
  expect(result.results.length).toBe(1)
  expect(result.results[0]!.source).toBe('https://react.dev')
  expect(result.results[0]!.title).toBe('React docs')
})

test('copilot: parses SSE data: envelope', async () => {
  const mcpResult = {
    content: [{ type: 'text', text: JSON.stringify({ text: { value: 'v', annotations: [{ url_citation: { url: 'https://ex.com' } }] } }) }],
  }
  const sseBody = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: mcpResult })}\n\n`
  const fakeFetch = (async () =>
    new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const provider = createCopilotWebSearchProvider('gho_x', { fetch: fakeFetch })
  const result = await provider.search({ query: 'x' })
  expect(result.type).toBe('ok')
  if (result.type !== 'ok') return
  expect(result.results[0]!.source).toBe('https://ex.com')
})

test('copilot: 429 -> too_many_requests, 401/403 -> unavailable', async () => {
  const p429 = createCopilotWebSearchProvider('t', { fetch: (async () => new Response('', { status: 429 })) as typeof fetch })
  const r429 = await p429.search({ query: 'x' })
  if (r429.type === 'error') expect(r429.errorCode).toBe('too_many_requests')

  const p401 = createCopilotWebSearchProvider('t', { fetch: (async () => new Response('', { status: 401 })) as typeof fetch })
  const r401 = await p401.search({ query: 'x' })
  if (r401.type === 'error') expect(r401.errorCode).toBe('unavailable')
})

test('copilot: JSON-RPC error -> unavailable', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  const provider = createCopilotWebSearchProvider('t', { fetch: fakeFetch })
  const result = await provider.search({ query: 'x' })
  if (result.type === 'error') {
    expect(result.errorCode).toBe('unavailable')
    expect(result.message).toContain('boom')
  }
})

test('copilot: sends required MCP headers and JSON-RPC body', async () => {
  let req: Request | undefined
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    req = new Request(url, init)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }), { status: 200 })
  }) as unknown as typeof fetch
  const provider = createCopilotWebSearchProvider('gho_abc', { fetch: fakeFetch })
  await provider.search({ query: 'react' })
  expect(req?.url).toBe('https://api.githubcopilot.com/mcp')
  expect(req?.headers.get('authorization')).toBe('Bearer gho_abc')
  expect(req?.headers.get('x-mcp-toolsets')).toBe('web_search')
  const body = await req!.json() as { method: string; params: { name: string; arguments: { query: string } } }
  expect(body.method).toBe('tools/call')
  expect(body.params.name).toBe('web_search')
  expect(body.params.arguments.query).toBe('react')
})

test('copilot: fetchPage returns unavailable', async () => {
  const provider = createCopilotWebSearchProvider('t')
  const result = await provider.fetchPage({ urls: ['https://x'] })
  if (result.type === 'error') expect(result.errorCode).toBe('unavailable')
})
