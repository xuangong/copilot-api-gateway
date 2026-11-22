import type { Calibration } from "../../../api/upstream-groups"

export interface CalibrateForm { used: string; entitlement: string; share: string; minutesAgo: string }
const num = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text))

/** Used + entitlement, or a used share in percent; the time is entered as minutes ago (at most 23 h 59 min) so no time zone is involved. */
export type CalibrationRefusal = "invalid" | "range" | "month" | "afterRead"
const SETTLE_MS = 30 * 60_000
const MAX_CALIBRATED_SHARE = 1.5
const monthStartMs = (nowMs: number): number => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }

export function parseCalibration(form: CalibrateForm, nowMs: number, lastReadAt: number | null = null): { ok: true; body: Calibration } | { ok: false; reason: CalibrationRefusal } {
  const minutes = form.minutesAgo.trim() === "" ? 0 : num(form.minutesAgo)
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1439) return { ok: false, reason: "invalid" }
  // The server counts months in UTC and ignores the first 30 minutes of one.
  if (nowMs - minutes * 60_000 < monthStartMs(nowMs) + SETTLE_MS) return { ok: false, reason: "month" }
  if (minutes > 0 && lastReadAt !== null && nowMs - minutes * 60_000 <= lastReadAt) return { ok: false, reason: "afterRead" }
  const at = minutes > 0 ? { at: nowMs - minutes * 60_000 } : {}
  const used = num(form.used)
  const entitlement = num(form.entitlement)
  if (form.used.trim() !== "" || form.entitlement.trim() !== "") {
    if (!Number.isFinite(used) || used < 0) return { ok: false, reason: "invalid" }
    // Used alone is fine: the server takes the entitlement of the last read.
    if (form.entitlement.trim() === "") return { ok: true, body: { used, ...at } }
    if (!Number.isFinite(entitlement) || entitlement <= 0) return { ok: false, reason: "invalid" }
    if (used > MAX_CALIBRATED_SHARE * entitlement) return { ok: false, reason: "range" }
    return { ok: true, body: { used, entitlement, ...at } }
  }
  const share = num(form.share)
  if (!Number.isFinite(share) || share < 0) return { ok: false, reason: "invalid" }
  if (share > MAX_CALIBRATED_SHARE * 100) return { ok: false, reason: "range" }
  return { ok: true, body: { usedShare: Math.round(share * 1e4) / 1e6, ...at } }
}
