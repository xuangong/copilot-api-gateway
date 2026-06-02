# Copilot Interceptor Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline `if (flags.has(...))` chains in `CopilotProvider.fetch()` with a Koa-style interceptor contract — `(inv, ctx, run) => Promise<Response>` — so request-side mutation, header injection, and (future) response-side wrapping all live in one composable shape.

**Architecture:**
- New file `src/providers/interceptor.ts` exports the contract: `Invocation`, `RequestContext`, `Interceptor<Ctx,Req,R>`, `runInterceptors`. Mirrors `copilot-gateway/apps/api/src/data-plane/llm/interceptors.ts` but stripped to what we actually need (no `ExecuteResult`/`ProtocolFrame`; terminal returns `Response`).
- New dir `src/providers/copilot/interceptors/{messages,chat-completions,responses,shared}/` — each transform call becomes one `with-xxx.ts` file + one `with-xxx.test.ts` file. Per-endpoint `index.ts` exports the readonly array in canonical order.
- `CopilotProvider.fetch()` collapses to: build `Invocation`, pick endpoint array, `runInterceptors(inv, ctx, arr, () => callCopilotAPI(...))`.
- `messages_count_tokens` gets its own array that reuses payload-mutation interceptors (incl. `withInlineImagesCompressed`) so token estimates match wire bytes — fixes a latent bug discovered during #64 analysis.

**Tech Stack:** TypeScript, Bun test runner, existing `~/transforms` mutation helpers (kept as-is, just wrapped by interceptors).

---

## File Structure

**New (contract):**
- `src/providers/interceptor.ts` — `Invocation`, `RequestContext`, `Interceptor`, `runInterceptors` (~50 lines)

**New (per-endpoint registries):**
- `src/providers/copilot/interceptors/messages/index.ts` — exports `messagesCopilotInterceptors`, `messagesCountTokensCopilotInterceptors`
- `src/providers/copilot/interceptors/responses/index.ts` — exports `responsesCopilotInterceptors`
- `src/providers/copilot/interceptors/chat-completions/index.ts` — exports `chatCompletionsCopilotInterceptors`
- `src/providers/copilot/interceptors/embeddings/index.ts` — exports `embeddingsCopilotInterceptors` (empty array initially — only variant/beta filtering for non-embeddings)

**New (one file per interceptor, mirrors current if-blocks 1:1):**

Shared (used by multiple endpoints):
- `shared/with-variant-and-beta-filtering.ts` + test
- `shared/with-initiator-header.ts` + test

Messages-specific:
- `messages/with-claude-agent-headers.ts` + test
- `messages/with-compact-headers.ts` + test
- `messages/with-interaction-id-header.ts` + test
- `messages/with-vision-header.ts` + test
- `messages/with-structured-output-format-stripped.ts` + test
- `messages/with-inline-images-compressed.ts` + test

Responses-specific:
- `responses/with-store-forced-false.ts` + test
- `responses/with-image-generation-stripped.ts` + test
- `responses/with-safety-identifier-stripped.ts` + test
- `responses/with-vision-header.ts` + test
- `responses/with-inline-images-compressed.ts` + test

Chat-Completions-specific:
- `chat-completions/with-cache-control-markers-attached.ts` + test
- `chat-completions/with-vision-header.ts` + test
- `chat-completions/with-inline-images-compressed.ts` + test

**Modified:**
- `src/providers/copilot/provider.ts` — `fetch()` body collapses from ~110 lines of if-blocks to ~30 lines (build `Invocation`, dispatch via `runInterceptors`). `applyVariantAndBetaFiltering` private method moves into `shared/with-variant-and-beta-filtering.ts`.

**Untouched:** `src/transforms/*` helpers stay exactly as they are — interceptors are thin wrappers calling them.

---

## Task 1: Interceptor 契约文件

**Files:**
- Create: `src/providers/interceptor.ts`
- Test: `tests/interceptor-contract.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/interceptor-contract.test.ts
import { describe, expect, test } from "bun:test"
import { runInterceptors, type Interceptor } from "~/providers/interceptor"

interface Ctx { trace: string[] }
type Inv = { value: number }
type Itc = Interceptor<Inv, Ctx, string>

describe("runInterceptors", () => {
  test("empty array calls terminal", async () => {
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 1 }, { trace: [] }, [], async () => "terminal",
    )
    expect(result).toBe("terminal")
  })

  test("invokes interceptors in array order, terminal last", async () => {
    const ctx: Ctx = { trace: [] }
    const a: Itc = async (_inv, c, run) => { c.trace.push("a-pre"); const r = await run(); c.trace.push("a-post"); return r }
    const b: Itc = async (_inv, c, run) => { c.trace.push("b-pre"); const r = await run(); c.trace.push("b-post"); return r }
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, ctx, [a, b], async () => { ctx.trace.push("terminal"); return "ok" },
    )
    expect(result).toBe("ok")
    expect(ctx.trace).toEqual(["a-pre", "b-pre", "terminal", "b-post", "a-post"])
  })

  test("interceptor can mutate invocation before run() and read result after", async () => {
    const ctx: Ctx = { trace: [] }
    const mutator: Itc = async (inv, _c, run) => { inv.value = 42; return run() }
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, ctx, [mutator], async () => "done",
    )
    expect(result).toBe("done")
  })

  test("interceptor can short-circuit without calling run()", async () => {
    let terminalCalled = false
    const guard: Itc = async () => "short-circuit"
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, { trace: [] }, [guard],
      async () => { terminalCalled = true; return "unused" },
    )
    expect(result).toBe("short-circuit")
    expect(terminalCalled).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun test tests/interceptor-contract.test.ts
```
Expected: FAIL — `Cannot find module '~/providers/interceptor'`

- [ ] **Step 3: 写最小实现**

```ts
// src/providers/interceptor.ts
import type { EndpointKey } from "~/protocols/common"

/**
 * Per-HTTP-request invariants. Threaded through every interceptor in the
 * chain. Fields that depend on the binding choice (model, flags, payload)
 * live on Invocation, not here.
 */
export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
}

/**
 * Per-provider-binding-attempt mutable state. Interceptors mutate `payload`
 * and `headers` in place; the terminal then ships them on the wire.
 *
 * Payload is intentionally untyped (`Record<string, unknown>`) because each
 * endpoint speaks a different protocol shape. Interceptors cast at the
 * boundary — matches what the inline if-blocks were already doing.
 */
export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  /** Original source protocol — lets translation-aware transforms run
   *  conditionally (e.g. strip safety_identifier only on translated payloads). */
  readonly sourceApi?: "messages" | "chat_completions" | "responses"
  payload: Record<string, unknown>
  headers: Record<string, string>
}

export type InterceptorRun<R> = () => Promise<R>

/**
 * Koa-style middleware. Each interceptor receives:
 *  - inv: mutable per-binding state
 *  - ctx: per-request invariants (read-only)
 *  - run: () => Promise<R> — invoke to delegate to next interceptor / terminal
 *
 * Call run() to wrap (do stuff before, await, do stuff after). Don't call
 * run() to short-circuit (e.g. cached response, validation reject).
 */
export type Interceptor<TInv, TCtx, R> = (
  inv: TInv,
  ctx: TCtx,
  run: InterceptorRun<R>,
) => Promise<R>

/**
 * Execute an interceptor chain. Terminal runs after the last interceptor
 * delegates with run(), or never runs if any interceptor short-circuits.
 */
export const runInterceptors = async <TInv, TCtx, R>(
  inv: TInv,
  ctx: TCtx,
  interceptors: readonly Interceptor<TInv, TCtx, R>[],
  terminal: InterceptorRun<R>,
): Promise<R> => {
  const run = (index: number): Promise<R> =>
    index < interceptors.length
      ? interceptors[index]!(inv, ctx, () => run(index + 1))
      : terminal()
  return run(0)
}

/** Convenience alias for Copilot interceptors. */
export type CopilotInterceptor = Interceptor<Invocation, RequestContext, Response>
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test tests/interceptor-contract.test.ts
```
Expected: PASS — 4 tests passing

- [ ] **Step 5: typecheck**

```
bunx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 6: commit**

```
git add src/providers/interceptor.ts tests/interceptor-contract.test.ts
git commit -m "$(cat <<'MSG'
feat(providers): add Koa-style Interceptor contract

Lays the foundation for replacing CopilotProvider.fetch()'s 14 inline
if-blocks with a composable, wrap-capable interceptor chain. Future
response-side mutations (e.g. context-window error rewrite) can plug in
without ad-hoc try/catch in each provider.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```


## Task 2: 迁第一个 interceptor — `withInlineImagesCompressed` (messages) + 顺手验证契约

迁这一个的目的是**在批量迁移前验证契约够不够用**。挑 messages 的 `compressInlineImagesMessages` 是因为：(a) 单一职责、不依赖其他 interceptor 的副作用；(b) 当前 count_tokens 没跑它（latent bug），迁完顺便修。

**Files:**
- Create: `src/providers/copilot/interceptors/messages/with-inline-images-compressed.ts`
- Create: `tests/with-inline-images-compressed-interceptor.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/with-inline-images-compressed-interceptor.test.ts
import { beforeEach, describe, expect, test } from "bun:test"
import {
  initImageProcessor,
  type ImageProcessor,
  type ImageSizeCalculator,
} from "~/image"
import { withInlineImagesCompressed } from "~/providers/copilot/interceptors/messages/with-inline-images-compressed"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46])

interface SpyProcessor extends ImageProcessor {
  calls: number
}
const createSpyProcessor = (): SpyProcessor => {
  const spy = {
    calls: 0,
    compressToWebp(_b: Uint8Array, _t: ImageSizeCalculator) {
      spy.calls++
      return Promise.resolve(FAKE_WEBP)
    },
  }
  return spy
}

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean, hasImage: boolean): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(enabled ? ["transform-compress-inline-images"] : []),
  payload: {
    model: "claude-opus-4.7",
    messages: hasImage ? [{
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
      }],
    }] : [],
  },
  headers: {},
})

let spy: SpyProcessor

beforeEach(() => {
  spy = createSpyProcessor()
  initImageProcessor(spy)
})

describe("withInlineImagesCompressed (messages)", () => {
  test("compresses inline image when flag enabled", async () => {
    const inv = makeInv(true, true)
    const result = await withInlineImagesCompressed(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(1)
  })

  test("skips compression when flag disabled but still delegates", async () => {
    const inv = makeInv(false, true)
    const result = await withInlineImagesCompressed(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(0)
  })

  test("no-op when payload has no images, still delegates", async () => {
    const inv = makeInv(true, false)
    const result = await withInlineImagesCompressed(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(0)
  })

  test("propagates terminal response unchanged (no result mutation)", async () => {
    const inv = makeInv(true, true)
    const custom = new Response("custom-body", { status: 201 })
    const result = await withInlineImagesCompressed(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun test tests/with-inline-images-compressed-interceptor.test.ts
```
Expected: FAIL — `Cannot find module '~/providers/copilot/interceptors/messages/with-inline-images-compressed'`

- [ ] **Step 3: 写最小实现**

```ts
// src/providers/copilot/interceptors/messages/with-inline-images-compressed.ts
import { compressInlineImagesMessages } from "~/transforms/compress-inline-images"
import type { AnthropicMessagesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

/**
 * Recompress inline base64 images in /v1/messages payloads to WebP.
 *
 * Reused by the count_tokens chain so token estimates match the bytes
 * we actually ship — otherwise count_tokens reports too high for any
 * client that sends raw PNG/JPEG inline.
 */
export const withInlineImagesCompressed: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-compress-inline-images")) {
    await compressInlineImagesMessages(
      inv.payload as unknown as AnthropicMessagesPayload,
      inv.payload.model as string,
    )
  }
  return run()
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test tests/with-inline-images-compressed-interceptor.test.ts
```
Expected: PASS — 4 tests passing

- [ ] **Step 5: typecheck**

```
bunx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 6: commit**

```
git add src/providers/copilot/interceptors/messages/with-inline-images-compressed.ts tests/with-inline-images-compressed-interceptor.test.ts
git commit -m "$(cat <<'MSG'
feat(providers): port compressInlineImagesMessages to interceptor shape

First migration step that validates the interceptor contract before
batch-migrating the rest. Picked the image compression transform because
it's self-contained and is also missing from count_tokens — once the
count_tokens chain registers this same interceptor in Task 7, token
estimates will match wire bytes.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```



## Task 3: `withVariantAndBetaFiltering` (shared, factory closure)

最复杂的一个：要 `this.copilotToken` + `this.accountType` 才能跑 `getCachedRawModels`。用工厂闭包把 token 关进去——契约保持 stateless，vendor 私有依赖留在 vendor 实现里。

**Files:**
- Create: `src/providers/copilot/interceptors/shared/with-variant-and-beta-filtering.ts`
- Test: `tests/with-variant-and-beta-filtering-interceptor.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/with-variant-and-beta-filtering-interceptor.test.ts
import { describe, expect, test } from "bun:test"
import { createVariantAndBetaFilteringInterceptor } from "~/providers/copilot/interceptors/shared/with-variant-and-beta-filtering"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (
  endpoint: "messages" | "chat_completions" | "responses" | "messages_count_tokens",
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Invocation => ({
  endpoint,
  enabledFlags: new Set(),
  payload,
  headers,
})

describe("withVariantAndBetaFiltering", () => {
  test("no-op when endpoint is embeddings (skipped at registry level — interceptor not registered)", async () => {
    // Sanity: the factory itself doesn't gate on endpoint — gating happens via
    // omitting it from the embeddings array. Just verifies the factory shape.
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv("messages", { model: "claude-opus-4.7" })
    const result = await itc(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
  })

  test("composite id claude-opus-4.7-xhigh-1m parsed: model normalized, effort injected, beta merged", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv(
      "messages",
      { model: "claude-opus-4.7-xhigh-1m" },
      { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    )
    await itc(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.payload.model).toBe("claude-opus-4.7")
    const oc = inv.payload.output_config as { effort?: string } | undefined
    expect(oc?.effort).toBe("xhigh")
    expect(inv.headers["anthropic-beta"]).toContain("context-1m-2025-08-07")
  })

  test("x-copilot-reasoning-effort header consumed and injected into payload field per endpoint", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv(
      "chat_completions",
      { model: "gpt-5" },
      { "x-copilot-reasoning-effort": "high" },
    )
    await itc(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-copilot-reasoning-effort"]).toBeUndefined()
    expect((inv.payload as { reasoning_effort?: string }).reasoning_effort).toBe("high")
  })

  test("anthropic-beta filtered through Copilot allowlist", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv(
      "messages",
      { model: "claude-sonnet-4-6" },
      { "anthropic-beta": "context-management-2025-06-27,fine-grained-tool-streaming-2025-05-14" },
    )
    await itc(inv, ctx, async () => FAKE_RESPONSE)
    // context-management is stripped (not in allowlist); fine-grained-tool-streaming stays
    expect(inv.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14")
  })

  test("delegates to terminal and returns its response", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv("messages", { model: "claude-opus-4.7" })
    const custom = new Response("custom", { status: 201 })
    const result = await itc(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun test tests/with-variant-and-beta-filtering-interceptor.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: 写最小实现**

```ts
// src/providers/copilot/interceptors/shared/with-variant-and-beta-filtering.ts
import type { AccountType } from "~/config/constants"
import { getCachedRawModels } from "~/services/copilot/raw-models-cache"
import {
  filterAnthropicBetaForUpstream,
  hasContext1mBeta,
  parseAnthropicBeta,
  parseCompositeModelId,
  resolveCopilotRawModel,
} from "~/services/copilot/variants"
import type { CopilotInterceptor, Invocation } from "~/providers/interceptor"

type VariantKind = "messages" | "chat_completions" | "responses"

const KIND_BY_ENDPOINT: Record<string, VariantKind | null> = {
  messages: "messages",
  messages_count_tokens: "messages",
  chat_completions: "chat_completions",
  responses: "responses",
  embeddings: null,
  images_generations: null,
  images_edits: null,
}

/**
 * Vendor-specific interceptor: rewrites payload.model to a Copilot raw variant
 * id (e.g. claude-opus-4.7 → claude-opus-4.7-1m-internal) and filters the
 * anthropic-beta header through Copilot's allowlist.
 *
 * Factory closure: copilotToken + accountType are CopilotProvider instance
 * state that the interceptor needs for getCachedRawModels(). Keeping them out
 * of the Invocation contract preserves portability — other providers don't
 * need to know Copilot's variant catalog exists.
 */
export const createVariantAndBetaFilteringInterceptor = (
  copilotToken: string,
  accountType: AccountType,
): CopilotInterceptor => {
  return async (inv, _ctx, run) => {
    const kind = KIND_BY_ENDPOINT[inv.endpoint]
    if (kind !== null && kind !== undefined) {
      await applyVariantAndBetaFiltering(inv, kind, copilotToken, accountType)
    }
    return run()
  }
}

const applyVariantAndBetaFiltering = async (
  inv: Invocation,
  kind: VariantKind,
  copilotToken: string,
  accountType: AccountType,
): Promise<void> => {
  const { payload, headers } = inv
  const rawModelId = typeof payload.model === "string" ? payload.model : undefined

  const betaHeader = headers["anthropic-beta"] ?? headers["Anthropic-Beta"]
  const clientBeta = parseAnthropicBeta(betaHeader)

  const headerEffort = consumeReasoningEffortHeader(headers)
  const parsedComposite = rawModelId ? parseCompositeModelId(rawModelId) : undefined
  const compositeEffort = parsedComposite?.effort
  const compositeContext1m = parsedComposite?.context1m === true

  if (parsedComposite && parsedComposite.baseId !== rawModelId) {
    payload.model = parsedComposite.baseId
  }

  const payloadEffort = extractEffort(payload, kind)
  const effectiveEffort = compositeEffort ?? payloadEffort ?? headerEffort
  if (effectiveEffort && effectiveEffort !== payloadEffort) {
    injectEffort(payload, kind, effectiveEffort)
  }

  const wantContext1m = hasContext1mBeta(clientBeta) || compositeContext1m
  const modelId = typeof payload.model === "string" ? payload.model : undefined

  if (modelId?.startsWith("claude-") && copilotToken) {
    try {
      const rawModels = await getCachedRawModels(copilotToken, accountType)
      const resolved = resolveCopilotRawModel(rawModels, modelId, {
        context1m: wantContext1m,
        reasoningEffort: effectiveEffort,
      })
      if (resolved !== modelId) payload.model = resolved
    } catch (e) {
      console.error("[variants] resolve failed:", e)
    }
  }

  if (betaHeader !== undefined || compositeContext1m) {
    const mergedBeta = compositeContext1m && !clientBeta.includes("context-1m-2025-08-07")
      ? [...clientBeta, "context-1m-2025-08-07"]
      : clientBeta
    const filtered = filterAnthropicBetaForUpstream(mergedBeta, {
      thinkingBudgetTokens: kind === "messages" && hasThinkingBudget(payload),
      isAdaptiveThinking: kind === "messages" && isAdaptiveThinking(payload),
    })
    delete headers["anthropic-beta"]
    delete headers["Anthropic-Beta"]
    if (filtered.length > 0) headers["anthropic-beta"] = filtered.join(",")
  }
}

const consumeReasoningEffortHeader = (headers: Record<string, string>): string | undefined => {
  const variants = ["x-copilot-reasoning-effort", "X-Copilot-Reasoning-Effort"]
  let value: string | undefined
  for (const name of variants) {
    if (headers[name] !== undefined) {
      value = value ?? headers[name]
      delete headers[name]
    }
  }
  const trimmed = value?.trim()
  return trimmed && trimmed !== "none" ? trimmed : undefined
}

const injectEffort = (
  payload: Record<string, unknown>,
  kind: VariantKind,
  effort: string,
): void => {
  if (kind === "messages") {
    const oc = (payload as { output_config?: { effort?: string } }).output_config ?? {}
    oc.effort = effort
    ;(payload as { output_config?: { effort?: string } }).output_config = oc
    return
  }
  if (kind === "chat_completions") {
    ;(payload as { reasoning_effort?: string }).reasoning_effort = effort
    return
  }
  const r = (payload as { reasoning?: { effort?: string } }).reasoning ?? {}
  r.effort = effort
  ;(payload as { reasoning?: { effort?: string } }).reasoning = r
}

const extractEffort = (
  payload: Record<string, unknown>,
  kind: VariantKind,
): string | undefined => {
  if (kind === "messages") {
    return (payload as { output_config?: { effort?: string } }).output_config?.effort
  }
  if (kind === "chat_completions") {
    const e = (payload as { reasoning_effort?: string }).reasoning_effort
    return e && e !== "none" ? e : undefined
  }
  const r = (payload as { reasoning?: { effort?: string } }).reasoning
  return r?.effort && r.effort !== "none" ? r.effort : undefined
}

const hasThinkingBudget = (payload: Record<string, unknown>): boolean => {
  const t = (payload as { thinking?: { budget_tokens?: number } }).thinking
  return typeof t?.budget_tokens === "number" && t.budget_tokens > 0
}

const isAdaptiveThinking = (payload: Record<string, unknown>): boolean => {
  const t = (payload as { thinking?: { type?: string } }).thinking
  return t?.type === "adaptive"
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test tests/with-variant-and-beta-filtering-interceptor.test.ts
```
Expected: PASS — 5 tests passing

- [ ] **Step 5: typecheck**

```
bunx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 6: commit**

```
git add src/providers/copilot/interceptors/shared/with-variant-and-beta-filtering.ts tests/with-variant-and-beta-filtering-interceptor.test.ts
git commit -m "$(cat <<'MSG'
feat(providers): port variant/beta filtering to factory-closure interceptor

CopilotProvider.applyVariantAndBetaFiltering needs this.copilotToken +
this.accountType for getCachedRawModels(). Factory closure keeps those
Copilot-specific deps out of the Interceptor contract — other providers
don't need to know Copilot's variant catalog exists.

Original private method stays in provider.ts until Task N flips fetch()
to dispatch via runInterceptors.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```


## Task 4: `withInitiatorHeader` (shared)

`setInitiatorHeader` 现在是 provider.ts 里的 module-level 函数，对三种 endpoint 各调一个 classifier。包成统一 interceptor，按 endpoint 分派。

**Files:**
- Create: `src/providers/copilot/interceptors/shared/with-initiator-header.ts`
- Test: `tests/with-initiator-header-interceptor.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/with-initiator-header-interceptor.test.ts
import { describe, expect, test } from "bun:test"
import { withInitiatorHeader } from "~/providers/copilot/interceptors/shared/with-initiator-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (
  endpoint: Invocation["endpoint"],
  payload: Record<string, unknown>,
  enabled = true,
): Invocation => ({
  endpoint,
  enabledFlags: new Set(enabled ? ["transform-set-initiator-header"] : []),
  payload,
  headers: {},
})

describe("withInitiatorHeader", () => {
  test("skips when flag disabled", async () => {
    const inv = makeInv("messages", { messages: [{ role: "user", content: "hi" }] }, false)
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBeUndefined()
  })

  test("messages: classifies last message → x-initiator", async () => {
    const inv = makeInv("messages", { messages: [{ role: "user", content: "hi" }] })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("messages_count_tokens uses same classifier as messages", async () => {
    const inv = makeInv("messages_count_tokens", { messages: [{ role: "user", content: "hi" }] })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("chat_completions: classifies via messages role", async () => {
    const inv = makeInv("chat_completions", { messages: [{ role: "user", content: "hi" }] })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("deletes pre-existing X-Initiator to avoid duplicate casing", async () => {
    const inv = makeInv("messages", { messages: [{ role: "user", content: "hi" }] })
    inv.headers["X-Initiator"] = "agent"
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["X-Initiator"]).toBeUndefined()
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("embeddings: no-op (no conversation semantics)", async () => {
    const inv = makeInv("embeddings", { input: "hi" })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun test tests/with-initiator-header-interceptor.test.ts
```
Expected: FAIL

- [ ] **Step 3: 写最小实现**

```ts
// src/providers/copilot/interceptors/shared/with-initiator-header.ts
import {
  classifyChatCompletionsInitiator,
  classifyMessagesInitiator,
  classifyResponsesInitiator,
} from "~/transforms"
import type { AnthropicMessagesPayload, ResponsesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withInitiatorHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (!inv.enabledFlags.has("transform-set-initiator-header")) return run()

  let initiator: "user" | "agent" | undefined
  if (inv.endpoint === "messages" || inv.endpoint === "messages_count_tokens") {
    initiator = classifyMessagesInitiator(inv.payload as unknown as AnthropicMessagesPayload)
  } else if (inv.endpoint === "chat_completions") {
    initiator = classifyChatCompletionsInitiator(inv.payload as { messages?: Array<{ role?: string }> })
  } else if (inv.endpoint === "responses") {
    initiator = classifyResponsesInitiator(inv.payload as unknown as ResponsesPayload)
  }
  if (initiator) {
    delete inv.headers["X-Initiator"]
    inv.headers["x-initiator"] = initiator
  }
  return run()
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test tests/with-initiator-header-interceptor.test.ts
```
Expected: PASS — 6 tests

- [ ] **Step 5: typecheck + commit**

```
bunx tsc --noEmit
git add src/providers/copilot/interceptors/shared/with-initiator-header.ts tests/with-initiator-header-interceptor.test.ts
git commit -m "$(cat <<'MSG'
feat(providers): port x-initiator header logic to interceptor

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```


## Task 5: Messages-only interceptors (batch)

剩 5 个 messages 专属的薄包装，都是 `if (flag) transform(...)` 模式。一个 task 内串起来——每个 file 一个 sub-step（仍然 TDD），但合并 commit 减少噪音。

**Files (5 × source + 5 × test):**
- `messages/with-claude-agent-headers.ts` + test — wraps `setClaudeAgentHeaders` (无 flag 门，恒执行)
- `messages/with-compact-headers.ts` + test — wraps `setCompactHeaders` (无 flag 门)
- `messages/with-interaction-id-header.ts` + test — wraps `setInteractionIdHeader` (flag: `transform-set-interaction-id-header`), async
- `messages/with-vision-header.ts` + test — wraps `setMessagesVisionHeader` (flag: `transform-vision-header`)
- `messages/with-structured-output-format-stripped.ts` + test — wraps `stripStructuredOutputFormat` (flag: `transform-strip-structured-output-format`)

每个文件遵循统一模板：

```ts
// e.g. src/providers/copilot/interceptors/messages/with-vision-header.ts
import { setMessagesVisionHeader } from "~/transforms"
import type { AnthropicMessagesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withMessagesVisionHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-vision-header")) {
    setMessagesVisionHeader(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  }
  return run()
}
```

`withClaudeAgentHeaders` / `withCompactHeaders` 无 flag 门（恒执行）：

```ts
// src/providers/copilot/interceptors/messages/with-claude-agent-headers.ts
export const withClaudeAgentHeaders: CopilotInterceptor = async (inv, _ctx, run) => {
  setClaudeAgentHeaders(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  return run()
}
```

`withInteractionIdHeader` 是 async：

```ts
// src/providers/copilot/interceptors/messages/with-interaction-id-header.ts
export const withInteractionIdHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-set-interaction-id-header")) {
    await setInteractionIdHeader(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  }
  return run()
}
```

- [ ] **Step 1: 5 个失败测试一起写**

每个测试文件 3 个 case：flag-on（验证 header 被设置）、flag-off（验证未触碰）、terminal-passthrough。无 flag 门的两个只测 header-set + passthrough。模板：

```ts
import { describe, expect, test } from "bun:test"
import { withMessagesVisionHeader } from "~/providers/copilot/interceptors/messages/with-vision-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean, withImage = true): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(enabled ? ["transform-vision-header"] : []),
  payload: {
    messages: withImage
      ? [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }]
      : [{ role: "user", content: "hi" }],
  },
  headers: {},
})

describe("withMessagesVisionHeader", () => {
  test("sets copilot-vision-request when flag on and image present", async () => {
    const inv = makeInv(true)
    await withMessagesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["copilot-vision-request"]).toBe("true")
  })
  test("skips when flag off", async () => {
    const inv = makeInv(false)
    await withMessagesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["copilot-vision-request"]).toBeUndefined()
  })
  test("delegates terminal response", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withMessagesVisionHeader(makeInv(true), ctx, async () => custom)
    expect(result).toBe(custom)
  })
})
```

Apply same shape for the other 4. `withClaudeAgentHeaders` test asserts header populated when payload carries `metadata.user_id`. `withCompactHeaders` test asserts compact-class header set on auto-continue payload. `withInteractionIdHeader` test asserts `x-interaction-id` is a UUID v4 string when `metadata.user_id` parseable.

- [ ] **Step 2: 跑测试确认全失败**

```
bun test tests/with-claude-agent-headers-interceptor.test.ts tests/with-compact-headers-interceptor.test.ts tests/with-interaction-id-header-interceptor.test.ts tests/with-messages-vision-header-interceptor.test.ts tests/with-structured-output-format-stripped-interceptor.test.ts
```
Expected: 5 FAILs — modules not found

- [ ] **Step 3: 写 5 个实现**

按上面模板创建 5 个文件。每个文件 ≤15 行。

- [ ] **Step 4: 跑测试确认通过**

同上命令。Expected: ALL PASS

- [ ] **Step 5: typecheck + commit**

```
bunx tsc --noEmit
git add src/providers/copilot/interceptors/messages/ tests/with-claude-agent-headers-interceptor.test.ts tests/with-compact-headers-interceptor.test.ts tests/with-interaction-id-header-interceptor.test.ts tests/with-messages-vision-header-interceptor.test.ts tests/with-structured-output-format-stripped-interceptor.test.ts
git commit -m "$(cat <<'MSG'
feat(providers): port remaining messages-specific transforms to interceptors

withClaudeAgentHeaders, withCompactHeaders, withInteractionIdHeader,
withMessagesVisionHeader, withStructuredOutputFormatStripped — thin
wrappers around existing ~/transforms helpers, each gated on the same
flag the inline if-blocks check today.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```


## Task 6: Responses-only interceptors (batch)

5 个 responses 专属：4 个 flag-gated + 1 个 sourceApi-gated（`withSafetyIdentifierStripped` 只在 translated payload 上跑）。

**Files:**
- `responses/with-store-forced-false.ts` + test — `forceStoreFalse` (flag: `transform-force-store-false`)
- `responses/with-image-generation-stripped.ts` + test — `stripImageGeneration` (flag: `transform-strip-image-generation`)
- `responses/with-safety-identifier-stripped.ts` + test — `stripSafetyIdentifier` (flag + `inv.sourceApi !== "responses"`)
- `responses/with-vision-header.ts` + test — `setResponsesVisionHeader` (flag: `transform-vision-header`)
- `responses/with-inline-images-compressed.ts` + test — `compressInlineImagesResponses` (flag: `transform-compress-inline-images`)

特殊形态 — `withSafetyIdentifierStripped` 双重门：

```ts
// src/providers/copilot/interceptors/responses/with-safety-identifier-stripped.ts
import { stripSafetyIdentifier } from "~/transforms"
import type { ResponsesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

/**
 * Strip safety_identifier only when the /responses payload was translated
 * from a non-Responses source (Messages→Responses, Chat→Responses).
 * VSCode Copilot Chat never sends it natively; preserving caller-supplied
 * values on native Responses calls keeps trace correlation intact.
 */
export const withSafetyIdentifierStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  const sourceApi = inv.sourceApi ?? "responses"
  if (sourceApi !== "responses" && inv.enabledFlags.has("transform-strip-safety-identifier")) {
    stripSafetyIdentifier(inv.payload as unknown as ResponsesPayload)
  }
  return run()
}
```

其余 4 个同 Task 5 模板（payload cast to `ResponsesPayload`，async if needed）。

- [ ] **Step 1: 5 个失败测试**

模板同 Task 5。`with-safety-identifier-stripped` 测试增加 `sourceApi: "messages"` vs `sourceApi: "responses"` 两个 case 验证 source 门。

- [ ] **Step 2: 失败 → 实现 → 通过 → typecheck → commit**

按 Task 5 节奏。Commit message:

```
feat(providers): port /responses-specific transforms to interceptors

withStoreForcedFalse, withImageGenerationStripped,
withSafetyIdentifierStripped (dual-gated: flag + sourceApi !== responses),
withResponsesVisionHeader, withInlineImagesCompressed (responses variant).
```


## Task 7: Chat-Completions-only interceptors (batch)

3 个：cache markers / vision / inline-images。最简单的一个 batch。

**Files:**
- `chat-completions/with-cache-control-markers-attached.ts` + test — `attachCacheControlMarkers` (flag: `transform-attach-cache-control-markers`)
- `chat-completions/with-vision-header.ts` + test — `setChatCompletionsVisionHeader` (flag: `transform-vision-header`)
- `chat-completions/with-inline-images-compressed.ts` + test — `compressInlineImagesChatCompletions` (flag: `transform-compress-inline-images`)

Payload cast: `{ messages?: Array<{ role?: string; content?: unknown }> }`. 同 Task 5 模板。

- [ ] **Step 1: 3 个失败测试**
- [ ] **Step 2: 实现 → 通过 → typecheck → commit**

```
feat(providers): port /chat/completions-specific transforms to interceptors
```


## Task 8: 每个 endpoint 的 `index.ts` 注册表

把所有 interceptors 按 canonical 顺序拼成 readonly 数组。**关键**：`messagesCountTokensCopilotInterceptors` 复用 messages 的 payload-mutation interceptors（含 `withInlineImagesCompressed`），修 latent bug。

**Files:**
- Create: `src/providers/copilot/interceptors/messages/index.ts`
- Create: `src/providers/copilot/interceptors/responses/index.ts`
- Create: `src/providers/copilot/interceptors/chat-completions/index.ts`
- Create: `src/providers/copilot/interceptors/embeddings/index.ts`
- Test: `tests/interceptor-registries.test.ts`

**`messages/index.ts`** — 注意：`withVariantAndBetaFiltering` + `withInitiatorHeader` 不在这里（它们是工厂/shared，在 provider.ts 拼装时插入数组首部）。

```ts
// src/providers/copilot/interceptors/messages/index.ts
import type { CopilotInterceptor } from "~/providers/interceptor"
import { withClaudeAgentHeaders } from "./with-claude-agent-headers"
import { withCompactHeaders } from "./with-compact-headers"
import { withInteractionIdHeader } from "./with-interaction-id-header"
import { withMessagesVisionHeader } from "./with-vision-header"
import { withStructuredOutputFormatStripped } from "./with-structured-output-format-stripped"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"

/**
 * Canonical order mirrors the if-block sequence currently in
 * CopilotProvider.fetch(). DO NOT reorder without verifying the comment
 * in setCompactHeaders() about running AFTER initiator + claude-agent-headers.
 */
export const messagesPayloadInterceptors: readonly CopilotInterceptor[] = [
  withClaudeAgentHeaders,
  withCompactHeaders,
  withInteractionIdHeader,
  withMessagesVisionHeader,
  withStructuredOutputFormatStripped,
  withInlineImagesCompressed,
]
```

**`responses/index.ts`**:

```ts
import type { CopilotInterceptor } from "~/providers/interceptor"
import { withStoreForcedFalse } from "./with-store-forced-false"
import { withImageGenerationStripped } from "./with-image-generation-stripped"
import { withSafetyIdentifierStripped } from "./with-safety-identifier-stripped"
import { withResponsesVisionHeader } from "./with-vision-header"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"

export const responsesPayloadInterceptors: readonly CopilotInterceptor[] = [
  withStoreForcedFalse,
  withImageGenerationStripped,
  withSafetyIdentifierStripped,
  withResponsesVisionHeader,
  withInlineImagesCompressed,
]
```

**`chat-completions/index.ts`**:

```ts
import type { CopilotInterceptor } from "~/providers/interceptor"
import { withCacheControlMarkersAttached } from "./with-cache-control-markers-attached"
import { withChatCompletionsVisionHeader } from "./with-vision-header"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"

export const chatCompletionsPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCacheControlMarkersAttached,
  withChatCompletionsVisionHeader,
  withInlineImagesCompressed,
]
```

**`embeddings/index.ts`**:

```ts
import type { CopilotInterceptor } from "~/providers/interceptor"
/** Empty — embeddings has no payload-shape transforms, only variant filtering
 *  which CopilotProvider skips for this endpoint kind. */
export const embeddingsPayloadInterceptors: readonly CopilotInterceptor[] = []
```

- [ ] **Step 1: 写注册表完整性测试**

```ts
// tests/interceptor-registries.test.ts
import { describe, expect, test } from "bun:test"
import { messagesPayloadInterceptors } from "~/providers/copilot/interceptors/messages"
import { responsesPayloadInterceptors } from "~/providers/copilot/interceptors/responses"
import { chatCompletionsPayloadInterceptors } from "~/providers/copilot/interceptors/chat-completions"
import { embeddingsPayloadInterceptors } from "~/providers/copilot/interceptors/embeddings"

describe("Copilot interceptor registries", () => {
  test("messages registry has 6 entries in canonical order", () => {
    expect(messagesPayloadInterceptors).toHaveLength(6)
    expect(messagesPayloadInterceptors[0]!.name).toBe("withClaudeAgentHeaders")
    expect(messagesPayloadInterceptors[5]!.name).toBe("withInlineImagesCompressed")
  })
  test("responses registry has 5 entries", () => {
    expect(responsesPayloadInterceptors).toHaveLength(5)
  })
  test("chat_completions registry has 3 entries", () => {
    expect(chatCompletionsPayloadInterceptors).toHaveLength(3)
  })
  test("embeddings registry is empty (only variant filtering applies)", () => {
    expect(embeddingsPayloadInterceptors).toHaveLength(0)
  })
})
```

- [ ] **Step 2: failing → 创建 4 个 index.ts → 通过**

- [ ] **Step 3: typecheck + commit**

```
feat(providers): add per-endpoint Copilot interceptor registries

messagesPayloadInterceptors gets reused by count_tokens (Task 9), so
withInlineImagesCompressed will finally run there — fixes the latent
bug where count_tokens overestimates by the uncompressed image bytes.
```


## Task 9: `CopilotProvider.fetch()` collapse + count_tokens fix

最后一步：替换 14 个 if-blocks 为 `runInterceptors(...)` dispatch。

**Files:**
- Modify: `src/providers/copilot/provider.ts`
- New test: `tests/copilot-provider-interceptor-dispatch.test.ts` (integration)

**新 `fetch()` 主体（~30 行）**:

```ts
async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
  const path = COPILOT_PATHS[endpoint]
  if (!path) throw new Error(`CopilotProvider does not support endpoint: ${endpoint}`)

  const inv: Invocation = {
    endpoint,
    enabledFlags: opts.enabledFlags ?? defaultsForUpstream("copilot"),
    sourceApi: opts.sourceApi,
    payload: parseJsonBody(init.body),
    headers: mergeHeaders(init.headers, opts.extraHeaders),
  }
  const ctx: RequestContext = {
    requestStartedAt: Date.now(),
    downstreamAbortSignal: init.signal ?? undefined,
  }

  const interceptors = this.interceptorsFor(endpoint)
  const requireModel = opts.requireModel ?? (endpoint !== "messages_count_tokens")

  return runInterceptors(inv, ctx, interceptors, () =>
    callCopilotAPI({
      endpoint: path,
      payload: inv.payload,
      operationName: opts.operationName ?? `call ${endpoint}`,
      copilotToken: this.copilotToken,
      accountType: this.accountType,
      timeout: opts.timeout,
      extraHeaders: inv.headers,
      requireModel,
    }),
  )
}

private interceptorsFor(endpoint: EndpointKey): readonly CopilotInterceptor[] {
  // Cached as instance properties (built in constructor).
  switch (endpoint) {
    case "messages": return this.messagesChain
    case "messages_count_tokens": return this.messagesCountTokensChain
    case "responses": return this.responsesChain
    case "chat_completions": return this.chatCompletionsChain
    case "embeddings": return this.embeddingsChain
    default: return [] as const
  }
}
```

**Constructor 拼装链（vendor 私有 + payload registry 合并）**:

```ts
constructor(cfg: CopilotProviderConfig) {
  this.copilotToken = cfg.copilotToken
  this.accountType = cfg.accountType
  this.name = cfg.name ?? "copilot"

  const variantFiltering = createVariantAndBetaFilteringInterceptor(this.copilotToken, this.accountType)
  // Canonical order for endpoints that need both shared + payload interceptors:
  //   1. variant/beta filtering (rewrites model id — must run first so
  //      downstream interceptors see the canonical name)
  //   2. initiator header (uses payload shape unchanged by variant filter)
  //   3. payload-shape transforms
  this.messagesChain = [variantFiltering, withInitiatorHeader, ...messagesPayloadInterceptors]
  // count_tokens reuses the SAME payload interceptors — fixes latent bug
  // where compressInlineImages was missing here.
  this.messagesCountTokensChain = [variantFiltering, withInitiatorHeader, ...messagesPayloadInterceptors]
  this.responsesChain = [variantFiltering, withInitiatorHeader, ...responsesPayloadInterceptors]
  this.chatCompletionsChain = [variantFiltering, withInitiatorHeader, ...chatCompletionsPayloadInterceptors]
  // embeddings: skip variant filtering AND initiator (no conversation semantics).
  this.embeddingsChain = []
}
```

**Delete** from provider.ts:
- `applyVariantAndBetaFiltering` private method (now in shared/)
- `consumeReasoningEffortHeader`, `injectEffort`, `extractEffort`, `hasThinkingBudget`, `isAdaptiveThinking` (moved to shared/)
- `setInitiatorHeader` module function (now interceptor)
- All transform imports that only appear inside if-blocks (keep `parseJsonBody`, `mergeHeaders`)
- `VARIANT_KIND` constant (logic moved to shared/)

- [ ] **Step 1: 写集成测试 — 跑完整 fetch() 验证 14 个 transforms 仍然全部生效**

```ts
// tests/copilot-provider-interceptor-dispatch.test.ts
import { describe, expect, test, beforeEach } from "bun:test"
import { CopilotProvider } from "~/providers/copilot/provider"
import { initImageProcessor, createInMemoryImageProcessor } from "~/image"

beforeEach(() => initImageProcessor(createInMemoryImageProcessor()))

describe("CopilotProvider dispatch via interceptors", () => {
  test("messages: variant + initiator + claude-agent + compact + vision headers all set", async () => {
    const provider = new CopilotProvider({ copilotToken: "", accountType: "individual" })
    // Stub callCopilotAPI by monkey-patching fetch (or use existing mock pattern in repo)
    // Send a /v1/messages payload with image + metadata.user_id
    // Assert: x-initiator, copilot-vision-request, x-interaction-id, anthropic-beta filter
    // (Concrete assertions mirror what each per-interceptor test verifies — this
    //  test only proves they all run in one fetch() call.)
  })

  test("count_tokens: now runs compressInlineImagesMessages (regression for latent bug)", async () => {
    // Send payload with raw PNG; spy ImageProcessor records call; assert spy.calls > 0.
  })

  test("embeddings: skips variant filtering and initiator (chain is empty)", async () => {
    // Send embeddings payload; assert no x-initiator header set; assert model id untouched.
  })
})
```

参考现有测试拼 stub — 复用 `tests/copilot-provider.test.ts` 里既有的 callCopilotAPI mock pattern.

- [ ] **Step 2: 跑 failing 集成测试**

```
bun test tests/copilot-provider-interceptor-dispatch.test.ts
```
Expected: FAIL — 还没改 provider.ts

- [ ] **Step 3: 改 provider.ts**

按上面 fetch() / constructor / delete 清单改。

- [ ] **Step 4: 跑所有 provider 相关测试**

```
bun test tests/copilot-provider.test.ts tests/copilot-provider-interceptor-dispatch.test.ts tests/interceptor-*.test.ts tests/with-*-interceptor.test.ts
```
Expected: ALL PASS, including既有的 copilot-provider 测试 (零回归).

- [ ] **Step 5: 全量 typecheck + 全量测试**

```
bunx tsc --noEmit
bun test
```
Expected: 0 type errors, no regressions across the suite.

- [ ] **Step 6: commit**

```
git add src/providers/copilot/provider.ts tests/copilot-provider-interceptor-dispatch.test.ts
git commit -m "$(cat <<'MSG'
refactor(providers): dispatch CopilotProvider.fetch via runInterceptors

Collapses 14 inline if-blocks into a Koa-style chain. Each former
if-block is now a self-contained interceptor with its own unit test
under tests/with-*-interceptor.test.ts.

Two behavior changes (intentional):
  - /v1/messages/count_tokens now runs the same payload interceptors as
    /v1/messages, including compressInlineImagesMessages. Previously
    count_tokens skipped image compression, causing token estimates to
    overshoot wire bytes for any client sending raw PNG/JPEG inline.
  - The chain composition is now testable in isolation (registries) and
    response-side wrapping (e.g. context-window error rewrite) can plug
    in without ad-hoc try/catch in fetch().

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```


## Task 10: 自检 + 收尾

- [ ] **Step 1: 跑全量测试**

```
bun test
```
Expected: 全绿，count_tokens 相关测试如果有 image-size 断言可能需要更新（latent bug 修复后估算值会变小）。

- [ ] **Step 2: 全量 typecheck**

```
bunx tsc --noEmit
```

- [ ] **Step 3: grep 验证 provider.ts 已无残留 if-block 模式**

```
grep -c "flags.has\|enabledFlags.has" src/providers/copilot/provider.ts
```
Expected: 0

- [ ] **Step 4: 行数对照**

```
wc -l src/providers/copilot/provider.ts
```
Expected: 从原 ~397 行降到 ~120 行左右（仅 class 骨架 + parseJsonBody/mergeHeaders）。

- [ ] **Step 5: 更新 backlog #64 状态为 completed**

在 `docs/backlog/2025-q2-backlog.md`（或当前 backlog 文件）把 #64 勾掉，引用 commits.

- [ ] **Step 6: PR description 草稿**

包含：
- Before/After 行数对照
- 14 个 if-block → 14 个 interceptor 的 1:1 映射表
- count_tokens latent bug fix 说明
- Future hook：response-side wrapping (context-window error rewrite) 现在可以直接挂链上

---

## File-by-file Migration Map (1:1 verification)

| 原 provider.ts 行号 | 原 if-block | 新 interceptor 文件 |
|---|---|---|
| L110-113 | `applyVariantAndBetaFiltering` | `shared/with-variant-and-beta-filtering.ts` |
| L115-117 | `setInitiatorHeader` | `shared/with-initiator-header.ts` |
| L120 | `setClaudeAgentHeaders` | `messages/with-claude-agent-headers.ts` |
| L125 | `setCompactHeaders` | `messages/with-compact-headers.ts` |
| L129-131 | `setInteractionIdHeader` | `messages/with-interaction-id-header.ts` |
| L135-137 | `setMessagesVisionHeader` | `messages/with-vision-header.ts` |
| L140-142 | `stripStructuredOutputFormat` | `messages/with-structured-output-format-stripped.ts` |
| L146-148 | `compressInlineImagesMessages` | `messages/with-inline-images-compressed.ts` |
| L156-158 | `forceStoreFalse` | `responses/with-store-forced-false.ts` |
| L161-163 | `stripImageGeneration` | `responses/with-image-generation-stripped.ts` |
| L168-171 | `stripSafetyIdentifier` | `responses/with-safety-identifier-stripped.ts` |
| L173-175 | `setResponsesVisionHeader` | `responses/with-vision-header.ts` |
| L178-180 | `compressInlineImagesResponses` | `responses/with-inline-images-compressed.ts` |
| L188-190 | `attachCacheControlMarkers` | `chat-completions/with-cache-control-markers-attached.ts` |
| L192-194 | `setChatCompletionsVisionHeader` | `chat-completions/with-vision-header.ts` |
| L196-198 | `compressInlineImagesChatCompletions` | `chat-completions/with-inline-images-compressed.ts` |

16 行 → 16 个 interceptor 文件（14 个 transform-gated + 2 个 always-on：claude-agent-headers, compact-headers）.
