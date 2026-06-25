/**
 * Bridge between /v1/responses dispatch and the responses-snapshot store.
 *
 * `expandPreviousResponseId` mutates the inbound payload in place: when
 * `previous_response_id` is present, load the matching snapshot, prepend its
 * `items` to `payload.input`, and drop the field so the upstream call never
 * sees it. `savePostTurnSnapshot` is the post-turn writer.
 */
import type { ResponsesSnapshotStore } from '@vibe-llm/responses-store'

const DEFAULT_TTL_MS = 24 * 3600_000

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
  const id = payload.previous_response_id
  if (id == null || id === '') return
  const snap = await store.load(id, apiKeyId)
  if (!snap) throw new PreviousResponseNotFoundError(id)
  const existing = Array.isArray(payload.input)
    ? (payload.input as unknown[])
    : typeof payload.input === 'string' && payload.input.length > 0
      ? [{ type: 'message', role: 'user', content: payload.input } as unknown]
      : []
  payload.input = [...snap.items, ...existing]
  delete payload.previous_response_id
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
  const now = Date.now()
  await store.save({
    responseId: args.responseId,
    apiKeyId: args.apiKeyId,
    model: args.model,
    items: [...args.inputItems, ...args.outputItems],
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
  })
}
