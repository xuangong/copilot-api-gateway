import { expect, test } from "bun:test"
import { AffinityCodec, InvalidAffinityStateError, AFFINITY_MARKER, MAX_AFFINITY_WIRE_CHARS } from "../../src/shared/affinity/carrier.ts"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"

const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "revision", model: "executed-model" }
const secret = { version: 1 as const, keyId: "kid", secret: new Uint8Array(32).fill(7) }
const codec = () => new AffinityCodec({ ownerId: "owner", apiKeyId: "key", ...secret })
const field = { domain: "messages/thinking/signature", block: "original thinking" }

test("carrier restores every UTF-16 code unit and canonical byte encodings", async () => {
  let all = ""
  for (let n = 0; n < 65536; n++) all += String.fromCharCode(n)
  for (const value of [all, "", "AAH+/w==", "AAH-_w", "opaque\ud800\uffff"]) {
    const wire = await codec().encode(value, target, field)
    expect(wire.startsWith(AFFINITY_MARKER)).toBe(true)
    expect(await codec().decode(wire, field)).toEqual({ kind: "owned", value, target, synthetic: false })
  }
})

test("foreign values remain exact; recognizable broken markers never become foreign", async () => {
  for (const value of ["foreign", "AAH+/w==", "\ud800"]) expect(await codec().decode(value, field)).toEqual({ kind: "foreign", value })
  for (const value of [AFFINITY_MARKER, `${AFFINITY_MARKER}9:AAAA`, `${AFFINITY_MARKER}1:not-base64`, `${AFFINITY_MARKER}1:${"A".repeat(MAX_AFFINITY_WIRE_CHARS)}`]) {
    await expect(codec().decode(value, field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  }
})

test("key, owner, domain, block and ciphertext are authenticated", async () => {
  const wire = await codec().encode("private", target, field)
  for (const other of [new AffinityCodec({ ownerId: "other", apiKeyId: "key", ...secret }), new AffinityCodec({ ownerId: "owner", apiKeyId: "other", ...secret }), new AffinityCodec({ ownerId: "owner", apiKeyId: "key", ...secret, secret: new Uint8Array(32).fill(8) })]) {
    await expect(other.decode(wire, field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  }
  await expect(codec().decode(wire, { ...field, domain: "responses/compaction/encrypted_content" })).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await expect(codec().decode(wire, { ...field, block: "swapped" })).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const offset = wire.indexOf(":1:") + 3
  const changed = wire.slice(0, offset) + (wire[offset] === "A" ? "B" : "A") + wire.slice(offset + 1)
  await expect(codec().decode(changed, field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})
