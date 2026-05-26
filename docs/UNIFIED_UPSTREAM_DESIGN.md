# Unified Upstream Management — System Design & Evolution Plan

**作者**: Xian + Claude
**日期**: 2026-05-27
**状态**: 演进中（M2 完成，M3-M6 规划）

---

## 1. 北极星目标（Vision）

让 copilot-api-gateway 从「单 GitHub 账号 → 单 Copilot 后端」的硬连接，演化成一个 **多上游统一管理平台**：

> 一个 admin 可以在 dashboard 上注册任意数量的上游（GitHub Copilot 账号 / Azure OpenAI 部署 / 任意 OpenAI 兼容端点），按 owner 隔离、按优先级排序、按 endpoint 能力路由；用户的请求会被透明地分派到合适的上游，所有 usage / latency 数据按 upstream 维度归档，admin 可以热修改配置且不需要重启。

这要求底层数据模型、provider 抽象、请求分派、缓存、控制面 UI、可观测性六个层都要被改造。

参考实现：`/Users/zhangxian/projects/copilot-gateway`（已在线，6 个 milestone 都已落地）。

---

## 2. 系统分层模型

```
┌──────────────────────────────────────────────────────────┐
│ L6  Dashboard UI (admin CRUD, probe results, flag toggle)│  ← M5
├──────────────────────────────────────────────────────────┤
│ L5  Observability (usage / latency 按 upstream 维度聚合) │  ← M6
├──────────────────────────────────────────────────────────┤
│ L4  Request Dispatch (resolveBinding → effectiveFlags)   │  ← M2 ✓
├──────────────────────────────────────────────────────────┤
│ L3  Provider Layer (Copilot / Azure / Custom + 工厂)     │  ← M1 ✓
├──────────────────────────────────────────────────────────┤
│ L2  Cache Layer (token cache + models cache + invalidate)│  ← M2 ✓
├──────────────────────────────────────────────────────────┤
│ L1  Data Model (upstreams 表 + flag_overrides)           │  ← M1 ✓
└──────────────────────────────────────────────────────────┘
```

每层向上提供契约，向下依赖更稳定的契约。Gap 的优先级由它们影响哪一层、以及该层下游是否还有 consumer 决定。

---

## 3. Milestone 进度 & Gap 角色

### M1 ✓ 数据模型 + Provider 抽象（已完成）

- `upstreams` 表（migration 0026）
- `ProviderBinding` 类型 + `listProviderBindings`
- `createProviderFromUpstream` 工厂派发 Copilot / Custom / Azure
- 自动迁移老 `github_accounts` 行

**对应参考项目**: migration 0010 + registry.ts + provider/types.ts。等价。

### M2 ✓ Cache + Flag 注入 + 路由全量切换（已完成）

- 13 个 route 全部切换到 binding 派发
- `getCachedCopilotToken` 两级 cache（Map + KV）
- control-plane CRUD 触发 `invalidateUpstreamCaches`
- `effectiveFlags(state, binding)` 注入到 4 处 transform/retry

**对应参考项目**: copilot.ts 缓存 + models-store.ts L1/L2 + flags-resolve.ts。等价但**有差异**（见下面 M3 Gap）。

### M3 ⏳ Probe + 失败鲁棒性（**下一步**）

参考项目 probe 是用户最终能否信任 admin UI 的关键 —— 当前 admin 添加一个 Azure / Custom upstream，**无法立刻知道**配置对不对，得等真实用户请求来才能看到 500。

#### Gap 5 — Probe 端点真实化
- **当前**: `probeUpstream` 只对 custom/azure 跑空 stub，copilot 直接返回 "use /api/copilot-quota"
- **参考**: 三种 provider 都打 `/v1/models`，captured status + 前 50 个 model id；Azure 还按 deployment.supportedEndpoints 逐 endpoint 真发小 payload
- **角色**: L4（dispatch）和 L6（UI）之间的契约。没有它，UI 没法显示配置可信度，admin 一次配错会让用户连锁报错
- **实施**: 给 `Provider` 接口加 `probe(): Promise<{ok, models?, error?}>`；CopilotProvider/AzureProvider/CustomProvider 各自实现；control-plane `/test` endpoint 直接代理；UI 渲染

#### Gap 6 — Usage 老数据 rewrite
- **当前**: migration 0026 只建表 + 迁 accounts，老 usage 行的 `upstream='copilot:3456821'` 没改
- **参考**: migration 0010 用 CTE 把老 usage 全部 rewrite 到新 `up_<id>`，避免 dashboard 出现两条孤立 series
- **角色**: L5（observability）和 L1（data model）的一致性。如果不修，dashboard 切到 upstream 维度聚合时会出现历史 + 现在两套 ID
- **实施**: 新 migration 0027，仿 0010 的 CTE 模式

### M4 ⏳ 配置热修改的完整闭环

#### Gap 4a — Models cache 按 upstream 隔离 + invalidate hook
- **当前**: `raw-models-cache` 是 in-process Map，TTL 60s；invalidation 是全清
- **参考**: per-upstream-id 双层 cache，invalidate 时按 id 精准失效
- **角色**: L2 → L4 性能。多 upstream 时全清开销大；但 single-account 阶段全清是够的，所以**优先级较低**

#### Gap 4b — Flag catalog 加 `defaultFor` 字段
- **当前**: `flag/catalog.ts` 有 flag 列表，但 default 表是固定常量
- **参考**: `Flag { id, label, description, defaultFor: ProviderKind[] }`，dashboard 渲染时用 `defaultsForProvider` 算"继承"按钮
- **角色**: L6 → L1。dashboard 三态 radio（继承/开/关）需要这个数据
- **实施**: 跟 Gap 7（UI）一起做

### M5 ⏳ Dashboard UI 完整 CRUD（**最大的工程量**）

#### Gap 7 — Dashboard 接 `/api/upstreams`
- **当前**: dashboard 还在调旧 `/api/upstream-accounts`（只列 GitHub 账号），admin 没法在 UI 上加 Azure / Custom，只能 curl
- **参考**: tabs.tsx 提供完整列表（card 视图）+ 编辑 modal + probe 结果展示 + 拖拽排序
- **角色**: L6 终局。这是把 M1-M4 的能力交付给 admin 的最后一公里
- **实施**: 拆 4 步 — 列表卡片 → 编辑 modal → flag 三态 radio → probe 结果浮层
- **风险**: 前端代码体量大，且 dashboard 现有架构（vanilla JS in client.ts）已经很重

### M6 ⏳ 失败鲁棒性 & 高级特性（**可选**）

#### Gap 8 — failover 选第二个 binding
- **当前**: 第一个匹配的 binding 直接调，错就给用户 500
- **参考**: **也没失败重试** —— `lastError` 只在 list 整批失败时抛
- **角色**: L4 可靠性。但**参考项目自己也没做**，说明不是 P0
- **实施**: 可选；如果做，要解决 idempotency / partial-stream 半截切换

#### Gap 9 — listProviderBindings 自身 cache
- **当前**: 每请求查 upstream 表 2 次 + 每个 upstream 调 getModels（model list 自己有 cache）
- **参考**: 也没缓存 binding list；只缓存 per-upstream model list
- **角色**: L4 性能。在 CFW 上每请求 +2 D1 round trip，但 D1 < 5ms，影响小
- **实施**: 加 30s in-process Map，invalidate 跟着 control-plane CRUD 走

#### Gap 10 — Web-search 接 binding
- **当前**: web-search interceptor 用 `state.copilotToken`，不走 binding
- **参考**: 同样把 web-search 视作独立服务，**也用 state**
- **角色**: 设计上是孤岛模块。**不修也行**

---

## 4. 优先级 & 顺序

按"用户能感受到的功能完整性"× "下游 consumer 是否被阻塞"两个维度排：

| 优先级 | Gap | Milestone | 工程量 | 为什么这个顺序 |
|---|---|---|---|---|
| **P0** | #5 Probe 真实化 | M3 | 小（1 天） | admin 现在没法验证配置；阻塞 dashboard UI 的可用性 |
| **P0** | #6 Usage rewrite migration | M3 | 小（半天） | 一次性 DDL，越晚做老数据越多越脏 |
| **P1** | #7 Dashboard UI 接 /api/upstreams | M5 | 大（3-5 天） | M1-M4 能力的交付出口；做完才算"管理"功能闭环 |
| **P1** | #4b Flag catalog defaultFor | M4 | 小（半天） | UI 三态 radio 的前置依赖，跟 #7 一起做 |
| **P2** | #4a 按 upstream 隔离 cache invalidate | M4 | 中 | 多 upstream 后才显出价值 |
| **P3** | #8 Failover | M6 | 中 | 参考项目都没做，设计先 ship 单路径 |
| **P3** | #9 binding list cache | M6 | 小 | D1 < 5ms，不优先 |
| **P3** | #10 web-search binding | M6 | 大 | 改 interceptor 签名，性价比低 |

**本轮决定**：做 P0 两个 (Probe + usage rewrite)，验证后再上 P1（dashboard UI）。

---

## 5. 各 Gap 实施微调

### Gap 5 (Probe 真实化)

**接口设计**:
```ts
interface ModelProvider {
  // existing: callChatCompletions / callMessages / callResponses / ...
  probe(): Promise<ProbeResult>
}
interface ProbeResult {
  ok: boolean
  modelCount?: number
  models?: string[]  // first 50
  status?: number    // upstream HTTP status
  error?: string     // first 1000 chars
}
```

**Copilot probe**: 调 `getRawModels(token, accountType)`，捕获 fetch 错误。
**Custom probe**: GET `{baseUrl}/models` with bearer。
**Azure probe**: 跟参考项目一致，遍历 `deployments[]`，每个 deployment 按 `supportedEndpoints` 选 endpoint 发小 payload；但 v1 简化版只打 `/models`。

**control-plane**: `/api/upstreams/:id/test` 调 `createProviderFromUpstream(upstream)` → `provider.probe()`，把结果原样返回。

**对参考的微调**: Azure 简化为 v1 只 probe models endpoint，不逐 deployment 跑测试 payload。下一次迭代再加细。

### Gap 6 (Usage rewrite migration)

**SQL**:
```sql
-- migration 0027_rewrite_usage_upstream.sql
UPDATE usage
SET upstream = (
  SELECT u.id FROM upstreams u
  WHERE u.provider = 'copilot'
    AND json_extract(u.config_json, '$.user.id') = CAST(substr(usage.upstream, 9) AS INTEGER)
  LIMIT 1
)
WHERE upstream LIKE 'copilot:%'
  AND EXISTS (
    SELECT 1 FROM upstreams u
    WHERE u.provider = 'copilot'
      AND json_extract(u.config_json, '$.user.id') = CAST(substr(usage.upstream, 9) AS INTEGER)
  );

-- Same for performance_summary, performance_latency_buckets
```

**对参考的微调**: 参考用 CTE + 临时表更安全（避免重复 join），我们 D1 sqlite 直接 UPDATE 简化；用 EXISTS 保证 fallback 行不被改成 NULL。

### Gap 7 (Dashboard UI — 未来 M5)

**分 4 个 PR**:
1. 列表卡片（renderUpstreamList）
2. 编辑 modal（POST/PATCH）
3. Flag 三态 radio（Inherit/On/Off）
4. Probe 按钮 + 结果浮层

---

## 6. 不打算做的事

- ❌ 多 upstream 并发 race（"先返回的赢"）—— 不符合 LLM 计费语义
- ❌ Per-key 上游配额预算 —— 已经有 quota 但是 per-key，不复杂化
- ❌ Upstream-level rate limiting —— 上游自己有
- ❌ 跨 upstream 的 token / key 加密 —— 当前明文存 `config_json`，跟参考一致；要做就一起做 secret box

---

## 7. 本次会话的下一步行动

按 **P0 顺序**：
1. **Gap 5**: 给 `ModelProvider` 加 `probe()`，三个实现，control-plane 调用，单元测试
2. **Gap 6**: migration 0027，加测试覆盖
3. **整体功能测试**: 走一遍 chat / messages / responses / embeddings + admin 添加一个假 Custom 上游 + probe + 删除

完成后再决定是否 commit + push（仍不部署 CFW/SSH，继续 local docker 验证期）。
