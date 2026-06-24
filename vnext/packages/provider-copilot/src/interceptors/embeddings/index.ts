import type { CopilotInterceptor } from "@vnext-llm/protocols/common"

/**
 * Empty — embeddings has no payload-shape transforms, only variant filtering
 * which CopilotProvider skips for this endpoint kind.
 */
export const embeddingsPayloadInterceptors: readonly CopilotInterceptor[] = []
