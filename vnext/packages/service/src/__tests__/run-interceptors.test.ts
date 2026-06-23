import { test, expect } from 'bun:test'
import { runInterceptors, type Interceptor } from '../index'

interface Ctx { tag: string }
interface Req { value: number }
type Result = string

test('runInterceptors invokes terminal when no interceptors', async () => {
  const out = await runInterceptors<Ctx, Req, Result>(
    { value: 1 },
    { tag: 't' },
    [],
    async () => 'terminal',
  )
  expect(out).toBe('terminal')
})

test('runInterceptors composes interceptors in order, terminal last', async () => {
  const trace: string[] = []
  const a: Interceptor<Ctx, Req, Result> = async (req, ctx, next) => {
    trace.push(`a-before:${ctx.tag}:${req.value}`)
    const r = await next()
    trace.push('a-after')
    return `[a]${r}`
  }
  const b: Interceptor<Ctx, Req, Result> = async (_req, _ctx, next) => {
    trace.push('b-before')
    const r = await next()
    trace.push('b-after')
    return `[b]${r}`
  }
  const out = await runInterceptors<Ctx, Req, Result>(
    { value: 7 },
    { tag: 'T' },
    [a, b],
    async () => {
      trace.push('terminal')
      return 'X'
    },
  )
  expect(out).toBe('[a][b]X')
  expect(trace).toEqual([
    'a-before:T:7',
    'b-before',
    'terminal',
    'b-after',
    'a-after',
  ])
})

test('interceptor can short-circuit without calling next', async () => {
  let terminalCalled = false
  const shortCircuit: Interceptor<Ctx, Req, Result> = async () => 'SHORT'
  const out = await runInterceptors<Ctx, Req, Result>(
    { value: 0 },
    { tag: 'x' },
    [shortCircuit],
    async () => {
      terminalCalled = true
      return 'NEVER'
    },
  )
  expect(out).toBe('SHORT')
  expect(terminalCalled).toBe(false)
})
