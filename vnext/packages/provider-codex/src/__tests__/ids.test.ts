import { expect, spyOn, test } from 'bun:test'
import { sha256Utf8Parts } from '@vibe-llm/provider-llm'
import { sha256Uuid, sha256UuidFromParts } from '../ids'

const oracleDigest = async (parts: readonly string[]): Promise<Uint8Array> => {
  const bytes = new TextEncoder().encode(parts.join(''))
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

const oracle = async (parts: readonly string[]): Promise<string> => {
  const digest = await oracleDigest(parts)
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const variant = ((parseInt(hex[16] ?? '0', 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

test('incremental UUID matches independent WebCrypto and frozen legacy IDs', async () => {
  const cases: Array<{ parts: string[]; expected: string }> = [
    { parts: ['', '\u0001', '[]'], expected: 'bb303ab3-3e10-4b68-bede-112cdebd040e' },
    { parts: ['\ud83d\ude00', '\u0001', JSON.stringify([{ type: 'message', role: 'user', content: '\ud83d\ude00' }])], expected: '22b53005-a42e-41bf-a2d7-8c274c235c95' },
    { parts: ['\ud800', '\u0001', JSON.stringify([{ type: 'message', role: 'user', content: '\udc00' }])], expected: 'e62db60d-c2fb-47a4-870d-d4767b9ba1f6' },
    { parts: ['a'.repeat(16383) + '\ud83d\ude00', '\u0001', JSON.stringify([{ type: 'message', role: 'user', content: '\u2028\u0000\\"' }])], expected: '60ebd003-1e64-4df3-8a38-9b219dac78c0' },
    { parts: ['', '\u0001', JSON.stringify([{ type: 'message', role: 'developer', content: 'pre' }, { type: 'message', role: 'user', content: 'first' }])], expected: 'e421c3ba-a898-496b-bc34-6023fa082958' },
  ]
  for (const { parts, expected } of cases) {
    expect(await sha256UuidFromParts(parts)).toBe(expected)
    expect(await oracle(parts)).toBe(expected)
    expect(await sha256Uuid(parts.join(''))).toBe(expected)
    expect(await sha256Utf8Parts(parts)).toEqual(await oracleDigest(parts))
  }
})

test('UTF-8 encoding carries split pairs and replaces lone surrogates across parts', async () => {
  const cases = [
    ['', ''],
    ['\ud83d', '', '\ude00'],
    ['x'.repeat(16383) + '\ud83d', '\ude00'],
    ['x'.repeat(16384) + '\ud83d', '\ude00'],
    ['\ud800', 'a', '\udc00'],
    ['\ud800', '\ud83d\ude00'],
    ['\ud800', '', '\ud83d', '\ude00'],
    ['\ud800', '\ud800', '\udc00'],
    ['\ud800'],
    ['\udc00'],
    ['\n\u0000\\"', '漢'.repeat(20000)],
  ]
  for (const parts of cases) {
    expect(await sha256UuidFromParts(parts)).toBe(await oracle(parts))
    expect(await sha256Utf8Parts(parts)).toEqual(await oracleDigest(parts))
  }
})

test('random short Unicode partitions match full TextEncoder semantics', async () => {
  const units = ['a', '漢', '\u0000', '\ud800', '\ud83d', '\udc00', '\ude00', '']
  let state = 0x5eed1234
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  for (let sample = 0; sample < 250; sample++) {
    const parts: string[] = []
    for (let segment = 0; segment < 1 + next() % 9; segment++) {
      let part = ''
      for (let unit = 0; unit < next() % 9; unit++) part += units[next() % units.length]
      parts.push(part)
    }
    expect(await sha256UuidFromParts(parts)).toBe(await oracle(parts))
    expect(await sha256Utf8Parts(parts)).toEqual(await oracleDigest(parts))
  }
})

test('fast path is inclusive at 2 Mi UTF-16 units and larger input is incremental', async () => {
  const atBoundary = ['x'.repeat(2 * 1024 * 1024)]
  const overBoundary = ['x'.repeat(2 * 1024 * 1024), 'y']
  const atExpected = await oracle(atBoundary)
  const overExpected = await oracle(overBoundary)
  const digest = spyOn(crypto.subtle, 'digest')
  try {
    expect(await sha256UuidFromParts(atBoundary)).toBe(atExpected)
    expect(digest).toHaveBeenCalledTimes(1)
    digest.mockClear()

    const actual = await sha256UuidFromParts(overBoundary)
    expect(digest).not.toHaveBeenCalled()
    expect(actual).toBe(overExpected)
  } finally {
    digest.mockRestore()
  }
})

test('concurrent incremental hashes keep independent state', async () => {
  const parts = [
    ['a'.repeat(2 * 1024 * 1024), '\u0001', 'one'],
    ['b'.repeat(2 * 1024 * 1024), '\u0001', 'two'],
    ['\ud83d', '\ude00'.repeat(1024 * 1024)],
  ]
  const actual = await Promise.all(parts.map((value) => sha256UuidFromParts(value)))
  const expected = await Promise.all(parts.map((value) => oracle(value)))
  expect(actual).toEqual(expected)
})

test('a timer runs before a large hash completes', async () => {
  let finished = false
  let timerObservedUnfinished = false
  const timer = new Promise<void>((resolve) => setTimeout(() => {
    timerObservedUnfinished = !finished
    resolve()
  }, 0))
  const digest = sha256UuidFromParts(['x'.repeat(3 * 1024 * 1024)])
  digest.then(() => { finished = true })
  await Promise.all([timer, digest])
  expect(timerObservedUnfinished).toBe(true)
})
