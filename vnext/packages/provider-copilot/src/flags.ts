/**
 * Flag helpers used by the Copilot provider / interceptors.
 *
 * Verbatim copy of the `defaultsForUpstream` helper plus the full
 * `OPTIONAL_FLAGS` catalog literal it iterates over (the union of flag IDs
 * is part of the contract — bit-exact reproduction only). Mirrors
 * apps/gateway/src/data-plane/flags/catalog.ts.
 */

import type { UpstreamKind } from "@vnext/protocols/common"

export interface Flag {
  id: string
  label: string
  description: string
  /** Upstream kinds that turn this flag on by default. */
  defaultFor: readonly UpstreamKind[]
}

export const OPTIONAL_FLAGS = [
  {
    id: "vendor-deepseek",
    label: "Vendor: DeepSeek style",
    description: "Marks this upstream as DeepSeek-compatible. Affects some flags below.",
    defaultFor: [],
  },
  {
    id: "vendor-qwen",
    label: "Vendor: Qwen style",
    description: "Marks this upstream as Qwen-compatible. Affects some flags below.",
    defaultFor: [],
  },
  {
    id: "retry-cyber-policy",
    label: "Retry on upstream cyber-policy block",
    description: "Retry cyber_policy 4xx errors from the upstream (up to 10 attempts).",
    defaultFor: ["copilot"],
  },
  {
    id: "messages-web-search-shim",
    label: "Messages web search shim",
    description: "Execute Anthropic native Messages web search through the gateway's configured search provider instead of forwarding it to the upstream. When a Messages request is routed to a non-Messages backend, the shim always runs regardless of this flag because those targets cannot carry Anthropic server tools.",
    defaultFor: ["copilot", "azure"],
  },
  {
    id: "deepseek-reasoning-dialect",
    label: "DeepSeek reasoning dialect",
    description: "On Chat Completions, use DeepSeek's legacy reasoning_content field instead of OpenAI's reasoning_text.",
    defaultFor: [],
  },
  {
    id: "disable-reasoning-on-forced-tool-choice",
    label: "Disable reasoning when caller forces a tool",
    description: "Disable reasoning in the outbound request when the caller forces a specific tool. Combine with a vendor flag to also emit that vendor's disable signal.",
    defaultFor: [],
  },
  {
    id: "promote-thinking-display",
    label: "Promote thinking blocks to visible display",
    description: "Wrap Anthropic thinking blocks in display-only formatting so clients that strip reasoning still surface the chain-of-thought.",
    defaultFor: [],
  },
  // ── Transform toggles ────────────────────────────────────────────────
  // Every entry below defaults ON for copilot (the upstream that needs
  // these compatibility patches). Admins can opt OUT per-upstream when an
  // upstream variant doesn't need the workaround.
  {
    id: "transform-vision-header",
    label: "Transform: copilot-vision-request header",
    description: "Set `copilot-vision-request: true` when the payload carries images. Without it, Copilot treats Anthropic image blocks as plain text.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-force-store-false",
    label: "Transform: force store:false on /responses",
    description: "Strip `store:true` from /responses payloads. Copilot rejects it with 400 unsupported_value.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-strip-image-generation",
    label: "Transform: strip image_generation tool",
    description: "Remove public image_generation tool entries from /responses. Copilot rejects them.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-strip-safety-identifier",
    label: "Transform: strip safety_identifier on translated /responses",
    description: "Remove safety_identifier when the request was translated from a non-Responses shape. VSCode Copilot Chat never sends it natively; only applies when the source API differs from /responses.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-strip-structured-output-format",
    label: "Transform: strip output_config.format",
    description: "Strip output_config.format from /v1/messages. Vertex-routed Copilot rejects structured_outputs via GCP org policy.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-strip-tool-strict",
    label: "Transform: strip tools[].strict",
    description: "Strip tools[].strict from /v1/messages. Vertex-routed Copilot rejects structured_outputs schemas.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-attach-cache-control-markers",
    label: "Transform: attach Copilot cache-control markers",
    description: "Tag stable prefixes (first 2 system messages) and the recent tail (last 2 non-system) on Chat Completions with Copilot's private cache-control marker. Generic OpenAI ignores it.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-attach-messages-cache-breakpoints",
    label: "Transform: attach /v1/messages cache breakpoints",
    description: "Inject Anthropic ephemeral cache_control breakpoints on translated /v1/messages payloads (system end, tools end when >=3, second-to-last user turn). Skipped when caller already set any cache_control.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-set-initiator-header",
    label: "Transform: x-initiator header",
    description: "Set x-initiator to user/agent based on last message role. Copilot uses this for abuse controls and billing/quota accounting.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-set-interaction-id-header",
    label: "Transform: x-interaction-id header",
    description: "SHA-256 hash of metadata.user_id session fingerprint → x-interaction-id on /v1/messages, for Copilot trace correlation.",
    defaultFor: ["copilot"],
  },
  {
    id: "transform-compress-inline-images",
    label: "Transform: compress inline base64 images to WebP",
    description: "Recompress base64 data-URL images in the payload to WebP via the Cloudflare Images binding before forwarding upstream. Cuts bandwidth and avoids the lossy multi-pass re-encode Copilot/Anthropic do server-side. No-op when no Images binding is configured.",
    defaultFor: ["copilot"],
  },
] as const satisfies readonly Flag[]

/**
 * Provider-default flag set, computed from the catalog's `defaultFor`.
 * Memoized per upstream kind because resolution happens per-request.
 */
const DEFAULTS_CACHE = new Map<UpstreamKind, ReadonlySet<string>>()

export function defaultsForUpstream(kind: UpstreamKind): ReadonlySet<string> {
  let cached = DEFAULTS_CACHE.get(kind)
  if (!cached) {
    cached = new Set(
      OPTIONAL_FLAGS
        .filter((f) => (f.defaultFor as readonly string[]).includes(kind))
        .map((f) => f.id),
    )
    DEFAULTS_CACHE.set(kind, cached)
  }
  return cached
}
