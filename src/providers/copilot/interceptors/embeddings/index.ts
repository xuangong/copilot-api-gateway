import type { CopilotInterceptor } from "~/providers/interceptor"

/**
 * Empty — embeddings has no payload-shape transforms, only variant filtering
 * which CopilotProvider skips for this endpoint kind.
 */
export const embeddingsPayloadInterceptors: readonly CopilotInterceptor[] = []
