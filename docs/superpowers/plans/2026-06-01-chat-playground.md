# Chat Playground (Models Tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new "Models" tab to the dashboard where any logged-in user (admin or not) can self-test `/v1/chat/completions` and `/v1/messages` against any model their upstreams expose, using one of their own API keys as the credential.

**Architecture:** Pure frontend feature. No new backend routes — `/v1/models`, `/v1/chat/completions`, `/v1/messages` already exist. The dashboard browser fetches them directly with the user's selected API key in `x-api-key`. Two tiny SSE parsers (OpenAI and Anthropic) live alongside the tab so what the playground tests is exactly what production sees.

**Tech Stack:** React 19, Tailwind, TypeScript, `bun test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-01-retire-admin-key-and-chat-playground-design.md` (Sub-project B).

**Depends on:** `docs/superpowers/plans/2026-06-01-retire-admin-key.md` must land first (B's auth model assumes A is done).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/ui/dashboard-app/api/models.ts` (new) | Typed `/v1/models` wrapper that sends `x-api-key` |
| `src/ui/dashboard-app/tabs/models/image.ts` (new) | File → data-URL helper, 5 MB guard |
| `src/ui/dashboard-app/tabs/models/streams/openai.ts` (new) | OpenAI SSE parser, async-iterable of text deltas |
| `src/ui/dashboard-app/tabs/models/streams/anthropic.ts` (new) | Anthropic SSE parser, async-iterable of text deltas |
| `src/ui/dashboard-app/tabs/models/ChatPanel.tsx` (new) | Message list, compose row, protocol radio, system panel, send/stop/clear, streaming dispatcher |
| `src/ui/dashboard-app/tabs/models/ModelsTab.tsx` (new) | Left list (search + grouped) + right panel layout, key dropdown, empty state |
| `src/ui/dashboard-app/App.tsx` (modify) | Register `models` tab in `ALL_TABS` and `TabBody` |
| `src/ui/i18n.ts` (modify) | Add `dash.models` and `dash.playground.*` keys (en + zh) |
| `tests/playground-image.test.ts` (new) | `image.ts` MIME + size-guard tests |
| `tests/playground-stream-openai.test.ts` (new) | OpenAI SSE parser golden-fixture tests |
| `tests/playground-stream-anthropic.test.ts` (new) | Anthropic SSE parser golden-fixture tests |

---

## Task 1: `image.ts` helper + tests

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/image.ts`
- Create: `tests/playground-image.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/playground-image.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { fileToDataUrl, IMAGE_MAX_BYTES, ImageTooLargeError } from "~/ui/dashboard-app/tabs/models/image"

function makeFile(size: number, mime = "image/png", name = "x.png"): File {
  const bytes = new Uint8Array(size)
  return new File([bytes], name, { type: mime })
}

describe("fileToDataUrl", () => {
  test("4 MB image returns data:image/png;base64,…", async () => {
    const url = await fileToDataUrl(makeFile(4 * 1024 * 1024, "image/png"))
    expect(url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("6 MB image throws ImageTooLargeError", async () => {
    await expect(fileToDataUrl(makeFile(6 * 1024 * 1024))).rejects.toBeInstanceOf(ImageTooLargeError)
  })

  test("IMAGE_MAX_BYTES is 5 MB", () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/playground-image.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the helper**

Create `src/ui/dashboard-app/tabs/models/image.ts`:

```ts
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

export class ImageTooLargeError extends Error {
  constructor() {
    super("Image too large (max 5 MB)")
    this.name = "ImageTooLargeError"
  }
}

export function fileToDataUrl(file: File): Promise<string> {
  if (file.size > IMAGE_MAX_BYTES) {
    return Promise.reject(new ImageTooLargeError())
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"))
        return
      }
      resolve(result)
    }
    reader.readAsDataURL(file)
  })
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test tests/playground-image.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/image.ts tests/playground-image.test.ts
git commit -m "feat(playground): add fileToDataUrl helper with 5 MB guard"
```

---

## Task 2: OpenAI SSE parser + tests

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/streams/openai.ts`
- Create: `tests/playground-stream-openai.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/playground-stream-openai.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { parseOpenAIStream } from "~/ui/dashboard-app/tabs/models/streams/openai"

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) {
        c.close()
        return
      }
      c.enqueue(enc.encode(chunks[i++]))
    },
  })
}

describe("parseOpenAIStream", () => {
  test("emits text deltas from data: lines and stops on [DONE]", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"!"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("Hello!")
  })

  test("skips malformed JSON lines silently", async () => {
    const fixture = [
      `data: {not json}\n\n`,
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("ok")
  })

  test("error payload throws", async () => {
    const fixture = [`data: {"error":{"message":"boom"}}\n\n`]
    await expect(async () => {
      for await (const _ of parseOpenAIStream(streamOf(fixture))) { void _ }
    }).toThrow("boom")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/playground-stream-openai.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the parser**

Create `src/ui/dashboard-app/tabs/models/streams/openai.ts`:

```ts
export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "")
        buf = buf.slice(nl + 1)
        if (!raw.startsWith("data:")) continue
        const payload = raw.slice(5).trim()
        if (!payload) continue
        if (payload === "[DONE]") return
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const obj = json as {
          error?: { message?: string }
          choices?: Array<{ delta?: { content?: string } }>
        }
        if (obj.error) {
          throw new Error(obj.error.message ?? "OpenAI stream error")
        }
        const delta = obj.choices?.[0]?.delta?.content
        if (typeof delta === "string" && delta.length) yield delta
      }
    }
  } finally {
    reader.releaseLock()
  }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test tests/playground-stream-openai.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/streams/openai.ts tests/playground-stream-openai.test.ts
git commit -m "feat(playground): add OpenAI SSE parser (text-only)"
```

---

## Task 3: Anthropic SSE parser + tests

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/streams/anthropic.ts`
- Create: `tests/playground-stream-anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/playground-stream-anthropic.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { parseAnthropicStream } from "~/ui/dashboard-app/tabs/models/streams/anthropic"

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) {
        c.close()
        return
      }
      c.enqueue(enc.encode(chunks[i++]))
    },
  })
}

describe("parseAnthropicStream", () => {
  test("emits text from content_block_delta until message_stop", async () => {
    const fixture = [
      `event: message_start\ndata: {"type":"message_start"}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseAnthropicStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("Hi there")
  })

  test("event: error throws with message", async () => {
    const fixture = [
      `event: error\ndata: {"type":"error","error":{"message":"nope"}}\n\n`,
    ]
    await expect(async () => {
      for await (const _ of parseAnthropicStream(streamOf(fixture))) { void _ }
    }).toThrow("nope")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/playground-stream-anthropic.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the parser**

Create `src/ui/dashboard-app/tabs/models/streams/anthropic.ts`:

```ts
export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let currentEvent = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "")
        buf = buf.slice(nl + 1)
        if (raw === "") {
          currentEvent = ""
          continue
        }
        if (raw.startsWith("event:")) {
          currentEvent = raw.slice(6).trim()
          continue
        }
        if (!raw.startsWith("data:")) continue
        const payload = raw.slice(5).trim()
        if (!payload) continue
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const obj = json as {
          type?: string
          delta?: { type?: string; text?: string }
          error?: { message?: string }
        }
        if (currentEvent === "error" || obj.type === "error") {
          throw new Error(obj.error?.message ?? "Anthropic stream error")
        }
        if (currentEvent === "message_stop" || obj.type === "message_stop") {
          return
        }
        if (
          (currentEvent === "content_block_delta" || obj.type === "content_block_delta") &&
          obj.delta?.type === "text_delta" &&
          typeof obj.delta.text === "string"
        ) {
          yield obj.delta.text
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test tests/playground-stream-anthropic.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/streams/anthropic.ts tests/playground-stream-anthropic.test.ts
git commit -m "feat(playground): add Anthropic SSE parser (text-only)"
```

---

## Task 4: Models API wrapper

**Files:**
- Create: `src/ui/dashboard-app/api/models.ts`

- [ ] **Step 1: Implement the wrapper**

Create `src/ui/dashboard-app/api/models.ts`:

```ts
// Typed wrapper around /v1/models. Uses the playground-selected API key as
// x-api-key, NOT the session cookie — we want the request to look exactly
// like a real client call.

export interface PlaygroundModel {
  id: string
  name?: string
  vendor?: string
  _upstream: string
  _provider: string
  [extra: string]: unknown
}

export interface PlaygroundModelsResponse {
  data: PlaygroundModel[]
}

export async function listPlaygroundModels(apiKey: string): Promise<PlaygroundModelsResponse> {
  const resp = await fetch("/v1/models", {
    headers: { "x-api-key": apiKey },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(text || `HTTP ${resp.status}`)
  }
  const json = (await resp.json()) as PlaygroundModelsResponse
  return json
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard-app/api/models.ts
git commit -m "feat(playground): add typed /v1/models client wrapper"
```

---

## Task 5: i18n keys (en + zh)

**Files:**
- Modify: `src/ui/i18n.ts` (add to both `en` and `zh` blocks)

- [ ] **Step 1: Locate the en block**

Open `src/ui/i18n.ts`. Find the line `"dash.relays": "Relays",` (~line 96) inside the `en` translations object. Insert after it:

```ts
      "dash.models": "Models",
      "dash.playground.noKey": "No API key",
      "dash.playground.noKeyBody": "You need at least one API key to use the playground",
      "dash.playground.createKey": "Create one in Keys",
      "dash.playground.sendWithKey": "Send with key",
      "dash.playground.searchModels": "Search models...",
      "dash.playground.system": "System",
      "dash.playground.systemPlaceholder": "Optional system prompt",
      "dash.playground.send": "Send",
      "dash.playground.stop": "Stop",
      "dash.playground.clear": "Clear",
      "dash.playground.selectModel": "Select a model to begin",
      "dash.playground.protocol": "Protocol",
      "dash.playground.imageUrl": "Image URL (public)",
      "dash.playground.imageFile": "Upload image",
      "dash.playground.imageTooLarge": "Image too large (max 5 MB)",
      "dash.playground.messagePlaceholder": "Type a message...",
```

- [ ] **Step 2: Locate the zh block**

Find `"dash.relays": "中继",` (or similar) inside the `zh` block (~line 685). Insert after it:

```ts
      "dash.models": "模型",
      "dash.playground.noKey": "无可用 API Key",
      "dash.playground.noKeyBody": "至少创建一个 API Key 才能使用调试台",
      "dash.playground.createKey": "前往 API Keys 创建",
      "dash.playground.sendWithKey": "使用 Key",
      "dash.playground.searchModels": "搜索模型...",
      "dash.playground.system": "系统提示",
      "dash.playground.systemPlaceholder": "可选的 system 提示词",
      "dash.playground.send": "发送",
      "dash.playground.stop": "停止",
      "dash.playground.clear": "清空",
      "dash.playground.selectModel": "选择左侧模型开始对话",
      "dash.playground.protocol": "协议",
      "dash.playground.imageUrl": "图片 URL（公开可访问）",
      "dash.playground.imageFile": "上传图片",
      "dash.playground.imageTooLarge": "图片过大（上限 5 MB）",
      "dash.playground.messagePlaceholder": "输入消息...",
```

- [ ] **Step 3: Verify zh key location**

Run: `grep -n '"dash.relays"' src/ui/i18n.ts`
Expected: two matches (one en, one zh). Confirm the new keys land below each.

- [ ] **Step 4: Commit**

```bash
git add src/ui/i18n.ts
git commit -m "feat(i18n): add dash.models and dash.playground.* keys (en + zh)"
```

---

## Task 6: `ChatPanel` component

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/ChatPanel.tsx`

This is the largest single component. No tests for the JSX shell per spec; the logic-bearing pieces (streams, image) are already tested.

- [ ] **Step 1: Create the file**

Create `src/ui/dashboard-app/tabs/models/ChatPanel.tsx`:

```tsx
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
      if (last.role !== "assistant") return prev
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
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/ChatPanel.tsx
git commit -m "feat(playground): add ChatPanel with OpenAI + Anthropic streaming"
```

---

## Task 7: `ModelsTab` component

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/ModelsTab.tsx`

- [ ] **Step 1: Create the file**

Create `src/ui/dashboard-app/tabs/models/ModelsTab.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react"
import { useT } from "../../state/i18n"
import { listKeys, type ApiKeyDetail } from "../../api/keys"
import { listPlaygroundModels, type PlaygroundModel } from "../../api/models"
import { ChatPanel } from "./ChatPanel"

const LS_KEY_ID = "playground.keyId"
const LS_OPEN_GROUPS = "playground.openGroups"

export function ModelsTab() {
  const t = useT()
  const [keys, setKeys] = useState<ApiKeyDetail[] | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string>(() => localStorage.getItem(LS_KEY_ID) ?? "")
  const [models, setModels] = useState<PlaygroundModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selectedModelId, setSelectedModelId] = useState<string>("")
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(LS_OPEN_GROUPS)
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const [systemPrompt, setSystemPrompt] = useState("")
  const [systemOpen, setSystemOpen] = useState(false)

  // Load user keys (only owned + enabled — same source as KeysTab).
  useEffect(() => {
    listKeys()
      .then((all) => {
        const enabled = all.filter((k) => k.is_owner)
        enabled.sort((a, b) => a.created_at.localeCompare(b.created_at))
        setKeys(enabled)
        if (enabled.length === 0) return
        const remembered = enabled.find((k) => k.id === selectedKeyId)
        const initial = remembered?.id ?? enabled[0].id
        if (initial !== selectedKeyId) setSelectedKeyId(initial)
      })
      .catch((e: Error) => setKeyError(e.message))
  }, [])

  // Persist key selection.
  useEffect(() => {
    if (selectedKeyId) localStorage.setItem(LS_KEY_ID, selectedKeyId)
  }, [selectedKeyId])

  // Load models when key changes.
  useEffect(() => {
    if (!selectedKeyId || !keys) return
    const key = keys.find((k) => k.id === selectedKeyId)
    if (!key) return
    setModels(null)
    setModelsError(null)
    listPlaygroundModels(key.key)
      .then((resp) => setModels(resp.data))
      .catch((e: Error) => setModelsError(e.message))
  }, [selectedKeyId, keys])

  // Group models by _upstream.
  const grouped = useMemo(() => {
    const groups = new Map<string, PlaygroundModel[]>()
    if (!models) return groups
    const needle = search.trim().toLowerCase()
    for (const m of models) {
      if (needle) {
        const hay = `${m.id} ${m.name ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) continue
      }
      const g = groups.get(m._upstream) ?? []
      g.push(m)
      groups.set(m._upstream, g)
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.id.localeCompare(b.id))
    return groups
  }, [models, search])

  // Auto-select first model on first render with data.
  useEffect(() => {
    if (selectedModelId) return
    for (const arr of grouped.values()) {
      if (arr.length) {
        setSelectedModelId(arr[0].id)
        return
      }
    }
  }, [grouped, selectedModelId])

  function toggleGroup(g: string) {
    setOpenGroups((prev) => {
      const next = { ...prev, [g]: prev[g] === false ? true : false }
      localStorage.setItem(LS_OPEN_GROUPS, JSON.stringify(next))
      return next
    })
  }

  // Empty state: no keys at all.
  if (keys && keys.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="border border-themed rounded-lg p-6 text-center max-w-sm">
          <div className="text-lg font-medium mb-2">{t("dash.playground.noKey")}</div>
          <div className="text-sm text-themed-dim mb-4">{t("dash.playground.noKeyBody")}</div>
          <button
            onClick={() => { window.location.hash = "#keys" }}
            className="px-4 py-2 bg-accent-cyan text-black text-sm rounded"
          >
            {t("dash.playground.createKey")}
          </button>
        </div>
      </div>
    )
  }

  if (keyError) return <div className="text-sm text-accent-red p-4">{keyError}</div>
  if (!keys) return <div className="text-sm text-themed-dim p-4">Loading…</div>

  const selectedKey = keys.find((k) => k.id === selectedKeyId)

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] min-h-[560px]">
      {/* Top bar: key dropdown + system toggle */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-themed">
        <label className="text-xs text-themed-dim">{t("dash.playground.sendWithKey")}:</label>
        <select
          value={selectedKeyId}
          onChange={(e) => setSelectedKeyId(e.target.value)}
          className="text-xs border border-themed rounded px-2 py-1 bg-transparent"
        >
          {keys.map((k) => (
            <option key={k.id} value={k.id}>{k.name || k.id}</option>
          ))}
        </select>
        <button
          onClick={() => setSystemOpen((v) => !v)}
          className="text-xs px-2 py-1 border border-themed rounded ml-2"
        >
          {t("dash.playground.system")} {systemOpen ? "▴" : "▾"}
        </button>
      </div>

      {systemOpen && (
        <div className="border-b border-themed p-3">
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t("dash.playground.systemPlaceholder")}
            className="w-full text-sm border border-themed rounded px-2 py-1 bg-transparent min-h-[60px]"
          />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left: search + grouped model list */}
        <div className="w-72 shrink-0 border-r border-themed flex flex-col min-h-0">
          <div className="p-2 border-b border-themed">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("dash.playground.searchModels")}
              className="w-full text-xs border border-themed rounded px-2 py-1 bg-transparent"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {modelsError && <div className="text-xs text-accent-red p-3">{modelsError}</div>}
            {!modelsError && !models && <div className="text-xs text-themed-dim p-3">Loading…</div>}
            {Array.from(grouped.entries()).map(([upstream, arr]) => {
              const isOpen = openGroups[upstream] !== false  // default open
              return (
                <div key={upstream} className="border-b border-themed">
                  <button
                    onClick={() => toggleGroup(upstream)}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-themed-dim hover:bg-themed-soft"
                  >
                    <span>{upstream} ({arr.length})</span>
                    <span>{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && arr.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedModelId(m.id)}
                      className={
                        "w-full text-left px-4 py-2 text-xs border-l-2 " +
                        (m.id === selectedModelId
                          ? "bg-accent-cyan/10 border-l-accent-cyan text-accent-cyan"
                          : "border-l-transparent text-themed hover:bg-themed-soft")
                      }
                    >
                      <div className="truncate">{m.name ?? m.id}</div>
                      <div className="font-mono opacity-60 truncate">{m.id}</div>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: chat panel */}
        <div className="flex-1 min-w-0">
          {selectedModelId && selectedKey ? (
            <ChatPanel modelId={selectedModelId} apiKey={selectedKey.key} systemPrompt={systemPrompt} />
          ) : (
            <div className="flex items-center justify-center h-full text-themed-dim text-sm">
              {t("dash.playground.selectModel")}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/ModelsTab.tsx
git commit -m "feat(playground): add ModelsTab (grouped list + key picker + empty state)"
```

---

## Task 8: Register the tab in `App.tsx`

**Files:**
- Modify: `src/ui/dashboard-app/App.tsx:11,24-31,72-90`

- [ ] **Step 1: Add import**

In `src/ui/dashboard-app/App.tsx`, add after the existing tab imports (around line 13):

```ts
import { ModelsTab } from "./tabs/models/ModelsTab"
```

- [ ] **Step 2: Register in `ALL_TABS`**

Replace the `ALL_TABS` array (`src/ui/dashboard-app/App.tsx:24-31`):

```ts
const ALL_TABS: ReadonlyArray<TabDef> = [
  { id: "upstreams", labelKey: "dash.upstream", fallback: "Upstreams", adminOnly: true },
  { id: "users", labelKey: "dash.users", fallback: "Users", adminOnly: true },
  { id: "keys", labelKey: "dash.apiKeys", fallback: "API Keys", userOk: true },
  { id: "models", labelKey: "dash.models", fallback: "Models", userOk: true },
  { id: "usage", labelKey: "dash.usage", fallback: "Usage", userOk: true },
  { id: "latency", labelKey: "dash.latency", fallback: "Latency", userOk: true },
  { id: "clients", labelKey: "dash.relays", fallback: "Clients", userOk: true },
]
```

- [ ] **Step 3: Add to `TabBody` switch**

In `TabBody`, add a case before `case "settings":`:

```tsx
    case "models":
      return <ModelsTab />
```

- [ ] **Step 4: Build dashboard bundle**

Run: `bun run build:ui`
Expected: clean build, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard-app/App.tsx
git commit -m "feat(dashboard): register Models tab in ALL_TABS and TabBody"
```

---

## Task 9: Manual smoke test

**Files:** (none modified — verification only)

- [ ] **Step 1: Start local server**

Run: `bun run src/local.ts`

- [ ] **Step 2: Log in as `test@local.dev`**

Browser: `http://localhost:41414/dashboard`. Log in with `test@local.dev` / `local-dev-admin`.

- [ ] **Step 3: Click the Models tab**

Expected: if no keys exist for this user, see the empty-state card with "Create one in Keys" button. Click it → URL changes to `#keys`. Create a key, copy its plaintext, return to `#models`.

- [ ] **Step 4: Verify left list**

Expected: left column shows models grouped by upstream (at minimum the `copilot:*` group if GitHub is connected). Search box filters in real time. Auto-selected first model.

- [ ] **Step 5: Send a message in OpenAI mode**

Expected: assistant bubble streams text in. Click Stop mid-stream — bubble freezes. Click Clear — list empties; system prompt (if set) remains.

- [ ] **Step 6: Switch to Anthropic protocol**

Expected: chat clears. Type "hi". For Claude-family model, get a streamed reply. For non-Claude model, observe error bubble with the upstream's message.

- [ ] **Step 7: Image attach**

Upload a ~1 MB JPEG → see "📎 Image attached (base64)". Send with "describe this" → model receives image. Then try a 6 MB file → inline `Image too large (max 5 MB)` error, no upload attempted.

- [ ] **Step 8: Switch key**

If you have ≥2 keys, change the dropdown — chat is preserved; subsequent sends use the new key.

- [ ] **Step 9: Switch model**

Pick a different model in the left list — chat auto-clears.

- [ ] **Step 10: Kill server**

Ctrl+C.

- [ ] **Step 11: Final commit (only if Steps 1–10 surfaced any fix)**

```bash
git status   # expect clean
```

No commit if clean.
