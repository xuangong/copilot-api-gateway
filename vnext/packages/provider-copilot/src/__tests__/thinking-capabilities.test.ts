import { test, expect, describe, beforeEach } from "bun:test"
import { clearRawModelsCache } from "../raw-models-cache"
import { thinkingCapabilitiesFor } from "../variants"
import { createVariantAndBetaFilteringInterceptor } from "../interceptors/shared/with-variant-and-beta-filtering"
import type { Model, ModelsResponse, ModelSupports } from "../models"
import type { Fetcher } from "@vibe-core/upstream"

/**
 * Capability shapes below mirror a live Copilot `/models` read on 2026-08-24
 * (individual tenant): claude-opus-5 advertises both adaptive_thinking and
 * reasoning_effort; claude-haiku-4.5 advertises neither.
 */
const model = (id: string, supports: ModelSupports): Model => ({
  id,
  name: id,
  object: "model",
  vendor: "Anthropic",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  capabilities: {
    family: "claude",
    limits: {},
    object: "model_capabilities",
    supports,
    tokenizer: "o200k",
    type: "chat",
  },
})

const ADAPTIVE: ModelSupports = {
  adaptive_thinking: true,
  reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
  streaming: true,
  tool_calls: true,
}
const NO_REASONING: ModelSupports = { streaming: true, tool_calls: true }

const catalog = (...models: Model[]): ModelsResponse => ({ object: "list", data: models })

describe("thinkingCapabilitiesFor", () => {
  test("reads the capabilities of an exactly-matching id", () => {
    const caps = thinkingCapabilitiesFor(
      catalog(model("claude-opus-5", ADAPTIVE)),
      "claude-opus-5",
    )
    expect(caps).toEqual({ adaptiveThinking: true, reasoningEffort: true })
  })

  test("reports a model that advertises neither key", () => {
    const caps = thinkingCapabilitiesFor(
      catalog(model("claude-haiku-4.5", NO_REASONING)),
      "claude-haiku-4.5",
    )
    expect(caps).toEqual({ adaptiveThinking: false, reasoningEffort: false })
  })

  test("resolves a variant id back onto its base entry", () => {
    // The resolved upstream id is the `-1m-internal` sibling; its own entry is
    // what the catalog carries, and it must still be found.
    const caps = thinkingCapabilitiesFor(
      catalog(model("claude-opus-5", ADAPTIVE), model("claude-opus-5-1m-internal", ADAPTIVE)),
      "claude-opus-5-1m-internal",
    )
    expect(caps).toEqual({ adaptiveThinking: true, reasoningEffort: true })
  })

  test("unions across the variant group so a bare sibling cannot mask support", () => {
    // Deliberate: `-high` here omits reasoning_effort. Taking that entry alone
    // would strip output_config from a model that plainly supports it.
    const caps = thinkingCapabilitiesFor(
      catalog(model("claude-opus-5", ADAPTIVE), model("claude-opus-5-high", NO_REASONING)),
      "claude-opus-5-high",
    )
    expect(caps).toEqual({ adaptiveThinking: true, reasoningEffort: true })
  })

  test("normalizes Anthropic's dash-versioned ids onto the Copilot form", () => {
    const caps = thinkingCapabilitiesFor(
      catalog(model("claude-opus-4.7", ADAPTIVE)),
      "claude-opus-4-7",
    )
    expect(caps).toEqual({ adaptiveThinking: true, reasoningEffort: true })
  })

  test("returns undefined for a non-Claude model", () => {
    expect(thinkingCapabilitiesFor(catalog(model("claude-opus-5", ADAPTIVE)), "gpt-5")).toBeUndefined()
  })

  test("returns undefined when the catalog has no entry for the id", () => {
    expect(
      thinkingCapabilitiesFor(catalog(model("claude-opus-5", ADAPTIVE)), "claude-nonesuch-9"),
    ).toBeUndefined()
  })
})

const modelsFetcher = (models: ModelsResponse): Fetcher =>
  async (url) => {
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify(models), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }

const runVariantInterceptor = async (
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  models: ModelsResponse,
  token: string,
): Promise<void> => {
  const interceptor = createVariantAndBetaFilteringInterceptor(
    () => token,
    "individual",
    () => undefined,
    modelsFetcher(models),
  )
  const inv = {
    endpoint: "messages" as const,
    enabledFlags: new Set<string>(),
    sourceApi: "messages" as const,
    payload,
    headers,
  }
  await interceptor(inv, { requestStartedAt: Date.now() }, async () => new Response("{}"))
}

describe("thinking adaptation inside the variant interceptor", () => {
  beforeEach(() => {
    clearRawModelsCache()
  })

  test("converts claude-opus-5 from thinking.type=enabled to adaptive", async () => {
    const payload: Record<string, unknown> = {
      model: "claude-opus-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    }
    await runVariantInterceptor(payload, {}, catalog(model("claude-opus-5", ADAPTIVE)), "tok-opus5")

    const thinking = payload.thinking as { type?: string; budget_tokens?: number }
    expect(thinking.type).toBe("adaptive")
    expect(thinking.budget_tokens).toBeUndefined()
    expect((payload.output_config as { effort?: string }).effort).toBe("medium")
  })

  test("drops interleaved-thinking once the payload has been adapted", async () => {
    // Ordering regression guard: the beta filter reads `thinking.type`, so the
    // adaptation must already have run when it does. When adaptation lived in a
    // later interceptor the filter still saw `enabled` and kept the beta.
    const payload: Record<string, unknown> = {
      model: "claude-opus-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    }
    const headers: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    }
    await runVariantInterceptor(payload, headers, catalog(model("claude-opus-5", ADAPTIVE)), "tok-beta")

    expect(headers["anthropic-beta"]).toBeUndefined()
  })

  test("strips output_config for a model advertising no reasoning_effort", async () => {
    const payload: Record<string, unknown> = {
      model: "claude-haiku-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }
    await runVariantInterceptor(payload, {}, catalog(model("claude-haiku-4.5", NO_REASONING)), "tok-haiku")

    expect(payload.output_config).toBeUndefined()
    const thinking = payload.thinking as { type?: string; budget_tokens?: number }
    expect(thinking.type).toBe("enabled")
    expect(thinking.budget_tokens).toBe(1024)
  })
})
