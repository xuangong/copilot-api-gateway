import { getRepo } from "~/repo"

function currentHour(): string {
  return new Date().toISOString().slice(0, 13) // "2026-03-09T15"
}

// Cost is recomputed at read-time from accumulated tokens (see dashboard
// resolveRecordCost). We intentionally stop persisting per-request cost
// snapshots because the row uses ON CONFLICT accumulation for tokens but
// the legacy cost_json column was overwritten on each upsert — leaving the
// stored cost reflecting only the last request while tokens reflected the
// sum, which diverged badly under heavy traffic.
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
  return getRepo().usage.record(keyId, model, currentHour(), 1, inputTokens, outputTokens, client, cacheReadTokens, cacheCreationTokens, upstream ?? null, null)
}

export function queryUsage(opts: { keyId?: string; start: string; end: string }) {
  return getRepo().usage.query(opts)
}
