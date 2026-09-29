/**
 * Bridge between /v1/responses dispatch and the responses-snapshot store.
 *
 * `expandPreviousResponseId` mutates the inbound payload in place: when
 * `previous_response_id` is present, load the matching snapshot, prepend its
 * `items` to `payload.input`, and drop the field so the upstream call never
 * sees it. `savePostTurnSnapshot` is the post-turn writer.
 */
import { snapshotExpiresAt, type ResponsesSnapshotStore } from '@vibe-llm/responses-store'
import type { ApiKeyId, ResponsesItemId } from '../../repo/branded-ids.ts'

export class PreviousResponseNotFoundError extends Error {
  readonly status = 400
  constructor(readonly responseId: ResponsesItemId) {
    super(`Previous response with id '${responseId}' not found.`)
    this.name = 'PreviousResponseNotFoundError'
  }
}

export async function expandPreviousResponseId(
  payload: { previous_response_id?: string | null; input?: unknown },
  store: ResponsesSnapshotStore,
  apiKeyId: ApiKeyId | null,
  refreshRetentionSeconds?: number,
): Promise<void> {
  const raw = payload.previous_response_id
  if (raw == null || raw === '') return
  // Intake boundary: brand the untrusted string from the parsed payload
  // once here so downstream code operates on ResponsesItemId.
  const id = raw as ResponsesItemId
  const snap = await store.load(id, apiKeyId, { refreshRetentionSeconds })
  if (!snap) throw new PreviousResponseNotFoundError(id)
  appendPreviousResponseItems(payload, snap.items)
}

export function appendPreviousResponseItems(payload: { previous_response_id?: string | null; input?: unknown }, items: readonly unknown[]): void {
  const existing = Array.isArray(payload.input)
    ? (payload.input as unknown[])
    : typeof payload.input === 'string' && payload.input.length > 0
      ? [{ type: 'message', role: 'user', content: payload.input } as unknown]
      : []
  payload.input = [...items, ...existing]
  delete payload.previous_response_id
}

export async function savePostTurnSnapshot(
  store: ResponsesSnapshotStore,
  args: {
    retentionSeconds: number
    responseId: ResponsesItemId
    apiKeyId: ApiKeyId | null
    model: string
    inputItems: unknown[]
    outputItems: unknown[]
    compactTriggered?: boolean
  },
): Promise<void> {
  const now = Date.now()
  await store.save({
    responseId: args.responseId,
    apiKeyId: args.apiKeyId,
    model: args.model,
    // A completed trigger's returned output is the canonical continuation
    // window, including any retained neighbors and every compact item.
    items: responseContinuationItems(args.inputItems, args.outputItems, args.compactTriggered),
    createdAt: now,
    expiresAt: snapshotExpiresAt(now, args.retentionSeconds),
  })
}

/** The same canonical compaction window is used by durable and private state. */
export function responseContinuationItems(input: readonly unknown[], output: readonly unknown[], compactTriggered = false): unknown[] {
  const hasCompactOutput = output.some(item => typeof item === "object" && item !== null && "type" in item
    && (item.type === "compaction" || item.type === "compaction_summary"))
  return compactTriggered && hasCompactOutput ? [...output] : [...input, ...output]
}
