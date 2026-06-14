import type { ResponsesSnapshotStore } from "@vnext/responses-store"
import { __registerPlatformReset } from "@vnext/platform"

let _store: ResponsesSnapshotStore | null = null
__registerPlatformReset(() => { _store = null })

export function initResponsesStore(store: ResponsesSnapshotStore): void {
  _store = store
}

export function getResponsesStore(): ResponsesSnapshotStore {
  if (!_store) throw new Error("ResponsesStore not initialized; call initResponsesStore() first")
  return _store
}
