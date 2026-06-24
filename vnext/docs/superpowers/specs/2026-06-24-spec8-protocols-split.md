# Spec 8 — Protocols Split + Scope Layering

**Date:** 2026-06-24
**Status:** Design approved
**Predecessors:** [Spec 7 — @vnext/interceptor → @vnext/service](./2026-06-24-spec7-interceptor-to-service.md); [vNext Roadmap](../research/2026-06-23-vnext-roadmap.md)
**Target:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

---

## 1. Goal

Make the framework / business split **visible at the package-name level**, and finish carving the LLM concepts out of `@vnext/protocols` so the framework layer is genuinely domain-neutral.

After Spec 8:

- **Framework scope `@vnext-gateway/*`** — domain-neutral, can serve any vertical. Zero LLM concepts.
- **Business scope `@vnext-llm/*`** — LLM vertical built on top of the framework.

Any `import '...'` statement reveals its layer from the scope alone.

---

## 2. Why now

After Spec 7 the framework / business boundary is correct in code but **invisible in package names** — `@vnext/service` (framework) and `@vnext/gateway` (business) look identical at the import site. The Clean Gateway Charter §4.1 calls for a hard split; Spec 8 makes the boundary observable so future drift is grep-able.

`@vnext/protocols` is the last package that still **mixes** framework concerns (the SSE `ProtocolFrame` abstraction, `parseSSEStream`) with LLM business types (`TelemetryModelIdentity`, `Invocation`, `ModelPricing`, four sub-protocol event shapes). Splitting it lands the last conceptual seam in the right place.

---

## 3. Architecture

### 3.1 Framework scope `@vnext-gateway/*`

| Package | Source | Contents |
|---|---|---|
| `@vnext-gateway/result` | **new** | `ProtocolFrame`, `EventFrame`, `DoneFrame`, `SseFrame`, `SseCommentFrame`, `SseWritableFrame` + factories; `parseSSEStream`, `parseTargetStreamFrames` |
| `@vnext-gateway/service` | rename of `@vnext/service` | `Interceptor<Ctx,Req,Result>`, `Service`, `Next`, `runInterceptors` |
| `@vnext-gateway/platform` | rename of `@vnext/platform` | env / sql / file / background / runtime-location |
| `@vnext-gateway/http` | rename of `@vnext/http` | `fetch-retry`, `headers`, `body` |
| `@vnext-gateway/cache` | rename of `@vnext/cache` | `memory`, `kv`, `d1` |

**Framework purity invariant (Charter §6):** packages under `@vnext-gateway/*` MUST NOT import any `@vnext-llm/*` package. Enforced by `scripts/check-framework-purity.ts` in CI.

### 3.2 Business scope `@vnext-llm/*`

| Package | Source |
|---|---|
| `@vnext-llm/protocols` | new — old `@vnext/protocols` minus the framework frame primitives |
| `@vnext-llm/translate` | rename of `@vnext/translate` |
| `@vnext-llm/responses-store` | rename of `@vnext/responses-store` |
| `@vnext-llm/provider` | rename of `@vnext/provider` |
| `@vnext-llm/provider-copilot` | rename of `@vnext/provider-copilot` |
| `@vnext-llm/provider-azure` | rename of `@vnext/provider-azure` |
| `@vnext-llm/provider-custom` | rename of `@vnext/provider-custom` |
| `@vnext-llm/provider-sdf` | rename of `@vnext/provider-sdf` |
| `@vnext-llm/gateway` | rename of `@vnext/gateway` |

The business package that today is called `@vnext/gateway` retains the word *gateway* in its package name because the `@vnext-llm/` scope already says "LLM business" — keeping the name preserves directory continuity (`vnext/packages/gateway/` stays) and aligns with the Envoy Gateway naming convention for the user-facing entry package.

### 3.3 `@vnext-gateway/result` package layout

```
@vnext-gateway/result
  exports:
    "."        → ProtocolFrame, EventFrame, DoneFrame, SseFrame,
                 SseCommentFrame, SseWritableFrame,
                 eventFrame, doneFrame, sseFrame, sseCommentFrame
    "./parse"  → parseSSEStream, parseTargetStreamFrames + option types

  src/
    frame.ts        — ProtocolFrame primitives (from protocols/common/sse.ts)
    parse-sse.ts    — from protocols/common/stream/parse-sse.ts
    parse-events.ts — from protocols/common/stream/parse-events.ts
    index.ts
    parse.ts        — re-exports the two parsers
```

Dependencies: `zod` only if any parser uses it (verify during implementation). Forbidden: `@vnext-gateway/service`, `@vnext-gateway/platform`, anything under `@vnext-llm/*`.

### 3.4 `@vnext-llm/protocols` package layout

```
@vnext-llm/protocols
  exports:
    "./common"     → all LLM-shared types
    "./chat"       → ChatCompletionsStreamEvent + sub-protocol shapes
    "./messages"   → MessagesStreamEvent
    "./responses"  → ResponsesStreamEvent
    "./gemini"     → GeminiStreamEvent

  src/
    common/
      index.ts          — EndpointKey, UpstreamKind, ModelKind, BillingDimension,
                          ModelPricing, ENDPOINTS_BY_MODEL_KIND, ALL_*,
                          unitPriceForDimension, endpointCompatibleWithKind,
                          ClientProtocol
      result.ts         — LlmEventResult<T>, LlmExecuteResult<T>,
                          TelemetryModelIdentity, PerformanceTelemetryContext,
                          EventResultMetadata, TranslateBodyContext,
                          UpstreamErrorResult, InternalErrorResult,
                          llmEventResult, llmInternalErrorResult,
                          readUpstreamError, upstreamErrorToResponse,
                          decodeUpstreamErrorBody
      invocation.ts     — Invocation, RequestContext,
                          CopilotInterceptor, three *StreamInterceptor aliases
      account-type.ts   — AccountType
      upstream.ts       — UpstreamRecord
      model-endpoints.ts— ModelEndpoints, kindForEndpoints
    chat/ messages/ responses/ gemini/
                        — same shape as today; internal imports of frame types
                          go through @vnext-gateway/result, all other shared
                          types come from ../common
    No root index.ts export — consumers go through subpath ./common, ./chat,
    etc. Preserves today's import boundaries.
```

Dependencies: `@vnext-gateway/result`, `@vnext-gateway/service`, `zod`. No platform dependency.

### 3.5 Type renames inside `@vnext-llm/protocols/common`

To eliminate "generic result" misreadings of types that always carry LLM telemetry:

| Old name | New name |
|---|---|
| `EventResult<T>` | `LlmEventResult<T>` |
| `ExecuteResult<T>` | `LlmExecuteResult<T>` |
| `eventResult()` | `llmEventResult()` |
| `internalErrorResult()` | `llmInternalErrorResult()` |

The three `*StreamInterceptor` aliases and `CopilotInterceptor` keep their names — they already convey the LLM context. Implementation must update every consumer call site in the same commit (hard cut, no shim).

---

## 4. Data flow (consumer perspective)

A representative `chat-completions` interceptor:

**Before:**
```ts
import { Interceptor } from '@vnext/service'
import type { Invocation, RequestContext } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { ExecuteResult, ProtocolFrame } from '@vnext/protocols/common'
```

**After:**
```ts
import { Interceptor } from '@vnext-gateway/service'
import type { ProtocolFrame } from '@vnext-gateway/result'
import type {
  Invocation, RequestContext, LlmExecuteResult,
} from '@vnext-llm/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext-llm/protocols/chat'
```

The scope alone reveals the layer of each dependency.

---

## 5. Migration mechanics (hard cut, one PR per logical step)

Steps land in dependency-topological order. After every step `bun test` must pass.

1. **Create `vnext/packages/result/`** with `@vnext-gateway/result`. Move `protocols/common/sse.ts` → `result/src/frame.ts` and `protocols/common/stream/*` → `result/src/`. Add re-exports inside `@vnext/protocols/common` so consumers still compile (temporary, removed in step 4). Run tests.
2. **Rename framework packages** to `@vnext-gateway/*`: service, platform, http, cache. One commit per rename; `sed` every consumer import; regenerate `bun.lock`. Tests after each.
3. **Create `@vnext-llm/protocols`** as a directory rename of `packages/protocols/` → `packages/protocols-llm/`, package.json `name` to `@vnext-llm/protocols`. Internal imports of frame types switch to `@vnext-gateway/result`. Apply the `EventResult` → `LlmEventResult` renames across all consumers (≈128 files). Single commit.
4. **Rename remaining business packages** to `@vnext-llm/*`: translate, responses-store, provider, provider-{copilot,azure,custom,sdf}, gateway. `sed` consumers; one commit per package; `bun.lock` refresh.
5. **Drop the temporary re-exports** from step 1 (they were only needed during steps 2–4).
6. **Add `scripts/check-framework-purity.ts`** wired into `bun test` (runs before the suite). Violation example output:
   ```
   [FRAMEWORK PURITY VIOLATION]
     @vnext-gateway/result imports @vnext-llm/protocols at:
       packages/result/src/parse-sse.ts:12
   ```
   Exits non-zero on any hit.
7. **Update `vnext/apps/platform-bun/Dockerfile`** — `COPY` paths are directory-based and unchanged for renamed packages; only `protocols/` → `protocols-llm/` and the new `result/` need updating. Verify image build.

Workspaces in `vnext/package.json` use glob `packages/*`, so directory names changing (only `protocols/` → `protocols-llm/`, plus the new `result/`) are picked up automatically. `bun.lock` regenerates from the new manifest names.

---

## 6. Charter §6 enforcement script

`vnext/scripts/check-framework-purity.ts`:

- Reads every `package.json` under `vnext/packages/*` and `vnext/apps/*`.
- For each package with scope `@vnext-gateway/`, scans its `src/` and `__tests__/` for `from '@vnext-llm/...'` imports.
- Also rejects `@vnext-gateway/*` packages whose `dependencies` / `devDependencies` mention `@vnext-llm/*`.
- Exit 0 = clean; exit 1 = violations, prints offending file:line.
- Hook: `bun test` script becomes `bun run scripts/check-framework-purity.ts && bun test` (root `package.json`).

This is the durable mechanism that prevents future drift. Without it the scope split is decorative.

---

## 7. Acceptance criteria

A1. All existing 981 tests in `bun test` pass after every commit on this branch.
A2. Per-package `bun run typecheck` succeeds for: `result`, `service`, `platform`, `http`, `cache`, `protocols-llm`, `provider-copilot`, `gateway`. Pre-existing baseline errors in `translate/src/gemini-via-responses/body.ts` (3 hits) and the provider-azure/custom/sdf typecheck failures noted in Spec 7 §8.1 may persist; no new errors introduced.
A3. `scripts/check-framework-purity.ts` exits 0.
A4. `grep -rn "@vnext/" vnext/packages vnext/apps --include='*.ts' --include='*.json'` returns zero matches in source files (matches inside `docs/superpowers/` are historical and allowed).
A5. `vnext/apps/platform-bun/Dockerfile` builds end-to-end (`docker build` against `vnext/` context succeeds).
A6. No behavior change: chat-completions / messages / responses / gemini live calls return byte-identical output to a pre-Spec-8 baseline (manual smoke acceptable; full SDK integration tests recommended).

---

## 8. Out of scope (deferred)

- Splitting `@vnext-llm/gateway` into runtime (chat-flow framework) vs application (admin / control-plane). Roadmap §3 step 5 / Spec 10.
- Carving `@vnext-llm/provider` into `@vnext-gateway/upstream` (domain-neutral Plugin/Binding) + `@vnext-llm/provider-llm` (model/pricing overlay). Roadmap §3 step 4 / Spec 9.
- The final scope rename to `@<final-name>/*`. Roadmap §3 step 6.
- vNext → main physical promotion. Roadmap §3 step 7.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| 128-file `sed` introduces typos | Each rename step is one commit; `bun test` after every step catches lexical errors immediately. |
| `bun.lock` drift breaks containers | Regenerate after each step; CI builds the Docker image as an acceptance check (A5). |
| `Dockerfile` COPY paths miss the new `result/` directory | Step 7 explicitly updates the Dockerfile; manual `docker build` in acceptance. |
| Framework-purity script has false positives (e.g. tooling globs) | Allowlist `vnext/scripts/`, `vnext/docs/`, top-level `vnext/package.json` in the scanner. |
| Future contributors revert to `@vnext/*` names out of habit | The purity script also rejects `@vnext/` (un-scoped) imports outside historical docs. |
