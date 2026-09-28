import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MultiSelect } from "./MultiSelect"

test("collapsed filter describes its current choices while keeping a stable field name", () => {
  const options = [{ value: "success", label: "Success" }, { value: "error", label: "Error" }]
  for (const [value, summary] of [
    [["success"], "Success"],
    [["success", "error"], "Success, Error"],
    [[], "All"],
  ] as Array<[string[], string]>) {
    const markup = renderToStaticMarkup(createElement(MultiSelect, {
      ariaLabel: "Outcome", value, options, allLabel: "All", clearLabel: "Clear", onChange: () => {},
    }))
    const descriptionId = markup.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(descriptionId).toBeDefined()
    expect(markup).toContain('aria-label="Outcome"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain(`id="${descriptionId}" class="truncate min-w-0">${summary}</span>`)
  }
})

test("a selected stale option's remembered label is the collapsed description", () => {
  const markup = renderToStaticMarkup(createElement(MultiSelect, {
    ariaLabel: "API key", value: ["key-1"], options: [{ value: "key-1", label: "Named key" }],
    allLabel: "All", clearLabel: "Clear", onChange: () => {},
  }))
  const descriptionId = markup.match(/aria-describedby="([^"]+)"/)?.[1]
  expect(descriptionId).toBeDefined()
  expect(markup).toContain(`id="${descriptionId}" class="truncate min-w-0">Named key</span>`)
})
