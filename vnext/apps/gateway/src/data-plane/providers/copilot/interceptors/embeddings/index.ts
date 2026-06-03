import type { CopilotInterceptor } from "../../../../interceptors/runner"

/**
 * Empty — embeddings has no payload-shape transforms, only variant filtering
 * which CopilotProvider skips for this endpoint kind.
 */
export const embeddingsPayloadInterceptors: readonly CopilotInterceptor[] = []
