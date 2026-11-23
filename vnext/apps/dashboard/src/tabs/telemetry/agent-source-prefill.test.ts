import { expect, test } from "bun:test"
import { initialAgentSource } from "./telemetry-sources"

test("the agent source field starts with the one stored for the source", () => {
  expect(initialAgentSource({ agentSource: "museum" })).toBe("museum")
  expect(initialAgentSource({})).toBe("")
})
