/**
 * OpenAI Responses protocol types.
 *
 * Re-exported from services/responses; will absorb the definitions
 * when the translate package split lands.
 */

export type {
  ResponsesAPIResponse,
  ResponsesStreamState,
  ResponsesEvent,
} from "~/services/responses"

export type { ResponsesPayload } from "~/transforms/types"
