import { test, expect } from 'bun:test'
import { runInterceptors } from "@vnext-gateway/service"
import type { CopilotInterceptor, Invocation, RequestContext } from "@vnext-llm/protocols/common"

const newInv = (): Invocation => ({
  endpoint: 'chat_completions',
  enabledFlags: new Set(),
  payload: {},
  headers: {},
})
const ctx: RequestContext = { requestStartedAt: 0 }

test('runInterceptors: runs in order and unwraps to terminal', async () => {
  const log: string[] = []
  const a: CopilotInterceptor = async (_inv, _ctx, run) => {
    log.push('a:pre'); const r = await run(); log.push('a:post'); return r
  }
  const b: CopilotInterceptor = async (_inv, _ctx, run) => {
    log.push('b:pre'); const r = await run(); log.push('b:post'); return r
  }
  const res = await runInterceptors(newInv(), ctx, [a, b], async () => {
    log.push('terminal'); return new Response('ok')
  })
  expect(await res.text()).toBe('ok')
  expect(log).toEqual(['a:pre', 'b:pre', 'terminal', 'b:post', 'a:post'])
})

test('runInterceptors: short-circuit when interceptor does not call run', async () => {
  const a: CopilotInterceptor = async () => new Response('short', { status: 418 })
  const r = await runInterceptors(newInv(), ctx, [a], async () => new Response('terminal'))
  expect(r.status).toBe(418)
  expect(await r.text()).toBe('short')
})

test('runInterceptors: payload mutations visible to downstream', async () => {
  const setFoo: CopilotInterceptor = async (inv, _c, run) => { inv.payload.foo = 'bar'; return run() }
  const inv = newInv()
  await runInterceptors(inv, ctx, [setFoo], async () => new Response('ok'))
  expect(inv.payload.foo).toBe('bar')
})
