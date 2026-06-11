# Plan 2 — ModelEndpoints 数据模型重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 endpoint capability 从「per-upstream 数组 + dispatcher 模型 id 启发式」迁移到「per-model 结构化 ModelEndpoints map + client-protocol 优先级链」，单 PR 一次性 cutover。

**Architecture:** 在 `@vnext/protocols/common` 新增结构化 `ModelEndpoints` 类型 + 派生函数 `kindForEndpoints`；`@vnext/provider/binding` 把 endpoints 字段下放到 `BindingModel`，删除 `ProviderBinding.upstreamEndpoints` 与 `BindingModel.kind` 独立字段；`@vnext/provider-copilot` 提供 `copilotModelEndpoints` 推断函数（claude-* 硬编码 workaround）；data-plane 用新的 `enumerateBindingCandidates` + 各路由内联 `pickTarget` 闭包替换 `chooseBackendEndpoint` 启发式。

**Tech Stack:** TypeScript, Bun, `bun:test`, Hono.

**Spec:** `vnext/docs/superpowers/specs/2026-06-11-plan2-model-endpoints-design.md`

---

## File Structure

**新增：**
- `vnext/packages/protocols/src/common/model-endpoints.ts` — `ModelEndpoints` 类型 + `kindForEndpoints`
- `vnext/packages/protocols/src/common/__tests__/model-endpoints.test.ts`
- `vnext/packages/provider-copilot/src/endpoints.ts` — `copilotPathToModelEndpoint` + `copilotModelEndpoints`
- `vnext/packages/provider-copilot/src/__tests__/endpoints.test.ts`
- `vnext/apps/gateway/src/data-plane/routing/candidates.ts` — `enumerateBindingCandidates`
- `vnext/apps/gateway/src/data-plane/routing/__tests__/candidates.test.ts`

**修改：**
- `vnext/packages/protocols/src/common/index.ts`
- `vnext/packages/provider/src/binding.ts`
- `vnext/apps/gateway/src/data-plane/providers/registry.ts`
- `vnext/apps/gateway/src/data-plane/routing/binding.ts`
- `vnext/apps/gateway/src/data-plane/routing/binding-resolver.ts`
- `vnext/apps/gateway/src/data-plane/routes.ts`

**删除：**
- `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts`
- `vnext/apps/gateway/tests/backend-selector.test.ts`

> 中间 commit 可能短暂 typecheck 失败 —— 这是设计上预期的、文档化过的 cutover 代价（spec § 迁移）。每个 task 独立 commit 用于回滚定位；最终 task 13 通过全量 typecheck + bun test。

---

### Task 1: 新增 `ModelEndpoints` 类型 + `kindForEndpoints`

**Files:**
- Create: `vnext/packages/protocols/src/common/model-endpoints.ts`

- [ ] **Step 1: 创建 model-endpoints.ts**

```ts
// vnext/packages/protocols/src/common/model-endpoints.ts
/**
 * Per-model structured endpoint capability map. Key presence = supported;
 * value reserved for future sub-capability flags.
 *
 * Replaces the old per-upstream `EndpointKey[]` + model-id heuristic. See
 * docs/superpowers/specs/2026-06-11-plan2-model-endpoints-design.md.
 */
import type { ModelKind } from './index'

export interface ModelEndpoints {
  chat_completions?: Record<string, never>
  responses?: Record<string, never>
  messages?: Record<string, never>
  messages_count_tokens?: Record<string, never>
  embeddings?: Record<string, never>
  images_generations?: Record<string, never>
  images_edits?: Record<string, never>
}

/**
 * Derive ModelKind from a ModelEndpoints map.
 *   only `embeddings` → 'embedding'
 *   only `images_*`   → 'image'
 *   anything else (incl. mixed, empty) → 'chat'
 */
export function kindForEndpoints(e: ModelEndpoints): ModelKind {
  const keys = Object.keys(e) as Array<keyof ModelEndpoints>
  if (keys.length === 1 && keys[0] === 'embeddings') return 'embedding'
  if (keys.length > 0 && keys.every((k) => k === 'images_generations' || k === 'images_edits')) {
    return 'image'
  }
  return 'chat'
}
```

- [ ] **Step 2: re-export 自 common/index.ts**

修改 `vnext/packages/protocols/src/common/index.ts`，在文件末尾追加：

```ts
export type { ModelEndpoints } from './model-endpoints'
export { kindForEndpoints } from './model-endpoints'
```

- [ ] **Step 3: 提交**

```bash
git add vnext/packages/protocols/src/common/model-endpoints.ts vnext/packages/protocols/src/common/index.ts
git commit -m "feat(protocols): add ModelEndpoints type and kindForEndpoints"
```

---

### Task 2: `kindForEndpoints` 单测

**Files:**
- Create: `vnext/packages/protocols/src/common/__tests__/model-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// vnext/packages/protocols/src/common/__tests__/model-endpoints.test.ts
import { test, expect } from 'bun:test'
import { kindForEndpoints, type ModelEndpoints } from '../model-endpoints'

test('embeddings only → embedding', () => {
  expect(kindForEndpoints({ embeddings: {} })).toBe('embedding')
})

test('images_generations only → image', () => {
  expect(kindForEndpoints({ images_generations: {} })).toBe('image')
})

test('images_edits only → image', () => {
  expect(kindForEndpoints({ images_edits: {} })).toBe('image')
})

test('both image endpoints → image', () => {
  expect(kindForEndpoints({ images_generations: {}, images_edits: {} })).toBe('image')
})

test('chat_completions only → chat', () => {
  expect(kindForEndpoints({ chat_completions: {} })).toBe('chat')
})

test('messages + responses + chat_completions → chat', () => {
  expect(kindForEndpoints({
    messages: {}, responses: {}, chat_completions: {},
  })).toBe('chat')
})

test('embeddings + chat_completions (mixed) → chat', () => {
  // Mixed embedding + chat is a violation of the invariant but the function
  // must not blow up. Producer-side validation will catch it.
  expect(kindForEndpoints({ embeddings: {}, chat_completions: {} } as ModelEndpoints))
    .toBe('chat')
})

test('empty object → chat (defensive default)', () => {
  expect(kindForEndpoints({})).toBe('chat')
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test vnext/packages/protocols/src/common/__tests__/model-endpoints.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 3: 提交**

```bash
git add vnext/packages/protocols/src/common/__tests__/model-endpoints.test.ts
git commit -m "test(protocols): cover kindForEndpoints derivations"
```

---

### Task 3: 改 `BindingModel` / `ProviderBinding` 形状

**Files:**
- Modify: `vnext/packages/provider/src/binding.ts`

- [ ] **Step 1: 改写 BindingModel/ProviderBinding**

完整替换 `vnext/packages/provider/src/binding.ts` 内容：

```ts
/**
 * ProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call ModelProvider instance. The shape every routing
 * helper (`enumerateBindingCandidates`, `resolveBinding`, ...) operates on.
 *
 * Plan 2 (Task #27) cutover:
 *   - `BindingModel.endpoints: ModelEndpoints` is now the single source of
 *     truth for per-model endpoint capability.
 *   - `BindingModel.kind` is removed; consumers derive via kindForEndpoints.
 *   - `ProviderBinding.upstreamEndpoints` is removed.
 */
import type { ModelEndpoints, ModelPricing, UpstreamKind } from '@vnext/protocols/common'
import type { ModelProvider } from './types'

/** Per-binding model metadata. */
export interface BindingModel {
  id: string
  displayName?: string
  ownedBy?: string
  created?: number
  endpoints: ModelEndpoints
  limits?: {
    maxOutputTokens?: number
    maxContextWindowTokens?: number
    maxPromptTokens?: number
  }
  cost?: ModelPricing
}

export interface ProviderBinding {
  upstream: string
  kind: UpstreamKind
  model: BindingModel
  enabledFlags: ReadonlySet<string>
  provider: ModelProvider
}
```

- [ ] **Step 2: 提交**

```bash
git add vnext/packages/provider/src/binding.ts
git commit -m "refactor(provider): move endpoints into BindingModel; drop upstreamEndpoints/kind"
```

> 此 commit 后 typecheck 暂时报错（registry/binding/binding-resolver/routes 引用了已删字段），由后续 task 修复。

---

### Task 4: 实现 `copilotModelEndpoints`

**Files:**
- Create: `vnext/packages/provider-copilot/src/endpoints.ts`

- [ ] **Step 1: 创建 endpoints.ts**

```ts
// vnext/packages/provider-copilot/src/endpoints.ts
/**
 * Map a Copilot raw model into a structured ModelEndpoints capability map.
 *
 * Copilot's `/models` exposes:
 *   - `capabilities.type` ∈ {'chat', 'embeddings', ...}
 *   - `capabilities.family` (e.g. 'claude-3.7-sonnet', 'gpt-5', 'o1')
 *   - `capabilities.supports.streaming` etc.
 * It does NOT expose a `supported_endpoints` list (unlike upstream OpenAI),
 * so we infer per-family.
 *
 * Hardcoded workaround: `claude-*` always carries `messages` because Copilot
 * historically routes Anthropic native path even though no `supported_endpoints`
 * field advertises it.
 */
import type { ModelEndpoints } from '@vnext/protocols/common'
import type { Model } from './models'

export function copilotModelEndpoints(model: Model): ModelEndpoints {
  const capType = model.capabilities?.type?.toLowerCase()
  if (capType === 'embeddings' || capType === 'embedding') {
    return { embeddings: {} }
  }

  const id = model.id.toLowerCase()
  const family = (model.capabilities?.family ?? '').toLowerCase()
  const endpoints: ModelEndpoints = {}

  // Anthropic native path — Copilot under-reports this; force-add per workaround.
  if (id.startsWith('claude-') || family.startsWith('claude')) {
    endpoints.messages = {}
    endpoints.messages_count_tokens = {}
  }

  // Reasoning families that prefer Responses API: gpt-5*, o1*, o3*, o4*.
  if (id.startsWith('gpt-5') || /^o[134](-|$)/.test(id)) {
    endpoints.responses = {}
  }

  // chat_completions is universally supported by Copilot's chat type.
  endpoints.chat_completions = {}

  return endpoints
}
```

- [ ] **Step 2: 在 provider-copilot 入口 re-export**

修改 `vnext/packages/provider-copilot/src/index.ts`，追加：

```ts
export { copilotModelEndpoints } from './endpoints'
```

> 若入口文件路径或聚合方式与现有不同，按现有 re-export 风格统一适配（grep 当前 `export.*from` 模式即可）。

- [ ] **Step 3: 提交**

```bash
git add vnext/packages/provider-copilot/src/endpoints.ts vnext/packages/provider-copilot/src/index.ts
git commit -m "feat(provider-copilot): add copilotModelEndpoints with claude-* workaround"
```

---

### Task 5: `copilotModelEndpoints` 单测

**Files:**
- Create: `vnext/packages/provider-copilot/src/__tests__/endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// vnext/packages/provider-copilot/src/__tests__/endpoints.test.ts
import { test, expect } from 'bun:test'
import { copilotModelEndpoints } from '../endpoints'
import type { Model } from '../models'

function makeModel(over: Partial<Model> & { id: string }): Model {
  return {
    id: over.id,
    name: over.name ?? over.id,
    object: 'model',
    vendor: over.vendor ?? 'test',
    version: over.version ?? '1',
    model_picker_enabled: true,
    preview: false,
    capabilities: {
      family: over.capabilities?.family ?? 'gpt-4o',
      type: over.capabilities?.type ?? 'chat',
      limits: over.capabilities?.limits ?? {},
      object: 'model_capabilities',
      supports: over.capabilities?.supports ?? {},
      tokenizer: over.capabilities?.tokenizer ?? 'unknown',
    },
    ...over,
  } as Model
}

test('embeddings type → embeddings only', () => {
  const m = makeModel({ id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } as Model['capabilities'] })
  expect(copilotModelEndpoints(m)).toEqual({ embeddings: {} })
})

test('claude-* family → messages + messages_count_tokens + chat_completions', () => {
  const m = makeModel({ id: 'claude-3-5-sonnet-20241022', capabilities: { family: 'claude-3.5-sonnet', type: 'chat' } as Model['capabilities'] })
  const e = copilotModelEndpoints(m)
  expect(e.messages).toEqual({})
  expect(e.messages_count_tokens).toEqual({})
  expect(e.chat_completions).toEqual({})
})

test('gpt-5 → responses + chat_completions (no messages)', () => {
  const m = makeModel({ id: 'gpt-5-mini', capabilities: { family: 'gpt-5', type: 'chat' } as Model['capabilities'] })
  const e = copilotModelEndpoints(m)
  expect(e.responses).toEqual({})
  expect(e.chat_completions).toEqual({})
  expect(e.messages).toBeUndefined()
})

test('o1 → responses + chat_completions', () => {
  const m = makeModel({ id: 'o1', capabilities: { family: 'o1', type: 'chat' } as Model['capabilities'] })
  const e = copilotModelEndpoints(m)
  expect(e.responses).toEqual({})
  expect(e.chat_completions).toEqual({})
})

test('o3-mini → responses + chat_completions', () => {
  const m = makeModel({ id: 'o3-mini', capabilities: { family: 'o3', type: 'chat' } as Model['capabilities'] })
  const e = copilotModelEndpoints(m)
  expect(e.responses).toEqual({})
})

test('o2-mini (not in {o1,o3,o4}) → chat_completions only', () => {
  const m = makeModel({ id: 'o2-mini', capabilities: { family: 'o2', type: 'chat' } as Model['capabilities'] })
  const e = copilotModelEndpoints(m)
  expect(e.chat_completions).toEqual({})
  expect(e.responses).toBeUndefined()
})

test('plain gpt-4o → chat_completions only', () => {
  const m = makeModel({ id: 'gpt-4o', capabilities: { family: 'gpt-4o', type: 'chat' } as Model['capabilities'] })
  expect(copilotModelEndpoints(m)).toEqual({ chat_completions: {} })
})

test('gemini-1.5-pro → chat_completions only', () => {
  const m = makeModel({ id: 'gemini-1.5-pro', capabilities: { family: 'gemini-1.5', type: 'chat' } as Model['capabilities'] })
  expect(copilotModelEndpoints(m)).toEqual({ chat_completions: {} })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test vnext/packages/provider-copilot/src/__tests__/endpoints.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 3: 提交**

```bash
git add vnext/packages/provider-copilot/src/__tests__/endpoints.test.ts
git commit -m "test(provider-copilot): cover copilotModelEndpoints inference"
```

---

### Task 6: registry.ts 接入新 endpoints 字段

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/providers/registry.ts`

- [ ] **Step 1: 改写 modelToBindingModel + listProviderBindings**

具体改动：
1. 删除 `DEFAULT_ENDPOINTS` 常量（lines 36-40）。
2. 删除 `inferModelKind` 函数（lines 73-80）。
3. import 添加：`import { copilotModelEndpoints } from '@vnext/provider-copilot'`
4. 删除 import 行里的 `EndpointKey, ModelKind`（不再需要），保留 `UpstreamKind`。
5. `modelToBindingModel` 改为：

```ts
function modelToBindingModel(model: ModelsResponse['data'][number]): ProviderBinding['model'] {
  return {
    id: model.id,
    displayName: model.name,
    ownedBy: model.vendor,
    endpoints: copilotModelEndpoints(model as Model),
    limits: model.capabilities?.limits ? {
      maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens,
      maxOutputTokens: model.capabilities.limits.max_output_tokens,
      maxPromptTokens: model.capabilities.limits.max_prompt_tokens,
    } : undefined,
  }
}
```

6. `listProviderBindings` 主循环：删除 `const endpoints = ...DEFAULT_ENDPOINTS...` 与 binding 字面量里的 `upstreamEndpoints: endpoints,`：

```ts
  for (const upstream of upstreams) {
    try {
      const provider = await createProviderFromUpstream(upstream, opts.copilot)
      if (!provider) continue
      const models = await provider.getModels()
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      const disabled = new Set(upstream.disabledPublicModelIds)
      for (const model of models.data ?? []) {
        if (disabled.has(model.id)) continue
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model as Model),
          enabledFlags,
          provider,
        })
      }
    } catch {
      continue
    }
  }
```

7. Fallback 块同样删 `upstreamEndpoints: DEFAULT_ENDPOINTS.copilot,`：

```ts
        bindings.push({
          upstream: 'copilot:request',
          kind: 'copilot',
          model: modelToBindingModel(model as Model),
          enabledFlags,
          provider,
        })
```

- [ ] **Step 2: typecheck registry.ts 通过**

Run: `bun --bun tsc --noEmit -p vnext/apps/gateway/tsconfig.json 2>&1 | grep registry.ts`
Expected: registry.ts 无错误（其它文件可能仍报错，由后续 task 修复）。

- [ ] **Step 3: 提交**

```bash
git add vnext/apps/gateway/src/data-plane/providers/registry.ts
git commit -m "refactor(gateway/registry): populate per-model endpoints via copilotModelEndpoints"
```

---

### Task 7: 实现 `enumerateBindingCandidates`

**Files:**
- Create: `vnext/apps/gateway/src/data-plane/routing/candidates.ts`

- [ ] **Step 1: 创建 candidates.ts**

```ts
// vnext/apps/gateway/src/data-plane/routing/candidates.ts
/**
 * Enumerate bindings that can serve a client request given a per-protocol
 * pickTarget closure. Replaces Plan 1's `chooseBackendEndpoint(model)` +
 * `bindingsForEndpoint(bindings, endpoint)` pattern.
 *
 * Returns `sawModel: true` when the requested model id exists somewhere but
 * no binding produced a target endpoint — caller can return 400 instead of 404.
 */
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'
import { listProviderBindings, type CreateProviderOptions } from '../providers/registry.ts'
import { parseModelRouting } from './binding-resolver.ts'
import type { ProviderBinding } from '@vnext/provider'
import { parseCompositeModelId } from '@vnext/provider-copilot'

export interface BindingCandidate {
  binding: ProviderBinding
  targetEndpoint: EndpointKey
}

export interface EnumerateBindingCandidatesArgs {
  model: string
  pickTarget: (e: ModelEndpoints) => EndpointKey | null
  ownerId?: string
  copilot?: CreateProviderOptions
  pin?: string
}

export interface EnumerateBindingCandidatesResult {
  candidates: BindingCandidate[]
  sawModel: boolean
  bareModel: string
  upstreamPin?: string
}

export async function enumerateBindingCandidates(
  args: EnumerateBindingCandidatesArgs,
): Promise<EnumerateBindingCandidatesResult> {
  const parsed = parseModelRouting(args.model)
  const upstreamPin = args.pin ?? parsed.upstreamPin
  const bareModel = parsed.bareModel
  const composite = parseCompositeModelId(bareModel)
  const acceptedIds = new Set<string>([bareModel])
  if (composite.baseId && composite.baseId !== bareModel) acceptedIds.add(composite.baseId)

  const bindings = await listProviderBindings({ ownerId: args.ownerId, copilot: args.copilot })
  const candidates: BindingCandidate[] = []
  let sawModel = false

  for (const b of bindings) {
    if (!acceptedIds.has(b.model.id)) continue
    if (upstreamPin && b.upstream !== upstreamPin) continue
    sawModel = true
    const target = args.pickTarget(b.model.endpoints)
    if (target) candidates.push({ binding: b, targetEndpoint: target })
  }

  return { candidates, sawModel, bareModel, upstreamPin }
}
```

- [ ] **Step 2: 提交**

```bash
git add vnext/apps/gateway/src/data-plane/routing/candidates.ts
git commit -m "feat(gateway/routing): add enumerateBindingCandidates with per-protocol pickTarget"
```

---

### Task 8: `enumerateBindingCandidates` 单测

**Files:**
- Create: `vnext/apps/gateway/src/data-plane/routing/__tests__/candidates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// vnext/apps/gateway/src/data-plane/routing/__tests__/candidates.test.ts
import { test, expect, mock, beforeEach } from 'bun:test'
import type { ProviderBinding } from '@vnext/provider'
import type { ModelEndpoints, EndpointKey } from '@vnext/protocols/common'

const mockListProviderBindings = mock(async (): Promise<ProviderBinding[]> => [])
mock.module('../../providers/registry.ts', () => ({
  listProviderBindings: mockListProviderBindings,
}))

const { enumerateBindingCandidates } = await import('../candidates.ts')

function mkBinding(over: { upstream?: string; modelId: string; endpoints: ModelEndpoints }): ProviderBinding {
  return {
    upstream: over.upstream ?? 'u1',
    kind: 'copilot',
    model: { id: over.modelId, endpoints: over.endpoints },
    enabledFlags: new Set<string>(),
    provider: { fetch: () => { throw new Error('not used') }, getModels: async () => ({ object: 'list', data: [] }) } as unknown as ProviderBinding['provider'],
  }
}

beforeEach(() => {
  mockListProviderBindings.mockReset()
})

test('messages pickTarget prefers messages over fallbacks', async () => {
  mockListProviderBindings.mockResolvedValue([
    mkBinding({ modelId: 'claude-3-5-sonnet', endpoints: { messages: {}, chat_completions: {} } }),
  ])
  const pickTarget = (e: ModelEndpoints): EndpointKey | null =>
    e.messages ? 'messages' : e.responses ? 'responses' : e.chat_completions ? 'chat_completions' : null
  const r = await enumerateBindingCandidates({ model: 'claude-3-5-sonnet', pickTarget })
  expect(r.candidates.length).toBe(1)
  expect(r.candidates[0].targetEndpoint).toBe('messages')
  expect(r.sawModel).toBe(true)
})

test('chat pickTarget falls back to messages when chat_completions missing', async () => {
  mockListProviderBindings.mockResolvedValue([
    mkBinding({ modelId: 'claude-x', endpoints: { messages: {} } }),
  ])
  const pickTarget = (e: ModelEndpoints): EndpointKey | null =>
    e.chat_completions ? 'chat_completions' : e.messages ? 'messages' : e.responses ? 'responses' : null
  const r = await enumerateBindingCandidates({ model: 'claude-x', pickTarget })
  expect(r.candidates[0].targetEndpoint).toBe('messages')
})

test('count_tokens narrow channel returns null when unsupported', async () => {
  mockListProviderBindings.mockResolvedValue([
    mkBinding({ modelId: 'gpt-4o', endpoints: { chat_completions: {} } }),
  ])
  const pickTarget = (e: ModelEndpoints): EndpointKey | null =>
    e.messages_count_tokens ? 'messages_count_tokens' : null
  const r = await enumerateBindingCandidates({ model: 'gpt-4o', pickTarget })
  expect(r.candidates.length).toBe(0)
  expect(r.sawModel).toBe(true)
})

test('unknown model id → sawModel false, no candidates', async () => {
  mockListProviderBindings.mockResolvedValue([
    mkBinding({ modelId: 'gpt-4o', endpoints: { chat_completions: {} } }),
  ])
  const pickTarget = (): EndpointKey | null => 'chat_completions'
  const r = await enumerateBindingCandidates({ model: 'does-not-exist', pickTarget })
  expect(r.candidates.length).toBe(0)
  expect(r.sawModel).toBe(false)
})

test('upstream pin filters candidates', async () => {
  mockListProviderBindings.mockResolvedValue([
    mkBinding({ upstream: 'u1', modelId: 'gpt-4o', endpoints: { chat_completions: {} } }),
    mkBinding({ upstream: 'u2', modelId: 'gpt-4o', endpoints: { chat_completions: {} } }),
  ])
  const pickTarget = (e: ModelEndpoints): EndpointKey | null =>
    e.chat_completions ? 'chat_completions' : null
  const r = await enumerateBindingCandidates({ model: 'u2/gpt-4o', pickTarget })
  expect(r.candidates.length).toBe(1)
  expect(r.candidates[0].binding.upstream).toBe('u2')
})
```

> ⚠️ Bun `mock.module` 在跨文件复用时不可靠（auto memory `bun_mock_module_unrestorable`）。如果运行时报模块解析错误，把测试改成把假 binding 直接注入到一个本地包装函数 —— 即在测试里 import `enumerateBindingCandidates` 的内部辅助函数（拆出 pure version），或直接重命名本测试文件并改用 dependency injection（给 `enumerateBindingCandidates` 增加 `_listBindings` 注入参数，仅测试用）。优先尝试 mock.module 路径；失败再切换。

- [ ] **Step 2: Run test**

Run: `bun test vnext/apps/gateway/src/data-plane/routing/__tests__/candidates.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 3: 提交**

```bash
git add vnext/apps/gateway/src/data-plane/routing/__tests__/candidates.test.ts
git commit -m "test(gateway/routing): cover enumerateBindingCandidates filtering and pickTarget"
```

---

### Task 9: `bindingServesEndpoint` 改查 `b.model.endpoints`

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routing/binding.ts`

- [ ] **Step 1: 改写**

完整替换 `binding.ts`：

```ts
/**
 * Binding helpers — Plan 2 cutover: serve check now reads
 * `binding.model.endpoints` instead of the deleted `upstreamEndpoints` array.
 */
import type { EndpointKey } from '@vnext/protocols/common'
import type { BindingModel, ProviderBinding } from '@vnext/provider'
export type { BindingModel, ProviderBinding }

export function bindingServesEndpoint(
  binding: ProviderBinding,
  endpoint: EndpointKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(binding.model.endpoints, endpoint)
}

export function bindingsForEndpoint(
  bindings: readonly ProviderBinding[],
  endpoint: EndpointKey,
): ProviderBinding[] {
  return bindings.filter((b) => bindingServesEndpoint(b, endpoint))
}
```

- [ ] **Step 2: 提交**

```bash
git add vnext/apps/gateway/src/data-plane/routing/binding.ts
git commit -m "refactor(gateway/routing): bindingServesEndpoint reads model.endpoints"
```

---

### Task 10: 改写 `binding-resolver.ts`

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routing/binding-resolver.ts`

- [ ] **Step 1: 改写 resolveBinding 与 resolveBindingForRequest**

`parseModelRouting`、`pinFromPayload`、`effectiveFlags`、`stripUpstreamPin` 保持不变；改写 `resolveBinding` / `resolveBindingForRequest`：

```ts
export async function resolveBinding(
  model: string,
  endpoint: EndpointKey,
  opts: ResolveBindingOptions = {},
): Promise<ProviderBinding | null> {
  const parsed = parseModelRouting(model)
  const upstreamPin = opts.pin ?? parsed.upstreamPin
  const bareModel = parsed.bareModel
  const bindings = await listProviderBindings({ ownerId: opts.ownerId, copilot: opts.copilot })
  const candidates = bindingsForEndpoint(bindings, endpoint)
  const matches = (b: ProviderBinding, id: string) =>
    b.model.id === id && (!upstreamPin || b.upstream === upstreamPin)

  const direct = candidates.find((b) => matches(b, bareModel))
  if (direct) return direct

  const composite = parseCompositeModelId(bareModel)
  if (composite.baseId && composite.baseId !== bareModel) {
    const base = candidates.find((b) => matches(b, composite.baseId))
    if (base) return base
  }

  return null
}
```

> 实际上签名/实现与现状一致 —— 仅依赖更新（`bindingsForEndpoint` 内部已改为查 endpoints map）。无需进一步改动；如果 typecheck 通过则直接 commit。`embeddings/routes.ts`、`images/routes.ts`、`orchestrator/.../route-handler.ts` 因仍传 endpoint 字面量调用 `resolveBinding`，无需改动。

- [ ] **Step 2: typecheck**

Run: `bun --bun tsc --noEmit -p vnext/apps/gateway/tsconfig.json 2>&1 | grep -E "binding-resolver|routing/binding\." | head`
Expected: 无错误。

- [ ] **Step 3: 提交（若有改动）**

```bash
git add vnext/apps/gateway/src/data-plane/routing/binding-resolver.ts
git diff --cached --quiet || git commit -m "refactor(gateway/routing): align resolveBinding doc with new endpoints model"
```

> 若 diff 为空，跳过此 commit。

---

### Task 11: routes.ts 三个 entry 改用 `enumerateBindingCandidates`

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: 改写 dispatch 签名 + 各 entry pickTarget**

dispatch 改为接收 `pickTarget` 参数（取代 `chooseBackendEndpoint(bareModel)` + `resolveBinding(model, endpoint, ...)`）。删除 `import { chooseBackendEndpoint }`，新增 `import { enumerateBindingCandidates } from './routing/candidates.ts'`。

dispatch 主体核心改动：

```ts
async function dispatch<TPayload>(
  c: { req: { json: () => Promise<unknown> }; json: (b: unknown, s?: number) => Response; body: (b: BodyInit, s?: number, h?: Record<string, string>) => Response },
  adapter: FrontendAdapter<TPayload>,
  toIR: (payload: TPayload) => IRRequest,
  pickTarget: (e: import('@vnext/protocols/common').ModelEndpoints) => EndpointKey | null,
  errorWrap: (status: number, body: unknown) => Response,
  auth: DataPlaneAuthCtx,
  sourceApi: SourceApi,
): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return errorWrap(400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } })
  }
  let payload: TPayload
  try { payload = adapter.parse(raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return errorWrap(e.status ?? 400, e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } })
  }
  const ir = toIR(payload)
  const requestedModel = ir.model
  const { bareModel } = parseModelRouting(requestedModel)
  if (bareModel !== requestedModel) ir.model = bareModel

  const { candidates, sawModel } = await enumerateBindingCandidates({
    model: requestedModel,
    pickTarget,
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (candidates.length === 0) {
    if (sawModel) {
      return errorWrap(400, { error: { type: 'invalid_request_error', message: `Model "${requestedModel}" exists but does not support this client protocol.` } })
    }
    return errorWrap(404, { error: { type: 'invalid_request_error', message: `No upstream serves model "${requestedModel}". Run GET /v1/models for available ids.` } })
  }
  const { binding, targetEndpoint } = candidates[0]
  const backend = backendForEndpoint(targetEndpoint)
  const upstreamPayload = backend.toUpstream(ir)

  let upstreamRes: Response
  try {
    upstreamRes = await binding.provider.fetch(
      targetEndpoint,
      { method: 'POST', body: JSON.stringify(upstreamPayload), headers: { 'content-type': 'application/json' } },
      { operationName: 'data-plane dispatch', enabledFlags: binding.enabledFlags, sourceApi },
    )
  } catch (err) {
    if (err instanceof HTTPError) return await repackageUpstreamError(err.response, sourceApi)
    const message = err instanceof Error ? err.message : 'upstream error'
    return errorWrap(502, { error: { type: 'api_error', message } })
  }
  if (!upstreamRes.ok) return await repackageUpstreamError(upstreamRes, sourceApi)

  if (ir.stream) {
    const events = upstreamRes.body
      ? backend.decodeSSE(upstreamRes.body)
      : (async function* (): AsyncIterable<IREvent> { /* empty */ })()
    const out = adapter.encodeSSE(events)
    return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  const upstreamJson = await upstreamRes.json()
  const events = backend.decodeBody(upstreamJson)
  const body = await adapter.encodeBody(events)
  return Response.json(body)
}
```

各 entry 改为传 pickTarget 闭包：

```ts
// /v1/messages
const messagesPick = (e: import('@vnext/protocols/common').ModelEndpoints): EndpointKey | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : e.chat_completions ? 'chat_completions' : null

// /v1/chat/completions  和 Gemini
const chatPick = (e: import('@vnext/protocols/common').ModelEndpoints): EndpointKey | null =>
  e.chat_completions ? 'chat_completions' : e.messages ? 'messages' : e.responses ? 'responses' : null

// /v1/responses
const responsesPick = (e: import('@vnext/protocols/common').ModelEndpoints): EndpointKey | null =>
  e.responses ? 'responses' : e.messages ? 'messages' : e.chat_completions ? 'chat_completions' : null
```

把这三个常量定义在文件顶部 import 之后，然后调用点：

```ts
// /v1/messages dispatcher call
return dispatch(
  { ...c, req: { json: async () => raw }, json: c.json.bind(c), body: c.body.bind(c) } as Parameters<typeof dispatch>[0],
  messagesIn,
  (p) => messagesIn.toIR(p),
  messagesPick,
  (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx,
  'messages',
)

// /v1/chat/completions
dispatch(c, chatIn, (p) => chatIn.toIR(p), chatPick, (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx,
  'chat_completions',
)

// /v1/responses
dispatch(
  { ...c, req: { json: async () => raw }, json: c.json.bind(c), body: c.body.bind(c) } as Parameters<typeof dispatch>[0],
  responsesIn,
  (p) => responsesIn.toIR(p),
  responsesPick,
  (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx,
  'responses',
)

// /v1beta/models/:model{.+} (Gemini → 与 chat 同向)
return dispatch(c, geminiIn, (p) => {
  const ir = geminiIn.toIRForModel(p, model ?? '')
  ir.stream = stream
  return ir
}, chatPick, (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx,
  'gemini',
)
```

- [ ] **Step 2: typecheck**

Run: `bun --bun tsc --noEmit -p vnext/apps/gateway/tsconfig.json 2>&1 | head -20`
Expected: 无 routes.ts 相关错误（backend-selector 仍在导致一个 unused import warning 由 Task 12 清理）。

- [ ] **Step 3: 提交**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/routes): inline pickTarget closures via enumerateBindingCandidates"
```

---

### Task 12: 删除 `backend-selector.ts` 与其测试

**Files:**
- Delete: `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts`
- Delete: `vnext/apps/gateway/tests/backend-selector.test.ts`

- [ ] **Step 1: 删除文件**

```bash
git rm vnext/apps/gateway/src/data-plane/routing/backend-selector.ts vnext/apps/gateway/tests/backend-selector.test.ts
```

- [ ] **Step 2: 确认无残留 import**

Run: `grep -rn "backend-selector\|chooseBackendEndpoint" vnext/`
Expected: 无输出。

- [ ] **Step 3: 提交**

```bash
git commit -m "refactor(gateway/routing): drop chooseBackendEndpoint heuristic"
```

---

### Task 13: 全量 typecheck + 测试 + smoke

- [ ] **Step 1: typecheck**

Run: `cd vnext && bun --bun tsc --noEmit -p apps/gateway/tsconfig.json && bun --bun tsc --noEmit -p packages/protocols/tsconfig.json && bun --bun tsc --noEmit -p packages/provider/tsconfig.json && bun --bun tsc --noEmit -p packages/provider-copilot/tsconfig.json`
Expected: 无错误。若某 package 没有独立 tsconfig，按现有 monorepo 命令调整（参考 `vnext/package.json` 的 typecheck 脚本）。

- [ ] **Step 2: 全量单测**

Run: `cd vnext && bun test`
Expected: 所有测试 PASS（Plan 1 留下的 278 测试 + 本 plan 新增的 ~21 测试，应当 ≥ 299 PASS）。

- [ ] **Step 3: smoke (本地真上游)**

启动本地 gateway：

```bash
cd vnext && bun run local
```

在另一个终端跑：

```bash
# chat
curl -sS http://localhost:4141/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' | head -c 200

# messages (Anthropic native)
curl -sS http://localhost:4141/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' | head -c 200

# embeddings
curl -sS http://localhost:4141/v1/embeddings -H 'content-type: application/json' \
  -d '{"model":"text-embedding-3-small","input":"hi"}' | head -c 200
```

Expected: 三条都返回 2xx + 合法 envelope（不是 4xx/5xx）。

- [ ] **Step 4: 终止 server，确认无错误日志**

回到 server 终端，scroll 检查无 `error|panic|unhandled` 关键字。Ctrl-C 终止。

- [ ] **Step 5: 最终 commit / 标记完成**

```bash
git status   # 应当 clean
git log --oneline -15   # 检查 12 个语义 commit 都在
```

> 若 typecheck 或 bun test 失败：定位失败的 task，回到对应 step 修复后再次执行 task 13。**不要** force-push 或 `--no-verify`。

---

## Out of Scope

- Custom / Azure / Codex provider 的 endpoints 推断
- Dashboard endpoint override UI
- Plan 3 的 chat-out 全量与 Claude 字段完整往返
