import { IDENTITY_BLOCK } from './system-blocks'
import type { MessagesBoundaryCtx } from './types'
import type { MessagesTextBlock } from '@vibe-llm/protocols/messages'

// system[1]; relies on injectBillingBlock having materialized payload.system
// as an array (see ./index.ts chain order).
export const injectIdentityBlock = async <TResult>(
  _env: object,
  ctx: MessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = ctx.payload.system as MessagesTextBlock[]
  ctx.payload = { ...ctx.payload, system: [...system, IDENTITY_BLOCK] }
  return await run()
}
