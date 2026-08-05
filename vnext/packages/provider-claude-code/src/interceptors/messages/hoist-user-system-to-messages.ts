import type { MessagesBoundaryCtx } from './types'
import type { MessagesPayload, MessagesTextBlock } from '@vibe-llm/protocols/messages'

type MessagesMessage = MessagesPayload['messages'][number]

// Synthetic assistant turn that closes the hoisted user/assistant pair so the
// upstream's role-alternation guard stays satisfied. Two independent OAuth-
// mimicry impls (sub2api + claude-relay-service) converged on this exact
// literal; divergence is a likely detector signal, so we match.
const SYNTHETIC_ACK = 'Understood. I will follow these instructions.'

// On the re-mimicry path the upstream's `system` slot is reserved for the
// three CC-mimicry blocks. Any caller-supplied system content must therefore
// move OUT of `system` before those blocks are injected — the convention
// sub2api and Parrot both ship is to fold it into the head of `messages` as
// a synthetic user/assistant turn. The ack keeps role alternation valid.
//
// Non-text fields on blocks (citations, cache_control) are intentionally
// dropped — the wrapped turn is best-effort recovery of the operator's intent.
export const hoistUserSystemToMessages = async <TResult>(
  _env: object,
  ctx: MessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = ctx.payload.system as string | MessagesTextBlock[] | undefined
  let captured = ''
  if (typeof system === 'string') {
    captured = system
  } else if (system !== undefined) {
    captured = system
      .map((block) => block.text)
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n\n')
  }
  // inject-billing-block et al rebuild `system` from scratch; removing the
  // field here keeps the boundary mutation self-contained.
  const nextPayload = { ...ctx.payload }
  delete nextPayload.system

  if (captured !== '') {
    // Wrapper `[System Instructions]\n${text}` matches sub2api
    // `gateway_service.go:4480` byte-for-byte; synthetic user content is
    // structured `[{type:"text",text:...}]` — the shape both reference impls
    // and real CC use.
    const synthetic: MessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${captured}` }] },
      { role: 'assistant', content: [{ type: 'text', text: SYNTHETIC_ACK }] },
    ]
    nextPayload.messages = [...synthetic, ...nextPayload.messages]
  }

  ctx.payload = nextPayload
  return await run()
}
