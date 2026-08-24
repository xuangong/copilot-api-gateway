// Claude Code re-mimicry chain. Runs on the re-mimicry path only —
// `ClaudeCodeProvider.fetch` bypasses the chain entirely when
// `isClaudeCodeShapedRequest` says the inbound request is already CC-shaped.
//
// Order matters:
//   1. backfillRequiredFields         fills max_tokens/temperature so rest
//                                     of the chain sees fully-formed shape.
//   2. synthesizeMetadataUserId       runs early so session_id derives from
//                                     operator's real first user message,
//                                     not the synthetic pair hoist injects.
//   3. hoistUserSystemToMessages      captures caller's system text into a
//                                     synthetic user/assistant pair so the
//                                     three mimicry blocks own `system`.
//   4. injectBillingBlock             system[0]: per-request cc_version /
//                                     cch=00000 fingerprint.
//   5. injectIdentityBlock            system[1]: canonical CC identity text.
//   6. injectDefaultTemplate          system[2]: cached boilerplate template.
//
// On-wire `model` field is set in fetch.ts from
// providerData.upstreamModelId — the chain never rewrites it.

import { backfillRequiredFields } from './backfill-required-fields'
import { hoistUserSystemToMessages } from './hoist-user-system-to-messages'
import { injectBillingBlock } from './inject-billing-block'
import { injectDefaultTemplate } from './inject-default-template'
import { injectIdentityBlock } from './inject-identity-block'
import { synthesizeMetadataUserId } from './synthesize-metadata-user-id'
import type { MessagesBoundaryCtx } from './types'
import type { Interceptor } from '@vibe-core/service'

export type { MessagesBoundaryCtx } from './types'

export const CLAUDE_CODE_MESSAGES_BOUNDARY: readonly Interceptor<
  MessagesBoundaryCtx,
  object,
  Response
>[] = [
  backfillRequiredFields,
  synthesizeMetadataUserId,
  hoistUserSystemToMessages,
  injectBillingBlock,
  injectIdentityBlock,
  injectDefaultTemplate,
]
