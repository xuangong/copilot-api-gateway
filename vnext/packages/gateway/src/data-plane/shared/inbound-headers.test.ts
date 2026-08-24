import { describe, expect, test } from 'bun:test'
import { filterInboundHeaders } from './inbound-headers.ts'

describe('filterInboundHeaders', () => {
  test('drops everything when the allowlist is empty', () => {
    const out = filterInboundHeaders(
      new Headers({ 'user-agent': 'claude-cli/2.1.181', authorization: 'Bearer secret' }),
      [],
    )
    expect([...out.keys()]).toEqual([])
  })

  test('keeps exact names case-insensitively and drops the rest', () => {
    const out = filterInboundHeaders(
      new Headers({
        'User-Agent': 'claude-cli/2.1.181',
        'X-App': 'cli',
        authorization: 'Bearer secret',
        cookie: 'session=1',
      }),
      ['user-agent', 'x-app'],
    )
    expect(out.get('user-agent')).toBe('claude-cli/2.1.181')
    expect(out.get('x-app')).toBe('cli')
    expect(out.get('authorization')).toBeNull()
    expect(out.get('cookie')).toBeNull()
  })

  test('matches regexp entries against the normalized lowercase name', () => {
    const out = filterInboundHeaders(
      new Headers({
        'X-Stainless-Lang': 'js',
        'X-Stainless-Retry-Count': '0',
        'x-stainless-unknown': 'nope',
      }),
      [/^x-stainless-(?:lang|retry-count)$/],
    )
    expect(out.get('x-stainless-lang')).toBe('js')
    expect(out.get('x-stainless-retry-count')).toBe('0')
    expect(out.get('x-stainless-unknown')).toBeNull()
  })

  // A stateful (`/g`) matcher would alternate hit/miss across calls because
  // `RegExp.test` advances `lastIndex`. The filter must clone before testing.
  test('a /g regexp matches every candidate rather than alternating', () => {
    const out = filterInboundHeaders(
      new Headers({ 'x-a': '1', 'x-b': '2', 'x-c': '3' }),
      [/^x-[abc]$/g],
    )
    expect([...out.keys()].sort()).toEqual(['x-a', 'x-b', 'x-c'])
  })

  // The client's bearer authenticates them to *us*; forwarding it upstream
  // would leak a gateway credential into an Anthropic request.
  test('authorization is never forwarded even if the allowlist names it', () => {
    const out = filterInboundHeaders(
      new Headers({ authorization: 'Bearer gateway-key' }),
      ['authorization'],
    )
    expect(out.get('authorization')).toBeNull()
  })
})
