import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RequestsEmptyState, RequestsLiveStatus } from "./RequestsPanel"
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

test("empty state distinguishes absent retained records from an all-omitted latest snapshot", () => {
  const render = (omittedRows: number, recordCount = 0, loading = false, listError: string | null = null) =>
    renderToStaticMarkup(<RequestsEmptyState loading={loading} listError={listError} recordCount={recordCount} omittedRows={omittedRows} />)
  expect(render(2)).toBe("")
  expect(render(0)).toContain("dash.requests.empty")
  expect(render(0, 1)).toBe("")
  expect(render(0, 0, true)).toBe("")
  expect(render(0, 0, false, "failed")).toBe("")
})
