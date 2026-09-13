import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentRemoteLink } from "./AgentRemoteEntry"

test("enabled Agent Remote entry links to the browser-bound gateway flow", () => {
  expect(renderToStaticMarkup(<AgentRemoteLink enabled={true} authenticated={true} />)).toContain('href="/agent-remote"')
}, 5000)

test("Agent Remote entry is hidden without configuration or a user login", () => {
  expect(renderToStaticMarkup(<AgentRemoteLink enabled={false} authenticated={true} />)).toBe("")
  expect(renderToStaticMarkup(<AgentRemoteLink enabled={true} authenticated={false} />)).toBe("")
}, 5000)
