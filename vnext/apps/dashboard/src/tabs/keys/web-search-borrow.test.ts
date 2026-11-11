import { describe, expect, test } from "bun:test"
import type { ApiKeyDetail } from "../../api/keys"
import { borrowCandidates, linkedKeyName } from "./web-search-borrow"

function key(id: string, fields: Partial<ApiKeyDetail> = {}): ApiKeyDetail {
  return {
    id,
    name: id,
    web_search_langsearch_key: null,
    web_search_tavily_key: null,
    web_search_ms_grounding_key: null,
    web_search_jina_key: null,
    ...fields,
  } as ApiKeyDetail
}

const jinaOnly = key("jina-only", { web_search_jina_key: "jina_****1234" })
const groundingOnly = key("grounding-only", { web_search_ms_grounding_key: "ms_****5678" })
const self = key("self", { web_search_jina_key: "jina_****0000", web_search_ms_grounding_key: "ms_****0000" })
const keys = [self, jinaOnly, groundingOnly]

describe("borrowCandidates", () => {
  test("Jina offers only keys that hold a Jina key", () => {
    expect(borrowCandidates("jina", keys, "self").map((k) => k.id)).toEqual(["jina-only"])
  })

  test("MS Grounding offers only keys that hold an MS Grounding key", () => {
    expect(borrowCandidates("msGrounding", keys, "self").map((k) => k.id)).toEqual(["grounding-only"])
  })

  test("LangSearch and Tavily filter on their own fields", () => {
    const ls = key("ls", { web_search_langsearch_key: "ls_****" })
    const tv = key("tv", { web_search_tavily_key: "tv_****" })
    expect(borrowCandidates("langsearch", [ls, tv], "self").map((k) => k.id)).toEqual(["ls"])
    expect(borrowCandidates("tavily", [ls, tv], "self").map((k) => k.id)).toEqual(["tv"])
  })

  test("the current key is never its own candidate", () => {
    for (const engine of ["langsearch", "tavily", "msGrounding", "jina"] as const) {
      expect(borrowCandidates(engine, keys, "self").some((k) => k.id === "self")).toBe(false)
    }
  })
})

describe("linkedKeyName", () => {
  test("prefers the server's descriptor, then the picked key's name, then its id", () => {
    expect(linkedKeyName({ id: "a", name: "Alpha", owner_id: null }, "b", keys)).toBe("Alpha")
    expect(linkedKeyName({ id: "a", name: null, owner_id: null }, "b", keys)).toBe("a")
    expect(linkedKeyName(null, "named", [key("named", { name: "Named key" })])).toBe("Named key")
    expect(linkedKeyName(null, "gone", keys)).toBe("gone")
    expect(linkedKeyName(null, "", keys)).toBe("")
  })
})
