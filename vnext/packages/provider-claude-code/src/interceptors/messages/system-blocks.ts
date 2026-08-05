import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

import type { MessagesPayload, MessagesTextBlock } from '@vibe-llm/protocols/messages'

// Three-block `system` array we send to Anthropic on the re-mimicry path,
// plus the per-request fingerprint helper that feeds the billing block.
//
// `IDENTITY_BLOCK` is the byte-exact identity banner real CC sends as
// `system[1]`; `DEFAULT_TEMPLATE_BLOCK` carries the cache-anchored
// `system[2]` boilerplate and is intentionally a strict subset of the
// v2.1.181 wire shape.
//
// `cch=00000` is a literal placeholder, not a client-computed hash. Real CC
// 2.x native binary emits `x-anthropic-billing-header: cc_version=…;
// cc_entrypoint=cli; cch=00000;` verbatim. Per-request hash mutation would
// poison Anthropic's prompt cache.

export const IDENTITY_BLOCK: MessagesTextBlock = {
  type: 'text',
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
}

// `system[2]` boilerplate carried alongside the identity block. Aligned to
// sub2api's `claudeCodeSystemPromptExpansion`. Byte-exact extracts from
// @anthropic-ai/claude-code@2.1.181's compiled prompt builder.
export const DEFAULT_TEMPLATE_BLOCK: MessagesTextBlock = {
  type: 'text',
  text: `You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

# Tone and style
 - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
 - Your responses should be short and concise.
 - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
 - When referencing GitHub issues or pull requests, use the owner/repo#123 format (e.g. anthropics/claude-code#100) so they render as clickable links.
 - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`,
  // `ttl: '5m'` matches sub2api's `gateway_service.go:4350-4357`. Real CC at
  // v2.1.181 ships `'1h'`; sub2api's `'5m'` keeps the cached prefix active
  // across in-flight turns without burning the 1h quota window — the trade-
  // off we want for a multi-tenant gateway.
  cache_control: { type: 'ephemeral', ttl: '5m' },
}

// 12-char ASCII salt, NOT hex-decoded. Ported from sub2api's
// `gateway_billing_block.go`, originally reverse-engineered from real CC
// packet captures.
const FINGERPRINT_SALT_ASCII = '59cf53e54c78'

// Byte indices into the first user-role text; see FINGERPRINT_SALT_ASCII source.
const FINGERPRINT_INDICES = [4, 7, 20] as const

const encoder = new TextEncoder()

const extractFirstUserText = (body: MessagesPayload): string => {
  for (const msg of body.messages) {
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    for (const block of msg.content) {
      if (block.type === 'text') return (block as { text: string }).text
    }
    return ''
  }
  return ''
}

// SHA-256(salt + body-derived 3 bytes + version), first 3 hex chars. The 3
// body-derived bytes come from UTF-8 indices 4, 7, 20 of the first user-
// message text; positions past the end are filled with 0x30 ('0').
export const computeCcVersionFingerprint = (version: string, body: MessagesPayload): string => {
  const utf8 = encoder.encode(extractFirstUserText(body))
  const chars = new Uint8Array(FINGERPRINT_INDICES.length)
  for (let i = 0; i < FINGERPRINT_INDICES.length; i++) {
    const idx = FINGERPRINT_INDICES[i]!
    chars[i] = idx < utf8.length ? utf8[idx]! : 0x30
  }
  const salt = encoder.encode(FINGERPRINT_SALT_ASCII)
  const ver = encoder.encode(version)
  const input = new Uint8Array(salt.length + chars.length + ver.length)
  input.set(salt, 0)
  input.set(chars, salt.length)
  input.set(ver, salt.length + chars.length)
  return bytesToHex(sha256(input)).slice(0, 3)
}

// Billing-attribution block dropped at `system[0]`. Sits BEFORE the cache
// breakpoint on `system[2]` so the per-request fingerprint bytes don't
// invalidate the cached identity+template prefix.
export const buildBillingBlock = (version: string, fingerprint: string): MessagesTextBlock => ({
  type: 'text',
  text: `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli; cch=00000;`,
})
