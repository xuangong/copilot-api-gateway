/**
 * Thrown when `saveState`'s targeted row no longer exists. Distinct from a
 * generic storage failure so a best-effort writer (e.g. a models-cache write)
 * can tolerate the operator having deleted the upstream mid-request, while a
 * write that must not be lost (a rotated refresh_token) still propagates.
 */
export class UpstreamGoneError extends Error {
  constructor(readonly upstreamId: string) {
    super(`Upstream ${upstreamId} disappeared before its state could be written`)
    this.name = 'UpstreamGoneError'
  }
}
