import { useCallback, useEffect, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { Select, type SelectOption } from "../../components/Select"
import { fileToDataUrl, ImageTooLargeError } from "./image"
import {
  buildEditsForm, buildGenerationsBody, buildImageContext, imagesErrorMessage,
  parseImagesResponse, type ImageParams, type PlaygroundMode,
} from "./images"
import { getImages, pruneImages, putImage } from "./image-store"
import { domToParts, type Part, partsToText } from "./parts"
import { toAnthropicContent, toChatHistory, toGeminiParts, toOpenAIContent } from "./payload"
import { isImageRejection, type VisionSupport } from "./vision"
import { ImageParamsBar } from "./ImageParamsBar"
import { downloadImage, imageFilename } from "./download"
import { collectImageIds, adoptImageIds, hydrateMessage, migrateMessage, stripImageBytes } from "./persistence"
import { parseOpenAIStream, type Citation, type StreamUsage, type WebSearchProgress } from "./streams/openai"
import { parseAnthropicStream } from "./streams/anthropic"
import { parseGeminiStream } from "./streams/gemini"
import { renderMarkdown } from "./markdown"
import { isAtBottom } from "./scroll"
import { initialFullscreen, persistFullscreen, spendLanded } from "./fullscreen"
import { avatarLabel } from "./avatar"
import { pruneIndexedState, retractFrom } from "./retract"
import { contextPercent, contextPressure, formatTokens } from "./tokens"

type Protocol = "openai" | "anthropic" | "gemini"
type Role = "user" | "assistant"

const LS_PROTOCOL = "playground.protocol"
const LS_MESSAGES = "playground.messages"
const MAX_PERSISTED_MESSAGES = 50

function loadPersistedMessages(): Message[] {
  try {
    const raw = localStorage.getItem(LS_MESSAGES)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<Message & { imageUrl?: string }>
    if (!Array.isArray(parsed)) return []
    const migrated = parsed.map(migrateMessage)
    // Drop any trailing streaming-in-progress assistant bubble that may have
    // been persisted without text (e.g. tab closed mid-stream).
    const last = migrated[migrated.length - 1]
    if (last && last.role === "assistant" && !last.text && !last.parts?.length) migrated.pop()
    return migrated
  } catch {
    return []
  }
}

function loadPersistedProtocol(): Protocol {
  const v = localStorage.getItem(LS_PROTOCOL)
  return v === "anthropic" || v === "gemini" ? v : "openai"
}

interface Message {
  role: Role
  /** Flattened text — display fallback, copy button, empty-bubble checks. */
  text: string
  /** Ordered content as typed in the composer. Absent on assistant messages. */
  parts?: Part[]
  usage?: StreamUsage
  durationMs?: number
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
}

/** A message as the protocol serializers see it. */
function messageParts(m: Message): Part[] {
  if (m.parts) return m.parts
  return m.text ? [{ type: "text", text: m.text }] : []
}

interface WebSearchEntry {
  /** Stable ID — upstream item_id, or fallback synthetic if missing. */
  id: string
  status: "in_progress" | "searching" | "completed"
  query?: string
}

/**
 * How many `pause_turn` continuations the playground will drive before giving
 * up. The gateway already caps how many searches one turn may run; this only
 * stops a pathological ping-pong from looping forever in the browser.
 */
const MAX_PAUSE_TURNS = 8

/**
 * How many sources stay visible before the rest fold behind "more…". A
 * research-style turn can ground itself in twenty links, and the full list
 * pushes the answer it belongs to off the screen — the sources end up more
 * prominent than the text they support. Three is enough to show what kind of
 * material was used; the rest is there for anyone who wants to audit it.
 */
const COLLAPSED_SOURCE_COUNT = 3

/** Fallback label for a source with no title. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

interface Props {
  modelId: string
  apiKey: string
  systemPrompt: string
  webSearchEnabled: boolean
  /** Whether this model takes images — see `vision.ts`. Advisory only. */
  vision: VisionSupport
  /**
   * The model's own context ceiling, so the thread's token count can be read
   * as headroom rather than as a bare number. Undefined when the models
   * endpoint reports no limit — the readout then falls back to the count alone
   * rather than inventing a denominator.
   */
  contextWindow?: number
  /**
   * The full model list, flattened for the fullscreen picker. Fullscreen turns
   * this panel into an overlay that covers the sidebar, so without a picker of
   * its own the only way to change model is to leave fullscreen first.
   */
  modelOptions: SelectOption[]
  onPickModel: (id: string) => void
  /**
   * `image` swaps the three chat protocols for the /v1/images endpoints.
   * Undefined while the model list is still loading — sending in that window
   * would have to guess, and guessing wrong routes an image model at the chat
   * endpoints.
   */
  mode: PlaygroundMode | undefined
  imageParams: ImageParams
  onImageParamsChange: (next: ImageParams) => void
}

/**
 * Web search is requested through each protocol's *hosted* search shape, not
 * as a client function tool. The playground is an ordinary client: the gateway
 * runs the search server-side (where the search credentials live — they must
 * never reach the browser) and the tool schema the model sees is the gateway's
 * business, not ours. Declaring a `web_search` function tool here would mean
 * claiming we execute it, which we can't.
 */

/**
 * Prepend the user's current local time to the system prompt so models can
 * resolve "now / today / recent / yesterday" without ambiguity. Browser-side
 * only — no server tool, no extra round-trip. Re-evaluated on every send so
 * long-running sessions don't drift.
 */
function buildTimeContext(): string {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const local = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(now)
  return `Current time: ${now.toISOString()} (${local}, timezone ${tz}).`
}

function composeSystemPrompt(userPrompt: string): string {
  const timeLine = buildTimeContext()
  const trimmed = userPrompt.trim()
  return trimmed ? `${timeLine}\n\n${trimmed}` : timeLine
}

export function ChatPanel({ modelId, apiKey, systemPrompt, webSearchEnabled, vision, contextWindow, modelOptions, onPickModel, mode, imageParams, onImageParamsChange }: Props) {
  const t = useT()
  const [protocol, setProtocol] = useState<Protocol>(() => loadPersistedProtocol())
  const [messages, setMessages] = useState<Message[]>(() => loadPersistedMessages())
  const [isEmpty, setIsEmpty] = useState(true)
  /** Composer holds at least one image → an image-model send becomes an edit. */
  const [hasReference, setHasReference] = useState(false)
  const [imageError, setImageError] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  /**
   * Which assistant turns have their source list expanded, by message index.
   * Index is what the rest of this component already keys per-message UI on
   * (see `copiedIdx`), so anything that renumbers messages — clearing,
   * switching models, compacting — resets this alongside them.
   */
  const [expandedSources, setExpandedSources] = useState<ReadonlySet<number>>(() => new Set())
  const [fullscreen, setFullscreen] = useState(initialFullscreen)
  /** Data URL of the image shown in the zoom overlay, or null when closed. */
  const [zoomed, setZoomed] = useState<string | null>(null)
  /** Timestamp the thread was opened with — names downloads consistently. */
  const openedAtRef = useRef<Date>(new Date())
  const abortRef = useRef<AbortController | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const threadObserverRef = useRef<ResizeObserver | null>(null)
  const lastUserRef = useRef<Message | null>(null)
  const startedAtRef = useRef<number>(0)

  useEffect(() => {
    localStorage.setItem(LS_PROTOCOL, protocol)
  }, [protocol])

  // Persist messages only between streams so we don't write on every delta.
  // The post-stream finalize update will re-trigger this with the final text.
  useEffect(() => {
    if (streaming) return
    try {
      const slice = messages.slice(-MAX_PERSISTED_MESSAGES).map(stripImageBytes)
      localStorage.setItem(LS_MESSAGES, JSON.stringify(slice))
    } catch {
      /* quota exceeded, ignore */
    }
  }, [messages, streaming])

  // Images live in IndexedDB, so a reloaded history arrives with ids but no
  // bytes. Fill them back in, adopt anything a previous release left inline,
  // and drop stored images the history no longer references.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const initial = messages
      const adopted = new Map<string, string>()
      for (const m of initial) {
        for (const p of m.parts ?? []) {
          if (p.type === "image" && p.dataUrl && !p.id && !adopted.has(p.dataUrl)) {
            adopted.set(p.dataUrl, await putImage(p.dataUrl))
          }
        }
      }
      const byId = await getImages(collectImageIds(initial))
      if (cancelled) return
      if (byId.size > 0 || adopted.size > 0) {
        setMessages((prev) => prev.map((m) => adoptImageIds(hydrateMessage(m, byId), adopted)))
      }
      await pruneImages([...collectImageIds(initial), ...adopted.values()])
    })().catch(() => {
      /* IndexedDB unavailable — images degrade to the placeholder chip */
    })
    return () => {
      cancelled = true
    }
    // Runs once: everything pasted later is already in memory and in the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Switching model or protocol keeps the thread. The history is stored
  // protocol-neutrally and re-encoded per send, so nothing about it belongs to
  // the model that produced it — and carrying a conversation across models is
  // most of what comparing them means. Clearing stays a deliberate act: the
  // topbar's own button, always one click away.
  useEffect(() => {
    // A failure belongs to the model that produced it, though.
    setError(null)
  }, [modelId, protocol])

  // —— Context token counting (Option D) ——
  // Calls /v1/messages/count_tokens after debounce so the topbar shows the
  // exact upstream token cost (matches what billing/limits will see).
  const [ctxTokens, setCtxTokens] = useState<number | null>(null)
  const [ctxCounting, setCtxCounting] = useState(false)
  const [compactNotice, setCompactNotice] = useState<string | null>(null)
  useEffect(() => {
    if (messages.length === 0) {
      setCtxTokens(0)
      return
    }
    if (streaming) return
    // Only count for a model we know is a chat model: images have no context,
    // and count_tokens 404s for them.
    if (mode !== "chat") return
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      void countContextTokens(messages, ctrl.signal)
    }, 400)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streaming, modelId, apiKey, systemPrompt, mode])

  async function countContextTokens(history: Message[], signal: AbortSignal) {
    const anMessages = toAnthropicMessages(history)
    const body: Record<string, unknown> = { model: modelId, messages: anMessages }
    body.system = composeSystemPrompt(systemPrompt)
    setCtxCounting(true)
    try {
      const resp = await fetch("/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
        signal,
      })
      if (!resp.ok) return
      const j = await resp.json() as { input_tokens?: number }
      if (typeof j.input_tokens === "number") setCtxTokens(j.input_tokens)
    } catch {
      /* aborted or network error — leave previous value */
    } finally {
      setCtxCounting(false)
    }
  }

  function toAnthropicMessages(history: Message[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const turn of toChatHistory(history)) {
      const content = toAnthropicContent(turn.parts, turn.role)
      if (typeof content === "string" && !content) continue
      out.push({ role: turn.role, content })
    }
    return out
  }

  function compact() {
    // Drop the oldest user+assistant pair(s). One click = up to 2 oldest turns
    // (4 messages) so the user can shrink large contexts quickly without
    // losing the most recent exchanges that carry conversational state.
    setMessages((prev) => {
      if (prev.length <= 2) return prev
      const dropCount = Math.min(4, prev.length - 2)
      // Always start drop from a user message so the surviving history stays
      // user→assistant aligned.
      let start = 0
      while (start < prev.length && prev[start]!.role !== "user") start++
      const next = [...prev.slice(0, start), ...prev.slice(start + dropCount)]
      const dropped = prev.length - next.length
      setCompactNotice(t("dash.playground.compacted", { n: Math.ceil(dropped / 2) }))
      // Compaction renumbers everything after the drop, so any expansion the
      // user had opened would land on a different turn than they opened it on.
      setExpandedSources(new Set())
      setTimeout(() => setCompactNotice(null), 3000)
      return next
    })
  }

  // —— Thread scrolling ——
  // Two behaviours, and the second one is "do nothing":
  //
  //   * reader is at the bottom → stay pinned there, so the growing answer
  //     pushes older content up and the bottom edge holds still;
  //   * reader has scrolled up    → never move them. The browser's own scroll
  //     anchoring keeps the viewport stable while content grows below the fold,
  //     but only as long as nothing scrolls programmatically.
  //
  // The pin is an instant `scrollTop` assignment, not `behavior: "smooth"`.
  // `messages` is re-set on every delta, so a smooth animation would be
  // restarted dozens of times a second toward a target that keeps moving — that
  // chase is what read as upward jitter.
  //
  // It is driven by a ResizeObserver rather than a `messages` effect because
  // height changes that no state update accompanies — an image finishing its
  // decode, a code block laying out — have to keep the thread pinned too.

  const stickToBottomRef = useRef(true)

  function pinToBottom() {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }

  function onThreadScroll(e: React.UIEvent<HTMLDivElement>) {
    // Our own `scrollTop` write re-enters here; it lands at the bottom, so the
    // flag simply stays true and there is no feedback loop.
    stickToBottomRef.current = isAtBottom(e.currentTarget)
  }

  const observeThread = useCallback((node: HTMLDivElement | null) => {
    threadObserverRef.current?.disconnect()
    threadObserverRef.current = null
    if (!node) return
    const observer = new ResizeObserver(pinToBottom)
    observer.observe(node)
    threadObserverRef.current = observer
    pinToBottom()
    // `pinToBottom` reads refs only, so this callback stays stable and the
    // observer is not torn down and rebuilt on every render.
  }, [])

  useEffect(() => () => threadObserverRef.current?.disconnect(), [])

  // —— Composer (contenteditable) ——
  // React can't control a contenteditable without fighting the caret, so the
  // editor is uncontrolled: the DOM is the source of truth and we only mirror
  // an "is empty" flag out of it for the placeholder and the send button.

  function readParts(): Part[] {
    const el = editorRef.current
    return el ? domToParts(el) : []
  }

  function syncEmpty() {
    const parts = readParts()
    setIsEmpty(parts.length === 0)
    setHasReference(parts.some((p) => p.type === "image" && !!p.dataUrl))
  }

  function clearEditor() {
    if (editorRef.current) editorRef.current.innerHTML = ""
    setIsEmpty(true)
    setHasReference(false)
  }

  /** Focus the editor, putting the caret at the end if it isn't already inside. */
  function ensureCaretInEditor() {
    const el = editorRef.current
    if (!el) return
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      el.focus()
      return
    }
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  function setEditorText(s: string) {
    const el = editorRef.current
    if (!el) return
    el.textContent = s
    setIsEmpty(s.trim() === "")
    ensureCaretInEditor()
  }

  // `execCommand` is deprecated but universally implemented, and it is the only
  // insertion API that keeps the browser's native undo stack intact.
  function insertText(s: string) {
    ensureCaretInEditor()
    document.execCommand("insertText", false, s)
    syncEmpty()
  }

  function insertImage(dataUrl: string, id: string) {
    ensureCaretInEditor()
    // Safe to build by concatenation: base64 data URLs contain no `"` or `<`,
    // and the id is our own hex hash.
    document.execCommand(
      "insertHTML",
      false,
      `<img src="${dataUrl}" data-img-id="${id}" class="pg-inline-img" alt="">`,
    )
    syncEmpty()
  }

  /** The single funnel for paste, drop and the 📎 picker. */
  async function insertFiles(files: File[]) {
    setImageError("")
    for (const f of files) {
      try {
        const dataUrl = await fileToDataUrl(f)
        // Store before inserting so the id travels with the image from the
        // first render — a message sent immediately still persists its bytes.
        insertImage(dataUrl, await putImage(dataUrl))
      } catch (err) {
        setImageError(
          err instanceof ImageTooLargeError
            ? t("dash.playground.imageTooLarge")
            : String((err as Error).message),
        )
      }
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const dt = e.clipboardData
    // clipboardData is invalidated the moment we await, so drain it first.
    const files: File[] = []
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    e.preventDefault()
    if (files.length > 0) {
      await insertFiles(files)
      return
    }
    // Paste as plain text — pasted HTML would drag foreign markup and inline
    // styles into the composer, and `domToParts` would have to survive them.
    insertText(dt.getData("text/plain"))
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) e.preventDefault()
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))
    if (files.length === 0) return
    e.preventDefault()
    // Drop where the pointer is, not where the caret happened to be.
    const caretFrom = (document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }).caretRangeFromPoint
    const range = caretFrom?.call(document, e.clientX, e.clientY)
    if (range && editorRef.current?.contains(range.commonAncestorContainer)) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    await insertFiles(files)
  }

  /**
   * Puts one specific thread image into the composer. Sends already inherit the
   * newest image automatically; this is the override for reaching back past it.
   */
  async function insertAsReference(part: Part) {
    if (part.type !== "image" || !part.dataUrl) return
    insertImage(part.dataUrl, part.id ?? await putImage(part.dataUrl))
    editorRef.current?.focus()
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    // Reset first so picking the same file twice in a row still fires onChange.
    e.target.value = ""
    if (files.length > 0) await insertFiles(files)
  }

  function toggleSources(idx: number) {
    setExpandedSources((prev) => {
      const next = new Set(prev)
      // `delete` reports whether it removed anything, which is the toggle.
      if (!next.delete(idx)) next.add(idx)
      return next
    })
  }

  function clear() {
    abortRef.current?.abort()
    setMessages([])
    setExpandedSources(new Set())
    setError(null)
  }

  /**
   * Take back a user turn: the thread rewinds to just before it, and its
   * content goes back into the composer so a typo can be fixed and re-sent.
   *
   * Everything after the retracted turn goes too. A mistyped question doesn't
   * only produce one bad answer — it stays in the history and every later turn
   * is answered in light of it, so leaving the tail behind would keep exactly
   * the contamination this is meant to undo.
   */
  async function retract(index: number, parts: Part[]) {
    // The reply being retracted may still be arriving.
    abortRef.current?.abort()
    setMessages((prev) => retractFrom(prev, index))
    setExpandedSources((prev) => pruneIndexedState(prev, index))
    setError(null)
    clearEditor()
    for (const p of parts) {
      if (p.type === "text") insertText(p.text)
      else if (p.dataUrl) insertImage(p.dataUrl, p.id ?? (await putImage(p.dataUrl)))
    }
    syncEmpty()
  }

  const send = useCallback(
    async (override?: Part[]) => {
      const parts = override ?? readParts()
      if (parts.length === 0 || mode === undefined) return
      const userMsg: Message = { role: "user", text: partsToText(parts), parts }
      lastUserRef.current = userMsg
      // Sending is an explicit "show me the answer", so re-arm the pin even if
      // the reader had scrolled up to review something before typing.
      stickToBottomRef.current = true
      const nextHistory = [...messages, userMsg]
      // Stamped now, not at render time: the panel's model can change while
      // this reply is still streaming, and the badge must keep naming whoever
      // actually produced the text.
      const model = modelOptions.find((o) => o.value === modelId)?.label ?? modelId
      setMessages([...nextHistory, { role: "assistant", text: "", model }])
      if (override === undefined) clearEditor()
      setImageError("")
      setError(null)
      setStreaming(true)
      startedAtRef.current = performance.now()

      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        if (mode === "image") {
          await sendImages(nextHistory, ctrl.signal)
        } else if (protocol === "openai") {
          await sendOpenAI(nextHistory, ctrl.signal)
        } else if (protocol === "anthropic") {
          await sendAnthropic(nextHistory, ctrl.signal)
        } else {
          await sendGemini(nextHistory, ctrl.signal)
        }
        finalizeLast()
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          finalizeLast()
        } else {
          // Pop the empty assistant bubble; show error in dedicated banner
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.role === "assistant" && !last.text && !last.parts?.length) {
              return prev.slice(0, -1)
            }
            return prev
          })
          const raw = (err as Error).message
          setError(isImageRejection(raw) ? t("dash.playground.visionRejected") : raw)
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, protocol, modelId, apiKey, systemPrompt, webSearchEnabled, mode, imageParams, modelOptions],
  )

  function retry() {
    const last = lastUserRef.current
    if (!last) return
    // Drop the last user message we're about to re-send (we re-add it inside send())
    setMessages((prev) => {
      let cut = prev.length
      while (cut > 0 && prev[cut - 1]!.role !== "user") cut--
      if (cut > 0) cut--
      return prev.slice(0, cut)
    })
    setError(null)
    // Defer to next tick so messages state is committed
    setTimeout(() => send(messageParts(last)), 0)
  }

  function finalizeLast() {
    const ms = Math.round(performance.now() - startedAtRef.current)
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== "assistant") return prev
      const updated: Message = { ...last, durationMs: ms }
      return [...prev.slice(0, -1), updated]
    })
  }

  function appendAssistant(chunk: string) {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      if (!last || last.role !== "assistant") return prev
      const updated: Message = { ...last, text: last.text + chunk }
      return [...prev.slice(0, -1), updated]
    })
  }

  function setLastUsage(usage: StreamUsage) {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== "assistant") return prev
      return [...prev.slice(0, -1), { ...last, usage }]
    })
  }

  function applyWebSearchProgress(progress: WebSearchProgress) {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== "assistant") return prev
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
      return [...prev.slice(0, -1), { ...last, webSearches: next }]
    })
  }

  /** Merge in newly cited sources, keeping arrival order and one entry per URL. */
  function applyCitations(citations: Citation[]) {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== "assistant") return prev
      const seen = new Map<string, Citation>()
      for (const c of [...(last.citations ?? []), ...citations]) {
        if (!seen.has(c.url)) seen.set(c.url, c)
      }
      return [...prev.slice(0, -1), { ...last, citations: [...seen.values()] }]
    })
  }

  /**
   * Image models take a prompt, not a conversation. References pasted into the
   * composer turn the call into an edit — same one funnel, so a screenshot you
   * paste is the image you edit.
   */
  async function sendImages(history: Message[], signal: AbortSignal) {
    const { prompt, refs } = buildImageContext(history)
    const editing = refs.length > 0

    const resp = editing
      ? await fetch("/v1/images/edits", {
          method: "POST",
          headers: { "x-api-key": apiKey },
          body: buildEditsForm(modelId, prompt, imageParams, refs),
          signal,
        })
      : await fetch("/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify(buildGenerationsBody(modelId, prompt, imageParams)),
          signal,
        })

    const text = await resp.text()
    if (!resp.ok) throw new Error(imagesErrorMessage(text) || `HTTP ${resp.status}`)

    const { parts: result, usage } = parseImagesResponse(JSON.parse(text))
    // Store the bytes the same way pasted images are stored, so a reload
    // rehydrates generated images from IndexedDB instead of a placeholder.
    const stored: Part[] = []
    for (const p of result) {
      if (p.type !== "image") continue
      stored.push(p.dataUrl.startsWith("data:")
        ? { type: "image", dataUrl: p.dataUrl, id: await putImage(p.dataUrl) }
        : p)
    }
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== "assistant") return prev
      return [...prev.slice(0, -1), { ...last, parts: stored, ...(usage ? { usage } : {}) }]
    })
  }

  async function sendOpenAI(history: Message[], signal: AbortSignal) {
    const oaiMessages: Array<Record<string, unknown>> = []
    oaiMessages.push({ role: "system", content: composeSystemPrompt(systemPrompt) })
    for (const turn of toChatHistory(history)) {
      const content = toOpenAIContent(turn.parts, turn.role)
      if (typeof content === "string" && !content) continue
      oaiMessages.push({ role: turn.role, content })
    }
    const resp = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        model: modelId,
        messages: oaiMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(webSearchEnabled ? { web_search_options: {} } : {}),
      }),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "")
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    for await (const ch of parseOpenAIStream(resp.body)) {
      if (ch.type === "delta") {
        appendAssistant(ch.text)
        await new Promise<void>((r) => setTimeout(r, 0))
      } else if (ch.type === "web_search") applyWebSearchProgress(ch.progress)
      else if (ch.type === "citations") applyCitations(ch.citations)
      else setLastUsage(ch.usage)
    }
  }

  async function sendAnthropic(history: Message[], signal: AbortSignal) {
    const anMessages = toAnthropicMessages(history)
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: 4096,
      messages: anMessages,
      stream: true,
    }
    body.system = composeSystemPrompt(systemPrompt)
    if (webSearchEnabled) {
      body.tools = [{ type: "web_search_20250305", name: "web_search" }]
    }

    // A hosted search ends the turn with `pause_turn` and no answer text: the
    // gateway ran the search, and the client owns the decision to continue.
    // Replay the assistant blocks verbatim until the model actually answers.
    for (let turn = 0; turn < MAX_PAUSE_TURNS; turn++) {
      const paused = await streamAnthropicTurn(body, signal)
      if (!paused) return
      anMessages.push({ role: "assistant", content: paused })
    }
  }

  /** One `/v1/messages` round trip. Returns the assistant blocks if it paused. */
  async function streamAnthropicTurn(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown[] | null> {
    const resp = await fetch("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "")
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    for await (const ch of parseAnthropicStream(resp.body)) {
      if (ch.type === "delta") {
        appendAssistant(ch.text)
        await new Promise<void>((r) => setTimeout(r, 0))
      } else if (ch.type === "usage") setLastUsage(ch.usage)
      else if (ch.type === "web_search") applyWebSearchProgress(ch.progress)
      else if (ch.type === "citations") applyCitations(ch.citations)
      else if (ch.type === "pause_turn") return ch.content
    }
    return null
  }

  async function sendGemini(history: Message[], signal: AbortSignal) {
    const contents: Array<Record<string, unknown>> = []
    for (const turn of toChatHistory(history)) {
      const parts = toGeminiParts(turn.parts, turn.role)
      if (parts.length === 0) continue
      contents.push({ role: turn.role === "assistant" ? "model" : "user", parts })
    }
    const body: Record<string, unknown> = { contents }
    body.systemInstruction = { parts: [{ text: composeSystemPrompt(systemPrompt) }] }
    if (webSearchEnabled) {
      body.tools = [{ googleSearch: {} }]
    }
    const resp = await fetch(
      `/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal,
      },
    )
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "")
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    for await (const ch of parseGeminiStream(resp.body)) {
      if (ch.type === "delta") {
        appendAssistant(ch.text)
        await new Promise<void>((r) => setTimeout(r, 0))
      } else if (ch.type === "usage") setLastUsage(ch.usage)
      else if (ch.type === "web_search") applyWebSearchProgress(ch.progress)
      else if (ch.type === "citations") applyCitations(ch.citations)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (e.shiftKey) {
      // Force a predictable `<br>` — left to itself the browser may split the
      // line into a wrapper element instead, which `domToParts` also handles
      // but which makes the DOM harder to reason about.
      document.execCommand("insertLineBreak")
      syncEmpty()
      return
    }
    // Typing during a stream is fine; sending is not. The next turn has to be
    // built on a finished reply, so Enter waits until the stream ends or the
    // stop button cuts it short — the draft sits in the composer meanwhile.
    if (!streaming) void send()
  }

  /**
   * In the composer a single click has to stay the native "select this image"
   * gesture — that's how you delete one — so zooming is on double click. In the
   * thread there is nothing to select, so a single click is enough (see JSX).
   */
  function onEditorDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement
    if (el.tagName === "IMG") setZoomed((el as HTMLImageElement).src)
  }

  useEffect(() => {
    if (!zoomed) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null)
    }
    window.addEventListener("keydown", onEsc)
    return () => window.removeEventListener("keydown", onEsc)
  }, [zoomed])

  async function onCopy(idx: number, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1200)
    } catch {
      /* clipboard denied, ignore */
    }
  }

  // Esc exits fullscreen
  useEffect(() => {
    if (!fullscreen) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      // An open dropdown owns this Escape. Both listeners sit on document, so
      // without the check one press would close the dropdown *and* drop out of
      // fullscreen — two undos for one keystroke.
      if (document.querySelector("[data-select-open]")) return
      setFullscreen(false)
    }
    document.addEventListener("keydown", onKey)
    // Lock body scroll while in fullscreen so the overlay doesn't allow the
    // page beneath to scroll.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [fullscreen])

  // Remember the frame for the next reload, and spend the landing so that
  // moving to another tab and back within this page load opens windowed —
  // that return is a navigation, not a resume.
  useEffect(() => {
    persistFullscreen(fullscreen)
  }, [fullscreen])
  useEffect(spendLanded, [])

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col min-h-0 pg-chat-surface pg-fullscreen bg-surface-900"
          : "flex flex-col h-full min-h-0 pg-chat-surface"
      }
    >
      <div className="pg-topbar">
        {/*
          Only in fullscreen: everywhere else the sidebar list is the picker,
          and a second control for the same thing would just be one more place
          for the two to disagree.
        */}
        {fullscreen && modelOptions.length > 0 && (
          <Select
            value={modelId}
            options={modelOptions}
            onChange={onPickModel}
            className="pg-fs-model"
          />
        )}

        {mode === "image" && (
          <ImageParamsBar
            params={imageParams}
            onChange={onImageParamsChange}
            editing={hasReference || buildImageContext(messages).refs.length > 0}
            disabled={streaming}
          />
        )}
        {mode === "chat" && (
          <span className="text-themed-dim">{t("dash.playground.protocol")}:</span>
        )}
        <div className={"flex items-center gap-1 bg-surface-800 rounded-lg p-0.5" + (mode === "chat" ? "" : " hidden")}>
          {(["openai", "anthropic", "gemini"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProtocol(p)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                protocol === p
                  ? "bg-surface-600 text-themed"
                  : "text-themed-dim hover:text-themed-secondary"
              }`}
            >
              {p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "Gemini"}
            </button>
          ))}
        </div>
        {mode === "chat" && (
        <span
          className={"pg-vision pg-vision-" + vision}
          title={t(
            vision === "yes" ? "dash.playground.visionYesHint"
              : vision === "unknown" ? "dash.playground.visionUnknownHint"
                : "dash.playground.visionNoHint",
          )}
        >
          {vision === "yes" ? "🖼" : vision === "unknown" ? "🖼?" : "🚫🖼"}
          <span className="pg-vision-label">
            {t(
              vision === "yes" ? "dash.playground.visionYes"
                : vision === "unknown" ? "dash.playground.visionUnknown"
                  : "dash.playground.visionNo",
            )}
          </span>
        </span>
        )}
        {streaming && (
          <span className="text-themed-dim flex items-center gap-2 ml-2">
            <span className="pg-dots"><span/><span/><span/></span>
            {t("dash.playground.generating")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {mode === "chat" && messages.length > 0 && (() => {
            if (ctxCounting) {
              return (
                <span className="text-themed-dim text-xs mr-2 font-mono">
                  {t("dash.playground.ctxCounting")}
                </span>
              )
            }
            // No count yet, or no ceiling reported: show what we have rather
            // than a made-up denominator.
            if (ctxTokens == null || !contextWindow) {
              return (
                <span className="text-themed-dim text-xs mr-2 font-mono">
                  {t("dash.playground.ctxTokens", { n: ctxTokens ?? "—" })}
                </span>
              )
            }
            const pressure = contextPressure(ctxTokens, contextWindow)
            return (
              <span
                className={"text-xs mr-2 font-mono pg-ctx pg-ctx-" + pressure}
                title={t("dash.playground.ctxTitle", {
                  left: Math.max(0, contextWindow - ctxTokens),
                })}
              >
                {t("dash.playground.ctxTokensOf", {
                  n: ctxTokens,
                  limit: formatTokens(contextWindow),
                  pct: contextPercent(ctxTokens, contextWindow),
                })}
              </span>
            )
          })()}
          {messages.length >= 4 && (
            <button
              onClick={compact}
              disabled={streaming}
              title={t("dash.playground.compactTitle")}
              className="px-3 py-1 rounded-md text-xs font-medium bg-surface-800 text-themed-secondary hover:text-themed transition-all disabled:opacity-50"
            >
              {t("dash.playground.compact")}
            </button>
          )}
          {streaming && (
            <button
              onClick={() => abortRef.current?.abort()}
              className="px-3 py-1 rounded-md text-xs font-medium bg-surface-800 text-themed-secondary hover:text-themed transition-all"
            >
              {t("dash.playground.stop")}
            </button>
          )}
          <button
            onClick={clear}
            className="px-3 py-1 rounded-md text-xs font-medium bg-surface-800 text-themed-secondary hover:text-themed transition-all"
          >
            {t("dash.playground.clear")}
          </button>
          <button
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? t("dash.playground.exitFullscreen") : t("dash.playground.fullscreen")}
            className="px-2 py-1 rounded-md text-xs font-medium bg-surface-800 text-themed-secondary hover:text-themed transition-all"
          >
            {fullscreen ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            )}
          </button>
        </div>
      </div>

      <div ref={scrollRef} onScroll={onThreadScroll} className="flex-1 min-h-0 overflow-auto">
        {messages.length === 0 && !error ? (
          <div className="pg-empty">
            <div className="pg-empty-title">{t("dash.playground.emptyHint")}</div>
            <div className="pg-empty-model">{modelId}</div>
            <div className="pg-empty-suggestions">
              <button className="pg-suggestion" onClick={() => setEditorText("Explain how SSE streaming works in 3 sentences.")}>
                💡 Explain how SSE streaming works
              </button>
              <button className="pg-suggestion" onClick={() => setEditorText("Write a TypeScript function that debounces an async call.")}>
                ⚡ Write a debounce function in TS
              </button>
              <button className="pg-suggestion" onClick={() => setEditorText("Hi! Introduce yourself in one sentence.")}>
                👋 Say hi
              </button>
            </div>
          </div>
        ) : (
          <div ref={observeThread} className="pg-thread">
            {messages.map((m, i) => {
              const isAssistant = m.role === "assistant"
              const isLast = i === messages.length - 1
              const showDots = isAssistant && streaming && isLast && !m.text
              return (
                <div key={i} className={"pg-row " + (m.role === "user" ? "pg-row-user" : "")}>
                  {isAssistant && <div className="pg-avatar">{avatarLabel(m.model)}</div>}
                  {!isAssistant && (
                    <button
                      className="pg-retract"
                      title={t("dash.playground.retractTitle")}
                      aria-label={t("dash.playground.retract")}
                      onClick={() => void retract(i, messageParts(m))}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>
                    </button>
                  )}
                  <div className={"pg-bubble " + (m.role === "user" ? "pg-bubble-user" : "pg-bubble-assistant")}>
                    {showDots ? (
                      <span className="pg-dots text-themed-dim"><span/><span/><span/></span>
                    ) : m.parts ? (
                      <div className="whitespace-pre-wrap">
                        {m.parts.map((p, pi) =>
                          p.type === "text" ? (
                            <span key={pi}>{p.text}</span>
                          ) : p.dataUrl ? (
                            <span key={pi} className="pg-img-wrap">
                              <img
                                src={p.dataUrl}
                                alt=""
                                className={"pg-zoomable " + (isAssistant ? "pg-gen-img" : "pg-inline-img")}
                                onClick={() => setZoomed(p.dataUrl)}
                                title={t("dash.playground.zoomImage")}
                              />
                              {mode === "image" && (
                                <button
                                  className="pg-img-ref"
                                  title={t("dash.playground.useAsReference")}
                                  onClick={() => void insertAsReference(p)}
                                >
                                  ✎
                                </button>
                              )}
                              <button
                                className="pg-img-save"
                                title={t("dash.playground.download")}
                                onClick={() => void downloadImage(
                                  p.dataUrl,
                                  imageFilename(p.dataUrl, openedAtRef.current, pi),
                                )}
                              >
                                ⬇
                              </button>
                            </span>
                          ) : (
                            // The bytes are gone from the store — the position
                            // survives so the message still reads correctly.
                            <span
                              key={pi}
                              className="pg-img-placeholder"
                              title={t("dash.playground.imagePlaceholder")}
                            >
                              🖼
                            </span>
                          ),
                        )}
                      </div>
                    ) : isAssistant ? (
                      <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                    ) : (
                      <div className="whitespace-pre-wrap">{m.text}</div>
                    )}
                    {isAssistant && m.webSearches && m.webSearches.length > 0 && (
                      <div className="pg-tool-list">
                        {m.webSearches.map((w) => (
                          <div key={w.id} className={"pg-tool pg-tool-" + w.status}>
                            <span className="pg-tool-icon">🔎</span>
                            <span className="pg-tool-label">
                              {w.status === "completed" ? "Searched" : w.status === "searching" ? "Searching" : "Preparing search"}
                            </span>
                            {w.query && <span className="pg-tool-query">"{w.query}"</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {isAssistant && m.citations && m.citations.length > 0 && (() => {
                      const all = m.citations
                      const expanded = expandedSources.has(i)
                      const hidden = all.length - COLLAPSED_SOURCE_COUNT
                      const shown = expanded ? all : all.slice(0, COLLAPSED_SOURCE_COUNT)
                      return (
                        <div className="pg-tool-list">
                          {shown.map((c, ci) => (
                            <a
                              key={c.url}
                              className="pg-tool pg-tool-completed"
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <span className="pg-tool-icon">{ci + 1}</span>
                              <span className="pg-tool-label">{c.title || hostOf(c.url)}</span>
                            </a>
                          ))}
                          {hidden > 0 && (
                            <button
                              className="pg-tool pg-tool-more"
                              onClick={() => toggleSources(i)}
                              aria-expanded={expanded}
                            >
                              <span className="pg-tool-icon">{expanded ? "▴" : "▾"}</span>
                              <span className="pg-tool-label">
                                {expanded
                                  ? t("dash.playground.sourcesFewer")
                                  : t("dash.playground.sourcesMore", { n: hidden })}
                              </span>
                            </button>
                          )}
                        </div>
                      )
                    })()}
                    {isAssistant && (m.text || m.usage || m.durationMs != null) && (
                      <div className="pg-bubble-meta">
                        {(m.usage || m.durationMs != null) &&
                          t("dash.playground.usage", {
                            tin: m.usage?.input_tokens ?? "—",
                            tout: m.usage?.output_tokens ?? "—",
                            ms: m.durationMs ?? "—",
                          })}
                        {m.text && (
                          <button
                            className="pg-copy"
                            onClick={() => onCopy(i, m.text)}
                            title={t("dash.playground.copy")}
                          >
                            {copiedIdx === i ? t("dash.playground.copied") : t("dash.playground.copy")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {compactNotice && (
        <div className="pg-confirm">
          <span>✂ {compactNotice}</span>
        </div>
      )}

      {error && (
        <div className="pg-error">
          <span>⚠ {error}</span>
          <button className="btn-ghost !py-1 !px-3 !text-xs ml-auto" onClick={retry}>{t("dash.playground.retry")}</button>
        </div>
      )}

      <div className="pg-composer-wrap">
        <div className="pg-composer">
          <div
            ref={editorRef}
            className="pg-input"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            data-placeholder={t("dash.playground.messagePlaceholder")}
            data-empty={isEmpty ? "true" : undefined}
            onInput={syncEmpty}
            onKeyDown={onKeyDown}
            onDoubleClick={onEditorDoubleClick}
            onPaste={(e) => void onPaste(e)}
            onDragOver={onDragOver}
            onDrop={(e) => void onDrop(e)}
          />
          <div className="pg-composer-actions">
            <label
              className={"pg-icon-btn" + (vision === "no" || vision === "yes-but-rejected" ? " pg-icon-btn-warn" : "")}
              title={t(vision === "yes" || vision === "unknown"
                ? "dash.playground.imageFile"
                : "dash.playground.visionNoHint")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8L9.4 17.36a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onPickFile(e)} />
            </label>
            {/* One button, two jobs. While a reply streams the only thing this
                corner can usefully do is stop it — and putting stop where the
                hand already is beats making the user find it in the topbar.
                Composing stays open throughout; it's *sending* that waits. */}
            <button
              onClick={() => {
                if (streaming) abortRef.current?.abort()
                else void send()
              }}
              disabled={!streaming && (isEmpty || mode === undefined)}
              className={"pg-send-btn" + (streaming ? " pg-send-btn-stop" : "")}
              title={streaming ? t("dash.playground.stop") : t("dash.playground.send")}
              aria-label={streaming ? t("dash.playground.stop") : t("dash.playground.send")}
            >
              {streaming ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              )}
            </button>
          </div>
        </div>
        {imageError && <div className="text-xs text-accent-red mt-2 text-center">{imageError}</div>}
      </div>

      {zoomed && (
        <div className="pg-zoom-overlay" onClick={() => setZoomed(null)} role="presentation">
          <img src={zoomed} alt="" className="pg-zoom-img" />
          <button
            className="pg-zoom-save"
            title={t("dash.playground.download")}
            onClick={(e) => {
              // The overlay closes on click; saving shouldn't also dismiss it.
              e.stopPropagation()
              void downloadImage(zoomed, imageFilename(zoomed, openedAtRef.current, 0))
            }}
          >
            ⬇
          </button>
          <button className="pg-zoom-close" title={t("dash.playground.closeZoom")}>✕</button>
        </div>
      )}
    </div>
  )
}
