// Overlay-only coverage: retained alongside the untracked collaboration shim.
import { translatedFixture } from "../../shared/translated-fixture"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { doneFrame, eventFrame } from "@vibe-core/result"
import type { Invocation } from "@vibe-llm/protocols/common"
import { withResponsesCollaborationShim } from "../../../../../src/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim"
import { respondResponses } from "../../../../../src/data-plane/chat-flow/responses/respond"
import { setupTestPlatform } from "../../../../_setup-platform"

let platform: ReturnType<typeof setupTestPlatform>
beforeEach(() => { platform = setupTestPlatform() })
afterEach(() => platform.db.close())
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "up", cost: null }
const ctx = { requestStartedAt: 0, targetEndpoint: "chat_completions" as const }
function invocation(stream: boolean): Invocation {
  return { endpoint: "responses", sourceApi: "responses", action: "generate", headers: {}, enabledFlags: new Set(),
    payload: { model: "m", stream, input: [{ type: "message", role: "user", content: "hello" }], metadata: { retained: "body-only" }, instructions: "retained instructions" } }
}
async function readResponse(response: Response, stream: boolean): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (!stream) return JSON.parse(text) as Record<string, unknown>
  const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as { response?: Record<string, unknown> })
  const body = events.at(-1)?.response
  if (!body) throw new Error(text)
  return body
}
for (const stream of [false, true]) {
  test(`collaboration shim keeps ${stream ? "event" : "body"} translation independent and restores its namespace`, async () => {
    const inv = invocation(stream)
    inv.enabledFlags = new Set(["responses-collaboration-shim"])
    inv.payload.tools = [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }] }]
    const counts = { body: 0, events: 0 }
    // Namespace tools are currently rejected by the real cross-protocol
    // request translator; exercise this response adapter seam explicitly.
    const result = await withResponsesCollaborationShim(inv, ctx, async () => {
      const tools = inv.payload.tools as Array<{ name: string }>
      const response = { id: "r", object: "response", status: "completed", model: "m", output: [
        { type: "function_call", id: "f", call_id: "c", namespace: tools[0]?.name, name: "spawn_agent", arguments: "{}" },
      ] }
      return translatedFixture({ kind: "translated", source: "responses", protocol: "chat_completions" },
        (async function* () { yield eventFrame({ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); yield doneFrame() })(), identity,
        undefined, undefined,
        () => { counts.body++; return response },
        async function* () { counts.events++; yield { type: "response.completed", response } },
      )
    })
    if (result.type !== "events") throw new Error("Expected events")
    expect(result.producer?.protocol).toBe("chat_completions")
    const body = await readResponse(await respondResponses(result, { wantsStream: stream }), stream)
    expect(body.output).toMatchObject([{ namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [] }])
    expect(counts).toEqual({ body: stream ? 0 : 1, events: stream ? 1 : 0 })
  })
}
