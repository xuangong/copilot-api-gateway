import { test, expect } from 'bun:test'
import type {
  Invocation,
  RequestContext,
  CopilotInterceptor,
  ChatCompletionsStreamInterceptor,
  MessagesStreamInterceptor,
  ResponsesStreamInterceptor,
} from '../invocation'

test('Invocation has expected mutable + readonly shape', () => {
  const inv: Invocation = {
    endpoint: 'chat-completions' as Invocation['endpoint'],
    enabledFlags: new Set<string>(),
    payload: {},
    headers: {},
  }
  inv.payload = { a: 1 }
  inv.headers = { 'x-trace': 'abc' }
  expect(inv.endpoint).toBeTruthy()
  expect(inv.enabledFlags.size).toBe(0)
})

test('CopilotInterceptor signature is (req, ctx, next) => Promise<Response>', async () => {
  const fn: CopilotInterceptor = async (_req, _ctx, next) => next()
  const ctx: RequestContext = { requestStartedAt: Date.now() }
  const inv: Invocation = {
    endpoint: 'chat-completions' as Invocation['endpoint'],
    enabledFlags: new Set<string>(),
    payload: {},
    headers: {},
  }
  const out = await fn(inv, ctx, async () => new Response('ok'))
  expect(await out.text()).toBe('ok')
})

test('stream interceptor aliases compile (type-level smoke)', () => {
  const _cc: ChatCompletionsStreamInterceptor | undefined = undefined
  const _msg: MessagesStreamInterceptor | undefined = undefined
  const _rsp: ResponsesStreamInterceptor | undefined = undefined
  expect(_cc).toBeUndefined()
  expect(_msg).toBeUndefined()
  expect(_rsp).toBeUndefined()
})
