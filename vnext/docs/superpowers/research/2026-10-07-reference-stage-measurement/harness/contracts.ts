export type Arm = "A" | "B" | "R"
export interface Cell {
  id: string
  stream: boolean
  shape: "string" | "containers"
  bytes: number
  dump: boolean
  comparison: "common-behavior" | "complete-behavior"
}
export const balancedOrders: readonly (readonly Arm[])[] = [["A", "B", "R"], ["A", "R", "B"], ["B", "A", "R"], ["B", "R", "A"], ["R", "A", "B"], ["R", "B", "A"]]
export const cells: readonly Cell[] = [true, false].flatMap(stream => [
  ...(["string", "containers"] as const).map(shape => ({ id: `${stream ? "sse" : "json"}-${shape}-full`, stream, shape, bytes: 65536, dump: true, comparison: "complete-behavior" as const })),
  { id: `${stream ? "sse" : "json"}-string-common`, stream, shape: "string" as const, bytes: 65536, dump: false, comparison: "common-behavior" as const },
])
export function makeRequest(id: string, cell: Cell): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id) || !Number.isSafeInteger(cell.bytes) || cell.bytes > 2 ** 24) throw new Error("Invalid fixture identity or bytes")
  const first = { role: "user", content: `BENCH_ID:${id} BENCH_PAYLOAD::END_PAYLOAD` }
  const messages = [first]
  if (cell.shape === "containers") for (let i = 0; i < 128; i++) messages.push({ role: "user", content: `fixture message ${i}` })
  const body = { model: "bench-chat-ok", stream: cell.stream, max_tokens: 128, messages, ...(cell.stream ? { stream_options: { include_usage: true } } : {}) }
  const padding = cell.bytes - Buffer.byteLength(JSON.stringify(body))
  if (padding < 0) throw new Error("Fixture bytes smaller than valid envelope")
  first.content = first.content.replace("BENCH_PAYLOAD:", `BENCH_PAYLOAD:${"x".repeat(padding)}`)
  const wire = JSON.stringify(body)
  if (Buffer.byteLength(wire) !== cell.bytes) throw new Error("Fixture wire size mismatch")
  return wire
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
export interface ChatWireEvidence {
  /** Number of parsed JSON events preceding each [DONE] marker, in wire order. */
  donePositions: readonly number[]
}
export function verifyChat(status: number, events: unknown[], done: boolean, stream: boolean, evidence?: ChatWireEvidence): {ok:boolean;errors:string[]} {
  const errors: string[] = []
  if (status !== 200) errors.push(`HTTP ${status}`)
  if (stream && !done) errors.push("missing DONE")
  if (!stream && done) errors.push("unexpected DONE in JSON")
  if (evidence) {
    if (stream && (evidence.donePositions.length !== 1 || evidence.donePositions[0] !== events.length)) errors.push("DONE count or position")
    if (!stream && evidence.donePositions.length !== 0) errors.push("unexpected DONE evidence in JSON")
    if (done !== (evidence.donePositions.length > 0)) errors.push("DONE evidence disagrees with parser")
  }
  if (!stream && events.length !== 1) errors.push("JSON envelope count")
  let text = "", terminals = 0, roles = 0, usages = 0
  for (const event of events) {
    const value = record(event)
    if (value.error !== undefined) errors.push("error envelope")
    if (!Array.isArray(value.choices)) { errors.push("missing choices"); continue }
    const hasUsage = value.usage !== undefined && value.usage !== null
    if (value.choices.length === 0) {
      if (!stream || terminals !== 1 || !hasUsage) errors.push("unexpected empty choices")
    } else {
      if (value.choices.length !== 1) errors.push("choice count")
      if (terminals > 0) errors.push("choice after terminal")
    }
    for (const item of value.choices) {
      const choice = record(item)
      if (choice.index !== 0) errors.push("choice index")
      const rawOutput: unknown = stream ? choice.delta : choice.message
      if (rawOutput === null || typeof rawOutput !== "object" || Array.isArray(rawOutput)) errors.push("invalid output envelope")
      const output = record(rawOutput)
      if (output.role === "assistant") roles++
      else if (output.role !== undefined) errors.push("unexpected role")
      if (typeof output.content === "string") text += output.content
      else if (output.content !== undefined && output.content !== null) errors.push("invalid content")
      if (choice.finish_reason === "stop") {
        terminals++
        if (text !== "BENCH_OK:65536") errors.push("terminal before complete content")
      }
      else if (choice.finish_reason != null) errors.push("unexpected terminal")
    }
    if (hasUsage) {
      usages++
      const usage = record(value.usage)
      if (usage.prompt_tokens !== 7 || usage.completion_tokens !== 3 || usage.total_tokens !== 10) errors.push("fixture usage mismatch")
      if (terminals !== 1) errors.push("usage before terminal")
    }
  }
  if (text !== "BENCH_OK:65536") errors.push("content mismatch")
  if (terminals !== 1) errors.push("terminal count")
  if (roles === 0) errors.push("missing assistant role")
  if (usages !== 1) errors.push("usage count")
  return { ok: errors.length === 0, errors }
}
export function validatePopulation(expected: readonly {id:string;arm:Arm;cell:string}[], actual: readonly {id:string;arm:Arm;cell:string;ok:boolean}[]):void {
  if (expected.length !== actual.length || new Set(expected.map(row => row.id)).size !== expected.length || new Set(actual.map(row => row.id)).size !== actual.length) throw new Error("Invalid population")
  const offered = new Map(expected.map(row => [row.id, row]))
  for (const row of actual) {
    const match = offered.get(row.id)
    if (!match || match.arm !== row.arm || match.cell !== row.cell) throw new Error("Invalid request identity")
    if (!row.ok) throw new Error("Observed unsuccessful request")
  }
}
