import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CodeBlock } from "./code-block"
import { cn } from "./cn"
import { Meter, meterTone } from "./meter"
import { Notice } from "./notice"

test("cn treats text-body as a font size, so a colour does not remove it", () => {
  expect(cn("text-body", "text-fg-muted")).toBe("text-body text-fg-muted")
  expect(cn("text-body", "text-xs")).toBe("text-xs")
})

test("Meter clamps its width to 0–100% and is decorative", () => {
  expect(renderToStaticMarkup(<Meter percent={140} />)).toContain("width:100%")
  expect(renderToStaticMarkup(<Meter percent={-5} />)).toContain("width:0%")
  expect(renderToStaticMarkup(<Meter percent={42} />)).toContain('aria-hidden="true"')
})

test("Meter's faint tone is the subtle colour at 40%, for an unchosen option beside a chosen one", () => {
  expect(renderToStaticMarkup(<Meter percent={50} tone="faint" />)).toContain("bg-fg-subtle/40")
})

test("meterTone escalates at 70% and 90%", () => {
  expect(meterTone(70)).toBe("brand")
  expect(meterTone(70.1)).toBe("warn")
  expect(meterTone(90.1)).toBe("danger")
})

test("CodeBlock renders its copy button for keyboard users, named by the label", () => {
  const html = renderToStaticMarkup(<CodeBlock language="bash" text="echo hi" copyLabel="Copy" copied={false} onCopy={() => {}} />)
  expect(html).toContain("<pre")
  expect(html).toContain("echo hi")
  expect(html).toMatch(/<button[^>]*aria-label="Copy"/)
  expect(html).not.toContain("opacity-0")
})

test("Notice has a success tone, and the role can be overridden", () => {
  expect(renderToStaticMarkup(<Notice tone="success">ok</Notice>)).toContain("text-success")
  expect(renderToStaticMarkup(<Notice tone="warn" role="status">x</Notice>)).toContain('role="status"')
  expect(renderToStaticMarkup(<Notice tone="danger">x</Notice>)).toContain('role="alert"')
})
