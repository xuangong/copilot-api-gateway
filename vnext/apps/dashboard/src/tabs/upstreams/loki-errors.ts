import { ApiError } from "../../api/client"

/** The server's `error.code` from a failed API call, if any. */
export function settingsError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object" || !("error" in error.body)) return undefined
  const detail = error.body.error
  return detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string" ? detail.code : undefined
}

/** Copy key for a failed mirror issue or revoke; `mirror_not_found` has no message (the list is refetched instead). */
export function mirrorIssueErrorKey(code: string | undefined): string | null {
  if (code === "mirror_not_found") return null
  if (code === "mirror_limit") return "dash.lokiMirrorLimit"
  if (code === "https_required") return "dash.lokiHttpsRequired"
  return "dash.lokiMirrorError"
}

/** Copy key for a failed create-from-mirror or re-import. */
export function mirrorImportErrorKey(code: string | undefined): string {
  switch (code) {
    case "invalid_mirror": return "dash.lokiMirrorInvalid"
    case "invalid_mirror_document": return "dash.lokiMirrorDocumentInvalid"
    case "mirror_unreachable": return "dash.lokiMirrorUnreachable"
    case "invalid_endpoint": return "dash.lokiEndpointInvalid"
    default: return "dash.lokiMirrorImportError"
  }
}
