/**
 * Set the Copilot `x-interaction-id` header from the messages payload's
 * session fingerprint. Copilot threads this id through its accounting and
 * trace tooling; same input → same UUID, so trace correlation across
 * requests still works.
 *
 * We hash the raw session id through SHA-256 and format the first 16 bytes
 * as a UUID v4 (RFC 4122 §4.4). The on-wire value stays a UUID-shaped
 * opaque identifier rather than leaking the upstream client's raw session id.
 *
 * Fires whenever `parseUserIdMetadata` produces a `sessionId`, regardless
 * of whether the safety-identifier half is also present (OpenCode-like
 * payloads sometimes ship session_id without device_id/account_uuid).
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/messages/set-interaction-id-header.ts
 */

import type { AnthropicMessagesPayload } from "./types"
import { parseUserIdMetadata } from "./detect-claude-code-metadata"

async function sessionUuid(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16)
  // RFC 4122 §4.4 layout: stamp version 4 in the high nibble of byte 6 and
  // variant 10 in the high two bits of byte 8.
  digest[6] = (digest[6]! & 0x0f) | 0x40
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function setInteractionIdHeader(
  payload: AnthropicMessagesPayload,
  headers: Record<string, string>,
): Promise<boolean> {
  const userId = (payload as { metadata?: { user_id?: string } }).metadata?.user_id
  const { sessionId } = parseUserIdMetadata(userId)
  if (!sessionId) return false
  headers["x-interaction-id"] = await sessionUuid(sessionId)
  return true
}
