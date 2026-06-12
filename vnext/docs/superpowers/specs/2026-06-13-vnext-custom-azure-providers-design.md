# vNext: Custom + Azure Provider 移植设计

**Date:** 2026-06-13
**Scope:** vNext feature parity 第三批 — 把 main 的 `CustomProvider`（OpenAI-兼容）和 `AzureProvider` 移植到 vNext，同时抽取 `@vnext/shared-http` 共享包以建立稳定的 transport 边界，并把 copilot 现有的 inline transport helpers 一次性收编到该包。

**Out of scope:** count_tokens（已在前置任务 #146 完成）；新增 D1 schema（控制面的 `CustomProviderConfig` / `AzureProviderConfig` 解析、normalize、parse 函数已经就绪）；任何 main 之外的行为变更。

---

## 1. 背景

### 1.1 当前 gap

- `vnext/apps/gateway/src/data-plane/providers/registry.ts:47-65` — `createProviderFromUpstream` 对 `kind === 'azure' | 'custom'` 返回 `null`，路由解析会失败。
- `vnext/apps/gateway/src/control-plane/upstreams/routes.ts:329-349` — `POST /api/upstream-probe` 对 `kind === 'custom' | 'azure'` 返回 `501 "provider not yet ported to vnext"`。
- 控制面其他配置基础设施（`CustomProviderConfig` 接口、`AzureProviderConfig` 接口、`parseManualModels`、`parseAzureDeployments`、`normalizeCustomConfig`、`normalizeAzureConfig`）**已存在**，不需新增。

### 1.2 main 参考实现

- `src/providers/custom/provider.ts`（~195 行） — OpenAI-兼容 provider，服务 DeepSeek/Together/Groq/OpenRouter/vLLM/llama.cpp。
- `src/providers/azure/provider.ts`（~238 行） — Azure OpenAI / Azure-Anthropic。`api-key` header，`?api-version=` 查询，`/openai/deployments/<name>` URL 命名空间，多 deployment fan-out（G6）。

### 1.3 vNext 已有共享设施

- `@vnext/provider` 暴露 `ModelProvider`、`HTTPError`、`ProbeResult`、`probeViaModels`、`ProviderModelsResponse`、`ProviderFetchOptions`。
- `@vnext/provider-copilot` 在 `src/lib/fetch-retry.ts` 内 verbatim 拷贝了 main 的 `fetchWithRetry`，并在 `provider.ts` / `forward.ts` 中 inline 实现：
  - `parseJsonBody(body)` — body 必须是 string，否则抛
  - `mergeHeaders(initHeaders, extra)` — 接受 `HeadersInit | undefined` + extra Record，把 init 转 Headers 后 forEach 拷入 Record，再 `Object.assign(out, extra)` 让 extra 覆盖 init
  - `forward.ts:87` 的错误体截断：`errorBody.slice(0, 200) + "...(truncated)"`（与 main custom/azure 的 `truncate(s, 200)` 完全等价）

main 侧的 custom/azure 各自 inline 实现 `headersInitToRecord` 和 `truncate` — 与 copilot 的 `mergeHeaders`（去掉 extra 参数）和 inline truncate 行为等价，只是命名分散。

---

## 2. 设计目标

1. 在 vNext 复刻 custom + azure 的全部行为，**等价于 main**（URL 拼接、auth、deployment 路由、错误包装、retry 曲线、FormData 处理）。
2. 抽取 `@vnext/shared-http` 作为 transport 工具集的稳定边界，**同步收编 copilot 的 inline helpers**，避免 transport 工具在多个 provider 之间漂移。
3. 接入 gateway 数据面（`createProviderFromUpstream`）和控制面（`/api/upstream-probe`），把两处 stub 替换为真实实现。
4. 每个新 provider 配完整单测，使用 `globalThis.fetch` mock，避免 Bun 1.3 `mock.module()` 跨文件泄漏问题。

---

## 3. 架构

### 3.1 包结构

```
vnext/packages/
├── shared-http/                ← 新建
│   ├── package.json            # deps: @vnext/provider (HTTPError 类型)
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # 桶口
│       ├── fetch-retry.ts      # fetchWithRetry + FetchOptions（verbatim 提升）
│       ├── headers.ts          # mergeHeaders(initHeaders, extra) → Record<string,string>
│       ├── body.ts             # parseJsonBody(body) + truncateBody(s, max=200)
│       └── __tests__/
│           └── shared-http.test.ts
├── provider/                   ← 不动
├── provider-copilot/           ← 修改（收编 inline helpers）
│   ├── package.json            # 加 "@vnext/shared-http": "workspace:*"
│   └── src/
│       ├── lib/fetch-retry.ts  # 删除
│       ├── forward.ts          # import 改到 @vnext/shared-http
│       └── provider.ts         # 删 inline parseJsonBody/mergeHeaders/truncate
├── provider-custom/            ← 新建
│   ├── package.json            # deps: @vnext/provider + @vnext/shared-http
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # re-export CustomProvider + CustomProviderConfig
│       ├── provider.ts         # ~155 行（main 195 - lib 拷贝节省）
│       └── __tests__/
│           └── provider.test.ts
└── provider-azure/             ← 新建
    ├── package.json            # deps: @vnext/provider + @vnext/shared-http
    ├── tsconfig.json
    └── src/
        ├── index.ts            # re-export AzureProvider + AzureProviderConfig
        ├── provider.ts         # ~200 行（main 238 - lib 拷贝节省）
        └── __tests__/
            └── provider.test.ts
```

### 3.2 `@vnext/shared-http` API

```ts
// fetch-retry.ts
export interface FetchOptions extends RequestInit {
  retryDelay?: number   // 基础退避，默认 1000ms。第 N 次重试等待 min(retryDelay * 2^N, 10000)ms
  maxRetries?: number   // 默认 3
  timeout?: number      // 默认无，启用时挂 AbortController
}
export async function fetchWithRetry(input: string | URL, init?: FetchOptions): Promise<Response>

// headers.ts
export function mergeHeaders(
  initHeaders: RequestInit['headers'] | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string>

// body.ts
export function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown>
export function truncateBody(s: string, max?: number): string  // 默认 200，超长追加 "...(truncated)"

// index.ts
export * from './fetch-retry'
export * from './headers'
export * from './body'
```

行为约束：`fetchWithRetry` 的语义/重试曲线/timeout 实现与 `provider-copilot/src/lib/fetch-retry.ts` **完全相同**，只是搬位置。

### 3.3 接线点

**数据面** — `vnext/apps/gateway/src/data-plane/providers/registry.ts`

替换当前 `createProviderFromUpstream` 内的 `return null`：
```ts
if (upstream.provider === 'custom') {
  return new CustomProvider(upstream.config as CustomProviderConfig)
}
if (upstream.provider === 'azure') {
  return new AzureProvider(upstream.config as AzureProviderConfig)
}
```

**控制面** — `vnext/apps/gateway/src/control-plane/upstreams/routes.ts` (line 345-346)

替换 `501 stub`。注意 `new CustomProvider(...)` / `new AzureProvider(...)` 在缺 apiKey / endpoint / deployment / apiVersion 时会**构造期抛 Error**，必须包 try/catch 转 400，避免冒泡成 500：
```ts
if (kind === 'custom' || kind === 'azure') {
  try {
    const provider = kind === 'custom'
      ? new CustomProvider(normalizeCustomConfig(config))
      : new AzureProvider(normalizeAzureConfig(config))
    return c.json(await provider.probe())
  } catch (e) {
    return c.json({ error: { type: 'invalid_request_error', message: (e as Error).message } }, 400)
  }
}
```

`normalizeCustomConfig` / `normalizeAzureConfig` 已在同文件存在。

---

## 4. Provider 详细规范

### 4.1 `CustomProvider`

**Config**:
```ts
interface CustomProviderConfig {
  name: string
  baseUrl: string                 // 无尾 slash
  apiKey: string                  // Bearer token
  defaultHeaders?: Record<string, string>
  endpoints?: readonly EndpointKey[]   // 默认 ['chat_completions', 'embeddings']
  modelsEndpoint?: string         // 默认 ${baseUrl}/models
  models?: ReadonlyArray<string | { id: string; name?: string; ownedBy?: string }>  // G2 manual list
}
```

**Endpoint path map**（包私有常量）：
```ts
const CUSTOM_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  messages_count_tokens: '/messages/count_tokens',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
}
```

**关键方法**：
- 构造期：`baseUrl.replace(/\/+$/, '')` 去尾 slash；缺 apiKey/baseUrl 抛 `Error`。
- `getModels()`：manual 列表存在则直接返回（包成 OpenAI `{object: 'list', data: [...]}`），否则 GET `modelsEndpoint` + `fetchWithRetry`，非 200 抛 `HTTPError`（body 用 `truncateBody`）。
- `probe()`：`probeViaModels(() => this.getModels())`。
- `fetch(endpoint, init, opts)`：查 `CUSTOM_PATHS`；非 string body 跳过 JSON Content-Type；headers 合并顺序 = `Authorization` → `defaultHeaders` → `init.headers`（via `mergeHeaders`） → `opts.extraHeaders`；调 `fetchWithRetry`；非 2xx 抛 `HTTPError` 携带原 Response。

### 4.2 `AzureProvider`

**Config**:
```ts
interface AzureProviderConfig {
  name: string
  endpoint: string                // 无尾 slash
  apiKey: string                  // api-key header
  deployment: string              // 默认 deployment
  apiVersion: string              // 必填，OpenAI 路径需要
  endpoints: readonly EndpointKey[]
  defaultHeaders?: Record<string, string>
  deployments?: ReadonlyArray<{ name: string; model: string }>  // G6 fan-out
}
```

**Endpoint path map**（两组）：
```ts
const OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
}
const ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
}
```

**URL 拼接**：
- OpenAI 路径：`${endpoint}/openai/deployments/${deployment}${path}?api-version=${encodeURIComponent(apiVersion)}`
- Anthropic 路径：`${endpoint}/anthropic${path}`（不带 api-version）

**Header**：`api-key: ${apiKey}`（**不是** `Authorization`），其余合并顺序与 custom 相同。

**deployment 路由** (`resolveDeployment(payload)`)：
1. payload 无 `model` → 默认 `deployment`
2. 遍历 `extraDeployments`：`d.model === model || d.name === model` 命中 → `d.name`
3. `model === this.deployment` → 默认
4. 兜底默认

**FormData 处理**（images/edits）：构造 payload 时若 body 是 `FormData`，从 form 取 `model` 字段；非 FormData 走 `parseJsonBody`（body 非 string 抛错）。

**`getModels()`**：合成默认 deployment + extra deployments 的 model 字段，去重，包成 OpenAI list。

**`probe()`**：自定义 — GET `${endpoint}/openai/deployments?api-version=${...}`，解析 `data` 数组传给 `probeViaModels`。

---

## 5. 测试策略

每包 `__tests__/provider.test.ts` 用 `globalThis.fetch` mock（参考 MEMORY 中 `bun_mock_module_unrestorable.md`），不依赖真实上游。

**`@vnext/shared-http` 测试**：
- `fetchWithRetry`：成功路径、5xx 重试、429 重试、4xx (除 429) 不重试、timeout 触发 AbortController、达到 `maxRetries` 抛错。
- `mergeHeaders`：空 init / 仅 init / init+extra / extra 覆盖 init / **header 合并优先级锁定**（在 provider 测试中验证：extra > init.headers > defaultHeaders > auth header，确保 init 不能覆盖 Authorization/api-key）。
- `parseJsonBody`：合法 JSON / FormData 抛 / undefined 抛 / 非对象 JSON。
- `truncateBody`：短串原样 / 超长追加后缀。

**`@vnext/provider-custom` 测试**（≥ 8 例）：
- URL 拼接覆盖 7 个 endpoint
- Bearer auth + defaultHeaders 合并
- Manual models 绕过 live /models
- Live /models 透传
- 错误体被 `truncateBody` 截断并包入 `HTTPError`，`HTTPError.response` 保留原 status
- FormData body：不强加 `Content-Type: application/json`
- 缺 apiKey / baseUrl → 构造抛错
- probe：成功返回 `{ok: true, modelCount, models}`，失败返回 `{ok: false, ...}`

**`@vnext/provider-azure` 测试**（≥ 10 例）：
- OpenAI 路径正确拼 `?api-version=`
- Anthropic 路径不带 `?api-version=`
- `api-key` header（非 bearer）
- `resolveDeployment`：默认 / 命中 `d.model` / 命中 `d.name` / 不匹配 fallback
- `getModels()` 合成（默认 + extra，去重）
- FormData body：从 form 取 model 用于 deployment 路由
- 不支持的 endpoint 抛 `Azure deployment ${name} does not serve endpoint: ${endpoint}`
- 缺 apiKey / endpoint / deployment / apiVersion → 构造抛错
- probe：成功 / 失败两路

---

## 6. 不做（明确边界）

- **不抽 path map** — 端点表是 provider 业务知识；custom 是 7 个的完整表，azure 是 OPENAI/ANTHROPIC 两组带前缀区别。强制共享会污染语义。
- **不抽 auth header** — Bearer / api-key / copilot 双 token 各自独立。
- **不动 `HTTPError`** — 它在 `@vnext/provider`（契约层），不属于 transport。
- **不动 `probeViaModels`、`ProbeResult`、`ModelProvider`** — 它们在 `@vnext/provider`。
- **不改 fetchWithRetry 行为** — verbatim 提升。
- **不引入新依赖**。
- **不加 D1 migration** — 控制面 config 解析就绪。
- **不重构 copilot 业务逻辑**（chain、interceptors、cyber-policy retry、connection-mismatch、forward） — 只替换它 inline 的 transport helpers。

---

## 7. 验收

- vNext typecheck 全绿
- `bun test` 三个新/改动包全绿
- **plan1 完成后 copilot 行为零差异**：所有 copilot 现有测试无回归、retry 曲线/timeout/header 合并语义与原 inline 实现等价
- `POST /api/upstream-probe` 对 `kind=custom` 和 `kind=azure` 返回合法 `ProbeResult`（不再 501；构造错误返回 400 而非 500）
- `/v1/chat/completions` 通过 custom upstream（如 DeepSeek key）能成功 round-trip
- `/v1/messages` 通过 azure-anthropic deployment 能成功 round-trip
- copilot 现有所有测试无回归

---

## 8. 实施分批

按用户偏好分多个 plan 文档：

- **plan1**：抽 `@vnext/shared-http`，同步收编 `@vnext/provider-copilot` inline helpers（**前置**，无依赖；对 gateway 行为零影响）
- **plan2**：新建 `@vnext/provider-custom`（**依赖 plan1**）
- **plan3**：新建 `@vnext/provider-azure`（**依赖 plan1**；与 plan2 独立，可并行）
- **plan4**：gateway 数据面/控制面接线，替换两处 stub（**依赖 plan2 + plan3**）

每个 plan 单独 commit，按依赖顺序执行；plan1 不接线，对 gateway 行为零影响。
