import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../ui/tooltip"
import { isPlainLeftClick } from "./links"
import { buildNavGroups } from "./navigation"
import { PageCrumb } from "./PageCrumb"
import { NavLink, SidebarNav } from "./SidebarNav"

const t = (key: string) => key
const render = (isAdmin: boolean, current = "usage") =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SidebarNav groups={buildNavGroups(t, { isAdmin })} current={current} onSelect={() => {}} collapsible={false} />
    </TooltipProvider>,
  )

test("every sidebar page is a real link to its old hash address", () => {
  const html = render(true)
  for (const id of ["usage", "latency", "models", "pricing", "keys", "users", "upstreams", "proxies", "clients"]) {
    expect(html).toContain(`href="#${id}"`)
  }
})

test("the current page is marked for assistive technology", () => {
  const html = render(true, "keys")
  expect(html).toMatch(/href="#keys"[^>]*aria-current="page"|aria-current="page"[^>]*href="#keys"/)
  expect(html.match(/aria-current="page"/g)?.length).toBe(1)
})

test("groups are labelled lists, and a non-admin gets no Users or Proxies link", () => {
  const html = render(false)
  expect(html).toContain('role="group"')
  expect(html).toContain("dash.nav.groupObserve")
  expect(html).not.toContain('href="#users"')
  expect(html).not.toContain('href="#proxies"')
})

test("the breadcrumb shows group and page, or just the title off the sidebar", () => {
  expect(renderToStaticMarkup(<PageCrumb group="Observe" page="Usage" fallback="" />)).toContain("Observe")
  const off = renderToStaticMarkup(<PageCrumb group={null} page={null} fallback="Settings" />)
  expect(off).toContain("Settings")
  expect(off).toContain('aria-current="page"')
})

test("group label ids stay unique when the navigation renders twice", () => {
  const groups = buildNavGroups(t, { isAdmin: true })
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SidebarNav groups={groups} current="usage" onSelect={() => {}} collapsible={false} />
      <SidebarNav groups={groups} current="usage" onSelect={() => {}} collapsible={false} />
    </TooltipProvider>,
  )
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
  expect(ids.length).toBe(groups.length * 2)
  expect(new Set(ids).size).toBe(ids.length)
})

test("an icon-only link is named by aria-label and shows no label text", () => {
  const item = buildNavGroups(t, { isAdmin: true })[0]!.items[0]!
  const icon = renderToStaticMarkup(
    <TooltipProvider>
      <NavLink item={item} active={false} iconOnly={true} onSelect={() => {}} />
    </TooltipProvider>,
  )
  expect(icon).toContain(`aria-label="${item.label}"`)
  expect(icon).not.toContain(`>${item.label}<`)
  const full = renderToStaticMarkup(<NavLink item={item} active={false} iconOnly={false} onSelect={() => {}} />)
  expect(full).not.toContain("aria-label")
  expect(full).toContain(`>${item.label}<`)
})

const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }

test("a plain left click is handled in-app", () => {
  expect(isPlainLeftClick(plain)).toBe(true)
})

test("modified, non-primary or already-handled clicks are left to the browser", () => {
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey", "defaultPrevented"] as const) {
    expect(isPlainLeftClick({ ...plain, [key]: true })).toBe(false)
  }
  expect(isPlainLeftClick({ ...plain, button: 1 })).toBe(false)
  expect(isPlainLeftClick({ ...plain, button: 2 })).toBe(false)
})

test("the page column scrolls with a stable gutter, so content does not shift between short and long pages", async () => {
  // AppShell needs the auth provider to render, so check its source.
  const source = await Bun.file(new URL("./AppShell.tsx", import.meta.url)).text()
  expect(source).toMatch(/<main className="[^"]*overflow-y-auto[^"]*\[scrollbar-gutter:stable\]/)
})

test("the bottom gap is the column's last item, so it stays below a long page's overflowing content", async () => {
  const source = await Bun.file(new URL("./AppShell.tsx", import.meta.url)).text()
  expect(source).toMatch(/\{children\}\s*<div aria-hidden="true" data-shell-bottom-gap="" className="h-6 shrink-0" \/>\s*<\/div>\s*<\/main>/)
  expect(source).not.toMatch(/<main className="[^"]*\bpy-6\b/)
})

test("each theme sets color-scheme, so native scrollbars and controls follow it", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text()
  expect(css).toMatch(/\[data-theme="light"\] \{\s*\/\*[^*]*\*\/\s*color-scheme: light;/)
  expect(css).toMatch(/\[data-theme="dark"\] \{\s*color-scheme: dark;/)
})
