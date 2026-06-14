# Plan C1 — Provider 工厂表（Plugin 式去中心化）

## Goal

把 `gateway/src/data-plane/providers/registry.ts` 中 `createProviderFromUpstream` 的 `if/else` 链改为基于 `ProviderPlugin` 的工厂表注册，让每个 `@vnext/provider-*` 包自带从 `UpstreamRecord` 构造 `ModelProvider` 的工厂函数。

## Background

现状 `createProviderFromUpstream(upstream, copilot?)`（registry.ts:57-82）按 `upstream.provider` 串 `if/else`：custom → `new CustomProvider(...)`、azure → `new AzureProvider(...)`、sdf → `new SdfProvider(...)`、copilot → 走 `getCachedCopilotToken` + `copilot` fallback。新增 provider 必须改 gateway，违反开闭原则；token-cache 调用反向依赖 gateway 的 `shared/copilot-token-cache.ts`。

Plan B 已落地后，所有 provider 的入口都收敛到 `ModelProvider.fetch(req: ProviderRequest)` 单签名，本 spec 在此基础上把"如何从 stored upstream 构造 provider"也下放到 provider 包。

## Non-Goals

- 不动 `data-plane/routes.ts` 拆分（那是 Plan C2）。
- 不动 `listProviderBindings` / `listUpstreamModels` / `getCachedModels` 的缓存层与遍历语义。
- 不引入运行时插件发现机制（`registerProviderPlugin` 形式的 bootstrap API）。模块加载时静态填表。
- 不动 `genericModelEndpoints` / `modelToBindingModel`（那是 endpoints 推断逻辑，与 factory 无关）。

## Design

### 1. 契约位置

#### 1.1 `UpstreamRecord` 上移到 `@vnext/protocols/common`

当前位于 `packages/gateway/src/shared/repo/types.ts:46-59`。把这个类型上移到 `@vnext/protocols/common`，gateway 通过 `re-export` 保留旧导入路径，避免连锁改动（`UpstreamKind`、`BillingDimension`、`ModelPricing` 早已在 protocols/common，无需迁移）。

理由：plugin 契约需要 `UpstreamRecord` 作为入参类型，不上移就只能 `unknown` narrow，损失类型安全。

#### 1.2 `ProviderPlugin` 契约定义在 `@vnext/provider`

```ts
// packages/provider/src/plugin.ts
import type { UpstreamKind, UpstreamRecord, AccountType } from '@vnext/protocols/common'
import type { ModelProvider } from './types'

export interface ProviderPluginContext {
  /** Copilot 专用：用于在 upstream.config.githubToken 存在时换取 copilot token。
   *  非 Copilot plugin 应忽略此字段。 */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Copilot 专用：upstream 的 token 换取失败 / 无 githubToken 时使用的
   *  per-request fallback。非 Copilot plugin 应忽略。 */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export interface ProviderPlugin {
  readonly kind: UpstreamKind
  /** 从存储行构造 ModelProvider；返回 null 表示该行无法构造 provider
   *  （例如 Copilot 缺 githubToken 又无 fallback）。*/
  createFromUpstream(
    upstream: UpstreamRecord,
    ctx: ProviderPluginContext,
  ): Promise<ModelProvider | null>
}
```

`AccountType` 当前位于 `provider-copilot/src/account-type.ts`，**上移到 `@vnext/protocols/common`**（与 `UpstreamRecord` 对齐），`provider-copilot` 内的 `account-type.ts` 改为从 protocols re-export 以保留旧 import 路径。

### 2. 各 provider 包导出 plugin

#### 2.1 `@vnext/provider-copilot`

```ts
// packages/provider-copilot/src/plugin.ts
import type { ProviderPlugin } from '@vnext/provider'
import type { AccountType } from '@vnext/protocols/common'
import { CopilotProvider } from './provider'

export const copilotProviderPlugin: ProviderPlugin = {
  kind: 'copilot',
  async createFromUpstream(upstream, ctx) {
    const config = upstream.config
    const accountType = (config.accountType as AccountType | undefined) ?? 'individual'
    if (typeof config.githubToken === 'string' && config.githubToken && ctx.getCachedCopilotToken) {
      try {
        const copilotToken = await ctx.getCachedCopilotToken(config.githubToken, accountType)
        return new CopilotProvider({ copilotToken, accountType })
      } catch {
        // fall through to fallback
      }
    }
    if (ctx.copilotFallback) {
      return new CopilotProvider(ctx.copilotFallback)
    }
    return null
  },
}
```

从 `index.ts` re-export：`export { copilotProviderPlugin } from './plugin'`。

#### 2.2 `@vnext/provider-azure` / `provider-custom` / `provider-sdf`（同形）

```ts
// packages/provider-azure/src/plugin.ts
import type { ProviderPlugin } from '@vnext/provider'
import { AzureProvider, type AzureProviderConfig } from './provider'

export const azureProviderPlugin: ProviderPlugin = {
  kind: 'azure',
  async createFromUpstream(upstream) {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  },
}
```

custom/sdf 同形；都不读 ctx。

### 3. Gateway 静态填表

```ts
// packages/gateway/src/data-plane/providers/registry.ts（替换 createProviderFromUpstream 实现）
import type { ProviderPlugin } from '@vnext/provider'
import { copilotProviderPlugin } from '@vnext/provider-copilot'
import { azureProviderPlugin }   from '@vnext/provider-azure'
import { customProviderPlugin }  from '@vnext/provider-custom'
import { sdfProviderPlugin }     from '@vnext/provider-sdf'
import { getCachedCopilotToken } from '../../shared/copilot-token-cache.ts'

const PROVIDER_PLUGINS: ReadonlyMap<UpstreamKind, ProviderPlugin> = new Map(
  [copilotProviderPlugin, azureProviderPlugin, customProviderPlugin, sdfProviderPlugin]
    .map((p) => [p.kind, p] as const),
)

export async function createProviderFromUpstream(
  upstream: UpstreamRecord,
  copilot?: CreateProviderOptions,
): Promise<ModelProvider | null> {
  const plugin = PROVIDER_PLUGINS.get(upstream.provider)
  if (!plugin) return null
  return plugin.createFromUpstream(upstream, {
    getCachedCopilotToken,
    copilotFallback: copilot,
  })
}
```

`createCopilotProvider(opts)` 函数保留（被 `listProviderBindings` 内的 request-scoped Copilot fallback 路径直接使用，跟 plugin 平行；plugin 处理"从 upstream row 构造"，`createCopilotProvider` 处理"从 per-request opts 构造"）。

### 4. 依赖方向修正

修正前：
- gateway → import 4 个 provider 类构造器
- gateway → import `getCachedCopilotToken` 并在 `createProviderFromUpstream` 内部调用（Copilot 专属流程嵌在 gateway 里）
- provider-copilot 不感知 token-cache 的存在

修正后：
- gateway → import 4 个 provider plugin（同等 import 数量）
- gateway → import `getCachedCopilotToken` 仅为传入 ctx；不再读取 `upstream.config.githubToken / accountType`
- provider-copilot plugin 拿到 ctx 后自行决定何时调用 hook、何时回落 fallback —— Copilot 专属流程下沉到 provider 包
- token-cache 实现仍住在 gateway，但调用边界由 ctx 注入

净收益：plugin 契约清晰，gateway 不再握有"如何从 config 取 githubToken / accountType / fallback"的知识。

### 5. 测试

#### 5.1 新增

每个 provider 包加 `__tests__/plugin.test.ts`：

```ts
test('copilotProviderPlugin.kind', () => {
  expect(copilotProviderPlugin.kind).toBe('copilot')
})

test('copilotProviderPlugin.createFromUpstream — githubToken path uses ctx hook', async () => {
  const upstream: UpstreamRecord = {
    id: 'u1', provider: 'copilot', name: 'x', enabled: true, sortOrder: 0,
    config: { githubToken: 'gh_xxx', accountType: 'business' },
    flagOverrides: {}, disabledPublicModelIds: [],
    createdAt: '2026-06-14', updatedAt: '2026-06-14',
  }
  let called = false
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (gh, at) => {
      called = true
      expect(gh).toBe('gh_xxx')
      expect(at).toBe('business')
      return 'tid_aaa'
    },
  })
  expect(called).toBe(true)
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('copilotProviderPlugin.createFromUpstream — falls back when token exchange throws', async () => {
  const upstream: UpstreamRecord = {
    id: 'u1', provider: 'copilot', name: 'x', enabled: true, sortOrder: 0,
    config: { githubToken: 'gh_xxx', accountType: 'individual' },
    flagOverrides: {}, disabledPublicModelIds: [],
    createdAt: '2026-06-14', updatedAt: '2026-06-14',
  }
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async () => { throw new Error('exchange failed') },
    copilotFallback: { copilotToken: 'tid_fb', accountType: 'individual' },
  })
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('copilotProviderPlugin.createFromUpstream — returns null without githubToken AND without fallback', async () => {
  const upstream: UpstreamRecord = {
    id: 'u1', provider: 'copilot', name: 'x', enabled: true, sortOrder: 0,
    config: {},
    flagOverrides: {}, disabledPublicModelIds: [],
    createdAt: '2026-06-14', updatedAt: '2026-06-14',
  }
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {})
  expect(provider).toBeNull()
})
```

azure/custom/sdf：每个一条 `kind` + 一条 `createFromUpstream` 走通 happy path（最小 config），无需 ctx。

#### 5.2 修改

- `packages/gateway/__tests__/registry.test.ts`（如已有 createProviderFromUpstream 用例）：保持现有断言，因为 `createProviderFromUpstream` 签名/语义不变。
- 不删除任何现有测试。

#### 5.3 基线

`bun test`（curated）应保持 Plan B 结尾的 755 pass / 4 fail（4 个 dispatch-observability 既存 flake 与本改动无关）。新增 plugin 测试会让 pass 数增加。

### 6. 改动文件清单

**新增：**
- `packages/protocols/src/common/upstream.ts`（`UpstreamRecord` 类型，由 protocols/index re-export）
- `packages/protocols/src/common/account-type.ts`（`AccountType` 类型，由 protocols/index re-export）
- `packages/provider/src/plugin.ts`（`ProviderPlugin` / `ProviderPluginContext` 契约）
- `packages/provider-copilot/src/plugin.ts`
- `packages/provider-azure/src/plugin.ts`
- `packages/provider-custom/src/plugin.ts`
- `packages/provider-sdf/src/plugin.ts`
- 4 个 provider 包各自的 `__tests__/plugin.test.ts`

**修改：**
- `packages/protocols/src/common/index.ts`：re-export `UpstreamRecord` + `AccountType`
- `packages/gateway/src/shared/repo/types.ts`：`UpstreamRecord` 改为 `re-export from '@vnext/protocols/common'`，保留旧 import 路径
- `packages/provider-copilot/src/account-type.ts`：改为 `re-export from '@vnext/protocols/common'`，保留旧 import 路径
- `packages/provider/src/index.ts`：re-export `ProviderPlugin`
- 4 个 provider 包的 `index.ts`：re-export plugin 实例
- `packages/gateway/src/data-plane/providers/registry.ts`：删 if/else 链 + 新增 `PROVIDER_PLUGINS` Map + 新版 `createProviderFromUpstream`

**删除：** 无。

### 7. 兼容性 / 风险

- `createProviderFromUpstream(upstream, copilot?)` 的对外签名与 null 语义保持不变 → 所有调用点（`listProviderBindings`、control-plane `upstream-probe`）零改动。
- `UpstreamRecord` 上移是 type-only 改动，运行时无影响；旧路径 re-export 后旧 import 继续工作。
- Plugin 静态 import → 4 个 provider 包仍然全部进 bundle，bun build / cfw worker 包大小无变化。
- Token cache 调用边界从直接 import 改为 ctx 注入：`getCachedCopilotToken` 函数本身在 gateway 内不变，仅调用点从 `registry.ts` 内联改成 ctx 字段。

### 8. 验收标准

1. `createProviderFromUpstream` 实现仅含 Map.get + 调 plugin.createFromUpstream（≤10 行非注释代码）。
2. `registry.ts` 内不再有 `if (upstream.provider === 'xxx')` 字串。
3. 4 个 provider 包均导出 `xxxProviderPlugin: ProviderPlugin`。
4. `provider-copilot/src/plugin.ts` 不 import 任何 gateway 代码（依赖方向干净）。
5. `bun test`（curated）pass 数不下降；新增 plugin 测试 ≥ 8 条且全部通过。
6. `bunx tsc --noEmit` 全 pass。

## Out of Scope（追溯）

- routes.ts 618 行拆分 → Plan C2
- `listProviderBindings` 缓存层重构
- 运行时 plugin 发现 / 动态加载
- `genericModelEndpoints` 重构
