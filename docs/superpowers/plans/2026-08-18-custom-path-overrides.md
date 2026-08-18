# Custom pathOverrides + authStyle 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个 custom 上游能同时以不同路径前缀跑 OpenAI 与 Anthropic 协议，并支持 `x-api-key` 认证风格。

**Architecture:** 在 `@vibe-llm/provider-custom` 新建 `config.ts`，承载 `CustomProviderConfig`、`authStyle` 枚举、可覆盖路径 key 清单与 `validateUpstreamPath`。`CustomProvider` 的路径解析从查固定表改为「覆盖优先、count_tokens 从 messages 派生」，认证头从写死 Bearer 改为按 `authStyle` 分支。随后把控制面的 `normalizeCustomConfig` 整体下沉到该包（C-full），最后接通 Dashboard 表单。

**Tech Stack:** Bun + TypeScript monorepo，`bun test`，Hono 控制面，React Dashboard。

**Spec:** `docs/superpowers/specs/2026-08-18-custom-path-overrides-design.md`

**分部分交付：** 第一部分 = provider 包内核；第二部分 = 辅助函数搬迁 + 控制面；第三部分 = Dashboard + i18n + 端到端。每部分独立可测、可提交。

**分支约束：** 全部改动留在 `vNext`，不合入 `main`。

---

## 第一部分：provider 包内核

完成后 `CustomProvider` 已具备完整能力，但还没有任何调用方能配置它（控制面在第二部分接通）。

### 已知的既有缺口（本部分不修）

`packages/gateway/src/control-plane/upstreams/routes.ts:64` 的 `ENDPOINTS` 集合只有 7 项，**缺 `alpha_search`**。因此本部分把 `alpha_search` 列入可覆盖路径 key 后，它在控制面暂时仍无法被声明为 endpoint。这是搬迁前就存在的不一致，第二部分按原样搬运、不顺手修改；如需修，另开任务。

---

### Task 1: `config.ts` — 类型、常量与路径校验

**Files:**
- Create: `vnext/packages/provider-custom/src/config.ts`
- Create: `vnext/packages/provider-custom/src/__tests__/config.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `vnext/packages/provider-custom/src/__tests__/config.test.ts`：

```ts
import { describe, test, expect } from 'bun:test'
import {
  CUSTOM_AUTH_STYLES,
  CUSTOM_PATH_OVERRIDE_KEYS,
  validateUpstreamPath,
} from '../config.ts'

describe('CUSTOM_PATH_OVERRIDE_KEYS', () => {
  test('covers the seven overridable endpoints', () => {
    expect([...CUSTOM_PATH_OVERRIDE_KEYS]).toEqual([
      'chat_completions',
      'responses',
      'messages',
      'embeddings',
      'images_generations',
      'images_edits',
      'alpha_search',
    ])
  })

  test('excludes messages_count_tokens because it derives from messages', () => {
    expect(CUSTOM_PATH_OVERRIDE_KEYS).not.toContain('messages_count_tokens')
  })
})

describe('CUSTOM_AUTH_STYLES', () => {
  test('is exactly bearer/anthropic/none', () => {
    expect([...CUSTOM_AUTH_STYLES]).toEqual(['bearer', 'anthropic', 'none'])
  })
})

describe('validateUpstreamPath', () => {
  test('accepts a plain absolute path', () => {
    expect(validateUpstreamPath('/anthropic/v1/messages', 'pathOverrides.messages'))
      .toBe('/anthropic/v1/messages')
  })

  test('trims surrounding whitespace', () => {
    expect(validateUpstreamPath('  /messages  ', 'p')).toBe('/messages')
  })

  test('rejects a non-string', () => {
    expect(() => validateUpstreamPath(42, 'p')).toThrow(/p must be a string/)
  })

  test('rejects an empty string', () => {
    expect(() => validateUpstreamPath('   ', 'p')).toThrow(/p must not be empty/)
  })

  test('rejects a path without a leading slash', () => {
    expect(() => validateUpstreamPath('v1/messages', 'p')).toThrow(/p must start with \//)
  })

  test('rejects a path longer than 256 chars', () => {
    expect(() => validateUpstreamPath('/' + 'a'.repeat(256), 'p')).toThrow(/p is too long/)
  })

  test('rejects a double slash', () => {
    expect(() => validateUpstreamPath('/a//b', 'p')).toThrow(/must not contain/)
  })

  test('rejects a single-dot segment', () => {
    expect(() => validateUpstreamPath('/a/./b', 'p')).toThrow(/must not contain/)
  })

  test('rejects traversal — this is the security boundary', () => {
    expect(() => validateUpstreamPath('/../../admin', 'p')).toThrow(/must not contain/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd vnext && bun test packages/provider-custom/src/__tests__/config.test.ts
```

预期：FAIL，报 `Cannot find module '../config.ts'`。

- [ ] **Step 3: 写实现**

创建 `vnext/packages/provider-custom/src/config.ts`：

```ts
/**
 * Configuration surface for the generic OpenAI-compatible provider.
 *
 * Lives in its own module (rather than provider.ts) because the gateway's
 * control plane validates these shapes before ever constructing a provider;
 * keeping the schema next to the consumer avoids a second, drifting copy.
 */

import type { EndpointKey, ModelPricing } from '@vibe-llm/protocols/common'

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none'

export const CUSTOM_AUTH_STYLES = [
  'bearer',
  'anthropic',
  'none',
] as const satisfies readonly CustomAuthStyle[]

/**
 * Endpoints whose upstream path may be overridden per-upstream.
 *
 * `messages_count_tokens` is deliberately absent: it is derived by appending
 * `/count_tokens` to the resolved `messages` path, so the two can never drift
 * onto different prefixes.
 */
export const CUSTOM_PATH_OVERRIDE_KEYS = [
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
  'images_generations',
  'images_edits',
  'alpha_search',
] as const satisfies readonly EndpointKey[]

export type CustomPathOverrideKey = (typeof CUSTOM_PATH_OVERRIDE_KEYS)[number]

export interface CustomProviderConfig {
  name: string
  baseUrl: string
  /** Required unless `authStyle` is `'none'`. */
  apiKey?: string
  /** Defaults to `'bearer'`. */
  authStyle?: CustomAuthStyle
  /**
   * Replaces the default path for an endpoint. Paths are appended to
   * `baseUrl` verbatim, so the override carries any version prefix it needs
   * (e.g. `/anthropic/v1/messages`).
   */
  pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>
  defaultHeaders?: Record<string, string>
  endpoints?: readonly EndpointKey[]
  modelsEndpoint?: string
  models?: ReadonlyArray<
    | string
    | { id: string; name?: string; ownedBy?: string }
    | { upstreamModelId: string; cost?: ModelPricing }
  >
}

const MAX_PATH_LENGTH = 256

/**
 * Validate a user-supplied upstream path.
 *
 * The traversal check is a security boundary, not cosmetics: without it an
 * operator with upstream-edit rights could point `/../../admin` at any path
 * under the baseUrl's origin.
 */
export function validateUpstreamPath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const path = value.trim()
  if (!path) throw new Error(`${field} must not be empty`)
  if (!path.startsWith('/')) throw new Error(`${field} must start with /`)
  if (path.length > MAX_PATH_LENGTH) throw new Error(`${field} is too long`)
  if (path.includes('//') || path.includes('/./') || path.includes('/../')) {
    throw new Error(`${field} must not contain //, /./ or /../`)
  }
  return path
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd vnext && bun test packages/provider-custom/src/__tests__/config.test.ts
```

预期：PASS，14 个断言全绿。

- [ ] **Step 5: 类型检查**

```bash
cd vnext/packages/provider-custom && bun run typecheck
```

预期：无输出（`tsc --noEmit` 成功）。

- [ ] **Step 6: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src/config.ts \
        vnext/packages/provider-custom/src/__tests__/config.test.ts
git commit -m "feat(provider-custom): add config module with path override keys and validation"
```

---

### Task 2: `CustomProvider` 采用新的配置类型

把 `CustomProviderConfig` 的定义从 `provider.ts` 移到 `config.ts`（Task 1 已建），`provider.ts` 改为 import，barrel 改为从 `config.ts` 导出。这一步不改任何运行时行为，只是搬家 —— 单独成一个 commit 以便后续两步的 diff 干净。

**Files:**
- Modify: `vnext/packages/provider-custom/src/provider.ts:7-31`
- Modify: `vnext/packages/provider-custom/src/index.ts:9-10`

- [ ] **Step 1: 删除 provider.ts 里的接口定义并改为 import**

把 `vnext/packages/provider-custom/src/provider.ts` 第 7-31 行（`import { BILLING_DIMENSIONS, ... }` 到 `interface CustomProviderConfig { ... }` 结束）替换为：

```ts
import { BILLING_DIMENSIONS, type EndpointKey, type ModelPricing } from '@vibe-llm/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
} from '@vibe-llm/provider-llm'
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vibe-core/http'
import {
  type CustomAuthStyle,
  type CustomPathOverrideKey,
  type CustomProviderConfig,
} from './config.ts'

export type { CustomProviderConfig } from './config.ts'
```

- [ ] **Step 2: 更新 barrel**

把 `vnext/packages/provider-custom/src/index.ts` 第 9-10 行：

```ts
export { CustomProvider } from './provider'
export type { CustomProviderConfig } from './provider'
```

改为：

```ts
export { CustomProvider } from './provider'
export type {
  CustomAuthStyle,
  CustomPathOverrideKey,
  CustomProviderConfig,
} from './config'
export { CUSTOM_AUTH_STYLES, CUSTOM_PATH_OVERRIDE_KEYS, validateUpstreamPath } from './config'
```

- [ ] **Step 3: 跑全包测试确认无回归**

```bash
cd vnext && bun test packages/provider-custom
```

预期：PASS。此步纯搬家，现有测试应一条不变地通过。

- [ ] **Step 4: 类型检查**

```bash
cd vnext/packages/provider-custom && bun run typecheck
```

预期：无输出。若报 `apiKey` 可选导致 `this.apiKey` 类型不匹配，说明 Task 3 尚未做 —— 此时临时不动，先确认只有该处报错，然后直接进 Task 3。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src/provider.ts vnext/packages/provider-custom/src/index.ts
git commit -m "refactor(provider-custom): move CustomProviderConfig into config module"
```

---

### Task 3: 路径解析支持覆盖与派生

**Files:**
- Modify: `vnext/packages/provider-custom/src/provider.ts`（构造函数 + 新增 `resolvePath` + `fetch`）
- Modify: `vnext/packages/provider-custom/src/__tests__/provider.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

在 `vnext/packages/provider-custom/src/__tests__/provider.test.ts` 末尾追加：

```ts
describe('CustomProvider.resolvePath', () => {
  const resolve = (p: CustomProvider, endpoint: string): string =>
    (p as unknown as { resolvePath: (e: string) => string }).resolvePath(endpoint)

  test('falls back to the built-in path table when no override is set', () => {
    const p = new CustomProvider({ name: 'x', baseUrl: 'https://x/v1', apiKey: 'k' })
    expect(resolve(p, 'messages')).toBe('/messages')
    expect(resolve(p, 'chat_completions')).toBe('/chat/completions')
  })

  test('an override replaces the built-in path', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      pathOverrides: { messages: '/anthropic/v1/messages' },
    })
    expect(resolve(p, 'messages')).toBe('/anthropic/v1/messages')
  })

  test('an override on one endpoint leaves the others alone', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x/v1', apiKey: 'k',
      pathOverrides: { messages: '/anthropic/v1/messages' },
    })
    expect(resolve(p, 'chat_completions')).toBe('/chat/completions')
  })

  test('count_tokens derives from the resolved messages path', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      pathOverrides: { messages: '/anthropic/v1/messages' },
    })
    expect(resolve(p, 'messages_count_tokens')).toBe('/anthropic/v1/messages/count_tokens')
  })

  test('count_tokens falls back to the default messages path', () => {
    const p = new CustomProvider({ name: 'x', baseUrl: 'https://x/v1', apiKey: 'k' })
    expect(resolve(p, 'messages_count_tokens')).toBe('/messages/count_tokens')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd vnext && bun test packages/provider-custom/src/__tests__/provider.test.ts
```

预期：FAIL，报 `resolvePath is not a function`。

- [ ] **Step 3: 写实现**

在 `vnext/packages/provider-custom/src/provider.ts` 的类字段区（`private readonly defaultHeaders` 那一组附近）加一个字段：

```ts
  private readonly pathOverrides: Partial<Record<CustomPathOverrideKey, string>>
```

在构造函数里 `this.defaultHeaders = mergeHeaders(cfg.defaultHeaders, undefined)` 之后加：

```ts
    this.pathOverrides = { ...cfg.pathOverrides }
```

新增私有方法（放在 `authHeaders` 之前）：

```ts
  /**
   * `messages_count_tokens` derives from `messages` rather than carrying its
   * own override, so an upstream that serves Anthropic under a non-default
   * prefix gets both endpoints moved in lockstep.
   */
  private resolvePath(endpoint: EndpointKey): string {
    if (endpoint === 'messages_count_tokens') {
      return `${this.resolvePath('messages')}/count_tokens`
    }
    const override = this.pathOverrides[endpoint as CustomPathOverrideKey]
    if (override) return override
    const path = CUSTOM_PATHS[endpoint]
    if (!path) throw new Error(`CustomProvider does not support endpoint: ${endpoint}`)
    return path
  }
```

把 `fetch()` 开头这两行：

```ts
    const path = CUSTOM_PATHS[req.endpoint]
    if (!path) throw new Error(`CustomProvider does not support endpoint: ${req.endpoint}`)
```

替换为：

```ts
    const path = this.resolvePath(req.endpoint)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd vnext && bun test packages/provider-custom
```

预期：PASS，全包绿。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src/provider.ts \
        vnext/packages/provider-custom/src/__tests__/provider.test.ts
git commit -m "feat(provider-custom): resolve upstream paths through pathOverrides"
```

---

### Task 4: 认证风格

**Files:**
- Modify: `vnext/packages/provider-custom/src/provider.ts`（构造函数 + `authHeaders`）
- Modify: `vnext/packages/provider-custom/src/__tests__/provider.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

在 `vnext/packages/provider-custom/src/__tests__/provider.test.ts` 末尾追加：

```ts
describe('CustomProvider auth styles', () => {
  const headers = (p: CustomProvider): Record<string, string> =>
    (p as unknown as { authHeaders: () => Record<string, string> }).authHeaders()

  test('defaults to bearer', () => {
    const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'sk-1' })
    const h = headers(p)
    expect(h['Authorization']).toBe('Bearer sk-1')
    expect(h['x-api-key']).toBeUndefined()
  })

  test('anthropic style sends x-api-key and a version header', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'sk-1', authStyle: 'anthropic',
    })
    const h = headers(p)
    expect(h['x-api-key']).toBe('sk-1')
    expect(h['anthropic-version']).toBe('2023-06-01')
    expect(h['Authorization']).toBeUndefined()
  })

  test('none style sends no credential at all', () => {
    const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', authStyle: 'none' })
    const h = headers(p)
    expect(h['Authorization']).toBeUndefined()
    expect(h['x-api-key']).toBeUndefined()
  })

  test('none style does not require an apiKey', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: 'https://x', authStyle: 'none',
    })).not.toThrow()
  })

  test('bearer style still requires an apiKey', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: 'https://x', authStyle: 'bearer',
    })).toThrow(/apiKey/)
  })

  test('anthropic style still requires an apiKey', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: 'https://x', authStyle: 'anthropic',
    })).toThrow(/apiKey/)
  })

  // Deliberate divergence from copilot-gateway, which guards built-in headers
  // with `if (!headers.has(...))`. vNext keeps last-write-wins so an operator
  // can pin a different anthropic-version. Do not "fix" this back.
  test('defaultHeaders can override the built-in anthropic-version', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'sk-1', authStyle: 'anthropic',
      defaultHeaders: { 'anthropic-version': '2024-01-01' },
    })
    expect(headers(p)['anthropic-version']).toBe('2024-01-01')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd vnext && bun test packages/provider-custom/src/__tests__/provider.test.ts
```

预期：FAIL —— `anthropic style sends x-api-key` 会因为拿到 `Bearer sk-1` 而失败，`none style does not require an apiKey` 会因为构造函数抛错而失败。

- [ ] **Step 3: 写实现**

在类字段区加：

```ts
  private readonly authStyle: CustomAuthStyle
```

把构造函数第一行：

```ts
    if (!cfg.apiKey) throw new Error('Custom provider requires an apiKey')
```

替换为：

```ts
    const authStyle = cfg.authStyle ?? 'bearer'
    if (authStyle !== 'none' && !cfg.apiKey) {
      throw new Error('Custom provider requires an apiKey')
    }
    this.authStyle = authStyle
```

把构造函数里的：

```ts
    this.apiKey = cfg.apiKey
```

替换为：

```ts
    this.apiKey = cfg.apiKey ?? ''
```

把 `authHeaders` 里的 `base` 构造：

```ts
    const base: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
      ...extra,
    }
```

替换为：

```ts
    const base: Record<string, string> = {}
    if (this.authStyle === 'bearer') {
      base['Authorization'] = `Bearer ${this.apiKey}`
    } else if (this.authStyle === 'anthropic') {
      base['x-api-key'] = this.apiKey
      base['anthropic-version'] = '2023-06-01'
    }
    Object.assign(base, this.defaultHeaders, extra)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd vnext && bun test packages/provider-custom
```

预期：PASS。注意既有测试 `throws when apiKey is missing`（传 `apiKey: ''` 且不传 authStyle）仍应通过 —— 缺省 `'bearer'` 依旧强制要求 apiKey。

- [ ] **Step 5: 类型检查**

```bash
cd vnext/packages/provider-custom && bun run typecheck
```

预期：无输出。

- [ ] **Step 6: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src/provider.ts \
        vnext/packages/provider-custom/src/__tests__/provider.test.ts
git commit -m "feat(provider-custom): support bearer/anthropic/none auth styles"
```

---

### 第一部分完成检查

- [ ] `cd vnext && bun test packages/provider-custom` 全绿
- [ ] `cd vnext/packages/provider-custom && bun run typecheck` 无输出
- [ ] `cd vnext && bun test packages/gateway` 全绿（确认放宽 `apiKey` 类型没有波及控制面既有代码）
- [ ] 四个 commit 都在 `vNext` 分支上：`git log --oneline -4`

此时 `CustomProvider` 已完全就绪，但控制面还不接受 `authStyle` / `pathOverrides` 字段（会被 `normalizeCustomConfig` 静默丢弃）—— 那是第二部分。

---

## 第二部分：辅助函数搬迁 + 控制面

完成后，控制面能接受、校验并持久化 `authStyle` / `pathOverrides`，`/api/upstream-probe` 也能用新字段探活。Dashboard 还没有对应输入框（第三部分）。

### 本部分要消除的既有重复

`routes.ts:94-102` 有一个**本地重复定义**的 `interface CustomProviderConfig`，与 `@vibe-llm/provider-custom` 导出的那个并存，靠 `as unknown as` 互转（见 `routes.ts:384`、`routes.ts:473`）。C-full 把 `normalizeCustomConfig` 下沉后，这个本地副本一并删除。

---

### Task 5: 把共享辅助函数提升到 `@vibe-llm/provider-llm`

`parseEndpoints` 与 `normalizeStringRecord` 同时被 custom 和 azure 的 normalizer 使用。custom 的那份要搬进 `provider-custom`，azure 的仍留在 `routes.ts`，所以这两个函数必须落到双方都能 import 的位置。`provider-custom` 已依赖 `provider-llm`，`gateway` 也已依赖 `provider-llm`（`packages/gateway/package.json:33`），无需新增依赖声明。

**纯搬运，不改任何逻辑。** 包括原样保留 `ENDPOINT_KEYS` 缺少 `alpha_search` 这一既有缺口。

**Files:**
- Create: `vnext/packages/provider-llm/src/upstream-config.ts`
- Create: `vnext/packages/provider-llm/src/__tests__/upstream-config.test.ts`
- Modify: `vnext/packages/provider-llm/src/index.ts`

- [ ] **Step 1: 写失败的测试**

创建 `vnext/packages/provider-llm/src/__tests__/upstream-config.test.ts`：

```ts
import { describe, test, expect } from 'bun:test'
import { parseEndpoints, normalizeStringRecord } from '../upstream-config.ts'

describe('parseEndpoints', () => {
  test('returns a copy of the fallback when the value is undefined', () => {
    const fallback = ['chat_completions', 'embeddings'] as const
    const out = parseEndpoints(undefined, fallback)
    expect(out).toEqual(['chat_completions', 'embeddings'])
    expect(out).not.toBe(fallback)
  })

  test('rejects a non-array', () => {
    expect(() => parseEndpoints('messages', [])).toThrow(/endpoints must be an array/)
  })

  test('rejects an unknown endpoint name', () => {
    expect(() => parseEndpoints(['not_an_endpoint'], [])).toThrow(/unknown endpoint: not_an_endpoint/)
  })

  test('deduplicates while preserving order', () => {
    expect(parseEndpoints(['messages', 'chat_completions', 'messages'], []))
      .toEqual(['messages', 'chat_completions'])
  })
})

describe('normalizeStringRecord', () => {
  test('returns undefined for undefined', () => {
    expect(normalizeStringRecord(undefined, 'defaultHeaders')).toBeUndefined()
  })

  test('rejects an array', () => {
    expect(() => normalizeStringRecord([], 'defaultHeaders'))
      .toThrow(/defaultHeaders must be an object/)
  })

  test('rejects a non-string value and names the offending key', () => {
    expect(() => normalizeStringRecord({ 'x-a': 1 }, 'defaultHeaders'))
      .toThrow(/defaultHeaders\.x-a must be a string/)
  })

  test('passes a valid record through', () => {
    expect(normalizeStringRecord({ 'x-a': 'b' }, 'defaultHeaders')).toEqual({ 'x-a': 'b' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd vnext && bun test packages/provider-llm/src/__tests__/upstream-config.test.ts
```

预期：FAIL，报 `Cannot find module '../upstream-config.ts'`。

- [ ] **Step 3: 写实现**

创建 `vnext/packages/provider-llm/src/upstream-config.ts`（内容逐字取自 `routes.ts:146-156` 与 `routes.ts:193-205`）：

```ts
/**
 * Shared validation helpers for upstream provider configs.
 *
 * These live here rather than in the gateway's control plane because both
 * the control plane (azure) and @vibe-llm/provider-custom (custom) need
 * them, and a second copy would drift.
 */

import type { EndpointKey } from '@vibe-llm/protocols/common'

/**
 * NOTE: `alpha_search` is deliberately absent — this set is moved verbatim
 * from the control plane, which never accepted it. Adding it is a behaviour
 * change and belongs in its own task.
 */
export const ENDPOINT_KEYS = new Set<EndpointKey>([
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
] as const satisfies readonly EndpointKey[])

export function parseEndpoints(value: unknown, fallback: readonly EndpointKey[]): EndpointKey[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new Error('endpoints must be an array')
  const endpoints = value.map((v) => {
    if (typeof v !== 'string' || !ENDPOINT_KEYS.has(v as EndpointKey)) {
      throw new Error(`unknown endpoint: ${String(v)}`)
    }
    return v as EndpointKey
  })
  return [...new Set(endpoints)]
}

export function normalizeStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new Error(`${field}.${k} must be a string`)
    out[k] = v
  }
  return out
}
```

在 `vnext/packages/provider-llm/src/index.ts` 末尾追加一行：

```ts
export * from './upstream-config'
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd vnext && bun test packages/provider-llm
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-llm/src/upstream-config.ts \
        vnext/packages/provider-llm/src/__tests__/upstream-config.test.ts \
        vnext/packages/provider-llm/src/index.ts
git commit -m "refactor(provider-llm): host shared upstream config validation helpers"
```

---

### Task 6: `normalizeCustomConfig` 下沉到 `provider-custom`

**Files:**
- Modify: `vnext/packages/provider-custom/src/config.ts`（追加 `parseManualModels` + `normalizeCustomConfig`）
- Modify: `vnext/packages/provider-custom/src/index.ts`（导出 `normalizeCustomConfig`）
- Modify: `vnext/packages/provider-custom/src/__tests__/config.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

在 `vnext/packages/provider-custom/src/__tests__/config.test.ts` 顶部的 import 改为：

```ts
import {
  CUSTOM_AUTH_STYLES,
  CUSTOM_PATH_OVERRIDE_KEYS,
  normalizeCustomConfig,
  validateUpstreamPath,
} from '../config.ts'
```

并在文件末尾追加：

```ts
describe('normalizeCustomConfig', () => {
  const base = { name: 'ds', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-1' }

  test('trims the name and strips trailing slashes from baseUrl', () => {
    const out = normalizeCustomConfig({ ...base, name: '  ds  ' })
    expect(out.name).toBe('ds')
    expect(out.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  test('defaults endpoints to chat_completions + embeddings', () => {
    expect(normalizeCustomConfig({ ...base }).endpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('requires a name', () => {
    expect(() => normalizeCustomConfig({ ...base, name: '  ' })).toThrow(/config.name required/)
  })

  test('requires a baseUrl', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: '' })).toThrow(/config.baseUrl required/)
  })

  test('defaults authStyle to bearer', () => {
    expect(normalizeCustomConfig({ ...base }).authStyle).toBe('bearer')
  })

  test('rejects an unknown authStyle', () => {
    expect(() => normalizeCustomConfig({ ...base, authStyle: 'x-api-key' }))
      .toThrow(/config.authStyle must be one of bearer, anthropic, none/)
  })

  test('requires an apiKey when authStyle is bearer', () => {
    expect(() => normalizeCustomConfig({ ...base, apiKey: '' })).toThrow(/config.apiKey required/)
  })

  test('allows a missing apiKey when authStyle is none', () => {
    const out = normalizeCustomConfig({ name: 'x', baseUrl: 'https://x', authStyle: 'none' })
    expect(out.authStyle).toBe('none')
    expect(out.apiKey).toBeUndefined()
  })

  test('accepts and preserves valid pathOverrides', () => {
    const out = normalizeCustomConfig({
      ...base,
      pathOverrides: { messages: '/anthropic/v1/messages' },
    })
    expect(out.pathOverrides).toEqual({ messages: '/anthropic/v1/messages' })
  })

  test('drops an empty pathOverrides object', () => {
    expect(normalizeCustomConfig({ ...base, pathOverrides: {} }).pathOverrides).toBeUndefined()
  })

  test('rejects an unknown pathOverrides key', () => {
    expect(() => normalizeCustomConfig({ ...base, pathOverrides: { bogus: '/x' } }))
      .toThrow(/unknown pathOverrides key: bogus/)
  })

  test('rejects messages_count_tokens and explains the derivation', () => {
    expect(() => normalizeCustomConfig({
      ...base,
      pathOverrides: { messages_count_tokens: '/x/count_tokens' },
    })).toThrow(/derived from the messages path/)
  })

  test('rejects a traversal path override', () => {
    expect(() => normalizeCustomConfig({ ...base, pathOverrides: { messages: '/../admin' } }))
      .toThrow(/must not contain/)
  })

  test('rejects a non-object pathOverrides', () => {
    expect(() => normalizeCustomConfig({ ...base, pathOverrides: [] }))
      .toThrow(/pathOverrides must be an object/)
  })

  test('coerces manual models from both string and object form', () => {
    const out = normalizeCustomConfig({ ...base, models: ['m1', { id: 'm2', name: 'Two' }] })
    expect(out.models).toEqual([{ id: 'm1' }, { id: 'm2', name: 'Two', ownedBy: undefined }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd vnext && bun test packages/provider-custom/src/__tests__/config.test.ts
```

预期：FAIL，报 `normalizeCustomConfig is not a function`。

- [ ] **Step 3: 写实现**

在 `vnext/packages/provider-custom/src/config.ts` 的 import 区追加：

```ts
import { parseEndpoints, normalizeStringRecord } from '@vibe-llm/provider-llm'
```

在文件末尾追加（`parseManualModels` 逐字取自 `routes.ts:206-240`；`normalizeCustomConfig` 取自 `routes.ts:251-269` 并加入两段新校验）：

```ts
const AUTH_STYLE_SET = new Set<string>(CUSTOM_AUTH_STYLES)
const PATH_OVERRIDE_KEY_SET = new Set<string>(CUSTOM_PATH_OVERRIDE_KEYS)

function parseManualModels(value: unknown): CustomProviderConfig['models'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error('models must be an array of strings or { id, name?, ownedBy? }')
  }
  const out: Array<{ id: string; name?: string; ownedBy?: string }> = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (!id) throw new Error('models[] entry must be a non-empty string')
      out.push({ id })
      continue
    }
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      const e = entry as { id: string; name?: unknown; ownedBy?: unknown }
      const id = e.id.trim()
      if (!id) throw new Error('models[].id must be a non-empty string')
      const name = typeof e.name === 'string' ? e.name : undefined
      const ownedBy = typeof e.ownedBy === 'string' ? e.ownedBy : undefined
      out.push({ id, name, ownedBy })
      continue
    }
    throw new Error('models[] entry must be a string or { id, name?, ownedBy? } object')
  }
  return out.length > 0 ? out : undefined
}

function parseAuthStyle(value: unknown): CustomAuthStyle {
  if (value === undefined || value === null) return 'bearer'
  if (typeof value !== 'string' || !AUTH_STYLE_SET.has(value)) {
    throw new Error(`custom config.authStyle must be one of ${CUSTOM_AUTH_STYLES.join(', ')}`)
  }
  return value as CustomAuthStyle
}

function parsePathOverrides(
  value: unknown,
): Partial<Record<CustomPathOverrideKey, string>> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('custom config.pathOverrides must be an object')
  }
  const out: Partial<Record<CustomPathOverrideKey, string>> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'messages_count_tokens') {
      throw new Error(
        'pathOverrides.messages_count_tokens is not settable — it is derived from the messages path',
      )
    }
    if (!PATH_OVERRIDE_KEY_SET.has(k)) throw new Error(`unknown pathOverrides key: ${k}`)
    out[k as CustomPathOverrideKey] = validateUpstreamPath(v, `pathOverrides.${k}`)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Validate and canonicalize a raw custom-upstream config from the control
 * plane. Throws with a user-facing message on any violation.
 */
export function normalizeCustomConfig(config: Record<string, unknown>): CustomProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) {
    throw new Error('custom config.name required')
  }
  if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
    throw new Error('custom config.baseUrl required')
  }
  const authStyle = parseAuthStyle(config.authStyle)
  const apiKey = typeof config.apiKey === 'string' && config.apiKey ? config.apiKey : undefined
  if (authStyle !== 'none' && !apiKey) throw new Error('custom config.apiKey required')
  const modelsEndpoint =
    typeof config.modelsEndpoint === 'string' && config.modelsEndpoint.trim()
      ? config.modelsEndpoint.trim()
      : undefined
  return {
    name: config.name.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey,
    authStyle,
    pathOverrides: parsePathOverrides(config.pathOverrides),
    endpoints: parseEndpoints(config.endpoints, ['chat_completions', 'embeddings']),
    modelsEndpoint,
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, 'defaultHeaders'),
    models: parseManualModels(config.models),
  }
}
```

在 `vnext/packages/provider-custom/src/index.ts` 的 config 导出行追加 `normalizeCustomConfig`：

```ts
export {
  CUSTOM_AUTH_STYLES,
  CUSTOM_PATH_OVERRIDE_KEYS,
  normalizeCustomConfig,
  validateUpstreamPath,
} from './config'
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd vnext && bun test packages/provider-custom
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src/config.ts \
        vnext/packages/provider-custom/src/index.ts \
        vnext/packages/provider-custom/src/__tests__/config.test.ts
git commit -m "feat(provider-custom): own custom upstream config normalization"
```

---

### Task 7: 控制面改用下沉后的 normalizer

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/upstreams/routes.ts`

- [ ] **Step 1: 更新 import**

把 `routes.ts:47-48`：

```ts
import { CustomProvider } from '@vibe-llm/provider-custom'
import type { CustomProviderConfig as PkgCustomConfig } from '@vibe-llm/provider-custom'
```

替换为：

```ts
import { CustomProvider, normalizeCustomConfig } from '@vibe-llm/provider-custom'
```

并在 provider 相关 import 附近追加：

```ts
import { parseEndpoints, normalizeStringRecord } from '@vibe-llm/provider-llm'
```

- [ ] **Step 2: 删除本地副本**

从 `routes.ts` 删除这五处：

1. `const ENDPOINTS = new Set<EndpointKey>([...])`（第 64-72 行）
2. `interface CustomProviderConfig { ... }`（第 94-102 行）
3. `function parseEndpoints(...)`（第 146-156 行）
4. `function normalizeStringRecord(...)`（第 193-205 行）
5. `function parseManualModels(...)`（第 206-240 行）
6. `function normalizeCustomConfig(...)`（第 251-269 行）

`normalizeAzureConfig` 继续调用 `parseEndpoints` / `normalizeStringRecord`，此时解析到新 import 的版本，无需改动函数体。

- [ ] **Step 3: 去掉两处失效的类型转换**

`routes.ts:473`（`upstream-probe` 处理器内）：

```ts
        ? new CustomProvider(normalizeCustomConfig(config as Record<string, unknown>) as PkgCustomConfig)
```

改为：

```ts
        ? new CustomProvider(normalizeCustomConfig(config as Record<string, unknown>))
```

`routes.ts:384`（`normalizeConfig` 分发器内）保持 `as unknown as Record<string, unknown>` 不变 —— 它是为了把结构化配置塞回 `Record`，与本次改动无关。

- [ ] **Step 4: 跑网关全量测试**

```bash
cd vnext && bun test packages/gateway
```

预期：PASS。特别关注 `packages/gateway/tests/control-plane-upstreams.test.ts` 里既有的 custom 与 azure 用例 —— 它们验证搬迁没有改变行为。

- [ ] **Step 5: 类型检查**

```bash
cd vnext/packages/gateway && bun run typecheck
```

预期：无输出。若报 `EndpointKey` 未使用，从 `routes.ts:32` 的 type import 里移除它。

- [ ] **Step 6: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/control-plane/upstreams/routes.ts
git commit -m "refactor(gateway): consume custom config normalization from provider package"
```

---

### Task 8: 控制面接受新字段的回归测试

**Files:**
- Modify: `vnext/packages/gateway/tests/control-plane-upstreams.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

在 `vnext/packages/gateway/tests/control-plane-upstreams.test.ts` 末尾追加：

```ts
test('POST /api/upstreams custom with pathOverrides + authStyle → 201', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'deepseek',
      config: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-secret',
        authStyle: 'anthropic',
        endpoints: ['chat_completions', 'messages'],
        pathOverrides: { messages: '/anthropic/v1/messages' },
      },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(201)
  const body = await res.json() as any
  expect(body.upstream.config.authStyle).toBe('anthropic')
  // pathOverrides is not secret-shaped, so it round-trips unredacted for the form
  expect(body.upstream.config.pathOverrides).toEqual({ messages: '/anthropic/v1/messages' })
  expect(body.upstream.config.apiKey).toBe('***')
})

test('POST /api/upstreams custom with a traversal path override → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'evil',
      config: {
        name: 'evil',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-1',
        pathOverrides: { messages: '/../../admin' },
      },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
  const body = await res.json() as any
  expect(body.error).toMatch(/must not contain/)
})

test('PATCH /api/upstreams/:id clears pathOverrides with an empty object', async () => {
  const created = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'ds',
      config: {
        name: 'ds',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-1',
        pathOverrides: { messages: '/anthropic/v1/messages' },
      },
    }),
    headers: { 'content-type': 'application/json' },
  })
  const id = ((await created.json()) as any).upstream.id

  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ config: { pathOverrides: {} } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstream.config.pathOverrides).toBeUndefined()
  // the shallow merge preserved everything the PATCH did not mention
  expect(body.upstream.config.baseUrl).toBe('https://api.deepseek.com/v1')
})
```

- [ ] **Step 2: 跑测试**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-upstreams.test.ts
```

预期：PASS —— Task 6/7 已提供全部实现，这三条是回归锁。若 `clears pathOverrides` 失败，检查 PATCH 的浅合并循环（`routes.ts:573-580`）是否被误改。

- [ ] **Step 3: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/tests/control-plane-upstreams.test.ts
git commit -m "test(gateway): lock control-plane handling of pathOverrides and authStyle"
```

---

### 第二部分完成检查

- [ ] `cd vnext && bun test` 全绿（全仓库，确认搬迁未波及其他包）
- [ ] `cd vnext/packages/gateway && bun run typecheck` 无输出
- [ ] `grep -n "normalizeCustomConfig\|parseManualModels" vnext/packages/gateway/src/control-plane/upstreams/routes.ts` 只剩调用、无定义
- [ ] 四个 commit 都在 `vNext` 分支上

此时用 `curl` 直接 POST `/api/upstreams` 已可配出目标形态的上游，但 Dashboard 表单还没有输入框 —— 那是第三部分。

## 第三部分：Dashboard + i18n + 端到端

前两部分做完，后端已经能接受并正确使用 `authStyle` 与 `pathOverrides`，但只能用 `curl`
配置。本部分把它们接到 Dashboard 表单上，并用一个端到端测试证明"同一个 custom 上游、
两个协议、两个前缀、两种认证同时工作"这个核心命题。

### 本部分要注意的三件事

1. **Dashboard 没有测试。** `apps/dashboard/package.json` 只有 `typecheck` 和 `build`
   两个脚本，没有 test。所以 Task 10-12 的验证手段是 `bun run typecheck` + 第三部分末尾
   的本地 docker 手工验证，而不是单元测试。不要为此新建测试框架。

2. **PATCH 是浅合并。** `routes.ts` 的 config 合并逐 key 覆盖顶层字段，所以
   `pathOverrides` 是整体替换而非逐 key 合并。表单每次保存都必须发送 7 个框的完整当前
   状态。这与文件里 `sdfTuning()` 上方那段注释描述的是同一个约束（"a partial `taxonomy`
   would replace, not merge"），照着它的做法来。

3. **dashboard bundle 是构建产物。** `packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/`
   下的文件不进版本库，docker 镜像内 `RUN bun run build:ui` 时重建。改完 tsx 后本地看效果
   必须重新构建镜像或重跑 `bun run build:ui`，直接改文件刷新页面是看不到的。

---

### Task 9: i18n 文案

**Files:**
- Modify: `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`（en 块 488 行后、zh 块 1236 行后）

这个文件是一个巨大的 `translations = { en: {...}, zh: {...} }` 字面量，被包在模板字符串里
注入到 `<head>`。两个语言块的 key 集合必须一致。

- [ ] **Step 1: 在 en 块加入 7 个 key**

找到 en 块里这一行（约 488 行）：

```
      "dash.manualModelListHint": "One id per line, optional # label. If non-empty, the upstream's /v1/models probe is skipped and these entries are exposed verbatim.",
```

在它**后面**插入：

```
      "dash.authStyleLabel": "Auth style",
      "dash.authStyleHint": "How the API key is sent upstream. Anthropic-native endpoints expect x-api-key instead of a bearer token.",
      "dash.authStyleBearer": "Bearer (Authorization header)",
      "dash.authStyleAnthropic": "Anthropic (x-api-key)",
      "dash.authStyleNone": "None (no credentials sent)",
      "dash.pathOverridesLabel": "Path overrides (advanced)",
      "dash.pathOverridesHint": "Leave blank to use the default shown in each box. Paths are appended to baseUrl verbatim, so use these when one vendor serves different protocols under different prefixes (e.g. DeepSeek's /anthropic/v1/messages). The count_tokens path always follows whatever messages resolves to.",
```

- [ ] **Step 2: 在 zh 块加入同样的 7 个 key**

找到 zh 块里这一行（约 1236 行）：

```
      "dash.manualModelListHint": "每行一个 ID，可选 # 标签。若非空，则跳过此上游的 /v1/models 探测，原样使用这些条目。",
```

在它**后面**插入：

```
      "dash.authStyleLabel": "认证方式",
      "dash.authStyleHint": "API key 以何种方式发给上游。原生 Anthropic 端点要的是 x-api-key，不是 bearer token。",
      "dash.authStyleBearer": "Bearer（Authorization 头）",
      "dash.authStyleAnthropic": "Anthropic（x-api-key）",
      "dash.authStyleNone": "无认证（不发送凭据）",
      "dash.pathOverridesLabel": "路径覆盖（高级）",
      "dash.pathOverridesHint": "留空则使用各输入框中显示的默认值。路径会原样拼在 baseUrl 之后，适用于同一厂商把不同协议挂在不同前缀下的情况（例如 DeepSeek 的 /anthropic/v1/messages）。count_tokens 路径始终跟随 messages 的解析结果。",
```

- [ ] **Step 3: 验证两个语言块 key 数量一致**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/gateway/src/shared/edge/ui-pages
grep -c '"dash.authStyleLabel"' i18n.ts
grep -c '"dash.pathOverridesHint"' i18n.ts
```

期望：两条命令都输出 `2`（en 一份、zh 一份）。若输出 `1`，说明漏了一个语言块。

- [ ] **Step 4: 类型检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/gateway && bun run typecheck
```

期望：无输出。

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "i18n(dashboard): add auth style and path override copy"
```

---

### Task 10: 表单状态与认证方式下拉框

**Files:**
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`

- [ ] **Step 1: 在 `FormState` 里加两个字段**

找到 `interface FormState`（18 行），在 `endpoints: string[]` 那一行**后面**加：

```ts
  authStyle: string
  pathOverrides: Record<string, string>
```

`authStyle` 用 `string` 而非联合类型：它来自 `<select>` 的 `e.target.value`，后端已经在
`parseAuthStyle` 里做了枚举校验，前端再收紧类型只会让 `update()` 的泛型难写。

- [ ] **Step 2: 在文件顶部加入路径覆盖的元数据**

在 `SERVED_ENDPOINTS`（81 行）**后面**加：

```ts
// The 7 override-able endpoint keys and their provider-side defaults.
// messages_count_tokens is absent on purpose — it derives from messages.
const PATH_OVERRIDE_KEYS = [
  ["chat_completions", "/chat/completions"],
  ["responses", "/responses"],
  ["messages", "/messages"],
  ["embeddings", "/embeddings"],
  ["images_generations", "/images/generations"],
  ["images_edits", "/images/edits"],
  ["alpha_search", "/alpha/search"],
] as const
```

- [ ] **Step 3: 给 `EMPTY` 加默认值**

找到 `const EMPTY: FormState`（57 行），在 `endpoints: ["chat_completions", "embeddings"],`
那一行**后面**加：

```ts
  authStyle: "bearer",
  pathOverrides: {},
```

- [ ] **Step 4: 让编辑模式回填这两个字段**

`redactConfig` 的正则是 `/token|apikey|api_key|authorization|password|secret/i`，
`authStyle` 与 `pathOverrides` 都不命中，所以 GET 回来的 `config` 里它们是原值，可以直接回填。

在 `buildInitial` 的返回对象里（`endpoints:` 那一大块**后面**、`modelsText,` **前面**）加：

```ts
      authStyle:
        u.provider === "custom" && typeof (cfg as { authStyle?: string }).authStyle === "string"
          ? (cfg as { authStyle: string }).authStyle
          : "bearer",
      pathOverrides:
        u.provider === "custom" && (cfg as { pathOverrides?: Record<string, string> }).pathOverrides
          ? { ...(cfg as { pathOverrides: Record<string, string> }).pathOverrides }
          : {},
```

- [ ] **Step 5: 在 custom 分支渲染认证方式下拉框**

找到 custom 的 baseUrl / apiKey 两个 `Field`（427-448 行）。在 apiKey 那个 `Field` 的
`</Field>` **后面**、`</>` **前面**插入：

```tsx
            <Field label={t("dash.authStyleLabel")}>
              <select
                value={form.authStyle}
                onChange={(e) => update("authStyle", e.target.value)}
                className={inputCls}
              >
                <option value="bearer">{t("dash.authStyleBearer")}</option>
                <option value="anthropic">{t("dash.authStyleAnthropic")}</option>
                <option value="none">{t("dash.authStyleNone")}</option>
              </select>
              <span className="text-xs text-themed-dim block mt-1">{t("dash.authStyleHint")}</span>
            </Field>
```

- [ ] **Step 6: 类型检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/dashboard && bun run typecheck
```

期望：无输出。（此时 `pathOverrides` 状态字段已存在但还没有 UI 读它——那是 Task 11。
未使用的接口成员不会触发 `noUnusedLocals`。）

- [ ] **Step 7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx
git commit -m "feat(dashboard): add auth style selector to the custom upstream form"
```

---

### Task 11: 路径覆盖折叠区

**Files:**
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`

- [ ] **Step 1: 加一个 setter**

在 `toggleEndpoint`（240-244 行）**后面**加：

```tsx
  const setPathOverride = (key: string, value: string) =>
    setForm((f) => {
      const next = { ...f.pathOverrides }
      if (value.trim()) next[key] = value
      else delete next[key]
      return { ...f, pathOverrides: next }
    })
```

空值直接从对象里删除，这样 `form.pathOverrides` 的键集合始终等于"用户真正填了内容的
那些框"，提交时无需再过滤。

- [ ] **Step 2: 渲染折叠区**

找到 custom 的手动模型列表那个 `div`（621-637 行），在它的 `) : null}` **后面**插入：

```tsx
        {provider === "custom" ? (
          <details className="border-t border-themed pt-3 mt-3">
            <summary className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2 cursor-pointer">
              {t("dash.pathOverridesLabel")}
            </summary>
            <p className="text-xs text-themed-dim mb-2">{t("dash.pathOverridesHint")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {PATH_OVERRIDE_KEYS.map(([key, fallback]) => (
                <Field key={key} label={key}>
                  <input
                    value={form.pathOverrides[key] ?? ""}
                    onChange={(e) => setPathOverride(key, e.target.value)}
                    onBlur={(e) => setPathOverride(key, e.target.value.trim())}
                    placeholder={fallback}
                    className={`${inputCls} font-mono text-xs`}
                  />
                </Field>
              ))}
            </div>
          </details>
        ) : null}
```

用原生 `<details>` 而不是自建 `useState` 折叠：它默认收起、无需额外状态、键盘可达，
且这个文件里没有现成的折叠组件可复用。

placeholder 用的是 provider 侧的真实默认值，所以留空时的行为一眼可见。

- [ ] **Step 3: 类型检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/dashboard && bun run typecheck
```

期望：无输出。

- [ ] **Step 4: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx
git commit -m "feat(dashboard): add collapsible path override inputs for custom upstreams"
```

---

### Task 12: 提交逻辑

**Files:**
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`（`submit` 内 307-319 与 360-365）

- [ ] **Step 1: create 分支——apiKey 变为条件必填，并带上新字段**

把 `submit` 里 create 的 custom 分支（307-319 行）整段替换为：

```tsx
        if (provider === "custom") {
          const needsKey = form.authStyle !== "none"
          if (!form.baseUrl.trim() || (needsKey && !form.apiKey.trim())) {
            toast(t("dash.errBaseUrlApiKeyRequired"), "error")
            return
          }
          config = {
            name: form.name.trim(),
            baseUrl: form.baseUrl.trim(),
            endpoints: form.endpoints,
            authStyle: form.authStyle,
            pathOverrides: form.pathOverrides,
          }
          if (form.apiKey.trim()) (config as { apiKey: string }).apiKey = form.apiKey.trim()
          const models = parseModelsText(form.modelsText)
          if (models) (config as { models: unknown }).models = models
        } else if (provider === "sdf") {
```

`apiKey` 从无条件写入改为"填了才写"：`authStyle: 'none'` 时它可以完全不出现，后端
`normalizeCustomConfig` 只在 `authStyle !== 'none'` 时才要求它。

- [ ] **Step 2: edit 分支——同样带上新字段**

把 `submit` 里 edit 的 custom 分支（360-365 行）整段替换为：

```tsx
        if (provider === "custom") {
          if (form.baseUrl.trim()) (config as { baseUrl: string }).baseUrl = form.baseUrl.trim()
          if (form.apiKey.trim()) (config as { apiKey: string }).apiKey = form.apiKey.trim()
          ;(config as { endpoints: string[] }).endpoints = form.endpoints
          ;(config as { authStyle: string }).authStyle = form.authStyle
          // Top-level merge is shallow, so this replaces rather than merges —
          // an empty object is how the user clears every override.
          ;(config as { pathOverrides: Record<string, string> }).pathOverrides = form.pathOverrides
          const models = parseModelsText(form.modelsText)
          ;(config as { models: unknown }).models = models ?? []
        } else if (provider === "sdf") {
```

`pathOverrides` 无条件整体发送（哪怕是 `{}`），这正是清空覆盖的路径：`{}` 被后端
`parsePathOverrides` 归一为 `undefined`，浅合并写进去后覆盖消失。

`apiKey` 保持"填了才发"——留空表示沿用旧值，这是编辑模式既有的语义，不要动。

- [ ] **Step 3: 类型检查**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/dashboard && bun run typecheck
```

期望：无输出。

- [ ] **Step 4: 全仓库测试仍然全绿**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test
```

期望：全绿。（Dashboard 无测试，这一步是确认前两部分没有被 i18n 改动波及。）

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx
git commit -m "feat(dashboard): submit auth style and path overrides for custom upstreams"
```

---

### Task 13: 端到端测试

**Files:**
- Create: `vnext/packages/gateway/tests/integration/custom-path-overrides.test.ts`

这是整个计划的收口：一个 DeepSeek 形态的假上游，两个协议走两个前缀、两种认证。

harness 照抄 `tests/integration/cross-protocol-cc-to-messages.test.ts`：真实 Hono app +
打桩 `Repo.upstreams.list` + 覆盖 `globalThis.fetch`。

- [ ] **Step 1: 写测试文件**

```ts
/**
 * 上游同时以两个前缀提供两种协议 —— DeepSeek 形态。
 *
 * baseUrl 下 OpenAI 协议在裸路径（/chat/completions），Anthropic 协议在
 * /anthropic/v1/messages。authStyle: 'anthropic' 意味着两条路都用 x-api-key。
 * 断言的是 URL 与认证头这两件事，不是响应体内容。
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../src/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'deepseek-chat'

const deepseekShapedUpstream = (): UpstreamRecord => ({
  id: 'up_custom_pathoverride',
  provider: 'custom',
  name: 'fake-deepseek',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'fake-deepseek',
    baseUrl: 'https://example.test',
    apiKey: 'sk-fake',
    authStyle: 'anthropic',
    endpoints: ['chat_completions', 'messages'],
    pathOverrides: { messages: '/anthropic/v1/messages' },
    models: [MODEL_ID],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

const originalFetch = globalThis.fetch

interface Captured {
  url: string
  authorization: string | null
  apiKeyHeader: string | null
  anthropicVersion: string | null
}

function installFetchCapture(): { last: () => Captured | null } {
  let last: Captured | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    last = {
      url: req.url,
      authorization: req.headers.get('authorization'),
      apiKeyHeader: req.headers.get('x-api-key'),
      anthropicVersion: req.headers.get('anthropic-version'),
    }
    if (url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.endsWith('/messages')) {
      return new Response(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL_ID,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { last: () => last }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

function boot() {
  initRepo(stubRepo([deepseekShapedUpstream()]))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  return installFetchCapture()
}

test('chat_completions keeps the bare prefix', async () => {
  const cap = boot()
  const res = await buildApp({}).fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  }), env)
  expect(res.status).toBe(200)

  const c = cap.last()
  expect(c).not.toBeNull()
  expect(c!.url).toBe('https://example.test/chat/completions')
})

test('messages lands on the overridden prefix', async () => {
  const cap = boot()
  const res = await buildApp({}).fetch(new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }), env)
  expect(res.status).toBe(200)

  const c = cap.last()
  expect(c).not.toBeNull()
  expect(c!.url).toBe('https://example.test/anthropic/v1/messages')
})

test('both prefixes authenticate with x-api-key, never a bearer token', async () => {
  const cap = boot()
  const app = buildApp({})

  await app.fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  }), env)
  const openai = cap.last()!
  expect(openai.apiKeyHeader).toBe('sk-fake')
  expect(openai.authorization).toBeNull()
  expect(openai.anthropicVersion).toBe('2023-06-01')

  await app.fetch(new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }), env)
  const anthropic = cap.last()!
  expect(anthropic.apiKeyHeader).toBe('sk-fake')
  expect(anthropic.authorization).toBeNull()
})
```

`models: [MODEL_ID]` 让 `getModels()` 短路，不去打 `/models`，捕获到的就只有真正的推理
请求。第三个测试断言 `authorization` 为 `null` 而不只是断言 `x-api-key` 存在——若将来
有人把两种头都发出去，只断言前者是发现不了的。

- [ ] **Step 2: 跑测试，确认通过**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/gateway
bun test tests/integration/custom-path-overrides.test.ts
```

期望：3 pass。

若 `messages` 那条断言拿到的是 `https://example.test/messages`，说明 Task 3 的
`resolvePath` 没有生效；若拿到 `Authorization: Bearer sk-fake`，说明 Task 4 的
`authHeaders` 没有生效。这两个方向的失败各自指向明确的上游任务。

- [ ] **Step 3: 全仓库测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test
```

期望：全绿。

- [ ] **Step 4: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/tests/integration/custom-path-overrides.test.ts
git commit -m "test(gateway): prove one custom upstream serves two protocols at two prefixes"
```

---

### Task 14: 本地 docker 验证

不写代码，纯手工验收。前 13 个 task 都完成后做。

- [ ] **Step 1: 构建并启动**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
docker compose build && docker compose up -d
```

镜像内的 `RUN bun run build:ui` 会重建 dashboard bundle，Task 10-12 的 tsx 改动经由这一步
才会出现在页面上。若跳过重建直接刷新页面，看到的是旧 UI。

- [ ] **Step 2: 在 UI 里配一个 DeepSeek 上游**

打开 dashboard → Upstreams → Add → Custom，填：

- Name: `deepseek`
- baseUrl: `https://api.deepseek.com`（注意**不带** `/v1`，因为要靠覆盖表达两个前缀）
- API key: 真实 key
- 认证方式: `Anthropic（x-api-key）`
- Served endpoints: 勾 `chat_completions` 和 `messages`
- 展开"路径覆盖（高级）"，`chat_completions` 填 `/v1/chat/completions`，
  `messages` 填 `/anthropic/v1/messages`，其余留空

保存。

- [ ] **Step 3: 重新打开表单，确认回填正确**

点该上游的编辑按钮，确认：

- 认证方式仍显示 `Anthropic（x-api-key）`
- 展开路径覆盖后，两个填过的框显示保存的值，其余五个显示灰色 placeholder

这一步验证的是 Task 10 Step 4 的回填逻辑与 `redactConfig` 不会误伤这两个字段。

- [ ] **Step 4: 校验错误路径**

把 `messages` 改成 `/../admin` 并保存。期望：toast 报错，提到 `/../`，记录未被修改。
改回 `/anthropic/v1/messages` 再保存。

- [ ] **Step 5: 清空覆盖**

把两个框都清空并保存，重新打开表单，确认七个框都空（显示 placeholder）。
再填回去并保存——这一步验证 PATCH 的整体替换语义两个方向都正确。

- [ ] **Step 6: 真实连通性（由用户手工完成）**

本机 `api.deepseek.com` 被 DNS 劫持到 `6.6.0.246`，agent 无法验证。由用户在
dashboard 选中 DeepSeek 模型各发一条消息（一次走 OpenAI 协议、一次走 Anthropic 协议），
确认不再返回 `upstream returned 404`。

---

### 第三部分完成检查

- [ ] `cd vnext && bun test` 全绿
- [ ] `cd vnext/apps/dashboard && bun run typecheck` 无输出
- [ ] `cd vnext/packages/gateway && bun run typecheck` 无输出
- [ ] 本地 docker 里能配出目标上游、能回填、能清空、非法路径被拒
- [ ] 全部 commit 都在 `vNext` 分支上，**未**合入 `main`
- [ ] 用户已手工确认真实 DeepSeek 连通

---

## 明确不做（来自 spec）

- `customProviderPlugin.createFromUpstream` 忽略注入的 `fetcher`，导致 custom 上游不走
  代理链 —— 独立缺陷，另开
- 生产 D1 中 DeepSeek 记录的 `responses` 端点声明是错的（DeepSeek 无 Responses API）——
  数据问题而非代码问题，代码上线后在 UI 中修正
- `routes.ts` 的 `ENDPOINTS` 集合缺 `alpha_search` —— 既有缺口，第二部分原样搬迁，不修
- CFW 部署 —— 需用户单独确认
