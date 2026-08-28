/**
 * `forwardUpstreamError` — the upstream error path.
 *
 * The contract is "don't touch it", so most of these tests assert *absence* of
 * transformation. The one that earns its keep is the `computer_use_preview`
 * case: that exact body, served without a JSON content-type, is what the old
 * repackaging code mangled into a double-encoded `message` with `code` and
 * `param` missing.
 */
import { test, expect } from 'bun:test'
import { forwardUpstreamError } from '../src/data-plane/errors/forward.ts'

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('the upstream body is forwarded byte-for-byte', async () => {
  const raw = '{"error":{"message":"bad model","type":"invalid_request_error"}}'
  const out = await forwardUpstreamError(new Response(raw, {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }), 'messages')
  expect(out.status).toBe(400)
  expect(await out.text()).toBe(raw)
})

test('code and param survive — the regression that started this', async () => {
  // Copilot's real rejection, verbatim, including the absent JSON content-type
  // that used to route this down the raw-text branch.
  const raw = '{"error":{"message":"The requested tool computer_use_preview is not supported.",'
    + '"code":"unsupported_value","param":"tools","type":"invalid_request_error"}}\n'
  const out = await forwardUpstreamError(new Response(raw, {
    status: 400,
    headers: { 'content-type': 'text/plain' },
  }), 'responses')
  expect(out.status).toBe(400)
  const body = await out.json() as { error: { code: string; param: string; message: string } }
  expect(body.error.code).toBe('unsupported_value')
  expect(body.error.param).toBe('tools')
  // Not the whole JSON document stuffed into `message`.
  expect(body.error.message).toBe('The requested tool computer_use_preview is not supported.')
})

test('a non-JSON body is forwarded as-is, content-type included', async () => {
  const out = await forwardUpstreamError(
    new Response('upstream down', { status: 502, headers: { 'content-type': 'text/plain' } }),
    'chat_completions',
  )
  expect(out.status).toBe(502)
  expect(out.headers.get('content-type')).toBe('text/plain')
  expect(await out.text()).toBe('upstream down')
})

test('retry-after reaches the client on a 429', async () => {
  // The old repackaging dropped every upstream header. The OpenAI SDK honours
  // this one for backoff.
  const out = await forwardUpstreamError(new Response('{"error":{"message":"rate"}}', {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '5' },
  }), 'chat_completions')
  expect(out.headers.get('retry-after')).toBe('5')
})

test('content-encoding is stripped, because fetch already decoded the body', async () => {
  // `fetch` gunzips the payload but leaves both headers in place. Forwarding
  // them would label plain text as gzip and break the client's decoder.
  const out = await forwardUpstreamError(new Response('{"error":{"message":"x"}}', {
    status: 500,
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '999',
      'set-cookie': 'session=leak',
    },
  }), 'responses')
  expect(out.headers.get('content-encoding')).toBeNull()
  expect(out.headers.get('content-length')).toBeNull()
  expect(out.headers.get('set-cookie')).toBeNull()
  expect(out.headers.get('content-type')).toBe('application/json')
  expect(await out.json()).toEqual({ error: { message: 'x' } })
})

test('an empty body gets a minted envelope, since there is nothing to forward', async () => {
  const out = await forwardUpstreamError(new Response('', { status: 503 }), 'chat_completions')
  expect(out.status).toBe(503)
  const body = await out.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('503')
})

test('an empty body for messages gets the Anthropic shape', async () => {
  const out = await forwardUpstreamError(new Response('', { status: 400 }), 'messages')
  const body = await out.json() as { type: string; error: { type: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('invalid_request_error')
})

// --- gemini: the one protocol that still gets reshaped ---

test('gemini: an OpenAI-shaped upstream body is re-minted, not forwarded', async () => {
  // No upstream we bind speaks Gemini, so this is the *normal* case here.
  // Forwarding verbatim would leave @google/genai with no code and no status.
  const out = await forwardUpstreamError(jsonRes(429, { error: { message: 'slow down' } }), 'gemini')
  expect(out.status).toBe(429)
  const body = await out.json() as { error: { code: number; message: string; status: string } }
  expect(body.error.code).toBe(429)
  expect(body.error.status).toBe('RESOURCE_EXHAUSTED')
  expect(body.error.message).toContain('slow down')
})

test('gemini: a genuine Google RPC body is forwarded untouched', async () => {
  const raw = JSON.stringify({
    error: { code: 400, message: 'Invalid argument', status: 'INVALID_ARGUMENT', details: [{ reason: 'X' }] },
  })
  const out = await forwardUpstreamError(new Response(raw, {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }), 'gemini')
  // `details` is the tell: a re-mint would have dropped it.
  expect(await out.text()).toBe(raw)
})

test('gemini: a bare {error:{message}} is not mistaken for a Google RPC error', async () => {
  // All three of code/message/status are required, per the reference's
  // `isGeminiErrorResponse`. Accepting two would misclassify every OpenAI body.
  const out = await forwardUpstreamError(jsonRes(500, { error: { message: 'boom', code: 500 } }), 'gemini')
  const body = await out.json() as { error: { status: string } }
  expect(body.error.status).toBe('INTERNAL')
})

test('an unknown sourceApi forwards like the rest', async () => {
  const raw = '{"error":{"message":"teapot"}}'
  const out = await forwardUpstreamError(new Response(raw, {
    status: 418,
    headers: { 'content-type': 'application/json' },
  }), undefined)
  expect(out.status).toBe(418)
  expect(await out.text()).toBe(raw)
})
