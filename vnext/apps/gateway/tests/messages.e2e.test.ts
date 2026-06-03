import { test, expect } from 'bun:test'
import { app } from '../src/app.ts'

const env = {} as never

test('POST /v1/messages non-stream returns Anthropic-shaped body', async () => {
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { type: string; role: string; content: Array<{ type: string; text?: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }
  expect(body.type).toBe('message')
  expect(body.role).toBe('assistant')
  expect(body.content[0]?.type).toBe('text')
  expect(body.content[0]?.text).toContain('FakeProvider')
  expect(body.stop_reason).toBe('stop')
  expect(body.usage.output_tokens).toBeGreaterThan(0)
})

test('POST /v1/messages streaming returns Anthropic SSE events', async () => {
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  expect(text).toContain('event: message_start')
  expect(text).toContain('event: content_block_start')
  expect(text).toContain('event: content_block_delta')
  expect(text).toContain('"text_delta"')
  expect(text).toContain('event: message_stop')

  // SDK accumulator: text deltas concatenate to the upstream text
  const deltas = [...text.matchAll(/"text_delta","text":"(.*?)"/g)].map((m) => m[1])
  const reconstructed = deltas.join('')
  expect(reconstructed).toContain('Hello from FakeProvider')
})

test('POST /v1/messages with invalid payload returns Anthropic error shape', async () => {
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }), // missing model + max_tokens
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
  const body = await res.json() as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('invalid_request_error')
})
