import { expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { HTTPError } from "@vibe-llm/provider-llm"
import { CopilotProvider } from "../provider"

const payload = { model: "gpt-4o", input: [{ role: "user", content: "hi" }], tools: [{ type: "namespace", name: "demo", description: "", tools: [] }] }

for (const action of ["generate", "compact"] as const) {
  test(`Copilot ${action} repairs namespace description on Responses wire`, async () => {
    let wire: Record<string, unknown> | undefined
    const fetcher: Fetcher = async (_url, init) => {
      wire = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response("{}", { status: 200 })
    }
    const provider = new CopilotProvider({ copilotToken: "token", accountType: "individual" }, fetcher)
    await provider.fetch({ endpoint: "responses", action, sourceApi: "openai", headers: new Headers(), payload })
    expect((wire?.tools as Array<Record<string, unknown>>)[0]?.description).toBe("Tools in the demo namespace.")
    expect(payload.tools[0]?.description).toBe("")
  })
}

test("Copilot does not repair a non-Responses request", async () => {
  let wire: Record<string, unknown> | undefined
  const fetcher: Fetcher = async (_url, init) => {
    wire = JSON.parse(String(init.body)) as Record<string, unknown>
    return new Response("{}", { status: 200 })
  }
  const provider = new CopilotProvider({ copilotToken: "token", accountType: "individual" }, fetcher)
  await provider.fetch({ endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(), payload: { model: "gpt-4o", messages: [], tools: payload.tools } })
  expect((wire?.tools as Array<Record<string, unknown>>)[0]?.description).toBe("")
})

test("Copilot preserves strict upstream error status, header, and body", async () => {
  const fetcher: Fetcher = async () => new Response("bad namespace", { status: 422, headers: { "x-trace": "trace-1" } })
  const provider = new CopilotProvider({ copilotToken: "token", accountType: "individual" }, fetcher)
  try {
    await provider.fetch({ endpoint: "responses", sourceApi: "openai", headers: new Headers(), payload })
    throw new Error("expected HTTPError")
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPError)
    if (!(error instanceof HTTPError)) throw error
    expect(error.response.status).toBe(422)
    expect(error.response.headers.get("x-trace")).toBe("trace-1")
    expect(await error.response.text()).toBe("bad namespace")
  }
})
