// packages/gateway/src/quota-balance/deps.ts
import { getRepo } from "../repo/index.ts"
import type { Repo } from "../repo/types.ts"
import { scheduleBackground } from "../protection/runtime.ts"

/** Injectable collaborators of every quota-balance class: tests pass a fake clock, a collecting scheduler and a fixed random. */
export interface QuotaDeps {
  repo: () => Repo
  /** Unix ms. */
  now: () => number
  schedule: (work: Promise<unknown>) => void
  random: () => number
}
export const defaultDeps = (): QuotaDeps => ({ repo: getRepo, now: Date.now, schedule: scheduleBackground, random: Math.random })
export const warn = (evt: string, error?: unknown): void => { console.warn(JSON.stringify({ evt, error: error instanceof Error ? error.name : "unknown" })) }
