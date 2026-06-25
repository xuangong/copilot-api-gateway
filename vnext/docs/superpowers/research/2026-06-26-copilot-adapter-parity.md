# Copilot upstream client-adapter parity audit

Generated: 2026-06-26

Cross-checks our `provider-copilot` against the reference project at
`/Users/zhangxian/projects/copilot-gateway` (the canonical Floway/vibe-llm
implementation). Goal: catalogue every Copilot upstream "work-around"
adapter that exists in reference, mark whether we ship an equivalent, and
list the real gaps.

## Methodology

For each of `messages`, `chat-completions`, `responses`, `shared`
interceptor families, list reference adapters and our equivalent. Cover is
"yes" when our codebase has the same effect (even if the file is renamed
or moved into `variants.ts`/`transforms/`).

## Messages family

| Reference adapter | What it does | Ours |
|---|---|---|
| `align-context-management-beta` | Strip `context-management-2025-06-27` when not whitelisted | ✅ `interceptors/shared/with-context-management-beta-aligned.ts` |
| `apply-top-level-cache-control` | Apply `payload.cache_control` to last message | ✅ `with-top-level-cache-control-applied.ts` |
| `compress-images` | Inline-image size+format normalization | ✅ `with-inline-images-compressed.ts` |
| `detect-claude-code-metadata` | Tag invocation with `metadata.user_id` if Claude Code UA detected | ✅ `transforms/detect-claude-code-metadata.ts` (driven from claude-agent-headers interceptor) |
| `filter-anthropic-beta-header` | Allowlist `anthropic-beta` values; synthesize `interleaved-thinking-2025-05-14` when `thinking.budget_tokens` set | ✅ `interceptors/shared/with-variant-and-beta-filtering.ts` + `variants.filterAnthropicBetaForUpstream` |
| `promote-thinking-display` | Force `thinking.display=omitted` for Claude ≥4.7 (and `summarized` otherwise) when client did not specify | ❌ **GAP** — we don't downgrade thinking display when client omits it |
| `rewrite-context-window-error` | Convert raw upstream `context_length_exceeded` into Messages `invalid_request_error` so Claude Code triggers compaction | ❌ **GAP** — upstream 400s for context overflow bubble up raw, breaking Claude Code compaction |
| `set-claude-agent-headers` | Set `User-Agent`, `X-Initiator`, etc when Claude-Code detected | ✅ `with-claude-agent-headers.ts` |
| `set-compact-headers` | Add `X-Conversation-Length`/`X-Compact` style headers | ✅ `with-compact-headers.ts` |
| `set-initiator-header` | Set `X-Initiator: agent` | ✅ `interceptors/shared/with-initiator-header.ts` |
| `set-interaction-id-header` | Stable per-conversation id | ✅ `with-interaction-id-header.ts` |
| `set-vision-header` | Toggle `Copilot-Vision-Request` from inline image presence | ✅ `with-vision-header.ts` |
| `strip-cache-control-extensions` | Remove `cache_control.ttl` and other extension fields | ✅ `with-cache-control-extensions-stripped.ts` |
| `strip-eager-input-streaming` | Strip per-tool `eager_input_streaming` (Copilot rejects extras) | ✅ `with-eager-input-streaming-stripped.ts` |
| `strip-structured-output-format` | Strip new structured `output_format` if unsupported | ✅ `with-structured-output-format-stripped.ts` |
| `strip-tool-strict` | Strip per-tool `strict: true` | ✅ `with-tool-strict-stripped.ts` |

## Responses family

| Reference adapter | What it does | Ours |
|---|---|---|
| `abort-on-tool-argument-whitespace` | Detect Copilot's whitespace-only `function_call_arguments.delta` runaway and abort stream with an `error` event | ❌ **GAP** — clients can hang until `max_tokens` on degenerate runs |
| `compress-images` | Inline-image normalization (responses input path) | ✅ `with-inline-images-compressed.ts` |
| `force-store-false` | Force `store: false` (Copilot does not own response storage) | ✅ `with-store-forced-false.ts` |
| `set-initiator-header` | `X-Initiator: agent` | ✅ shared `with-initiator-header.ts` |
| `set-vision-header` | Vision header toggle | ✅ `with-vision-header.ts` |
| `strip-image-generation` | Strip `tools[].type === 'image_generation'` (Copilot rejects) | ✅ `with-image-generation-stripped.ts` |
| `strip-service-tier` | Strip `service_tier` (Copilot ignores) | ✅ `with-service-tier-stripped.ts` |
| `synchronize-output-item-ids` | Pin output_item.id across `added`/`done`/delta events so `@ai-sdk/openai` reasoning-part tracking does not crash | ❌ **GAP** — `@ai-sdk/openai` clients (Codex CLI families) crash on Copilot's id drift |
| — (ours-only) `safety-identifier` strip | Strip `safety_identifier` field — Copilot 400s on unknown extras | ✅ `with-safety-identifier-stripped.ts` |

## Chat-completions family

| Reference adapter | What it does | Ours |
|---|---|---|
| `abort-on-tool-argument-whitespace` | Same as responses-side, applied to `tool_call.arguments` deltas | ❌ **GAP** — symmetric to responses gap |
| `attach-cache-control-markers` | Inject Anthropic-style cache_control on tool/system blocks for chat→messages translation | ✅ `with-cache-control-markers-attached.ts` |
| `compress-images` | Inline-image normalization | ✅ `with-inline-images-compressed.ts` |
| `set-initiator-header` | `X-Initiator: agent` | ✅ shared `with-initiator-header.ts` |
| `set-vision-header` | Vision header toggle | ✅ `with-vision-header.ts` |

## Shared / cross-family

| Reference adapter | What it does | Ours |
|---|---|---|
| `whitespace-overflow` | Counter helper used by abort-on-tool-argument-whitespace | ❌ — not needed in our tree until we add the abort adapters |

## Summary of real gaps

Three behavioural gaps, all of them adapters whose purpose is to mask
specific Copilot upstream bugs that bite specific clients:

1. **`promote-thinking-display`** (messages) — when Claude Code (or any
   client) sends `thinking.budget_tokens` without `thinking.display`,
   Copilot returns full thinking by default. Reference downgrades to
   `omitted` (Claude ≥4.7) or `summarized` (older) so token spend stays
   predictable and the UI does not get a wall of text. Without this, our
   gateway returns more text than Claude Code expects.

2. **`rewrite-context-window-error`** (messages) — Copilot can surface
   context-length failures as non-Messages-shaped errors. Claude Code's
   compaction trigger keys on the canonical `invalid_request_error`
   message ("prompt is too long: ..."), so without rewriting we break
   Claude Code's auto-compaction loop.

3. **`abort-on-tool-argument-whitespace`** (responses + chat-completions)
   plus **`synchronize-output-item-ids`** (responses) — these are the
   two Codex-CLI / `@ai-sdk/openai` survivability patches. Without
   `abort-on-tool-argument-whitespace`, Copilot's degenerate streams
   (whitespace-only deltas until `max_tokens`) hang the client until
   token budget exhausts. Without `synchronize-output-item-ids`, the AI
   SDK's reasoning-part tracker crashes mid-stream because Copilot drifts
   the `output_item.id` between `added`/`.done`/delta events.

## Recommendation

Port the four missing adapters from reference. They are pure boundary
interceptors (no provider state required, no cross-package coupling) and
each one has a self-contained reference implementation with tests. The
risk is low and the failure mode in each case is a known, reproducible
upstream pathology.

Suggested order (highest user-visible impact first):

1. `synchronize-output-item-ids` (responses) — Codex CLI crashes hard
2. `abort-on-tool-argument-whitespace` (responses + chat-completions) —
   hung streams up to `max_tokens`
3. `rewrite-context-window-error` (messages) — Claude Code compaction
4. `promote-thinking-display` (messages) — token spend / UX

Each is a separate ~50-line interceptor + test, and each lands at the
provider boundary so no other provider is affected.
