import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Badge } from "./badge"
import { Card, SectionHeading } from "./card"
import { EmptyState } from "./empty-state"
import { MultiSelect, multiSelectSummary } from "./multi-select"
import { Notice } from "./notice"
import { PageHeader } from "./page-header"
import { SegmentedControl, nextSegmentIndex } from "./segmented-control"
import { Select, toRadixValue, fromRadixValue } from "./select"
import { TBody, Table, Td, Th } from "./table"

test("PageHeader renders the page title as the h1, with optional description and actions", () => {
  const html = renderToStaticMarkup(<PageHeader title="Usage" description="Tokens and cost" actions={<button type="button">R</button>} />)
  expect(html).toContain("<h1")
  expect(html).toContain(">Usage</h1>")
  expect(html).toContain("Tokens and cost")
  expect(html).toContain(">R</button>")
})

test("Card is a bordered section and SectionHeading an h2", () => {
  expect(renderToStaticMarkup(<Card>x</Card>)).toMatch(/^<section[^>]*border-border/)
  expect(renderToStaticMarkup(<SectionHeading>Model distribution</SectionHeading>)).toContain("<h2")
  expect(renderToStaticMarkup(<SectionHeading as="h3">By key</SectionHeading>)).toMatch(/^<h3 class="text-sm font-semibold text-fg">By key<\/h3>$/)
})

test("SegmentedControl is a labelled radio group with one checked, tabbable option", () => {
  const html = renderToStaticMarkup(
    <SegmentedControl
      ariaLabel="Range"
      value="week"
      onChange={() => {}}
      options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]}
    />,
  )
  expect(html).toContain('role="radiogroup"')
  expect(html).toContain('aria-label="Range"')
  expect(html.match(/role="radio"/g)?.length).toBe(3)
  expect(html.match(/aria-checked="true"/g)?.length).toBe(1)
  expect(html.match(/tabindex="0"/g)?.length).toBe(1)
  expect(html.match(/tabindex="-1"/g)?.length).toBe(2)
  expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>Week</)
})

test("SegmentedControl disabled disables every segment", () => {
  const html = renderToStaticMarkup(
    <SegmentedControl ariaLabel="Format" value="a" onChange={() => {}} disabled options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />,
  )
  expect(html.match(/<button[^>]* disabled=""/g)?.length).toBe(2)
  const enabled = renderToStaticMarkup(
    <SegmentedControl ariaLabel="Format" value="a" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />,
  )
  expect(enabled).not.toContain("disabled=\"\"")
})

test("nextSegmentIndex: arrows step and wrap, Home/End jump, other keys do nothing", () => {
  expect(nextSegmentIndex(0, "ArrowRight", 3)).toBe(1)
  expect(nextSegmentIndex(2, "ArrowRight", 3)).toBe(0)
  expect(nextSegmentIndex(2, "ArrowDown", 3)).toBe(0)
  expect(nextSegmentIndex(1, "ArrowLeft", 3)).toBe(0)
  expect(nextSegmentIndex(0, "ArrowLeft", 3)).toBe(2)
  expect(nextSegmentIndex(0, "ArrowUp", 3)).toBe(2)
  expect(nextSegmentIndex(1, "Home", 3)).toBe(0)
  expect(nextSegmentIndex(1, "End", 3)).toBe(2)
  expect(nextSegmentIndex(1, "Enter", 3)).toBeNull()
  expect(nextSegmentIndex(1, "a", 3)).toBeNull()
})

test("Select maps the empty 'all' value through a sentinel, since Radix forbids empty item values", () => {
  expect(fromRadixValue(toRadixValue(""))).toBe("")
  expect(toRadixValue("")).not.toBe("")
  expect(fromRadixValue(toRadixValue("gpt-6"))).toBe("gpt-6")
})

/** Text content of the element with the given id in static markup, found by balancing its tags. */
const elementText = (html: string, id: string): string | null => {
  const open = html.indexOf(`id="${id}"`)
  if (open === -1) return null
  const tagStart = html.lastIndexOf("<", open)
  const tag = html.slice(tagStart + 1).match(/^[a-z0-9]+/)?.[0]
  if (!tag) return null
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g")
  tags.lastIndex = tagStart
  let depth = 0
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return html.slice(tagStart, m.index).replace(/<[^>]+>/g, "")
  }
  return null
}

test("Select shows the current option's label and, with a visible label, is named by label and value", () => {
  const options = [{ value: "", label: "All keys" }, { value: "k1", label: "Key 1", badge: "shared" }]
  const html = renderToStaticMarkup(<Select labelledBy="lbl" value="" onChange={() => {}} options={options} />)
  const valueId = html.match(/aria-labelledby="lbl ([^"]+)"/)?.[1]
  expect(valueId).toBeDefined()
  expect(elementText(html, valueId!)).toBe("All keys")

  const withBadge = renderToStaticMarkup(<Select labelledBy="lbl" value="k1" onChange={() => {}} options={options} />)
  const badgeValueId = withBadge.match(/aria-labelledby="lbl ([^"]+)"/)?.[1]
  expect(badgeValueId).toBeDefined()
  expect(elementText(withBadge, badgeValueId!)).toBe("Key 1 shared")
  expect(withBadge).toMatch(/<span[^>]*>shared<\/span>/)
})

test("Select without a visible label uses ariaLabel, and shows a value missing from the options as itself", () => {
  const html = renderToStaticMarkup(<Select ariaLabel="Key" value="deleted-key" onChange={() => {}} options={[{ value: "", label: "All keys" }]} />)
  expect(html).toContain('aria-label="Key"')
  expect(html).not.toContain("aria-labelledby")
  expect(html).toContain(">deleted-key</span>")
})

test("MultiSelect summarises the selection", () => {
  const options = [{ value: "success", label: "Success" }, { value: "error", label: "Error" }]
  expect(multiSelectSummary([], options, "All")).toBe("All")
  expect(multiSelectSummary(["success", "error"], options, "All")).toBe("Success, Error")
  expect(multiSelectSummary(["gone"], options, "All")).toBe("gone")
})

// Ported from the old latency-page MultiSelect test.
test("collapsed MultiSelect describes its current choices while keeping a stable field name", () => {
  const options = [{ value: "success", label: "Success" }, { value: "error", label: "Error" }]
  for (const [value, summary] of [
    [[], "All"],
    [["success"], "Success"],
    [["success", "error"], "Success, Error"],
    [["stale-key"], "stale-key"],
  ] as Array<[string[], string]>) {
    const html = renderToStaticMarkup(
      <MultiSelect ariaLabel="Outcome" value={value} options={options} allLabel="All" clearLabel="Clear" onChange={() => {}} />,
    )
    const descriptionId = html.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(descriptionId).toBeDefined()
    expect(html).toContain('aria-label="Outcome"')
    expect(html).toContain('aria-expanded="false"')
    expect(elementText(html, descriptionId!)).toBe(summary)
  }
})

test("MultiSelect with a visible label is named by label and summary", () => {
  const html = renderToStaticMarkup(
    <MultiSelect labelledBy="lbl" value={["error"]} options={[{ value: "error", label: "Error" }]} allLabel="All" clearLabel="Clear" onChange={() => {}} />,
  )
  const summaryId = html.match(/aria-labelledby="lbl ([^"]+)"/)?.[1]
  expect(summaryId).toBeDefined()
  expect(elementText(html, summaryId!)).toBe("Error")
  expect(html).not.toContain("aria-label=")
  expect(html).not.toContain("aria-describedby")
})

test("Table cells: header cells are column headers, numeric cells align right", () => {
  const html = renderToStaticMarkup(<Table><thead><tr><Th>Model</Th><Th numeric>Cost</Th></tr></thead><tbody><tr><Td numeric>1</Td></tr></tbody></Table>)
  expect(html).toContain('scope="col"')
  expect(html).toMatch(/<th[^>]*text-right[^>]*>Cost</)
  expect(html).toMatch(/<td[^>]*text-right/)
  expect(html).not.toContain("font-mono")
})

test("Table is a plain scroll frame without a label, and a named focusable region with one", () => {
  const plain = renderToStaticMarkup(<Table><tbody /></Table>)
  expect(plain).toMatch(/^<div class="min-w-0 overflow-x-auto"><table/)
  expect(plain).not.toContain("role=")
  expect(plain).not.toContain("tabindex")
  const labelled = renderToStaticMarkup(<Table label="Model distribution"><tbody /></Table>)
  expect(labelled).toMatch(/^<div role="region" aria-label="Model distribution" tabindex="0"/)
})

test("Badge, EmptyState and Notice render their content with the right roles", () => {
  expect(renderToStaticMarkup(<Badge>shared</Badge>)).toContain(">shared</span>")
  expect(renderToStaticMarkup(<EmptyState title="No usage in range" />)).toContain("No usage in range")
  expect(renderToStaticMarkup(<Notice tone="danger">Boom</Notice>)).toContain('role="alert"')
  expect(renderToStaticMarkup(<Notice tone="info">Note</Notice>)).not.toContain("role=")
  expect(renderToStaticMarkup(<Notice tone="warn">Careful</Notice>)).not.toContain("role=")
})

test("Th row is a row header and TBody drops the last row's bottom border", () => {
  const html = renderToStaticMarkup(<Table><TBody><tr><Th row>gpt-6</Th><Td numeric>1</Td></tr></TBody></Table>)
  expect(html).toMatch(/<th scope="row"[^>]*font-normal[^>]*>gpt-6</)
  expect(html).not.toContain('scope="col"')
  expect(html).toContain('<tbody class="[&amp;&gt;tr:last-child&gt;*]:border-b-0">')
})
