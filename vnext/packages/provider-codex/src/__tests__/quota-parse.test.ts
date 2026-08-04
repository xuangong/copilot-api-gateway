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
      'x-codex-primary-reset-after-seconds': '60',
      'x-codex-secondary-reset-after-seconds': '600',
    }),
    { now, isRateLimited: true },
  )
  expect(snap.ratelimited_until).toBe('2026-01-01T00:10:00.000Z')
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
