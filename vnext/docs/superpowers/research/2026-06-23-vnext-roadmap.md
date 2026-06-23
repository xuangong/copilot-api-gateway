# vNext Roadmap — Framework / Business Split

**日期:** 2026-06-23
**前置文档:** [Gateway Abstractions Research](./2026-06-23-gateway-abstractions-research.md)
**对象:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

---

## 0. 当前现状盘点

vNext 已经有 **13 个包**,框架 / 域 在物理上已有分离:

| 现有包 | 当前定位 |
|--------|---------|
| `@vnext/platform` | runtime 抽象(env / sql / file / background / runtime-location) |
| `@vnext/interceptor` | around-middleware,目前形状偏 stream-specific |
| `@vnext/protocols` | `common`(ProtocolFrame / ExecuteResult) + 4 个 LLM 子协议 |
| `@vnext/provider` | Plugin + Binding,接口里有 LLM 特定字段 |
| `@vnext/shared-http` | HTTP 工具 |
| `@vnext/shared-cache` | cache 抽象 |
| `@vnext/translate` | LLM Cartesian 翻译 |
| `@vnext/responses-store` | OpenAI Responses 协议 stateful items |
| `@vnext/provider-{copilot,azure,custom,sdf}` | 具体 LLM provider 实现 |
| `@vnext/gateway` | 4 个 endpoint serve+attempt+respond + control-plane 业务表 |

业界 gateway 共识(详见调研报告)是 7 个契约:**Listener / Route Matcher / Phase Chain / Upstream / Policy Attachment / Config Plane / Observability**。vNext 当前满足前 4 + Observability,缺 **Policy Attachment** 与 **Config Plane**,**Phase Chain** 实现得偏弱(无显式 phase + PDK 约束)。

---

## 1. 拆分立场:框架 vs 业务

### 1.1 框架部分(domain-neutral,服务任何 vertical)

| 包 | 域中性程度 | 拆解动作 |
|----|-----------|---------|
| `@vnext/platform` | ✅ | 保留 |
| `@vnext/interceptor` | ⚠️ 隐含 stream 语义 | **收紧成 `Interceptor<Ctx,Req,Result>` 三参泛型,现有 stream/request interceptor 变 type alias** |
| `@vnext/protocols/common` | ⚠️ 混了域中性 + LLM 子协议 | **拆出 `@vnext/result`(域中性 ProtocolFrame / ExecuteResult)** |
| `@vnext/provider` | ⚠️ `getPricingForModelKey` 等 LLM 字段 | **拆为 `@vnext/upstream`(域中性 Plugin/Binding) + `@vnext/provider-llm`(LLM 字段叠加)** |
| `@vnext/shared-http` | ✅ | **改名 `@vnext/http`** |
| `@vnext/shared-cache` | ✅ | **改名 `@vnext/cache`** |
| `apps/platform-bun` / `apps/platform-cloudflare` | ✅ listener 边界 | 保留 |

**新增建议(可选):**

- `@vnext/observability` —— 抽出域中性的 `PerformanceTelemetryContext` / `recordPerformance`,把 `gateway/src/data-plane/observability` 中纯指标管道(不含 token 计费)挪进来。

### 1.2 业务部分(LLM vertical,在框架之上)

| 包 | 定位 |
|----|------|
| `@vnext/protocols-llm`(从 `protocols` 拆出来) | LLM 协议形状定义(chat/messages/responses/gemini) |
| `@vnext/translate` | LLM 协议笛卡尔翻译 |
| `@vnext/provider-llm` | 在域中性 upstream 之上叠 `model.id / limits / pricing` |
| `@vnext/provider-{copilot,azure,custom,sdf}` | 具体 LLM provider 实现 |
| `@vnext/responses-store` | OpenAI Responses 协议 stateful items |
| `@vnext/gateway/data-plane/chat-flow` | 4 endpoint serve+attempt+respond 链 |
| `@vnext/gateway/control-plane/{api-keys,copilot-quota,upstreams,token-usage,…}` | LLM 业务 admin |
| `@vnext/gateway/data-plane/{orchestrator,embeddings,images,models}` | 其它 LLM 周边 |

---

## 2. 拆分后的目标拓扑

```
框架层 (domain-neutral)
  @vnext/platform        runtime 抽象 (env/sql/file/background)
  @vnext/http            HTTP 工具
  @vnext/cache           通用 cache
  @vnext/interceptor     Interceptor<Ctx,Req,Result> around-middleware
  @vnext/result          ExecuteResult / ProtocolFrame
  @vnext/upstream        Plugin / Binding / 域中性 telemetry context
  @vnext/observability   纯指标管道 (可选)
  apps/platform-*        listener 入口

业务层 (LLM vertical)
  @vnext/protocols-llm   在 @vnext/result 上声明 4 个 LLM 子协议
  @vnext/provider-llm    在 @vnext/upstream 上叠 LLM model 字段
  @vnext/translate       LLM 协议笛卡尔翻译
  @vnext/provider-{copilot,azure,custom,sdf}
  @vnext/responses-store
  @vnext/gateway         data-plane/chat-flow + control-plane 业务表
```

---

## 3. 调整动作清单(按风险/价值排序)

| # | 动作 | 类型 | 风险 | 阶段 |
|---|------|------|------|------|
| 1 | 改名 `shared-http` → `http`,`shared-cache` → `cache` | 纯 rename | 极低 | 顺手 |
| 2 | `@vnext/interceptor` 改为 `Interceptor<Ctx,Req,Result>` 三参 | 框架层重构 | 低 | Spec 7 |
| 3 | `@vnext/protocols` 拆为 `@vnext/result` + `@vnext/protocols-llm` | 包级切分 | 中 | Spec 8 |
| 4 | `@vnext/provider` 拆为 `@vnext/upstream` + `@vnext/provider-llm` | 包级切分 | 中 | Spec 9 |
| 5 | `gateway/data-plane/chat-flow` 收敛 4 endpoint 模板 | 业务层去重 | 中 | Spec 10 |
| 6 | 整套 `@vnext/*` 重命名到对外名字(例: `@floe/*`) | codemod | 低 | Final epilogue |
| 7 | **vNext → main 上位:删除根 `src/`,把 `vnext/` 提到根** | 仓库结构 | 中 | **Deferred — 等 vnext 完全能替代 prod 后再做** |

> **2026-06-23 决策变更:** 原 Step 0 (vnext→main 上位) 降级为 Step 7 / Final-final epilogue。
> 原因:根 `src/` 仍在 prod 跑稳,vnext 内部还有 5-6 个 Spec 的演进。同时动两个稳定点的风险高于收益。
> 改为:Spec 7-10 全部直接在 `vnext/packages/*` 内迭代,根 `src/` 不动,等 vnext 真正能 cutover prod 时再做物理提升。

---

## 4. 故意不做的事

| 不做的事 | 原因 |
|---------|------|
| 抽 `@vnext/proxy` 独立包(底层 TCP/TLS dialer 等) | `fetch` + `Bun.serve` / Workers 已经够;抽出来只是"看起来像 gateway 框架" |
| 引入显式 Phase + PDK | 当前 interceptor 数量人脑能 hold;没有第三方插件生态 |
| 引入 Policy Attachment(GEP-713 风格) | single-tenant proxy 用不到;引入只增加复杂度 |
| 引入 xDS 风格 Config Plane | 现状 D1 + admin routes 已经是简易 config plane;够用,渐进扩展即可 |

---

## 5. 执行顺序总览

```
当前: Spec 6 cross-protocol attempt wiring (in progress)
   │
   ▼
[Tag] vnext-2026-06-23-baseline
        - 当前 vNext 13 包结构 + Spec 1-6 进展的快照
        - 之后 Spec 7-10 全部在 vnext/packages/* 内直接迭代
        - 根 src/ 不动,继续跑 prod
   │
   ▼
Step 1: rename shared-http/shared-cache (顺手)
   │
   ▼
Spec 7: interceptor 三参泛型
   │
   ▼
Spec 8: protocols 拆 result + protocols-llm
   │
   ▼
Spec 9: provider 拆 upstream + provider-llm
   │
   ▼
Spec 10: chat-flow 4 endpoint 收敛
   │
   ▼
Final: @vnext → @<final-name> 整体改名
   │
   ▼
[Final-final, deferred] Step 7: vNext → main 上位
        - 触发条件:vnext 能完全替代根 src/ 的 prod 行为
        - 动作:删除根 src/,vnext/ 内容提到根,
                更新 package.json / docker-compose / 路径,旧测试归档
```

---

## 6. 关键判断

1. **vNext 当前不是 "gateway 框架",是"组织良好的 LLM 代理"。** 区别在于:
   - 框架层接口仍有 LLM 残留(provider 接口的 pricing / limits)
   - interceptor 泛型不开放
   - 没有显式 phase / policy attachment / 完整 config plane
2. **以上拆分能把 vNext 推进到"可以服务任何 vertical 的 gateway 框架"边界,但需要 5-6 个 Spec 的迭代。**
3. **LLM 特有逻辑(model_key 修正 / translator pair 笛卡尔展开 / token 计费)永远不该进框架层。** 它们是 domain layer 的事;框架层只看到 `EventResult<T>` / `PerformanceTelemetryContext` / `Interceptor<Ctx,Req,Result>`。
4. **`@vnext` 这个 namespace 是临时名字。** 它是"相对老 src/ 而言的下一代"。等 vNext 上位 + 拆分完成后,统一改名是 Final epilogue。
