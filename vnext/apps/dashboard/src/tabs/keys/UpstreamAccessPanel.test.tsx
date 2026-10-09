import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { UpstreamAccessPanel } from "./UpstreamAccessPanel"

function render(ids: string[] | null, canEdit = true, invalid = false) {
  return renderToStaticMarkup(createElement(UpstreamAccessPanel, {
    keyRow: { id: "key-a", upstream_ids: ids, upstream_ids_invalid: invalid },
    canEdit, busy: false, onSave: async () => true,
  }))
}

test("read mode distinguishes inheritance from a custom empty selection", () => {
  expect(render(null)).toContain("dash.upstreamAccessInheritHint")
  const empty = render([])
  expect(empty).toContain("dash.upstreamAccessEmpty")
  expect(empty).not.toContain("dash.upstreamAccessInheritHint")
  expect(empty).toContain("dash.upstreamAccessSharedHint")
})

test("the key permission flag controls whether the edit action is available", () => {
  expect(render(null, true)).toContain(">dash.edit</button>")
  expect(render(null, false)).not.toContain(">dash.edit</button>")
})

test("invalid settings display a fail-closed repair warning", () => {
  expect(render([], true, true)).toContain("dash.upstreamAccessInvalid")
  expect(render([], true, false)).not.toContain("dash.upstreamAccessInvalid")
})
