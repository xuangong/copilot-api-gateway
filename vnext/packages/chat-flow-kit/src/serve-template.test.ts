// vnext/packages/chat-flow-kit/src/serve-template.test.ts
/**
 * Kit-level unit suite for serveTemplate. Covers Spec 10 §A5.
 */
import { describe, expect, test } from 'bun:test'
import {
  serveTemplate,
  type KitAuthCtx,
  type PreProcessResult,
  type ServeTemplateDeps,
  type ServeTemplateHooks,
  type ServeTemplateInput,
} from './serve-template.ts'

type Auth = KitAuthCtx & { readonly userId?: string }
type Payload = { value: number; stream?: boolean }
type Extra = { tag: string } | undefined
type AttemptResult = { kind: 'ok'; echoed: number }
type TCtx = { tag: string; isStreaming: boolean }

function defaultDeps(overrides: Partial<ServeTemplateDeps<Auth, TCtx>> = {}): ServeTemplateDeps<Auth, TCtx> {
  return {
    runQuotaGate: async () => null,
    jsonErrorWrap: (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    buildTelemetryCtx: ({ endpointTag, isStreaming }) => ({ tag: endpointTag, isStreaming }),
    ...overrides,
  }
}

function defaultInput(overrides: Partial<ServeTemplateInput<Auth>> = {}): ServeTemplateInput<Auth> {
  return {
    raw: { value: 1 },
    auth: { apiKeyId: 'k1', userId: 'u1' },
    obsCtx: { apiKeyId: 'k1', userAgent: null, requestId: 'r1' },
    extras: {},
    ...overrides,
  }
}

function defaultHooks(
  overrides: Partial<ServeTemplateHooks<Payload, AttemptResult, Extra, Auth, TCtx>> = {},
): ServeTemplateHooks<Payload, AttemptResult, Extra, Auth, TCtx> {
  return {
    endpointTag: 'test_endpoint',
    parse: ({ raw }) => raw as Payload,
    wantsStream: (p) => p.stream === true,
    runAttempt: async (a) => ({ kind: 'ok', echoed: a.payload.value }),
    respond: async (r) => new Response(JSON.stringify(r), { status: 200 }),
    ...overrides,
  }
}

describe('serveTemplate — skeleton order', () => {
  test('runs parse → preProcess → buildTelemetryCtx → runQuotaGate → runAttempt → respond in order', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      parse: ({ raw }) => {
        calls.push('parse')
        return raw as Payload
      },
      preProcess: async (payload) => {
        calls.push('preProcess')
        return { kind: 'continue', payload, extra: { tag: 'x' } }
      },
      wantsStream: (p) => {
        calls.push('wantsStream')
        return p.stream === true
      },
      runAttempt: async (a) => {
        calls.push('runAttempt')
        return { kind: 'ok', echoed: a.payload.value }
      },
      respond: async (r) => {
        calls.push('respond')
        return new Response(JSON.stringify(r), { status: 200 })
      },
    })
    const deps = defaultDeps({
      buildTelemetryCtx: ({ endpointTag, isStreaming }) => {
        calls.push('buildTelemetryCtx')
        return { tag: endpointTag, isStreaming }
      },
      runQuotaGate: async () => {
        calls.push('runQuotaGate')
        return null
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(200)
    expect(calls).toEqual([
      'parse',
      'preProcess',
      'wantsStream',
      'buildTelemetryCtx',
      'runQuotaGate',
      'runAttempt',
      'respond',
    ])
  })
})

describe('serveTemplate — parse error path', () => {
  test('default: parse() throw → deps.jsonErrorWrap with status+body', async () => {
    const hooks = defaultHooks({
      parse: () => {
        const e = Object.assign(new Error('bad json'), {
          status: 422,
          body: { error: { type: 'invalid_request_error', message: 'bad json' } },
        })
        throw e
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(result.response.status).toBe(422)
    expect(result.extra).toBeUndefined()
    expect(await result.response.json()).toEqual({
      error: { type: 'invalid_request_error', message: 'bad json' },
    })
  })

  test('default: parse() throws plain Error → 400 + message fallback', async () => {
    const hooks = defaultHooks({
      parse: () => {
        throw new Error('nope')
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(result.response.status).toBe(400)
    expect(await result.response.json()).toEqual({ error: { message: 'nope' } })
  })

  test('parseErrorRender override is preferred over jsonErrorWrap', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      parse: () => {
        throw Object.assign(new Error('x'), { status: 418, body: { teapot: true } })
      },
      parseErrorRender: (e) => {
        calls.push(`render:${e.status}`)
        return new Response('teapot', { status: 418, headers: { 'x-render': 'custom' } })
      },
    })
    const deps = defaultDeps({
      jsonErrorWrap: () => {
        throw new Error('jsonErrorWrap must NOT be called when parseErrorRender provided')
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(418)
    expect(result.response.headers.get('x-render')).toBe('custom')
    expect(await result.response.text()).toBe('teapot')
    expect(calls).toEqual(['render:418'])
  })
})

describe('serveTemplate — preProcess short-circuit', () => {
  test('short-circuit returns the supplied Response and skips quota/attempt/respond', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      preProcess: async () => {
        calls.push('preProcess')
        return {
          kind: 'short-circuit',
          response: new Response('blocked', { status: 451, headers: { 'x-from': 'pre' } }),
          extra: { tag: 'sc' },
        }
      },
      runAttempt: async () => {
        calls.push('runAttempt')
        return { kind: 'ok', echoed: -1 }
      },
      respond: async () => {
        calls.push('respond')
        return new Response('should not happen', { status: 500 })
      },
    })
    const deps = defaultDeps({
      runQuotaGate: async () => {
        calls.push('runQuotaGate')
        return null
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(451)
    expect(result.response.headers.get('x-from')).toBe('pre')
    expect(await result.response.text()).toBe('blocked')
    expect(result.extra).toEqual({ tag: 'sc' })
    expect(calls).toEqual(['preProcess'])
  })

  test('preProcess throw with status+body uses jsonErrorWrap', async () => {
    const hooks = defaultHooks({
      preProcess: async () => {
        throw Object.assign(new Error('pre-bad'), {
          status: 409,
          body: { error: { message: 'conflict' } },
        })
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(result.response.status).toBe(409)
    expect(await result.response.json()).toEqual({ error: { message: 'conflict' } })
    expect(result.extra).toBeUndefined()
  })
})

describe('serveTemplate — preProcess continue + mutation', () => {
  test('mutated payload is what runAttempt + respond see', async () => {
    const seenByAttempt: Payload[] = []
    const seenByRespond: Payload[] = []
    const hooks = defaultHooks({
      preProcess: async (payload) => ({
        kind: 'continue',
        payload: { ...payload, value: payload.value + 100 },
        extra: { tag: 'mutated' },
      }),
      runAttempt: async (a) => {
        seenByAttempt.push(a.payload)
        return { kind: 'ok', echoed: a.payload.value }
      },
      respond: async (r, c) => {
        seenByRespond.push(c.payload)
        return new Response(JSON.stringify({ r, extra: c.extra }), { status: 200 })
      },
    })
    const result = await serveTemplate(hooks, defaultInput({ raw: { value: 7 } }), defaultDeps())
    expect(seenByAttempt).toEqual([{ value: 107 }])
    expect(seenByRespond).toEqual([{ value: 107 }])
    expect(result.extra).toEqual({ tag: 'mutated' })
    const body = await result.response.json()
    expect(body).toEqual({ r: { kind: 'ok', echoed: 107 }, extra: { tag: 'mutated' } })
  })
})

describe('serveTemplate — quota-gate short-circuit', () => {
  test('quota Response returns immediately; runAttempt + respond not invoked', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      preProcess: async (p) => {
        calls.push('preProcess')
        return { kind: 'continue', payload: p, extra: { tag: 'q' } }
      },
      runAttempt: async () => {
        calls.push('runAttempt')
        return { kind: 'ok', echoed: -1 }
      },
      respond: async () => {
        calls.push('respond')
        return new Response('should not happen', { status: 500 })
      },
    })
    const deps = defaultDeps({
      runQuotaGate: async (apiKeyId) => {
        calls.push(`runQuotaGate:${apiKeyId}`)
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429 })
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(429)
    expect(await result.response.json()).toEqual({ error: { type: 'rate_limit_error' } })
    expect(result.extra).toEqual({ tag: 'q' })
    expect(calls).toEqual(['preProcess', 'runQuotaGate:k1'])
  })
})
