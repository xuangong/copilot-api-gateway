import { test, expect } from 'bun:test'
import { app } from '../src/app.ts'

const env = {} as never

test('POST /v1/responses non-stream returns Responses-shaped body', async () => {
  const req = new Request('http://local/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      input: 'hi',
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    id: string; object: string
    output: Array<{ type: string; role?: string; content?: Array<{ type: string; text: string }> }>
    output_text: string
    usage: { input_tokens: number; output_tokens: number; total_tokens: number }
  }
  expect(body.object).toBe('response')
  expect(body.output_text).toContain('FakeProvider')
  expect(body.output[0]?.type).toBe('message')
  expect(body.output[0]?.content?.[0]?.type).toBe('output_text')
  expect(body.usage.total_tokens).toBeGreaterThan(0)
})

test('POST /v1/responses streaming returns Responses SSE events', async () => {
  const req = new Request('http://local/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      stream: true,
      input: 'hi',
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  expect(text).toContain('event: response.created')
  expect(text).toContain('event: response.output_text.delta')
  expect(text).toContain('event: response.completed')
  const deltas = [...text.matchAll(/"delta":"(.*?)"/g)].map((m) => m[1])
  expect(deltas.join('')).toContain('Hello from FakeProvider')
})

test('POST /v1/responses with invalid payload returns Responses error shape', async () => {
  const req = new Request('http://local/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})
