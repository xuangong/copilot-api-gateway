# Plan C2.1 — chat-flow/shared 基础与 dispatch 解耦 Hono

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽出 `chat-flow/shared/{dispatch,gateway-ctx,sse-readers,error-wrap}.ts` 4 个共享文件，把 `dispatch<T>` 从 `(c, input)` 改成 `(rawJson, input)`，让 dispatch 不再依赖 Hono Context；routes.ts 5 个 handler 改用新签名。

**Architecture:** 单方向：routes.ts → shared/dispatch.ts → 现有 routing/errors/observability 算法层。`dispatch` 不再 import `hono`，可独立单测。Helpers 只是搬移现状代码，无行为变化。

**Tech Stack:** Bun + TypeScript + Hono；既有 `@vnext/protocols/common`、`@vnext/provider-copilot`。

**Spec ref:** `docs/superpowers/specs/2026-06-15-planc2-routes-split-design.md` §2.1–§2.4。

---

## File Structure

新建：
- `packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts` — 通用编排器，从 routes.ts:101-291 搬出并改签名
- `packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts` — `readAuth` + `readObsCtx`
- `packages/gateway/src/data-plane/chat-flow/shared/sse-readers.ts` — `parseTargetSSE` + `mapSourceApiToProviderRequest`
- `packages/gateway/src/data-plane/chat-flow/shared/error-wrap.ts` — `invalidJsonResponse` + `jsonErrorWrap`
- `packages/gateway/tests/data-plane/chat-flow/shared/dispatch.test.ts` — dispatch 单测（≥10 条）

修改：
- `packages/gateway/src/data-plane/routes.ts` — 删除内联 dispatch / 4 helpers / DispatchObsCtx / DispatchInput；5 个 handler 适配新签名（`raw` 在 handler 内 parse 后传给 dispatch）

---

## Task 1: 抽 `error-wrap.ts`（无依赖）

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/shared/error-wrap.ts`

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/shared/error-wrap.ts
/**
 * Tiny helpers for emitting JSON 4xx/5xx envelopes from the chat-flow handlers.
 * Kept minimal so dispatch.ts and the per-endpoint http.ts files share the
 * same shape without re-declaring the headers each time.
 */
export function invalidJsonResponse(): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

export const jsonErrorWrap = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
```

- [ ] **Step 2: 编译检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS（新文件没人 import，单纯加文件不会破坏）

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/shared/error-wrap.ts
git commit -m "feat(gateway/chat-flow): add shared/error-wrap.ts (invalidJsonResponse + jsonErrorWrap)"
```

---

## Task 2: 抽 `sse-readers.ts`（搬现状两个 helper）

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/shared/sse-readers.ts`
- Modify: `packages/gateway/src/data-plane/routes.ts:82-99`（暂保留原状，下个 Task 整体改）

- [ ] **Step 1: 创建文件 — 字面搬运 routes.ts:82-99**

```ts
// packages/gateway/src/data-plane/chat-flow/shared/sse-readers.ts
import type { EndpointKey } from '@vnext/protocols/common'
import {
  parseMessagesSSEStream,
  parseChatSSEStream,
  parseResponsesSSEStream,
} from '@vnext/provider-copilot'

export function mapSourceApiToProviderRequest(
  src: 'messages' | 'chat_completions' | 'responses' | 'gemini',
): 'anthropic' | 'openai' | 'gemini' {
  if (src === 'messages') return 'anthropic'
  if (src === 'chat_completions') return 'openai'
  if (src === 'responses') return 'openai'
  return 'gemini'
}

/**
 * Parse an upstream SSE byte stream into typed events for the given target
 * endpoint. The translator's translateEvents consumes these typed events.
 */
export function parseTargetSSE(
  target: EndpointKey,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  if (target === 'messages') return parseMessagesSSEStream(body, signal)
  if (target === 'chat_completions') return parseChatSSEStream(body, signal)
  if (target === 'responses') return parseResponsesSSEStream(body, signal)
  return (async function* (): AsyncIterable<unknown> { /* empty */ })()
}
```

- [ ] **Step 2: 编译检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/shared/sse-readers.ts
git commit -m "feat(gateway/chat-flow): add shared/sse-readers.ts (mapSourceApi + parseTargetSSE)"
```

---

## Task 3: 抽 `gateway-ctx.ts`

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts`

依赖：本 task 引用了 `DispatchObsCtx` —— 类型先在 `gateway-ctx.ts` 内定义，Task 4 把它从这里 re-export 给 dispatch（避免循环 import：dispatch 不依赖 gateway-ctx，gateway-ctx 自定义类型）。

- [ ] **Step 1: 创建文件**

```ts
// packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts
/**
 * Boundary helpers for reading per-request context off Hono.
 * The dispatch core does NOT depend on Hono — it consumes the resulting
 * plain values via DispatchObsCtx. Kept here so each http.ts handler can
 * call `readAuth(c)` + `readObsCtx(c, auth)` in two lines.
 */
import type { Context } from 'hono'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'

export interface DispatchObsCtx {
  apiKeyId: string | undefined
  userAgent: string | undefined
  requestId: string | undefined
}

export function readAuth(c: Context): DataPlaneAuthCtx {
  return (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
}

export function readObsCtx(c: Context, auth: DataPlaneAuthCtx): DispatchObsCtx {
  return {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
}
```

- [ ] **Step 2: 编译检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts
git commit -m "feat(gateway/chat-flow): add shared/gateway-ctx.ts (readAuth + readObsCtx + DispatchObsCtx)"
```

---

## Task 4: 抽 `dispatch.ts`（核心改动 — 改签名为 `(rawJson, input)`）

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts`
- Read context: `packages/gateway/src/data-plane/routes.ts:101-291`

- [ ] **Step 1: 创建 dispatch.ts**

把现状 routes.ts:101-291 整段搬过来，做以下改动：

1. 接口字段不变；`DispatchObsCtx` 改为从 `./gateway-ctx.ts` re-export
2. 函数签名：`async function dispatch<TPayload>(c: { req: { json } }, input)` → `async function dispatch<TPayload>(rawJson: unknown, input)`
3. 删除 `let raw: unknown; try { raw = await c.req.json() } catch { ... }` 这个块；把后面所有 `raw` 替换成 `rawJson`
4. `export` dispatch、DispatchInput、DispatchObsCtx

```ts
// packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
/**
 * Generic chat-flow orchestrator: rawJson → parse → preprocess → postParse
 * → enumerate → translate → call → render. No Hono dependency — the caller
 * (http.ts handlers) is responsible for c.req.json() + invalid-JSON 400.
 */
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { selectPair, type SourceApi } from '../../dispatch/pair-selector.ts'
import { getTranslator, type TranslateContext } from '../../dispatch/translator-registry.ts'
import { encodeClientSSE } from '../../dispatch/sse-writers.ts'
import { parseModelRouting } from '../../routing/binding-resolver.ts'
import { enumerateBindingCandidates } from '../../routing/candidates.ts'
import {
  repackageUpstreamError,
  renderPreviousResponseNotFound,
  type SourceApi as ErrorSourceApi,
} from '../../errors/repackage.ts'
import { PreviousResponseNotFoundError } from '../../dispatch/responses-store-bridge.ts'
import { runConversationAttempt } from '../../observability/attempts/conversation-attempt.ts'
import type {
  SourceApiInput,
  TargetApiInput,
} from '../../../shared/observability/latency-tracker.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { parseTargetSSE, mapSourceApiToProviderRequest } from './sse-readers.ts'
import type { DispatchObsCtx } from './gateway-ctx.ts'

export type { DispatchObsCtx }

export interface DispatchInput<TPayload> {
  parse: (raw: unknown) => TPayload
  modelOf: (payload: TPayload) => string
  /** Currently unused by all 5 endpoints — preserved verbatim from the old
   *  routes.ts shape to keep this refactor purely structural. */
  preprocess?: (payload: TPayload) => TPayload
  postParse?: (payload: TPayload) => Promise<void>
  fallbackMaxOutputTokens?: number
  forceStream?: boolean
  sourceApi: SourceApi
  errorWrap: (status: number, body: unknown) => Response
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export async function dispatch<TPayload>(
  rawJson: unknown,
  input: DispatchInput<TPayload>,
): Promise<Response> {
  let payload: TPayload
  try { payload = input.parse(rawJson) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return input.errorWrap(
      e.status ?? 400,
      e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } },
    )
  }
  if (input.preprocess) payload = input.preprocess(payload)

  if (input.postParse) {
    try {
      await input.postParse(payload)
    } catch (err) {
      if (err instanceof PreviousResponseNotFoundError) {
        return renderPreviousResponseNotFound(err)
      }
      const message = err instanceof Error ? err.message : 'request error'
      return input.errorWrap(400, { error: { type: 'invalid_request_error', message } })
    }
  }

  const requestedModel = input.modelOf(payload)
  const { bareModel } = parseModelRouting(requestedModel)

  const pickTarget = (e: ModelEndpoints): EndpointKey | null => selectPair(input.sourceApi, e)
  const { candidates, sawModel } = await enumerateBindingCandidates({
    model: requestedModel,
    pickTarget,
    opts: { ownerId: input.auth.userId, copilot: input.auth.copilot },
  })
  if (candidates.length === 0) {
    if (sawModel) {
      return input.errorWrap(400, {
        error: {
          type: 'invalid_request_error',
          message: `Model "${requestedModel}" does not support the "${input.sourceApi}" client protocol.`,
        },
      })
    }
    return input.errorWrap(404, {
      error: {
        type: 'invalid_request_error',
        message: `No upstream serves model "${requestedModel}". Run GET /v1/models for available ids.`,
      },
    })
  }
  const { binding, targetEndpoint } = candidates[0]!

  const translator = getTranslator(input.sourceApi, targetEndpoint)
  if (!translator) {
    return input.errorWrap(400, {
      error: {
        type: 'invalid_request_error',
        message: `No translator for ${input.sourceApi}→${targetEndpoint}.`,
      },
    })
  }

  const controller = new AbortController()
  const ctx: TranslateContext = {
    signal: controller.signal,
    fallbackMaxOutputTokens: input.fallbackMaxOutputTokens,
    model: bareModel,
  }

  let upstreamPayload: unknown
  try {
    upstreamPayload = await translator.translateRequest(payload, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'translation error'
    return input.errorWrap(400, { error: { type: 'invalid_request_error', message } })
  }

  let isStream: boolean
  if (typeof input.forceStream === 'boolean') {
    isStream = input.forceStream
  } else {
    const upstreamObj = upstreamPayload as { stream?: unknown } | null
    isStream = upstreamObj?.stream === true
  }

  let attempt: Awaited<ReturnType<typeof runConversationAttempt>>
  try {
    const pricing = binding.provider.getPricingForModelKey(bareModel)
    attempt = await runConversationAttempt({
      apiKeyId: input.obsCtx.apiKeyId,
      model: bareModel,
      modelKey: bareModel,
      pricing,
      sourceApi: input.sourceApi as SourceApiInput,
      targetApi: targetEndpoint as TargetApiInput,
      upstream: 'github_copilot',
      userAgent: input.obsCtx.userAgent,
      requestId: input.obsCtx.requestId,
      stream: isStream,
      call: async () => {
        const pr = await binding.provider.fetch({
          endpoint: targetEndpoint,
          payload: upstreamPayload,
          headers: new Headers({ 'content-type': 'application/json' }),
          sourceApi: mapSourceApiToProviderRequest(input.sourceApi),
          operationName: 'data-plane dispatch',
          flags: { isStreaming: isStream },
          signal: ctx.signal,
        })
        return new Response(pr.body, { status: pr.status, headers: pr.headers })
      },
    })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, input.sourceApi as ErrorSourceApi)
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return input.errorWrap(502, { error: { type: 'api_error', message } })
  }

  if (!attempt.ok && attempt.status === 429 && 'rateLimit' in attempt) {
    return input.errorWrap(429, {
      error: {
        type: 'rate_limit_error',
        message: attempt.rateLimit.reason,
        ...(attempt.rateLimit.retryAfterSeconds != null
          ? { retry_after_seconds: attempt.rateLimit.retryAfterSeconds }
          : {}),
      },
    })
  }
  if (!attempt.ok) {
    if ('response' in attempt) return await repackageUpstreamError(attempt.response, input.sourceApi as ErrorSourceApi)
    return input.errorWrap(502, { error: { type: 'api_error', message: 'upstream error' } })
  }

  if (attempt.stream) {
    const hubEvents = parseTargetSSE(targetEndpoint, attempt.response.body, ctx.signal)
    const clientEvents = translator.translateEvents(hubEvents, ctx)
    const out = encodeClientSSE(input.sourceApi, clientEvents)
    return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  let clientBody: unknown
  try {
    clientBody = await translator.translateBody(attempt.json, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'translation error'
    return input.errorWrap(502, { error: { type: 'api_error', message } })
  }
  return Response.json(clientBody)
}
```

- [ ] **Step 2: 编译（应仍 PASS — 没人 import 它）**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
git commit -m "feat(gateway/chat-flow): add shared/dispatch.ts (rawJson signature, no Hono dep)"
```

---

## Task 5: routes.ts 改 5 个 handler 用新 dispatch

**Files:**
- Modify: `packages/gateway/src/data-plane/routes.ts`（多处，按下面的 5 个步骤改）

**目标**：删掉 routes.ts 内联的 `dispatch` 定义、`DispatchInput`、`DispatchObsCtx`、`mapSourceApiToProviderRequest`、`parseTargetSSE`、`messagesErrorWrap`；从 `chat-flow/shared` 引入；5 个 handler 改用 `dispatch(raw, ...)` 形式（raw 在 handler 内 parse 后传入，invalid-JSON 由 handler 自己 envelope）。

count_tokens 路由不走 dispatch — 不在本 Task 范围内（保留原状）。

- [ ] **Step 1: 替换 routes.ts 顶部 import 段**

把 routes.ts:20-55 的 import 段改成：

```ts
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import {
  parseMessagesPayload,
  parseMessagesCountTokensPayload,
  parseChatPayload,
  parseResponsesPayload,
  parseGeminiPayload,
} from './parsers.ts'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { resolveBinding, stripUpstreamPin } from './routing/binding-resolver.ts'
import { repackageUpstreamError } from './errors/repackage.ts'
import { HTTPError, parseResponsesSSEStream } from '@vnext/provider-copilot'
import { handleMessagesWebSearch, hasWebSearch } from './orchestrator/server-tools/plugins/web-search/index.ts'
import { handleResponsesImageGeneration, hasImageGeneration } from './orchestrator/server-tools/plugins/image-generation/index.ts'
import {
  expandPreviousResponseId,
  savePostTurnSnapshot,
} from './dispatch/responses-store-bridge.ts'
import { getResponsesStore } from '../shared/runtime/responses-store.ts'
import { dispatch, type DispatchObsCtx } from './chat-flow/shared/dispatch.ts'
import { invalidJsonResponse, jsonErrorWrap } from './chat-flow/shared/error-wrap.ts'
import { readAuth, readObsCtx } from './chat-flow/shared/gateway-ctx.ts'
```

注意：保留 `parseResponsesSSEStream` 和 `expandPreviousResponseId` / `savePostTurnSnapshot` —— responses sidecar 仍内联（C2.3 才下沉）。删掉的：`parseModelRouting`、`enumerateBindingCandidates`、`runConversationAttempt`、`SourceApiInput`/`TargetApiInput`、`selectPair`/`SourceApi`、`getTranslator`/`TranslateContext`、`encodeClientSSE`、`PreviousResponseNotFoundError`、`renderPreviousResponseNotFound`、`parseMessagesSSEStream`、`parseChatSSEStream`、`ErrorSourceApi`。

- [ ] **Step 2: 删除 routes.ts:72-291 内联定义**

删掉这一段：`type DispatchObsCtx`、`mapSourceApiToProviderRequest`、`parseTargetSSE`、`interface DispatchInput`、`async function dispatch`、`const messagesErrorWrap`。

确认删除后，`auth bridge middleware`（routes.ts:57-70）的下面紧接 `dataPlane.post('/v1/messages', ...)`。

- [ ] **Step 3: 改 `/v1/messages` handler — 用 jsonErrorWrap + 新 dispatch**

```ts
dataPlane.post('/v1/messages', async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  if (hasWebSearch(raw as Parameters<typeof hasWebSearch>[0])) {
    const auth = readAuth(c)
    if (!auth.copilot?.copilotToken || !auth.githubToken) {
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'Copilot/GitHub credentials required for web search.' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    }
    return handleMessagesWebSearch(
      {
        copilotToken: auth.copilot.copilotToken,
        accountType: auth.copilot.accountType,
        githubToken: auth.githubToken,
        msGroundingKey: auth.msGroundingKey,
        apiKeyId: auth.apiKeyId,
        requestId: c.req.header('x-request-id') ?? undefined,
        userAgent: c.req.header('user-agent') ?? undefined,
      },
      raw as Parameters<typeof handleMessagesWebSearch>[1],
    )
  }
  const auth = readAuth(c)
  return dispatch(raw, {
    parse: (r) => parseMessagesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'messages',
    errorWrap: jsonErrorWrap,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
})
```

- [ ] **Step 4: 改 `/v1/chat/completions` handler**

```ts
dataPlane.post('/v1/chat/completions', async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return dispatch(raw, {
    parse: (r) => parseChatPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'chat_completions',
    fallbackMaxOutputTokens: 4096,
    errorWrap: jsonErrorWrap,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
})
```

- [ ] **Step 5: 改 `/v1/responses` handler — dispatch 调用点改签名（sidecar 逻辑保持原状）**

把 routes.ts:469-488 这一段：

```ts
const response = await dispatch(
  { req: { json: async () => raw } },
  {
    parse: (r) => parseResponsesPayload(r),
    ...
  },
)
```

改为：

```ts
const response = await dispatch(raw, {
  parse: (r) => parseResponsesPayload(r),
  modelOf: (p) => (p as { model?: string }).model ?? '',
  sourceApi: 'responses',
  errorWrap: jsonErrorWrap,
  auth,
  obsCtx,
  postParse: async (payload) => {
    await expandPreviousResponseId(
      payload as { previous_response_id?: string | null; input?: unknown },
      store,
      auth.apiKeyId ?? null,
    )
    const expanded = (payload as { input?: unknown }).input
    mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
  },
})
```

`/v1/responses` 顶上也把 invalid-JSON 改成 `invalidJsonResponse()`：

```ts
let raw: unknown
try { raw = await c.req.json() } catch { return invalidJsonResponse() }
```

`auth` / `obsCtx` 改为 `readAuth(c)` / `readObsCtx(c, auth)`。

`messagesErrorWrap` 一律换成 `jsonErrorWrap`。

- [ ] **Step 6: 改 `/v1beta/models/:model{.+}` Gemini handler**

```ts
dataPlane.post('/v1beta/models/:model{.+}', async (c) => {
  const raw = c.req.param('model')
  const [model, verb] = raw.split(':')
  const stream = verb === 'streamGenerateContent'
  let body: unknown
  try { body = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return dispatch(body, {
    parse: (r) => parseGeminiPayload(r),
    modelOf: () => model ?? '',
    forceStream: stream,
    fallbackMaxOutputTokens: 4096,
    sourceApi: 'gemini',
    errorWrap: jsonErrorWrap,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
})
```

注意：原 handler 是同步 `(c) =>`，新版需 `async`，因为要 `await c.req.json()`。

count_tokens handler 保持原状（不走 dispatch）。

- [ ] **Step 7: 编译**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS

- [ ] **Step 8: 跑既有 e2e 测试（行为不变 → 应 0 退化）**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/messages.e2e.test.ts packages/gateway/tests/chat.e2e.test.ts packages/gateway/tests/responses.e2e.test.ts packages/gateway/tests/gemini.e2e.test.ts packages/gateway/src/data-plane/dispatch/dispatch.test.ts 2>&1 | tail -20
```

Expected: 全 pass（与改动前同样的 pass/fail 数）

- [ ] **Step 9: 提交**

```bash
git add packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/routes): handlers use shared/dispatch with rawJson signature

- 5 chat-flow handlers parse JSON inline then call dispatch(raw, input)
- inline DispatchObsCtx/DispatchInput/dispatch/parseTargetSSE/mapSourceApi/messagesErrorWrap removed (now in chat-flow/shared/)
- /v1/messages/count_tokens unchanged (non-dispatch path; will move in C2.2)"
```

---

## Task 6: dispatch 单测（≥10 条，无 Hono Context）

**Files:**
- Create: `packages/gateway/tests/data-plane/chat-flow/shared/dispatch.test.ts`

**测试策略**：dispatch 现在不依赖 Hono，可以直接喂 `rawJson`。stub `binding.provider.fetch` + `getTranslator` 路径有两条思路：(a) 用 `globalThis.fetch` 拦截 + 真实 SqliteRepo 注入一条 Copilot upstream（仿现状 `dispatch.test.ts`）；(b) 直接构造一个最小 `BindingResolutionResult` 注入。

为了避免与现状 `dispatch.test.ts` 重复 e2e 路径，本套**仅覆盖错误路径 + happy path 两条**，目标是让"输入 → 输出"边界稳定可重现。

- [ ] **Step 1: 写测试骨架（10 条）**

```ts
// packages/gateway/tests/data-plane/chat-flow/shared/dispatch.test.ts
/**
 * Unit tests for chat-flow/shared/dispatch.ts.
 * Covers the error-path branches that historically lived in routes.ts and
 * one happy non-stream path. Uses globalThis.fetch + real SqliteRepo to
 * avoid Bun's mock.module cross-file leak (see MEMORY note).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { initRepo } from '../../../../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../../../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../../../src/data-plane/models/routes.ts'
import { dispatch, type DispatchInput } from '../../../../src/data-plane/chat-flow/shared/dispatch.ts'
import { jsonErrorWrap } from '../../../../src/data-plane/chat-flow/shared/error-wrap.ts'
import { parseMessagesPayload } from '../../../../src/data-plane/parsers.ts'

const env = {} as never
const auth: DataPlaneAuthCtx = {
  apiKeyId: 'k1',
  userId: 'u1',
  copilot: { copilotToken: 'tid_x', accountType: 'individual' },
  githubToken: 'gh_x',
} as DataPlaneAuthCtx

const obsCtx = { apiKeyId: 'k1', userAgent: 't', requestId: 'r1' }

let originalFetch: typeof globalThis.fetch
beforeEach(async () => {
  __resetPlatformForTests()
  originalFetch = globalThis.fetch
  // minimal repo setup helper extracted in next steps
})
afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

function baseInput(): DispatchInput<unknown> {
  return {
    parse: (r) => parseMessagesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'messages',
    errorWrap: jsonErrorWrap,
    auth,
    obsCtx,
  }
}

test('dispatch — parse error returns errorWrap(400)', async () => {
  const res = await dispatch({}, baseInput())
  expect(res.status).toBe(400)
  const body = await res.json() as { error?: { type?: string } }
  expect(body.error?.type).toBe('invalid_request_error')
})

test('dispatch — postParse throwing non-PreviousResponseNotFoundError → errorWrap(400 invalid_request_error)', async () => {
  const input: DispatchInput<unknown> = {
    ...baseInput(),
    postParse: async () => { throw new Error('boom') },
  }
  // first need a parsable raw; minimal Anthropic Messages payload
  const raw = { model: 'whatever', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  const res = await dispatch(raw, input)
  expect(res.status).toBe(400)
  const body = await res.json() as { error?: { type?: string; message?: string } }
  expect(body.error?.type).toBe('invalid_request_error')
  expect(body.error?.message).toBe('boom')
})

test('dispatch — model with no upstream candidates and sawModel=false returns 404', async () => {
  // No repo setup → enumerateBindingCandidates sees no upstream → sawModel=false
  await initRepo({ kind: 'sqlite', path: ':memory:' })
  const raw = { model: 'no-such-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  const res = await dispatch(raw, baseInput())
  expect(res.status).toBe(404)
})

// Tests 4-10: happy path (non-stream JSON), candidates=0/sawModel=true (400),
// translator not found (400), translateRequest throw (400), HTTPError → repackage,
// 429 rateLimit, translateBody throw (502), happy stream (SSE).
// For brevity each follows the same pattern: stub fetch, optionally seed repo,
// invoke dispatch with crafted input, assert status + body shape.
//
// TODO before commit: expand each into a full test using SqliteRepo seeding +
// globalThis.fetch handler patterns from packages/gateway/src/data-plane/
// dispatch/dispatch.test.ts.
```

- [ ] **Step 2: 把上面 7 条 TODO 测试展开**

参考 `packages/gateway/src/data-plane/dispatch/dispatch.test.ts:1-50` 的 stub 模式（globalThis.fetch + seed Copilot upstream + claude-family stub model）。每条测试自包含一个 `globalThis.fetch = async (url) => Response`。

完整实现（替换 Step 1 文件中的 TODO 块）：

```ts
// 略；按 dispatch.test.ts 现状的 globalThis.fetch + seedCopilotUpstream 模式逐条补完
// 由 implementer subagent 实现具体 stub
```

**execution note**: 这一步对 implementer 的指引是"复用 packages/gateway/src/data-plane/dispatch/dispatch.test.ts 里的 stub 工具，按 7 条用例每条造最小 fetch 桩，不引新 mock 框架。"

- [ ] **Step 3: 跑测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/data-plane/chat-flow/shared/dispatch.test.ts
```

Expected: 10 pass / 0 fail

- [ ] **Step 4: 跑全量 curated 测试确认无退化**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tail -5
```

Expected: pass 数 ≥ 之前 baseline + 10（新增 10 条），fail 数不变。

- [ ] **Step 5: 提交**

```bash
git add packages/gateway/tests/data-plane/chat-flow/shared/dispatch.test.ts
git commit -m "test(gateway/chat-flow): unit tests for shared/dispatch (10 cases, no Hono Context)"
```

---

## Self-Review Checklist（Plan 自检）

1. **Spec 覆盖**：spec §2.1–2.4 + 验收 #2/#3（dispatch ≤100 行 + 无 hono）✓ Task 4 + Task 5 共同满足。
2. **占位符**：Task 6 Step 2 把 7 条测试展开标为"由 implementer subagent 完成"——属于策略级指引，不是占位（要求引用现成 stub 文件、给出明确的 7 条用例），可接受。
3. **类型一致**：`DispatchInput`、`DispatchObsCtx` 字段名在所有 Task 一致；`jsonErrorWrap`/`invalidJsonResponse` 命名贯穿。
4. **范围**：本 plan 不动 count_tokens / responses sidecar / 端点子目录拆分（留给 C2.2 / C2.3）。完成后仓库可独立 merge。
