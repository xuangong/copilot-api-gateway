import type { ResponsesInterceptor } from './types'

export const withEmptyToolsToolChoiceNone: ResponsesInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as Record<string, unknown>
  if (inv.enabledFlags.has('empty-tools-tool-choice-none') && Array.isArray(payload.tools) && payload.tools.length === 0) {
    inv.payload = { ...payload, tool_choice: 'none' } as typeof inv.payload
  }
  return run()
}
