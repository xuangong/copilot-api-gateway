import type { UpstreamRecord } from "./types.ts"

/** Quota snapshots are advisory response telemetry, independent of configuration. */
export function upstreamConfiguration(upstream: UpstreamRecord<unknown>): string {
  let state = upstream.state
  if ((upstream.provider === 'codex' || upstream.provider === 'claude-code') && state && typeof state === 'object' && 'accounts' in state && Array.isArray(state.accounts)) {
    state = { ...state, accounts: state.accounts.map((account: unknown) => {
      if (!account || typeof account !== 'object') return account
      const clean = { ...account } as Record<string, unknown>
      delete clean.quotaSnapshot
      return clean
    }) }
  }
  const { updatedAt: _updatedAt, state: _state, ...configuration } = upstream
  return JSON.stringify({ ...configuration, state })
}
