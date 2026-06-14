# Plan C2 — `routes.ts` 拆分（端点目录 + http/serve 二分）

## Goal

把 `packages/gateway/src/data-plane/routes.ts`（618 行，承载 5 个 chat-flow 路由 + dispatch 编排 + sidecar）拆成可独立理解、可独立测试的小单元。每个路由按"端点目录 + http.ts/serve.ts 二分"组织：`http.ts` 负责 Hono 边界，`serve.ts` 是与 Hono 解耦的核心逻辑。`dispatch<T>` 通用编排器抽到 `chat-flow/shared/dispatch.ts`，签名改为 `(rawJson, input) => Response`，不再依赖 Hono Context，从而可独立单测。

## Background

现状 `routes.ts` 一个文件 618 行，包含：
- 入口与中间件 mount（lines 57-70）
- 两个 helper（`mapSourceApiToProviderRequest`、`parseTargetSSE`，lines 82-99）
- `DispatchInput<TPayload>` 接口（lines 101-127）
- `dispatch<T>` 通用编排（lines 129-291）
- `/v1/messages` handler + web-search 短路（lines 296-345）
- `/v1/messages/count_tokens` handler（独立路径，不走 dispatch；lines 347-410）
- `/v1/chat/completions` handler（lines 412-430）
- `/v1/responses` handler + image-generation 短路 + sidecar tee/clone + `waitUntil`（lines 432-593）
- `/v1beta/models/:model{.+}` Gemini handler（lines 595-618）

新增端点 / 修 sidecar / 改路由策略，都要在这个 600+ 行的文件里来回滚动。dispatch 编排和 Hono Context 紧耦合（`(c, input) => Response`），无法脱离 Hono 单测。Sidecar 闭包 `mergedInputItems` 跨 dispatch 边界以闭包捕获方式传递，对读者不显式。

参考项目（`copilot-gateway`，floway-dev）的 `data-plane/llm/` 采用"端点目录 + http/serve 二分"结构（`messages/{http.ts, serve.ts, attempt.ts, ...}`），与 vNext 当前架构最接近，且证明了该模式在 monorepo + Hono + pairwise translate 场景下成熟可用。本 spec 借鉴该模式。

## Non-Goals

- 不拆 `dispatch<T>` 编排为多个阶段函数（参考项目也没拆，5 阶段拆分被评估为过度工程）。
- 不动 `routing/`、`errors/`、`dispatch/`（pair-selector / translator-registry / sse-writers / responses-store-bridge）、`observability/`、`orchestrator/server-tools/plugins/` 这些已经独立的模块。
- 不动 5 个端点的对外行为（URL、状态码、wire shape 全部保持不变）。
- 不动 `models/`、`embeddings/`、`images/` 子路由（已在自己的目录里）。
- 不引入新的中间件机制 / Pipeline 抽象。

## Design

### 1. 目录结构

```
data-plane/
├── routes.ts                              # ~35 行：Hono mount + auth bridge
├── chat-flow/
│   ├── messages/
│   │   ├── http.ts                        # Hono handler（边界）
│   │   ├── serve.ts                       # 纯逻辑（无 Hono import）
│   │   └── web-search-shortcut.ts
│   ├── chat-completions/
│   │   ├── http.ts
│   │   └── serve.ts
│   ├── responses/
│   │   ├── http.ts                        # 含 sidecar 触发（waitUntil）
│   │   ├── serve.ts                       # 含 postParse 钩子
│   │   ├── snapshot-sidecar.ts            # tee/clone + parseSSE + savePostTurnSnapshot
│   │   └── image-generation-shortcut.ts
│   ├── gemini/
│   │   ├── http.ts                        # URL verb 解码
│   │   └── serve.ts
│   ├── count-tokens/
│   │   ├── http.ts
│   │   └── serve.ts                       # 独立路径（不调 dispatch）
│   └── shared/
│       ├── dispatch.ts                    # 通用 dispatch<T> 编排器
│       ├── gateway-ctx.ts                 # readAuth + readObsCtx
│       ├── sse-readers.ts                 # parseTargetSSE + mapSourceApiToProviderRequest
│       └── error-wrap.ts                  # invalidJsonResponse + jsonErrorWrap
└── (现有 routing/, errors/, dispatch/, observability/, orchestrator/, models/, embeddings/, images/ 原位不动)
```

### 2. 关键文件契约

#### 2.1 `chat-flow/shared/dispatch.ts`（~80 行）

```ts
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { selectPair, type SourceApi } from '../../dispatch/pair-selector.ts'
import { getTranslator, type TranslateContext } from '../../dispatch/translator-registry.ts'
import { encodeClientSSE } from '../../dispatch/sse-writers.ts'
import { parseModelRouting } from '../../routing/binding-resolver.ts'
import { enumerateBindingCandidates } from '../../routing/candidates.ts'
import { repackageUpstreamError, renderPreviousResponseNotFound, type SourceApi as ErrorSourceApi } from '../../errors/repackage.ts'
import { PreviousResponseNotFoundError } from '../../dispatch/responses-store-bridge.ts'
import { runConversationAttempt } from '../../observability/attempts/conversation-attempt.ts'
import type { SourceApiInput, TargetApiInput } from '../../../shared/observability/latency-tracker.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { parseTargetSSE, mapSourceApiToProviderRequest } from './sse-readers.ts'

export interface DispatchObsCtx {
  apiKeyId: string | undefined
  userAgent: string | undefined
  requestId: string | undefined
}

export interface DispatchInput<TPayload> {
  parse: (raw: unknown) => TPayload
  modelOf: (payload: TPayload) => string
  preprocess?: (payload: TPayload) => TPayload
  postParse?: (payload: TPayload) => Promise<void>
  fallbackMaxOutputTokens?: number
  forceStream?: boolean
  sourceApi: SourceApi
  errorWrap: (status: number, body: unknown) => Response
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

/**
 * 通用 chat-flow 编排器：rawJson → parse → preprocess → postParse → enumerate
 * → translate → call → render。无 Hono 依赖，可独立单测。
 *
 * 调用方负责把 `c.req.json()` 的结果（或 invalid JSON 的 400）传进来。
 */
export async function dispatch<TPayload>(
  rawJson: unknown,
  input: DispatchInput<TPayload>,
): Promise<Response>
```

**关键签名变更**：从原 `dispatch(c, input)` 改为 `dispatch(rawJson, input)`。`c.req.json()` 在 `http.ts` 里完成；invalid-JSON 的 400 由 `http.ts` 直接构造（共享 helper）。

#### 2.2 `chat-flow/shared/gateway-ctx.ts`（~15 行）

```ts
import type { Context } from 'hono'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import type { DispatchObsCtx } from './dispatch.ts'

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

#### 2.3 `chat-flow/shared/sse-readers.ts`（~25 行）

直接搬现状的 `parseTargetSSE` + `mapSourceApiToProviderRequest`，从 `routes.ts` 移过来。

#### 2.4 `chat-flow/shared/error-wrap.ts`（~10 行）

```ts
export function invalidJsonResponse(): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

export const jsonErrorWrap = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
```

#### 2.5 `chat-flow/messages/http.ts`（~40 行）

```ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { hasWebSearch } from '../../orchestrator/server-tools/plugins/web-search/index.ts'
import { invokeMessagesWebSearchShortcut } from './web-search-shortcut.ts'
import { serveMessages } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function messagesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  if (hasWebSearch(raw as Parameters<typeof hasWebSearch>[0])) {
    return invokeMessagesWebSearchShortcut(c, raw)
  }

  const auth = readAuth(c)
  return serveMessages({ raw, auth, obsCtx: readObsCtx(c, auth) })
}
```

#### 2.6 `chat-flow/messages/serve.ts`（~25 行）

```ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface MessagesServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveMessages(args: MessagesServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: parseMessagesPayload,
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'messages',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
```

#### 2.7 `chat-flow/messages/web-search-shortcut.ts`（~30 行）

封装现状 routes.ts:307-326 的 web-search 短路逻辑：auth check + 401 envelope + 委托 `handleMessagesWebSearch`。

#### 2.8 `chat-flow/chat-completions/{http,serve}.ts`

最简单的端点。http.ts ~25 行，serve.ts ~20 行（含 `fallbackMaxOutputTokens: 4096`）。

#### 2.9 `chat-flow/responses/serve.ts`（~35 行）

```ts
export interface ResponsesServeResult {
  response: Response
  mergedInputItems: unknown[]
}

export async function serveResponses(args): Promise<ResponsesServeResult> {
  const store = getResponsesStore()
  let mergedInputItems: unknown[] = []
  const response = await dispatch(args.raw, {
    parse: parseResponsesPayload,
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'responses',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
    postParse: async (payload) => {
      await expandPreviousResponseId(payload, store, args.auth.apiKeyId ?? null)
      const expanded = (payload as { input?: unknown }).input
      mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
    },
  })
  return { response, mergedInputItems }
}
```

`mergedInputItems` 不再以闭包捕获方式逃出 dispatch — 显式地从 serveResponses 返回，给 http.ts 的 sidecar 触发使用。

#### 2.10 `chat-flow/responses/snapshot-sidecar.ts`（~80 行）

集中 sidecar tee/clone + parseSSE + savePostTurnSnapshot 逻辑。导出两个函数：

```ts
export async function attachStreamSidecar(args: {
  c: Context
  response: Response
  fallbackModel: string
  apiKeyId: string | null
  requestId: string | null
  mergedInputItems: unknown[]
}): Promise<Response>

export async function attachNonStreamSidecar(args): Promise<Response>
```

`http.ts` 根据 content-type 选其一调用。

#### 2.11 `chat-flow/responses/http.ts`（~70 行）

```ts
export async function responsesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  const rawObj = raw as { tools?: Array<Record<string, unknown>> } | null
  if (rawObj && hasImageGeneration(rawObj.tools as Parameters<typeof hasImageGeneration>[0])) {
    return invokeResponsesImageGenerationShortcut(c, raw)
  }

  const auth = readAuth(c)
  const obsCtx = readObsCtx(c, auth)

  const { response, mergedInputItems } = await serveResponses({ raw, auth, obsCtx })

  if (response.status !== 200) return response
  const ct = response.headers.get('content-type') ?? ''
  const fallbackModel = (raw as { model?: string }).model ?? ''
  const apiKeyIdSnap = auth.apiKeyId ?? null
  const requestIdSnap = obsCtx.requestId ?? null

  if (ct.includes('text/event-stream') && response.body) {
    return attachStreamSidecar({ c, response, fallbackModel, apiKeyId: apiKeyIdSnap, requestId: requestIdSnap, mergedInputItems })
  }
  if (ct.includes('application/json')) {
    return attachNonStreamSidecar({ c, response, fallbackModel, apiKeyId: apiKeyIdSnap, requestId: requestIdSnap, mergedInputItems })
  }
  return response
}
```

#### 2.12 `chat-flow/gemini/{http,serve}.ts`

http.ts ~30 行：URL verb 解码（`raw.split(':')`），把 `model` 和 `forceStream` 传给 serve。serve.ts ~25 行：dispatch with `forceStream`、`fallbackMaxOutputTokens: 4096`。

#### 2.13 `chat-flow/count-tokens/{http,serve}.ts`

完全独立路径（不走 dispatch）。http.ts ~25 行：JSON parse + 委托 serve。serve.ts ~50 行：parseMessagesCountTokensPayload → resolveBinding → binding.provider.fetch → JSON return。

#### 2.14 `routes.ts`（~35 行）

```ts
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { messagesHandler } from './chat-flow/messages/http.ts'
import { chatCompletionsHandler } from './chat-flow/chat-completions/http.ts'
import { responsesHandler } from './chat-flow/responses/http.ts'
import { geminiHandler } from './chat-flow/gemini/http.ts'
import { countTokensHandler } from './chat-flow/count-tokens/http.ts'

export const dataPlane = new Hono<{ Bindings: Env }>()

dataPlane.use('*', async (c, next) => {
  if (!c.get('auth' as never)) {
    c.set('auth' as never, {} as DataPlaneAuthCtx)
  }
  await next()
})

dataPlane.route('/', modelsRouter)
dataPlane.route('/', embeddingsRouter)
dataPlane.route('/', imagesRouter)

dataPlane.post('/v1/messages', messagesHandler)
dataPlane.post('/v1/messages/count_tokens', countTokensHandler)
dataPlane.post('/v1/chat/completions', chatCompletionsHandler)
dataPlane.post('/v1/responses', responsesHandler)
dataPlane.post('/v1beta/models/:model{.+}', geminiHandler)
```

### 3. 依赖方向

- `routes.ts` → 5 个 `chat-flow/*/http.ts`（边界层）
- 每个 `http.ts` → 同目录 `serve.ts` + `chat-flow/shared/*` + 现有的 `dispatch/`、`errors/`、`routing/`、`orchestrator/server-tools/plugins/`
- `serve.ts` → `chat-flow/shared/dispatch.ts` + `parsers.ts` + (responses 还依赖 `responses-store-bridge` 和 `responses-store`)
- `chat-flow/shared/dispatch.ts` → 现有 `dispatch/`、`routing/`、`errors/`、`observability/`、`provider-copilot`
- 单向 import 图：routes → http → serve → shared/dispatch → 算法层。**无循环。**

### 4. 测试

#### 4.1 不动的测试

所有现有 routes 集成测试（gateway 包内 `__tests__` 目录下凡断言 `/v1/messages`、`/v1/responses`、`/v1/chat/completions`、`/v1beta/models/:model`、`/v1/messages/count_tokens` 行为的）保持不变 —— 行为零变化，测试自动覆盖新路径。

#### 4.2 新增

**`packages/gateway/__tests__/data-plane/chat-flow/shared/dispatch.test.ts`**（≥ 10 条）

dispatch 现在不依赖 Hono Context，可用 fake binding + fake translator 直接测：

```ts
test('dispatch — invalid JSON not handled here (caller responsibility)', () => {
  // 仅文档化：dispatch 不处理 invalid JSON, http.ts 处理
})

test('dispatch — parse error → errorWrap(400)', async () => { /* ... */ })
test('dispatch — postParse PreviousResponseNotFoundError → renderPreviousResponseNotFound', async () => { /* ... */ })
test('dispatch — postParse other Error → errorWrap(400)', async () => { /* ... */ })
test('dispatch — candidates=0 sawModel=true → errorWrap(400 invalid_request_error)', async () => { /* ... */ })
test('dispatch — candidates=0 sawModel=false → errorWrap(404)', async () => { /* ... */ })
test('dispatch — getTranslator null → errorWrap(400)', async () => { /* ... */ })
test('dispatch — translateRequest throw → errorWrap(400)', async () => { /* ... */ })
test('dispatch — HTTPError → repackageUpstreamError', async () => { /* ... */ })
test('dispatch — attempt 429 → errorWrap(429 with rate_limit_error)', async () => { /* ... */ })
test('dispatch — happy path stream → SSE response', async () => { /* ... */ })
test('dispatch — happy path non-stream → JSON', async () => { /* ... */ })
test('dispatch — translateBody throw → errorWrap(502)', async () => { /* ... */ })
```

**`packages/gateway/__tests__/data-plane/chat-flow/responses/snapshot-sidecar.test.ts`**（≥ 3 条）

```ts
test('attachStreamSidecar — tees body and saves snapshot via responses-store', async () => { /* ... */ })
test('attachNonStreamSidecar — clones JSON and saves snapshot via responses-store', async () => { /* ... */ })
test('attachStreamSidecar — falls back to fire-and-forget when executionCtx absent', async () => { /* ... */ })
```

#### 4.3 基线

拆分前：768 pass / 4 fail（`bun test` curated；4 个 dispatch-observability 既存 flake 与本改动无关）。
拆分后期望：≥ 781 pass（+13 新测试）/ 4 fail。

### 5. 改动文件清单

**新增（11 个 .ts 源文件 + 2 个 .test.ts 文件）：**
- `packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts`
- `packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts`
- `packages/gateway/src/data-plane/chat-flow/shared/sse-readers.ts`
- `packages/gateway/src/data-plane/chat-flow/shared/error-wrap.ts`
- `packages/gateway/src/data-plane/chat-flow/messages/{http,serve,web-search-shortcut}.ts`
- `packages/gateway/src/data-plane/chat-flow/chat-completions/{http,serve}.ts`
- `packages/gateway/src/data-plane/chat-flow/responses/{http,serve,snapshot-sidecar,image-generation-shortcut}.ts`
- `packages/gateway/src/data-plane/chat-flow/gemini/{http,serve}.ts`
- `packages/gateway/src/data-plane/chat-flow/count-tokens/{http,serve}.ts`
- `packages/gateway/__tests__/data-plane/chat-flow/shared/dispatch.test.ts`
- `packages/gateway/__tests__/data-plane/chat-flow/responses/snapshot-sidecar.test.ts`

**修改：**
- `packages/gateway/src/data-plane/routes.ts`：从 618 行裁到 ~35 行；只保留 Hono mount + auth bridge + 5 个 handler import。

**删除：** 无（routes.ts 是收缩，不是删除）。

### 6. 兼容性 / 风险

- 5 个端点的对外行为（URL、wire shape、状态码、SSE 流形态）零变化。
- `dispatch<T>` 签名变更（`(c, input) → (raw, input)`）—— 调用点全部在新 http.ts 内一次性重写，不影响其他模块。
- `mergedInputItems` 闭包改为显式返回值传递 → 行为相同，更易读。
- `routes.ts` 不再 import `parseMessagesSSEStream / parseChatSSEStream / parseResponsesSSEStream / orchestrator/server-tools/plugins/` —— 这些 import 下沉到使用方文件。
- 新增导入边界（`http.ts` 是唯一允许 import Hono `Context` 的层）—— 通过验收标准 #4 强制保证。
- 测试粒度提升：dispatch 单测无需造 Hono Context（重大可测性改进）。

### 7. 验收标准

1. `routes.ts` ≤ 40 行非空白代码。
2. `chat-flow/shared/dispatch.ts` ≤ 100 行；签名 `(rawJson, input) => Promise<Response>`；**不 import `hono`**。
3. 每个 `chat-flow/*/serve.ts` ≤ 60 行；**不 import `hono`**。
4. 每个 `chat-flow/*/http.ts` ≤ 80 行；是允许 import `Context from 'hono'` 的唯一层（连同 `routes.ts` 自身 import `Hono`）。
5. `bun test`（curated）pass 数不下降；新增 ≥ 13 条测试全部通过。
6. `bunx tsc --noEmit` 全 pass。
7. `routes.ts` 不再 import：`parseMessagesSSEStream` / `parseChatSSEStream` / `parseResponsesSSEStream` / `orchestrator/server-tools/plugins/` / `parseTargetSSE` / `mapSourceApiToProviderRequest` / `expandPreviousResponseId` / `savePostTurnSnapshot` / `getResponsesStore` / `runConversationAttempt` / `repackageUpstreamError` / `enumerateBindingCandidates` / `parseModelRouting` / `selectPair` / `getTranslator` / `encodeClientSSE` / `parseMessagesPayload` / `parseChatPayload` / `parseResponsesPayload` / `parseGeminiPayload` / `parseMessagesCountTokensPayload` / `resolveBinding` / `stripUpstreamPin` / `HTTPError` / `PreviousResponseNotFoundError` / `renderPreviousResponseNotFound`。

### 8. 参考项目对照

- **`copilot-gateway`（floway-dev）**：`packages/gateway/src/data-plane/llm/{messages,responses,chat-completions,gemini}/{http,serve,attempt,routing,errors,respond}.ts` + `llm/shared/`。验证了"端点目录 + http/serve 二分 + shared 抽公共"模式在 monorepo + Hono + pairwise translate 场景下成熟。本 spec 借鉴此结构但简化了内部分层（不再额外拆 attempt/routing/respond，因为 vNext 的 dispatch<T> 已经是相当于 attempt + routing 的一体化编排，无需进一步细分）。
- **`copilot-api-gateway` 旧 `src/routes/{messages,responses}/*.ts`**：Elysia 路由，按"主路径 + fallback 变体"切分（chat-completions-fallback / responses-fallback / web-search / image-generation / direct）。这个组织方式针对老架构有 IR 的多 fallback 场景；vNext 已经无 IR 单 translator 直选，不需要 fallback 子文件，参考意义有限。

## Out of Scope（追溯）

- L2 共享缓存验证 → 另起 plan
- 修复 4 个 dispatch-observability flake（mock.module 跨文件泄漏）→ 另起 plan
- 后续若 dispatch 编排再长 → 可以引入 stage 拆分作为 Plan C3，但现状 ~80 行不需要
- snapshot-sidecar 进一步下沉到 interceptor 链 → 已记录在 commit 33a16c9 + 69d489c 上下文，未来另起 plan
