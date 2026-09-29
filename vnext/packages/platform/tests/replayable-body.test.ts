import { describe, expect, it } from 'bun:test'
import { assertReplayBodyLength, isReplayableBody, ReplayBodyError } from '../src/replayable-body.ts'

describe('neutral replay body contract', () => {
  it('accepts zero and safe exact lengths', () => {
    expect(() => assertReplayBodyLength(0)).not.toThrow()
    expect(() => assertReplayBodyLength(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  it('rejects negative, fractional, infinite and unsafe lengths with one typed code', () => {
    for (const length of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      try { assertReplayBodyLength(length); throw new Error('expected invalid length') }
      catch (error) {
        expect(error).toBeInstanceOf(ReplayBodyError)
        expect(error).toHaveProperty('code', 'INVALID_LENGTH')
      }
    }
  })

  it('uses the literal kind rather than an open-shaped native object', () => {
    expect(isReplayableBody({ open() {}, contentLength: 1 })).toBe(false)
    expect(isReplayableBody({ kind: 'replayable', open() {}, contentLength: 1 })).toBe(true)
    expect(isReplayableBody(new Uint8Array(1))).toBe(false)
  })
})
