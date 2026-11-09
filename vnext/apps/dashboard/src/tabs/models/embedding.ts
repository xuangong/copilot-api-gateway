// Embedding playground: one input per line, then a summary a person can read
// instead of thousands of floats — dimensions, norms, a short preview of each
// vector, and how similar the inputs are to each other.

const DEFAULT_PREVIEW_LENGTH = 8
/** More rows than this stop fitting the similarity matrix on screen. */
export const MAX_EMBEDDING_INPUTS = 16

export interface EmbeddingVectorSummary {
  index: number
  norm: number
  preview: number[]
}

export interface EmbeddingSummary {
  dimensions: number
  promptTokens: number | undefined
  vectors: EmbeddingVectorSummary[]
  /** Pairwise cosine similarity in `vectors` order; null for a single input. */
  similarity: number[][] | null
  /** Per row, the position of the most similar other input — a search's top hit. */
  nearest: number[] | null
}

export function embeddingInputs(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean)
}

/** The i18n key of the first problem, or null when the draft can be sent. */
export function validateEmbeddingDraft(text: string, dimensions: string): string | null {
  const inputs = embeddingInputs(text)
  if (inputs.length === 0) return "dash.playground.embeddingErrEmpty"
  if (inputs.length > MAX_EMBEDDING_INPUTS) return "dash.playground.embeddingErrTooMany"
  if (dimensions.trim() && !/^[1-9]\d*$/.test(dimensions.trim())) return "dash.playground.embeddingErrDimensions"
  return null
}

/** Blank dimensions leave the size to the model. */
export function buildEmbeddingBody(model: string, text: string, dimensions: string): Record<string, unknown> {
  const size = dimensions.trim()
  return { model, input: embeddingInputs(text), ...(size ? { dimensions: Number(size) } : {}) }
}

export interface EmbeddingDraft {
  text: string
  dimensions: string
}

/** A draft saved by an earlier visit, or null when storage holds nothing usable. */
export function restoreEmbeddingDraft(raw: string | null): EmbeddingDraft | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value) || typeof value.text !== "string") return null
    return { text: value.text, dimensions: typeof value.dimensions === "string" ? value.dimensions : "" }
  } catch {
    return null
  }
}

const norm = (vector: readonly number[]): number => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))

const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)

/** Cosine of two vectors with known norms; 0 when either is the zero vector. */
const cosine = (a: readonly number[], normA: number, b: readonly number[], normB: number): number =>
  normA === 0 || normB === 0 ? 0 : dot(a, b) / (normA * normB)

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  return cosine(a, norm(a), b, norm(b))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function summarizeEmbeddings(body: unknown, previewLength = DEFAULT_PREVIEW_LENGTH): EmbeddingSummary {
  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length === 0) throw new Error("The response has no embeddings")
  const rows = body.data.map((row, position) => {
    if (!isRecord(row) || !Array.isArray(row.embedding) || !row.embedding.every((value) => typeof value === "number")) {
      throw new Error(`data[${position}].embedding is not a float vector`)
    }
    return { index: typeof row.index === "number" ? row.index : position, embedding: row.embedding as number[] }
  }).sort((a, b) => a.index - b.index)
  const usage = isRecord(body.usage) ? body.usage : undefined
  const norms = rows.map((row) => norm(row.embedding))
  const similarity = rows.length < 2 ? null
    : rows.map((a, i) => rows.map((b, j) => cosine(a.embedding, norms[i]!, b.embedding, norms[j]!)))
  return {
    dimensions: rows[0]!.embedding.length,
    promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    vectors: rows.map((row, i) => ({ index: row.index, norm: norms[i]!, preview: row.embedding.slice(0, previewLength) })),
    similarity,
    nearest: similarity?.map((row, self) => row.reduce((best, value, at) => (at !== self && (best === -1 || value > row[best]!) ? at : best), -1)) ?? null,
  }
}

// —— Example scenarios ——
// Each shows a typical use of embeddings, with a hint on what to look for in
// the similarity matrix.

export interface EmbeddingExample {
  id: string
  titleKey: string
  hintKey: string
  text: string
}

const EXAMPLES: Array<{ id: string; key: string; lines: { en: string[]; zh: string[] } }> = [
  {
    id: "paraphrase",
    key: "Paraphrase",
    lines: {
      en: ["How do I reset my password?", "I forgot my password, how can I change it?", "What are your office hours?", "Can I get a refund for my order?"],
      zh: ["怎么重置密码？", "我忘记密码了，要怎么修改？", "你们的营业时间是几点？", "我的订单可以退款吗？"],
    },
  },
  {
    id: "cross-lingual",
    key: "CrossLingual",
    lines: {
      en: ["The cat is sleeping on the sofa.", "猫在沙发上睡觉。", "Le chat dort sur le canapé.", "The stock market fell sharply today."],
      zh: ["猫在沙发上睡觉。", "The cat is sleeping on the sofa.", "Le chat dort sur le canapé.", "今天股市大幅下跌。"],
    },
  },
  {
    id: "search",
    key: "Search",
    lines: {
      en: [
        "How long does shipping take?",
        "Orders ship within 2 business days and arrive 3 to 5 days later.",
        "Every pair of headphones comes with a two-year warranty.",
        "Express delivery is available for an extra fee.",
        "You can return any item within 30 days.",
      ],
      zh: [
        "发货要多久？",
        "订单会在 2 个工作日内发出，3 到 5 天送达。",
        "所有耳机都提供两年质保。",
        "支付额外费用可以选择加急配送。",
        "所有商品 30 天内都可以退货。",
      ],
    },
  },
]

export function embeddingExamples(lang: "en" | "zh"): EmbeddingExample[] {
  return EXAMPLES.map((example) => ({
    id: example.id,
    titleKey: `dash.playground.embeddingExample${example.key}`,
    hintKey: `dash.playground.embeddingExample${example.key}Hint`,
    text: example.lines[lang].join("\n"),
  }))
}
