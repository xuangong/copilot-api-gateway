import { buildBillingBlock, computeCcVersionFingerprint } from './system-blocks'
import type { MessagesBoundaryCtx } from './types'
import { CLAUDE_CLI_VERSION } from '../../headers'

// Drops per-request `cc_version=${VERSION}.${FP}` billing block at head of
// `system`. Runs BEFORE inject-identity-block / inject-default-template so
// wire order matches byte-for-byte CC shape: system[0]=billing,
// system[1]=identity, system[2]=default template.
//
// Hoist must run first so caller-supplied system text is captured into
// `messages`; this unconditionally starts a fresh `system` array.
//
// Fingerprint runs on post-hoist payload deliberately — that is the shape
// Anthropic will actually see on the wire.
export const injectBillingBlock = async <TResult>(
  _env: object,
  ctx: MessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const fingerprint = computeCcVersionFingerprint(CLAUDE_CLI_VERSION, ctx.payload)
  const block = buildBillingBlock(CLAUDE_CLI_VERSION, fingerprint)
  ctx.payload = { ...ctx.payload, system: [block] }
  return await run()
}
