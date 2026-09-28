import type { MessagesPayload } from '@vibe-llm/protocols/messages'

interface MessagesReasoningState {
  thinking?: { type?: string; budget_tokens?: number }
  output_config?: { effort?: string }
}

export function messagesReasoningFromEffort(effort: string | null | undefined): {
  thinking?: { type: 'disabled' }
  effort?: string
} {
  if (effort === 'none') return { thinking: { type: 'disabled' } }
  return effort ? { effort } : {}
}

export function effortFromMessages(
  payload: MessagesPayload,
  budgetToEffort: (budget: number) => string,
): string | undefined {
  const state = payload as MessagesPayload & MessagesReasoningState
  // The dedicated off switch wins over a contradictory effort level.
  if (state.thinking?.type === 'disabled') return 'none'
  if (state.output_config?.effort) return state.output_config.effort
  const budget = state.thinking?.budget_tokens
  return budget != null && budget > 0 ? budgetToEffort(budget) : undefined
}
