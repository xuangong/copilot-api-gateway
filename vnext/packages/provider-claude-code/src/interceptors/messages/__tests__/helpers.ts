import type { MessagesBoundaryCtx } from '../types'
import type { ClaudeCodeProviderModel } from '../../../models'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

export const makeModel = (max_output_tokens?: number): ClaudeCodeProviderModel =>
  ({
    id: 'claude-sonnet-4-5',
    limits: { max_context_window_tokens: 200_000, max_output_tokens },
  }) as unknown as ClaudeCodeProviderModel

export const makeCtx = (
  payload: Partial<MessagesPayload> & { messages: MessagesPayload['messages'] },
  opts: { upstreamId?: string; model?: ClaudeCodeProviderModel } = {},
): MessagesBoundaryCtx => ({
  payload: {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    ...payload,
  } as MessagesPayload,
  model: opts.model ?? makeModel(),
  upstreamId: opts.upstreamId ?? 'upstream-A',
})

export const runOnce = async <T>(
  interceptor: (env: object, ctx: MessagesBoundaryCtx, run: () => Promise<T>) => Promise<T>,
  ctx: MessagesBoundaryCtx,
  terminal: () => Promise<T> = async () => 'ok' as unknown as T,
): Promise<T> => interceptor({}, ctx, terminal)
