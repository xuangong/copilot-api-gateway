/**
 * Bridge between /v1/responses dispatch and the responses-snapshot store.
 *
 * `expandPreviousResponseId` mutates the inbound payload in place: when
 * `previous_response_id` is present, load the matching snapshot, prepend its
 * `items` to `payload.input`, and drop the field so the upstream call never
 * sees it. `savePostTurnSnapshot` is the post-turn writer.
 */
import type { ResponsesSnapshotStore } from '@vnext/responses-store'

export class PreviousResponseNotFoundError extends Error {
  readonly status = 400
  constructor(readonly responseId: string) {
    super(`Previous response with id '${responseId}' not found.`)
    this.name = 'PreviousResponseNotFoundError'
  }
}

export async function expandPreviousResponseId(
  payload: { previous_response_id?: string | null; input?: unknown },
  store: ResponsesSnapshotStore,
  apiKeyId: string | null,
): Promise<void> {
  void payload
  void store
  void apiKeyId
  throw new Error('not implemented')
}

export async function savePostTurnSnapshot(
  store: ResponsesSnapshotStore,
  args: {
    responseId: string
    apiKeyId: string | null
    model: string
    inputItems: unknown[]
    outputItems: unknown[]
  },
): Promise<void> {
  void store
  void args
  throw new Error('not implemented')
}
