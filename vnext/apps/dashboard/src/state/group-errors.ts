import { ApiError } from "../api/client"
import type { Translate } from "./quota-format"

interface Parsed { code: string | null; message: string | null; blockedUntil: number | null }
function parse(error: unknown): Parsed {
  const body = error instanceof ApiError && error.body && typeof error.body === "object" ? error.body as { error?: unknown; blockedUntil?: unknown } : null
  const detail = body?.error && typeof body.error === "object" ? body.error as { code?: unknown; message?: unknown } : null
  return {
    code: typeof detail?.code === "string" ? detail.code : null,
    message: typeof detail?.message === "string" ? detail.message : null,
    blockedUntil: typeof body?.blockedUntil === "number" ? body.blockedUntil : null,
  }
}

const CALIBRATION: Array<[RegExp, string]> = [
  [/1\.5 times/, "dash.qbCalErrRange"], [/current month/, "dash.qbCalErrMonth"], [/last 24 hours/, "dash.qbCalErrWindow"], [/after the last read/, "dash.qbCalErrAfterRead"],
]

/** User-facing text for a failed group, membership, Refresh or Calibrate call: the server's error codes (the body is `{ error: { code, message } }`) get their own wording. */
export function groupErrorText(error: unknown, t: Translate, nowMs: number): string {
  const { code, message, blockedUntil } = parse(error)
  switch (code) {
    case "group_limit": return t("dash.qbErrGroupLimit")
    case "invalid_owner": return t("dash.qbErrInvalidOwner")
    case "owner_mismatch": return t("dash.qbErrOwnerMismatch")
    case "invalid_name": return t("dash.qbErrName")
    case "not_found": return t("dash.qbErrNotFound")
    case "invalid_settings": return t("dash.qbErrSettingsServer", { detail: message ?? "" })
    case "too_soon": return blockedUntil === null ? t("dash.qbCalTooSoon") : t("dash.qbCalTooSoonIn", { minutes: Math.max(1, Math.ceil((blockedUntil - nowMs) / 60_000)) })
    case "invalid_calibration": return t(CALIBRATION.find(([pattern]) => pattern.test(message ?? ""))?.[1] ?? "dash.qbCalInvalid")
    case "not_a_member": return t("dash.qbErrNotAMember")
    case "unsupported_provider": return t("dash.qbErrUnsupportedProvider")
    case "invalid_body": return t("dash.qbErrInvalidBody")
    case "read_failed": return `${t("dash.qbRefreshFailed")}: ${message ?? ""}`.replace(/: $/, "")
    default: return code !== null ? message ?? code : error instanceof Error ? error.message : String(error)
  }
}
