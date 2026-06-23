# Clean Gateway Charter — Rationale 附录

**日期:** 2026-06-24
**主文档:** [Clean Gateway Charter](./2026-06-24-clean-gateway-charter.md)
**引用 deep research:**
- [LLM Gateway Prior Art](./2026-06-24-llm-gateway-prior-art.md)(8 个 LLM gateway 项目源码级分析)
- [Modern Proxy Abstractions](./2026-06-24-modern-proxy-abstractions.md)(8 个现代代理框架源码级分析)

---

## 目的

主 Charter 是"决定了什么 + 怎么验收",本附录是"为什么这样决定"。每条决定都对应到一份 deep research 的原始观察或一个反面案例。需要在 Spec 7-11 落地时回头判断"这个边界还成不成立",回到本附录找原因比从主 Charter 反推更可靠。

---

## 1. 为什么是这 5 个契约,不是更多/更少

### 1.1 Service<Ctx, Req, Result> — 灵感 Tower + Pingora `type CTX`

**为什么选三参泛型而不是单参 `Service<Req>`(Tower 风格):**

- Tower 的 `Service<Request>` 关联类型(Response / Error / Future)在 Rust 里很优雅,在 TypeScript 里硬翻就变成"四个泛型 + 三个 conditional type",可读性崩盘。
- vNext 已经有 around-middleware 形状(现有 `Interceptor`),三参 `<Ctx, Req, Result>` 是这个形状的最小开放化:
  - `Ctx` 让 vertical 类型化自己的 per-request state(Pingora `type CTX` 同思路)
  - `Req` / `Result` 让契约本身不绑 LLM
- LLM 业务用 `Service<GatewayCtx, ChatCompletionsInvocation, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>` 实例化,echo-proxy 业务用 `Service<EchoCtx, Request, Response>` 实例化。

**为什么不选 Pingora 30 方法 god trait(`ProxyHttp`):**

详见 modern-proxy-abstractions.md §"Pingora 反模式"。要点:
- 30 个 phase 方法捆在一个 trait,业务实现 5 个还是 30 个都必须 `impl ProxyHttp`,认知负担和扩展空间都不好
- 新增 phase 是 breaking change
- 没有第三方插件生态来摊销这种刚性的成本

vNext 体量小、内部使用、interceptor 数量人脑能 hold,around-middleware 形状的成本/收益比远好于 phase god trait。

**为什么 Interceptor 是三参函数而不是带 `poll_ready` 的 trait:**

- TypeScript 没有 `poll_ready` 这种 backpressure primitive(JS event loop 模型不一样)
- 函数式 around-middleware 是 Caddy / Tyk / Traefik 的共识形状(modern-proxy-abstractions.md §"Around-middleware 家族")
- 业务真要做并发控制走 limiter interceptor 自己实现,而不是把 backpressure 抽到框架契约

### 1.2 ExecuteResult<T> — 灵感 LLM gateway typed stream parts + Pingora "always-runs logging"

**为什么是 discriminated union 而不是 `Result<Stream, Error>`:**

llm-gateway-prior-art.md §"Convergent" 里观察到:Portkey / Vercel AI SDK / LiteLLM 都把上游错误响应**作为一种正常的结果形态**返回,而不是抛异常。原因:

- 上游 4xx / 5xx 的 body 本身要透传给客户端(SDK 期望见到 OpenAI shape 的 error JSON)
- 抛异常会让中间件链的 try/catch 语义复杂化
- 区分"上游显式错误"(4xx/5xx body)和"内部错误"(translator 崩 / network 断)对 telemetry 和 retry 决策都关键

所以 union 有三态:`events` / `upstream-error` / `internal-error`。

**为什么每个 variant 都带 `performance`:**

modern-proxy-abstractions.md §"Pingora always-runs logging" 观察到:Pingora 的 `logging` 方法即使 phase chain 早期抛错也会跑。这条对 telemetry 至关重要——错误请求往往才是要研究的对象,缺了它们的 latency / token usage / upstream host 信息就是黑盒。

vNext 的等价实现:让 `performance` 字段在 union 的所有 variant 出现(`internal-error` 除外,因为内部错通常发生在还没开始计时之前),框架不需要"always-runs hook",业务在任何一个 interceptor 短路时只要返回一个带 `performance` 的 ExecuteResult,就保证 telemetry 链路不断。

**为什么用 `AsyncIterable<T>` 而不是 `ReadableStream`:**

- `AsyncIterable` 是 JS/TS 原生 protocol,`for await` 在业务代码里读最自然
- 业务 interceptor 经常要"重 wrap" stream(加 telemetry / retry / 提前短路),`async function*` 比 `ReadableStream` transformer 简单一个数量级
- `ReadableStream` 在 Bun / CFW Workers 行为略有差异(尤其 cancellation),`AsyncIterable` 由我们自己控制

### 1.3 Plugin<TBinding, TConfig> — 灵感 LLM gateway provider triple + Tower 关联类型

**为什么是 `Plugin<TBinding>` 而不是直接 `Provider`:**

llm-gateway-prior-art.md §"Convergent" 里观察到:所有 8 个 LLM gateway 都收敛到一个"provider triple"——`(req→providerReq, providerResp→resp, providerStream→StreamPart*)`。但**这个三元组本身是 LLM-specific 的**(它在做 protocol translation)。

框架契约不能写死这个三元组,否则永远不是中性的。框架只规定一件中性的事:**"plugin 解析 config 产出 binding 列表"**(`resolveBindings`)。LLM 业务在 `@vnext/provider-llm` 把 `Binding` 扩成"带 model.id / limits / pricing",在 LLM provider 实现里再叠上三元组。

**为什么 `Binding.fetcher: typeof fetch` 而不是抽象 `Upstream` 接口:**

- `fetch` 在 Bun / CFW Workers / Node 都是 first-class
- 抽 `Upstream { send(req): Response }` 只是把 fetch 重新包一层,没有新能力
- modern-proxy-abstractions.md §"反模式" 里 Pingora 的"core 不知道 cache 但 cache 又内嵌 core"是反例——抽象不该带额外的"哲学包袱"

### 1.4 Codec / Filter 分离 — 灵感 Envoy generic_proxy

modern-proxy-abstractions.md §"generic_proxy" 观察到:Envoy 的 generic_proxy filter 把 codec(协议 wire format ↔ 内部 frame)和 filter(行为)分开,让同一个 filter 可以服务多个协议(redis / dubbo / kafka 全用一套 filter 框架)。

vNext 套用这个分离:

- 4 个 LLM 协议(chat / messages / responses / gemini)各自实现自己的 `Codec`
- chat-flow 模板里的 serve→attempt→respond 是中性的,不感知协议 wire format
- 新加一个协议(比如 `bedrock`)只需要写一个新 Codec,不动 chat-flow

**为什么 Codec 不放框架包(@vnext/result)而放 @vnext/service:**

- Codec 接口本身是中性的(`decodeRequest` / `encodeResponse`),所以可以放框架包
- 但 codec 的"协议 wire format"概念跟 Service / Interceptor 同层(都是 request/response 处理生命周期的一部分),放 @vnext/service 语义更连贯
- @vnext/result 应该只放纯数据类型(ExecuteResult / ProtocolFrame),不放生命周期接口

### 1.5 CandidateEnumerator<TBinding, TCriteria> — vNext 原创

llm-gateway-prior-art.md §"Divergent" 明确写:**Cartesian translator pair 设计在 8 个 LLM gateway 里都不存在,无 copy template**。

但这个 pattern 是 vNext 的硬业务需求(同一个 model 在多个 upstream 都能跑,要按 source × target 笛卡尔展开候选,再按 PREFERENCE 选 pair)。框架不能内置这个 pattern(那就把 LLM 概念漏进框架了),但必须**支持**这个 pattern。

`CandidateEnumerator` 是中性的"给定 criteria,产出有序 candidate 列表"——对 LLM 业务它产出 (model, upstream, translator-pair) 三元组,对 echo-proxy 业务它可能就产出 (upstream-host) 单元组。**排序策略在 enumerator 实现里**,框架只规定"调用一次得列表"。

这是唯一一个没有现成 prior art 的契约,所以特意把它从 Service 里分出来——让它的 vNext 原创性可见,也方便将来调整(只动 enumerator 实现,不动 Service 契约)。

---

## 2. 为什么"不做的事"是这几条

### 2.1 不做"显式 Phase + PDK"(Kong 7 phase / Pingora 30 方法)

- Kong / APISIX 的 phase + PDK 是为**第三方插件生态**服务的,不是为"代码组织"
- vNext 没有第三方插件,所有 interceptor 都是内部代码,跨包 import 类型约束就够
- Pingora 30 方法 god trait 是反例:phase 列表是 breaking-change-prone 的 surface
- 业务做"特定时机插桩"用 interceptor 的 `before next()` / `after next()` 自己写就好

### 2.2 不做 Policy Attachment (GEP-713)

- GEP-713 解决的是"在多租户 K8s 集群里把 policy attach 到 route/service"
- vNext 是 single-tenant proxy,policy 就是 interceptor 的执行顺序,直接代码里写
- 引入 attachment 抽象只增复杂度,无收益

### 2.3 不做 xDS 风格 Config Plane

- xDS 是为"动态发现 + 推送配置"的,目标是数千 Envoy sidecar 的舰队管理
- vNext 是少量 instance + D1 持久化,admin routes + reload 已经够
- 渐进扩展 admin routes 比抽 xDS 简单几个数量级

### 2.4 不抽 @vnext/proxy 独立包(TCP/TLS dialer)

- `fetch` + `Bun.serve` / Workers 已经把传输层抽走
- 抽 dialer 包只是"看起来像 gateway 框架",对 LLM 业务零增量价值
- 真要做的话也是 platform 包扩展,不是新独立包

### 2.5 不抽 cache 进 Service 核心

- modern-proxy-abstractions.md §"Pingora cache" 明确反例:Pingora 的 cache 内嵌 core 是历史遗留,让 core trait 变臃肿
- cache 应该是普通框架包(`@vnext/cache`),业务在 interceptor 里调用
- "framework 知道 cache 存在"和"framework core 接口里有 cache"是两回事

### 2.6 不做"每 endpoint 文件爆炸"(Portkey 17 文件 × 80 provider)

- llm-gateway-prior-art.md §"Portkey 反模式" 详述
- Portkey 每个 provider 17 个文件(api.ts / chatComplete.ts / complete.ts / ...),80 个 provider = 1360 个文件,绝大部分 90% 重复
- vNext 走 Spec 10 的 chat-flow 模板收敛(serve→attempt→respond 同一份代码,4 endpoint 共用),Codec 抽走协议特殊性

---

## 3. 10 个业务 Pattern 如何被 5 个契约满足

| Pattern | 满足契约 | 怎么落 |
|---------|---------|--------|
| 1. Cartesian translator pair | E (CandidateEnumerator) | vertical 实现 enumerator 时 source × target 笛卡尔展开 |
| 2. Multi-candidate fallback | E + A | enumerator 给出有序列表,Service 实现里循环消费,interceptor 决定何时 stop |
| 3. Per-request inheritedHeaders | A (Ctx 字段) | `GatewayCtx` 里放 `inheritedHeaders: Headers` 字段,跨 attempt 链由 vertical 自己传 |
| 4. Pre-attempt short-circuit | A (Interceptor 短路) | interceptor 不调 next 直接返回 ExecuteResult(events 形态) |
| 5. Stateful sidecar | (Platform 包) | `@vnext/platform` 提供 sql/file/background,业务自管表 schema |
| 6. Telemetry context per-binding | B (ExecuteResult.performance) | 每次 attempt 产生独立 ExecuteResult,各自带 performance |
| 7. Type-safe streaming events | B (ExecuteResult<T>) | T 由业务实例化为 ProtocolFrame<...>,framework 不感知 |
| 8. Translator error as terminal frame | B (events variant 可包错误 frame) | vertical 的 ProtocolFrame union 自带 error 形态;framework 看到的还是 `events: AsyncIterable<T>` |
| 9. Twin runtime | (Platform 包) | `@vnext/platform` 抽 env/sql/file/background/runtime-location,业务码不感知 runtime |
| 10. Control plane 业务表 | (Platform sql) | `@vnext/platform` 提供 sql;framework 不感知业务表 |

注意:Pattern 5/9/10 由 platform 包满足,**不进 Service / ExecuteResult / Plugin / Codec / Enumerator 这 5 个核心契约**。这是有意的——平台能力是基础设施层,与业务契约正交。

---

## 4. 为什么验收标准从 grep 改成"依赖图 + 独立 build + API surface review + echo-proxy"

### 4.1 grep 的失败模式

- **False negative(漏报):** vertical 概念以变量名 / 注释 / 隐式 type structural shape 出现时,grep 看不到。比如 `interface Binding { metadata: Record<string, unknown> }` 实际承载 LLM `model` 字段——grep "model" 抓不到。
- **False positive(误报):** 通用词被误判。"model" 在 framework 里可能指 "data model";"token" 可能指 "auth token"。每条都要 reviewer 解释,变成"垃圾搜索结果分类工作"。
- **不可执行约束:** grep 是 post-hoc check,没法在编译期阻止违规。一个新 PR 引入 LLM 词,要等下次 CI grep 跑才发现。

### 4.2 替代方案各自补齐什么

| 方法 | 补齐什么 | 强度 |
|------|---------|------|
| dependency-cruiser | 编译期阻止 framework 包 import 业务包,不依赖关键字 | 强 |
| 独立 build | 框架包能脱离业务包构建,证明无隐式依赖 | 强 |
| API surface 人工 review | type signature 不接受 LLM shape 的对象(主观判断,自动化做不到) | 中(人工但必要) |
| Echo proxy 实验 | **运行时反证**——能跑通完全无关的 vertical,就证明 framework 真的中性 | 最强 |

### 4.3 为什么 echo proxy 是"最强"

dependency-cruiser 是必要条件(framework 不 import 业务),echo proxy 是充分条件(framework **能服务** non-LLM 业务)。一个 framework 即使依赖图干净,API 设计里如果隐含 LLM 假设(比如"streaming 一定是 SSE"),echo proxy 也跑不通——这种偏见 grep 永远抓不到,但 echo proxy 第一秒就崩。

grep 保留作辅助 smell check 是合理的(成本低,偶尔抓到漏的),但**不作为 gate**。

---

## 5. 演进路径为什么这样排

```
Step 1 rename(顺手)
  ↓
Spec 7 @vnext/service(框架核心契约,最小破坏)
  ↓
Spec 8 @vnext/result + protocols-llm(类型层切分)
  ↓
Spec 9 @vnext/upstream + provider-llm(provider 层切分)
  ↓
Spec 10 Codec + chat-flow 模板收敛(业务去重)
  ↓
Spec 11 echo-proxy 验收(运行时反证)
  ↓
Final 整体改名
  ↓
[Deferred] vnext→main 上位
```

**为什么 Spec 7 先做 Service:** Service / Interceptor 是其它所有契约的载体。先把这个开放成三参泛型,后面 Spec 8/9 拆类型才有"放进哪个泛型槽位"的去处。

**为什么 Spec 8 先于 Spec 9:** 类型(ExecuteResult / ProtocolFrame)的拆分影响面比 provider 接口拆分小——前者是声明,后者是实现。先拆类型,provider 实现再 follow 拆好的类型。

**为什么 Spec 10 放在 9 后面:** chat-flow 模板要用到 @vnext/service 的 Service + 拆好的 ExecuteResult + 拆好的 Plugin/Binding,所有前置都到位才做收敛。

**为什么 Spec 11 是独立 Spec:** echo-proxy 是验收实验,不是 framework 演进。把它单独立 Spec 让"验收通过"成为一个可标记的 milestone。

**为什么 Final rename 推到最后:** 改包名是 codemod,机械工作。早改 vs 晚改不影响架构,放最后避免 Spec 7-11 进行中的 PR 一直 conflict。

**为什么 vnext→main 上位 deferred:** 见 roadmap.md §3 决策变更 + Charter §9 决策日志。要点:根 src/ 在 prod 稳定,同时改两个稳定点风险大于收益,等 vnext 真能 cutover 再做。

---

## 6. 决策的可逆性

每个 Spec 单独 PR + tag,如果某个契约设计不对,可独立 rollback:

- Spec 7 错 → Service 三参回退到 stream-specific interceptor,Spec 8/9/10 暂停
- Spec 8 错 → ProtocolFrame 类型形状调整,只动 @vnext/result + protocols-llm
- Spec 9 错 → Plugin / Binding 形状调整,provider 实现同步改
- Spec 10 错 → chat-flow 模板回退到 4 endpoint 各自维护(回到现状)
- Spec 11 echo-proxy 跑不通 → 暴露 framework 仍有 LLM 假设,定位修复

这种"Spec 边界 = rollback 边界"是有意设计——避免一次大 PR 全推翻。

---

## 7. 与其它已发表 spec 的关系

- **Spec 1-6**(已完成):baseline,本 Charter 不动它们的产物
- **Spec 7-11**(本 Charter 规划):框架契约演进
- **后续 vertical 扩展 spec**(未来):在框架契约稳定后,加新 LLM 协议 / 新 provider / 新 endpoint,走"加 Codec / 加 provider plugin"的窄路径,不动框架

---

## 8. 不会改的东西(用户侧契约)

- 4 个 LLM endpoint 的对外 HTTP API(path / method / 请求 body shape / 响应 SSE 格式)
- Control plane admin routes 的 path / 权限模型
- D1 表 schema(api-keys / copilot-quota / upstreams / token-usage / web-tests / responses-items)
- Twin runtime 部署形态(Bun docker + CFW Workers)

Spec 7-11 是**内部架构重构**,用户(SDK 调用方 + admin)看到的 surface 不变。这是验收 Charter §6.5 / §6.6(Cartesian pair + SDK regression 全绿)的前提。

---

## 9. 与 deep research 报告的引用映射

| Charter 条款 | 引用 research |
|--------------|--------------|
| 契约 A Service<Ctx,...> | modern-proxy §"Service-style 家族" + §"Pingora type CTX" |
| 契约 B ExecuteResult union | llm-gateway-prior-art §"Convergent: typed StreamParts" + modern-proxy §"Pingora always-runs logging" |
| 契约 C Plugin/Binding | llm-gateway-prior-art §"Convergent: provider triple" + modern-proxy §"Tower 关联类型" |
| 契约 D Codec/Filter | modern-proxy §"Envoy generic_proxy" |
| 契约 E CandidateEnumerator | llm-gateway-prior-art §"Divergent: 无 prior art" |
| 不做 Phase + PDK | modern-proxy §"Pingora 30 方法反模式" |
| 不抽 cache 进 core | modern-proxy §"Pingora cache 内嵌反模式" |
| 不做每 endpoint 文件爆炸 | llm-gateway-prior-art §"Portkey 17 文件 × 80 provider" |
| 验收用 echo proxy | modern-proxy §"运行时反证比静态分析强" |

---

详细业务 pattern 描述与契约 TypeScript 签名见主 Charter [Clean Gateway Charter](./2026-06-24-clean-gateway-charter.md)。
