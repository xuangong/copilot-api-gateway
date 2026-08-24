// Gap #3: active quota probe against `GET /api/oauth/usage`. Ported from
// copilot-gateway `packages/provider-claude-code/src/usage-probe.ts`.
//
// The point of the probe is to read the plan's rate-limit windows *without*
// burning a model call. The header set is load-bearing, not decorative:
// `anthropic-beta: oauth-2025-04-20` is what makes the endpoint accept the
// bearer at all, so these tests pin the wire shape as much as the parsing.
import { describe, expect, test } from 'bun:test'
import { fetchClaudeCodeUsageProbe } from '../usage-probe.ts'

interface Call {
  url: string
  method: string | undefined
  headers: Headers
}

const capturing = (respond: () => Response) => {
  const calls: Call[] = []
  const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method, headers: new Headers(init?.headers) })
    return Promise.resolve(respond())
  }
  return { calls, fetcher }
}

const okBody = { five_hour: { utilization: 0.4, resets_at: '2026-08-24T10:00:00Z' } }

describe('fetchClaudeCodeUsageProbe', () => {
  test('GETs the usage endpoint with the CLI header set', async () => {
    const { calls, fetcher } = capturing(() => new Response(JSON.stringify(okBody), { status: 200 }))
    await fetchClaudeCodeUsageProbe('at_test', fetcher)

    const call = calls[0]!
    expect(call.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(call.method).toBe('GET')
    expect(call.headers.get('authorization')).toBe('Bearer at_test')
    expect(call.headers.get('accept')).toBe('application/json')
    // Pinned axios UA — the real CLI's probe rides on axios, not on its own
    // claude-cli UA, so mimicking it means matching that.
    expect(call.headers.get('user-agent')).toBe('axios/1.13.6')
    // Without this the endpoint 401s even on a valid bearer.
    expect(call.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01')
  })

  // Anthropic adds fields (priorIsUsingOverage, hadPriorUtilizationData, …)
  // without warning, so the body is surfaced verbatim rather than parsed into
  // a fixed shape that a new field would break.
  test('returns the upstream body verbatim with a fetched_at stamp', async () => {
    const { fetcher } = capturing(() => new Response(JSON.stringify(okBody), { status: 200 }))
    const before = Date.now()
    const result = await fetchClaudeCodeUsageProbe('at_test', fetcher)

    expect(result.body).toEqual(okBody)
    expect(Date.parse(result.fetched_at)).toBeGreaterThanOrEqual(before)
  })

  test('throws with the upstream status and a truncated body on non-2xx', async () => {
    const { fetcher } = capturing(() => new Response('nope '.repeat(200), { status: 401 }))
    expect(fetchClaudeCodeUsageProbe('at_test', fetcher)).rejects.toThrow(/401/)
  })

  test('throws on a non-JSON body', async () => {
    const { fetcher } = capturing(() => new Response('<html>gateway error</html>', { status: 200 }))
    expect(fetchClaudeCodeUsageProbe('at_test', fetcher)).rejects.toThrow(/non-JSON/)
  })

  // A bare `null` or a JSON array parses fine but carries no usage windows;
  // accepting it would persist a snapshot the dashboard cannot render.
  test('throws on an empty or non-object body', async () => {
    const empty = capturing(() => new Response('', { status: 200 }))
    expect(fetchClaudeCodeUsageProbe('at_test', empty.fetcher)).rejects.toThrow(/non-object/)
    const nullish = capturing(() => new Response('null', { status: 200 }))
    expect(fetchClaudeCodeUsageProbe('at_test', nullish.fetcher)).rejects.toThrow(/non-object/)
  })
})
