import { useEffect, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import {
  buildEmbeddingBody, embeddingExamples, embeddingInputs, MAX_EMBEDDING_INPUTS, restoreEmbeddingDraft, summarizeEmbeddings,
  validateEmbeddingDraft, type EmbeddingDraft, type EmbeddingSummary,
} from "./embedding"
import { imagesErrorMessage } from "./images"
import { PlaygroundExamples } from "./PlaygroundExamples"

const LS_DRAFT = "playground.embeddingDraft"

const lang = (): "en" | "zh" => (window.__lang === "zh" ? "zh" : "en")

interface Result {
  inputs: string[]
  request: Record<string, unknown>
  status: number
  ms: number
  summary?: EmbeddingSummary
  error?: string
}

interface Props {
  modelId: string
  apiKey: string
}

/**
 * Test surface for embedding models: lines in, a readable summary of the
 * vectors out — chiefly how similar the inputs are to each other, which is
 * what embeddings are for.
 */
export function EmbeddingPanel({ modelId, apiKey }: Props) {
  const t = useT()
  // Rebuilt each render, so a language switch relabels the scenarios too.
  const examples = embeddingExamples(lang())
  const [draft, setDraft] = useState<EmbeddingDraft>(
    () => restoreEmbeddingDraft(localStorage.getItem(LS_DRAFT)) ?? { text: examples[0]!.text, dimensions: "" },
  )
  const [exampleId, setExampleId] = useState<string | null>(null)
  const [replaced, setReplaced] = useState<EmbeddingDraft | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [sending, setSending] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    setResult(null)
  }, [modelId])

  useEffect(() => () => abortRef.current?.abort(), [])

  // The form is long; bring a fresh result into view instead of leaving it below the fold.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [result])

  useEffect(() => {
    localStorage.setItem(LS_DRAFT, JSON.stringify(draft))
  }, [draft])

  const problem = validateEmbeddingDraft(draft.text, draft.dimensions)
  const count = embeddingInputs(draft.text).length

  function edit(next: EmbeddingDraft) {
    setDraft(next)
    setReplaced(null)
  }

  function pickExample(id: string) {
    const example = examples.find((e) => e.id === id)
    if (!example) return
    setReplaced(draft)
    // Examples are about comparing meaning, so they run at the model's own size.
    setDraft({ text: example.text, dimensions: "" })
    setExampleId(id)
    setResult(null)
  }

  function undoExample() {
    if (!replaced) return
    setDraft(replaced)
    setReplaced(null)
    setExampleId(null)
  }

  async function send() {
    if (problem || sending) return
    const request = buildEmbeddingBody(modelId, draft.text, draft.dimensions)
    const inputs = embeddingInputs(draft.text)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setSending(true)
    setResult(null)
    const started = performance.now()
    try {
      const resp = await fetch("/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(request),
        signal: ctrl.signal,
      })
      const text = await resp.text()
      const base = { inputs, request, status: resp.status, ms: Math.round(performance.now() - started) }
      if (!resp.ok) {
        setResult({ ...base, error: imagesErrorMessage(text) || `HTTP ${resp.status}` })
        return
      }
      try {
        setResult({ ...base, summary: summarizeEmbeddings(JSON.parse(text)) })
      } catch (err) {
        setResult({ ...base, error: (err as Error).message })
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setResult({ inputs, request, status: 0, ms: Math.round(performance.now() - started), error: (err as Error).message })
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 pg-chat-surface">
      <div className="pg-topbar">
        <span className="text-themed-dim">{t("dash.playground.protocol")}:</span>
        <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
          <span className="px-3 py-1 rounded-md text-xs font-medium bg-surface-600 text-themed">OpenAI Embeddings</span>
        </div>
        <span className="text-themed-dim">{t("dash.playground.embeddingFormatHint")}</span>
        {sending && (
          <span className="text-themed-dim flex items-center gap-2">
            <span className="pg-dots"><span/><span/><span/></span>
            {t("dash.playground.generating")}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="pg-form">
          <PlaygroundExamples
            examples={examples}
            activeId={exampleId}
            onPick={pickExample}
            {...(replaced ? { onUndo: undoExample } : {})}
            disabled={sending}
          />

          <section className="space-y-1.5">
            <div className="pg-label">
              {t("dash.playground.embeddingInputs")}
              <span className={"pg-label-hint font-mono" + (count > MAX_EMBEDDING_INPUTS ? " text-(--danger)!" : "")}>
                {count} / {MAX_EMBEDDING_INPUTS}
              </span>
            </div>
            <textarea
              className="pg-field pg-field-sans min-h-[140px]"
              value={draft.text}
              onChange={(e) => edit({ ...draft, text: e.target.value })}
              placeholder={t("dash.playground.embeddingInputsPlaceholder")}
            />
          </section>

          <section className="flex items-center gap-2 flex-wrap">
            <span className="pg-label mb-0!">{t("dash.playground.embeddingDimensions")}</span>
            <input
              type="text"
              inputMode="numeric"
              className="pg-field w-32!"
              value={draft.dimensions}
              onChange={(e) => edit({ ...draft, dimensions: e.target.value })}
              placeholder={t("dash.playground.embeddingDimensionsPlaceholder")}
            />
            <span className="text-[11px] text-themed-dim">{t("dash.playground.embeddingDimensionsHint")}</span>
          </section>

          <div className="flex items-center gap-3">
            <button className="btn-primary py-2! px-5!" disabled={problem !== null || sending} onClick={() => void send()}>
              {t("dash.playground.send")}
            </button>
            {sending && (
              <button className="btn-ghost py-2! px-4!" onClick={() => abortRef.current?.abort()}>{t("dash.playground.stop")}</button>
            )}
            {problem && (
              <span className="text-xs text-(--danger)">{t(problem, { max: MAX_EMBEDDING_INPUTS })}</span>
            )}
          </div>

          <div ref={resultRef} className="scroll-mt-4">
            {result ? <EmbeddingResult result={result} /> : !sending && (
              <div className="text-xs text-themed-dim">{t("dash.playground.embeddingEmpty")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Similarity drawn as a wash, stretched over the matrix's own range: cosine
 * values of real text cluster in a narrow band, so an absolute scale paints
 * every cell the same.
 */
function shader(similarity: number[][]) {
  const others = similarity.flatMap((row, r) => row.filter((_, c) => c !== r))
  const low = Math.min(...others)
  const high = Math.max(...others)
  return (value: number) => ({ background: `rgba(139, 92, 246, ${0.06 + 0.5 * (high > low ? (value - low) / (high - low) : 1)})` })
}

function EmbeddingResult({ result }: { result: Result }) {
  const t = useT()
  const [showRequest, setShowRequest] = useState(false)
  const summary = result.summary
  const label = (index: number) => result.inputs[index] ?? `#${index + 1}`
  const shade = summary?.similarity ? shader(summary.similarity) : undefined
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-xs text-themed-dim">
        <span className="font-mono">
          {t("dash.playground.embeddingMeta", {
            dims: summary?.dimensions ?? "—",
            status: result.status || "—",
            tin: summary?.promptTokens ?? "—",
            ms: result.ms,
          })}
        </span>
        <span className="ml-auto">
          <button className={"pg-mini-btn" + (showRequest ? " is-active" : "")} onClick={() => setShowRequest((v) => !v)}>
            {t("dash.playground.rawRequest")}
          </button>
        </span>
      </div>
      {showRequest && <pre className="pg-raw">{JSON.stringify(result.request, null, 2)}</pre>}
      {result.error && <div className="pg-error mx-0!">⚠ {result.error}</div>}

      {summary?.similarity && (
        <div className="space-y-1.5">
          <div className="pg-label">
            {t("dash.playground.embeddingSimilarity")}
            <span className="pg-label-hint">{t("dash.playground.embeddingSimilarityHint")}</span>
          </div>
          <div className="overflow-auto">
            <table className="pg-matrix">
              <thead>
                <tr>
                  <th />
                  {summary.vectors.map((v) => <th key={v.index} title={label(v.index)}>#{v.index + 1}</th>)}
                </tr>
              </thead>
              <tbody>
                {summary.similarity.map((row, r) => (
                  <tr key={r}>
                    <th className="pg-matrix-row" title={label(summary.vectors[r]!.index)}>
                      #{summary.vectors[r]!.index + 1} {label(summary.vectors[r]!.index)}
                    </th>
                    {row.map((value, c) => (
                      <td key={c} style={r === c ? undefined : shade?.(value)}
                        className={r === c ? "is-self" : summary.nearest?.[r] === c ? "is-nearest" : ""}>
                        {value.toFixed(3)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {summary && (
        <div className="space-y-1.5">
          <div className="pg-label">{t("dash.playground.embeddingVectors")}</div>
          <div className="overflow-auto">
            <table className="pg-matrix pg-vectors">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t("dash.playground.embeddingColInput")}</th>
                  <th>{t("dash.playground.embeddingColNorm")}</th>
                  <th>{t("dash.playground.embeddingColPreview")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.vectors.map((v) => (
                  <tr key={v.index}>
                    <td>{v.index + 1}</td>
                    <td className="pg-matrix-row" title={label(v.index)}>{label(v.index)}</td>
                    <td>{v.norm.toFixed(4)}</td>
                    <td className="pg-preview">[{v.preview.map((x) => x.toFixed(4)).join(", ")}{summary.dimensions > v.preview.length ? ", …" : ""}]</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
