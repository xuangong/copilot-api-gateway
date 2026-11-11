import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { cn } from "./cn"
import { Button } from "./button"
import { Tooltip, TooltipProvider } from "./tooltip"

test("cn lets a later Tailwind class win and drops falsy parts", () => {
  expect(cn("px-2 py-1", false, undefined, "px-4")).toBe("py-1 px-4")
})

test("Button is a type=button by default so it never submits a form by accident", () => {
  const html = renderToStaticMarkup(<Button>Save</Button>)
  expect(html).toContain('type="button"')
  expect(html).toContain(">Save</button>")
})

test("Button variants map to the semantic tokens", () => {
  expect(renderToStaticMarkup(<Button variant="primary">Go</Button>)).toContain("bg-brand")
  expect(renderToStaticMarkup(<Button variant="danger">Del</Button>)).toContain("bg-danger")
  expect(renderToStaticMarkup(<Button size="icon-sm">R</Button>)).toContain("size-7")
})

test("Button asChild renders the child element instead of a button", () => {
  const html = renderToStaticMarkup(<Button asChild variant="ghost"><a href="#keys">Keys</a></Button>)
  expect(html.startsWith("<a")).toBe(true)
  expect(html).toContain('href="#keys"')
  expect(html).not.toContain("type=")
})

test("a disabled Tooltip renders only its trigger", () => {
  expect(renderToStaticMarkup(<Tooltip content="Usage" disabled><span>icon</span></Tooltip>)).toBe("<span>icon</span>")
})

test("an enabled Tooltip keeps the trigger's own name and adds no wrapper element", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <Tooltip content="Usage"><a href="#usage" aria-label="Usage">i</a></Tooltip>
    </TooltipProvider>,
  )
  expect(html.startsWith("<a")).toBe(true)
  expect(html).toContain('aria-label="Usage"')
})

test("a controlled open Tooltip still renders its trigger unchanged", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <Tooltip content="Weighted" open onOpenChange={() => {}}>
        <button type="button" aria-label="Total tokens">i</button>
      </Tooltip>
    </TooltipProvider>,
  )
  expect(html.startsWith("<button")).toBe(true)
  expect(html).toContain('type="button"')
  expect(html).toContain('aria-label="Total tokens"')
  expect(html).toContain(">i</button>")
})
