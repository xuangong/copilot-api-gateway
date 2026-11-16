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

test("a paired Loki upstream offers pairing controls and no device mirrors", () => {
  const html = withWindow("https:", () => renderToStaticMarkup(<LokiPairingPanel row={row} onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiNewPairing")
  expect(html).toContain("dash.lokiRevoke")
  expect(html).not.toContain("dash.lokiMirror")
})

test("creating Loki over plain HTTP explains that pairing needs HTTPS and offers no other source", () => {
  const html = withWindow("http:", () => renderToStaticMarkup(<LokiPairingPanel onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiHttpsRequired")
  expect(html).not.toContain('type="radio"')
  expect(html).not.toContain("dash.lokiMirrorDocument")
})
