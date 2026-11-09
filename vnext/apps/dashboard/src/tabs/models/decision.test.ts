import { describe, expect, it } from "bun:test"
import {
  buildDecisionBody,
  decisionPath,
  decisionExamples,
  decisionUsage,
  nativeDecisionDialect,
  parseDecisionAnswers,
  restoreDecisionDraft,
  unsentCriteria,
  validateDecisionDraft,
  type DecisionDraft,
} from "./decision"

const draft: DecisionDraft = {
  state: "The API returns 500 on every call.",
  questions: [
    { id: "1", type: "yesno", name: "is_bug", instructions: "Is this a bug report?", criteriaTrue: "Describes broken behaviour", criteriaFalse: "", options: [], levels: [] },
    { id: "2", type: "choice", name: "team", instructions: "Which team?", criteriaTrue: "", criteriaFalse: "",
      options: [{ value: "billing", description: "Charges" }, { value: "engineering", description: "" }], levels: [] },
    { id: "3", type: "score", name: "severity", instructions: "", criteriaTrue: "", criteriaFalse: "", options: [], levels: ["Low", "High"] },
  ],
}

describe("dialect", () => {
  it("uses the dialect the model advertises", () => {
    expect(nativeDecisionDialect(["/v1/decisions"])).toBe("openai-decisions")
    expect(nativeDecisionDialect(["/v1/systemone"])).toBe("typesafe-systemone")
  })

  it("defaults to System One when the model advertises both or neither", () => {
    expect(nativeDecisionDialect(undefined)).toBe("typesafe-systemone")
    expect(nativeDecisionDialect(["/v1/decisions", "/v1/systemone"])).toBe("typesafe-systemone")
  })

  it("maps each dialect to its gateway path", () => {
    expect(decisionPath("openai-decisions")).toBe("/v1/decisions")
    expect(decisionPath("typesafe-systemone")).toBe("/v1/systemone")
  })
})

describe("request body", () => {
  it("builds a System One body keyed by question name", () => {
    expect(buildDecisionBody("typesafe-systemone", "microsoft-decision-1", draft)).toEqual({
      model: "microsoft-decision-1",
      state: "The API returns 500 on every call.",
      questions: {
        is_bug: { type: "noul", instructions: "Is this a bug report?", criteria: { true: "Describes broken behaviour" } },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", engineering: null } },
        severity: { type: "score", criteria: ["Low", "High"] },
      },
    })
  })

  it("builds an OpenAI Decisions body as an ordered question list", () => {
    expect(buildDecisionBody("openai-decisions", "gpt-6-luna-decisions", draft)).toEqual({
      model: "gpt-6-luna-decisions",
      input: "The API returns 500 on every call.",
      questions: [
        { type: "predicate", name: "is_bug", instructions: "Is this a bug report?" },
        { type: "choice", name: "team", instructions: "Which team?", choices: [{ value: "billing", description: "Charges" }, { value: "engineering" }] },
        { type: "score", name: "severity", levels: [{ label: "Low" }, { label: "High" }] },
      ],
    })
  })
})

describe("validation", () => {
  it("accepts a complete draft", () => {
    expect(validateDecisionDraft(draft, "typesafe-systemone")).toBeNull()
  })

  it("names the first problem and the question it is in", () => {
    expect(validateDecisionDraft({ ...draft, state: "  " }, "typesafe-systemone")).toEqual({ key: "dash.playground.decisionErrState" })
    expect(validateDecisionDraft({ ...draft, questions: [] }, "typesafe-systemone")).toEqual({ key: "dash.playground.decisionErrNoQuestions" })
    const [first, second, third] = draft.questions
    const problem = (questions: DecisionDraft["questions"]) => validateDecisionDraft({ ...draft, questions }, "typesafe-systemone")
    expect(problem([{ ...first!, name: "" }])).toEqual({ key: "dash.playground.decisionErrName", question: 0 })
    expect(problem([first!, { ...second!, name: "is_bug" }])).toEqual({ key: "dash.playground.decisionErrDuplicate", question: 1 })
    expect(problem([first!, { ...second!, options: [{ value: "billing", description: "" }] }])).toEqual({ key: "dash.playground.decisionErrOptions", question: 1 })
    expect(problem([{ ...second!, options: [{ value: "a", description: "" }, { value: "a", description: "" }] }])).toEqual({ key: "dash.playground.decisionErrOptions", question: 0 })
    expect(problem([first!, second!, { ...third!, levels: ["Only"] }])).toEqual({ key: "dash.playground.decisionErrLevels", question: 2 })
    expect(problem([{ ...third!, levels: ["Low", " "] }])).toEqual({ key: "dash.playground.decisionErrLevels", question: 0 })
  })
})

describe("instructions", () => {
  // The OpenAI API requires them on every question, and a translated System
  // One request needs them too, so the model, not the format sent, decides.
  it("are required when the model is an OpenAI Decisions model, whatever format is sent", () => {
    expect(validateDecisionDraft(draft, "typesafe-systemone")).toBeNull()
    expect(validateDecisionDraft(draft, "openai-decisions")).toEqual({ key: "dash.playground.decisionErrInstructions", question: 2 })
    const blankFirst = { ...draft, questions: [{ ...draft.questions[0]!, instructions: "  " }, ...draft.questions.slice(1)] }
    expect(validateDecisionDraft(blankFirst, "openai-decisions")).toEqual({ key: "dash.playground.decisionErrInstructions", question: 0 })
  })
})

describe("yes/no criteria", () => {
  // Only a System One request to a System One model carries them: OpenAI
  // predicates have no criteria, and the gateway's translation drops them.
  it("reach the model only in System One to a System One model", () => {
    expect(unsentCriteria(draft, "typesafe-systemone", "typesafe-systemone")).toBe(0)
    expect(unsentCriteria(draft, "openai-decisions", "typesafe-systemone")).toBe(1)
    expect(unsentCriteria(draft, "typesafe-systemone", "openai-decisions")).toBe(1)
  })

  it("count only yes/no questions that have criteria", () => {
    const blank = { ...draft, questions: draft.questions.map((q) => ({ ...q, criteriaTrue: "", criteriaFalse: "" })) }
    expect(unsentCriteria(blank, "openai-decisions", "openai-decisions")).toBe(0)
  })
})

describe("examples", () => {
  for (const lang of ["en", "zh"] as const) {
    it(`are complete, valid scenarios in ${lang}`, () => {
      const examples = decisionExamples(lang)
      expect(examples.length).toBeGreaterThanOrEqual(3)
      expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length)
      for (const example of examples) {
        for (const native of ["typesafe-systemone", "openai-decisions"] as const) expect(validateDecisionDraft(example.draft, native)).toBeNull()
        expect(example.titleKey).toStartWith("dash.playground.decisionExample")
        expect(example.hintKey).toStartWith("dash.playground.decisionExample")
      }
    })
  }

  it("show every question type somewhere", () => {
    const types = new Set(decisionExamples("en").flatMap((e) => e.draft.questions.map((q) => q.type)))
    expect([...types].sort()).toEqual(["choice", "score", "yesno"])
  })

  it("keep the same scenarios and question names across languages", () => {
    const shape = (lang: "en" | "zh") => decisionExamples(lang).map((e) => [e.id, e.draft.questions.map((q) => [q.name, q.type])])
    expect(shape("zh")).toEqual(shape("en"))
  })
})

describe("answers", () => {
  const order = ["is_bug", "team", "severity"]

  it("reads System One answers in question order", () => {
    const views = parseDecisionAnswers("typesafe-systemone", {
      answers: {
        severity: { type: "score", score: 0.8, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "Low", "1": "High" } },
        team: { type: "choice", choice: "engineering", confidence: 0.9, probabilities: { billing: 0.1, engineering: 0.9 } },
        is_bug: { type: "noul", noul: 0.97 },
      },
    }, order)
    expect(views).toEqual([
      { name: "is_bug", kind: "yesno", probability: 0.97 },
      { name: "team", kind: "choice", choice: "engineering", confidence: 0.9,
        bars: [{ label: "billing", probability: 0.1, selected: false }, { label: "engineering", probability: 0.9, selected: true }] },
      { name: "severity", kind: "score", score: 0.8, confidence: 0.6, levelCount: 2,
        bars: [{ label: "0 · Low", probability: 0.2, selected: false }, { label: "1 · High", probability: 0.8, selected: true }] },
    ])
  })

  it("reads OpenAI answers, including a refused question", () => {
    const views = parseDecisionAnswers("openai-decisions", {
      answers: [
        { type: "predicate", name: "is_bug", probability: 0.4 },
        { type: "refusal", name: "team" },
        { type: "score", name: "severity", score: 1, confidence: 0.7, probabilities: [{ value: 0, label: "Low", probability: 0.3 }, { value: 1, label: "High", probability: 0.7 }] },
      ],
    }, order)
    expect(views).toEqual([
      { name: "is_bug", kind: "yesno", probability: 0.4 },
      { name: "team", kind: "refusal" },
      { name: "severity", kind: "score", score: 1, confidence: 0.7, levelCount: 2,
        bars: [{ label: "0 · Low", probability: 0.3, selected: false }, { label: "1 · High", probability: 0.7, selected: true }] },
    ])
  })

  // System One returns choice probabilities keyed by value, in whatever order
  // the upstream serialises them; bars follow the options as they were asked.
  it("orders choice bars as the options were asked", () => {
    const body = { answers: { team: { type: "choice", choice: "engineering", confidence: 0.9,
      probabilities: { billing: 0.05, engineering: 0.9, sales: 0.05 } } } }
    const [view] = parseDecisionAnswers("typesafe-systemone", body, ["team"], { team: ["sales", "engineering", "billing"] })
    expect(view!.kind === "choice" && view!.bars.map((bar) => bar.label)).toEqual(["sales", "engineering", "billing"])
    const [unordered] = parseDecisionAnswers("typesafe-systemone", body, ["team"], { team: ["engineering"] })
    expect(unordered!.kind === "choice" && unordered!.bars.map((bar) => bar.label)).toEqual(["engineering", "billing", "sales"])
  })

  it("rejects a body that is not an answer set", () => {
    expect(() => parseDecisionAnswers("openai-decisions", { answers: {} }, order)).toThrow()
    expect(() => parseDecisionAnswers("typesafe-systemone", { error: { message: "nope" } }, order)).toThrow()
  })

  it("reads input token usage when present", () => {
    expect(decisionUsage({ usage: { input_tokens: 56, output_tokens: 1 } })).toBe(56)
    expect(decisionUsage({})).toBeUndefined()
  })
})

describe("stored draft", () => {
  it("round-trips through storage", () => {
    expect(restoreDecisionDraft(JSON.stringify(draft))).toEqual(draft)
  })

  it("fills fields an older draft lacks", () => {
    const restored = restoreDecisionDraft(JSON.stringify({ state: "s", questions: [{ id: "1", type: "choice", name: "team" }] }))
    expect(restored).toEqual({ state: "s", questions: [{ id: "1", type: "choice", name: "team", instructions: "",
      criteriaTrue: "", criteriaFalse: "", options: [], levels: [] }] })
  })

  it("discards anything that is not a draft", () => {
    for (const raw of [null, "", "{", "[]", JSON.stringify({ state: 1, questions: [] }),
      JSON.stringify({ state: "s", questions: [{ type: "essay", name: "x" }] }),
      JSON.stringify({ state: "s", questions: [{ type: "choice", name: "x", options: [{ value: 1 }] }] })]) {
      expect(restoreDecisionDraft(raw)).toBeNull()
    }
  })
})
