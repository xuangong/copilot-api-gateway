import type { ChatCompletionsInterceptor } from './types'
import { withRequestNormalization } from "../../shared/request-normalization"

export const withEmptyToolsToolChoiceNone: ChatCompletionsInterceptor = withRequestNormalization((inv) => {
  const payload = inv.payload as Record<string, unknown>
  if (inv.enabledFlags.has('empty-tools-tool-choice-none') && Array.isArray(payload.tools) && payload.tools.length === 0) {
    inv.payload = { ...payload, tool_choice: 'none' } as typeof inv.payload
  }
})
