import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { PlaygroundModel } from "../../api/models"
import { ModelList } from "./ModelsTab"
import { playgroundModelOptions } from "./model-options"

const target: PlaygroundModel = {
  id: "gpt-target",
  name: "Target model",
  _upstream: "test-upstream",
  _provider: "custom",
  capabilities: { type: "chat", limits: { max_context_window_tokens: 128_000 } },
}
const alias: PlaygroundModel = {
  ...target,
  id: "my-chat-high-1m",
  name: "my-chat-high-1m",
  _mapped_to: "gpt-target",
}

function renderModels(models: PlaygroundModel[], selectedModelId = "") {
  return renderToStaticMarkup(
    <ModelList
      grouped={new Map([["test-upstream", models]])}
      models={models}
      modelsError={null}
      search=""
      onSearch={() => {}}
      selectedModelId={selectedModelId}
      onPick={() => {}}
      openGroups={{}}
      onToggleGroup={() => {}}
    />,
  )
}

describe("mapped models in the playground", () => {
  it("marks an added source and exposes its target before it is selected", () => {
    const html = renderModels([alias])
    expect(html).toContain("my-chat-high-1m")
    expect(html).toContain("dash.playground.mappedModel")
    expect(html).toContain("gpt-target")
  })

  it("keeps source identity as the selected model", () => {
    const html = renderModels([target, alias], "my-chat-high-1m")
    expect(html).toMatch(/class="pg-model-item is-selected"[^>]*>[\s\S]*?my-chat-high-1m/)
  })

  it("does not mark native models as mapped", () => {
    expect(renderModels([target])).not.toContain("dash.playground.mappedModel")
  })

  it("marks fullscreen options while retaining exact source IDs for chat", () => {
    expect(playgroundModelOptions([alias, target], "映射")).toEqual([
      { value: "gpt-target", label: "Target model" },
      { value: "my-chat-high-1m", label: "my-chat-high-1m", badge: "映射" },
    ])
  })
})
