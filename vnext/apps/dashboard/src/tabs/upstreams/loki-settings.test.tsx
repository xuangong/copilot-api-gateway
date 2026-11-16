import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { LokiPairingPanel } from "./LokiPairingPanel"
import { UpstreamRow } from "./UpstreamRow"

const row: UpstreamRecord = { id: "loki-fixture", provider: "loki", name: "Loki", enabled: true, sortOrder: 0,
  config: {}, disabledPublicModelIds: [], createdAt: "", updatedAt: "" }
const noop = () => {}

test("a Loki row lists its models like any other upstream", () => {
  const html = renderToStaticMarkup(<ToastProvider><UpstreamRow
    row={row} index={0} total={1} busy={false} models={[{ id: "claude-opus-5.5", name: "claude-opus-5.5" }]} onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop}
    onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} />
  </ToastProvider>)
  expect(html).toContain("dash.modelsServedHeader")
  expect(html).toContain("claude-opus-5.5")
})

function withWindow<T>(protocol: string, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { protocol, origin: `${protocol}//host` } } })
  try { return run() } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("a paired Loki upstream shows device mirror management", () => {
  const html = withWindow("https:", () => renderToStaticMarkup(<LokiPairingPanel row={row} onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiMirrorsTitle")
  expect(html).toContain("dash.lokiMirrorIssue")
})

test("a mirror upstream shows its source and re-import, not pairing or mirror issuance", () => {
  const mirrorRow: UpstreamRecord = { ...row, lokiSource: { kind: "mirror", origin: "https://central.example" } }
  const html = withWindow("http:", () => renderToStaticMarkup(<LokiPairingPanel row={mirrorRow} onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiMirrorSourceFrom")
  expect(html).toContain("dash.lokiMirrorReimport")
  expect(html).not.toContain("dash.lokiNewPairing")
  expect(html).not.toContain("dash.lokiMirrorsTitle")
})

test("creating Loki over plain HTTP offers only the mirror source", () => {
  const html = withWindow("http:", () => renderToStaticMarkup(<LokiPairingPanel onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiSourceMirror")
  expect(html).toContain("dash.lokiMirrorDocument")
  expect(html).toContain("dash.lokiHttpsRequired")
  expect(html).not.toContain("dash.lokiPairDescription")
  const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []
  expect(radios).toHaveLength(2)
  expect(radios[0]).toContain("disabled")
  expect(radios[0]).not.toContain("checked")
  expect(radios[1]).toContain("checked")
  expect(radios[1]).not.toContain("disabled")
})

test("rows describe a revoked mirror", () => {
  const revoked: UpstreamRecord = { ...row, lokiSource: { kind: "mirror", origin: "https://central.example" },
    lokiStatus: { assistantStatus: "authorized", tokenStatus: "valid", expiresAt: null, updatedAt: null, errorCode: "mirror_revoked" } }
  const html = renderToStaticMarkup(<ToastProvider><UpstreamRow row={revoked} index={0} total={1} busy={false} models={[]}
    onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop} onRefreshModels={noop}
    onRefreshCredential={noop} onReauth={noop} onDelete={noop} /></ToastProvider>)
  expect(html).toContain("dash.lokiMirrorRevoked")
})
