# Spec 7: @vnext/service 框架包 — Design Spec

**日期:** 2026-06-24
**前置文档:**
- [Clean Gateway Charter](../research/2026-06-24-clean-gateway-charter.md) §4.1 契约 A
- [Charter Rationale](../research/2026-06-24-clean-gateway-charter-rationale.md) §1.1
- [vNext Roadmap](../research/2026-06-23-vnext-roadmap.md) §3 Step 2

---

## 1. 目标(单句)

把 `@vnext/interceptor` 演化为中性的 `@vnext/service` 框架包,泛型顺序对齐 Charter §4.1,切断"框架包→业务包"的反向依赖,LLM 特定类型移出框架边界。

---

## 2. 背景与动机

### 2.1 当前状态

`vnext/packages/interceptor/src/index.ts` 当前已是三参泛型形状 `Interceptor<TInv, TCtx, R>`,但存在 3 个问题:

1. **方向错误的依赖** — 框架包 `@vnext/interceptor` import 业务包 `@vnext/protocols/common`,违反 Charter §6 单向依赖原则
2. **LLM 特定 type alias 污染框架包** — `CopilotInterceptor` / `ChatCompletionsStreamInterceptor` / `MessagesStreamInterceptor` / `ResponsesStreamInterceptor` 4 个 LLM 概念 type alias 与中性泛型放在同一文件
3. **泛型参数顺序与 Charter 不一致** — 当前 `<TInv, TCtx, R>` 等价于 `<Req, Ctx, Result>`;Charter §4.1 定的契约是 `<Ctx, Req, Result>`

### 2.2 Charter 契约 A 引用

```ts
interface Service<Ctx, Req, Result> {
  invoke(req: Req, ctx: Ctx): Promise<Result>;
}
type Interceptor<Ctx, Req, Result> = (
  req: Req,
  ctx: Ctx,
  next: (req: Req) => Promise<Result>,
) => Promise<Result>;
```

Spec 7 的目标是把"中性 Interceptor 契约 + Service interface 占位"以新包 `@vnext/service` 的形式落地,LLM 特定 alias 迁出框架边界。

### 2.3 范围决策(brainstorm 过程中确认)

- **Service interface** — 仅引入占位 interface,Spec 7 不强制 chat-flow terminal handler 改写为 `Service` 实例。真正的 chat-flow 服务化收敛在 Spec 10 与 Codec 一起做。
- **`runInterceptors` helper** — 保留并 re-export,仅做泛型顺序调整,零行为变化。`composeInterceptors`(返回闭包形式)推迟到 Spec 10。
- **`Invocation` / `RequestContext`** — Spec 7 临时迁到 `@vnext/protocols/common`(老 protocols 包),Spec 8 拆分 `@vnext/protocols` → `@vnext/result` + `@vnext/protocols-llm` 时再搬到 protocols-llm。

---

## 3. 包拓扑变化

```
Before:
  @vnext/interceptor          ← 含 LLM type alias + import @vnext/protocols/common(方向错)
  @vnext/protocols/common     ← 中性 ProtocolFrame / ExecuteResult

After:
  @vnext/service              ← 中性 Interceptor<Ctx,Req,Result> + Service interface 占位 + runInterceptors
  @vnext/protocols/common     ← + Invocation + RequestContext + 4 个 LLM alias(Spec 8 时再迁出)
  (@vnext/interceptor 包目录删除)
```

**关键不变量:** `@vnext/service/package.json` 的 dependencies 字段不包含任何 `@vnext/*` 业务包(允许 dev tooling)。

---

## 4. 新包 `@vnext/service` 的 surface

`vnext/packages/service/src/index.ts`:

```ts
/**
 * Domain-neutral around-middleware.
 * Charter §4.1 Contract A (with Spec 7 deviation noted below).
 *
 * NOTE on `next` arity: Charter §4.1 ideal form is `next: (req: Req) => Promise<Result>`,
 * propagating a fresh req down the chain. Current code uses `next: () => Promise<Result>`
 * and mutates shared invocation state. Spec 7 keeps zero-behavior-change: `next` stays
 * `() => Promise<Result>`. Migrating to req-propagation is a separate future spec
 * (breaks all existing interceptor implementations; requires Invocation immutability).
 */
export type Interceptor<Ctx, Req, Result> = (
  req: Req,
  ctx: Ctx,
  next: () => Promise<Result>,
) => Promise<Result>

/**
 * Service interface placeholder. Real terminal-handler wrapping
 * deferred to Spec 10 (chat-flow Codec convergence).
 */
export interface Service<Ctx, Req, Result> {
  invoke(req: Req, ctx: Ctx): Promise<Result>
}

export type Next<R> = () => Promise<R>

/**
 * Compose an interceptor chain with a terminal handler and run it.
 * Behaviorally identical to the legacy @vnext/interceptor.runInterceptors;
 * only the generic parameter order changes to <Ctx, Req, R>.
 */
export const runInterceptors = async <Ctx, Req, R>(
  req: Req,
  ctx: Ctx,
  interceptors: readonly Interceptor<Ctx, Req, R>[],
  terminal: Next<R>,
): Promise<R> => {
  const run = (index: number): Promise<R> =>
    index < interceptors.length
      ? interceptors[index]!(req, ctx, () => run(index + 1))
      : terminal()
  return run(0)
}
```

**Surface 注释:**
- 泛型顺序 `<Ctx, Req, Result>`(Charter 对齐),与当前 `<TInv, TCtx, R>` 顺序互换
- 函数参数顺序 `(req, ctx, next)` 维持当前形式不变(泛型顺序≠参数顺序;泛型描述类型槽位语义,参数描述调用形式)
- `Service` interface 占位,Spec 7 不强制业务采纳
- `package.json` dependencies 字段仅含 dev tooling

---

## 5. `@vnext/protocols/common` 接收的 LLM 类型(从 interceptor 迁入)

新文件 `vnext/packages/protocols/src/common/invocation.ts`:

```ts
import type { EndpointKey } from './index'
import type { ExecuteResult } from './result'
import type { ProtocolFrame } from './sse'
import type { ChatCompletionsStreamEvent } from '../chat'
import type { MessagesStreamEvent } from '../messages'
import type { ResponsesStreamEvent } from '../responses'
import type { Interceptor } from '@vnext/service'

export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  readonly sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  payload: Record<string, unknown>
  headers: Record<string, string>
}

export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
}

export type CopilotInterceptor = Interceptor<RequestContext, Invocation, Response>

export type ChatCompletionsStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>

export type MessagesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>

export type ResponsesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>
```

`vnext/packages/protocols/src/common/index.ts` 添加 `export * from './invocation'`(同时确保 4 个 LLM stream event 类型已被 common 可见或通过路径 import)。

**注意:** 4 个 alias 泛型实参顺序变成 `<Ctx=RequestContext, Req=Invocation, Result=...>`,因为新泛型顺序是 `<Ctx, Req, Result>`。

---

## 6. Consumer 迁移规则

所有当前 `@vnext/interceptor` consumer 统一改动模式(brainstorm 初步 grep 报 21 文件,实际 `rg '@vnext/interceptor' vnext/packages vnext/apps -l` 返回 ~56 文件;实施前以 grep 实测结果为准):

### 6.1 Import 路径调整

```diff
- import { CopilotInterceptor, runInterceptors, Invocation, RequestContext } from '@vnext/interceptor'
+ import { runInterceptors } from '@vnext/service'
+ import { CopilotInterceptor, Invocation, RequestContext } from '@vnext/protocols/common'
```

### 6.2 直接使用 `Interceptor<...>` 泛型时调换实参顺序

```diff
- const fn: Interceptor<Invocation, RequestContext, Response> = ...
+ const fn: Interceptor<RequestContext, Invocation, Response> = ...
```

注意:若实施时 grep 发现 consumer 直接拼 `Interceptor<...>` 泛型,按此规则迁移泛型实参顺序;当前 grep 显示 consumer 普遍使用 type alias(`CopilotInterceptor` 等),无需调换。

### 6.3 Consumer 分布(brainstorm 初估 21 文件;实测 ~56 文件,以 grep 为准)

实施时按以下范围全量 grep `@vnext/interceptor` 并迁移:

- `vnext/packages/gateway/src/**` — chat-flow 各 endpoint 的 attempt.ts / serve.ts / interceptors/types.ts 等
- `vnext/packages/gateway/tests/**`
- `vnext/packages/provider-copilot/src/provider.ts` 及 `src/interceptors/**`(主要消费点,brainstorm 漏统计)
- `vnext/packages/provider-copilot/__tests__/**`
- `vnext/apps/**`(若有)
- 其他 packages(provider-azure / provider-custom / provider-sdf / translate / responses-store)按 grep 结果处理

T6 在执行开始时第一步运行 `rg '@vnext/interceptor' vnext/packages vnext/apps -l` 获取完整列表后再分批迁移。

### 6.4 Package manifest 迁移

以下 `package.json` 文件 `dependencies` 字段需要更新:

| 文件 | 动作 |
|------|------|
| `vnext/packages/service/package.json` | 新建;`dependencies` 留空(无 runtime 依赖)。若包内需要 TS 等 dev tooling,放 `devDependencies` 并优先复用 vnext root devDependencies |
| `vnext/packages/protocols/package.json` | 增加 `"@vnext/service": "workspace:*"`(因 invocation.ts import Interceptor) |
| `vnext/packages/gateway/package.json` | 增加 `"@vnext/service": "workspace:*"`;移除 `"@vnext/interceptor"` |
| `vnext/packages/provider-copilot/package.json` | 增加 `"@vnext/service": "workspace:*"`;移除 `"@vnext/interceptor"` |
| 其他 consumer 包(按 grep 结果) | 同上 |
| `vnext/packages/interceptor/package.json` | T3 阶段保留作兼容层,在原有 `"@vnext/protocols": "workspace:*"` 基础上**新增** `"@vnext/service": "workspace:*"`(re-export 需要);T7 阶段整个包目录删除 |

T7 删除 interceptor 包后必须运行 `bun install` 更新 `vnext/bun.lock`,并 commit lockfile。

---

## 7. Task 分解(交给 writing-plans 落实)

预估 8 task:

1. **T1** 新建 `@vnext/service` 包(`package.json` / `tsconfig.json` / `src/index.ts` + 单元测试 `runInterceptors`)
2. **T2** 在 `@vnext/protocols/common` 增加 `Invocation` / `RequestContext` + 4 个 LLM alias(从 `@vnext/service` import `Interceptor`)
3. **T3** `@vnext/interceptor` 改为从 `@vnext/protocols/common` 与 `@vnext/service` re-export(临时兼容层,保持现有所有 consumer 不破)
4. **T4** 迁移 `gateway` src consumer(~7 文件)
5. **T5** 迁移 `gateway` tests consumer(~7 文件)
6. **T6** 迁移 `provider-copilot` + 其余 consumer
7. **T7** 删除 `@vnext/interceptor` 包目录 + workspace `package.json` 清理
8. **T8** 全验证:tsc(各包独立)+ `bun test` + smoke check(`grep '@vnext/' vnext/packages/service/package.json` 不含 LLM 业务包)

---

## 8. 验收

### 8.1 必须

- `cd vnext && bun test` 全绿,无新增 failing
- `cd vnext/packages/service && bun run typecheck` 独立通过
- `cd vnext/packages/protocols && bun run typecheck` 独立通过
- `cd vnext/packages/gateway && bun run typecheck` 独立通过
- `vnext/packages/service/package.json` 的 `dependencies` 字段不包含任何 `@vnext/*` 包名
- `rg '@vnext/protocols' vnext/packages/service` 返回空(service 包内任何位置——src/、tests、配置文件——都不得依赖 protocols)
- `vnext/packages/interceptor/` 目录不存在
- T7 后运行 `bun install` 更新 `vnext/bun.lock`;`rg '@vnext/interceptor|packages/interceptor' vnext/packages vnext/apps vnext/bun.lock` 返回空

### 8.2 推迟到后续 Spec 验收

- 完整 dependency-cruiser 配置(Spec 9 后,Charter §6 验收项 #1)
- Echo proxy 实验(Spec 11)
- API surface 人工 review(Spec 9 后,Charter §6 验收项 #3)

---

## 9. 不在 Spec 7 范围

- `Service` interface 强制使用 — Spec 10 chat-flow 收敛时一起做
- `composeInterceptors` 返回闭包形式 — Spec 10
- 完整 dependency-cruiser 配置 — Spec 9 后(等所有框架包就位再一次 enforce)
- `Invocation` / `RequestContext` 迁到 `@vnext/protocols-llm` — Spec 8
- `runInterceptors` 改名为 `composeService` 或类似 — Spec 10
- API surface 人工 review — Spec 9 后

---

## 10. 风险与回退

### 10.1 中间状态

T1-T6 实施过程中,`@vnext/interceptor`(re-export 形式)与 `@vnext/service` 短暂并存。所有 consumer 此时可任选 import 路径都能跑。Task 划分确保任意 task 之间均可独立 commit。

### 10.2 回退

每个 task 独立 commit。若 T4-T6 任一批次迁移引入回归:
- 回退该批次 commit
- `@vnext/interceptor` re-export 层仍在,系统继续运行
- 修复后重新迁

若整个 Spec 7 需要回退:
- revert 全部 T1-T7 commit
- baseline tag `vnext-2026-06-23-baseline` 是兜底

### 10.3 已知不确定性

- 是否有 consumer 直接拼 `Interceptor<TInv, TCtx, R>` 而非用 type alias?T4-T6 实施时 grep 全量统计,若超出预期,在 task 执行中拆分。

---

## 11. 决策日志

- **2026-06-24** Spec 7 范围定为"包改名 + 泛型顺序对齐 + LLM alias 迁出 + 切断错误依赖",Service interface 仅占位
- **2026-06-24** `Invocation` / `RequestContext` 临时迁到 `@vnext/protocols/common`,Spec 8 再迁到 protocols-llm
- **2026-06-24** 采用增量迁移路径(Approach 2),每 task 独立 commit
