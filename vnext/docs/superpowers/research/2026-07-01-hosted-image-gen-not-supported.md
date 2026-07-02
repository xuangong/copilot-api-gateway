# vNext does not support hosted `image_generation` on the Responses route

**Decision date:** 2026-07-01
**Status:** Adopted — aligns with upstream reference project (`copilot-gateway`)

## TL;DR

vNext will **not** bridge the OpenAI Responses-API `image_generation` hosted
tool through `/v1/responses`. Clients that need image generation must call
`/v1/images/generations` directly (SDF provider). The Copilot provider chain
actively strips `image_generation` tool entries and matching `tool_choice`
values before forwarding to upstream.

## Why

### Upstream Copilot does not host `image_generation`

GitHub Copilot's Responses endpoint accepts hosted tool entries for
`web_search`, `tool_search`, and `namespace`, but rejects
`image_generation`. Forwarding the tool entry leaks an unsupported field to
upstream and produces undefined / 400 behavior.

### Codex desktop client gates injection on `input_modalities`

Investigation in late June 2026 (see prior diag logs in `attempt.ts` git
history) showed Codex desktop only injects `{type: "image_generation"}` into
`payload.tools` when ALL of these gates pass:

1. `uses_openai_actor_authorization()` OR Codex backend auth present
2. `capabilities().image_generation` (controlled by `[features].image_generation`)
3. `model_info.input_modalities.contains(InputModality::Image)`

Gate (3) fails for vNext-exposed model IDs (`gpt-5.5`, `gpt-5.4`, etc.) that
are not in Codex's built-in preset table. Even with the
`x-openai-actor-authorization` header workaround for gate (1) and the feature
flag set for gate (2), Codex still won't inject the tool entry for our
models. There is no client-side configuration in Codex that overrides
gate (3).

### The reference project takes the same stance

`copilot-gateway/TRANSLATION.md` (lines 148-170, 179-198) documents that the
upstream reference project:

- Strips `image_generation` tool entries at the Copilot boundary
  ("Copilot does not host it")
- Has no client-side injection mechanism
- Has no Codex upstream PR / capability flag to bypass the modality gate
- Routes actual image generation through a dedicated `/v1/images/*` endpoint
  (their SDF provider equivalent)

We mirror this architecture exactly.

## Implementation

### Boundary strip (active)

`vnext/packages/provider-copilot/src/transforms/strip-image-generation.ts`
removes any `{type: "image_generation"}` tool entry and matching
`tool_choice` from Responses payloads bound for Copilot upstream, gated by
the `transform-strip-image-generation` flag (default on for Copilot).
Interceptor: `with-image-generation-stripped.ts`. Mirrors the reference
project's Floway interceptor.

### Removed shortcut (deleted 2026-07-01)

The earlier
`vnext/packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts`
attempted to passively detect `image_generation` requests and bridge them to
the images endpoint server-side. This was deleted because:

- It was dead code in practice — Codex desktop never injected the tool entry
  for vNext models, so the shortcut never fired.
- Keeping it suggested an "ambiguous policy" — partial support that worked
  for hypothetical injecting clients but not for Codex. Cleaner to align
  with the reference project's "explicit rejection" stance.
- Future readers would be misled into thinking hosted image_gen via
  Responses was a supported path.

If a real use case ever emerges (e.g. a non-Codex client that natively
injects `image_generation`), reintroduce the bridge as a deliberate feature
rather than as a sleeping fallback.

## What clients should do

| Goal                                          | Route                                       |
| --------------------------------------------- | ------------------------------------------- |
| Generate an image directly                    | `POST /v1/images/generations` (SDF)         |
| Edit an image                                 | `POST /v1/images/edits` (SDF)               |
| Let the LLM decide when to generate an image  | Expose image generation as a `function`/`custom` tool in the LLM's tool list; intercept the tool call server-side or client-side and dispatch to `/v1/images/generations` |

The function-tool approach matches the reference project's broader
"function tool, not hosted tool" philosophy for image operations.

## References

- `copilot-gateway/TRANSLATION.md` (upstream reference) — Responses
  interceptor section
- `vnext/packages/provider-copilot/src/transforms/strip-image-generation.ts`
- `vnext/packages/provider-copilot/src/interceptors/responses/with-image-generation-stripped.ts`
- `codex-rs/core/src/tools/spec_plan.rs::image_generation_runtime_enabled`
- `codex-rs/model-provider-info/src/lib.rs::uses_openai_actor_authorization`
- Recent commit `142654e fix(root): allow /v1/images/* without GitHub token
  (SDF upstream support)` — landed the dedicated images endpoint that this
  decision routes clients to.
