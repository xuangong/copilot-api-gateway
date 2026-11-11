import { useEffect, useRef, useState } from "react"
import { useT } from "../../state/i18n"
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

  return (
    <div className="flex flex-col h-full min-h-0 pg-chat-surface">
      <div className="pg-topbar">
        <span className="text-themed-dim">{t("dash.playground.protocol")}:</span>
        <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
          {DIALECTS.map((d) => (
            <button
              key={d.value}
              onClick={() => setDialect(d.value)}
              disabled={sending}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                dialect === d.value ? "bg-surface-600 text-themed" : "text-themed-dim hover:text-themed-secondary"
              }`}
            >
              {d.label}
              {d.value === native && <span className="ml-1.5 text-[10px] text-accent-teal">{t("dash.playground.decisionNative")}</span>}
            </button>
          ))}
        </div>
        <span className="text-themed-dim">
          {dialect === native
            ? t("dash.playground.decisionFormatNativeHint", { format: dialectLabel(dialect), path: decisionPath(dialect) })
            : t("dash.playground.decisionFormatTranslatedHint", { format: dialectLabel(dialect), path: decisionPath(dialect), native: dialectLabel(native) })}
        </span>
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
              {t("dash.playground.decisionState")}
              <span className="pg-label-hint">{t("dash.playground.decisionStateHint")}</span>
            </div>
            <textarea
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
            <div className="flex items-center gap-1.5 text-xs flex-wrap">
              <span className="text-themed-dim">{t("dash.playground.decisionAddQuestion")}:</span>
              {TYPES.map((type) => (
                <button key={type.value} className="pg-mini-btn" onClick={() => edit({ ...draft, questions: [...draft.questions, blankQuestion(type.value)] })}>
                  + {t(type.key)}
                </button>
              ))}
            </div>
          </section>

          {dropped > 0 && <div className="pg-warn">⚠ {t("dash.playground.decisionCriteriaDropped", { n: dropped })}</div>}

          <div className="flex items-center gap-3">
            <button className="btn-primary py-2! px-5!" disabled={problem !== null || sending} onClick={() => void send()}>
              {t("dash.playground.send")}
            </button>
            {sending && (
              <button className="btn-ghost py-2! px-4!" onClick={() => abortRef.current?.abort()}>{t("dash.playground.stop")}</button>
            )}
            {problem && (
              <span className="text-xs text-(--danger)">
                {t(problem.key, { n: (problem.question ?? 0) + 1 })}
              </span>
            )}
          </div>

          <div ref={resultRef} className="scroll-mt-4">
            {result ? <DecisionResult result={result} /> : !sending && (
              <div className="text-xs text-themed-dim">{t("dash.playground.decisionEmpty")}</div>
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
  return (
    <div className={"pg-card space-y-2" + (problemKey ? " is-invalid" : "")}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-themed-dim">#{index + 1}</span>
        <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
          {TYPES.map((entry) => (
            <button
              key={entry.value}
              onClick={() => onRetype(entry.value)}
              className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-all ${
                question.type === entry.value ? "bg-surface-600 text-themed" : "text-themed-dim hover:text-themed-secondary"
              }`}
            >
              {t(entry.key)}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="pg-field flex-1 min-w-[140px] w-auto!"
          value={question.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t("dash.playground.decisionNamePlaceholder")}
          title={t("dash.playground.decisionNameHint")}
        />
        <button className="pg-mini-btn" onClick={onRemove} title={t("dash.playground.decisionRemove")}>✕</button>
      </div>
      <div className="text-[11px] text-themed-dim">{t(type.hintKey)}</div>
      <input
        type="text"
        className="pg-field pg-field-sans"
        value={question.instructions}
        onChange={(e) => onChange({ instructions: e.target.value })}
        placeholder={t(instructionsRequired
          ? "dash.playground.decisionInstructionsRequiredPlaceholder"
          : "dash.playground.decisionInstructionsPlaceholder")}
      />

      {question.type === "yesno" && (dialect === "typesafe-systemone" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input type="text" className="pg-field pg-field-sans" value={question.criteriaTrue}
            onChange={(e) => onChange({ criteriaTrue: e.target.value })} placeholder={t("dash.playground.decisionCriteriaTrue")} />
          <input type="text" className="pg-field pg-field-sans" value={question.criteriaFalse}
            onChange={(e) => onChange({ criteriaFalse: e.target.value })} placeholder={t("dash.playground.decisionCriteriaFalse")} />
        </div>
      ) : (
        <div className="text-[11px] text-themed-dim">{t("dash.playground.decisionCriteriaHidden")}</div>
      ))}

      {question.type === "choice" && (
        <div className="space-y-1.5">
          {question.options.map((option, at) => (
            <div key={at} className="flex items-center gap-2">
              <input type="text" className="pg-field w-40! shrink-0" value={option.value}
                onChange={(e) => onChange({ options: question.options.map((o, i) => (i === at ? { ...o, value: e.target.value } : o)) })}
                placeholder={t("dash.playground.decisionOptionValue")} />
              <input type="text" className="pg-field pg-field-sans flex-1" value={option.description}
                onChange={(e) => onChange({ options: question.options.map((o, i) => (i === at ? { ...o, description: e.target.value } : o)) })}
                placeholder={t("dash.playground.decisionOptionDescription")} />
              <button className="pg-mini-btn" onClick={() => onChange({ options: question.options.filter((_, i) => i !== at) })}
                title={t("dash.playground.decisionRemove")}>✕</button>
            </div>
          ))}
          <button className="pg-mini-btn" onClick={() => onChange({ options: [...question.options, { value: "", description: "" }] })}>
            {t("dash.playground.decisionAddOption")}
          </button>
        </div>
      )}

      {question.type === "score" && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-themed-dim">{t("dash.playground.decisionLevelsOrder")}</div>
          {question.levels.map((level, at) => (
            <div key={at} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-right text-xs font-mono text-themed-dim">{at}</span>
              <input type="text" className="pg-field pg-field-sans flex-1" value={level}
                onChange={(e) => onChange({ levels: question.levels.map((l, i) => (i === at ? e.target.value : l)) })}
                placeholder={t("dash.playground.decisionLevelPlaceholder", { n: at })} />
              <button className="pg-mini-btn" onClick={() => onChange({ levels: question.levels.filter((_, i) => i !== at) })}
                title={t("dash.playground.decisionRemove")}>✕</button>
            </div>
          ))}
          <button className="pg-mini-btn" disabled={question.levels.length >= MAX_LEVELS}
            onClick={() => onChange({ levels: [...question.levels, ""] })}>
            {t("dash.playground.decisionAddLevel")}
          </button>
        </div>
      )}

      {problemKey && <div className="text-xs text-(--danger)">{t(problemKey, { n: index + 1 })}</div>}
    </div>
  )
}

function ProbabilityBar({ label, probability, selected }: { label: string; probability: number; selected: boolean }) {
  return (
    <div className="pg-prob">
      <span className={"pg-prob-label" + (selected ? " is-selected" : "")} title={label}>{label}</span>
      <span className="pg-bar"><span className={"pg-bar-fill" + (selected ? " is-selected" : "")} style={{ width: percent(probability) }} /></span>
      <span className="pg-prob-value">{percent(probability)}</span>
    </div>
  )
}

function DecisionResult({ result }: { result: Result }) {
  const t = useT()
  const [raw, setRaw] = useState<"request" | "response" | null>(null)
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs text-themed-dim">
        <span className="pg-label mb-0!">{t("dash.playground.decisionAnswers")}</span>
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
            <button key={which} className={"pg-mini-btn" + (raw === which ? " is-active" : "")} onClick={() => setRaw(raw === which ? null : which)}>
              {t(which === "request" ? "dash.playground.rawRequest" : "dash.playground.rawResponse")}
            </button>
          ))}
        </span>
      </div>
      {raw && (
        <pre className="pg-raw">
          {raw === "request" ? JSON.stringify(result.request, null, 2) : prettyJson(result.text)}
        </pre>
      )}
      {result.error && <div className="pg-error mx-0!">⚠ {result.error}</div>}
      {result.answers?.map((answer) => (
        <div key={answer.name} className="pg-card space-y-1.5">
          <div className="flex items-baseline gap-2 flex-wrap text-xs">
            <span className="font-mono font-medium text-themed">{answer.name}</span>
            {answer.kind === "choice" && (
              <span className="text-themed-secondary">
                {t("dash.playground.decisionChosen", { choice: answer.choice })} · {t("dash.playground.decisionConfidence", { pct: percent(answer.confidence) })}
              </span>
            )}
            {answer.kind === "score" && (
              <span className="text-themed-secondary">
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
          {answer.kind === "refusal" && <div className="text-xs text-(--warn)">{t("dash.playground.decisionRefusal")}</div>}
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
