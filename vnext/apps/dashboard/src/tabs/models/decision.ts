// Decision playground: builds a request in either decision dialect from one
// draft and reads either dialect's answers into one view. The gateway
// translates between the dialects, so the panel can call a model in its own
// dialect (the default) or in the other one to exercise the translation.
//   - System One (`/v1/systemone`): `state` plus questions keyed by name.
//   - OpenAI Decisions (`/v1/decisions`): `input` plus an ordered question list.

export type DecisionDialect = "typesafe-systemone" | "openai-decisions"
export type DecisionQuestionType = "yesno" | "choice" | "score"

export interface DecisionQuestionDraft {
  /** Stable React key; never sent. */
  id: string
  type: DecisionQuestionType
  name: string
  /** Optional for System One models, which can read a question from its options or levels alone. */
  instructions: string
  /** Yes/no criteria. System One only: OpenAI predicates have no criteria. */
  criteriaTrue: string
  criteriaFalse: string
  options: Array<{ value: string; description: string }>
  /** Ordered from lowest to highest; the index is the level number. */
  levels: string[]
}

export interface DecisionDraft {
  state: string
  questions: DecisionQuestionDraft[]
}

// Both contracts bound these; the stricter OpenAI bounds apply to both.
const CHOICE_OPTION_MIN = 2
const CHOICE_OPTION_MAX = 255
const SCORE_LEVEL_MIN = 2
const SCORE_LEVEL_MAX = 10

export function nativeDecisionDialect(supportedEndpoints: readonly string[] | undefined): DecisionDialect {
  const paths = supportedEndpoints ?? []
  const openai = paths.some((path) => path === "/v1/decisions" || path === "/decisions")
  const systemOne = paths.some((path) => path === "/v1/systemone" || path === "/systemone")
  return openai && !systemOne ? "openai-decisions" : "typesafe-systemone"
}

export function decisionPath(dialect: DecisionDialect): "/v1/decisions" | "/v1/systemone" {
  return dialect === "openai-decisions" ? "/v1/decisions" : "/v1/systemone"
}

const trimmed = (value: string): string | undefined => value.trim() || undefined

export interface DecisionDraftProblem {
  /** i18n key of the message. */
  key: string
  /** Index of the question at fault; absent for draft-wide problems. */
  question?: number
}

/**
 * The first problem that would make the gateway or the model reject the
 * draft, or null. `native` is the model's own format: an OpenAI Decisions
 * model needs instructions on every question in either format, because the
 * gateway's translation has nothing faithful to fill them with.
 */
export function validateDecisionDraft(draft: DecisionDraft, native: DecisionDialect): DecisionDraftProblem | null {
  if (!draft.state.trim()) return { key: "dash.playground.decisionErrState" }
  if (draft.questions.length === 0) return { key: "dash.playground.decisionErrNoQuestions" }
  const names = new Set<string>()
  for (const [question, entry] of draft.questions.entries()) {
    const name = entry.name.trim()
    if (!name) return { key: "dash.playground.decisionErrName", question }
    if (names.has(name)) return { key: "dash.playground.decisionErrDuplicate", question }
    names.add(name)
    if (native === "openai-decisions" && !entry.instructions.trim()) return { key: "dash.playground.decisionErrInstructions", question }
    if (entry.type === "choice") {
      const values = entry.options.map((option) => option.value.trim())
      if (values.length < CHOICE_OPTION_MIN || values.length > CHOICE_OPTION_MAX
        || values.some((value) => !value) || new Set(values).size !== values.length) return { key: "dash.playground.decisionErrOptions", question }
    }
    if (entry.type === "score") {
      const levels = entry.levels.map((level) => level.trim())
      if (levels.length < SCORE_LEVEL_MIN || levels.length > SCORE_LEVEL_MAX || levels.some((level) => !level)) {
        return { key: "dash.playground.decisionErrLevels", question }
      }
    }
  }
  return null
}

const hasCriteria = (question: DecisionQuestionDraft) =>
  question.type === "yesno" && (question.criteriaTrue.trim() !== "" || question.criteriaFalse.trim() !== "")

/**
 * How many yes/no questions have criteria the model will never see. Criteria
 * exist only in System One: an OpenAI request cannot carry them, and the
 * gateway drops them when it translates a System One request for an OpenAI
 * Decisions model.
 */
export function unsentCriteria(draft: DecisionDraft, dialect: DecisionDialect, native: DecisionDialect): number {
  if (dialect === "typesafe-systemone" && native === "typesafe-systemone") return 0
  return draft.questions.filter(hasCriteria).length
}

function systemOneQuestion(question: DecisionQuestionDraft): Record<string, unknown> {
  const instructions = trimmed(question.instructions)
  const base = { type: question.type === "yesno" ? "noul" : question.type, ...(instructions ? { instructions } : {}) }
  if (question.type === "choice") {
    return { ...base, criteria: Object.fromEntries(question.options.map((option) => [option.value.trim(), trimmed(option.description) ?? null])) }
  }
  if (question.type === "score") return { ...base, criteria: question.levels.map((level) => level.trim()) }
  const criteria = {
    ...(trimmed(question.criteriaTrue) ? { true: question.criteriaTrue.trim() } : {}),
    ...(trimmed(question.criteriaFalse) ? { false: question.criteriaFalse.trim() } : {}),
  }
  return Object.keys(criteria).length > 0 ? { ...base, criteria } : base
}

function openAIQuestion(question: DecisionQuestionDraft): Record<string, unknown> {
  const instructions = trimmed(question.instructions)
  const base = { name: question.name.trim(), ...(instructions ? { instructions } : {}) }
  if (question.type === "choice") {
    return { type: "choice", ...base, choices: question.options.map((option) => {
      const description = trimmed(option.description)
      return { value: option.value.trim(), ...(description ? { description } : {}) }
    }) }
  }
  if (question.type === "score") return { type: "score", ...base, levels: question.levels.map((level) => ({ label: level.trim() })) }
  return { type: "predicate", ...base }
}

export function buildDecisionBody(dialect: DecisionDialect, model: string, draft: DecisionDraft): Record<string, unknown> {
  if (dialect === "openai-decisions") {
    return { model, input: draft.state, questions: draft.questions.map(openAIQuestion) }
  }
  return { model, state: draft.state, questions: Object.fromEntries(draft.questions.map((question) => [question.name.trim(), systemOneQuestion(question)])) }
}

const QUESTION_TYPES = new Set<DecisionQuestionType>(["yesno", "choice", "score"])
const optionalString = (value: unknown): string | null => (value === undefined ? "" : typeof value === "string" ? value : null)

function restoreQuestion(value: unknown, index: number): DecisionQuestionDraft | null {
  if (!isRecord(value) || !QUESTION_TYPES.has(value.type as DecisionQuestionType) || typeof value.name !== "string") return null
  const instructions = optionalString(value.instructions)
  const criteriaTrue = optionalString(value.criteriaTrue)
  const criteriaFalse = optionalString(value.criteriaFalse)
  const options = value.options ?? []
  const levels = value.levels ?? []
  if (instructions === null || criteriaTrue === null || criteriaFalse === null || !Array.isArray(options) || !Array.isArray(levels)) return null
  if (!options.every((option) => isRecord(option) && typeof option.value === "string" && optionalString(option.description) !== null)) return null
  if (!levels.every((level) => typeof level === "string")) return null
  return {
    id: typeof value.id === "string" ? value.id : `restored-${index}`,
    type: value.type as DecisionQuestionType,
    name: value.name,
    instructions,
    criteriaTrue,
    criteriaFalse,
    options: options.map((option) => ({ value: option.value as string, description: (option.description as string | undefined) ?? "" })),
    levels: levels as string[],
  }
}

/** A draft saved by an earlier visit, or null when storage holds nothing usable. */
export function restoreDecisionDraft(raw: string | null): DecisionDraft | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.state !== "string" || !Array.isArray(value.questions)) return null
  const questions = value.questions.map(restoreQuestion)
  return questions.every((question) => question !== null) ? { state: value.state, questions: questions as DecisionQuestionDraft[] } : null
}

export interface DecisionBar {
  label: string
  probability: number
  selected: boolean
}

export type DecisionAnswerView =
  | { name: string; kind: "yesno"; probability: number }
  | { name: string; kind: "choice"; choice: string; confidence: number; bars: DecisionBar[] }
  | { name: string; kind: "score"; score: number; confidence: number; levelCount: number; bars: DecisionBar[] }
  | { name: string; kind: "refusal" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const num = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number`)
  return value
}

const withSelection = (bars: Array<{ label: string; probability: number }>, isSelected: (index: number) => boolean): DecisionBar[] =>
  bars.map((bar, index) => ({ ...bar, selected: isSelected(index) }))

/** The most probable level is the one a score lands nearest in practice. */
const scoreBars = (entries: Array<{ value: number; label?: string; probability: number }>): DecisionBar[] => {
  const best = entries.reduce((top, entry, index) => (entry.probability > (entries[top]?.probability ?? -1) ? index : top), 0)
  return withSelection(entries.map((entry) => ({ label: entry.label ? `${entry.value} · ${entry.label}` : String(entry.value), probability: entry.probability })),
    (index) => index === best)
}

function systemOneAnswer(name: string, value: unknown): DecisionAnswerView {
  if (!isRecord(value)) throw new Error(`answers.${name} must be an object`)
  if (value.type === "noul") return { name, kind: "yesno", probability: num(value.noul, `answers.${name}.noul`) }
  if (!isRecord(value.probabilities)) throw new Error(`answers.${name}.probabilities must be an object`)
  const probabilities = Object.entries(value.probabilities).map(([key, probability]) => ({ key, probability: num(probability, `answers.${name}.probabilities.${key}`) }))
  const confidence = num(value.confidence, `answers.${name}.confidence`)
  if (value.type === "choice") {
    const choice = String(value.choice)
    return { name, kind: "choice", choice, confidence,
      bars: withSelection(probabilities.map(({ key, probability }) => ({ label: key, probability })), (index) => probabilities[index]?.key === choice) }
  }
  if (value.type === "score") {
    const legend = isRecord(value.legend) ? value.legend : {}
    return { name, kind: "score", score: num(value.score, `answers.${name}.score`), confidence, levelCount: probabilities.length,
      bars: scoreBars(probabilities.map(({ key, probability }) => {
        const label = legend[key]
        return { value: Number(key), probability, ...(typeof label === "string" ? { label } : label !== undefined ? { label: JSON.stringify(label) } : {}) }
      })) }
  }
  throw new Error(`answers.${name}.type is not a decision answer`)
}

function openAIAnswer(value: unknown, index: number): DecisionAnswerView {
  if (!isRecord(value) || typeof value.name !== "string") throw new Error(`answers[${index}] must be a named answer`)
  const name = value.name
  if (value.type === "refusal") return { name, kind: "refusal" }
  if (value.type === "predicate") return { name, kind: "yesno", probability: num(value.probability, `answers[${index}].probability`) }
  if (!Array.isArray(value.probabilities)) throw new Error(`answers[${index}].probabilities must be an array`)
  const entries = value.probabilities.map((entry, at) => {
    if (!isRecord(entry)) throw new Error(`answers[${index}].probabilities[${at}] must be an object`)
    return { value: entry.value, label: typeof entry.label === "string" ? entry.label : undefined, probability: num(entry.probability, `answers[${index}].probabilities[${at}].probability`) }
  })
  const confidence = num(value.confidence, `answers[${index}].confidence`)
  if (value.type === "choice") {
    return { name, kind: "choice", choice: String(value.choice), confidence,
      bars: withSelection(entries.map((entry) => ({ label: String(entry.value), probability: entry.probability })), (at) => entries[at]?.value === value.choice) }
  }
  if (value.type === "score") {
    return { name, kind: "score", score: num(value.score, `answers[${index}].score`), confidence, levelCount: entries.length,
      bars: scoreBars(entries.map((entry) => ({ value: Number(entry.value), probability: entry.probability, ...(entry.label ? { label: entry.label } : {}) }))) }
  }
  throw new Error(`answers[${index}].type is not a decision answer`)
}

const rankIn = (order: readonly string[]) => (key: string) => {
  const at = order.indexOf(key)
  return at === -1 ? order.length : at
}

/** Choice bars in the order the options were asked; unknown values keep their place after them. */
function orderChoiceBars(view: DecisionAnswerView, optionOrder: Readonly<Record<string, readonly string[]>>): DecisionAnswerView {
  const order = optionOrder[view.name]
  if (view.kind !== "choice" || !order) return view
  const rank = rankIn(order)
  return { ...view, bars: [...view.bars].sort((a, b) => rank(a.label) - rank(b.label)) }
}

/**
 * Answers in the order the questions were asked; unknown names come last.
 * `optionOrder` maps a choice question to its option values as asked.
 */
export function parseDecisionAnswers(
  dialect: DecisionDialect,
  body: unknown,
  questionOrder: readonly string[],
  optionOrder: Readonly<Record<string, readonly string[]>> = {},
): DecisionAnswerView[] {
  if (!isRecord(body)) throw new Error("The response is not a JSON object")
  let views: DecisionAnswerView[]
  if (dialect === "openai-decisions") {
    if (!Array.isArray(body.answers)) throw new Error("answers must be an array")
    views = body.answers.map(openAIAnswer)
  } else {
    if (!isRecord(body.answers)) throw new Error("answers must be an object keyed by question name")
    views = Object.entries(body.answers).map(([name, value]) => systemOneAnswer(name, value))
  }
  const rank = rankIn(questionOrder)
  return views.map((view) => orderChoiceBars(view, optionOrder)).sort((a, b) => rank(a.name) - rank(b.name))
}

export function decisionUsage(body: unknown): number | undefined {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : undefined
  return typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined
}

// —— Example scenarios ——
// Each one shows a typical use of decision models, with a hint on what to look
// for in the answers. Option values and question names stay the same in every
// language: they are the stable keys code would branch on, while state,
// instructions, descriptions and level labels are what the model reads.

export interface DecisionExample {
  id: string
  titleKey: string
  hintKey: string
  draft: DecisionDraft
}

type Localized = { en: string; zh: string }
type ExampleQuestion =
  | { type: "yesno"; name: string; instructions: Localized; criteriaTrue?: Localized; criteriaFalse?: Localized }
  | { type: "choice"; name: string; instructions: Localized; options: Array<{ value: string; description: Localized }> }
  | { type: "score"; name: string; instructions: Localized; levels: Localized[] }

const EXAMPLES: Array<{ id: string; key: string; state: Localized; questions: ExampleQuestion[] }> = [
  {
    id: "ticket-triage",
    key: "Triage",
    state: {
      en: "Since this morning every call to /v1/orders returns HTTP 500 and our checkout is down. We were also charged twice for last month's invoice.",
      zh: "从今天早上开始，所有 /v1/orders 调用都返回 HTTP 500，我们的结账功能已经瘫痪。另外上个月的账单还被重复扣了两次款。",
    },
    questions: [
      { type: "yesno", name: "is_outage", instructions: { en: "Does the customer report a service outage?", zh: "客户是否报告了服务中断？" } },
      { type: "choice", name: "team", instructions: { en: "Which team should handle this ticket first?", zh: "这张工单应该先交给哪个团队？" }, options: [
        { value: "billing", description: { en: "Charges, invoices and refunds", zh: "扣费、账单和退款" } },
        { value: "engineering", description: { en: "Bugs, errors and outages", zh: "缺陷、报错和服务中断" } },
        { value: "sales", description: { en: "Plans, pricing and upgrades", zh: "套餐、价格和升级" } },
      ] },
      { type: "score", name: "urgency", instructions: { en: "How urgent is this ticket?", zh: "这张工单有多紧急？" }, levels: [
        { en: "Can wait", zh: "可以等" }, { en: "Normal", zh: "一般" }, { en: "Today", zh: "今天处理" }, { en: "Drop everything", zh: "立即处理" },
      ] },
    ],
  },
  {
    id: "moderation",
    key: "Moderation",
    state: {
      en: "Cheap followers!!! 10k for $5, DM me on WhatsApp +1 555 0100 before the deal ends tonight.",
      zh: "超便宜涨粉！！！5 美元 1 万粉，今晚截止，加 WhatsApp +1 555 0100 私聊。",
    },
    questions: [
      { type: "yesno", name: "has_contact_info", instructions: { en: "Does the post share contact details?", zh: "帖子里是否留了联系方式？" },
        criteriaTrue: { en: "A phone number, email address or messaging handle appears", zh: "出现了电话号码、邮箱或聊天账号" },
        criteriaFalse: { en: "There is no way to reach the author outside the forum", zh: "无法在论坛之外联系到作者" } },
      { type: "choice", name: "category", instructions: { en: "Which moderation category fits best?", zh: "最符合哪个审核类别？" }, options: [
        { value: "spam", description: { en: "Advertising or scams", zh: "广告或诈骗" } },
        { value: "harassment", description: { en: "Attacks on a person or group", zh: "针对个人或群体的攻击" } },
        { value: "off_topic", description: { en: "Harmless but unrelated to the forum", zh: "无害但与论坛无关" } },
        { value: "ok", description: { en: "Fine to keep", zh: "可以保留" } },
      ] },
      { type: "score", name: "action", instructions: { en: "What should moderators do?", zh: "版主应该如何处理？" }, levels: [
        { en: "Keep", zh: "保留" }, { en: "Review", zh: "人工复核" }, { en: "Remove", zh: "删除" }, { en: "Remove and ban", zh: "删除并封号" },
      ] },
    ],
  },
  {
    id: "review",
    key: "Review",
    state: {
      en: "The headphones sound great and the battery lasts all week, but the left ear cup cracked after two weeks and support never replied.",
      zh: "耳机音质很好，续航能撑一整周，但左耳罩两周就裂了，联系客服也一直没人回复。",
    },
    questions: [
      { type: "yesno", name: "would_recommend", instructions: { en: "Would the reviewer recommend this product?", zh: "评论者会推荐这款产品吗？" } },
      { type: "choice", name: "main_issue", instructions: { en: "What is the reviewer's main complaint?", zh: "评论者最主要的不满是什么？" }, options: [
        { value: "quality", description: { en: "The product broke or is badly made", zh: "产品损坏或做工差" } },
        { value: "price", description: { en: "Too expensive for what it is", zh: "价格偏贵" } },
        { value: "delivery", description: { en: "Late, lost or damaged shipping", zh: "物流慢、丢件或运输损坏" } },
        { value: "support", description: { en: "Unhelpful or missing customer service", zh: "客服不作为或联系不上" } },
        { value: "none", description: { en: "No complaint", zh: "没有不满" } },
      ] },
      { type: "score", name: "rating", instructions: { en: "How many stars does this review deserve?", zh: "这条评价相当于几星？" }, levels: [
        { en: "1 star", zh: "1 星" }, { en: "2 stars", zh: "2 星" }, { en: "3 stars", zh: "3 星" }, { en: "4 stars", zh: "4 星" }, { en: "5 stars", zh: "5 星" },
      ] },
    ],
  },
  {
    id: "lead",
    key: "Lead",
    state: {
      en: "Hi, I lead IT at a 300-person logistics company. We need SSO and audit logs in place before our compliance audit in March, and the budget for this quarter is approved.",
      zh: "你好，我是一家 300 人物流公司的 IT 负责人。我们需要在 3 月合规审计前上线 SSO 和审计日志，本季度预算已经批下来了。",
    },
    questions: [
      { type: "yesno", name: "budget_confirmed", instructions: { en: "Has the prospect confirmed a budget?", zh: "对方是否确认了预算？" } },
      { type: "choice", name: "stage", instructions: { en: "Where is the prospect in the buying process?", zh: "对方处在采购流程的哪个阶段？" }, options: [
        { value: "browsing", description: { en: "Just collecting information", zh: "只是了解一下" } },
        { value: "evaluating", description: { en: "Comparing vendors against requirements", zh: "按需求对比供应商" } },
        { value: "ready_to_buy", description: { en: "Has a deadline and wants to sign", zh: "有明确期限，准备签约" } },
      ] },
      { type: "score", name: "fit", instructions: { en: "How well does the prospect fit our product?", zh: "对方与我们产品的匹配度如何？" }, levels: [
        { en: "Poor", zh: "不匹配" }, { en: "Possible", zh: "可能" }, { en: "Good", zh: "较好" }, { en: "Excellent", zh: "非常匹配" },
      ] },
    ],
  },
]

export function decisionExamples(lang: "en" | "zh"): DecisionExample[] {
  return EXAMPLES.map((example) => ({
    id: example.id,
    titleKey: `dash.playground.decisionExample${example.key}`,
    hintKey: `dash.playground.decisionExample${example.key}Hint`,
    draft: {
      state: example.state[lang],
      questions: example.questions.map((question, index) => ({
        id: `${example.id}-${index}`,
        type: question.type,
        name: question.name,
        instructions: question.instructions[lang],
        criteriaTrue: question.type === "yesno" ? question.criteriaTrue?.[lang] ?? "" : "",
        criteriaFalse: question.type === "yesno" ? question.criteriaFalse?.[lang] ?? "" : "",
        options: question.type === "choice" ? question.options.map((option) => ({ value: option.value, description: option.description[lang] })) : [],
        levels: question.type === "score" ? question.levels.map((level) => level[lang]) : [],
      })),
    },
  }))
}
