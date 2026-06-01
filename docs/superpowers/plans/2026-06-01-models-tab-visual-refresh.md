# Models Tab Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the dashboard Models tab to match the visual quality of the rest of the app and surface model capability metadata that the backend already returns — without adding new debug/inspector machinery.

**Architecture:** Two-commit, UI-only refresh. Commit 1 extracts a `ModelInfoBar` component and restructures `ModelsTab` into a single-card layout (sidebar + main) with metadata chips. Commit 2 visually rebuilds `ChatPanel` (rounded bubbles with tails, bouncing typing dots, paper-plane Send button, collapsible image input, Enter-to-send) and disables image input when the selected model lacks vision support. No backend changes, no new API calls — the `/v1/models` response already carries `capabilities.limits.{max_context_window_tokens,max_output_tokens,max_prompt_tokens}`, `capabilities.supports.{streaming,tool_calls,vision}`, `preview`, and `vendor`.

**Tech Stack:** React 19, Tailwind (theme tokens in `tailwind.config.ts` and CSS vars in `src/ui/dashboard-app/styles.css`), TypeScript strict, Bun test runner. Reference visual language: `/Users/zhangxian/projects/copilot-gateway/apps/web/src/components/models/ChatPanel.vue` and `ModelInfoBar.vue`.

---

## File Structure

**Modify:**
- `src/ui/dashboard-app/tabs/models/ModelsTab.tsx` — restructure into single-card layout, render new `<ModelInfoBar>`, move system-prompt + key picker into sidebar header (collapsible).
- `src/ui/dashboard-app/tabs/models/ChatPanel.tsx` — visual rebuild: bubble shape, typing indicator, paper-plane Send icon, collapsible image input via icon toggle, Enter-to-send, vision-aware image button disable. Add `x-models-playground: 1` request header. Add empty-state placeholder.
- `src/ui/i18n.ts` — add new i18n keys for the InfoBar chips and a few new UI labels (EN + ZH).
- `src/ui/dashboard-app/api/models.ts` — extend `PlaygroundModel` type to declare the optional capability fields the UI now reads (no runtime change; the backend already returns these).

**Create:**
- `src/ui/dashboard-app/tabs/models/ModelInfoBar.tsx` — pure presentation component for the right-pane header (model name + upstream chip + limit chips + capability badges + Clear button slot).
- `src/ui/dashboard-app/tabs/models/format.ts` — `formatTokenLimit(n: number): string` helper (e.g. `128000 → "128k"`, `1_048_576 → "1M"`).
- `tests/playground-format-token-limit.test.ts` — unit tests for `formatTokenLimit`.

**Untouched:**
- SSE parsers (`streams/openai.ts`, `streams/anthropic.ts`) — already covered by prior task.
- `image.ts` — already correct.
- `/v1/models` route — already returns the metadata.

---

## Task 1: `formatTokenLimit` helper (TDD)

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/format.ts`
- Test: `tests/playground-format-token-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/playground-format-token-limit.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { formatTokenLimit } from "~/ui/dashboard-app/tabs/models/format"

describe("formatTokenLimit", () => {
  test("undefined returns empty string", () => {
    expect(formatTokenLimit(undefined)).toBe("")
  })
  test("zero returns empty string", () => {
    expect(formatTokenLimit(0)).toBe("")
  })
  test("under 1000 returns raw number", () => {
    expect(formatTokenLimit(512)).toBe("512")
  })
  test("thousands use k suffix without decimal when whole", () => {
    expect(formatTokenLimit(128_000)).toBe("128k")
    expect(formatTokenLimit(8_000)).toBe("8k")
  })
  test("thousands round to one decimal when not whole", () => {
    expect(formatTokenLimit(8_192)).toBe("8.2k")
  })
  test("millions use M suffix", () => {
    expect(formatTokenLimit(1_000_000)).toBe("1M")
    expect(formatTokenLimit(1_048_576)).toBe("1M")
    expect(formatTokenLimit(2_500_000)).toBe("2.5M")
  })
  test("negative returns empty string", () => {
    expect(formatTokenLimit(-1)).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/playground-format-token-limit.test.ts`
Expected: FAIL — `Cannot find module '~/ui/dashboard-app/tabs/models/format'`.

- [ ] **Step 3: Implement the helper**

Create `src/ui/dashboard-app/tabs/models/format.ts`:

```ts
export function formatTokenLimit(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return ""
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const v = n / 1000
    return v === Math.floor(v) ? `${v}k` : `${v.toFixed(1)}k`
  }
  const v = n / 1_000_000
  return v === Math.floor(v) ? `${v}M` : `${v.toFixed(1)}M`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/playground-format-token-limit.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/format.ts tests/playground-format-token-limit.test.ts
git commit -m "feat(dashboard): formatTokenLimit helper for model capability chips"
```

---

## Task 2: Extend `PlaygroundModel` type with capability fields

**Files:**
- Modify: `src/ui/dashboard-app/api/models.ts`

- [ ] **Step 1: Replace the type declaration**

Open `src/ui/dashboard-app/api/models.ts`. Replace the `PlaygroundModel` interface (currently lines 5–12) with:

```ts
export interface PlaygroundModelCapabilities {
  family?: string
  tokenizer?: string
  type?: string
  limits?: {
    max_context_window_tokens?: number
    max_output_tokens?: number
    max_prompt_tokens?: number
  }
  supports?: {
    streaming?: boolean
    tool_calls?: boolean
    vision?: boolean
    parallel_tool_calls?: boolean
    structured_outputs?: boolean
  }
}

export interface PlaygroundModel {
  id: string
  name?: string
  vendor?: string
  preview?: boolean
  capabilities?: PlaygroundModelCapabilities
  _upstream: string
  _provider: string
  [extra: string]: unknown
}
```

Leave `PlaygroundModelsResponse` and `listPlaygroundModels` untouched.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if no script exists — first check `package.json scripts.typecheck`).
Expected: PASS — no type errors. The fields are all optional so existing call sites remain valid.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard-app/api/models.ts
git commit -m "feat(dashboard): expose model capability fields on PlaygroundModel type"
```

---

## Task 3: Add i18n keys for InfoBar + new ChatPanel labels

**Files:**
- Modify: `src/ui/i18n.ts`

Six new keys, in both EN (around line 113, after `dash.playground.messagePlaceholder`) and ZH (mirror location, around line 718).

- [ ] **Step 1: Add English keys**

In `src/ui/i18n.ts`, find the EN block (line ~113 ends with `"dash.playground.messagePlaceholder"`). Insert before the closing `}` of that block:

```ts
      "dash.playground.ctx": "ctx",
      "dash.playground.prompt": "prompt",
      "dash.playground.output": "output",
      "dash.playground.vision": "vision",
      "dash.playground.tools": "tools",
      "dash.playground.streaming": "streaming",
      "dash.playground.preview": "preview",
      "dash.playground.emptyState": "Send a message to start chatting",
      "dash.playground.imageToggleHint": "Attach image",
      "dash.playground.visionUnsupported": "Selected model does not support vision",
      "dash.playground.options": "Options",
```

- [ ] **Step 2: Add Chinese keys**

In the same file, find the ZH block (line ~718 — look for the ZH equivalent of `dash.playground.messagePlaceholder`). Insert the parallel set:

```ts
      "dash.playground.ctx": "上下文",
      "dash.playground.prompt": "输入上限",
      "dash.playground.output": "输出上限",
      "dash.playground.vision": "图像",
      "dash.playground.tools": "工具",
      "dash.playground.streaming": "流式",
      "dash.playground.preview": "预览",
      "dash.playground.emptyState": "发送消息开始对话",
      "dash.playground.imageToggleHint": "附加图片",
      "dash.playground.visionUnsupported": "当前模型不支持图像输入",
      "dash.playground.options": "选项",
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/i18n.ts
git commit -m "feat(dashboard): i18n keys for Models tab capability chips and new labels"
```

---

## Task 4: Create `ModelInfoBar` component

**Files:**
- Create: `src/ui/dashboard-app/tabs/models/ModelInfoBar.tsx`

- [ ] **Step 1: Write the file**

Create `src/ui/dashboard-app/tabs/models/ModelInfoBar.tsx`:

```tsx
import { useT } from "../../state/i18n"
import { formatTokenLimit } from "./format"
import type { PlaygroundModel } from "../../api/models"

interface Props {
  model: PlaygroundModel
  streaming: boolean
  onClear: () => void
  onStop: () => void
}

function providerChipClass(provider: string): string {
  // Color-coded by upstream provider kind. Falls back to neutral.
  switch (provider) {
    case "copilot":
      return "bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30"
    case "azure":
      return "bg-accent-teal/10 text-accent-teal border-accent-teal/30"
    case "custom":
      return "bg-accent-amber/10 text-accent-amber border-accent-amber/30"
    default:
      return "bg-surface-700/30 text-themed-dim border-themed"
  }
}

export function ModelInfoBar({ model, streaming, onClear, onStop }: Props) {
  const t = useT()
  const caps = model.capabilities
  const limits = caps?.limits
  const supports = caps?.supports
  const ctx = formatTokenLimit(limits?.max_context_window_tokens)
  const prompt = formatTokenLimit(limits?.max_prompt_tokens)
  const out = formatTokenLimit(limits?.max_output_tokens)

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-themed flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate">{model.name ?? model.id}</span>
        <span className="text-xs font-mono text-themed-dim truncate">{model.id}</span>
      </div>
      <span
        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${providerChipClass(model._provider)}`}
        title={model._upstream}
      >
        {model._upstream}
      </span>
      {model.preview && (
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border bg-accent-amber/10 text-accent-amber border-accent-amber/30">
          {t("dash.playground.preview")}
        </span>
      )}
      {ctx && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-themed text-themed-dim" title="max context window">
          {t("dash.playground.ctx")}: {ctx}
        </span>
      )}
      {prompt && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-themed text-themed-dim" title="max prompt tokens">
          {t("dash.playground.prompt")}: {prompt}
        </span>
      )}
      {out && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-themed text-themed-dim" title="max output tokens">
          {t("dash.playground.output")}: {out}
        </span>
      )}
      {supports?.streaming && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-themed text-themed-dim">
          {t("dash.playground.streaming")}
        </span>
      )}
      {supports?.tool_calls && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-themed text-themed-dim">
          {t("dash.playground.tools")}
        </span>
      )}
      {supports?.vision && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-themed text-themed-dim">
          {t("dash.playground.vision")}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {streaming && (
          <button onClick={onStop} className="text-xs px-2 py-1 border border-themed rounded hover:bg-surface-700/40">
            {t("dash.playground.stop")}
          </button>
        )}
        <button onClick={onClear} className="text-xs px-2 py-1 border border-themed rounded hover:bg-surface-700/40">
          {t("dash.playground.clear")}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS — `ModelInfoBar` only depends on already-exported types.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard-app/tabs/models/ModelInfoBar.tsx
git commit -m "feat(dashboard): ModelInfoBar component with capability chips"
```

---

## Task 5: Restructure `ModelsTab` to single-card layout

**Files:**
- Modify: `src/ui/dashboard-app/tabs/models/ModelsTab.tsx`

Goal: drop the top bar; move key picker + system prompt into the sidebar header (collapsible "Options"). Flatten the model list (no provider grouping); keep search. Pass the resolved `PlaygroundModel` object down to `ChatPanel` so the InfoBar can read its metadata. Keep all existing localStorage persistence keys (`playground.keyId`).

The grouping logic and `LS_OPEN_GROUPS` are deleted in this task.

- [ ] **Step 1: Replace the file**

Overwrite `src/ui/dashboard-app/tabs/models/ModelsTab.tsx` with:

```tsx
import { useEffect, useMemo, useState } from "react"
import { useT } from "../../state/i18n"
import { listKeys, type ApiKeyDetail } from "../../api/keys"
import { listPlaygroundModels, type PlaygroundModel } from "../../api/models"
import { ChatPanel } from "./ChatPanel"

const LS_KEY_ID = "playground.keyId"

export function ModelsTab() {
  const t = useT()
  const [keys, setKeys] = useState<ApiKeyDetail[] | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string>(() => localStorage.getItem(LS_KEY_ID) ?? "")
  const [models, setModels] = useState<PlaygroundModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selectedModelId, setSelectedModelId] = useState<string>("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [optionsOpen, setOptionsOpen] = useState(false)

  useEffect(() => {
    listKeys()
      .then((all) => {
        const owned = all.filter((k) => k.is_owner)
        owned.sort((a, b) => a.created_at.localeCompare(b.created_at))
        setKeys(owned)
        if (owned.length === 0) return
        const first = owned[0]!
        const remembered = owned.find((k) => k.id === selectedKeyId)
        const initial = remembered?.id ?? first.id
        if (initial !== selectedKeyId) setSelectedKeyId(initial)
      })
      .catch((e: Error) => setKeyError(e.message))
  }, [])

  useEffect(() => {
    if (selectedKeyId) localStorage.setItem(LS_KEY_ID, selectedKeyId)
  }, [selectedKeyId])

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

  const filtered = useMemo(() => {
    if (!models) return []
    const needle = search.trim().toLowerCase()
    const out = needle
      ? models.filter((m) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(needle))
      : models.slice()
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }, [models, search])

  useEffect(() => {
    if (selectedModelId) return
    if (filtered.length) setSelectedModelId(filtered[0]!.id)
  }, [filtered, selectedModelId])

  if (keys && keys.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="glass-card p-6 text-center max-w-sm">
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
  const selectedModel = models?.find((m) => m.id === selectedModelId) ?? null

  return (
    <div className="glass-card h-[calc(100vh-140px)] min-h-[560px] overflow-hidden flex">
      {/* Sidebar */}
      <aside className="w-[280px] shrink-0 border-r border-themed flex flex-col min-h-0">
        <div className="p-3 border-b border-themed space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={selectedKeyId}
              onChange={(e) => setSelectedKeyId(e.target.value)}
              className="flex-1 text-xs border border-themed rounded px-2 py-1 bg-transparent"
            >
              {keys.map((k) => (
                <option key={k.id} value={k.id}>{k.name || k.id}</option>
              ))}
            </select>
            <button
              onClick={() => setOptionsOpen((v) => !v)}
              className="text-xs px-2 py-1 border border-themed rounded"
              title={t("dash.playground.options")}
            >
              {optionsOpen ? "▴" : "▾"}
            </button>
          </div>
          {optionsOpen && (
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("dash.playground.systemPlaceholder")}
              className="w-full text-xs border border-themed rounded px-2 py-1 bg-transparent min-h-[60px]"
            />
          )}
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
          {filtered.map((m) => {
            const active = m.id === selectedModelId
            return (
              <button
                key={m.id}
                onClick={() => setSelectedModelId(m.id)}
                className={
                  "w-full text-left px-3 py-2 text-xs border-l-2 transition-colors " +
                  (active
                    ? "bg-accent-cyan/10 border-l-accent-cyan text-accent-cyan"
                    : "border-l-transparent text-themed hover:bg-surface-700/30")
                }
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate flex-1">{m.name ?? m.id}</span>
                  {m.preview && (
                    <span className="text-[9px] uppercase px-1 rounded bg-accent-amber/15 text-accent-amber">
                      {t("dash.playground.preview")}
                    </span>
                  )}
                </div>
                <div className="font-mono opacity-60 truncate">{m.id}</div>
              </button>
            )
          })}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 flex flex-col">
        {selectedModel && selectedKey ? (
          <ChatPanel
            model={selectedModel}
            apiKey={selectedKey.key}
            systemPrompt={systemPrompt}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-themed-dim text-sm">
            {t("dash.playground.selectModel")}
          </div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: FAIL — `ChatPanel`'s prop signature still says `modelId: string`, not `model: PlaygroundModel`. This will be fixed in Task 6.

- [ ] **Step 3: Defer commit**

Do NOT commit this task alone — it leaves the typecheck broken. Commit it together with Task 6.

---

## Task 6: Rebuild `ChatPanel` visuals

**Files:**
- Modify: `src/ui/dashboard-app/tabs/models/ChatPanel.tsx`

Changes:
- New prop signature: `{ model: PlaygroundModel, apiKey: string, systemPrompt: string }` (was `modelId: string`).
- Render `<ModelInfoBar>` at top (replaces the old protocol radio row; protocol toggle becomes a segmented control rendered above the messages list).
- Bubbles: `rounded-2xl` with `rounded-br-md` (user) / `rounded-bl-md` (assistant) tails. User bubble `bg-accent-cyan/15`, assistant `bg-surface-700/40`.
- Typing indicator: 3 bouncing dots, CSS only.
- Empty state: centered placeholder text `dash.playground.emptyState`.
- Composer: textarea + collapsible image input row (toggled by image icon button); paper-plane Send icon button.
- `Enter` sends, `Shift+Enter` newline.
- Image button is `disabled` and shows tooltip `dash.playground.visionUnsupported` when `!model.capabilities?.supports?.vision`.
- Add `x-models-playground: "1"` header on both fetch calls.

- [ ] **Step 1: Replace the file**

Overwrite `src/ui/dashboard-app/tabs/models/ChatPanel.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { fileToDataUrl, ImageTooLargeError } from "./image"
import { parseOpenAIStream } from "./streams/openai"
import { parseAnthropicStream } from "./streams/anthropic"
import { ModelInfoBar } from "./ModelInfoBar"
import type { PlaygroundModel } from "../../api/models"

type Protocol = "openai" | "anthropic"
type Role = "user" | "assistant"

interface Message {
  role: Role
  text: string
  imageUrl?: string
}

interface Props {
  model: PlaygroundModel
  apiKey: string
  systemPrompt: string
}

const PLAYGROUND_HEADER = { "x-models-playground": "1" } as const

export function ChatPanel({ model, apiKey, systemPrompt }: Props) {
  const t = useT()
  const modelId = model.id
  const visionSupported = model.capabilities?.supports?.vision === true
  const [protocol, setProtocol] = useState<Protocol>("openai")
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [imageOpen, setImageOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState("")
  const [imageDataUrl, setImageDataUrl] = useState("")
  const [imageError, setImageError] = useState("")
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    setMessages([])
    setImageOpen(false)
    setImageUrl("")
    setImageDataUrl("")
    setImageError("")
  }, [modelId, protocol])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  function clear() {
    abortRef.current?.abort()
    setMessages([])
  }

  function stop() {
    abortRef.current?.abort()
  }

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
        // cancelled
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
    if (systemPrompt.trim()) oaiMessages.push({ role: "system", content: systemPrompt })
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
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...PLAYGROUND_HEADER },
      body: JSON.stringify({ model: modelId, messages: oaiMessages, stream: true }),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "")
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    for await (const delta of parseOpenAIStream(resp.body)) appendAssistant(delta)
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
    const body: Record<string, unknown> = { model: modelId, max_tokens: 4096, messages: anMessages, stream: true }
    if (systemPrompt.trim()) body.system = systemPrompt
    const resp = await fetch("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...PLAYGROUND_HEADER },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "")
      throw new Error(errText || `HTTP ${resp.status}`)
    }
    for await (const delta of parseAnthropicStream(resp.body)) appendAssistant(delta)
  }

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!streaming) void send()
    }
  }

  const showEmpty = messages.length === 0 && !streaming

  return (
    <div className="flex flex-col h-full min-h-0">
      <ModelInfoBar model={model} streaming={streaming} onClear={clear} onStop={stop} />

      {/* Protocol segmented control */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-themed">
        <div className="inline-flex border border-themed rounded overflow-hidden text-[11px]">
          <button
            onClick={() => setProtocol("openai")}
            className={"px-2 py-0.5 " + (protocol === "openai" ? "bg-accent-cyan/15 text-accent-cyan" : "text-themed-dim hover:bg-surface-700/30")}
          >
            OpenAI
          </button>
          <button
            onClick={() => setProtocol("anthropic")}
            className={"px-2 py-0.5 border-l border-themed " + (protocol === "anthropic" ? "bg-accent-cyan/15 text-accent-cyan" : "text-themed-dim hover:bg-surface-700/30")}
          >
            Anthropic
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-4 py-4 space-y-3">
        {showEmpty && (
          <div className="h-full flex items-center justify-center text-themed-dim text-sm">
            {t("dash.playground.emptyState")}
          </div>
        )}
        {messages.map((m, i) => {
          const isUser = m.role === "user"
          const isLast = i === messages.length - 1
          const isTyping = streaming && isLast && !isUser && !m.text
          return (
            <div key={i} className={isUser ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  "max-w-[80%] whitespace-pre-wrap px-3 py-2 text-sm rounded-2xl " +
                  (isUser
                    ? "bg-accent-cyan/15 text-themed rounded-br-md"
                    : "bg-surface-700/40 text-themed rounded-bl-md")
                }
              >
                {isTyping ? (
                  <span className="inline-flex items-center gap-1 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                ) : (
                  m.text
                )}
                {m.imageUrl && (
                  <img src={m.imageUrl} alt="" className="mt-2 max-h-48 rounded-lg" />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Composer */}
      <div className="border-t border-themed p-3 space-y-2">
        {imageOpen && visionSupported && (
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
          </div>
        )}
        {imageError && <div className="text-xs text-accent-red">{imageError}</div>}
        {imageDataUrl && <div className="text-xs text-themed-dim">📎 Image attached (base64)</div>}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => setImageOpen((v) => !v)}
            disabled={!visionSupported || streaming}
            title={visionSupported ? t("dash.playground.imageToggleHint") : t("dash.playground.visionUnsupported")}
            className="shrink-0 px-2 py-2 border border-themed rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-700/30"
            aria-label={t("dash.playground.imageToggleHint")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder={t("dash.playground.messagePlaceholder")}
            className="flex-1 text-sm border border-themed rounded px-2 py-1 min-h-[44px] max-h-[160px] bg-transparent resize-none"
            disabled={streaming}
            rows={1}
          />
          <button
            type="button"
            onClick={send}
            disabled={streaming || (!input.trim() && !imageDataUrl && !imageUrl.trim())}
            className="shrink-0 px-3 py-2 bg-accent-cyan text-black rounded disabled:opacity-50 inline-flex items-center gap-1.5"
            aria-label={t("dash.playground.send")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M22 2L11 13" />
              <path d="M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
            <span className="text-xs">{t("dash.playground.send")}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS — `ModelsTab` now passes `model={selectedModel}` which matches the new `ChatPanel` prop.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: All previously-passing tests still pass. The 7 new `formatTokenLimit` tests + 13 stream parser tests + everything else.

- [ ] **Step 4: Rebuild the dashboard bundle**

Run: `bun run build:dashboard` (verify the exact script name in `package.json`; common aliases: `build:dashboard`, `dashboard:build`, or `build`).
Expected: bundle written under `src/ui/dashboard-app/dist/`. No build errors.

If the script doesn't exist, check `package.json` and use the matching one — do not invent a command.

- [ ] **Step 5: Commit Tasks 5 + 6 together**

```bash
git add src/ui/dashboard-app/tabs/models/ModelsTab.tsx \
        src/ui/dashboard-app/tabs/models/ChatPanel.tsx \
        src/ui/dashboard-app/dist/
git commit -m "feat(dashboard): visual refresh for Models tab (single-card layout, InfoBar, modern ChatPanel)"
```

(Include `dist/` in the commit so the served bundle matches the source — this matches how prior dashboard commits in this repo have been structured. Verify by `git log -1 --stat 87d439d` if uncertain.)

---

## Task 7: Manual smoke verification

**Files:** none modified — this is a verification task.

Container should still be running from prior session at `http://localhost:41414` (login `test@local.dev` / `local-dev-admin`).

- [ ] **Step 1: If container is stopped, restart it**

Run: `docker compose ps`
If `copilot-api-gateway-gateway-1` is not `running`, run: `docker compose up -d`

- [ ] **Step 2: Force-reload the dashboard**

Open `http://localhost:41414/dashboard/` in the browser. Hard-reload (Cmd-Shift-R) to bypass cache.

- [ ] **Step 3: Walk the checklist**

Tick each item:

1. Models tab loads inside a `glass-card`; sidebar 280px on the left, main on the right.
2. Key dropdown appears at the top of the sidebar; clicking the `▾` button toggles the Options panel containing the system prompt textarea.
3. Model list is flat (no provider grouping); search filters it; `preview` models show an amber `preview` chip in the row.
4. Selecting a model:
   - Shows the model name + id in the InfoBar.
   - Upstream chip is color-coded (cyan for copilot, teal for azure, amber for custom).
   - `ctx` / `prompt` / `output` chips appear only when the underlying field is present.
   - `streaming` / `vision` / `tools` chips appear only when the corresponding `capabilities.supports.*` is true.
5. The image button is disabled (greyed out) for a non-vision model; hovering shows the `dash.playground.visionUnsupported` tooltip. Selecting a vision-capable model enables it.
6. Typing a message + pressing `Enter` sends; `Shift+Enter` inserts a newline.
7. While the assistant is streaming, the bubble shows 3 bouncing dots; once the first chunk arrives, the text replaces the dots.
8. The Stop button appears in the InfoBar while streaming and works.
9. Switching the protocol segmented control clears the chat (existing behaviour).
10. In DevTools → Network, the `chat/completions` and `messages` requests include the `x-models-playground: 1` header.
11. Switch between light and dark theme — all new chips/bubbles remain legible.

- [ ] **Step 4: Mark TaskList #27 (B Task 9) complete if everything passes**

If anything fails, report which step + screenshot, then iterate.

---

## Self-Review

**Spec coverage check** (7 confirmed decisions):
1. InfoBar chips: upstream + 3 limits + 3 capability badges → **Task 4 ✓**
2. Sidebar flat, no grouping → **Task 5 ✓** (`filtered` not `grouped`)
3. Sidebar shows `preview` chip → **Task 5 ✓** (amber preview chip in row)
4. Unsupported capability disables UI → **Task 6 ✓** (image button disabled when `!visionSupported`)
5. Hide chips when underlying field missing → **Task 4 ✓** (`{ctx && ...}`, `{supports?.vision && ...}`)
6. Add `x-models-playground: 1` header → **Task 6 ✓** (`PLAYGROUND_HEADER` constant on both fetches)
7. Mobile responsive → **deferred** — current desktop dashboard does not have a mobile layout for any tab; adding a one-off mobile layout for Models would be inconsistent. Documented here as intentional non-coverage; revisit when other tabs gain responsive layouts.

**Privacy:** No new logging anywhere. The `x-models-playground` header is a routing flag, not PII.

**Placeholder scan:** Each step has full code blocks. No "TODO" / "TBD" / "similar to". All file paths absolute. All commands exact.

**Type consistency:** `ChatPanel` prop renamed from `modelId: string` → `model: PlaygroundModel`; `ModelsTab` call site updated in Task 5; this is why Tasks 5 and 6 must be committed together.
