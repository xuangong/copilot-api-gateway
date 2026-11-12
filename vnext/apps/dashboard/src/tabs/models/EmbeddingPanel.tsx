import { useEffect, useId, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Notice } from "../../ui/notice"
import { Table, TBody, Td, Th } from "../../ui/table"
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

  const inputsId = useId()
  const countId = useId()
  const dimensionsId = useId()
  const dimensionsHintId = useId()
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
        <span className="text-fg-subtle">{t("dash.playground.protocol")}:</span>
        <div className="inline-flex items-center rounded-md border border-control bg-panel p-0.5">
          <span className="flex h-6 items-center rounded-[5px] bg-background px-2.5 text-body font-medium text-fg shadow-xs ring-1 ring-control">OpenAI Embeddings</span>
        </div>
        <span className="text-fg-subtle">{t("dash.playground.embeddingFormatHint")}</span>
        {sending && (
          <span role="status" className="flex items-center gap-2 text-fg-subtle">
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
              <label htmlFor={inputsId}>{t("dash.playground.embeddingInputs")}</label>
              {/* .pg-label-hint's colour is unlayered and would beat a utility, so over the limit it is swapped out. */}
              <span id={countId} className={count > MAX_EMBEDDING_INPUTS ? "font-mono font-normal text-danger-text" : "pg-label-hint font-mono"}>
                {count} / {MAX_EMBEDDING_INPUTS}
              </span>
            </div>
            <textarea
              id={inputsId}
              aria-describedby={countId}
              className="pg-field pg-field-sans min-h-[140px]"
              value={draft.text}
              onChange={(e) => edit({ ...draft, text: e.target.value })}
              placeholder={t("dash.playground.embeddingInputsPlaceholder")}
            />
          </section>

          <section className="flex items-center gap-2 flex-wrap">
            <label htmlFor={dimensionsId} className="text-xs font-semibold text-fg-muted">{t("dash.playground.embeddingDimensions")}</label>
            <div className="w-32">
              <input
                id={dimensionsId}
                aria-describedby={dimensionsHintId}
                type="text"
                inputMode="numeric"
                className="pg-field"
                value={draft.dimensions}
                onChange={(e) => edit({ ...draft, dimensions: e.target.value })}
                placeholder={t("dash.playground.embeddingDimensionsPlaceholder")}
              />
            </div>
            <span id={dimensionsHintId} className="text-xs text-fg-subtle">{t("dash.playground.embeddingDimensionsHint")}</span>
          </section>

          <div className="flex items-center gap-3">
            <Button variant="primary" className="px-5" disabled={problem !== null || sending} onClick={() => void send()}>
              {t("dash.playground.send")}
            </Button>
            {sending && (
              <Button variant="secondary" onClick={() => abortRef.current?.abort()}>{t("dash.playground.stop")}</Button>
            )}
            {problem && (
              <span className="text-xs text-danger-text">{t(problem, { max: MAX_EMBEDDING_INPUTS })}</span>
            )}
          </div>

          <div ref={resultRef} className="scroll-mt-4">
            {result ? <EmbeddingResult result={result} /> : !sending && (
              <div className="text-xs text-fg-subtle">{t("dash.playground.embeddingEmpty")}</div>
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
  return (value: number) => {
    const strength = 6 + 50 * (high > low ? (value - low) / (high - low) : 1)
    return { background: `color-mix(in oklab, var(--brand) ${strength.toFixed(1)}%, transparent)` }
  }
}

/** Matrix cells: compact, bordered, monospace — a grid to scan, not a list. */
const CELL = "border border-border px-2 py-1 text-center whitespace-nowrap"
/** The input's text beside its number: clipped so a long line doesn't widen the grid. */
const ROW_LABEL = "max-w-[280px] overflow-hidden text-ellipsis text-left font-sans font-normal text-fg-muted"

function EmbeddingResult({ result }: { result: Result }) {
  const t = useT()
  const [showRequest, setShowRequest] = useState(false)
  const similarityId = useId()
  const vectorsId = useId()
  const summary = result.summary
  const label = (index: number) => result.inputs[index] ?? `#${index + 1}`
  const shade = summary?.similarity ? shader(summary.similarity) : undefined
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-xs text-fg-subtle">
        <span className="font-mono">
          {t("dash.playground.embeddingMeta", {
            dims: summary?.dimensions ?? "—",
            status: result.status || "—",
            tin: summary?.promptTokens ?? "—",
            ms: result.ms,
          })}
        </span>
        <span className="ml-auto">
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={showRequest}
            className="aria-pressed:border-brand-text/40 aria-pressed:bg-brand-text/10 aria-pressed:text-brand-text"
            onClick={() => setShowRequest((v) => !v)}
          >
            {t("dash.playground.rawRequest")}
          </Button>
        </span>
      </div>
      {showRequest && (
        <pre className="max-h-80 overflow-auto whitespace-pre rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-xs">
          {JSON.stringify(result.request, null, 2)}
        </pre>
      )}
      {result.error && <Notice tone="danger" className="break-words">{result.error}</Notice>}

      {summary?.similarity && (
        <div className="space-y-1.5">
          <div className="pg-label">
            <span id={similarityId}>{t("dash.playground.embeddingSimilarity")}</span>
            <span className="pg-label-hint">{t("dash.playground.embeddingSimilarityHint")}</span>
          </div>
          <div className="overflow-auto">
            <table aria-labelledby={similarityId} className="border-collapse font-mono text-xs">
              <thead>
                <tr>
                  <td className={CELL} />
                  {summary.vectors.map((v) => (
                    <th key={v.index} scope="col" title={label(v.index)} className={cn(CELL, "font-medium text-fg-subtle")}>#{v.index + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.similarity.map((row, r) => (
                  <tr key={r}>
                    <th scope="row" className={cn(CELL, ROW_LABEL)} title={label(summary.vectors[r]!.index)}>
                      #{summary.vectors[r]!.index + 1} {label(summary.vectors[r]!.index)}
                    </th>
                    {row.map((value, c) => (
                      <td key={c} style={r === c ? undefined : shade?.(value)}
                        className={cn(
                          CELL,
                          r === c && "text-fg-subtle",
                          r !== c && summary.nearest?.[r] === c && "font-bold outline-2 -outline-offset-2 outline-brand-text",
                        )}>
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
          <div id={vectorsId} className="pg-label">{t("dash.playground.embeddingVectors")}</div>
          <Table aria-labelledby={vectorsId} className="font-mono text-xs">
            <thead>
              <tr>
                <Th numeric>#</Th>
                <Th>{t("dash.playground.embeddingColInput")}</Th>
                <Th numeric>{t("dash.playground.embeddingColNorm")}</Th>
                <Th>{t("dash.playground.embeddingColPreview")}</Th>
              </tr>
            </thead>
            <TBody>
              {summary.vectors.map((v) => (
                <tr key={v.index}>
                  <Td numeric>{v.index + 1}</Td>
                  <Th row className={cn("whitespace-nowrap", ROW_LABEL)} title={label(v.index)}>{label(v.index)}</Th>
                  <Td numeric className="whitespace-nowrap">{v.norm.toFixed(4)}</Td>
                  <Td className="min-w-[240px] text-fg-muted">[{v.preview.map((x) => x.toFixed(4)).join(", ")}{summary.dimensions > v.preview.length ? ", …" : ""}]</Td>
                </tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </section>
  )
}
