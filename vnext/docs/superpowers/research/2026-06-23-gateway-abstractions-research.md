# Gateway 抽象契约调研报告

**日期:** 2026-06-23
**作者:** controller(与用户对话整理)
**对象:** vNext (`/Users/zhangxian/projects/copilot-api-gateway/vnext/`) 与参考项目 (`/Users/zhangxian/projects/copilot-gateway/`)
**目的:** 在"这是一个 gateway 框架,LLM/认证/路由/背压只是它上面的领域 feature"这一前提下,厘清一个 gateway 框架应该提供哪些抽象契约;以业界共识为参照,审视两个项目当前的形态。

---

## 1. 立场

我们要梳理的不是一个 LLM 代理,而是一个**通用 gateway 框架**。LLM 网关是它的第一个 vertical;认证、路由、背压、配额、可观测同样应在这个框架上以可插拔的方式实现。任何抽象都应满足:

- **域中性 (domain-neutral):** 框架层不知道 "model" / "token" / "tool_call",这些只能出现在 vertical 实现中。
- **替换性 (substitutability):** 任何一层的实现都可在不动其它层的前提下替换 (e.g. 换 transport、换持久化、换路由策略)。
- **生命周期清晰 (lifecycle):** 每条请求经过的阶段、可注入点、约束(能读什么、能改什么、能终结流程吗)是显式的。
- **配置/代码分离 (config-plane vs code-plane):** 调路由、调权重、调策略不必改代码、不必重新部署。

---

## 2. 业界共识(横切对比)

调研对象:Envoy、Kong、APISIX、Kubernetes Gateway API、Azure API Management 的官方文档与源码组织方式。

抽象契约可归纳为 **7 个**:

| # | 契约 | Envoy | Kong | APISIX | K8s Gateway API | 用一句话说 |
|---|------|-------|------|--------|------------------|------------|
| 1 | **Listener / Entry** | Listener (LDS) | server_block | server_block | `Gateway` + `Listener` | 一组监听端口/协议/TLS;请求从这里进入 |
| 2 | **Route Matcher** | Route (RDS) | Route | Route (radixtree) | `HTTPRoute` / `GRPCRoute` | host/path/method/header 匹配到一条 logical route |
| 3 | **Phase Chain** | HTTP Filter Chain | 7 phases (certificate/rewrite/access/header_filter/body_filter/log/…) | 5 NGINX 阶段钩子 | 通过 Filter 字段间接表达 | 一条请求被切成显式的若干"阶段",每个阶段允许做什么由 PDK 框定 |
| 4 | **Upstream / Cluster** | Cluster (CDS/EDS) | Service | Upstream | `BackendRef` | 抽象一个被调用方:多 endpoint、健康检查、负载均衡、熔断 |
| 5 | **Policy Attachment** | Listener/Route filter | Plugin (consumer/route/service/global) | Plugin (consumer/route/service/global) | GEP-713 `targetRefs` + 优先级 (Route > Gateway > Namespace) | 把策略(认证、限流、重试…)挂在 listener/route/upstream 任一层,有清晰的优先级 |
| 6 | **Config Plane** | xDS (LDS/RDS/CDS/EDS) | Admin API + DB | Admin API + etcd | CRD + controller | 配置变更不重启、不改代码;数据面读到的是配置面下发的快照 |
| 7 | **Observability** | access_log + stats + tracing | log/metric/trace 插件 | log/metric/trace 插件 | 标准化的 metric/log/trace 字段 | 显式的可观测信号:指标、日志、链路 |

> **关键观察:** Phase Chain(契约 3)和 Policy Attachment(契约 5)是真正区分 "一个组织良好的 proxy" 与 "通用 gateway 框架" 的分水岭。前者把"能干什么、什么时候干、能改什么"做成了一等公民;后者解耦了"在哪个 scope 生效"与"做什么"。

---

## 3. 对照矩阵(vNext / 参考 / 业界)

| 契约 | vNext | 参考项目 | 业界 |
|------|-------|----------|------|
| 1. Listener / Entry | ✅ Hono / Bun.serve / Workers (在 platform 包) | ✅ 同前 | ✅ |
| 2. Route Matcher | ✅ Hono 路由 + `routing.ts`(18 行) | ✅ Hono 路由 + `planChatCompletionsRouting` | ✅ |
| 3. Phase Chain | ⚠️ 有 `@vnext/interceptor`,但仅 around-middleware,无显式 phase 枚举 / PDK 能力边界 | ⚠️ 有 `@floway-dev/interceptor`,泛型三参 around-middleware,**抽象更纯**(`Interceptor<Ctx, Req, Result>`),但同样无显式 phase | ✅ (Kong/Envoy 都把 phase 做成一等公民) |
| 4. Upstream / Cluster | ✅ `provider-*` 包族 | ✅ 同前 + `@floway-dev/provider` 框架接口 | ✅ |
| 5. Policy Attachment | ❌ 认证/限流/重试以注册顺序进入 interceptor 链,无 targetRef、无优先级 | ❌ 同样问题 | ✅ (GEP-713 标准化) |
| 6. Config Plane | ❌ 所有路由相关配置在 TS 代码里,加 upstream 要重新部署 | ❌ 同左 | ✅ (xDS/Admin API/CRD) |
| 7. Observability | ✅ 各 endpoint 自己的 `usage.ts` + `recordUpstreamLatency` | ✅ `@floway-dev/provider` 暴露 `PerformanceTelemetryContext`,helper 内部 fire-and-forget,**更对称** | ✅ |

**得分:vNext 4 / 7,参考项目 4.5 / 7**。差距集中在第 5、6 项以及第 3 项的"phase 显式化"。

---

## 4. 两个项目的差异(在通用 gateway 框架视角下)

### 4.1 物理打包

- 参考项目把 **框架层** 和 **域层** 在**包边界**上切开:
  - 框架层:`@floway-dev/interceptor`、`@floway-dev/http`、`@floway-dev/proxy`、`@floway-dev/provider`、`@floway-dev/platform`、`@floway-dev/protocols`
  - 域层:`@floway-dev/gateway`、`@floway-dev/translate`、5 个 `provider-*`
- vNext 只用目录区分,所有东西在 `@vnext/gateway` 内。
- **影响:** 物理边界 = 强制不让 LLM 知识泄漏到框架层;目录边界 = 靠纪律。

### 4.2 Interceptor 抽象

- 参考:`Interceptor<Ctx, Req, Result>` 三参泛型,注释明确"intentionally generic so it works for any kind of call"。
- vNext:`StreamInterceptor` / `RequestInterceptor` 等更具体的形状,泛型不够开放,事实上仍然只服务于 chat-flow。
- **影响:** 参考项目的 interceptor 可以原样套到一个非 LLM 的 vertical 上;vNext 不行。

### 4.3 Telemetry 在 ExecuteResult 上的位置

- 参考最新:`providerStreamResultToExecuteResult` 是 helper,**所有** ExecuteResult(events / upstream-error)都附带 `performance: PerformanceTelemetryContext`;`withUpstreamTelemetry` 不再用 promise channel,直接在 stream wrap 里 fire-and-forget。
- vNext:Spec 2 后还在用 recorder + finalMetadata channel 草稿。
- **影响:** 参考项目的 telemetry 是 ExecuteResult 自带的"额外字段",任何 vertical 自由复用;vNext 还在围绕"如何在 interceptor 替换流时不丢失 metadata"做妥协。

### 4.4 Cartesian Routing

- 两边都通过"axes 枚举 + pair-selector PREFERENCE"展开 source × target 的笛卡尔乘积。这是**域级**做法,不属于框架契约。

### 4.5 Platform 三阶段(boot / serve / shutdown)

- 两边都有 `packages/platform` 抽象 runtime;**非差异点**。

---

## 5. 两个项目共同缺失的 3 个契约

### 5.1 显式 Phase + PDK 能力边界

**现状:** 两边的 interceptor 都是位置式的 around-middleware,没有命名 phase,没有"这个 phase 只能读 request、不能改 response body"这类约束。
**业界做法:** Kong 7 phase × PDK(每 phase 暴露的 API 是受限的子集);Envoy filter chain 显式区分 decoder/encoder/log filter。
**为什么重要:** 没有 phase 概念,limit/auth/retry/transform 这些通用插件就没法被第三方写出来 —— 没人知道自己处在请求生命周期的什么位置、可以触碰什么。

### 5.2 Policy Attachment(targetRef + 优先级)

**现状:** 两边把"哪条 route 走哪条 interceptor 链"硬编码在 `serve.ts` 的注册顺序里。
**业界做法:** GEP-713 把"策略 = 一个对象 + 一组 targetRefs"分离开,Route 上的策略覆盖 Gateway 上的,Gateway 上的覆盖 Namespace 上的。
**为什么重要:** 没有 attachment,运维想给某条 route 单独开速率限制,只能改代码 + 重新部署。

### 5.3 Config Plane 与 Code Plane 分离

**现状:** 两边的 upstream / route / pricing / policy 全在 TypeScript 代码里。
**业界做法:** xDS / Admin API / CRD + controller —— 数据面只是"配置快照的执行器"。
**为什么重要:** 没有 config plane,加一个 upstream provider 或调一个权重都是一次代码 review + 部署。

---

## 6. 一个"足够好"的 gateway 框架长什么样

```
┌────────────────────────────────────────────────────────────┐
│ Framework Layer (domain-neutral)                            │
│  1. Listener                                                │
│  2. Route Matcher                                           │
│  3. Phase Chain (with PDK)        ← 共同缺失                │
│  4. Upstream / Cluster                                      │
│  5. Policy Attachment             ← 共同缺失                │
│  6. Config Plane                  ← 共同缺失                │
│  7. Observability                                           │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────┴──────────────────────────────────┐
│ Domain Layer (LLM vertical)                                 │
│  - protocols (chat-completions / messages / responses / …)  │
│  - translators (Cartesian pair selector)                    │
│  - providers (copilot / azure / openai / custom / sdf)      │
│  - LLM-specific policies (model_key correction, token usage)│
└────────────────────────────────────────────────────────────┘
```

参考项目的包结构已经把这两层切开了,这是它优于 vNext 的根本。它仍然没把契约 3 / 5 / 6 实做出来。

---

## 7. 结论与建议

1. **vNext 目前是"组织良好的 LLM 代理",不是 gateway 框架。** 参考项目向 gateway 框架方向迈了一步(包边界 + 三参 Interceptor + 自带 telemetry 的 ExecuteResult),但仍未越过界。
2. **要先抄包结构。** vNext 下一步若想朝 gateway 框架演进,最低成本的对齐就是把 `interceptor`、`http`、`proxy`、`provider`、`protocols`、`platform` 拆成独立包 —— 这一步只是物理切割,不破坏现有 LLM 代码。
3. **再补三个契约。** 显式 phase 比 policy attachment 更紧急,policy attachment 比 config plane 更紧急。建议依此顺序逐个写 spec。
4. **LLM 特有逻辑(model_key 修正、translator pair 笛卡尔展开、token 计费)绝不该进框架层。** 它们是 domain layer 的事;框架层只看到 `EventResult<T>` / `PerformanceTelemetryContext` / `Interceptor<Ctx,Req,Result>`。

---

## 8. 引用

- Envoy: <https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/dynamic_configuration>
- Kong PDK & phases: <https://docs.konghq.com/gateway/latest/plugin-development/pdk/>
- APISIX architecture: <https://apisix.apache.org/docs/apisix/architecture-design/apisix/>
- Kubernetes Gateway API: <https://gateway-api.sigs.k8s.io/>
- GEP-713 Policy Attachment: <https://gateway-api.sigs.k8s.io/geps/gep-713/>
- xDS protocol: <https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol>
