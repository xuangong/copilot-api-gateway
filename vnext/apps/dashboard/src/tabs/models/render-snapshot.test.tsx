/**
 * Characterisation snapshots for the playground's render output.
 *
 * Written against the unrefactored ChatPanel so a pure-refactor split can be
 * checked byte for byte: the snapshots must pass unchanged after any change
 * that claims not to alter markup. Restyle work updates them on purpose.
 *
 * `renderToStaticMarkup` runs no effects and no event handlers, so these cover
 * the first render from seeded storage only. Not covered here, because only an
 * effect, a stream or a user action can reach them:
 *   - streaming (topbar "generating" dots, Stop buttons, stop-style send
 *     button, the empty assistant bubble's dots);
 *   - the error banner with Retry, the compaction notice, the image-insert
 *     error line;
 *   - the zoom overlay, "Copied", expanded source lists;
 *   - a non-empty composer (`data-empty` absent) and `hasReference`;
 *   - token counts from count_tokens (`ctxCounting`, a known count, the
 *     pressure-coloured `pg-ctx-*` readout) — the readout here is always the
 *     "no count yet" form;
 *   - images re-hydrated from IndexedDB;
 *   - DecisionPanel/EmbeddingPanel results and in-flight sending.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { PlaygroundModel } from "../../api/models"
import { ChatPanel } from "./ChatPanel"
import { DecisionPanel } from "./DecisionPanel"
import { EmbeddingPanel } from "./EmbeddingPanel"
import { DEFAULT_IMAGE_PARAMS } from "./images"
import { MarkdownSanitizer } from "./markdown"
import { TooltipProvider } from "../../ui/tooltip"
import { ModelList } from "./ModelsTab"
import type { VisionSupport } from "./vision"

// —— Browser stubs ——
// Only what the first render reads: `localStorage` for the persisted state and
// a bare `window` (DecisionPanel/EmbeddingPanel read `window.__lang`). Installed
// for this file only, so other suites keep their window-less environment.

const store = new Map<string, string>()
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
}

const g = globalThis as Record<string, unknown>
const hadWindow = "window" in g
const hadLocalStorage = "localStorage" in g
const originalWindow = g.window
const originalLocalStorage = g.localStorage

beforeAll(() => {
  g.window = {}
  g.localStorage = localStorageStub
})

afterAll(() => {
  if (hadWindow) g.window = originalWindow
  else delete g.window
  if (hadLocalStorage) g.localStorage = originalLocalStorage
  else delete g.localStorage
})

// DOMPurify needs a real DOM and, without one, has no `sanitize` at all. Pass
// the HTML through: these snapshots pin our markup, not DOMPurify's.
const passThrough = (html: string) => html

// —— Seeded chat history ——

const PNG = "data:image/png;base64,iVBORw0KGgo="

const MESSAGES = [
  // Legacy user turn: text only, no parts.
  { role: "user", text: "Hello there" },
  {
    role: "assistant",
    text: "Here is **bold** and a list:\n\n- one\n- two\n\n```ts\nconst x = 1\n```",
    model: "Claude Sonnet",
    usage: { input_tokens: 12, output_tokens: 34 },
    durationMs: 1500,
    webSearches: [
      { id: "ws_0", status: "completed", query: "sse streaming" },
      { id: "ws_1", status: "searching", query: "debounce" },
      { id: "ws_2", status: "in_progress" },
    ],
    citations: [
      { url: "https://www.example.com/a", title: "Example A" },
      { url: "https://example.org/b" },
      { url: "https://docs.example.net/c", title: "Docs C" },
      { url: "https://example.com/d", title: "D" },
      { url: "https://example.com/e", title: "E" },
    ],
  },
  // User turn with ordered parts: text, a stored image, and one whose bytes are gone.
  {
    role: "user",
    text: "Look at these",
    parts: [
      { type: "text", text: "Look at these" },
      { type: "image", dataUrl: PNG, id: "img1" },
      { type: "image", dataUrl: "", id: "img-missing" },
    ],
  },
  // Assistant with browser performance and usage.
  {
    role: "assistant",
    text: "Plain answer",
    model: "gpt-4o",
    usage: { input_tokens: 100, output_tokens: 200 },
    durationMs: 2400,
    performance: {
      outcome: "success",
      responses: 1,
      outputChunks: 5,
      metrics: { totalMs: 2400, ttftMs: 320, inputTokens: 101, outputTokens: 202, overallTps: 84 },
    },
  },
  { role: "user", text: "Draw a cat", parts: [{ type: "text", text: "Draw a cat" }] },
  // Image-model reply: generated image parts, usage only.
  {
    role: "assistant",
    text: "",
    model: "gpt-image-1",
    parts: [{ type: "image", dataUrl: PNG, id: "gen1" }],
    usage: { input_tokens: 7, output_tokens: 0 },
    durationMs: 9000,
  },
]

const MODEL_OPTIONS = [
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "alias-model", label: "alias-model", badge: "mapped" },
]

function seedChat(messages: unknown[] | null, protocol: string | null = null) {
  store.clear()
  if (messages) store.set("playground.messages", JSON.stringify(messages))
  if (protocol) store.set("playground.protocol", protocol)
}

function renderChat(opts: {
  mode: "chat" | "image" | undefined
  vision?: VisionSupport
  contextWindow?: number
  fullscreen?: boolean
}) {
  // The app shell supplies the provider the retract tooltip needs; neither
  // provider adds markup.
  return renderToStaticMarkup(
    <MarkdownSanitizer.Provider value={passThrough}>
      <TooltipProvider>
        <ChatPanel
          modelId="gpt-4o"
          apiKey="sk-test"
          systemPrompt=""
          webSearchEnabled={false}
          vision={opts.vision ?? "yes"}
          contextWindow={opts.contextWindow}
          modelOptions={MODEL_OPTIONS}
          onPickModel={() => {}}
          mode={opts.mode}
          imageParams={DEFAULT_IMAGE_PARAMS}
          onImageParamsChange={() => {}}
          defaultFullscreen={opts.fullscreen}
        />
      </TooltipProvider>
    </MarkdownSanitizer.Provider>,
  )
}

describe("ChatPanel", () => {
  test.each(["chat", "image", undefined] as const)("seeded thread, mode %p", (mode) => {
    seedChat(MESSAGES)
    expect(renderChat({ mode, contextWindow: 128_000 })).toMatchSnapshot()
  })

  test.each(["yes", "unknown", "no", "yes-but-rejected"] as const)("vision %p", (vision) => {
    seedChat(MESSAGES.slice(0, 2))
    expect(renderChat({ mode: "chat", vision })).toMatchSnapshot()
  })

  test("empty thread", () => {
    seedChat(null)
    expect(renderChat({ mode: "chat" })).toMatchSnapshot()
  })

  test("empty thread, image mode", () => {
    seedChat([])
    expect(renderChat({ mode: "image" })).toMatchSnapshot()
  })

  test("persisted protocol (anthropic) and a dangling empty assistant bubble", () => {
    seedChat([...MESSAGES.slice(0, 3), { role: "assistant", text: "" }], "anthropic")
    expect(renderChat({ mode: "chat" })).toMatchSnapshot()
  })

  test("fullscreen restores the overlay and the model picker", () => {
    seedChat(MESSAGES.slice(0, 2))
    expect(renderChat({ mode: "chat", fullscreen: true })).toMatchSnapshot()
  })
})

// —— ModelList ——

const chatModel: PlaygroundModel = {
  id: "gpt-4o",
  name: "GPT-4o",
  _upstream: "up-a",
  _provider: "custom",
  capabilities: { type: "chat", limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_384 } },
}
const mappedModel: PlaygroundModel = {
  ...chatModel,
  id: "alias-model",
  name: "alias-model",
  _mapped_to: "gpt-4o",
}
const imageModel: PlaygroundModel = {
  id: "gpt-image-1",
  _upstream: "up-a",
  _provider: "custom",
  capabilities: { type: "image" } as PlaygroundModel["capabilities"],
}
const bareModel: PlaygroundModel = { id: "no-caps", _upstream: "up-b", _provider: "custom" }

function renderList(selectedModelId: string, openGroups: Record<string, boolean>, models: PlaygroundModel[] | null = [chatModel, mappedModel, imageModel, bareModel], modelsError: string | null = null) {
  const grouped = new Map<string, PlaygroundModel[]>()
  for (const m of models ?? []) grouped.set(m._upstream, [...(grouped.get(m._upstream) ?? []), m])
  return renderToStaticMarkup(
    <ModelList
      grouped={grouped}
      models={models}
      modelsError={modelsError}
      search="gp"
      onSearch={() => {}}
      selectedModelId={selectedModelId}
      onPick={() => {}}
      openGroups={openGroups}
      onToggleGroup={() => {}}
    />,
  )
}

describe("ModelList", () => {
  test("nothing selected, all groups open", () => {
    expect(renderList("", {})).toMatchSnapshot()
  })
  test("mapped model selected, second group collapsed", () => {
    expect(renderList("alias-model", { "up-b": false })).toMatchSnapshot()
  })
  test("loading", () => {
    expect(renderList("", {}, null)).toMatchSnapshot()
  })
  test("error", () => {
    expect(renderList("", {}, [], "boom")).toMatchSnapshot()
  })
})

// —— DecisionPanel ——

const DECISION_DRAFT = {
  state: "A customer writes in asking for a refund on a damaged item.",
  questions: [
    {
      id: "q1", type: "yesno", name: "refund", instructions: "Should we refund?",
      criteriaTrue: "Item damaged", criteriaFalse: "Item fine", options: [], levels: [],
    },
    {
      id: "q2", type: "choice", name: "channel", instructions: "Which channel?",
      criteriaTrue: "", criteriaFalse: "",
      options: [{ value: "email", description: "Send an email" }, { value: "phone", description: "" }],
      levels: [],
    },
    {
      id: "q3", type: "score", name: "urgency", instructions: "",
      criteriaTrue: "", criteriaFalse: "", options: [], levels: ["low", "medium", "high"],
    },
  ],
}

describe("DecisionPanel", () => {
  test("seeded draft, System One model", () => {
    store.clear()
    store.set("playground.decisionDraft", JSON.stringify(DECISION_DRAFT))
    expect(renderToStaticMarkup(
      <DecisionPanel modelId="decider" apiKey="sk" supportedEndpoints={["/v1/systemone"]} />,
    )).toMatchSnapshot()
  })

  test("seeded draft, OpenAI Decisions model (instructions missing → problem)", () => {
    store.clear()
    store.set("playground.decisionDraft", JSON.stringify(DECISION_DRAFT))
    expect(renderToStaticMarkup(
      <DecisionPanel modelId="decider" apiKey="sk" supportedEndpoints={["/v1/decisions"]} />,
    )).toMatchSnapshot()
  })

  test("no draft falls back to the first example", () => {
    store.clear()
    expect(renderToStaticMarkup(
      <DecisionPanel modelId="decider" apiKey="sk" supportedEndpoints={undefined} />,
    )).toMatchSnapshot()
  })
})

// —— EmbeddingPanel ——

describe("EmbeddingPanel", () => {
  test("seeded draft", () => {
    store.clear()
    store.set("playground.embeddingDraft", JSON.stringify({ text: "cats\ndogs\nstocks", dimensions: "256" }))
    expect(renderToStaticMarkup(<EmbeddingPanel modelId="embed" apiKey="sk" />)).toMatchSnapshot()
  })

  test("seeded draft with invalid dimensions", () => {
    store.clear()
    store.set("playground.embeddingDraft", JSON.stringify({ text: "only one", dimensions: "abc" }))
    expect(renderToStaticMarkup(<EmbeddingPanel modelId="embed" apiKey="sk" />)).toMatchSnapshot()
  })

  test("no draft falls back to the first example", () => {
    store.clear()
    expect(renderToStaticMarkup(<EmbeddingPanel modelId="embed" apiKey="sk" />)).toMatchSnapshot()
  })
})
