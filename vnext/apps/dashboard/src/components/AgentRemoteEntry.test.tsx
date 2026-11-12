import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentRemoteLink } from "./AgentRemoteEntry"
import { installDictionary } from "../state/i18n-fixture"
import { TooltipProvider } from "../ui/tooltip"

test("enabled Agent Remote entry links to the Host management tab", () => {
  expect(renderToStaticMarkup(<AgentRemoteLink enabled={true} authenticated={true} />)).toContain('href="#agent-remote"')
}, 5000)

test("Agent Remote entry is hidden without configuration or a user login", () => {
  expect(renderToStaticMarkup(<AgentRemoteLink enabled={false} authenticated={true} />)).toBe("")
  expect(renderToStaticMarkup(<AgentRemoteLink enabled={true} authenticated={false} />)).toBe("")
}, 5000)

test("the entry is named by the page title key, so the sidebar and the page agree", () => {
  const scope = globalThis as { window?: unknown }
  const had = "window" in scope
  const previous = scope.window
  scope.window = { t: (key: string) => (key === "dash.remote.title" ? "Page Title" : key) }
  try {
    expect(renderToStaticMarkup(<AgentRemoteLink enabled={true} authenticated={true} />)).toContain(">Page Title</span>")
    expect(renderToStaticMarkup(<TooltipProvider><AgentRemoteLink enabled={true} authenticated={true} iconOnly /></TooltipProvider>)).toContain('aria-label="Page Title"')
  } finally {
    if (had) scope.window = previous
    else delete scope.window
  }
}, 5000)

test("both languages call it Agent Remote", () => {
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      expect(renderToStaticMarkup(<AgentRemoteLink enabled={true} authenticated={true} />)).toContain(">Agent Remote</span>")
    } finally {
      restore()
    }
  }
}, 5000)
