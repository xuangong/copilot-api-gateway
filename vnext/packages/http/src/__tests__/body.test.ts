import { describe, test, expect } from 'bun:test'
import { parseJsonBody, truncateBody } from '../body.ts'

describe('parseJsonBody', () => {
  test('parses a valid JSON string into an object', () => {
    expect(parseJsonBody('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' })
  })

  test('throws when body is undefined', () => {
    expect(() => parseJsonBody(undefined)).toThrow(/body must be a JSON string/)
  })

  test('throws when body is null', () => {
    expect(() => parseJsonBody(null)).toThrow(/body must be a JSON string/)
  })

  test('throws when body is FormData (non-string BodyInit)', () => {
    const fd = new FormData()
    fd.append('k', 'v')
    expect(() => parseJsonBody(fd)).toThrow(/body must be a JSON string/)
  })
})

describe('truncateBody', () => {
  test('returns the original string when length <= max', () => {
    expect(truncateBody('hello', 200)).toBe('hello')
  })

  test('truncates and appends "...(truncated)" when length > max', () => {
    const s = 'x'.repeat(250)
    const out = truncateBody(s, 200)
    expect(out).toBe('x'.repeat(200) + '...(truncated)')
  })

  test('defaults max to 200 when omitted', () => {
    const s = 'y'.repeat(250)
    const out = truncateBody(s)
    expect(out).toBe('y'.repeat(200) + '...(truncated)')
  })
})
