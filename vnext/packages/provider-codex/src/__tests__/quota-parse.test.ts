import { test, expect } from 'bun:test'
import {
  CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT,
  codexQuotaActiveLimitKey,
  computeCodexQuotaTtlMs,
  parseCodexQuotaHeaders,
} from '../quota'

const mkHeaders = (init: Record<string, string>): Headers => new Headers(init)

test('parseCodexQuotaHeaders: empty headers → observed_at only', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const snap = parseCodexQuotaHeaders(mkHeaders({}), { now, isRateLimited: false })
  expect(snap).toEqual({ observed_at: now.toISOString() })
})

test('parseCodexQuotaHeaders: strings/numbers/bools + reset-after → ISO', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const snap = parseCodexQuotaHeaders(
    mkHeaders({
      'x-codex-active-limit': 'weekly',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-used-percent': '10',
      'x-codex-secondary-window-minutes': '300',
      'x-codex-secondary-reset-after-seconds': '60',
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-balance': '250',
    }),
    { now, isRateLimited: false },
  )
  expect(snap.active_limit).toBe('weekly')
  expect(snap.plan_type).toBe('plus')
  expect(snap.primary_used_percent).toBe(42.5)
  expect(snap.primary_window_minutes).toBe(10080)
  expect(snap.primary_reset_after_at).toBe('2026-01-01T01:00:00.000Z')
  expect(snap.secondary_used_percent).toBe(10)
  expect(snap.secondary_window_minutes).toBe(300)
  expect(snap.secondary_reset_after_at).toBe('2026-01-01T00:01:00.000Z')
  expect(snap.credits_has_credits).toBe(true)
  expect(snap.credits_balance).toBe(250)
  expect(snap.ratelimited_until).toBeUndefined()
})

test('parseCodexQuotaHeaders: isRateLimited stamps ratelimited_until from max window', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const snap = parseCodexQuotaHeaders(
    mkHeaders({
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-used-percent': '100',
      'x-codex-primary-reset-after-seconds': '60',
      'x-codex-secondary-reset-after-seconds': '600',
    }),
    { now, isRateLimited: true },
  )
  expect(snap.ratelimited_until).toBe('2026-01-01T00:10:00.000Z')
})

// Adapted from reference copilot-gateway c27a76122 (#570): a 429 must be dated
// by the windows actually exhausted (>=100% with a valid reset), not by the
// furthest reset of any window; otherwise a 5h limit blocks for 7 days.
test.each([
  ['primary only exhausted', '100', '40', '2026-01-01T00:05:00.000Z'],
  ['secondary only exhausted', '40', '100', '2026-01-08T00:00:00.000Z'],
  ['both exhausted -> latest', '100', '100', '2026-01-08T00:00:00.000Z'],
  ['none exhausted -> unset', '99.9', '40', undefined],
  ['no usage headers -> unset', undefined, undefined, undefined],
  ['invalid usage -> unset', 'NaN', 'Infinity', undefined],
])('parseCodexQuotaHeaders: 429 expiry from exhausted windows only: %s', (_n, primary, secondary, expected) => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const init: Record<string, string> = {
    'x-codex-primary-reset-after-seconds': '300',
    'x-codex-secondary-reset-after-seconds': String(7 * 24 * 3600),
  }
  if (primary !== undefined) init['x-codex-primary-used-percent'] = primary
  if (secondary !== undefined) init['x-codex-secondary-used-percent'] = secondary
  const snap = parseCodexQuotaHeaders(mkHeaders(init), { now, isRateLimited: true })
  expect(snap.ratelimited_until).toBe(expected)
})

test('parseCodexQuotaHeaders: exhausted window without a reset does not invent an expiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const snap = parseCodexQuotaHeaders(
    mkHeaders({ 'x-codex-primary-used-percent': '100', 'x-codex-secondary-reset-after-seconds': '600' }),
    { now, isRateLimited: true },
  )
  expect(snap.ratelimited_until).toBeUndefined()
})

test('parseCodexQuotaHeaders: ignores non-numeric numeric headers', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const snap = parseCodexQuotaHeaders(
    mkHeaders({ 'x-codex-primary-used-percent': 'not-a-number' }),
    { now, isRateLimited: false },
  )
  expect(snap.primary_used_percent).toBeUndefined()
})

test('codexQuotaActiveLimitKey: prototype pollution guard', () => {
  expect(codexQuotaActiveLimitKey({ observed_at: 'x', active_limit: '__proto__' })).toBe(
    CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT,
  )
  expect(codexQuotaActiveLimitKey({ observed_at: 'x', active_limit: 'constructor' })).toBe(
    CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT,
  )
  expect(codexQuotaActiveLimitKey({ observed_at: 'x' })).toBe(CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT)
  expect(codexQuotaActiveLimitKey({ observed_at: 'x', active_limit: '  weekly  ' })).toBe(
    'weekly',
  )
})

test('computeCodexQuotaTtlMs: floors at 24h when horizons are past', () => {
  const now = new Date('2026-01-02T00:00:00.000Z')
  expect(computeCodexQuotaTtlMs({ observed_at: 'x' }, now)).toBe(24 * 60 * 60 * 1000)
})

test('computeCodexQuotaTtlMs: extends to furthest future reset', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const ttl = computeCodexQuotaTtlMs(
    {
      observed_at: 'x',
      primary_reset_after_at: '2026-01-03T00:00:00.000Z', // 48h out
      secondary_reset_after_at: '2026-01-02T00:00:00.000Z', // 24h out
    },
    now,
  )
  expect(ttl).toBe(48 * 60 * 60 * 1000)
})
