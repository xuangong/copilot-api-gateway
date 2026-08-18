/**
 * Flag catalog — single source of truth for every admin-toggleable
 * per-upstream behavior flag.
 *
 * Lives in @vibe-llm/protocols because both the gateway and the provider
 * packages need it, and gateway already depends on the providers (so the
 * dependency cannot go the other way).
 *
 * Interceptors and translators reference a flag by id; the dependency
 * always goes interceptor → flag, never the reverse. This keeps the
 * catalog free of runtime closures and makes "one flag drives many
 * interceptors" straightforward.
 *
 * Vendor-style flags (e.g. `vendor-deepseek`) are data-only — they have
 * no interceptor of their own. Other interceptors read effective flags
 * and dispatch on these to choose vendor-specific protocol behavior.
 * With no vendor flag set, behavior defaults to the OpenAI standard.
 */

import type { UpstreamKind } from '../common/index'

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
    id: "vendor-kimi",
    label: "Vendor: Kimi style",
    description: "Marks this upstream as Kimi (Moonshot) OpenAI-compatible. Normalizes Kimi's flat `usage.cached_tokens` field into OpenAI's `prompt_tokens_details.cached_tokens`.",
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
    id: "strip-eager-input-streaming",
    label: "Strip Messages `eager_input_streaming`",
    description: "Strip the per-tool `eager_input_streaming` property from outbound Messages payloads. Copilot's native Messages target rejects it with `tools.N.custom.eager_input_streaming: Extra inputs are not permitted`. Leaves other providers untouched when the flag is off.",
    defaultFor: ["copilot"],
  },
  {
    id: "responses-image-generation-shim",
    label: "Responses image generation shim",
    description: "Execute the Responses `image_generation` hosted tool through the gateway's image-capable upstream (gpt-image-*) instead of forwarding it to a Responses upstream. The orchestrator model calls a generated function tool; the shim drives the standalone /images/{generations,edits} backend and synthesizes the native image_generation_call lifecycle. When a Responses request is routed to a non-Responses backend, the shim always runs regardless of this flag because those targets cannot carry the hosted image_generation tool.",
    defaultFor: ["copilot", "azure", "custom"],
  },
  {
    id: "responses-compact-shim",
    label: "Responses compact shim",
    description: "Simulate a `response.compaction` envelope against upstreams that have no native compaction wire. Runs the summarization turn through the upstream's standard /responses generate wire under the vendored openai/codex SUMMARIZATION_PROMPT, then packs the summary into a synthetic `response.compaction` output item. Structurally required (always engages, ignoring this flag) on non-Responses target endpoints because those translators cannot carry the `compaction_trigger` / `compaction` item variants.",
    defaultFor: ["claude-code"],
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
  // ── Role compatibility ──────────────────────────────────────────────
  {
    id: "promote-system-to-developer",
    label: "Promote system role to developer",
    description: "Rewrite `role:'system'` to `role:'developer'` on Chat Completions messages and Responses input items. Used for OpenAI o-series and upstreams that only accept `developer` at the system slot.",
    defaultFor: ["codex"],
  },
  {
    id: "demote-developer-to-system",
    label: "Demote developer role to system",
    description: "Rewrite `role:'developer'` to `role:'system'` on Chat Completions messages and Responses input items. Used for upstreams that don't know about the `developer` role yet.",
    defaultFor: [],
  },
  {
    id: "demote-interleaved-system-to-user",
    label: "Demote interleaved system messages to user",
    description: "Any `role:'system'` message that appears after the leading system run is rewritten to `role:'user'`. Applies to Messages, Chat Completions, and Responses. Used for upstreams that reject interleaved system messages mid-conversation.",
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
  {
    id: "strip-billing-attribution",
    label: "Strip Claude Code billing-attribution block from /v1/messages system",
    description: "Remove Claude Code's `x-anthropic-billing-header` line and per-turn `cch=<hash>` from `payload.system` before forwarding. The hash flips every turn, so leaving it in destroys upstream prompt-cache hit rate on every non-claude-code upstream. Must remain OFF for a claude-code subscription upstream (that endpoint reads the block to bill against the user's plan).",
    defaultFor: ["copilot", "azure", "custom", "codex"],
  },
] as const satisfies readonly Flag[]

export type OptionalFlagId = (typeof OPTIONAL_FLAGS)[number]["id"]

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
