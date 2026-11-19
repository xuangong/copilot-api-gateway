import { spyOn } from 'bun:test'
import type { Repo, UsageRecord } from '../../src/repo/types.ts'

type PerformanceRow = Parameters<Repo['performance']['record']>[0]

export interface CapturedRepoWrites {
  usage: UsageRecord[]
  perf: PerformanceRow[]
  touched: string[]
}

/**
 * Observe telemetry writes on a real repo. Each spy calls through to the real
 * method, so rows land in the store as in production; the captured arguments
 * let a test assert exactly what the gateway wrote. Spies are `bun:test`
 * spies: restore them with `mock.restore()` (e.g. in `afterEach`).
 */
export function captureRepoWrites(repo: Pick<Repo, 'usage' | 'performance' | 'apiKeys'>): CapturedRepoWrites {
  const captured: CapturedRepoWrites = { usage: [], perf: [], touched: [] }
  const usage = repo.usage.record.bind(repo.usage)
  spyOn(repo.usage, 'record').mockImplementation(async row => { captured.usage.push(row); await usage(row) })
  const perf = repo.performance.record.bind(repo.performance)
  spyOn(repo.performance, 'record').mockImplementation(async row => { captured.perf.push(row); await perf(row) })
  const touch = repo.apiKeys.touchLastUsed.bind(repo.apiKeys)
  spyOn(repo.apiKeys, 'touchLastUsed').mockImplementation(async id => { captured.touched.push(id); await touch(id) })
  return captured
}
