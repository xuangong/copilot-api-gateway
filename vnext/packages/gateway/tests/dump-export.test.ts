import { test, expect } from "bun:test"
import { dumpRecordToExport } from "../src/shared/dump/export.ts"
import type { StoredDumpRecord } from "../src/shared/dump/types.ts"
import type { DumpRecordId, UpstreamId } from "../src/repo/branded-ids.ts"

test("redacted export omits opaque content and future envelopes without mutating the record", () => {
  const secret = "D03_SECRET_SENTINEL"
  const record: StoredDumpRecord = {
    meta: {
      id: "01H0000000000000000000AAAA" as DumpRecordId,
      startedAt: 1, completedAt: 2, method: "POST",
      path: `/v1/responses/${secret}?token=${secret}&%61pi_key=${secret}`,
      status: 200, upstream: { id: secret as UpstreamId, name: secret, kind: "custom" },
      model: secret, inputTokens: 1, outputTokens: 2, requestBytes: 5, responseBytes: 6,
      durationMs: 1, error: { kind: "failed", reason: secret },
    },
    request: { method: "POST", path: `https://${secret}@example.test/?code=${secret}`, headers: [["aUtHoRiZaTiOn", secret], ["content-type", `application/${secret}`], ["x-custom", secret]], body: new TextEncoder().encode(`{"password":"${secret}"}`) },
    response: { status: 200, headers: [["SeT-CoOkIe", secret]], body: { type: "bytes", body: new TextEncoder().encode(secret) } },
  }
  const extended = Object.assign(record, { upstreamExchanges: [{ headers: [["authorization", secret]], body: secret }] })
  const before = structuredClone(extended)
  const output = dumpRecordToExport(extended)
  expect(JSON.stringify(output)).not.toContain(secret)
  expect(JSON.stringify(output)).not.toContain("upstreamExchanges")
  expect(output.request.body).toEqual({
    type: "bytes", byteLength: record.request.body.byteLength,
    representation: "captured_bytes", sourceEncoding: "not_captured",
    omitted: "sensitive_or_opaque_content",
  })
  expect(output.response.body).toEqual({
    type: "bytes", byteLength: record.response.body.type === "bytes" ? record.response.body.body.byteLength : 0,
    representation: "captured_bytes", sourceEncoding: "not_captured",
    omitted: "sensitive_or_opaque_content",
  })
  expect(extended).toEqual(before)
})

test("stream export retains known event names and counts without frame payloads", () => {
  const secret = "D03_SECRET_SENTINEL"
  const record: StoredDumpRecord = {
    meta: {
      id: "01H0000000000000000000AAAB" as DumpRecordId,
      startedAt: 1, completedAt: 2, method: "POST", path: "/v1/responses", status: 200,
      upstream: null, model: null, inputTokens: null, outputTokens: null,
      requestBytes: 0, responseBytes: 0, durationMs: 1, error: null,
    },
    request: { method: "POST", path: "/v1/responses", headers: [], body: new Uint8Array() },
    response: { status: 200, headers: [], body: { type: "stream", events: [
      { frame: { type: "event", event: { type: "response.output_text.delta", delta: secret } }, ts: 1 },
      { frame: { type: "event", event: { type: secret, payload: secret } }, ts: 2 },
      { frame: { type: "done" }, ts: 3 },
    ] } },
  }
  const output = dumpRecordToExport(record)
  expect(output.response.body).toEqual({
    type: "stream", eventCount: 3, eventNames: ["response.output_text.delta"],
    lastEventOffsetMs: 3, representation: "canonical_frames", sourceEncoding: "not_captured",
    completion: "unknown", truncation: "not_captured", omitted: "sensitive_or_opaque_content",
  })
  expect(JSON.stringify(output)).not.toContain(secret)
})

test("base64-encoded binary credential bytes are omitted with their source encoding unknown", () => {
  const secret = "D03_BINARY_SECRET"
  const encoded = btoa(secret)
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const record: StoredDumpRecord = {
    meta: {
      id: "01H0000000000000000000AAAC" as DumpRecordId,
      startedAt: 1, completedAt: 2, method: "POST", path: "/v1/responses", status: 200,
      upstream: null, model: null, inputTokens: null, outputTokens: null,
      requestBytes: bytes.byteLength, responseBytes: bytes.byteLength, durationMs: 1, error: null,
    },
    request: { method: "POST", path: "/v1/responses", headers: [["content-type", "application/octet-stream"]], body: bytes },
    response: { status: 200, headers: [], body: { type: "bytes", body: bytes } },
  }
  const output = JSON.stringify(dumpRecordToExport(record))
  expect(output).not.toContain(secret)
  expect(output).not.toContain(encoded)
  expect(record.request.body).toEqual(bytes)
})
