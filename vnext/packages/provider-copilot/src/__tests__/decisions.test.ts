import { test, expect } from "bun:test"
import { copilotDecisionProtocol, copilotModelEndpoints } from "../endpoints"
import { CopilotProvider } from "../provider"
import type { Model } from "../models"
import type { Fetcher } from "@vibe-core/upstream"

// Catalog entries observed on production Copilot `/models` (2026-11-06). Each
// model serves exactly one decision dialect: Luna answers on `/v1/decisions`
// and returns 400 `no_available_model_endpoints` on `/v1/systemone`;
// microsoft-decision-1 is the inverse.
const decisionModel = (id: string, supported_endpoints?: string[]): Model => ({
  id,
  name: id,
  object: "model",
  vendor: "OpenAI",
  version: id,
  preview: false,
  model_picker_enabled: false,
  capabilities: { family: id, limits: {}, object: "model_capabilities", supports: {}, tokenizer: "o200k_base", type: "decisions" },
  ...(supported_endpoints ? { supported_endpoints } : {}),
})
const LUNA = decisionModel("gpt-6-luna-decisions", ["/v1/decisions"])
const SYSTEM_ONE = decisionModel("microsoft-decision-1", ["/v1/systemone"])

test("decision models carry only the decision endpoint", () => {
  expect(copilotModelEndpoints(LUNA)).toEqual({ decision: {} })
  expect(copilotModelEndpoints(SYSTEM_ONE)).toEqual({ decision: {} })
})

test("the advertised path names each model's dialect", () => {
  expect(copilotDecisionProtocol(LUNA)).toBe("openai-decisions")
  expect(copilotDecisionProtocol(SYSTEM_ONE)).toBe("typesafe-systemone")
  expect(copilotDecisionProtocol(decisionModel("bare", ["/decisions"]))).toBe("openai-decisions")
  expect(copilotDecisionProtocol(decisionModel("bare", ["/systemone"]))).toBe("typesafe-systemone")
})

// The declared type marks a decision model; the path only picks its dialect.
// Without exactly one dialect there is nothing safe to call, and a catalog
// that omits the path must not fall into the chat_completions inference.
test("a decision model without exactly one known dialect is not served", () => {
  for (const model of [decisionModel("silent"), decisionModel("unknown", ["/v1/decide"]),
    decisionModel("both", ["/v1/decisions", "/v1/systemone"])]) {
    expect(copilotDecisionProtocol(model)).toBeUndefined()
    expect(copilotModelEndpoints(model)).toEqual({})
  }
})

test("a chat model never reports a decision dialect", () => {
  expect(copilotDecisionProtocol({ ...LUNA, capabilities: { ...LUNA.capabilities, type: "chat" } })).toBeUndefined()
})

interface SeenCall { url: string; body: string }

const provider = (seen: SeenCall[]) => {
  const fetcher: Fetcher = async (url, init) => {
    seen.push({ url, body: String(init.body) })
    return Response.json({ answers: {} })
  }
  const copilot = new CopilotProvider({ copilotToken: "tok", accountType: "individual" }, fetcher)
  copilot.setModelCatalog({ object: "list", data: [LUNA, SYSTEM_ONE] })
  return copilot
}

test("the provider declares the decision endpoint and resolves dialects from its catalog", () => {
  const copilot = provider([])
  expect(copilot.supportedEndpoints).toContain("decision")
  expect(copilot.decisionProtocol("gpt-6-luna-decisions")).toBe("openai-decisions")
  expect(copilot.decisionProtocol("microsoft-decision-1")).toBe("typesafe-systemone")
  expect(copilot.decisionProtocol("gpt-4o")).toBeUndefined()
})

test("decision requests go to the path of the model's own dialect, body unchanged", async () => {
  const seen: SeenCall[] = []
  const copilot = provider(seen)
  const luna = { model: "gpt-6-luna-decisions", input: "s", questions: [{ type: "predicate", name: "q", instructions: "i" }] }
  const systemOne = { model: "microsoft-decision-1", state: "s", questions: { q: { type: "noul", instructions: "i" } } }
  for (const payload of [luna, systemOne]) {
    const response = await copilot.fetch({ endpoint: "decision", sourceApi: "openai", headers: new Headers({ "content-type": "application/json" }), payload })
    expect(response.status).toBe(200)
  }
  expect(seen.map(call => call.url)).toEqual([
    "https://api.githubcopilot.com/v1/decisions",
    "https://api.githubcopilot.com/v1/systemone",
  ])
  expect(JSON.parse(seen[0]!.body)).toEqual(luna)
  expect(JSON.parse(seen[1]!.body)).toEqual(systemOne)
})

test("a decision request for a model without a dialect fails before egress", async () => {
  const seen: SeenCall[] = []
  await expect(provider(seen).fetch({ endpoint: "decision", sourceApi: "openai", headers: new Headers(),
    payload: { model: "gpt-4o", state: "s", questions: {} } })).rejects.toThrow("does not serve decisions")
  expect(seen).toHaveLength(0)
})
