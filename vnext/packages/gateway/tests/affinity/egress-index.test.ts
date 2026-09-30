import { expect, test } from "bun:test"
import { AffinityCodec } from "../../src/shared/affinity/carrier.ts"
import { AffinityEgress } from "../../src/shared/affinity/egress.ts"
import type { AffinityExecutionState } from "../../src/shared/affinity/context.ts"

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
