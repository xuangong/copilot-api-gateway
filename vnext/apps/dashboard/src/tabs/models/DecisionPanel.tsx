import { useEffect, useId, useRef, useState } from "react"
import { Plus, X } from "lucide-react"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Meter } from "../../ui/meter"
import { Notice } from "../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../ui/segmented-control"
import {
  buildDecisionBody, decisionExamples, decisionPath, decisionUsage, nativeDecisionDialect, parseDecisionAnswers,
  restoreDecisionDraft, unsentCriteria, validateDecisionDraft,
  type DecisionAnswerView, type DecisionDialect, type DecisionDraft, type DecisionQuestionDraft, type DecisionQuestionType,
} from "./decision"
import { imagesErrorMessage } from "./images"
import { PlaygroundExamples } from "./PlaygroundExamples"

const LS_DRAFT = "playground.decisionDraft"
const MAX_LEVELS = 10

const DIALECTS: ReadonlyArray<{ value: DecisionDialect; label: string }> = [
  { value: "typesafe-systemone", label: "System One" },
  { value: "openai-decisions", label: "OpenAI Decisions" },
]
const dialectLabel = (dialect: DecisionDialect) => DIALECTS.find((d) => d.value === dialect)!.label

const TYPES: ReadonlyArray<{ value: DecisionQuestionType; key: string; hintKey: string }> = [
  { value: "yesno", key: "dash.playground.decisionTypeYesno", hintKey: "dash.playground.decisionTypeYesnoHint" },
  { value: "choice", key: "dash.playground.decisionTypeChoice", hintKey: "dash.playground.decisionTypeChoiceHint" },
  { value: "score", key: "dash.playground.decisionTypeScore", hintKey: "dash.playground.decisionTypeScoreHint" },
]

const lang = (): "en" | "zh" => (window.__lang === "zh" ? "zh" : "en")

let nextId = 0
const freshId = () => `q-${Date.now().toString(36)}-${nextId++}`

function blankQuestion(type: DecisionQuestionType): DecisionQuestionDraft {
  return {
    id: freshId(), type, name: "", instructions: "", criteriaTrue: "", criteriaFalse: "",
    options: type === "choice" ? [{ value: "", description: "" }, { value: "", description: "" }] : [],
    levels: type === "score" ? ["", ""] : [],
  }
}

/** Switching type keeps the name and question, and seeds what the new type needs. */
function retype(question: DecisionQuestionDraft, type: DecisionQuestionType): DecisionQuestionDraft {
  const seeded = blankQuestion(type)
  return {
    ...question,
    type,
    options: question.options.length > 0 ? question.options : seeded.options,
    levels: question.levels.length > 0 ? question.levels : seeded.levels,
  }
}

const percent = (probability: number) => `${(probability * 100).toFixed(1)}%`

interface Result {
  dialect: DecisionDialect
  request: Record<string, unknown>
  status: number
  text: string
  ms: number
  answers?: DecisionAnswerView[]
  inputTokens?: number
  error?: string
}

interface Props {
  modelId: string
  apiKey: string
  supportedEndpoints: readonly string[] | undefined
}

/**
 * Test surface for decision models: a state plus typed questions in, a
 * probability per answer out. Either decision format reaches either model —
 * the gateway translates — so the format switch works like the chat panel's
 * protocol switch.
 */
export function DecisionPanel({ modelId, apiKey, supportedEndpoints }: Props) {
  const t = useT()
  // Rebuilt each render, so a language switch relabels the scenarios too.
  const examples = decisionExamples(lang())
  const native = nativeDecisionDialect(supportedEndpoints)
  const [dialect, setDialect] = useState<DecisionDialect>(native)
  const [draft, setDraft] = useState<DecisionDraft>(() => restoreDecisionDraft(localStorage.getItem(LS_DRAFT)) ?? examples[0]!.draft)
  const [exampleId, setExampleId] = useState<string | null>(null)
  /** The draft an example replaced, until the next edit makes undo ambiguous. */
  const [replaced, setReplaced] = useState<DecisionDraft | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [sending, setSending] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)

  // A new model starts in its own format with a clean result; the draft stays,
  // so the same questions can be compared across models.
  useEffect(() => {
    abortRef.current?.abort()
    setDialect(native)
    setResult(null)
  }, [modelId, native])

  useEffect(() => () => abortRef.current?.abort(), [])

  // The form is long; bring a fresh result into view instead of leaving it below the fold.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [result])

  useEffect(() => {
    localStorage.setItem(LS_DRAFT, JSON.stringify(draft))
  }, [draft])

  const stateId = useId()
  const stateHintId = useId()
  const addQuestionId = useId()
  const problem = validateDecisionDraft(draft, native)
  const dropped = unsentCriteria(draft, dialect, native)

  function edit(next: DecisionDraft) {
    setDraft(next)
    setReplaced(null)
  }

  function updateQuestion(index: number, patch: Partial<DecisionQuestionDraft>) {
    edit({ ...draft, questions: draft.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)) })
  }

  function pickExample(id: string) {
    const example = examples.find((e) => e.id === id)
    if (!example) return
    setReplaced(draft)
    setDraft(example.draft)
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
    const request = buildDecisionBody(dialect, modelId, draft)
    const order = draft.questions.map((q) => q.name.trim())
    const optionOrder = Object.fromEntries(draft.questions.filter((q) => q.type === "choice")
      .map((q) => [q.name.trim(), q.options.map((option) => option.value.trim())]))
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setSending(true)
    setResult(null)
    const started = performance.now()
    try {
      const resp = await fetch(decisionPath(dialect), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(request),
        signal: ctrl.signal,
      })
      const text = await resp.text()
      const base = { dialect, request, status: resp.status, text, ms: Math.round(performance.now() - started) }
      if (!resp.ok) {
        setResult({ ...base, error: imagesErrorMessage(text) || `HTTP ${resp.status}` })
        return
      }
      try {
        const body = JSON.parse(text) as unknown
        setResult({ ...base, answers: parseDecisionAnswers(dialect, body, order, optionOrder), inputTokens: decisionUsage(body) })
      } catch (err) {
        setResult({ ...base, error: (err as Error).message })
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setResult({ dialect, request, status: 0, text: "", ms: Math.round(performance.now() - started), error: (err as Error).message })
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
      setSending(false)
    }
  }

  const dialectOptions: ReadonlyArray<SegmentedOption<DecisionDialect>> = DIALECTS.map((d) => ({
    value: d.value,
    label: d.value === native
      ? <>{d.label}<Badge tone="brand" className="ml-1.5">{t("dash.playground.decisionNative")}</Badge></>
      : d.label,
  }))

  return (
    <div className="flex flex-col h-full min-h-0 pg-chat-surface">
      <div className="pg-topbar">
        <span className="text-fg-subtle">{t("dash.playground.protocol")}:</span>
        <SegmentedControl
          options={dialectOptions}
          value={dialect}
          onChange={setDialect}
          ariaLabel={t("dash.playground.protocol")}
          size="sm"
          disabled={sending}
        />
        <span className="text-fg-subtle">
          {dialect === native
            ? t("dash.playground.decisionFormatNativeHint", { format: dialectLabel(dialect), path: decisionPath(dialect) })
            : t("dash.playground.decisionFormatTranslatedHint", { format: dialectLabel(dialect), path: decisionPath(dialect), native: dialectLabel(native) })}
        </span>
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
              <label htmlFor={stateId}>{t("dash.playground.decisionState")}</label>
              <span id={stateHintId} className="pg-label-hint">{t("dash.playground.decisionStateHint")}</span>
            </div>
            <textarea
              id={stateId}
              aria-describedby={stateHintId}
              className="pg-field pg-field-sans min-h-[84px]"
              value={draft.state}
              onChange={(e) => edit({ ...draft, state: e.target.value })}
              placeholder={t("dash.playground.decisionStatePlaceholder")}
            />
          </section>

          <section className="space-y-2">
            <div className="pg-label">{t("dash.playground.decisionQuestions")}</div>
            {draft.questions.map((question, index) => (
              <QuestionCard
                key={question.id}
                index={index}
                question={question}
                dialect={dialect}
                instructionsRequired={native === "openai-decisions"}
                problemKey={problem?.question === index ? problem.key : undefined}
                onChange={(patch) => updateQuestion(index, patch)}
                onRetype={(type) => edit({ ...draft, questions: draft.questions.map((q, i) => (i === index ? retype(q, type) : q)) })}
                onRemove={() => edit({ ...draft, questions: draft.questions.filter((_, i) => i !== index) })}
              />
            ))}
            <div role="group" aria-labelledby={addQuestionId} className="flex items-center gap-1.5 text-xs flex-wrap">
              <span id={addQuestionId} className="text-fg-subtle">{t("dash.playground.decisionAddQuestion")}:</span>
              {TYPES.map((type) => (
                <Button
                  key={type.value}
                  variant="secondary"
                  size="sm"
                  className="gap-1"
                  onClick={() => edit({ ...draft, questions: [...draft.questions, blankQuestion(type.value)] })}
                >
                  <Plus aria-hidden="true" />
                  {t(type.key)}
                </Button>
              ))}
            </div>
          </section>

          {dropped > 0 && <Notice tone="warn" className="text-xs">{t("dash.playground.decisionCriteriaDropped", { n: dropped })}</Notice>}

          <div className="flex items-center gap-3">
            <Button variant="primary" className="px-5" disabled={problem !== null || sending} onClick={() => void send()}>
              {t("dash.playground.send")}
            </Button>
            {sending && (
              <Button variant="secondary" onClick={() => abortRef.current?.abort()}>{t("dash.playground.stop")}</Button>
            )}
            {problem && (
              <span className="text-xs text-danger-text">
                {t(problem.key, { n: (problem.question ?? 0) + 1 })}
              </span>
            )}
          </div>

          <div ref={resultRef} className="scroll-mt-4">
            {result ? <DecisionResult result={result} /> : !sending && (
              <div className="text-xs text-fg-subtle">{t("dash.playground.decisionEmpty")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface CardProps {
  index: number
  question: DecisionQuestionDraft
  dialect: DecisionDialect
  /** The model's own format needs instructions on every question. */
  instructionsRequired: boolean
  problemKey: string | undefined
  onChange: (patch: Partial<DecisionQuestionDraft>) => void
  onRetype: (type: DecisionQuestionType) => void
  onRemove: () => void
}

function QuestionCard({ index, question, dialect, instructionsRequired, problemKey, onChange, onRetype, onRemove }: CardProps) {
  const t = useT()
  const type = TYPES.find((entry) => entry.value === question.type)!
  const typeOptions: ReadonlyArray<SegmentedOption<DecisionQuestionType>> = TYPES.map((entry) => ({ value: entry.value, label: t(entry.key) }))
  const instructionsPlaceholder = t(instructionsRequired
    ? "dash.playground.decisionInstructionsRequiredPlaceholder"
    : "dash.playground.decisionInstructionsPlaceholder")
  const removeLabel = t("dash.playground.decisionRemove")
  return (
    <div className={cn("space-y-2 rounded-lg border bg-panel p-3", problemKey ? "border-danger" : "border-border")}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-fg-subtle">#{index + 1}</span>
        <SegmentedControl
          options={typeOptions}
          value={question.type}
          onChange={onRetype}
          ariaLabel={t("dash.playground.decisionTypeAria", { n: index + 1 })}
          size="sm"
        />
        <div className="min-w-[140px] flex-1">
          <input
            type="text"
            className="pg-field"
            value={question.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={t("dash.playground.decisionNamePlaceholder")}
            aria-label={t("dash.playground.decisionNamePlaceholder")}
            title={t("dash.playground.decisionNameHint")}
          />
        </div>
        <RemoveButton label={removeLabel} onClick={onRemove} />
      </div>
      <div className="text-xs text-fg-subtle">{t(type.hintKey)}</div>
      <input
        type="text"
        className="pg-field pg-field-sans"
        value={question.instructions}
        onChange={(e) => onChange({ instructions: e.target.value })}
        placeholder={instructionsPlaceholder}
        aria-label={instructionsPlaceholder}
      />

      {question.type === "yesno" && (dialect === "typesafe-systemone" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input type="text" className="pg-field pg-field-sans" value={question.criteriaTrue}
            onChange={(e) => onChange({ criteriaTrue: e.target.value })} placeholder={t("dash.playground.decisionCriteriaTrue")}
            aria-label={t("dash.playground.decisionCriteriaTrue")} />
          <input type="text" className="pg-field pg-field-sans" value={question.criteriaFalse}
            onChange={(e) => onChange({ criteriaFalse: e.target.value })} placeholder={t("dash.playground.decisionCriteriaFalse")}
            aria-label={t("dash.playground.decisionCriteriaFalse")} />
        </div>
      ) : (
        <div className="text-xs text-fg-subtle">{t("dash.playground.decisionCriteriaHidden")}</div>
      ))}

      {question.type === "choice" && (
        <div className="space-y-1.5">
          {question.options.map((option, at) => (
            <div key={at} className="flex items-center gap-2">
              <div className="w-40 shrink-0">
                <input type="text" className="pg-field" value={option.value}
                  onChange={(e) => onChange({ options: question.options.map((o, i) => (i === at ? { ...o, value: e.target.value } : o)) })}
                  placeholder={t("dash.playground.decisionOptionValue")}
                  aria-label={t("dash.playground.decisionOptionValue")} />
              </div>
              <input type="text" className="pg-field pg-field-sans flex-1" value={option.description}
                onChange={(e) => onChange({ options: question.options.map((o, i) => (i === at ? { ...o, description: e.target.value } : o)) })}
                placeholder={t("dash.playground.decisionOptionDescription")}
                aria-label={t("dash.playground.decisionOptionDescription")} />
              <RemoveButton label={removeLabel} onClick={() => onChange({ options: question.options.filter((_, i) => i !== at) })} />
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={() => onChange({ options: [...question.options, { value: "", description: "" }] })}>
            {t("dash.playground.decisionAddOption")}
          </Button>
        </div>
      )}

      {question.type === "score" && (
        <div className="space-y-1.5">
          <div className="text-xs text-fg-subtle">{t("dash.playground.decisionLevelsOrder")}</div>
          {question.levels.map((level, at) => (
            <div key={at} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-right text-xs font-mono text-fg-subtle">{at}</span>
              <input type="text" className="pg-field pg-field-sans flex-1" value={level}
                onChange={(e) => onChange({ levels: question.levels.map((l, i) => (i === at ? e.target.value : l)) })}
                placeholder={t("dash.playground.decisionLevelPlaceholder", { n: at })}
                aria-label={t("dash.playground.decisionLevelPlaceholder", { n: at })} />
              <RemoveButton label={removeLabel} onClick={() => onChange({ levels: question.levels.filter((_, i) => i !== at) })} />
            </div>
          ))}
          <Button variant="secondary" size="sm" disabled={question.levels.length >= MAX_LEVELS}
            onClick={() => onChange({ levels: [...question.levels, ""] })}>
            {t("dash.playground.decisionAddLevel")}
          </Button>
        </div>
      )}

      {problemKey && <div className="text-xs text-danger-text">{t(problemKey, { n: index + 1 })}</div>}
    </div>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={onClick} title={label} aria-label={label}>
      <X aria-hidden="true" />
    </Button>
  )
}

function ProbabilityBar({ label, probability, selected }: { label: string; probability: number; selected: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(80px,180px)_1fr_52px] items-center gap-2.5 text-xs">
      <span className={cn("truncate", selected ? "font-semibold text-fg" : "text-fg-muted")} title={label}>{label}</span>
      <Meter percent={probability * 100} tone={selected ? "brand" : "muted"} className={cn("h-2", !selected && "[&>div]:bg-fg-subtle/40")} />
      <span className="text-right font-mono text-fg-muted">{percent(probability)}</span>
    </div>
  )
}

function DecisionResult({ result }: { result: Result }) {
  const t = useT()
  const [raw, setRaw] = useState<"request" | "response" | null>(null)
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs text-fg-subtle">
        <span className="font-semibold text-fg-muted">{t("dash.playground.decisionAnswers")}</span>
        <span className="font-mono">
          {t("dash.playground.decisionMeta", {
            format: dialectLabel(result.dialect),
            status: result.status || "—",
            tin: result.inputTokens ?? "—",
            ms: result.ms,
          })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {(["request", "response"] as const).map((which) => (
            <Button
              key={which}
              variant="secondary"
              size="sm"
              aria-pressed={raw === which}
              className="aria-pressed:border-brand-text/40 aria-pressed:bg-brand-text/10 aria-pressed:text-brand-text"
              onClick={() => setRaw(raw === which ? null : which)}
            >
              {t(which === "request" ? "dash.playground.rawRequest" : "dash.playground.rawResponse")}
            </Button>
          ))}
        </span>
      </div>
      {raw && (
        <pre className="max-h-80 overflow-auto whitespace-pre rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-xs">
          {raw === "request" ? JSON.stringify(result.request, null, 2) : prettyJson(result.text)}
        </pre>
      )}
      {result.error && <Notice tone="danger" className="break-words">{result.error}</Notice>}
      {result.answers?.map((answer) => (
        <div key={answer.name} className="space-y-1.5 rounded-lg border border-border bg-panel p-3">
          <div className="flex items-baseline gap-2 flex-wrap text-xs">
            <span className="font-mono font-medium text-fg">{answer.name}</span>
            {answer.kind === "choice" && (
              <span className="text-fg-muted">
                {t("dash.playground.decisionChosen", { choice: answer.choice })} · {t("dash.playground.decisionConfidence", { pct: percent(answer.confidence) })}
              </span>
            )}
            {answer.kind === "score" && (
              <span className="text-fg-muted">
                {t("dash.playground.decisionScored", { score: answer.score.toFixed(2), max: answer.levelCount - 1 })} · {t("dash.playground.decisionConfidence", { pct: percent(answer.confidence) })}
              </span>
            )}
          </div>
          {answer.kind === "yesno" && (
            <>
              <ProbabilityBar label={t("dash.playground.decisionYes")} probability={answer.probability} selected={answer.probability >= 0.5} />
              <ProbabilityBar label={t("dash.playground.decisionNo")} probability={1 - answer.probability} selected={answer.probability < 0.5} />
            </>
          )}
          {(answer.kind === "choice" || answer.kind === "score") && answer.bars.map((bar) => <ProbabilityBar key={bar.label} {...bar} />)}
          {answer.kind === "refusal" && <div className="text-xs text-warn-text">{t("dash.playground.decisionRefusal")}</div>}
        </div>
      ))}
    </section>
  )
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
