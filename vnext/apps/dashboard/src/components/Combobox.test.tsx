import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Combobox } from "./Combobox"

function render(labelledBy?: string) {
  return renderToStaticMarkup(createElement(Combobox, {
    value: "", options: [], onChange: () => {}, placeholder: "search", ariaLabel: "Destination 1", labelledBy, noMatchesText: "none",
  }))
}

test("a visible label names the field instead of the aria-label fallback", () => {
  const html = render("dest-label")
  expect(html).toContain('aria-labelledby="dest-label"')
  expect(html).not.toContain("aria-label=")
})

test("without a visible label the aria-label names the field", () => {
  const html = render()
  expect(html).toContain('aria-label="Destination 1"')
  expect(html).not.toContain("aria-labelledby")
})
