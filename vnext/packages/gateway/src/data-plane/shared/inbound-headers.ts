// Inbound client headers → upstream. The conduit is opt-in per provider:
// `LlmModelProvider.inboundHeaderAllowlist` names what that provider can
// consume, and the gateway filters through it at the binding boundary. A
// provider that declares nothing gets nothing, which is the status quo for
// every provider except claude-code.
//
// Ported from copilot-gateway
// `packages/gateway/src/data-plane/shared/inbound-headers.ts`.
import type { InboundHeaderMatcher } from '@vibe-llm/provider-llm'

// Never forwarded regardless of what a provider's allowlist says. These
// authenticate the client to *us*; relaying them upstream would leak a
// gateway credential into a third-party request. Providers supply their own
// upstream auth, so there is no legitimate reason to pass these through.
const NEVER_FORWARD = new Set(['authorization', 'proxy-authorization', 'cookie'])

// `RegExp.test` on a `/g` or `/y` matcher advances `lastIndex`, so reusing one
// instance across header names would alternate hit/miss. Clone per test.
const regexpMatches = (regexp: RegExp, value: string): boolean =>
  new RegExp(regexp.source, regexp.flags).test(value)

export const filterInboundHeaders = (
  headers: Headers,
  allowlist: readonly InboundHeaderMatcher[],
): Headers => {
  const exactNames = new Set(
    allowlist.flatMap((entry) => (typeof entry === 'string' ? [entry.toLowerCase()] : [])),
  )
  const regexps = allowlist.filter((entry): entry is RegExp => entry instanceof RegExp)
  const filtered = new Headers()
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase()
    if (NEVER_FORWARD.has(normalized)) continue
    if (exactNames.has(normalized) || regexps.some((re) => regexpMatches(re, normalized))) {
      filtered.append(name, value)
    }
  }
  return filtered
}

/**
 * Attempt-level convenience: reduce the raw inbound headers to the plain object
 * an {@link Invocation} carries, using whatever the resolved provider declares.
 * Absent headers or an absent allowlist both collapse to `{}` — the status quo
 * for every provider that hasn't opted in.
 */
export const allowedInboundHeaders = (
  inbound: Headers | undefined,
  provider: { readonly inboundHeaderAllowlist?: readonly InboundHeaderMatcher[] },
): Record<string, string> => {
  const allowlist = provider.inboundHeaderAllowlist
  if (!inbound || !allowlist || allowlist.length === 0) return {}
  return Object.fromEntries(filterInboundHeaders(inbound, allowlist))
}
