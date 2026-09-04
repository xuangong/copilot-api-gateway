import { expect, test } from "bun:test"
import { adaptUsageRow, type ServerUsageRow } from "./usage"

test("adapts missing incoming model from an older server as a legacy row", () => {
  const oldServerRow: ServerUsageRow = {
    hour: "2026-09-04T12",
    keyId: "key-a",
    model: "target-model",
    requests: 1,
  }

  expect(adaptUsageRow(oldServerRow).incomingModel).toBe("")
})

test("preserves an incoming model emitted by a newer server", () => {
  const serverRow: ServerUsageRow = {
    hour: "2026-09-04T12",
    keyId: "key-a",
    incomingModel: "caller-alias",
    model: "target-model",
    requests: 1,
  }

  expect(adaptUsageRow(serverRow).incomingModel).toBe("caller-alias")
})
