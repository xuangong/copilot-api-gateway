import { beforeEach, describe, expect, test } from "bun:test"

import { initImageProcessor, type ImageProcessor, type ImageSizeCalculator } from "~/image"
import {
  compressInlineImagesChatCompletions,
  compressInlineImagesMessages,
  compressInlineImagesResponses,
} from "~/transforms/compress-inline-images"
import type { AnthropicMessagesPayload, ResponsesPayload } from "~/transforms/types"

// 1×1 PNG, base64-encoded — payload content is irrelevant, the spy ignores it.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`

interface SpyProcessor extends ImageProcessor {
  calls: Array<{ size: number; targetSize: ImageSizeCalculator }>
}

const createSpyProcessor = (replacement: Uint8Array): SpyProcessor => {
  const calls: SpyProcessor["calls"] = []
  return {
    calls,
    compressToWebp(input, targetSize) {
      calls.push({ size: input.length, targetSize })
      return Promise.resolve(replacement)
    },
  }
}

const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46]) // "RIFF" bytes
const FAKE_WEBP_B64 = btoa(String.fromCharCode(...FAKE_WEBP))

let spy: SpyProcessor

beforeEach(() => {
  spy = createSpyProcessor(FAKE_WEBP)
  initImageProcessor(spy)
})

describe("compressInlineImagesMessages", () => {
  test("rewrites top-level image block and updates media_type", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.7",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const count = await compressInlineImagesMessages(payload, "claude-opus-4.7")
    expect(count).toBe(1)
    expect(spy.calls).toHaveLength(1)

    const block = (payload.messages[0]!.content as Array<{ type: string; source?: { data?: string; media_type?: string } }>)[1]!
    expect(block.source?.data).toBe(FAKE_WEBP_B64)
    expect(block.source?.media_type).toBe("image/webp")
  })

  test("recurses into tool_result.content image blocks", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "x",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const count = await compressInlineImagesMessages(payload, "claude-opus-4.7")
    expect(count).toBe(1)
  })

  test("skips url-source images and returns 0 when no inline images", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.7",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const count = await compressInlineImagesMessages(payload, "claude-opus-4.7")
    expect(count).toBe(0)
    expect(spy.calls).toHaveLength(0)
  })

  test("opus 4.7 uses the high-res cap (2576px / 3.59MP)", async () => {
    const payload = {
      model: "claude-opus-4.7",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 } },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    await compressInlineImagesMessages(payload, "claude-opus-4.7")
    // Target box is calculator-driven; a huge source should be scaled to fit cap.
    const fit = spy.calls[0]!.targetSize({ width: 10_000, height: 10_000 })
    expect(Math.max(fit.width, fit.height)).toBeLessThanOrEqual(2576)
  })

  test("non-high-res claude uses the standard cap (1568px)", async () => {
    const payload = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 } },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    await compressInlineImagesMessages(payload, "claude-sonnet-4-6")
    const fit = spy.calls[0]!.targetSize({ width: 10_000, height: 10_000 })
    expect(Math.max(fit.width, fit.height)).toBeLessThanOrEqual(1568)
  })
})

describe("compressInlineImagesChatCompletions", () => {
  test("rewrites base64 image_url parts and leaves https references untouched", async () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
            { type: "image_url", image_url: { url: "https://example.com/x.png" } },
          ],
        },
      ],
    }

    const count = await compressInlineImagesChatCompletions(payload, "gpt-4.1")
    expect(count).toBe(1)

    const parts = payload.messages[0]!.content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts[1]!.image_url!.url).toBe(`data:image/webp;base64,${FAKE_WEBP_B64}`)
    expect(parts[2]!.image_url!.url).toBe("https://example.com/x.png")
  })

  test("gpt-4.1 uses tile cap (2048×768)", async () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URL } }] },
      ],
    }
    await compressInlineImagesChatCompletions(payload, "gpt-4.1")
    const fit = spy.calls[0]!.targetSize({ width: 10_000, height: 10_000 })
    expect(fit.width).toBeLessThanOrEqual(2048)
    expect(fit.height).toBeLessThanOrEqual(768)
  })

  test("returns 0 when no inline images", async () => {
    const payload = {
      messages: [{ role: "user", content: "plain text" }],
    }
    const count = await compressInlineImagesChatCompletions(payload, "gpt-4.1")
    expect(count).toBe(0)
  })
})

describe("compressInlineImagesResponses", () => {
  test("rewrites input_image inside message.content", async () => {
    const payload: ResponsesPayload = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hi" },
            { type: "input_image", image_url: TINY_PNG_DATA_URL },
          ],
        },
      ],
    } as unknown as ResponsesPayload

    const count = await compressInlineImagesResponses(payload, "gpt-5")
    expect(count).toBe(1)

    const part = (payload.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]!
      .content[1]!
    expect(part.image_url).toBe(`data:image/webp;base64,${FAKE_WEBP_B64}`)
  })

  test("rewrites input_image inside function_call_output.output", async () => {
    const payload: ResponsesPayload = {
      input: [
        {
          type: "function_call_output",
          call_id: "x",
          output: [{ type: "input_image", image_url: TINY_PNG_DATA_URL }],
        },
      ],
    } as unknown as ResponsesPayload

    const count = await compressInlineImagesResponses(payload, "gpt-5")
    expect(count).toBe(1)
  })

  test("skips https image_url and returns 0", async () => {
    const payload: ResponsesPayload = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.com/x.png" }],
        },
      ],
    } as unknown as ResponsesPayload

    const count = await compressInlineImagesResponses(payload, "gpt-5")
    expect(count).toBe(0)
    expect(spy.calls).toHaveLength(0)
  })
})

describe("InMemoryImageProcessor (passthrough)", () => {
  test("returns input bytes unchanged via inline helper", async () => {
    const { createInMemoryImageProcessor, compressBase64ImageToWebp } = await import("~/image")
    initImageProcessor(createInMemoryImageProcessor())
    const result = await compressBase64ImageToWebp(TINY_PNG_B64, (s) => s)
    expect(result).toBe(TINY_PNG_B64)
  })
})
