// packages/gateway/src/protection/detect.ts
import { riskyCount, type PauseMode, type PauseReason, type PauseRecord, type PauseTargetKind, type ProtectionSettings, type WindowSummary } from "../repo/protection.ts"

export interface Assessment {
  trigger: "ratio" | "authBurst"
  target: { kind: PauseTargetKind; id: string }
  /** The key whose share of the risky errors reaches `keyShare`, when there is one and at least two keys sent traffic. */
  attributedKey: string | null
  reason: PauseReason
}

/**
 * Spec steps 2 and 4: does the window trigger, and who is the target? Pure: the caller supplies the summed window.
 * Ratio rule: risky >= minRiskyErrors and risky / requests >= minFailureRatio. Auth burst: authBurst > 0 and auth >= authBurst.
 */
export function assess(upstreamId: string, settings: ProtectionSettings, window: WindowSummary): Assessment | null {
  const { totals } = window
  const risky = riskyCount(totals)
  const ratio = totals.requests > 0 ? risky / totals.requests : 0
  const byRatio = risky >= settings.minRiskyErrors && ratio >= settings.minFailureRatio
  const byAuth = settings.authBurst > 0 && totals.auth >= settings.authBurst
  if (!byRatio && !byAuth) return null

  const ranked = window.byKey
    .map(key => ({ keyId: key.keyId, risky: riskyCount(key) }))
    .filter(key => key.risky > 0)
    .sort((a, b) => b.risky - a.risky || a.keyId.localeCompare(b.keyId))
  const top = ranked[0]
  const share = top && risky > 0 ? top.risky / risky : 0
  // A key is only singled out when others share the upstream: with one key, pausing it would lock the owner out of the upstream anyway.
  const activeKeys = new Set(window.byKey.filter(key => key.requests > 0 && key.keyId !== "").map(key => key.keyId))
  const attributedKey = top && top.keyId !== "" && activeKeys.size >= 2 && share >= settings.keyShare ? top.keyId : null
  const trigger = byRatio ? "ratio" as const : "authBurst" as const
  const { requests, ...counts } = totals
  return {
    trigger,
    target: attributedKey ? { kind: "key", id: attributedKey } : { kind: "upstream", id: upstreamId },
    attributedKey,
    reason: { windowMinutes: settings.windowMinutes, requests, risky, counts, failureRatio: ratio, topKeys: ranked.slice(0, 5), trigger, keyShare: attributedKey ? share : null },
  }
}

/**
 * Spec step 3: an active row for this upstream, or for the attributed key, already covers it. `active` must be unresolved and unexpired.
 * In `pause` mode only `pause` rows cover (a warning must not stop a pause after notify -> pause); in `notify` mode any row covers.
 */
export function covered(active: readonly PauseRecord[], upstreamId: string, attributedKey: string | null, mode: PauseMode): boolean {
  return active.some(row =>
    (mode === "notify" || row.mode === "pause") &&
    ((row.targetKind === "upstream" && row.targetId === upstreamId) ||
      (attributedKey !== null && row.targetKind === "key" && row.targetId === attributedKey)))
}

/** Spec step 5: `cooldownMinutes`, doubled for each earlier row of the same target in the last 24 h, capped at `maxCooldownMinutes`. */
export function cooldownMinutes(settings: ProtectionSettings, earlier: number): number {
  return Math.min(settings.maxCooldownMinutes, settings.cooldownMinutes * 2 ** Math.min(earlier, 20))
}
