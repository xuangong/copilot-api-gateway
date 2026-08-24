/**
 * Shaped-request detection for Claude Code.
 *
 * Decides whether an inbound /v1/messages request is already shaped like a real
 * Claude Code session and can pass through unmodified, or whether it must be
 * re-mimicked into canonical CC shape before reaching Anthropic.
 *
 * Ported from copilot-gateway `packages/provider-claude-code/src/detection.ts`,
 * whose predicate strength mirrors sub2api
 * `backend/internal/service/claude_code_validator.go`:
 * https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_validator.go
 *
 * Weakening this predicate breaks plan billing in either direction:
 *   - Dropping the Dice-template fallback false-negatives pre-v2.1.36 CC
 *     clients (their requests carry no billing block but DO route to plan
 *     billing). We would re-mimic and replace the user's actual session
 *     fingerprint with ours — fidelity loss for zero defensive benefit.
 *   - Relaxing the strict gate (UA + headers + metadata.user_id) false-positives
 *     non-CC traffic, which Anthropic's detector — when active — downgrades to
 *     extra-usage billing.
 *
 * The detector's status changes without notice, so neither direction is safe to
 * relax on the theory that it is currently dormant.
 */
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

const UA_PATTERN = /^claude-cli\/\d+\.\d+\.\d+/i
const LEGACY_USER_ID_PATTERN =
  /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/

const DICE_THRESHOLD = 0.5

// Pre- and post-v2.1.181 CC shapes — that release renamed "interactive CLI
// tool" → "interactive agent".
const IDENTITY_TEMPLATES = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  // 2.1.233's multi-worker orchestrator mode. Shares only the "You are Claude
  // Code," stem with the CLI template, so Dice misses it without its own entry.
  'You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.',
  "You are a file search specialist for Claude Code, Anthropic's official CLI for Claude.",
  'You are a helpful AI assistant tasked with summarizing conversations.',
  'You are an interactive CLI tool that helps users',
  'You are an interactive agent that helps users',
] as const

export interface ParsedUserId {
  deviceId: string
  accountUuid: string
  sessionId: string
  isNewFormat: boolean
}

/**
 * `metadata.user_id` arrives in one of two shapes:
 *   - legacy (CLI < 2.1.78): user_<sha256>_account_<uuid?>_session_<uuid>
 *   - new (CLI >= 2.1.78): JSON {"device_id":"…","account_uuid":"…","session_id":"…"}
 * Both are valid CC identifiers; either passes detection.
 */
export const parseMetadataUserID = (raw: string): ParsedUserId | null => {
  const s = raw.trim()
  if (!s) return null
  if (s.startsWith('{')) {
    let parsed: { device_id?: unknown; account_uuid?: unknown; session_id?: unknown }
    try {
      parsed = JSON.parse(s)
    } catch {
      return null
    }
    if (typeof parsed.device_id !== 'string' || !parsed.device_id) return null
    if (typeof parsed.session_id !== 'string' || !parsed.session_id) return null
    // sub2api intentionally accepts legacy-format CC sessions where the account
    // part is empty (personal accounts that never had an organization UUID), so
    // an empty string is a legitimate value here, not a missing-field signal.
    const accountUuid = typeof parsed.account_uuid === 'string' ? parsed.account_uuid : ''
    return { deviceId: parsed.device_id, accountUuid, sessionId: parsed.session_id, isNewFormat: true }
  }
  const m = LEGACY_USER_ID_PATTERN.exec(s)
  if (!m) return null
  return { deviceId: m[1]!, accountUuid: m[2]!, sessionId: m[3]!, isNewFormat: false }
}

const normalize = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ')

const bigrams = (s: string): Map<string, number> => {
  const out = new Map<string, number>()
  const runes = [...s.toLowerCase()]
  for (let i = 0; i < runes.length - 1; i++) {
    const g = runes[i]! + runes[i + 1]!
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

// Precomputed at module load: the templates are constant and only the
// request-side string changes per call, so recomputing them per request is
// wasted work on the hot path.
const IDENTITY_TEMPLATE_BIGRAMS = IDENTITY_TEMPLATES.map((tpl) => bigrams(normalize(tpl)))

const diceFromBigrams = (a: Map<string, number>, b: Map<string, number>): number => {
  let inter = 0
  let total = 0
  for (const [g, ca] of a) {
    total += ca
    const cb = b.get(g)
    if (cb) inter += Math.min(ca, cb)
  }
  for (const cb of b.values()) total += cb
  return total === 0 ? 0 : (2 * inter) / total
}

const matchesAnyIdentityTemplate = (text: string): boolean => {
  const normalized = normalize(text)
  if (normalized.length < 2) return false
  const textBigrams = bigrams(normalized)
  return IDENTITY_TEMPLATE_BIGRAMS.some((tpl) => diceFromBigrams(textBigrams, tpl) >= DICE_THRESHOLD)
}

const looksLikeBillingBlock = (text: string): boolean =>
  text.startsWith('x-anthropic-billing-header') && text.includes('cc_entrypoint=cli')

// Real Claude Code's periodic connectivity probe carries max_tokens=1 against a
// Haiku id and no system block.
const detectHaikuProbe = (body: MessagesPayload): boolean =>
  body.model.includes('haiku') && body.max_tokens === 1

// Hand-crafted payloads can land here with a structured `system` block whose
// `.text` is missing or non-string. Mirrors sub2api `claude_code_validator.go`
// lines 175-178: skip those rather than throw — a TypeError here would crash
// the inbound request before any upstream call is made.
const extractSystemTexts = (body: MessagesPayload): string[] => {
  const system = body.system
  if (!system) return []
  if (typeof system === 'string') return [system]
  if (!Array.isArray(system)) return []
  return system.flatMap((block) => {
    const text = (block as { text?: unknown } | null)?.text
    return typeof text === 'string' && text.length > 0 ? [text] : []
  })
}

const extractUserId = (body: MessagesPayload): string | null => {
  const userId = (body.metadata as { user_id?: unknown } | null | undefined)?.user_id
  return typeof userId === 'string' && userId.length > 0 ? userId : null
}

export interface ClaudeCodeShapedRequestInput {
  headers: Headers
  body: MessagesPayload
}

export const isClaudeCodeShapedRequest = (input: ClaudeCodeShapedRequestInput): boolean => {
  const ua = input.headers.get('user-agent')
  if (!ua || !UA_PATTERN.test(ua)) return false

  // The connectivity probe legitimately carries no system block and no
  // metadata, so it must short-circuit before those gates.
  if (detectHaikuProbe(input.body)) return true

  if (!input.headers.get('x-app')) return false
  if (!input.headers.get('anthropic-beta')) return false
  if (!input.headers.get('anthropic-version')) return false

  const systemTexts = extractSystemTexts(input.body)
  if (systemTexts.length === 0) return false
  if (!systemTexts.some((t) => looksLikeBillingBlock(t) || matchesAnyIdentityTemplate(t))) return false

  const userId = extractUserId(input.body)
  if (!userId) return false
  return parseMetadataUserID(userId) !== null
}
