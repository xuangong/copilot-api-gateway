import { test, expect } from 'bun:test'
import { appendFailedUpstreams } from '../../src/shared/failed-upstreams.ts'

test('returns the message unchanged when no upstream failed', () => {
  expect(appendFailedUpstreams('Model X is not available.', [])).toBe('Model X is not available.')
})

test('inserts the parenthetical before a trailing period', () => {
  expect(appendFailedUpstreams('Model X is not available.', ['Azure prod'])).toBe(
    'Model X is not available (models from upstream(s) "Azure prod" failed to load).',
  )
})

test('joins multiple names with commas in the supplied order', () => {
  expect(appendFailedUpstreams('Model X is not available.', ['a', 'b', 'c'])).toBe(
    'Model X is not available (models from upstream(s) "a", "b", "c" failed to load).',
  )
})

test('appends without inserting when the message has no trailing period', () => {
  expect(appendFailedUpstreams('Model X is not available', ['a'])).toBe(
    'Model X is not available (models from upstream(s) "a" failed to load)',
  )
})
