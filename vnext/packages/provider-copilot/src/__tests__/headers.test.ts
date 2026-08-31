/**
 * The Copilot data-plane header surface.
 *
 * These values are the whole of our claim to be a real GitHub Copilot Chat
 * client. Both directions are failures: a missing canonical header is as much
 * of a tell as an extra one, since the upstream can cross-check them against
 * each other. Nothing here was covered by a test before, so this file pins the
 * exact set — treat a diff as intentional only if the whole captured set moved
 * together (see the comment block in account-type.ts).
 */
import { expect, test } from "bun:test"
import { copilotHeaders } from "../headers"

test("sends exactly the pinned Copilot Chat header set", () => {
  const headers = copilotHeaders("tok")

  expect(Object.keys(headers).sort()).toEqual([
    "Authorization",
    "accept-encoding",
    "content-type",
    "copilot-integration-id",
    "editor-device-id",
    "editor-plugin-version",
    "editor-version",
    "openai-intent",
    "user-agent",
    "x-agent-task-id",
    "x-github-api-version",
    "x-interaction-type",
    "x-request-id",
    "x-vscode-user-agent-library-version",
  ])

  expect(headers.Authorization).toBe("Bearer tok")
  expect(headers["editor-version"]).toBe("vscode/1.124.2")
  expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.52.0")
  expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.52.0")
  expect(headers["copilot-integration-id"]).toBe("vscode-chat")
  expect(headers["openai-intent"]).toBe("conversation-agent")
  expect(headers["x-interaction-type"]).toBe("conversation-agent")
  expect(headers["x-vscode-user-agent-library-version"]).toBe("electron-fetch")
})

test("data plane uses the Copilot API version, not the GitHub REST one", () => {
  expect(copilotHeaders("tok")["x-github-api-version"]).toBe("2026-06-01")
})

test("one interaction is one task: request id and task id are the same uuid", () => {
  const headers = copilotHeaders("tok")
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"]!)
  expect(headers["x-request-id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
})

test("device id is stable across calls while request id is not", () => {
  const a = copilotHeaders("tok")
  const b = copilotHeaders("tok")

  // A real editor install has one device id for its whole lifetime. Minting a
  // fresh one per call would show the upstream device-count == request-count.
  expect(b["editor-device-id"]).toBe(a["editor-device-id"]!)
  expect(b["x-request-id"]).not.toBe(a["x-request-id"]!)
})

test("vision header appears only when asked for", () => {
  expect(copilotHeaders("tok")["copilot-vision-request"]).toBeUndefined()
  expect(copilotHeaders("tok", true)["copilot-vision-request"]).toBe("true")
})
