import { getRepo } from "~/repo"
import { costForUsage } from "~/pricing"

function currentHour(): string {
  return new Date().toISOString().slice(0, 13) // "2026-03-09T15"
}

export function recordUsage(
  keyId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  client?: string,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
  upstream?: string | null,
): Promise<void> {
  const cost = costForUsage({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens })
  const costJson = cost ? JSON.stringify(cost) : null
  return getRepo().usage.record(keyId, model, currentHour(), 1, inputTokens, outputTokens, client, cacheReadTokens, cacheCreationTokens, upstream ?? null, costJson)
}

export function queryUsage(opts: { keyId?: string; start: string; end: string }) {
  return getRepo().usage.query(opts)
}
