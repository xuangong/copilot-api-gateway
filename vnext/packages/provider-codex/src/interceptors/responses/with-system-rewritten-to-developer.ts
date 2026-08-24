// Codex's Responses Lite wire carries base instructions as leading developer
// messages and never emits a `system` role in `input[]`. Native callers and the
// translate layer both do produce `system` items, so the provider normalises
// them at its boundary — otherwise we forward a shape the client we impersonate
// cannot produce, on the very endpoint we impersonate it on.
// https://github.com/openai/codex/blob/1f17e7512f0e47625f2cad416f14870688a99814/codex-rs/core/src/client.rs#L829-L849
//
// Reference parity note: copilot-gateway gates this behind the
// `rewrite-system-to-developer` flag defaulting true for codex. vNext's codex
// boundary chain runs on a provider-internal Invocation with no flag set, and
// the reference never ships it off for codex, so it applies unconditionally
// here rather than growing a flag-plumbing path with one always-on consumer.
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

export const withSystemRewrittenToDeveloper: CopilotInterceptor = async (inv, _ctx, run) => {
  const input = inv.payload.input
  // `input` is legally a bare string, and hand-built payloads can carry junk;
  // neither has a role to rewrite.
  if (!Array.isArray(input)) return run()

  let changed = false
  const rewritten = input.map((item) => {
    if (typeof item !== "object" || item === null) return item
    if ((item as { role?: unknown }).role !== "system") return item
    changed = true
    return { ...(item as object), role: "developer" }
  })
  if (changed) inv.payload.input = rewritten

  return run()
}
