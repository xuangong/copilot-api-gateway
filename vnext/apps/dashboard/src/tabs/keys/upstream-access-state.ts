import type { KeyUpstreamChoice } from "../../api/types"

interface UpstreamAccessInput {
  upstream_ids?: string[] | null
  upstreamIds?: string[] | null
  upstream_ids_invalid?: boolean
}

export interface UpstreamAccessDraft {
  mode: "inherit" | "custom"
  ids: string[]
  customInitialized: boolean
}

export interface UpstreamAccessRow {
  id: string
  name: string
  provider: string | null
  enabled: boolean
  selected: boolean
  unavailable: boolean
}

export function initialUpstreamAccessDraft(server: UpstreamAccessInput): UpstreamAccessDraft {
  const ids = server.upstream_ids_invalid
    ? []
    : server.upstream_ids !== undefined ? server.upstream_ids : server.upstreamIds
  return ids == null
    ? { mode: "inherit", ids: [], customInitialized: false }
    : { mode: "custom", ids: [...ids], customInitialized: true }
}

export function setUpstreamAccessMode(draft: UpstreamAccessDraft, mode: UpstreamAccessDraft["mode"], choices: KeyUpstreamChoice[]): UpstreamAccessDraft {
  if (mode === "inherit") return { ...draft, mode }
  return {
    mode,
    ids: draft.customInitialized ? [...draft.ids] : choices.map((choice) => choice.id),
    customInitialized: true,
  }
}

export function setUpstreamSelected(draft: UpstreamAccessDraft, id: string, selected: boolean): UpstreamAccessDraft {
  return {
    ...draft,
    ids: selected
      ? draft.ids.includes(id) ? [...draft.ids] : [...draft.ids, id]
      : draft.ids.filter((selectedId) => selectedId !== id),
  }
}

export function moveSelectedUpstream(draft: UpstreamAccessDraft, index: number, delta: number): UpstreamAccessDraft {
  const target = index + delta
  const current = draft.ids[index]
  const replacement = draft.ids[target]
  if (current === undefined || replacement === undefined) return draft
  const ids = [...draft.ids]
  ids[index] = replacement
  ids[target] = current
  return { ...draft, ids }
}

export function upstreamAccessPatch(draft: UpstreamAccessDraft): { upstream_ids: string[] | null } {
  return { upstream_ids: draft.mode === "inherit" ? null : [...draft.ids] }
}

export function isUpstreamAccessDirty(draft: UpstreamAccessDraft, server: UpstreamAccessInput): boolean {
  if (server.upstream_ids_invalid) return true
  const initial = initialUpstreamAccessDraft(server)
  if (draft.mode !== initial.mode) return true
  return draft.mode === "custom" && (
    draft.ids.length !== initial.ids.length || draft.ids.some((id, index) => id !== initial.ids[index])
  )
}

export function buildUpstreamAccessRows(choices: KeyUpstreamChoice[], selectedIds: string[]): UpstreamAccessRow[] {
  const byId = new Map(choices.map((choice) => [choice.id, choice]))
  const selected = new Set(selectedIds)
  const rows = selectedIds.map((id): UpstreamAccessRow => {
    const choice = byId.get(id)
    return choice
      ? { ...choice, selected: true, unavailable: false }
      : { id, name: id, provider: null, enabled: false, selected: true, unavailable: true }
  })
  for (const choice of choices) {
    if (!selected.has(choice.id)) rows.push({ ...choice, selected: false, unavailable: false })
  }
  return rows
}
