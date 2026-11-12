import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { LokiPairingPanel } from "./LokiPairingPanel"
import { UpstreamRow } from "./UpstreamRow"

const row: UpstreamRecord = { id: "loki-fixture", provider: "loki", name: "Loki", enabled: true, sortOrder: 0,
  config: { staticModels: ["claude-opus-5.5", "gpt-6-luna"] }, disabledPublicModelIds: [], createdAt: "", updatedAt: "" }
const noop = () => {}

test("Loki edit renders saved names in a labelled multiline input", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { protocol: "https:" } } })
  try {
    const html = renderToStaticMarkup(<LokiPairingPanel row={row} onChanged={noop} onClose={noop} />)
    expect(html).toContain("dash.lokiStaticModels")
    expect(html).toContain("claude-opus-5.5\ngpt-6-luna</textarea>")
    const inputId = html.match(/<textarea id="([^"]+)"[^>]*rows="6"/)?.[1]
    expect(inputId).toBeDefined()
    expect(html.match(/<label[^>]*>/g)?.some(label => label.includes(`for="${inputId}"`))).toBe(true)
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("served static models and live probe results render separately, including an empty live list", () => {
  const render = (liveModels?: string[]) => renderToStaticMarkup(<ToastProvider><UpstreamRow
    row={row} index={0} total={1} busy={false} models={[{ id: "claude-opus-5.5", name: "claude-opus-5.5" }]}
    liveModels={liveModels === undefined ? undefined : { ids: liveModels, total: liveModels.length }} onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop}
    onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} />
  </ToastProvider>)
  expect(render()).not.toContain("dash.lokiLiveModelsHeader")
  const html = render(["live-only-model"])
  expect(html).toContain("dash.lokiStaticModelsHeader")
  expect(html).toContain("dash.lokiLiveModelsHeader")
  expect(html).toContain("claude-opus-5.5")
  expect(html).toContain("live-only-model")
  expect(render([])).toContain("dash.lokiLiveModelsHeader")
})
