# Custom 上游的 pathOverrides 与 authStyle

日期：2026-08-18
分支：`vNext`（不合入 `main`）

## 问题

CFW 生产环境上配置的 DeepSeek 上游，在选中 DeepSeek 模型发消息时返回：

```json
{"error":{"type":"invalid_request_error","message":"upstream returned 404"}}
```

追查链路：生产 D1 里 `up_custom_deepseek_8c5acfbc` 声明的 `endpoints` 是
`["embeddings","responses","messages"]`。`genericModelEndpoints()` 据此把模型的可用端点
标为 `{responses, messages}`。客户端发 `/v1/messages`，`selectPair('messages', …)` 按
`PREFERENCE` 选中 `messages` 目标，`CustomProvider` 拼出
`https://api.deepseek.com` + `/messages` → 404 空体 →
`repackage.ts:41` 把它变成 `upstream returned 404`。

但 DeepSeek 确实支持 Anthropic 协议，只是挂在不同前缀下：

| 协议 | 真实路径 |
|---|---|
| OpenAI | `https://api.deepseek.com/v1/chat/completions` |
| Anthropic | `https://api.deepseek.com/anthropic/v1/messages` |

所以这不是"DeepSeek 不兼容"，是 vNext 的 `CustomProvider` 表达不了这种形态：它只有
一个 `baseUrl` 加一张固定的 `CUSTOM_PATHS` 路径表，无法让 `messages` 和
`chat_completions` 落在不同前缀上。参考项目 `/Users/zhangxian/projects/copilot-gateway`
用 `pathOverrides` + `authStyle` 解决了同样的问题。

## 目标

一个 custom 上游能同时以不同路径前缀跑 OpenAI 与 Anthropic 协议，并支持
Anthropic 风格的 `x-api-key` 认证。

## 已锁定的决策

1. **范围** = `pathOverrides` + `authStyle`，**不做** `modelsFetch` 开关。
   理由：vNext 已有 `modelsEndpoint` 可指定模型列表地址；且 `getModels()` 在手工
   `models` 非空时直接短路，根本不会去打 `/models`。开关是多余的。

2. **路径语义** = 保持 vNext 现有约定：`baseUrl` 自带版本前缀，默认路径是裸 key
   （`/chat/completions`），覆盖值整体替换裸 key。
   拒绝了参考项目的 `` `/v1${key}` `` 默认，因为 vNext 存量记录的 `baseUrl` 多以
   `/v1` 结尾，改用那套会拼出 `/v1/v1/chat/completions`。当前选择的迁移成本为零。

3. **可覆盖的 key** = 7 个：`chat_completions`、`responses`、`messages`、`embeddings`、
   `images_generations`、`images_edits`、`alpha_search`。
   `messages_count_tokens` **不可直接覆盖**，它从解析后的 `messages` 路径派生
   （追加 `/count_tokens`）。

4. **authStyle** = 三值 `bearer | anthropic | none`，缺省 `bearer`。

5. **验收** = 单元测试 + 本地 docker；真实 DeepSeek 由用户在 dashboard 手工验证
   （本机 `api.deepseek.com` 被 DNS 劫持到 `6.6.0.246`，无法联通）。

6. **架构** = 方案 C-full：把 custom 配置校验整体下沉到 `@vibe-llm/provider-custom`，
   `routes.ts` 里的 `normalizeCustomConfig` 删除并改为 import。

## 第一部分：provider 包

### 新文件 `packages/provider-custom/src/config.ts`

```ts
export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none'

// messages_count_tokens 不在内，它从 messages 派生
export const CUSTOM_PATH_OVERRIDE_KEYS = [
  'chat_completions', 'responses', 'messages',
  'embeddings', 'images_generations', 'images_edits', 'alpha_search',
] as const satisfies readonly EndpointKey[]
```

`CustomProviderConfig` 的变化：

```ts
authStyle?: CustomAuthStyle                                   // 缺省 'bearer'
pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>
apiKey?: string                                               // 原为必填 string
```

`apiKey` 从必填放宽为可选，是为了支持 `authStyle: 'none'`。已确认 `config.apiKey`
只被 `CustomProvider` 自身读取，放宽的影响是封闭的。

### 路径解析（替换 `provider.ts:151`）

```ts
private resolvePath(endpoint: EndpointKey): string {
  if (endpoint === 'messages_count_tokens') {
    return `${this.resolvePath('messages')}/count_tokens`
  }
  return this.pathOverrides[endpoint] ?? CUSTOM_PATHS[endpoint]
}
```

派生而非独立覆盖，保证 count_tokens 永远跟随 messages 所在的前缀。

### 认证头（替换 `provider.ts:169` 的 `authHeaders()` 主体）

```ts
const base: Record<string, string> = {}
if (this.authStyle === 'bearer') {
  base['Authorization'] = `Bearer ${this.apiKey}`
} else if (this.authStyle === 'anthropic') {
  base['x-api-key'] = this.apiKey!
  base['anthropic-version'] = '2023-06-01'
}
Object.assign(base, this.defaultHeaders, extra)   // 顺序不变
```

**与参考项目的刻意分叉**：参考项目用 `if (!headers.has(...))` 守卫，使内置值不可被
覆盖。vNext 保持"后者覆盖前者"，让 `defaultHeaders` 仍能覆盖 `anthropic-version`。
这一点必须由测试锁住。

`getModels()` 共用 `authHeaders()`，所以模型列表请求会自动带上正确的认证风格。

## 第二部分：控制面与 Dashboard

### 辅助函数搬迁（C-full 的代价）

`normalizeCustomConfig` 依赖三个辅助函数：

| 函数 | 当前位置 | 使用方 |
|---|---|---|
| `parseManualModels` | `routes.ts:206` | 仅 custom |
| `normalizeStringRecord` | `routes.ts:193` | custom + azure |
| `parseEndpoints` | `routes.ts:146` | custom + azure |

处置：`parseManualModels` 随 `normalizeCustomConfig` 迁入 `provider-custom`；
`normalizeStringRecord` 与 `parseEndpoints` 提升到 `@vibe-llm/provider-llm`，
`routes.ts` 与 `provider-custom` 各自 import。纯搬运，无逻辑变化。azure 侧只改
import，靠现有测试确认不回归。

### 路径校验

```ts
function validateUpstreamPath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const p = value.trim()
  if (!p) throw new Error(`${field} must not be empty`)
  if (!p.startsWith('/')) throw new Error(`${field} must start with /`)
  if (p.length > 256) throw new Error(`${field} is too long`)
  if (p.includes('//') || p.includes('/./') || p.includes('/../')) {
    throw new Error(`${field} must not contain //, /./ or /../`)
  }
  return p
}
```

规则照抄参考项目 `join.ts`。`/../` 一条是安全边界：缺了它，有权编辑上游的人可以用
`/../../admin` 把请求打到 baseUrl 域名下的任意路径。

### `normalizeCustomConfig` 的新增校验

1. `authStyle` 缺省 `'bearer'`，只接受三个枚举值，其余抛错
2. `pathOverrides` 逐 key 校验：key 必须属于 `CUSTOM_PATH_OVERRIDE_KEYS`
   （出现 `messages_count_tokens` 时抛错，错误信息说明它派生自 `messages`），
   value 过 `validateUpstreamPath`。空对象归一成 `undefined`
3. `apiKey` 的必填性由无条件改为 `authStyle !== 'none'` 时必填

### Dashboard 表单（`UpstreamFormModal.tsx`）

**认证方式** — select，三项：Bearer / Anthropic (x-api-key) / 无认证。选"无认证"时，
第 295-385 行 submit 逻辑里 create 分支的 apiKey 必填校验放开。

**路径覆盖** — 7 个可选输入框，收在默认折叠的"高级"区域内。每个的 placeholder 是
当前默认值（`/chat/completions`、`/messages` 等），让人一眼看出不填时的行为。

**PATCH 语义** — `routes.ts:560-600` 的 config 合并是浅合并，因此 `pathOverrides` 是
整体替换而非逐 key 合并。表单每次提交都发送 7 个框的完整当前值（空值不发），
全空则发 `{}`、被 normalize 丢成 `undefined`，等价于清空所有覆盖。

**回显** — `redactConfig`（`routes.ts:390`）的正则是
`/token|apikey|api_key|authorization|password|secret/i`，`pathOverrides` 与 `authStyle`
都不命中，会原样返回给表单，编辑时可正确回填。这是期望行为：路径不是秘密。

### i18n

`packages/gateway/src/shared/edge/ui-pages/i18n.ts` 新增 7 个 key（en + zh 各一份）：
`dash.authStyleLabel`、`dash.authStyleHint`、`dash.authStyleBearer`、
`dash.authStyleAnthropic`、`dash.authStyleNone`、
`dash.pathOverridesLabel`、`dash.pathOverridesHint`。

## 第三部分：测试与验收

### provider-custom 单元测试

`validateUpstreamPath` 的拒绝集，逐条断言：非字符串、空串、`v1/messages`（缺前导斜杠）、
超 256 字符、`/a//b`、`/a/./b`、`/../admin`。

`normalizeCustomConfig` 新逻辑：缺省 authStyle 为 `'bearer'`；`'x-api-key'` 之类非法值
抛错；`pathOverrides` 含 `messages_count_tokens` 抛错且错误信息提及派生关系；空对象归一
为 `undefined`；`authStyle: 'none'` 无 apiKey 通过，`'bearer'` 无 apiKey 抛错。

`CustomProvider.resolvePath`：无覆盖时 `messages → /messages`；覆盖
`{ messages: '/anthropic/v1/messages' }` 时 `messages → /anthropic/v1/messages`
**且** `messages_count_tokens → /anthropic/v1/messages/count_tokens`。

`authHeaders`：三种 style 各断言一次头部集合；外加一条——
`defaultHeaders: { 'anthropic-version': '2024-01-01' }` 能覆盖内置的 `2023-06-01`。
这条锁住上文那个刻意分叉，防止将来有人"修"回守卫写法而无人察觉。

### gateway 控制面测试

POST 带 `pathOverrides` + `authStyle: 'anthropic'` 的 custom 上游能落库；非法路径返回
400 且错误信息可读；PATCH 传 `pathOverrides: {}` 能清空既有覆盖。

### 端到端

一条 DeepSeek 形态的 fake upstream：`baseUrl: https://example.test`、
`endpoints: ['chat_completions','messages']`、
`pathOverrides: { messages: '/anthropic/v1/messages' }`、`authStyle: 'anthropic'`。
用打桩 fetch 断言两件事：

- `/v1/chat/completions` 打到 `https://example.test/chat/completions`，带 `Authorization: Bearer`
- `/v1/messages` 打到 `https://example.test/anthropic/v1/messages`，带 `x-api-key`

同一个 custom 上游、两个协议、两个前缀、两种认证同时工作——这就是本设计要证明的命题。

### 交付标准

`bun test` 全绿；本地 docker 起来后能在 UI 里配出该上游、保存、重新打开表单看到覆盖值
正确回填。真实 DeepSeek 联通性由用户手工验证。

## 明确不做

- `customProviderPlugin.createFromUpstream` 忽略注入的 `fetcher`，导致 custom 上游不走
  代理链——独立缺陷，另开
- 生产 D1 中 DeepSeek 记录的 `responses` 端点声明是错的（DeepSeek 无 Responses API）——
  数据问题而非代码问题，代码上线后在 UI 中修正
- CFW 部署等用户单独确认
