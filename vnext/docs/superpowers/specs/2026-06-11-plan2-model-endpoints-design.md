# Plan 2 — ModelEndpoints 数据模型重构

> 把 endpoint capability 从「per-upstream 数组 + dispatcher 启发式」迁移到「per-model 结构化 map + client-protocol 优先级链」。一次性 cutover，单 PR 交付。

## 背景

Plan 1 临时实现的 `chooseBackendEndpoint(model)` 用模型 id 正则推断后端 endpoint：

```ts
// vnext/apps/gateway/src/data-plane/routing/backend-selector.ts
if (m.startsWith('gpt-5') || /^o[134](-|$)/.test(m)) return 'responses'
if (m.startsWith('claude-')) return 'messages'
return 'chat_completions'
```

问题：
- 模型 id 启发式不可扩展（Gemini family、新模型必须改 helper）
- 与 `ProviderBinding.upstreamEndpoints` 的 per-upstream 数组无法表达"该 upstream 上 model A 支持 responses，model B 只支持 chat_completions"
- dispatcher 决策与 client 协议无关，导致同协议直通的优化机会丢失（client `/v1/messages` 调用模型 X，模型支持 messages 时却被启发式路由到 chat_completions）

参考项目 `copilot-gateway` 已经实现了完整的 ModelEndpoints 模式（`packages/provider/src/model.ts`、`packages/gateway/src/data-plane/llm/*/serve.ts`），本设计直接对齐。

## 设计

### 数据模型

**`@vnext/protocols/common`** 新增结构化能力 map：

```ts
export interface ModelEndpoints {
  chat_completions?: {}
  responses?: {}
  messages?: {}
  messages_count_tokens?: {}
  embeddings?: {}
  images_generations?: {}
  images_edits?: {}
}

export function kindForEndpoints(e: ModelEndpoints): ModelKind
//   只声明 embeddings → 'embedding'
//   只声明 images_* → 'image'
//   其它（含混合）→ 'chat'
```

键存在即代表该模型支持那个 endpoint，值为空对象，预留未来子能力扩展。

**不变量**（producer 边界 enforce）：
- `kind === 'embedding'` ⇔ `endpoints` 仅包含 `embeddings`
- `kind === 'image'` ⇔ `endpoints ⊆ { images_generations, images_edits }`
- `kind === 'chat'` ⇒ `endpoints` 包含至少一个生成 endpoint

`ModelKind` 退化为派生量，不再独立存储。需要 kind 的调用点统一调 `kindForEndpoints(model.endpoints)`。

### Binding 形状

**`@vnext/provider/binding`**：

```ts
export interface BindingModel {
  id: string
  displayName?: string
  ownedBy?: string
  created?: number
  limits: { /* unchanged */ }
  endpoints: ModelEndpoints      // 新增
  cost?: ModelPricing
  // kind 字段删除（改为派生）
}

export interface ProviderBinding {
  upstream: UpstreamRecord
  model: BindingModel
  enabledFlags: ReadonlySet<string>
  provider: ModelProvider
  // upstreamEndpoints 字段删除
}
```

### Provider 包负责填充

**`@vnext/provider-copilot`** 新增 `copilotModelEndpoints(rawModel, allRawModels)`，从 Copilot `/models` 推断：

1. 把 `supported_endpoints` 路径列表（`/v1/responses` 等）映射到 `ModelEndpoints` key
2. 优先级 fallback：`responses > messages > chat_completions > embeddings`
3. **provider 内部硬编码 workaround**：`claude-*` 强制标 messages（Copilot 历史漏报 Anthropic native path）。注释说明原因。

`registry.ts` 的 `DEFAULT_ENDPOINTS` 常量删除；`listProviderBindings` 改为调用 provider 包接口逐 model 计算 endpoints。

**Override 机制**：仅在 provider 包代码里硬编码 workaround（参考项目同型）。dashboard / config schema 不暴露 endpoint override 字段。理由：endpoint capability 是 provider 对上游的客观映射，不是用户偏好；漏报是 provider 包的 bug，由 provider 包修。

### Dispatcher 形状

**新增 `data-plane/routing/candidates.ts`**：

```ts
export interface BindingCandidate {
  binding: ProviderBinding
  targetEndpoint: EndpointKey
}

export async function enumerateBindingCandidates(args: {
  model: string                                    // 客户端请求的 model id
  pickTarget: (e: ModelEndpoints) => EndpointKey | null
}): Promise<{ candidates: BindingCandidate[]; sawModel: boolean }>
```

遍历所有 enabled bindings，对每条 `pickTarget(binding.model.endpoints)`：
- 返回 `EndpointKey` → 加入 candidates
- 返回 `null` → 跳过（该 binding 不能服务此 client protocol）
- 一条都没返回 → `sawModel` 标记是否模型存在但无可用 endpoint，便于上层报 4xx

**`routes.ts`** 三个 entry 各自内联 pickTarget 闭包：

```ts
// /v1/messages (generate)
pickTarget: e => e.messages ? 'messages'
              : e.responses ? 'responses'
              : e.chat_completions ? 'chat_completions'
              : null

// /v1/messages/count_tokens — 窄通道
pickTarget: e => e.messages_count_tokens ? 'messages_count_tokens' : null

// /v1/responses
pickTarget: e => e.responses ? 'responses'
              : e.messages ? 'messages'
              : e.chat_completions ? 'chat_completions'
              : null

// /v1/chat/completions  和  Gemini /v1beta/...
pickTarget: e => e.chat_completions ? 'chat_completions'
              : e.messages ? 'messages'
              : e.responses ? 'responses'
              : null
```

**删除**：
- `data-plane/routing/backend-selector.ts`（chooseBackendEndpoint）
- `binding-resolver.ts` 的 `resolveBinding(model, endpoint, opts)` API；改由 `enumerateBindingCandidates` 调用，endpoint 不再是 input
- `bindingServesEndpoint` 中检查 `b.upstreamEndpoints.includes(endpoint)` 的分支（改查 `b.model.endpoints`）

## 文件结构

**新增：**
- `vnext/packages/protocols/src/common/model-endpoints.ts` — `ModelEndpoints` 类型 + `kindForEndpoints`
- `vnext/packages/provider-copilot/src/endpoints.ts` — `copilotPathToModelEndpoint` + `copilotModelEndpoints`
- `vnext/apps/gateway/src/data-plane/routing/candidates.ts` — `enumerateBindingCandidates`
- `vnext/packages/protocols/src/common/__tests__/model-endpoints.test.ts`
- `vnext/packages/provider-copilot/src/__tests__/endpoints.test.ts`
- `vnext/apps/gateway/src/data-plane/routing/__tests__/candidates.test.ts`

**修改：**
- `vnext/packages/protocols/src/common/index.ts` — re-export ModelEndpoints；删除/标记 `ENDPOINTS_BY_MODEL_KIND`（被 kindForEndpoints 取代）
- `vnext/packages/provider/src/binding.ts` — `BindingModel.endpoints` 字段；`ProviderBinding.upstreamEndpoints` 移除
- `vnext/packages/provider-copilot/src/provider.ts` 或 `registry-builder` — 接入 `copilotModelEndpoints`
- `vnext/apps/gateway/src/data-plane/providers/registry.ts` — 删除 `DEFAULT_ENDPOINTS`；`listProviderBindings` 调 provider 计算
- `vnext/apps/gateway/src/data-plane/routing/binding.ts` — `bindingServesEndpoint` 改查 `b.model.endpoints`
- `vnext/apps/gateway/src/data-plane/routing/binding-resolver.ts` — 重写为 `enumerateBindingCandidates` 包装
- `vnext/apps/gateway/src/data-plane/routes.ts` — 三个 entry 改为 pickTarget 闭包

**删除：**
- `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts`
- 关联测试：`backend-selector.test.ts`（如有）

## 错误处理

`enumerateBindingCandidates` 返回 `{ candidates: [], sawModel: false }` → `404 model_not_found`
返回 `{ candidates: [], sawModel: true }` → `400 model_does_not_support_endpoint`

错误 envelope 仍走 Plan 1 已落地的 `repackageUpstreamError` 分支。

## 测试

1. **`kindForEndpoints` 单测**：6 种典型组合 + 空对象 corner case
2. **`copilotModelEndpoints` 单测**：覆盖
   - `supported_endpoints: ['/v1/chat/completions','/v1/responses']` → 选 responses（高优先）
   - `supported_endpoints: ['/v1/embeddings']` + `capabilities.type='embeddings'` → embeddings
   - `claude-*` 不论 supported_endpoints 如何 → 必含 messages
   - 缺失 `supported_endpoints` 但 `capabilities.type='chat'` → chat_completions
3. **`enumerateBindingCandidates` 单测**：3 桩 binding + 4 种 pickTarget，验证候选筛选与 sawModel 标记
4. **routes.ts e2e**：保留 Plan 1 现有套件，所有 278 测试应当继续 PASS
5. **smoke**：`bun run local` + 真上游 Copilot 至少跑 chat / messages / embeddings 各一次

## 迁移

一次性 cutover，单 PR：
1. 加 `ModelEndpoints` 类型 + `kindForEndpoints`
2. 改 `BindingModel`（加 endpoints, 删 kind 独立字段）
3. 实现 `copilotModelEndpoints` + 接入 registry
4. 实现 `enumerateBindingCandidates`
5. 重写 routes.ts 三个 entry
6. 删除 backend-selector.ts、`DEFAULT_ENDPOINTS`、`upstreamEndpoints` 字段
7. typecheck + bun test + smoke 全过

中间 commit 可能短暂 typecheck 失败，但单 PR 完整交付。

## 不在范围

- Custom / Azure / Codex provider：本 PR 只做 Copilot；其它 provider 暂保留现状的 endpoint 推断空壳，待 provider 各自迁移
- Dashboard endpoint override UI：参考项目无此功能，本 PR 同样不做
- Plan 3 的 chat-out 全量 + Claude 字段完整往返：独立交付

## 与参考项目差异

- vNext 用 `chat_completions` snake_case key（既有 `EndpointKey` 类型），参考项目用 `chatCompletions` camelCase
- vNext binding 用 `ProviderBinding`（per-upstream + per-model 合一），参考项目分 `UpstreamRecord` 与 `UpstreamModel` 两层；本设计在 vNext 内保持现有合一结构，仅把 endpoints 字段下放到 model 层
