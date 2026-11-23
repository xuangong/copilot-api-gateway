import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { IssuedKeyPanel, SourceListView, type SourceListViewProps } from "./SourceList"

const noop = () => {}
const now = Date.parse("2026-11-16T12:00:00Z")
const source = (over: Record<string, unknown> = {}) => ({ id: `tls_${"1".repeat(32)}`, name: "trojan-vm", createdAt: "2026-11-01T00:00:00.000Z", lastPushAt: "2026-11-16T11:30:00.000Z", settings: {}, ...over })
const issued = { sourceName: "trojan-vm", key: `tlm_${"a".repeat(8)}`, install: "curl -fsSL https://example/install.sh | sudo TELEMETRY_KEY='k' bash" }
const view = (over: Partial<SourceListViewProps> = {}) => renderToStaticMarkup(<SourceListView sources={[]} nowMs={now} newName="" issued={null} busy={false} error=""
  copied={null} secureOrigin agentSource="" onAgentSource={noop} onName={noop} onCreate={noop} onRotate={noop} onDelete={noop} onCopy={noop} onDismissIssued={noop} {...over} />)

test("with no sources the page explains itself and offers to create one", () => {
  const html = view()
  expect(html).toContain("dash.tlmSources")
  expect(html).toContain("dash.tlmDescription")
  expect(html).toContain("dash.tlmNone")
  expect(html).toContain("dash.tlmCreate")
})

test("each source shows its name, a freshness badge, the last push and rotate and delete actions", () => {
  const html = view({ sources: [source(), source({ id: `tls_${"2".repeat(32)}`, name: "stale-vm", lastPushAt: "2026-11-16T08:00:00.000Z" }),
    source({ id: `tls_${"3".repeat(32)}`, name: "new-vm", lastPushAt: null })] })
  expect(html).toContain("trojan-vm")
  expect(html).toContain("stale-vm")
  expect(html).toContain("new-vm")
  expect(html).toContain("dash.tlmFresh")
  expect(html).toContain("dash.tlmStale")
  expect(html).toContain("dash.tlmNeverPushed")
  expect(html.match(/dash\.tlmRotate/g)).toHaveLength(3)
  expect(html.match(/dash\.delete/g)).toHaveLength(3)
  expect(html).not.toContain("dash.tlmOpen")
})

test("an Open action appears only when the page can open a source", () => {
  expect(view({ sources: [source()], onOpen: noop })).toContain("dash.tlmOpen")
})

test("the create button needs a name and no request in flight, and plain HTTP warns and blocks creation", () => {
  const disabled = (html: string) => /<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.tlmCreate/.test(html)
  expect(disabled(view({ newName: "" }))).toBe(true)
  expect(disabled(view({ newName: "vm" }))).toBe(false)
  expect(disabled(view({ newName: "vm", busy: true }))).toBe(true)
  const plain = view({ newName: "vm", secureOrigin: false })
  expect(plain).toContain("dash.tlmHttpsRequired")
  expect(disabled(plain)).toBe(true)
})

test("an issued key shows the install command and the key once, with copy buttons and a dismiss", () => {
  const html = view({ issued })
  expect(html).toContain("dash.tlmKeyHint")
  expect(html).toContain("TELEMETRY_KEY=&#x27;k&#x27;")
  expect(html).toContain(issued.key)
  expect(html).toContain("dash.tlmCopyCommand")
  expect(html).toContain("dash.tlmCopyKey")
  expect(html).toContain("dash.tlmDismiss")
  expect(renderToStaticMarkup(<IssuedKeyPanel issued={issued} copied="install" onCopy={noop} onDismiss={noop} />)).toContain("dash.tlmCopied")
})

test("errors are announced as alerts", () => {
  expect(view({ error: "dash.tlmError" })).toContain('role="alert"')
})

test("the source list has an optional agent source name field, described by its hint, that blocks creation when invalid", () => {
  const html = view()
  expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>dash\.tlmAgentSource<\/label><input[^>]*id="\1"/)
  expect(html).not.toContain('aria-label="dash.tlmAgentSource"')
  expect(html).toContain("dash.tlmAgentSourceHint")
  expect(html).toContain("aria-describedby")
  expect(html).not.toContain('aria-invalid="true"')
  const bad = view({ newName: "x", agentSource: "Museum" })
  expect(bad).toContain('aria-invalid="true"')
  expect(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.tlmCreate/.test(bad)).toBe(true)
  expect(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.tlmCreate/.test(view({ newName: "x", agentSource: "museum" }))).toBe(false)
})
