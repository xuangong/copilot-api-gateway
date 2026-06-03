import { test, expect } from 'bun:test'
import { app } from '../src/app.ts'

const env = {} as never

test('POST /v1/chat/completions non-stream returns OpenAI-shaped body', async () => {
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    id: string; object: string
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }
  expect(body.object).toBe('chat.completion')
  expect(body.choices[0]?.message.role).toBe('assistant')
  expect(body.choices[0]?.message.content).toContain('FakeProvider')
  expect(body.choices[0]?.finish_reason).toBe('stop')
  expect(body.usage.completion_tokens).toBeGreaterThan(0)
})

test('POST /v1/chat/completions streaming returns OpenAI SSE chunks + [DONE]', async () => {
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  expect(text).toContain('"object":"chat.completion.chunk"')
  expect(text).toContain('data: [DONE]')
  const deltas = [...text.matchAll(/"delta":\{"content":"(.*?)"\}/g)].map((m) => m[1])
  expect(deltas.join('')).toContain('Hello from FakeProvider')
})

test('POST /v1/chat/completions with invalid payload returns OpenAI error shape', async () => {
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})
