import { useEffect, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { fileToDataUrl, ImageTooLargeError } from "./image"
import { parseOpenAIStream } from "./streams/openai"
import { parseAnthropicStream } from "./streams/anthropic"

type Protocol = "openai" | "anthropic"
type Role = "user" | "assistant"

interface Message {
  role: Role
  text: string
  imageUrl?: string
}

interface Props {
  modelId: string
  apiKey: string
  systemPrompt: string
}

export function ChatPanel({ modelId, apiKey, systemPrompt }: Props) {
  const t = useT()
  const [protocol, setProtocol] = useState<Protocol>("openai")
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [imageUrl, setImageUrl] = useState("")
  const [imageDataUrl, setImageDataUrl] = useState("")
  const [imageError, setImageError] = useState("")
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-clear chat when model or protocol changes (spec B7).
  useEffect(() => {
    abortRef.current?.abort()
    setMessages([])
  }, [modelId, protocol])

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

  function clear() {
    abortRef.current?.abort()
    setMessages([])
  }

  async function send() {
    const text = input.trim()
    const img = imageDataUrl || imageUrl.trim()
    if (!text && !img) return
    const userMsg: Message = { role: "user", text, imageUrl: img || undefined }
    const nextHistory = [...messages, userMsg]
    setMessages([...nextHistory, { role: "assistant", text: "" }])
    setInput("")
    setImageUrl("")
    setImageDataUrl("")
    setImageError("")
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      if (protocol === "openai") {
        await sendOpenAI(nextHistory, ctrl.signal)
      } else {
        await sendAnthropic(nextHistory, ctrl.signal)
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // user-cancelled; bubble nothing
      } else {
        appendAssistant(`\n\n[Error] ${(err as Error).message}`)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
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

  async function sendOpenAI(history: Message[], signal: AbortSignal) {
    const oaiMessages: Array<Record<string, unknown>> = []
    if (systemPrompt.trim()) {
      oaiMessages.push({ role: "system", content: systemPrompt })
    }
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
      body: JSON.stringify({ model: modelId, messages: oaiMessages, stream: true }),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "")
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    for await (const delta of parseOpenAIStream(resp.body)) {
      appendAssistant(delta)
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
    if (systemPrompt.trim()) body.system = systemPrompt

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
    for await (const delta of parseAnthropicStream(resp.body)) {
      appendAssistant(delta)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-themed">
        <span className="text-xs text-themed-dim">{t("dash.playground.protocol")}:</span>
        <label className="text-xs flex items-center gap-1">
          <input
            type="radio"
            name="protocol"
            checked={protocol === "openai"}
            onChange={() => setProtocol("openai")}
          />{" "}
          OpenAI
        </label>
        <label className="text-xs flex items-center gap-1">
          <input
            type="radio"
            name="protocol"
            checked={protocol === "anthropic"}
            onChange={() => setProtocol("anthropic")}
          />{" "}
          Anthropic
        </label>
        <div className="ml-auto flex items-center gap-2">
          {streaming && (
            <button onClick={() => abortRef.current?.abort()} className="text-xs px-2 py-1 border border-themed rounded">
              {t("dash.playground.stop")}
            </button>
          )}
          <button onClick={clear} className="text-xs px-2 py-1 border border-themed rounded">
            {t("dash.playground.clear")}
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-3 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <div
              className={
                "inline-block max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm " +
                (m.role === "user" ? "bg-accent-cyan/20" : "bg-themed-soft")
              }
            >
              {m.text || (streaming && i === messages.length - 1 ? "…" : "")}
              {m.imageUrl && (
                <img src={m.imageUrl} alt="" className="mt-2 max-h-48 rounded" />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-themed p-3 space-y-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("dash.playground.messagePlaceholder")}
          className="w-full text-sm border border-themed rounded px-2 py-1 min-h-[60px] bg-transparent"
          disabled={streaming}
        />
        <div className="flex items-center gap-2 text-xs">
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => {
              setImageUrl(e.target.value)
              if (e.target.value) setImageDataUrl("")
            }}
            placeholder={t("dash.playground.imageUrl")}
            className="flex-1 border border-themed rounded px-2 py-1 bg-transparent"
            disabled={streaming}
          />
          <label className="px-2 py-1 border border-themed rounded cursor-pointer">
            {t("dash.playground.imageFile")}
            <input type="file" accept="image/*" className="hidden" onChange={onPickFile} disabled={streaming} />
          </label>
          <button
            onClick={send}
            disabled={streaming}
            className="px-3 py-1 bg-accent-cyan text-black rounded disabled:opacity-50"
          >
            {t("dash.playground.send")}
          </button>
        </div>
        {imageError && <div className="text-xs text-accent-red">{imageError}</div>}
        {imageDataUrl && <div className="text-xs text-themed-dim">📎 Image attached (base64)</div>}
      </div>
    </div>
  )
}
