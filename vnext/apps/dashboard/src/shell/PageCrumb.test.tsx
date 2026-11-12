import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PageCrumb } from "./PageCrumb"

test("a page named like its group shows once", () => {
  const html = renderToStaticMarkup(<PageCrumb group="Models" page="Models" fallback="" />)
  expect(html.match(/Models/g)?.length).toBe(1)
  expect(html).not.toContain(">/</li>")
})

test("other pages keep their group", () => {
  const html = renderToStaticMarkup(<PageCrumb group="Observe" page="Usage" fallback="" />)
  expect(html).toContain("<li>Observe</li>")
  expect(html).toContain(">Usage</li>")
})

test("a page outside the groups shows its title alone", () => {
  const html = renderToStaticMarkup(<PageCrumb group={null} page={null} fallback="Settings" />)
  expect(html).toContain(">Settings</li>")
  expect(html).not.toContain(">/</li>")
})
