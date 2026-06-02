import { describe, expect, test } from "bun:test"

import {
  buildEditsForm,
  buildGenerationsBody,
  buildImageGenerationResponse,
  collectImageSources,
  decodeInlineImage,
  DEFAULT_IMAGE_MODEL,
  editSupportedMime,
  extractImageGenerationConfig,
  extractPromptFromInput,
  synthImageGenerationSSE,
  validateImageGenerationConfig,
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

describe("editSupportedMime", () => {
  test("canonicalizes aliases", () => {
    expect(editSupportedMime("image/jpg")).toBe("image/jpeg")
    expect(editSupportedMime("image/pjpeg")).toBe("image/jpeg")
    expect(editSupportedMime("image/x-png")).toBe("image/png")
  })
  test("passes through canonical supported mimes", () => {
    expect(editSupportedMime("image/png")).toBe("image/png")
    expect(editSupportedMime("image/jpeg")).toBe("image/jpeg")
    expect(editSupportedMime("image/webp")).toBe("image/webp")
  })
  test("rejects unsupported mimes", () => {
    expect(editSupportedMime("image/gif")).toBeNull()
    expect(editSupportedMime("application/octet-stream")).toBeNull()
  })
})

describe("decodeInlineImage", () => {
  test("decodes a data:base64 URL with mime", () => {
    const png = "iVBORw0KGgo="
    const src = decodeInlineImage(`data:image/png;base64,${png}`)
    expect(src).not.toBeNull()
    expect(src!.mimeType).toBe("image/png")
    expect(src!.bytes.byteLength).toBe(8)
  })
  test("treats bare base64 as png by default", () => {
    const src = decodeInlineImage("AAAA")
    expect(src).not.toBeNull()
    expect(src!.mimeType).toBe("image/png")
  })
  test("returns null for remote http(s) URLs", () => {
    expect(decodeInlineImage("https://example.com/x.png")).toBeNull()
  })
  test("returns null for non-base64 data URL", () => {
    expect(decodeInlineImage("data:image/png,raw")).toBeNull()
  })
})

describe("collectImageSources", () => {
  test("returns empty for non-array input", () => {
    expect(collectImageSources("hi")).toEqual([])
    expect(collectImageSources(undefined as never)).toEqual([])
  })
  test("collects input_image blocks in declaration order", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "edit these" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_image", image_url: "data:image/jpeg;base64,/9j/" },
        ],
      },
    ] as never
    const sources = collectImageSources(input)
    expect(sources).toHaveLength(2)
    expect(sources[0]!.mimeType).toBe("image/png")
    expect(sources[1]!.mimeType).toBe("image/jpeg")
  })
  test("skips http(s) image_url references", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "https://example.com/x.png" }],
      },
    ] as never
    expect(collectImageSources(input)).toEqual([])
  })
})

describe("buildEditsForm", () => {
  const png = new Uint8Array([1, 2, 3, 4]).buffer
  test("emits required fields, model, and image[] parts", async () => {
    const form = buildEditsForm("a cat", { model: "gpt-image-2", size: "1024x1024" }, [
      { bytes: png, mimeType: "image/png" },
    ])
    expect(form.get("model")).toBe("gpt-image-2")
    expect(form.get("prompt")).toBe("a cat")
    expect(form.get("n")).toBe("1")
    expect(form.get("size")).toBe("1024x1024")
    const files = form.getAll("image[]")
    expect(files).toHaveLength(1)
    const f = files[0] as File
    expect(f.type).toBe("image/png")
    expect(f.name).toBe("image_0.png")
  })
  test("attaches multiple sources as repeated image[] parts in order", () => {
    const form = buildEditsForm("p", { model: "gpt-image-2" }, [
      { bytes: png, mimeType: "image/jpeg" },
      { bytes: png, mimeType: "image/webp" },
    ])
    const files = form.getAll("image[]") as File[]
    expect(files).toHaveLength(2)
    expect(files[0]!.type).toBe("image/jpeg")
    expect(files[0]!.name).toBe("image_0.jpg")
    expect(files[1]!.type).toBe("image/webp")
    expect(files[1]!.name).toBe("image_1.webp")
  })
  test("omits undefined optional fields", () => {
    const form = buildEditsForm("p", { model: "gpt-image-2" }, [
      { bytes: png, mimeType: "image/png" },
    ])
    expect(form.get("size")).toBeNull()
    expect(form.get("quality")).toBeNull()
    expect(form.get("background")).toBeNull()
  })
})

describe("validateImageGenerationConfig (Azure-strict)", () => {
  test("rejects unknown parameter with tools[i].field path", () => {
    const r = validateImageGenerationConfig([
      { type: "image_generation", bogus: 1 } as never,
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("unknown_parameter")
      expect(r.error.param).toBe("tools[0].bogus")
    }
  })
  test("rejects size outside ALLOWED_SIZES", () => {
    const r = validateImageGenerationConfig([
      { type: "image_generation", size: "512x512" } as never,
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_value")
      expect(r.error.param).toBe("tools[0].size")
    }
  })
  test("rejects output_compression < 0 with distinct code", () => {
    const r = validateImageGenerationConfig([
      { type: "image_generation", output_compression: -1 } as never,
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("integer_below_min_value")
  })
  test("rejects output_compression > 100 with distinct code", () => {
    const r = validateImageGenerationConfig([
      { type: "image_generation", output_compression: 101 } as never,
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("integer_above_max_value")
  })
  test("earlier-entry error rejects even when later entry is valid", () => {
    const r = validateImageGenerationConfig([
      { type: "image_generation", quality: "ultra" } as never,
      { type: "image_generation", quality: "high" } as never,
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.param).toBe("tools[0].quality")
  })
  test("last valid entry wins on success", () => {
    const r = validateImageGenerationConfig([
      { type: "image_generation", size: "1024x1024" } as never,
      { type: "image_generation", model: "gpt-image-2", quality: "high" } as never,
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toEqual({ model: "gpt-image-2", quality: "high" })
  })
  test("missing image_generation entry returns ok:false", () => {
    const r = validateImageGenerationConfig([{ type: "function", name: "x" } as never])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.param).toBe("tools")
  })
  test("defaults model when absent", () => {
    const r = validateImageGenerationConfig([{ type: "image_generation" } as never])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.model).toBe(DEFAULT_IMAGE_MODEL)
  })
})
