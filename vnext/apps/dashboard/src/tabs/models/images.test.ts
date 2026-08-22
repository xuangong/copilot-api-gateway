import { describe, expect, it } from "bun:test"
import type { Part } from "./parts"
import {
  buildEditsForm,
  playgroundMode,
  buildImageContext,
  buildGenerationsBody,
  DEFAULT_IMAGE_PARAMS,
  dataUrlToBlob,
  imagesErrorMessage,
  parseImagesResponse,
  type ImageParams,
} from "./images"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const JPG = "data:image/jpeg;base64,/9j/4AAQ"
const params = (over: Partial<ImageParams> = {}): ImageParams => ({ ...DEFAULT_IMAGE_PARAMS, ...over })
const image = (dataUrl: string): Part => ({ type: "image", dataUrl })

describe("buildGenerationsBody", () => {
  it("always carries model, prompt and n", () => {
    expect(buildGenerationsBody("gpt-image-2", "a cat", params({ n: 3 }))).toMatchObject({
      model: "gpt-image-2",
      prompt: "a cat",
      n: 3,
    })
  })

  // `auto` is the upstream's own default; sending the literal string risks a
  // provider that doesn't accept it as an enum member.
  it("omits fields left on auto", () => {
    const body = buildGenerationsBody("m", "p", params({
      size: "auto", quality: "auto", background: "auto", outputFormat: "auto",
    }))
    expect("size" in body).toBe(false)
    expect("quality" in body).toBe(false)
    expect("background" in body).toBe(false)
    expect("output_format" in body).toBe(false)
  })

  it("passes explicit choices through under their wire names", () => {
    expect(buildGenerationsBody("m", "p", params({
      size: "1024x1536", quality: "high", background: "transparent", outputFormat: "webp",
    }))).toMatchObject({
      size: "1024x1536",
      quality: "high",
      background: "transparent",
      output_format: "webp",
    })
  })

  it("never sends input_fidelity, which only exists for edits", () => {
    expect("input_fidelity" in buildGenerationsBody("m", "p", params({ inputFidelity: "high" })))
      .toBe(false)
  })
})

describe("buildEditsForm", () => {
  const entries = (f: FormData) => [...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).type}`])

  it("names a single reference `image`", () => {
    const f = buildEditsForm("m", "p", params(), [image(PNG)])
    expect(entries(f)).toContainEqual(["image", "file:image/png"])
  })

  // OpenAI's gpt-image contract, mirrored from provider-llm/src/images.ts.
  it("names multiple references `image[]`", () => {
    const f = buildEditsForm("m", "p", params(), [image(PNG), image(JPG)])
    const keys = [...f.keys()]
    expect(keys.filter((k) => k === "image[]").length).toBe(2)
    expect(keys).not.toContain("image")
  })

  it("carries model, prompt and n as string fields", () => {
    const f = buildEditsForm("m", "a cat", params({ n: 2 }), [image(PNG)])
    expect(f.get("model")).toBe("m")
    expect(f.get("prompt")).toBe("a cat")
    expect(f.get("n")).toBe("2")
  })

  it("omits fields left on auto", () => {
    const f = buildEditsForm("m", "p", params({ size: "auto", quality: "auto", inputFidelity: "auto" }), [image(PNG)])
    expect(f.has("size")).toBe(false)
    expect(f.has("quality")).toBe(false)
    expect(f.has("input_fidelity")).toBe(false)
  })

  it("sends input_fidelity when set, since edits accept it", () => {
    const f = buildEditsForm("m", "p", params({ inputFidelity: "high" }), [image(PNG)])
    expect(f.get("input_fidelity")).toBe("high")
  })

  it("skips parts that carry no bytes", () => {
    const f = buildEditsForm("m", "p", params(), [{ type: "image", dataUrl: "" }, image(PNG)])
    expect([...f.keys()].filter((k) => k.startsWith("image")).length).toBe(1)
  })
})

describe("dataUrlToBlob", () => {
  it("recovers the declared mime type", () => {
    expect(dataUrlToBlob(JPG)!.type).toBe("image/jpeg")
  })

  it("recovers the bytes", async () => {
    const bytes = new Uint8Array(await dataUrlToBlob("data:image/png;base64,AAEC")!.arrayBuffer())
    expect([...bytes]).toEqual([0, 1, 2])
  })

  it("returns null for anything that is not a data url", () => {
    expect(dataUrlToBlob("https://example.com/a.png")).toBeNull()
  })
})

describe("parseImagesResponse", () => {
  it("turns each b64_json into an image part, in order", () => {
    const out = parseImagesResponse({
      output_format: "png",
      data: [{ b64_json: "AAA" }, { b64_json: "BBB" }],
    })
    expect(out.parts).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", dataUrl: "data:image/png;base64,BBB" },
    ])
  })

  it("uses the response's output_format for the mime type", () => {
    expect(parseImagesResponse({ output_format: "webp", data: [{ b64_json: "AAA" }] }).parts)
      .toEqual([{ type: "image", dataUrl: "data:image/webp;base64,AAA" }])
  })

  it("defaults to png when the response omits output_format", () => {
    expect(parseImagesResponse({ data: [{ b64_json: "AAA" }] }).parts)
      .toEqual([{ type: "image", dataUrl: "data:image/png;base64,AAA" }])
  })

  it("passes a url-shaped result straight through", () => {
    expect(parseImagesResponse({ data: [{ url: "https://x/y.png" }] }).parts)
      .toEqual([{ type: "image", dataUrl: "https://x/y.png" }])
  })

  it("maps usage onto the shape the chat bubbles already render", () => {
    expect(parseImagesResponse({ data: [], usage: { input_tokens: 9, output_tokens: 196 } }).usage)
      .toEqual({ input_tokens: 9, output_tokens: 196 })
  })

  it("leaves usage undefined when the upstream reports none", () => {
    expect(parseImagesResponse({ data: [{ b64_json: "AAA" }] }).usage).toBeUndefined()
  })

  it("returns no parts for an empty result rather than throwing", () => {
    expect(parseImagesResponse({}).parts).toEqual([])
  })
})

describe("imagesErrorMessage", () => {
  it("reads a plain error body", () => {
    expect(imagesErrorMessage('{"error":{"message":"bad size"}}')).toBe("bad size")
  })

  // Upstream errors reach us wrapped: the gateway puts the provider's whole
  // JSON body into its own `message`, so the useful text is one level down.
  it("unwraps a message that is itself an error document", () => {
    expect(imagesErrorMessage(JSON.stringify({
      error: { message: JSON.stringify({ error: { message: "LLM API: Invalid JSON format." } }) },
    }))).toBe("LLM API: Invalid JSON format.")
  })

  it("falls back to the raw text when it is not JSON", () => {
    expect(imagesErrorMessage("Internal Server Error")).toBe("Internal Server Error")
  })

  it("falls back to the raw text for an empty body", () => {
    expect(imagesErrorMessage("")).toBe("")
  })
})

describe("playgroundMode", () => {
  // Regression: this used to be `type === "image" ? "image" : "chat"`, which
  // reads "chat" while the model list is still loading. Sending in that window
  // sent an image model down the chat path — "No messages upstream available
  // for model: gpt-image-2".
  it("is undefined until the model list has loaded", () => {
    expect(playgroundMode(undefined, false)).toBeUndefined()
  })

  it("is undefined when the list is loaded but the model is not in it yet", () => {
    expect(playgroundMode(undefined, true)).toBeUndefined()
  })

  it("reports image for a model the upstream types as image", () => {
    expect(playgroundMode({ type: "image" }, true)).toBe("image")
  })

  it("reports chat for a model typed as chat", () => {
    expect(playgroundMode({ type: "chat" }, true)).toBe("chat")
  })

  it("falls back to chat when the upstream publishes no type", () => {
    expect(playgroundMode({}, true)).toBe("chat")
  })
})

describe("buildImageContext", () => {
  const user = (text: string, parts?: Part[]) => ({ role: "user" as const, text, parts })
  const bot = (parts?: Part[]) => ({ role: "assistant" as const, text: "", parts })

  it("uses the composer's own images when it has them", () => {
    const ctx = buildImageContext([user("make a poster", [image(PNG)])])
    expect(ctx.refs).toEqual([image(PNG)])
    expect(ctx.prompt).toBe("make a poster")
  })

  // The whole point: a bare follow-up like "继续" has to inherit the picture
  // the conversation was about, because the images API carries no history.
  it("falls back to the most recent image in the thread", () => {
    const ctx = buildImageContext([
      user("make a poster", [image(PNG)]),
      bot([image(JPG)]),
      user("continue"),
    ])
    expect(ctx.refs).toEqual([image(JPG)])
  })

  it("prefers the generated result over the original upload", () => {
    const ctx = buildImageContext([
      user("a", [image(PNG)]),
      bot([image(JPG)]),
      user("b"),
    ])
    expect(ctx.refs[0]).toEqual(image(JPG))
  })

  it("sends a lone instruction as-is, with no scaffolding", () => {
    expect(buildImageContext([user("make a poster")]).prompt).toBe("make a poster")
  })

  // Earlier instructions are background, not commands. Concatenating them flat
  // makes the model re-run "make a poster" every turn instead of continuing.
  it("labels earlier instructions as context and the newest as the command", () => {
    const ctx = buildImageContext([
      user("make a poster", [image(PNG)]),
      bot([image(JPG)]),
      user("continue"),
    ])
    expect(ctx.prompt).toBe(
      "Earlier instructions in this session, for context:\nmake a poster\n\nWhat to do now:\ncontinue",
    )
  })

  it("ignores assistant turns, which carry no instruction", () => {
    const ctx = buildImageContext([user("a"), bot([image(PNG)]), user("b")])
    expect(ctx.prompt).toContain("a")
    expect(ctx.prompt).toEndWith("b")
  })

  it("skips user turns that were images with no words", () => {
    expect(buildImageContext([user("", [image(PNG)]), user("b")]).prompt).toBe("b")
  })

  // Repeating "continue" three times is one intent: it stays the current
  // command and doesn't also pile up in the context block.
  it("collapses a repeated instruction", () => {
    const ctx = buildImageContext([user("a"), user("continue"), user("continue"), user("continue")])
    expect(ctx.prompt).toBe(
      "Earlier instructions in this session, for context:\na\n\nWhat to do now:\ncontinue",
    )
  })

  it("keeps only the most recent turns so the prompt cannot grow without bound", () => {
    const many = Array.from({ length: 12 }, (_, i) => user(`step ${i}`))
    expect(buildImageContext(many, 3).prompt).toBe(
      "Earlier instructions in this session, for context:\nstep 9\nstep 10\n\nWhat to do now:\nstep 11",
    )
  })

  it("returns no refs for a fresh thread, so the call is a generation", () => {
    expect(buildImageContext([user("a cat")]).refs).toEqual([])
  })

  it("ignores images whose bytes are gone from the store", () => {
    const ctx = buildImageContext([
      user("a", [{ type: "image", dataUrl: "" }]),
      user("b"),
    ])
    expect(ctx.refs).toEqual([])
  })
})
