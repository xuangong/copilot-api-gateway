import { expect, test } from "bun:test"
import type { ResponsesPayload } from "@vibe-llm/protocols/responses"
import { translateResponsesToMessages } from "../../src/responses-via-messages/request"
import { prepareResponsesTools, restoreResponsesToolEvents } from "../../src/shared/responses-namespace-tools"
import { translateResponsesToChat } from "../../src/responses-via-chat-completions/request"

for (const [kind, translate] of [["messages", translateResponsesToMessages], ["chat", translateResponsesToChat]] as const) {
  const run = (fields: Record<string, unknown>) => translate({ model: "m", input: [], ...fields } as ResponsesPayload).target
  const names = (target: ReturnType<typeof run>) => (target.tools as Array<{ name?: string; function?: { name: string } }>).map(tool => tool.name ?? tool.function?.name)

  test(`${kind}: namespace declarations, choice and history share collision-safe names`, () => {
    const source = { tools: [
      { type: "function", name: "agents_spawn" },
      { type: "namespace", name: "agents", description: "Agents", tools: [
        { type: "function", name: "spawn", parameters: { type: "object" } },
        { type: "custom", name: "audit", format: { type: "text" } },
      ] },
    ], tool_choice: { type: "function", namespace: "agents", name: "spawn" }, input: [
      { type: "function_call", namespace: "agents", name: "spawn", call_id: "old", arguments: "{}" },
      { type: "function_call_output", call_id: "old", output: "ok" },
    ] }
    const before = structuredClone(source)
    const target = run(source)
    expect(names(target)).toEqual(["agents_spawn", "agents_spawn_2", "agents_audit"])
    expect(target.tool_choice).toEqual(kind === "messages" ? { type: "tool", name: "agents_spawn_2" } : { type: "function", function: { name: "agents_spawn_2" } })
    expect(JSON.stringify(target.messages)).toContain('"name":"agents_spawn_2"')
    expect(source).toEqual(before)
  })

  test(`${kind}: namespace allowed_tools selects only its children`, () => {
    const target = run({ tools: [
      { type: "function", name: "flat" },
      { type: "namespace", name: "files", tools: [{ type: "function", name: "read" }, { type: "custom", name: "write" }] },
    ], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "namespace", name: "files" }] } })
    expect(names(target)).toEqual(["files_read", "files_write"])
    expect(target.tool_choice).toEqual(kind === "messages" ? { type: "any" } : "required")
  })

  test(`${kind}: explicit namespace declarations and historical inventories are expanded`, () => {
    const target = run({ tools: [{ type: "function", namespace: "files", name: "read" }], input: [
      { type: "additional_tools", tools: [{ type: "namespace", name: "shell", tools: [{ type: "custom", name: "run" }] }] },
      { type: "tool_search_output", tools: [{ type: "function", namespace: "db", name: "query" }] },
      { type: "custom_tool_call", namespace: "shell", name: "run", call_id: "c", input: "echo hi" },
      { type: "custom_tool_call_output", call_id: "c", output: "hi" },
    ] })
    expect(names(target)).toEqual(["files_read", "shell_run", "db_query"])
    expect(JSON.stringify(target.messages)).toContain('"name":"shell_run"')
    expect(JSON.stringify(target.messages)).not.toContain('"namespace"')
  })

  test(`${kind}: reserved history and long sanitized names cannot collide`, () => {
    const target = run({ tools: [
      { type: "namespace", name: "a.b", tools: [{ type: "function", name: "c" }] },
      { type: "namespace", name: "a", tools: [{ type: "function", name: "b.c" }] },
      { type: "namespace", name: "n".repeat(80), tools: [{ type: "function", name: "first" }, { type: "function", name: "second" }] },
    ], input: [{ type: "function_call", name: "a_b_c", call_id: "old", arguments: "{}" }] })
    const actual = names(target)
    expect(actual.slice(0, 2)).toEqual(["a_b_c_2", "a_b_c_3"])
    expect(new Set(actual).size).toBe(4)
    for (const name of actual) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  test.each(["additional_tools", "tool_search_output"])(`${kind}: %s keeps assistant turns separate`, type => {
    const target = run({ input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "before" }] },
      { type, tools: [{ type: "namespace", name: "n", tools: [{ type: "function", name: "f" }] }] },
      { type: "function_call", namespace: "n", name: "f", call_id: "c", arguments: "{}" },
    ] })
    expect(target.messages).toHaveLength(2)
  })

  test(`${kind}: malformed children and ambiguous kinds remain rejected`, () => {
    for (const tools of [
      [{ type: "namespace", name: "n", tools: [{ type: "web_search" }] }],
      [{ type: "namespace", name: "n", tools: [{ type: "function", name: "same" }, { type: "custom", name: "same" }] }],
      [{ type: "namespace", name: "n", tools: null }],
      [{ type: "namespace", name: "n", tools: [{ type: "custom", name: "grammar", format: { type: "grammar" } }] }],
    ]) expect(() => run({ tools })).toThrow()
  })
}


test("flat tool events retain their existing wire shape", async () => {
  const { mapping } = prepareResponsesTools({ model: "m", input: [], tools: [{ type: "function", name: "flat" }] })
  const added = { type: "response.output_item.added", item: { type: "function_call", id: "i", name: "flat", arguments: "" } }
  const done = { type: "response.function_call_arguments.done", item_id: "i", arguments: "{}" }
  async function* events() { yield added; yield done }
  const result = []
  for await (const event of restoreResponsesToolEvents(events(), mapping)) result.push(event)
  expect(result).toEqual([added, done])
})
