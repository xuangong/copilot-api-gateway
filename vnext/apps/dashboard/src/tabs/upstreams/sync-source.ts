import type { SyncSourceView } from "../../api/sync"

/** `skipped`: the snapshot applied but some entries could not be (they are retried). `failing`: the last poll or apply failed. */
export type SourceHealth = "revoked" | "failing" | "skipped" | "ok"

const SKIP_CODES = new Set(["id_conflict", "unsupported_provider"])

export function sourceHealth(source: Pick<SyncSourceView, "status" | "lastError" | "lastSuccessAt">): SourceHealth {
  if (source.status === "revoked") return "revoked"
  if (source.lastError === null) return "ok"
  // A run that succeeded but skipped entries has a success time; without one, the error is a real failure.
  return SKIP_CODES.has(source.lastError) && source.lastSuccessAt !== null ? "skipped" : "failing"
}

/** Whether a newly read source differs in a way that changes the upstream list (a sync ran, or the source was revoked or removed). */
export function sourceChanged(previous: SyncSourceView | null, next: SyncSourceView | null): boolean {
  if (previous === null || next === null) return previous !== next
  return previous.status !== next.status || previous.lastSuccessAt !== next.lastSuccessAt || previous.upstreamCount !== next.upstreamCount
}

/** Lets a slow background poll be discarded once a user action has started or finished after it. */
export class PollGate {
  private sequence = 0
  ticket(): number { return this.sequence }
  bump(): void { this.sequence++ }
  isFresh(ticket: number): boolean { return ticket === this.sequence }
}

/** Keep polling while the state is unknown (a failed first load must recover); only an explicit `available: false` stops it. */
export const shouldPoll = (state: { available: boolean; source: unknown } | null): boolean => state?.available !== false
