import { describe, expect, test } from "bun:test"

import {
  buildGenerationsBody,
  buildImageGenerationResponse,
  DEFAULT_IMAGE_MODEL,
  extractImageGenerationConfig,
  extractPromptFromInput,
  synthImageGenerationSSE,
} from "~/services/image-generation"
import type { ResponseTool } from "~/transforms"

describe("extractImageGenerationConfig", () => {
  test("returns null when tools missing or empty", () => {
    expect(extractImageGenerationConfig(null)).toBeNull()
    expect(extractImageGenerationConfig(undefined)).toBeNull()
    expect(extractImageGenerationConfig([])).toBeNull()
  })

  test("returns null when no image_generation entry present", () => {
    const tools = [{ type: "function", name: "lookup", parameters: {}, strict: false }] as ResponseTool[]
    expect(extractImageGenerationConfig(tools)).toBeNull()
  })

  test("defaults model to gpt-image-2 when omitted", () => {
    const tools = [{ type: "image_generation" } as never] as ResponseTool[]
    expect(extractImageGenerationConfig(tools)).toEqual({ model: DEFAULT_IMAGE_MODEL })
  })

  test("extracts and whitelists known config fields", () => {
    const tools = [
      {
        type: "image_generation",
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "high",
        output_format: "png",
        background: "transparent",
        moderation: "low",
        output_compression: 80,
        rogue_field: "ignored",
      } as never,
    ] as ResponseTool[]
    expect(extractImageGenerationConfig(tools)).toEqual({
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "high",
      output_format: "png",
      background: "transparent",
      moderation: "low",
      output_compression: 80,
    })
  })

  test("last image_generation entry wins", () => {
    const tools = [
      { type: "image_generation", model: "a", size: "256x256" } as never,
      { type: "image_generation", model: "b", quality: "low" } as never,
    ] as ResponseTool[]
    expect(extractImageGenerationConfig(tools)).toEqual({ model: "b", quality: "low" })
  })

  test("rejects invalid enum values", () => {
    const tools = [
      {
        type: "image_generation",
        output_format: "gif",
        background: "rainbow",
        moderation: "strict",
      } as never,
    ] as ResponseTool[]
    expect(extractImageGenerationConfig(tools)).toEqual({ model: DEFAULT_IMAGE_MODEL })
  })
})

describe("extractPromptFromInput", () => {
  test("bare string input passes through", () => {
    expect(extractPromptFromInput("a cat")).toBe("a cat")
  })

  test("non-array, non-string returns empty", () => {
    expect(extractPromptFromInput(undefined as never)).toBe("")
  })

  test("last user message text wins", () => {
    const input = [
      { type: "message", role: "user", content: "first" },
      { type: "message", role: "assistant", content: "noise" },
      { type: "message", role: "user", content: "second" },
    ] as never
    expect(extractPromptFromInput(input)).toBe("second")
  })

  test("collects input_text + text blocks joined by newline", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "line1" },
          { type: "input_image", image_url: "x" },
          { type: "text", text: "line2" },
        ],
      },
    ] as never
    expect(extractPromptFromInput(input)).toBe("line1\nline2")
  })

  test("returns empty when no user message", () => {
    const input = [{ type: "message", role: "assistant", content: "x" }] as never
    expect(extractPromptFromInput(input)).toBe("")
  })
})

describe("buildGenerationsBody", () => {
  test("includes model, prompt, n=1 and only defined optional fields", () => {
    const body = buildGenerationsBody("hi", {
      model: "gpt-image-2",
      size: "1024x1024",
      output_format: "png",
    })
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "hi",
      n: 1,
      size: "1024x1024",
      output_format: "png",
    })
  })

  test("omits undefined optionals", () => {
    const body = buildGenerationsBody("hi", { model: "gpt-image-2" })
    expect(body).toEqual({ model: "gpt-image-2", prompt: "hi", n: 1 })
  })
})

describe("buildImageGenerationResponse", () => {
  test("success envelope carries b64 result + echo + revised_prompt", () => {
    const env = buildImageGenerationResponse("public-model", "a cat", {
      ok: true,
      b64: "AAAA",
      echo: { output_format: "png", size: "1024x1024" },
      upstreamMs: 12,
    })
    expect(env.status).toBe("completed")
    expect(env.model).toBe("public-model")
    expect(env.output).toHaveLength(1)
    const item = env.output[0] as Record<string, unknown>
    expect(item.type).toBe("image_generation_call")
    expect(item.status).toBe("completed")
    expect(item.result).toBe("AAAA")
    expect(item.revised_prompt).toBe("a cat")
    expect(item.output_format).toBe("png")
    expect(item.size).toBe("1024x1024")
  })

  test("failed envelope carries error and status=failed", () => {
    const env = buildImageGenerationResponse("public-model", "a cat", {
      ok: false,
      error: { type: "image_generation_error", code: "upstream_400", message: "boom" },
      echo: {},
      upstreamMs: 5,
    })
    expect(env.status).toBe("failed")
    const item = env.output[0] as Record<string, unknown>
    expect(item.status).toBe("failed")
    expect(item.error).toEqual({ type: "image_generation_error", code: "upstream_400", message: "boom" })
  })
})

describe("synthImageGenerationSSE", () => {
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let out = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value)
    }
    return out
  }

  test("emits full success lifecycle ending with completed + [DONE]", async () => {
    const env = buildImageGenerationResponse("m", "p", {
      ok: true,
      b64: "X",
      echo: {},
      upstreamMs: 1,
    })
    const text = await collect(synthImageGenerationSSE(env))
    expect(text).toContain("event: response.created")
    expect(text).toContain("event: response.in_progress")
    expect(text).toContain("event: response.output_item.added")
    expect(text).toContain("event: response.image_generation_call.in_progress")
    expect(text).toContain("event: response.image_generation_call.generating")
    expect(text).toContain("event: response.image_generation_call.completed")
    expect(text).toContain("event: response.output_item.done")
    expect(text).toContain("event: response.completed")
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })

  test("failed outcome skips the .completed lifecycle event", async () => {
    const env = buildImageGenerationResponse("m", "p", {
      ok: false,
      error: { type: "image_generation_error", code: "upstream_500", message: "x" },
      echo: {},
      upstreamMs: 1,
    })
    const text = await collect(synthImageGenerationSSE(env))
    expect(text).toContain("event: response.image_generation_call.generating")
    expect(text).not.toContain("event: response.image_generation_call.completed")
    expect(text).toContain("event: response.completed")
  })
})
