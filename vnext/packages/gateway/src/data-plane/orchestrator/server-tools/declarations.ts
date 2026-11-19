import type { ResponsesInputItem, ResponsesTool } from './types'

/**
 * Every tool declaration a Responses payload carries, with its JSON path:
 * top-level `tools` plus the positional carriers Codex uses
 * (`additional_tools` and `tool_search_output` input items).
 * Adapted from reference copilot-gateway `collectOpenAIResponsesToolEntries` (659f185dc, #558).
 */
export const collectResponsesToolEntries = (
  payload: { tools?: unknown; input?: unknown },
): Array<{ tool: ResponsesTool; path: string }> => [
  ...(Array.isArray(payload.tools) ? (payload.tools as ResponsesTool[]) : []).map((tool, index) => ({ tool, path: `tools[${index}]` })),
  ...(Array.isArray(payload.input) ? (payload.input as ResponsesInputItem[]) : []).flatMap((item, inputIndex) =>
    (item.type === 'additional_tools' || item.type === 'tool_search_output') && Array.isArray(item.tools)
      ? (item.tools as ResponsesTool[]).map((tool, toolIndex) => ({ tool, path: `input[${inputIndex}].tools[${toolIndex}]` }))
      : []),
]
