import { describe, expect, it } from "bun:test"
import {
  buildEmbeddingBody, cosineSimilarity, embeddingExamples, embeddingInputs, MAX_EMBEDDING_INPUTS, summarizeEmbeddings,
  restoreEmbeddingDraft, validateEmbeddingDraft,
} from "./embedding"

describe("inputs", () => {
  it("sends one input per non-blank line", () => {
    expect(embeddingInputs("first line\n\n  second line  \n")).toEqual(["first line", "second line"])
    expect(embeddingInputs(" \n ")).toEqual([])
  })
})

describe("draft", () => {
  it("needs at least one input, and no more than the panel can compare", () => {
    expect(validateEmbeddingDraft("hello", "")).toBeNull()
    expect(validateEmbeddingDraft(" \n ", "")).toBe("dash.playground.embeddingErrEmpty")
    const tooMany = Array.from({ length: MAX_EMBEDDING_INPUTS + 1 }, (_, i) => `line ${i}`).join("\n")
    expect(validateEmbeddingDraft(tooMany, "")).toBe("dash.playground.embeddingErrTooMany")
  })

  it("accepts a blank or positive whole number of dimensions", () => {
    expect(validateEmbeddingDraft("hello", " 256 ")).toBeNull()
    for (const bad of ["0", "-1", "1.5", "abc"]) expect(validateEmbeddingDraft("hello", bad)).toBe("dash.playground.embeddingErrDimensions")
  })

  it("sends every input, and dimensions only when set", () => {
    expect(buildEmbeddingBody("text-embedding-3-small", "a\n\nb", "")).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] })
    expect(buildEmbeddingBody("text-embedding-3-small", "a", "256")).toEqual({ model: "text-embedding-3-small", input: ["a"], dimensions: 256 })
  })
})

describe("examples", () => {
  for (const lang of ["en", "zh"] as const) {
    it(`compare several valid inputs in ${lang}`, () => {
      const examples = embeddingExamples(lang)
      expect(examples.length).toBeGreaterThanOrEqual(3)
      expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length)
      for (const example of examples) {
        expect(validateEmbeddingDraft(example.text, "")).toBeNull()
        expect(embeddingInputs(example.text).length).toBeGreaterThanOrEqual(3)
        expect(example.titleKey).toStartWith("dash.playground.embeddingExample")
        expect(example.hintKey).toStartWith("dash.playground.embeddingExample")
      }
    })
  }
})

describe("cosine similarity", () => {
  it("is 1 for parallel vectors, 0 for orthogonal and -1 for opposite", () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1)
  })

  it("is 0 for a zero vector instead of NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe("summary", () => {
  it("reports dimensions, norms, a preview, pairwise similarity and token usage", () => {
    const summary = summarizeEmbeddings({
      data: [{ index: 1, embedding: [0, 2, 0, 0, 0, 0, 0, 0, 0] }, { index: 0, embedding: [3, 4, 0, 0, 0, 0, 0, 0, 0] }],
      usage: { prompt_tokens: 7, total_tokens: 7 },
    }, 6)
    expect(summary.dimensions).toBe(9)
    expect(summary.promptTokens).toBe(7)
    // Ordered by the upstream's `index`, not by array position.
    expect(summary.vectors.map(v => [v.index, v.norm])).toEqual([[0, 5], [1, 2]])
    expect(summary.vectors[0]!.preview).toEqual([3, 4, 0, 0, 0, 0])
    expect(summary.similarity).toHaveLength(2)
    expect(summary.similarity![0]![0]).toBeCloseTo(1)
    expect(summary.similarity![0]![1]).toBeCloseTo(0.8)
    expect(summary.similarity![1]![0]).toBeCloseTo(0.8)
  })

  it("names each input's nearest other input", () => {
    const summary = summarizeEmbeddings({ data: [
      { index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }, { index: 2, embedding: [1, 0.2] },
    ] })
    expect(summary.nearest).toEqual([2, 2, 0])
    expect(summarizeEmbeddings({ data: [{ index: 0, embedding: [1, 0] }] }).nearest).toBeNull()
  })

  it("has no similarity matrix for a single input", () => {
    expect(summarizeEmbeddings({ data: [{ index: 0, embedding: [1, 0] }] }).similarity).toBeNull()
  })

  it("rejects a body without vectors", () => {
    expect(() => summarizeEmbeddings({ data: [{ index: 0, embedding: "AAAA" }] })).toThrow()
    expect(() => summarizeEmbeddings({ error: { message: "nope" } })).toThrow()
  })
})

describe("stored draft", () => {
  it("round-trips through storage and discards anything else", () => {
    expect(restoreEmbeddingDraft(JSON.stringify({ text: "a\nb", dimensions: "256" }))).toEqual({ text: "a\nb", dimensions: "256" })
    expect(restoreEmbeddingDraft(JSON.stringify({ text: "a" }))).toEqual({ text: "a", dimensions: "" })
    for (const raw of [null, "{", "[]", JSON.stringify({ text: 1 })]) expect(restoreEmbeddingDraft(raw)).toBeNull()
  })
})
