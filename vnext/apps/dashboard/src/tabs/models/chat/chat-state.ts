/**
 * The chat thread's data model and the pure transitions over it.
 *
 * Everything here is free of React and of the network, so the reducers the
 * stream handlers feed through `setMessages` can be tested on plain arrays.
 */
import type { Part } from "../parts"
import type { AssistantOutput } from "../assistant-output"
import type { BrowserPerformanceSnapshot } from "../browser-performance"
import { migrateMessage } from "../persistence"
import type { Citation, StreamUsage, WebSearchProgress } from "../streams/openai"

export type Protocol = "openai" | "anthropic" | "gemini"
export type Role = "user" | "assistant"

export const LS_PROTOCOL = "playground.protocol"
export const LS_MESSAGES = "playground.messages"
export const MAX_PERSISTED_MESSAGES = 50

export interface Message {
  role: Role
  /** Flattened text — display fallback, copy button, empty-bubble checks. */
  text: string
  /** Ordered content as typed in the composer. Absent on assistant messages. */
  parts?: Part[]
  usage?: StreamUsage
  durationMs?: number
  performance?: BrowserPerformanceSnapshot
  /** Web search progress events surfaced as inline bubbles. */
  webSearches?: WebSearchEntry[]
  /** Sources the gateway grounded the answer in, deduped by URL. */
  citations?: Citation[]
  /**
   * Display name of the model that wrote this turn, for the avatar badge. A
   * thread survives model switches, so the panel's *current* model is the
   * wrong answer for anything but the newest reply. Absent on user turns and
   * on history persisted before turns recorded this.
   */
  model?: string
  /** The reply in its own wire shape, replayed on the next turn; see `replayTurn`. */
  output?: AssistantOutput
}

export interface WebSearchEntry {
  /** Stable ID — upstream item_id, or fallback synthetic if missing. */
  id: string
  status: "in_progress" | "searching" | "completed"
  query?: string
}

export function loadPersistedMessages(): Message[] {
  try {
    const raw = localStorage.getItem(LS_MESSAGES)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<Message & { imageUrl?: string }>
    if (!Array.isArray(parsed)) return []
    const migrated = parsed.map(migrateMessage)
    // Drop any trailing streaming-in-progress assistant bubble that may have
    // been persisted without text (e.g. tab closed mid-stream).
    const last = migrated[migrated.length - 1]
    if (last && last.role === "assistant" && !last.text && !last.parts?.length && !last.performance) migrated.pop()
    return migrated
  } catch {
    return []
  }
}

export function loadPersistedProtocol(): Protocol {
  const v = localStorage.getItem(LS_PROTOCOL)
  return v === "anthropic" || v === "gemini" ? v : "openai"
}

/** A message as the protocol serializers see it. */
export function messageParts(m: Message): Part[] {
  if (m.parts) return m.parts
  return m.text ? [{ type: "text", text: m.text }] : []
}

/**
 * How many sources stay visible before the rest fold behind "more…". A
 * research-style turn can ground itself in twenty links, and the full list
 * pushes the answer it belongs to off the screen — the sources end up more
 * prominent than the text they support. Three is enough to show what kind of
 * material was used; the rest is there for anyone who wants to audit it.
 */
export const COLLAPSED_SOURCE_COUNT = 3

/** Fallback label for a source with no title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * Prepend the user's current local time to the system prompt so models can
 * resolve "now / today / recent / yesterday" without ambiguity. Browser-side
 * only — no server tool, no extra round-trip. Re-evaluated on every send so
 * long-running sessions don't drift.
 */
export function buildTimeContext(): string {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const local = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(now)
  return `Current time: ${now.toISOString()} (${local}, timezone ${tz}).`
}

export function composeSystemPrompt(userPrompt: string): string {
  const timeLine = buildTimeContext()
  const trimmed = userPrompt.trim()
  return trimmed ? `${timeLine}\n\n${trimmed}` : timeLine
}

// —— Reducers over the thread ——
// Each returns `prev` itself when there is nothing to change, so React can
// bail out of the update.

/** Replace the trailing assistant turn, or leave the thread alone if the last turn isn't one. */
function updateLastAssistant(prev: Message[], update: (last: Message) => Message): Message[] {
  const last = prev[prev.length - 1]
  if (!last || last.role !== "assistant") return prev
  return [...prev.slice(0, -1), update(last)]
}

export function appendText(prev: Message[], chunk: string): Message[] {
  if (prev.length === 0) return prev
  return updateLastAssistant(prev, (last) => ({ ...last, text: last.text + chunk }))
}

export function setLastOutput(prev: Message[], output: AssistantOutput): Message[] {
  return updateLastAssistant(prev, (last) => ({ ...last, output }))
}

export function setLastUsage(prev: Message[], usage: StreamUsage): Message[] {
  return updateLastAssistant(prev, (last) => ({ ...last, usage }))
}

/** An image-model reply: the generated parts, plus usage when the endpoint reported any. */
export function setLastImages(prev: Message[], parts: Part[], usage: StreamUsage | undefined): Message[] {
  return updateLastAssistant(prev, (last) => ({ ...last, parts, ...(usage ? { usage } : {}) }))
}

/** Stamp the finished turn with its wall time and, for chat turns, the browser's observation. */
export function finalizeLast(prev: Message[], durationMs: number, snapshot: BrowserPerformanceSnapshot | undefined): Message[] {
  return updateLastAssistant(prev, (last) => ({ ...last, durationMs, ...(snapshot ? { performance: snapshot } : {}) }))
}

export function applyWebSearchProgress(prev: Message[], progress: WebSearchProgress): Message[] {
  return updateLastAssistant(prev, (last) => {
    const id: string = progress.item_id ?? `ws_${(last.webSearches?.length ?? 0)}`
    const existing = last.webSearches ?? []
    const idx = existing.findIndex((w) => w.id === id)
    const merged: WebSearchEntry =
      idx >= 0 && existing[idx]
        ? {
            ...existing[idx],
            id,
            status: progress.status,
            ...(progress.query ? { query: progress.query } : {}),
          }
        : { id, status: progress.status, ...(progress.query ? { query: progress.query } : {}) }
    const next = idx >= 0
      ? [...existing.slice(0, idx), merged, ...existing.slice(idx + 1)]
      : [...existing, merged]
    return { ...last, webSearches: next }
  })
}

/** Merge in newly cited sources, keeping arrival order and one entry per URL. */
export function applyCitations(prev: Message[], citations: Citation[]): Message[] {
  return updateLastAssistant(prev, (last) => {
    const seen = new Map<string, Citation>()
    for (const c of [...(last.citations ?? []), ...citations]) {
      if (!seen.has(c.url)) seen.set(c.url, c)
    }
    return { ...last, citations: [...seen.values()] }
  })
}

/** A failed send that produced nothing at all leaves no empty bubble behind. */
export function dropEmptyAssistant(prev: Message[]): Message[] {
  const last = prev[prev.length - 1]
  if (last && last.role === "assistant" && !last.text && !last.parts?.length) {
    return prev.slice(0, -1)
  }
  return prev
}

/** Cut the thread back to just before its last user turn, which a retry re-sends. */
export function dropLastUserTurn(prev: Message[]): Message[] {
  let cut = prev.length
  while (cut > 0 && prev[cut - 1]!.role !== "user") cut--
  if (cut > 0) cut--
  return prev.slice(0, cut)
}

/**
 * Drop the oldest user+assistant pair(s). One click = up to 2 oldest turns
 * (4 messages) so the user can shrink large contexts quickly without losing
 * the most recent exchanges that carry conversational state.
 *
 * Null when the thread is too short to compact; otherwise the new thread,
 * which may hold as many messages as before if there was no user turn to start
 * the cut from.
 */
export function compactMessages(prev: Message[]): Message[] | null {
  if (prev.length <= 2) return null
  const dropCount = Math.min(4, prev.length - 2)
  // Always start drop from a user message so the surviving history stays
  // user→assistant aligned.
  let start = 0
  while (start < prev.length && prev[start]!.role !== "user") start++
  return [...prev.slice(0, start), ...prev.slice(start + dropCount)]
}

/** Flip one index in a set of expanded rows. */
export function toggleIndex(prev: ReadonlySet<number>, idx: number): ReadonlySet<number> {
  const next = new Set(prev)
  // `delete` reports whether it removed anything, which is the toggle.
  if (!next.delete(idx)) next.add(idx)
  return next
}
