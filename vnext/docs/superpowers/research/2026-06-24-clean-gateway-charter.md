# Clean Gateway Charter — vNext 框架宪章

**日期:** 2026-06-24
**前置文档:**
- [Gateway Abstractions Research (2026-06-23)](./2026-06-23-gateway-abstractions-research.md)
- [vNext Roadmap (2026-06-23)](./2026-06-23-vnext-roadmap.md)
- [LLM Gateway Prior Art (2026-06-24)](./2026-06-24-llm-gateway-prior-art.md)
- [Modern Proxy Abstractions (2026-06-24)](./2026-06-24-modern-proxy-abstractions.md)
- [Charter Rationale (附录)](./2026-06-24-clean-gateway-charter-rationale.md)

---

## 1. 目标(单句)

把 vNext 从"组织良好的 LLM 代理"演进为**"域中性的 gateway 框架 + 在它之上的 LLM 业务"**,两者在**包边界**上物理分离,框架对 LLM 一无所知,业务通过框架契约扩展。

---

## 2. 不做的事

| 不做 | 原因 |
|------|------|
| 显式 Phase + PDK(Kong 7 phase / Pingora 30 方法风格) | 当前 interceptor 数量人脑能 hold;Pingora god trait 是反例;无第三方插件生态 |
| Policy Attachment (GEP-713 风格) | 单租户 proxy 用不到;增复杂度无收益 |
| xDS 风格 Config Plane | D1 + admin routes 已是简易 config plane;够用,渐进扩展即可 |
| `@vnext/proxy` 独立包(底层 TCP/TLS dialer) | `fetch` + `Bun.serve` / Workers 已够 |
| 抽 cache 进 Service 核心 | Pingora 教训:cache 内嵌核心是反模式;cache 当作普通框架包 |
| 每 endpoint 文件爆炸(Portkey 17 文件 × 80 provider) | 我们走 Spec 10 chat-flow 收敛,template 化 |

---

## 3. 框架必须支持的业务 Pattern

这是 LLM 业务对框架契约的**功能性输入**——框架的设计必须能容纳这些 pattern,但**不会内置任何一条**。

| # | 业务 Pattern | 框架支持点 |
|---|--------------|-----------|
| 1 | **Cartesian translator pair**(source × target 笛卡尔展开,PREFERENCE 选 pair) | 中性"binding 候选枚举 + selector"抽象;framework 不知 translator |
| 2 | **Multi-candidate fallback**(model 在多 upstream 都能跑,按序尝试) | "candidate 列表 + 顺序消费"是框架抽象;排序策略业务层 |
| 3 | **Per-request inheritedHeaders 透传**(cross-protocol attempt 链中上层 invocation 的 header 要传到下层) | Service 契约的 ctx 或 invocation 字段能承载任意 header bundle |
| 4 | **Pre-attempt short-circuit**(web search / image generation 在 attempt 前直接出结果) | Service 契约允许 interceptor / pre-attempt 短路返回 ExecuteResult |
| 5 | **Stateful sidecar**(Responses items 持久化到 D1) | Platform 包提供 sql / file / background;业务自管表 schema |
| 6 | **Telemetry context per-binding**(每个 candidate 各自的 PerformanceTelemetryContext) | ExecuteResult 携带 `performance` 字段;framework 类型不知 metric 业务语义 |
| 7 | **Type-safe streaming events**(类型化 ProtocolFrame,不透传 bytes) | Framework 提供 `ExecuteResult<ProtocolFrame<T>>` 泛型 |
| 8 | **Translator error as terminal frame**(translate 失败生成符合源协议的 SSE error 流) | Framework 的 ExecuteResult union 支持 "upstream-error + body bytes" 与 "events" 两态 |
| 9 | **Twin runtime**(同份业务码 Bun + CFW Workers) | @vnext/platform 已抽象 env / sql / file / background / runtime-location |
| 10 | **Control plane 业务表**(api-keys, copilot-quota, upstreams, token-usage, web tests) | Platform 提供 sql;framework 不感知业务表 schema |

---

## 4. 框架核心契约(Final Topology)

```
框架层 (domain-neutral)
  @vnext/platform        runtime 抽象 (env/sql/file/background)
  @vnext/http            HTTP 工具
  @vnext/cache           通用 cache
  @vnext/result          ExecuteResult<T> / ProtocolFrame<T> / PerformanceTelemetryContext
  @vnext/service         Service<Ctx, Req, Result> 三参泛型 + interceptor 三参泛型
  @vnext/upstream        Plugin<TBinding,TConfig> / Binding / candidate enumeration
  apps/platform-*        listener 入口 (bun / cloudflare)

业务层 (LLM vertical)
  @vnext/protocols-llm   4 个 LLM 协议形状 (chat/messages/responses/gemini)
  @vnext/translate       LLM 协议笛卡尔翻译 (PREFERENCE pair selector)
  @vnext/provider-llm    在 @vnext/upstream 之上叠 model.id / limits / pricing
  @vnext/provider-{copilot,azure,custom,sdf}
  @vnext/responses-store Responses stateful items
  @vnext/gateway         data-plane (4 endpoint chat-flow) + control-plane
```

### 4.1 五个核心契约

#### 契约 A — `Service<Ctx, Req, Result>`

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

- 域中性,三参泛型
- Interceptor 是 around-middleware,可短路(不调 `next` 直接返回 Result)
- 灵感:Tower `Service<Req>` + 当前 vNext 自带的 around-middleware 形状
- LLM 业务用 `Service<GatewayCtx, ChatCompletionsInvocation, ExecuteResult<...>>` 实例化

#### 契约 B — `ExecuteResult<T>`

```ts
type ExecuteResult<T> =
  | { type: 'events'; events: AsyncIterable<T>; performance: PerformanceTelemetryContext; headers: Headers }
  | { type: 'upstream-error'; status: number; headers: Headers; body: Uint8Array; performance: PerformanceTelemetryContext }
  | { type: 'internal-error'; error: Error }
```

- 域中性 union(events / upstream-error / internal-error)
- 所有 variant 都带 `performance` —— 即使短路也有遥测
- 灵感:LLM gateway 共识(typed stream parts)+ Pingora "总会跑 logging 钩子"
- `T` 由业务实例化(LLM 业务用 `ProtocolFrame<ChatCompletionsStreamEvent>`)

#### 契约 C — `Plugin<TBinding, TConfig>`

```ts
interface Plugin<TBinding, TConfig> {
  readonly kind: string;
  resolveBindings(config: TConfig, ctx: PluginContext): Promise<TBinding[]>;
}
interface Binding {
  readonly upstream: string;
  readonly fetcher: typeof fetch;
}
```

- 中性的"上游契约":一个 plugin 解析 config 出 binding 列表
- `TBinding` 由 vertical 扩展(LLM 业务把 `model.id / limits / pricing` 叠在 `Binding` 之上)
- 灵感:LLM gateway 的 provider 三元组共识 + Tower Service 关联类型
- Framework 不感知 model / pricing

#### 契约 D — Codec / Filter 分离

```ts
interface Codec<TInbound, TOutbound, TFrame> {
  decodeRequest(raw: Request): TInbound;
  encodeResponse(events: AsyncIterable<TFrame>): Response;
}
```

- Codec 管"协议 wire format ←→ 内部 frame";Filter (interceptor) 管行为
- Codec 实例化在业务层(`ChatCompletionsCodec` / `MessagesCodec` / `GeminiCodec` / `ResponsesCodec`)
- 灵感:Envoy generic_proxy filter 的 codec/filter 分离

#### 契约 E — Candidate Enumeration

```ts
interface CandidateEnumerator<TBinding, TCriteria> {
  enumerate(criteria: TCriteria, ctx: EnumCtx): Promise<readonly TBinding[]>;
}
```

- 中性的 "给定 criteria,产出有序 candidate 列表"
- "排序策略"在 enumerator 实现里(业务层注入),framework 只规定"调用一次得列表"
- 支持 Cartesian pair 业务 pattern:vertical 实现 enumerator 时做 source × target 展开

### 4.2 类型化 per-request CTX

每个 vertical 自己定义 `Ctx`,framework 不规定 shape。`Service<Ctx, ...>` 三参泛型保证类型链通畅。
灵感:Pingora `type CTX` 关联类型。

---

## 5. 演进路径

```
[Current] vnext-2026-06-23-baseline
    │
    ▼
Step 1 (顺手): rename shared-http → http, shared-cache → cache
    │
    ▼
Spec 7: 抽 @vnext/service 包,Interceptor<Ctx,Req,Result> 三参泛型
        现有 StreamInterceptor / RequestInterceptor 变 type alias
    │
    ▼
Spec 8: 拆 @vnext/protocols → @vnext/result + @vnext/protocols-llm
        ExecuteResult / ProtocolFrame 入 @vnext/result(中性)
        4 个 LLM 协议入 @vnext/protocols-llm
    │
    ▼
Spec 9: 拆 @vnext/provider → @vnext/upstream + @vnext/provider-llm
        Plugin / Binding / CandidateEnumerator 入 @vnext/upstream(中性)
        model.id / limits / pricing 入 @vnext/provider-llm
    │
    ▼
Spec 10: 抽 Codec 接口入 @vnext/result 或 @vnext/service
         chat-flow 4 endpoint 用 Codec + Service 模板收敛
    │
    ▼
Spec 11 (验收): 写 echo-proxy vertical 验证框架域中性
         + 配置 dependency-cruiser 强制单向依赖
    │
    ▼
Final epilogue: @vnext/* → @<final-name>/* 整体改名
    │
    ▼
[Final-final, deferred] vNext → main 物理上位(根 src/ 删除)
```

每个 Spec 走完整的 **brainstorming → writing-plans → subagent-driven-development** 流程,
单独 PR + tag,可独立 rollback。

---

## 6. 验收硬标准

| # | 验收项 | 方法 | 强度 |
|---|--------|------|------|
| 1 | **框架包单向依赖** | dependency-cruiser 配置禁运:framework 包不能 import LLM 业务包(`@vnext/protocols-llm`, `@vnext/translate`, `@vnext/provider-llm`, `@vnext/provider-{copilot,azure,custom,sdf}`, `@vnext/gateway`, `@vnext/responses-store`) | 强(编译期) |
| 2 | **框架包独立 build** | 每个框架包 `bun run --filter @vnext/<pkg> typecheck` 单独跑通,无业务包依赖 | 强 |
| 3 | **API surface 人工 review** | 框架包所有 export 的 type / function signature 不含 LLM 概念词 + 不接受 LLM shape 的对象;reviewer signoff | 中(人工,定性) |
| 4 | **Echo proxy 实验** | 写一个最小的非 LLM vertical:`apps/echo-proxy/`,只 import 框架包,实现 listener→route→upstream→response 完整链路,跑通 | **最强**(运行时反证) |
| 5 | **Cartesian pair regression** | 所有 cross-protocol integration tests(cc→responses, cc→messages, responses→cc, responses→messages, gemini ←→ *, messages ←→ *)绿 | 强 |
| 6 | **SDK regression** | sdk-anthropic / sdk-openai / sdk-gemini 三套测试全绿 | 强 |

辅助 smell check(不作硬验收):
- CI grep 框架包源码,出现 LLM 词(model, token, prompt, pricing, embeddings, chatCompletions, ...)需要 reviewer 解释。grep 是噪音多的工具,只做 smell,不做 gate。

---

## 7. 度量与里程碑

- **里程碑 M1** (Spec 7 完成):`@vnext/service` 包存在,所有 interceptor 走三参泛型,dependency-cruiser 规则就位但允许跨边
- **里程碑 M2** (Spec 8+9 完成):`@vnext/result` + `@vnext/upstream` 存在,LLM 类型从中剥离;dependency-cruiser 规则 enforce
- **里程碑 M3** (Spec 10 完成):chat-flow 4 endpoint 用 Codec + Service 模板,业务层包≤ 50% 现有 LOC
- **里程碑 M4** (Spec 11 验收):echo-proxy 跑通;Charter §6 验收全绿

---

## 8. 命名约定

| 包路径 | 命名 |
|--------|------|
| 框架包 | `@vnext/<noun>` 单词,中性(platform/http/cache/result/service/upstream/...) |
| 业务包 | `@vnext/<vertical>-<noun>` 或 `@vnext/<noun>-llm`,显式带 vertical 名 |
| Vertical entry app | `apps/<vertical>-<runtime>`(目前 `apps/platform-bun` / `apps/platform-cloudflare` 是历史命名,Final epilogue 时考虑改 `apps/llm-bun` / `apps/llm-cloudflare`) |

---

## 9. 决策日志(后续追加)

- 2026-06-24: Charter v1 写定,Step 0 (vnext→main) 推后到 deferred final-final epilogue
- 2026-06-24: 验收标准从 grep 关键字改为依赖图禁运 + 独立 build + API surface review + echo-proxy 实验
- 2026-06-24: Spec 7 中 `Interceptor` 的 `next` 参数暂保持零参 `() => Promise<Result>`,偏离 §4.1 理想形式 `(req: Req) => Promise<Result>`。原因:现有 21+ consumer 普遍调用 `run()` / `next()` 不传参,且依赖共享 Invocation 引用的可变状态;改为 req 传播需要 Invocation 不可变化,作为独立 spec 处理。Charter §4.1 文本保持理想形式不变,Spec 7 在自己的文件里显式记录此 deviation。
- (后续 Spec 落地时追加)

---

详细论证见附录 [Charter Rationale](./2026-06-24-clean-gateway-charter-rationale.md)。
