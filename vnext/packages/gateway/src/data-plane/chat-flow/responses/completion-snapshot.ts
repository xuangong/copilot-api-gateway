import type { ResponsesSnapshotStore } from "@vibe-llm/responses-store"
import { savePostTurnSnapshot } from "../../dispatch/responses-store-bridge.ts"
import type { ApiKeyId, ResponsesItemId } from "../../../repo/branded-ids.ts"
import type { ResponsesCompletionWriter } from "./respond.ts"

/** Capture the request's policy and store before provider interceptors run. */
export function createResponseSnapshotWriter(args: {
  readonly store: ResponsesSnapshotStore
  readonly apiKeyId: ApiKeyId
  readonly retentionSeconds: number
  readonly fallbackModel: string
}): ResponsesCompletionWriter {
  const { store, apiKeyId, retentionSeconds, fallbackModel } = args
  return async (response, inputItems) => {
    await savePostTurnSnapshot(store, {
      responseId: response.id as ResponsesItemId,
      apiKeyId,
      retentionSeconds,
      model: typeof response.model === "string" ? response.model : fallbackModel,
      inputItems: [...inputItems],
      outputItems: response.output,
    })
  }
}
