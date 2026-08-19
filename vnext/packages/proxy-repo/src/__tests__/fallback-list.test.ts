/**
 * `normalizeProxyFallbackList` — the single gate every fallback chain passes
 * through before storage and before dial. These cases pin its *current*
 * behaviour, including one surprise called out inline (colo casing).
 */
import { test, expect } from 'bun:test'
import {
  DIRECT_CONNECT_ID,
  DIRECT_FETCH_ID,
  entryMatchesColo,
  normalizeProxyFallbackList,
} from '../fallback-list.ts'
import type { ProxyFallbackEntry } from '../types.ts'

test('an empty list normalizes to an empty list', () => {
  expect(normalizeProxyFallbackList([])).toEqual([])
})

test('order is preserved', () => {
  expect(normalizeProxyFallbackList([{ id: 'c' }, { id: 'a' }, { id: 'b' }])).toEqual([
    { id: 'c' },
    { id: 'a' },
    { id: 'b' },
  ])
})

test('ids are trimmed', () => {
  expect(normalizeProxyFallbackList([{ id: '  px_a\t' }])).toEqual([{ id: 'px_a' }])
})

// A blank id can reach here from the dashboard's free-form row editor and from
// a stored row: the repo's JSON parser keeps any entry whose `id` is a string,
// so '' and '   ' survive persistence and are dropped only here.
test('ids that are empty or whitespace-only are dropped', () => {
  expect(normalizeProxyFallbackList([{ id: '' }, { id: '   ' }, { id: 'px_a' }])).toEqual([
    { id: 'px_a' },
  ])
})

test('a list of nothing but blank ids normalizes to an empty list', () => {
  expect(normalizeProxyFallbackList([{ id: '' }, { id: ' ' }])).toEqual([])
})

// Set-by-id semantics: a repeat means nothing beyond "try once".
test('duplicate ids collapse to the first occurrence', () => {
  expect(
    normalizeProxyFallbackList([{ id: 'px_a' }, { id: 'px_b' }, { id: 'px_a' }]),
  ).toEqual([{ id: 'px_a' }, { id: 'px_b' }])
})

// Dedup runs on the trimmed id, so padding does not buy a second slot.
test('duplicates are detected after trimming', () => {
  expect(normalizeProxyFallbackList([{ id: 'px_a' }, { id: '  px_a  ' }])).toEqual([
    { id: 'px_a' },
  ])
})

// The first occurrence wins whole: a later duplicate's `colos` is discarded
// rather than merged into or replacing the survivor's.
test('the first occurrence keeps its colos and a later duplicate contributes none', () => {
  expect(
    normalizeProxyFallbackList([
      { id: 'px_a', colos: ['LAX'] },
      { id: 'px_a', colos: ['NRT'] },
    ]),
  ).toEqual([{ id: 'px_a', colos: ['LAX'] }])
})

test('a duplicate cannot add colos to a first occurrence that had none', () => {
  expect(
    normalizeProxyFallbackList([{ id: 'px_a' }, { id: 'px_a', colos: ['NRT'] }]),
  ).toEqual([{ id: 'px_a' }])
})

test('an entry without colos comes back without a colos key at all', () => {
  const [entry] = normalizeProxyFallbackList([{ id: 'px_a' }])
  expect(entry).toEqual({ id: 'px_a' })
  expect('colos' in entry!).toBe(false)
})

// An empty whitelist would mean "matches nothing" at dial time, which no
// operator can express deliberately; it is folded back into "matches every
// colo" by omitting the key.
test('an empty colos array is stripped rather than stored', () => {
  const [entry] = normalizeProxyFallbackList([{ id: 'px_a', colos: [] }])
  expect('colos' in entry!).toBe(false)
})

test('colos that are all blank are stripped like an empty array', () => {
  const [entry] = normalizeProxyFallbackList([{ id: 'px_a', colos: ['', '  '] }])
  expect('colos' in entry!).toBe(false)
})

test('colos are trimmed, uppercased and order-preserved', () => {
  expect(normalizeProxyFallbackList([{ id: 'px_a', colos: [' nrt ', 'lax'] }])).toEqual([
    { id: 'px_a', colos: ['NRT', 'LAX'] },
  ])
})

// Dedup happens after uppercasing, so colos differing only in case collapse.
test('colos are deduplicated case-insensitively, keeping the first', () => {
  expect(
    normalizeProxyFallbackList([{ id: 'px_a', colos: ['nrt', 'NRT', ' Nrt ', 'lax'] }]),
  ).toEqual([{ id: 'px_a', colos: ['NRT', 'LAX'] }])
})

// Built-in transports share the list with operator-managed proxies and get no
// special treatment here — normalization is purely about entry shape. Whether
// an id resolves to a proxy row is decided elsewhere.
test('built-in ids are normalized like any other id', () => {
  expect(
    normalizeProxyFallbackList([
      { id: `  ${DIRECT_CONNECT_ID}  ` },
      { id: DIRECT_FETCH_ID, colos: ['nrt'] },
      { id: DIRECT_CONNECT_ID },
    ]),
  ).toEqual([{ id: DIRECT_CONNECT_ID }, { id: DIRECT_FETCH_ID, colos: ['NRT'] }])
})

// Unknown ids are not the concern of this function: it never consults the
// proxy catalog, so a nonexistent proxy id passes through untouched and fails
// (or is reported) later.
test('unknown proxy ids pass through untouched', () => {
  expect(normalizeProxyFallbackList([{ id: 'px_does_not_exist' }])).toEqual([
    { id: 'px_does_not_exist' },
  ])
})

test('the input list and its entries are not mutated', () => {
  const colos = [' nrt ']
  const input: ProxyFallbackEntry[] = [{ id: '  px_a  ', colos }]
  const out = normalizeProxyFallbackList(input)
  expect(input).toEqual([{ id: '  px_a  ', colos: [' nrt '] }])
  expect(colos).toEqual([' nrt '])
  expect(out).not.toBe(input)
  expect(out[0]).not.toBe(input[0])
})

/**
 * Known wart, pinned as-is rather than fixed.
 *
 * Normalization uppercases every colo code, but the value it is matched
 * against at dial time is `getRuntimeLocation()` from @vibe-core/platform,
 * whose only possible returns are the lowercase literals 'bun' and
 * 'cloudflare'. `entryMatchesColo` compares with `Array.includes`, which is
 * case-sensitive, so a whitelist written as the runtime location the operator
 * actually sees never matches. The comment above `normalizeProxyFallbackList`
 * describes a `getRuntimeLocation` that uppercases its inputs; that is stale.
 *
 * The practical consequence is that a `colos` whitelist excludes the entry on
 * every current runtime unless the operator types the location in uppercase.
 */
test('uppercased colos do not match the lowercase runtime locations (known wart)', () => {
  const [entry] = normalizeProxyFallbackList([{ id: 'px_a', colos: ['bun'] }])
  expect(entry).toEqual({ id: 'px_a', colos: ['BUN'] })
  expect(entryMatchesColo(entry!, 'bun')).toBe(false)
  expect(entryMatchesColo(entry!, 'BUN')).toBe(true)
})

test('an entry with no colos matches any location', () => {
  const [entry] = normalizeProxyFallbackList([{ id: 'px_a' }])
  expect(entryMatchesColo(entry!, 'bun')).toBe(true)
})
