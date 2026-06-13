import { useCallback, useEffect, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { fileToDataUrl, ImageTooLargeError } from "./image"
import { parseOpenAIStream, type StreamUsage, type WebSearchProgress } from "./streams/openai"
import { parseAnthropicStream } from "./streams/anthropic"
import { parseGeminiStream } from "./streams/gemini"
import { renderMarkdown } from "./markdown"

type Protocol = "openai" | "anthropic" | "gemini"
type Role = "user" | "assistant"

const LS_PROTOCOL = "playground.protocol"
const LS_MESSAGES = "playground.messages"
const MAX_PERSISTED_MESSAGES = 50

function loadPersistedMessages(): Message[] {
  try {
    const raw = localStorage.getItem(LS_MESSAGES)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Message[]
    if (!Array.isArray(parsed)) return []
    // Drop any trailing streaming-in-progress assistant bubble that may have
    // been persisted without text (e.g. tab closed mid-stream).
    const last = parsed[parsed.length - 1]
    if (last && last.role === "assistant" && !last.text) parsed.pop()
    return parsed
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
  text: string
  imageUrl?: string
  usage?: StreamUsage
  durationMs?: number
  /** Web search progress events surfaced as inline bubbles. */
  webSearches?: WebSearchEntry[]
}

interface WebSearchEntry {
  /** Stable ID — upstream item_id, or fallback synthetic if missing. */
  id: string
  status: "in_progress" | "searching" | "completed"
  query?: string
}

interface Props {
  modelId: string
  apiKey: string
  systemPrompt: string
  webSearchEnabled: boolean
  onRevertModel?: (id: string) => void
}

const WEB_SEARCH_DESCRIPTION = "Search the web for current information. Use this when you need to find recent information, news, or answers to questions that require up-to-date knowledge."
const WEB_SEARCH_PARAMS = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query to execute" },
  },
  required: ["query"],
} as const

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

export function ChatPanel({ modelId, apiKey, systemPrompt, webSearchEnabled, onRevertModel }: Props) {
  const t = useT()
  const [protocol, setProtocol] = useState<Protocol>(() => loadPersistedProtocol())
  const [messages, setMessages] = useState<Message[]>(() => loadPersistedMessages())
  const [input, setInput] = useState("")
  const [imageUrl, setImageUrl] = useState("")
  const [imageDataUrl, setImageDataUrl] = useState("")
  const [imageError, setImageError] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastUserRef = useRef<Message | null>(null)
  const startedAtRef = useRef<number>(0)
  const lastDepsRef = useRef<{ modelId: string; protocol: Protocol }>({ modelId, protocol })

  useEffect(() => {
    localStorage.setItem(LS_PROTOCOL, protocol)
  }, [protocol])

  // Persist messages only between streams so we don't write on every delta.
  // The post-stream finalize update will re-trigger this with the final text.
  useEffect(() => {
    if (streaming) return
    try {
      const slice = messages.slice(-MAX_PERSISTED_MESSAGES)
      localStorage.setItem(LS_MESSAGES, JSON.stringify(slice))
    } catch {
      /* quota exceeded, ignore */
    }
  }, [messages, streaming])

  // Track model+protocol changes; if there are messages, surface inline confirm bar
  // rather than wiping silently.
  const [pendingDeps, setPendingDeps] = useState<{ modelId: string; protocol: Protocol } | null>(null)
  useEffect(() => {
    const prev = lastDepsRef.current
    if (prev.modelId === modelId && prev.protocol === protocol) return
    if (messages.length === 0) {
      lastDepsRef.current = { modelId, protocol }
      abortRef.current?.abort()
      setError(null)
      return
    }
    setPendingDeps({ modelId, protocol })
  }, [modelId, protocol, messages.length])

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
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      void countContextTokens(messages, ctrl.signal)
    }, 400)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streaming, modelId, apiKey, systemPrompt])

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
    for (const m of history) {
      if (!m.text && !m.imageUrl) continue
      if (m.imageUrl) {
        const parts: Array<Record<string, unknown>> = []
        if (m.text) parts.push({ type: "text", text: m.text })
        if (m.imageUrl.startsWith("data:")) {
          const comma = m.imageUrl.indexOf(",")
          const meta = m.imageUrl.slice(5, comma)
          const mime = meta.split(";")[0] || "image/png"
          const data = m.imageUrl.slice(comma + 1)
          parts.push({ type: "image", source: { type: "base64", media_type: mime, data } })
        } else {
          parts.push({ type: "image", source: { type: "url", url: m.imageUrl } })
        }
        out.push({ role: m.role, content: parts })
      } else {
        out.push({ role: m.role, content: m.text })
      }
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
      setTimeout(() => setCompactNotice(null), 3000)
      return next
    })
  }

  function confirmSwitch() {
    abortRef.current?.abort()
    setMessages([])
    setError(null)
    lastDepsRef.current = { modelId, protocol }
    setPendingDeps(null)
  }
  function cancelSwitch() {
    // Roll back parent's selection to the last accepted model so the topbar
    // and model list reflect that the switch was cancelled.
    const prev = lastDepsRef.current
    if (prev.modelId !== modelId) onRevertModel?.(prev.modelId)
    if (prev.protocol !== protocol) setProtocol(prev.protocol)
    setPendingDeps(null)
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setImageError("")
    const file = e.target.files?.[0]
    if (!file) {
      setImageDataUrl("")
      return
    }
    try {
      const url = await fileToDataUrl(file)
      setImageDataUrl(url)
      setImageUrl("")
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        setImageError(t("dash.playground.imageTooLarge"))
      } else {
        setImageError(String((err as Error).message))
      }
      setImageDataUrl("")
    }
  }

  function removeImage() {
    setImageDataUrl("")
    setImageUrl("")
    setImageError("")
  }

  function clear() {
    abortRef.current?.abort()
    setMessages([])
    setError(null)
  }

  const send = useCallback(
    async (overrideInput?: { text: string; image?: string }) => {
      const text = (overrideInput?.text ?? input).trim()
      const img = overrideInput?.image ?? (imageDataUrl || imageUrl.trim())
      if (!text && !img) return
      const userMsg: Message = { role: "user", text, imageUrl: img || undefined }
      lastUserRef.current = userMsg
      const nextHistory = [...messages, userMsg]
      setMessages([...nextHistory, { role: "assistant", text: "" }])
      if (overrideInput === undefined) {
        setInput("")
        setImageUrl("")
        setImageDataUrl("")
      }
      setImageError("")
      setError(null)
      setStreaming(true)
      startedAtRef.current = performance.now()

      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        if (protocol === "openai") {
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
            if (last && last.role === "assistant" && !last.text) return prev.slice(0, -1)
            return prev
          })
          setError((err as Error).message)
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, imageDataUrl, imageUrl, messages, protocol, modelId, apiKey, systemPrompt, webSearchEnabled],
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
    setTimeout(() => send({ text: last.text, image: last.imageUrl }), 0)
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

  async function sendOpenAI(history: Message[], signal: AbortSignal) {
    const oaiMessages: Array<Record<string, unknown>> = []
    oaiMessages.push({ role: "system", content: composeSystemPrompt(systemPrompt) })
    for (const m of history) {
      if (m.imageUrl) {
        oaiMessages.push({
          role: m.role,
          content: [
            ...(m.text ? [{ type: "text", text: m.text }] : []),
            { type: "image_url", image_url: { url: m.imageUrl } },
          ],
        })
      } else {
        oaiMessages.push({ role: m.role, content: m.text })
      }
    }
    const resp = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        model: modelId,
        messages: oaiMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(webSearchEnabled
          ? {
              tools: [
                {
                  type: "function",
                  function: {
                    name: "web_search",
                    description: WEB_SEARCH_DESCRIPTION,
                    parameters: WEB_SEARCH_PARAMS,
                  },
                },
              ],
            }
          : {}),
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
      else setLastUsage(ch.usage)
    }
  }

  async function sendAnthropic(history: Message[], signal: AbortSignal) {
    const anMessages: Array<Record<string, unknown>> = []
    for (const m of history) {
      if (m.imageUrl) {
        anMessages.push({
          role: m.role,
          content: [
            ...(m.text ? [{ type: "text", text: m.text }] : []),
            { type: "image", source: { type: "url", url: m.imageUrl } },
          ],
        })
      } else {
        anMessages.push({ role: m.role, content: m.text })
      }
    }
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: 4096,
      messages: anMessages,
      stream: true,
    }
    body.system = composeSystemPrompt(systemPrompt)
    if (webSearchEnabled) {
      body.tools = [
        {
          name: "web_search",
          description: WEB_SEARCH_DESCRIPTION,
          input_schema: WEB_SEARCH_PARAMS,
        },
      ]
    }

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
    }
  }

  async function sendGemini(history: Message[], signal: AbortSignal) {
    const contents: Array<Record<string, unknown>> = []
    for (const m of history) {
      const role = m.role === "assistant" ? "model" : "user"
      const parts: Array<Record<string, unknown>> = []
      if (m.text) parts.push({ text: m.text })
      if (m.imageUrl) {
        // Gemini wants base64 inline data. We only have data URLs reliably;
        // a remote URL is passed through as text since the backend will reject
        // raw url refs.
        if (m.imageUrl.startsWith("data:")) {
          const comma = m.imageUrl.indexOf(",")
          const meta = m.imageUrl.slice(5, comma) // e.g. image/png;base64
          const mime = meta.split(";")[0] || "image/png"
          const data = m.imageUrl.slice(comma + 1)
          parts.push({ inlineData: { mimeType: mime, data } })
        } else {
          parts.push({ text: `[image] ${m.imageUrl}` })
        }
      }
      contents.push({ role, parts })
    }
    const body: Record<string, unknown> = { contents }
    body.systemInstruction = { parts: [{ text: composeSystemPrompt(systemPrompt) }] }
    if (webSearchEnabled) {
      body.tools = [
        {
          functionDeclarations: [
            {
              name: "web_search",
              description: WEB_SEARCH_DESCRIPTION,
              parameters: WEB_SEARCH_PARAMS,
            },
          ],
        },
      ]
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
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!streaming) void send()
    }
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

  // Esc exits fullscreen
  useEffect(() => {
    if (!fullscreen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false)
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

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col min-h-0 pg-chat-surface bg-surface-900"
          : "flex flex-col h-full min-h-0 pg-chat-surface"
      }
    >
      <div className="pg-topbar">
        <span className="text-themed-dim">{t("dash.playground.protocol")}:</span>
        <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
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
        {streaming && (
          <span className="text-themed-dim flex items-center gap-2 ml-2">
            <span className="pg-dots"><span/><span/><span/></span>
            {t("dash.playground.generating")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {messages.length > 0 && (
            <span className="text-themed-dim text-xs mr-2 font-mono">
              {ctxCounting
                ? t("dash.playground.ctxCounting")
                : t("dash.playground.ctxTokens", { n: ctxTokens ?? "—" })}
            </span>
          )}
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

      {pendingDeps && (
        <div className="pg-confirm">
          <span>{t("dash.playground.switchWarn")}</span>
          <button className="btn-primary !py-1 !px-3 !text-xs" onClick={confirmSwitch}>{t("dash.playground.confirm")}</button>
          <button className="btn-ghost !py-1 !px-3 !text-xs" onClick={cancelSwitch}>{t("dash.playground.cancel")}</button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        {messages.length === 0 && !error ? (
          <div className="pg-empty">
            <div className="pg-empty-title">{t("dash.playground.emptyHint")}</div>
            <div className="pg-empty-model">{modelId}</div>
            <div className="pg-empty-suggestions">
              <button className="pg-suggestion" onClick={() => setInput("Explain how SSE streaming works in 3 sentences.")}>
                💡 Explain how SSE streaming works
              </button>
              <button className="pg-suggestion" onClick={() => setInput("Write a TypeScript function that debounces an async call.")}>
                ⚡ Write a debounce function in TS
              </button>
              <button className="pg-suggestion" onClick={() => setInput("Hi! Introduce yourself in one sentence.")}>
                👋 Say hi
              </button>
            </div>
          </div>
        ) : (
          <div className="pg-thread">
            {messages.map((m, i) => {
              const isAssistant = m.role === "assistant"
              const isLast = i === messages.length - 1
              const showDots = isAssistant && streaming && isLast && !m.text
              return (
                <div key={i} className={"pg-row " + (m.role === "user" ? "pg-row-user" : "")}>
                  {isAssistant && <div className="pg-avatar">AI</div>}
                  <div className={"pg-bubble " + (m.role === "user" ? "pg-bubble-user" : "pg-bubble-assistant")}>
                    {isAssistant && m.text && (
                      <button
                        className="pg-copy"
                        onClick={() => onCopy(i, m.text)}
                        title={t("dash.playground.copy")}
                      >
                        {copiedIdx === i ? t("dash.playground.copied") : t("dash.playground.copy")}
                      </button>
                    )}
                    {showDots ? (
                      <span className="pg-dots text-themed-dim"><span/><span/><span/></span>
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
                    {m.imageUrl && (
                      <img src={m.imageUrl} alt="" className="mt-2 max-h-48 rounded-lg" />
                    )}
                    {isAssistant && (m.usage || m.durationMs != null) && (
                      <div className="pg-bubble-meta">
                        {t("dash.playground.usage", {
                          tin: m.usage?.input_tokens ?? "—",
                          tout: m.usage?.output_tokens ?? "—",
                          ms: m.durationMs ?? "—",
                        })}
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
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("dash.playground.messagePlaceholder")}
            disabled={streaming}
            rows={1}
          />
          {imageUrl && !imageDataUrl && (
            <div className="pg-url-row">
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder={t("dash.playground.imageUrl")}
                disabled={streaming}
              />
            </div>
          )}
          <div className="pg-composer-actions">
            <label className="pg-icon-btn" title={t("dash.playground.imageFile")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8L9.4 17.36a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              <input type="file" accept="image/*" className="hidden" onChange={onPickFile} disabled={streaming} />
            </label>
            <button
              className="pg-icon-btn"
              onClick={() => setImageUrl(imageUrl ? "" : " ")}
              title={t("dash.playground.imageUrl")}
              disabled={streaming || !!imageDataUrl}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            </button>
            {imageDataUrl && (
              <span className="pg-thumb">
                <img src={imageDataUrl} alt="" />
                <button onClick={removeImage} title={t("dash.playground.removeImage")} disabled={streaming}>✕</button>
              </span>
            )}
            <button
              onClick={() => void send()}
              disabled={streaming || (!input.trim() && !imageDataUrl && !imageUrl.trim())}
              className="pg-send-btn"
              title={t("dash.playground.send")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            </button>
          </div>
        </div>
        {imageError && <div className="text-xs text-accent-red mt-2 text-center">{imageError}</div>}
      </div>
    </div>
  )
}
