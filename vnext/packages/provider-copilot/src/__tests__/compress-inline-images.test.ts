/**
 * Responses-side inline image compression.
 *
 * The case that matters here is `custom_tool_call_output`. Codex's local
 * image extension replays every image it has generated this session as an
 * `input_image` under that item type, so a handful of 1024×1024 PNGs is tens
 * of megabytes of base64 — which the walker used to skip entirely, and which
 * GitHub Copilot answers with a 413 "failed to parse request".
 */
import { afterEach, expect, test } from "bun:test"
import {
  __resetPlatformForTests,
  initImageProcessor,
  type ImageSizeCalculator,
} from "@vibe-core/platform"
import { compressInlineImagesResponses } from "../transforms/compress-inline-images"
import type { ResponsesPayload } from "../transforms/types"

const decode = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Real 1×1 PNG, so `image-size` can read dimensions the way it would in prod.
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII="
const PNG_1x1_URL = `data:image/png;base64,${PNG_1x1_B64}`
const WEBP_BYTES = decode("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAEAcQERGIiP4HAA==")

/** Stands in for a real encoder: always returns fresh (≠ input) WebP bytes. */
const installEncoder = (): { calls: Uint8Array[] } => {
  const calls: Uint8Array[] = []
  initImageProcessor({
    compressToWebp(input: Uint8Array, _targetSize: ImageSizeCalculator) {
      calls.push(input)
      return Promise.resolve(WEBP_BYTES)
    },
  })
  return { calls }
}

/** The stub shipped in local Bun dev: no codec, returns input by reference. */
const installPassthrough = (): void => {
  initImageProcessor({
    compressToWebp: (input: Uint8Array) => Promise.resolve(input),
  })
}

afterEach(() => {
  __resetPlatformForTests()
})

const imagePart = () => ({ type: "input_image", image_url: PNG_1x1_URL })

const payloadWith = (item: unknown): ResponsesPayload =>
  ({ model: "gpt-5.5", input: [item] }) as unknown as ResponsesPayload

test("compresses images parked under custom_tool_call_output", async () => {
  installEncoder()
  const payload = payloadWith({
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [{ type: "input_text", text: "generated" }, imagePart()],
  })

  expect(await compressInlineImagesResponses(payload, "gpt-5.5")).toBe(1)

  const parts = (payload.input as unknown as { output: { image_url?: string }[] }[])[0]!.output
  expect(parts[1]!.image_url).toStartWith("data:image/webp;base64,")
})

test("still compresses message content and function_call_output", async () => {
  installEncoder()
  const payload = {
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [imagePart()] },
      { type: "function_call_output", call_id: "c", output: [imagePart()] },
    ],
  } as unknown as ResponsesPayload

  expect(await compressInlineImagesResponses(payload, "gpt-5.5")).toBe(2)
})

test("a second pass over the same payload re-encodes nothing", async () => {
  // The server-tool shim loops (`while (true)` → `run()`), so this boundary is
  // reached again on every ReAct turn with the same in-place-mutated payload.
  // Without the marker each turn would lossily re-encode its own WebP output.
  const { calls } = installEncoder()
  const payload = payloadWith({
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [imagePart()],
  })

  expect(await compressInlineImagesResponses(payload, "gpt-5.5")).toBe(1)
  expect(await compressInlineImagesResponses(payload, "gpt-5.5")).toBe(0)
  expect(calls).toHaveLength(1)
})

test("the marker is non-enumerable, so it never reaches the upstream JSON", async () => {
  installEncoder()
  const payload = payloadWith({
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [imagePart()],
  })
  await compressInlineImagesResponses(payload, "gpt-5.5")

  const part = (payload.input as unknown as { output: unknown[] }[])[0]!.output[0]!
  expect(Object.keys(part as object)).toEqual(["type", "image_url"])
  expect(JSON.parse(JSON.stringify(part))).toHaveProperty("image_url")
})

test("a remote https image is left alone", async () => {
  const { calls } = installEncoder()
  const payload = payloadWith({
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [{ type: "input_image", image_url: "https://example.com/cat.png" }],
  })

  expect(await compressInlineImagesResponses(payload, "gpt-5.5")).toBe(0)
  expect(calls).toHaveLength(0)
})

test("a passthrough processor leaves the data URL as PNG", async () => {
  // Local dev has no WebP codec; rewriting the media type without rewriting
  // the bytes would hand strict upstreams a mislabelled image.
  installPassthrough()
  const payload = payloadWith({
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [imagePart()],
  })

  expect(await compressInlineImagesResponses(payload, "gpt-5.5")).toBe(1)
  const part = (payload.input as unknown as { output: { image_url: string }[] }[])[0]!.output[0]!
  expect(part.image_url).toBe(PNG_1x1_URL)
})
