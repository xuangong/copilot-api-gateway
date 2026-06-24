import { describe, test, expect } from 'bun:test'
import { mergeHeaders } from '../headers.ts'

describe('mergeHeaders', () => {
  test('returns empty object when both inputs are undefined', () => {
    expect(mergeHeaders(undefined, undefined)).toEqual({})
  })

  test('returns lowercased init headers when extra is undefined (Headers normalizes case)', () => {
    const out = mergeHeaders({ Authorization: 'Bearer x', 'X-Foo': '1' }, undefined)
    expect(out['authorization']).toBe('Bearer x')
    expect(out['x-foo']).toBe('1')
  })

  test('extra fully overrides init when keys collide', () => {
    const out = mergeHeaders(
      { authorization: 'Bearer init', 'x-keep': 'init' },
      { authorization: 'Bearer extra', 'x-new': 'extra' },
    )
    expect(out['authorization']).toBe('Bearer extra')
    expect(out['x-keep']).toBe('init')
    expect(out['x-new']).toBe('extra')
  })

  test('accepts HeadersInit array form for init', () => {
    const out = mergeHeaders(
      [['authorization', 'Bearer x'], ['x-foo', '1']],
      { 'x-foo': '2' },
    )
    expect(out['authorization']).toBe('Bearer x')
    expect(out['x-foo']).toBe('2')
  })
})
