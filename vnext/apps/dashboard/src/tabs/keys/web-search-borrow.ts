import type { ApiKeyDetail, KeyRefDescriptor } from "../../api/keys"

export type WebSearchEngine = "langsearch" | "tavily" | "msGrounding" | "jina"

const KEY_FIELD = {
  langsearch: "web_search_langsearch_key",
  tavily: "web_search_tavily_key",
  msGrounding: "web_search_ms_grounding_key",
  jina: "web_search_jina_key",
} as const satisfies Record<WebSearchEngine, keyof ApiKeyDetail>

/** Other keys holding their own key for `engine`, which this key may link to instead of storing one. */
export function borrowCandidates(engine: WebSearchEngine, keys: ApiKeyDetail[], selfId: string): ApiKeyDetail[] {
  const field = KEY_FIELD[engine]
  return keys.filter((k) => k.id !== selfId && k[field])
}

/**
 * What a linked engine row shows: the descriptor the server sent if there is one,
 * else the name of the key just picked (or its id when that key is gone).
 */
export function linkedKeyName(ref: KeyRefDescriptor | null, fallbackId: string, keys: ApiKeyDetail[]): string {
  if (ref) return ref.name ?? ref.id
  if (!fallbackId) return ""
  return keys.find((k) => k.id === fallbackId)?.name ?? fallbackId
}
