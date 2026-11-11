import { useCallback, useEffect, useRef, useState } from "react"
import { Scissors } from "lucide-react"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import type { SelectOption } from "../../ui/select"
import type { ImageParams, PlaygroundMode } from "./images"
import { getImages, pruneImages, putImage } from "./image-store"
import { type Part, partsToText } from "./parts"
import type { AssistantOutput } from "./assistant-output"
import { isImageRejection, type VisionSupport } from "./vision"
import { collectImageIds, adoptImageIds, hydrateMessage, stripImageBytes } from "./persistence"
import type { Citation, StreamUsage, WebSearchProgress } from "./streams/openai"
import { isAtBottom } from "./scroll"
import { escapeExitsFullscreen, initialFullscreen, persistFullscreen, spendLanded } from "./fullscreen"
import { pruneIndexedState, retractFrom } from "./retract"
import { BrowserPerformance, type BrowserPerformanceSnapshot } from "./browser-performance"
import {
  appendText, applyCitations, applyWebSearchProgress, compactMessages, dropEmptyAssistant, dropLastUserTurn,
  finalizeLast as finalizeLastMessage, loadPersistedMessages, loadPersistedProtocol, messageParts,
  setLastImages, setLastOutput, setLastUsage, toggleIndex,
  LS_MESSAGES, LS_PROTOCOL, MAX_PERSISTED_MESSAGES, type Message, type Protocol,
} from "./chat/chat-state"
import {
  countContextTokens as fetchContextTokens, sendAnthropic, sendGemini, sendImages, sendOpenAI,
  type ChatSink, type SendSettings,
} from "./chat/chat-send"
import { useComposer } from "./chat/useComposer"
import { ChatTopbar } from "./chat/ChatTopbar"
import { ChatEmpty } from "./chat/ChatEmpty"
import { ChatThread } from "./chat/ChatThread"
import { ChatComposer } from "./chat/ChatComposer"
import { ImageZoom } from "./chat/ImageZoom"

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
   * endpoints. Embedding and decision models never reach this panel; they
   * have panels of their own.
   */
  mode: Extract<PlaygroundMode, "chat" | "image"> | undefined
  imageParams: ImageParams
  onImageParamsChange: (next: ImageParams) => void
}

export function ChatPanel({ modelId, apiKey, systemPrompt, webSearchEnabled, vision, contextWindow, modelOptions, onPickModel, mode, imageParams, onImageParamsChange }: Props) {
  const t = useT()
  const [protocol, setProtocol] = useState<Protocol>(() => loadPersistedProtocol())
  const [messages, setMessages] = useState<Message[]>(() => loadPersistedMessages())
  const composer = useComposer(t)
  const {
    editorRef, isEmpty, hasReference, imageError, setImageError,
    readParts, syncEmpty, clearEditor, setEditorText, insertText, insertImage, insertAsReference,
  } = composer
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
    setCtxCounting(true)
    try {
      const n = await fetchContextTokens(history, { modelId, apiKey, systemPrompt }, signal)
      if (n !== undefined) setCtxTokens(n)
    } finally {
      setCtxCounting(false)
    }
  }

  function compact() {
    setMessages((prev) => {
      const next = compactMessages(prev)
      if (!next) return prev
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

  function toggleSources(idx: number) {
    setExpandedSources((prev) => toggleIndex(prev, idx))
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

  // Each stream event lands on the trailing assistant turn.
  const sink: ChatSink = {
    appendText: (chunk: string) => setMessages((prev) => appendText(prev, chunk)),
    setUsage: (usage: StreamUsage) => setMessages((prev) => setLastUsage(prev, usage)),
    setOutput: (output: AssistantOutput) => setMessages((prev) => setLastOutput(prev, output)),
    webSearch: (progress: WebSearchProgress) => setMessages((prev) => applyWebSearchProgress(prev, progress)),
    citations: (citations: Citation[]) => setMessages((prev) => applyCitations(prev, citations)),
    setImages: (parts: Part[], usage: StreamUsage | undefined) => setMessages((prev) => setLastImages(prev, parts, usage)),
  }

  // The memo below is effectively per message (its deps change on every
  // delta), and `retry` reaches it through a `setTimeout` from the render the
  // retry was clicked in. Known bug carried over unchanged from before the
  // split: that `send` still sees the failed user turn in `messages`, and its
  // non-functional `setMessages([...messages, …])` overwrites retry's drop, so a
  // retry sends the user turn twice. Fix by passing an explicit base history.
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
      const observation = mode === "image" ? undefined : new BrowserPerformance()
      const settings: SendSettings = { modelId, apiKey, systemPrompt, webSearchEnabled, imageParams, t }

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const onAbort = () => { observation?.finish("cancelled") }
      ctrl.signal.addEventListener("abort", onAbort, { once: true })
      try {
        if (mode === "image") {
          await sendImages(nextHistory, ctrl.signal, settings, sink)
        } else if (protocol === "openai") {
          await sendOpenAI(nextHistory, ctrl.signal, observation!, settings, sink)
        } else if (protocol === "anthropic") {
          await sendAnthropic(nextHistory, ctrl.signal, observation!, settings, sink)
        } else {
          await sendGemini(nextHistory, ctrl.signal, observation!, settings, sink)
        }
        ctrl.signal.throwIfAborted()
        finalizeLast("success", observation)
      } catch (err) {
        if (ctrl.signal.aborted || (err as Error).name === "AbortError") {
          finalizeLast("cancelled", observation)
        } else {
          finalizeLast("error", observation)
          // Keep collected timings on failed chat turns; image errors use the banner.
          setMessages((prev) => (observation ? prev : dropEmptyAssistant(prev)))
          const raw = (err as Error).message
          setError(isImageRejection(raw) ? t("dash.playground.visionRejected") : raw)
        }
      } finally {
        ctrl.signal.removeEventListener("abort", onAbort)
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
    setMessages((prev) => dropLastUserTurn(prev))
    setError(null)
    // Defer to next tick so messages state is committed
    setTimeout(() => send(messageParts(last)), 0)
  }

  function finalizeLast(outcome: BrowserPerformanceSnapshot["outcome"], observation?: BrowserPerformance) {
    const snapshot = observation?.finish(outcome)
    const ms = Math.round(performance.now() - startedAtRef.current)
    setMessages((prev) => finalizeLastMessage(prev, ms, snapshot))
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

  async function onCopy(idx: number, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1200)
    } catch {
      /* clipboard denied, ignore */
    }
  }

  // Esc exits fullscreen — unless something above it (an open select, the
  // zoom dialog) takes this press; see `escapeExitsFullscreen`. Its own
  // effect so a zoom opening or closing re-binds only the key handler, not
  // the scroll lock below.
  useEffect(() => {
    if (!fullscreen) return
    const zoomOpen = zoomed !== null
    function onKey(e: KeyboardEvent) {
      if (escapeExitsFullscreen(e, zoomOpen)) setFullscreen(false)
    }
    // Bubble phase on document: Radix's capture-phase Esc handler has run by
    // now and marked the event if it closed a select or dialog.
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [fullscreen, zoomed])

  // Lock body scroll while in fullscreen so the overlay doesn't allow the
  // page beneath to scroll.
  useEffect(() => {
    if (!fullscreen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
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
          ? "fixed inset-0 z-50 flex flex-col min-h-0 pg-chat-surface pg-fullscreen bg-background"
          : "flex flex-col h-full min-h-0 pg-chat-surface"
      }
    >
      <ChatTopbar
        fullscreen={fullscreen}
        modelId={modelId}
        modelOptions={modelOptions}
        onPickModel={onPickModel}
        mode={mode}
        imageParams={imageParams}
        onImageParamsChange={onImageParamsChange}
        hasReference={hasReference}
        messages={messages}
        protocol={protocol}
        onProtocol={setProtocol}
        vision={vision}
        streaming={streaming}
        ctxCounting={ctxCounting}
        ctxTokens={ctxTokens}
        contextWindow={contextWindow}
        onCompact={compact}
        onStop={() => abortRef.current?.abort()}
        onClear={clear}
        onToggleFullscreen={() => setFullscreen((v) => !v)}
      />

      <div ref={scrollRef} onScroll={onThreadScroll} className="flex-1 min-h-0 overflow-auto">
        {messages.length === 0 && !error ? (
          <ChatEmpty modelId={modelId} onSuggest={setEditorText} />
        ) : (
          <ChatThread
            threadRef={observeThread}
            messages={messages}
            streaming={streaming}
            mode={mode}
            expandedSources={expandedSources}
            copiedIdx={copiedIdx}
            openedAt={openedAtRef.current}
            onRetract={(i, parts) => void retract(i, parts)}
            onZoom={setZoomed}
            onUseAsReference={(p) => void insertAsReference(p)}
            onToggleSources={toggleSources}
            onCopy={(i, text) => void onCopy(i, text)}
          />
        )}
      </div>

      {compactNotice && (
        <Notice role="status" className="mx-3 mb-2 flex items-center gap-2 text-xs">
          <Scissors className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{compactNotice}</span>
        </Notice>
      )}

      {error && (
        <Notice tone="danger" className="mx-3 mb-2 flex items-center gap-2">
          <span className="min-w-0 break-words">{error}</span>
          <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={retry}>{t("dash.playground.retry")}</Button>
        </Notice>
      )}

      <ChatComposer
        editorRef={editorRef}
        isEmpty={isEmpty}
        imageError={imageError}
        vision={vision}
        mode={mode}
        streaming={streaming}
        onInput={syncEmpty}
        onKeyDown={onKeyDown}
        onDoubleClick={onEditorDoubleClick}
        onPaste={composer.onPaste}
        onDragOver={composer.onDragOver}
        onDrop={composer.onDrop}
        onPickFile={composer.onPickFile}
        onSend={() => void send()}
        onStop={() => abortRef.current?.abort()}
      />

      {zoomed && <ImageZoom src={zoomed} openedAt={openedAtRef.current} onClose={() => setZoomed(null)} />}
    </div>
  )
}
