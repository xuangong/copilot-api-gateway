import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RequestsLiveStatus } from "./RequestsPanel"
import { dumpStreamUrl } from "../../api/dumps"

test("live status always exposes best-effort scope and explicit refresh beside persistent warnings", () => {
  const html = renderToStaticMarkup(<RequestsLiveStatus continuity="overflow" omittedRows={2} loading={false} onRefresh={() => {}} />)
  expect(html).toContain("dash.requests.liveScope")
  expect(html).toContain("dash.requests.continuity.overflow")
  expect(html).toContain("dash.requests.liveOmitted")
  expect(html).toContain("dash.requests.refreshLatest")
  expect(html).toContain('role="status"')
  expect(dumpStreamUrl("k/1")).toBe("/api/keys/k%2F1/stream?view=latest-v1")
})
