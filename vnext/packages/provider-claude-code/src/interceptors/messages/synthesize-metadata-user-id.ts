import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

import type { MessagesBoundaryCtx } from './types'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

type MessagesMessage = MessagesPayload['messages'][number]

// Real CC includes `metadata.user_id` on every /v1/messages request: a JSON
// envelope `{device_id, account_uuid, session_id}` (v2.1.78+). Anthropic's
// detector treats a missing user_id as one of several CC-shape failures.
//
// Deterministic ids: device_id per-upstream stable, session_id per-payload
// (multi-turn re-uses when prefix repeats — the property prompt-cache routing
// relies on). Stability comes from sha256 over upstream id + payload prefix.
//
// account_uuid is the empty string by convention.
export const synthesizeMetadataUserId = async <TResult>(
  _env: object,
  ctx: MessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const existing = (ctx.payload.metadata as { user_id?: unknown } | undefined)?.user_id
  if (typeof existing === 'string' && existing.length > 0) return await run()

  const deviceId = deviceIdForUpstream(ctx.upstreamId)
  const sessionId = sessionIdForPayload(ctx.upstreamId, ctx.payload)
  const userId = JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId })

  const existingMetadata = (ctx.payload.metadata ?? {}) as Record<string, unknown>
  ctx.payload = { ...ctx.payload, metadata: { ...existingMetadata, user_id: userId } }
  return await run()
}

// 64-hex (32-byte) device_id, matching the format real CC emits.
const deviceIdForUpstream = (upstreamId: string): string =>
  sha256Hex(`claude-code-device:${upstreamId}`)

// Session id derives from upstream id + first user message text: multi-turn
// conversations of the same conversation prefix re-use the same session id,
// different conversations get different ids. Per-upstream salt prevents
// cross-upstream collision.
const sessionIdForPayload = (
  upstreamId: string,
  payload: Pick<MessagesPayload, 'messages'>,
): string => {
  const firstUser = firstUserMessageText(payload.messages)
  return sha256Uuidv4(`claude-code-session:${upstreamId}${firstUser}`)
}

const firstUserMessageText = (messages: MessagesMessage[]): string => {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    return msg.content
      .map((part) => {
        const p = part as { type?: string; text?: string }
        return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const sha256Hex = (input: string): string => bytesToHex(sha256(new TextEncoder().encode(input)))

// Same UUIDv4 stamping trick provider-codex uses: stamp version-4 nibble
// inline and overwrite variant nibble so output validates as UUIDv4.
const sha256Uuidv4 = (input: string): string => {
  const hex = sha256Hex(input)
  const variantNibble = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
