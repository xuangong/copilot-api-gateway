/**
 * Moving a chat history in and out of `localStorage`.
 *
 * Image bytes never go in — they live in `image-store.ts` and are referenced by
 * id. These helpers are pure so the round trip (strip → persist → hydrate) is
 * testable without a browser.
 */

import type { Part } from "./parts"

export interface PersistedMessage {
  role: string
  text: string
  parts?: Part[]
}

/** Messages written before the composer carried `parts` held one `imageUrl`. */
export type LegacyMessage = { imageUrl?: string }

/** Drops the legacy field and rebuilds it as a trailing image part. */
export function migrateMessage<T extends PersistedMessage & LegacyMessage>(
  m: T,
): Omit<T, "imageUrl"> & { parts?: Part[] } {
  if (!m.imageUrl) return m
  const { imageUrl, ...rest } = m
  if (rest.parts) return rest
  const parts: Part[] = []
  if (rest.text) parts.push({ type: "text", text: rest.text })
  parts.push({ type: "image", dataUrl: imageUrl })
  return { ...rest, parts }
}

export function stripImageBytes<T extends PersistedMessage>(m: T): T {
  if (!m.parts?.some((p) => p.type === "image" && p.dataUrl)) return m
  return {
    ...m,
    parts: m.parts.map((p) =>
      p.type === "image" ? (p.id ? { type: "image", dataUrl: "", id: p.id } : { type: "image", dataUrl: "" }) : p,
    ),
  }
}

export function hydrateMessage<T extends PersistedMessage>(m: T, byId: Map<string, string>): T {
  if (!m.parts?.some((p) => p.type === "image" && !p.dataUrl && p.id && byId.has(p.id))) return m
  return {
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== "image" || p.dataUrl || !p.id) return p
      const dataUrl = byId.get(p.id)
      return dataUrl ? { type: "image", dataUrl, id: p.id } : p
    }),
  }
}

/**
 * Attaches store ids to images a previous release kept inline in
 * `localStorage`, so they survive the next reload like any pasted image.
 */
export function adoptImageIds<T extends PersistedMessage>(
  m: T,
  idByDataUrl: Map<string, string>,
): T {
  if (!m.parts?.some((p) => p.type === "image" && p.dataUrl && !p.id && idByDataUrl.has(p.dataUrl))) {
    return m
  }
  return {
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== "image" || !p.dataUrl || p.id) return p
      const id = idByDataUrl.get(p.dataUrl)
      return id ? { type: "image", dataUrl: p.dataUrl, id } : p
    }),
  }
}

/** Every image id the history still refers to — the keep-set for pruning. */
export function collectImageIds(messages: PersistedMessage[]): string[] {
  const ids = new Set<string>()
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type === "image" && p.id) ids.add(p.id)
    }
  }
  return [...ids]
}
