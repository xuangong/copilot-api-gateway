import { expect, test } from "bun:test"
import { adaptUsageRow, type ServerUsageRow } from "./usage"

// Records from before 2026-09-06 carry no incoming model. Key model mappings
// did not exist yet, so the model asked for was the model served.
test("falls back to the routed model when a record has no incoming model", () => {
  const oldServerRow: ServerUsageRow = {
    hour: "2026-09-04T12",
    keyId: "key-a",
    model: "target-model",
    requests: 1,
  }
  expect(adaptUsageRow(oldServerRow).incomingModel).toBe("target-model")
  expect(adaptUsageRow({ ...oldServerRow, incomingModel: "" }).incomingModel).toBe("target-model")
})

test("leaves the incoming model empty only when no model was recorded at all", () => {
  expect(adaptUsageRow({ hour: "2026-09-04T12", keyId: "key-a", requests: 1 }).incomingModel).toBe("")
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
