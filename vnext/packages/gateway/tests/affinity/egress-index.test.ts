import { expect, test } from "bun:test"
import { AffinityCodec } from "../../src/shared/affinity/carrier.ts"
import { AffinityEgress } from "../../src/shared/affinity/egress.ts"
import type { AffinityExecutionState } from "../../src/shared/affinity/context.ts"
import { OriginEgress } from "../../src/shared/affinity/origin-egress.ts"

test("egress keeps positional carrier identity after IDs move and their slots are replaced", async () => {
  const execution: AffinityExecutionState = {
    protocol: "responses",
    actual: { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" },
    codec: new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) }),
  }
  const egress = new AffinityEgress(execution)
  const done = (id: string, index: number) => egress.responseEvent({ type: "response.output_item.done", output_index: index, item: { type: "reasoning", id, encrypted_content: id, summary: [] } })
  const a = await done("a", 0)
  await done("b", 1)
  expect((await done("a", 1)).item).toEqual(a.item)
  const c = await done("c", 1)
  const terminal = await egress.responseEvent({ type: "response.completed", response: { output: [
    { type: "reasoning", encrypted_content: "conflict", summary: [] },
    { type: "reasoning", id: "a", encrypted_content: "conflict", summary: [] },
  ] } })
  expect(terminal.response.output).toEqual([c.item, a.item])
})

test("origin projection rebases every output index while preserving all native IDs and inner indices", async () => {
  const execution: AffinityExecutionState = {
    protocol: "responses",
    actual: { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" },
    codec: new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) }),
  }
  const egress = new OriginEgress(execution)
  const types = ["response.function_call_arguments.delta", "response.output_text.delta", "response.reasoning_summary_text.delta", "response.output_item.done"]
  const input = types.map((type, index) => ({ type, sequence_number: 40 + index * 7, output_index: index * 3, item_id: "native", call_id: "call", content_index: 2, summary_index: 4, delta: "text" }))
  const output: unknown[] = []
  for (const event of input) output.push(...await egress.responsesEvent(event))
  expect(output.slice(0, 2)).toMatchObject([{ type: "response.output_item.added", output_index: 0, sequence_number: 0 }, { type: "response.output_item.done", output_index: 0, sequence_number: 1 }])
  for (const [index, event] of input.entries()) expect(output[index + 2]).toEqual({ ...event, output_index: event.output_index + 1, sequence_number: index + 2 })
})
