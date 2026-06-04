# vNext Cutover Playbook

> **唯一目标**：把生产流量从 `copilot-api-gateway`（旧 worker）切到 `copilot-gateway-vnext`（vNext worker），过程对客户端 0 感知，24h 内可一键回滚。
>
> **核心保险**：两个 worker 共用同一个 D1 (`database_id = 9a81ab21-8c45-4fce-bf32-95796e574b16`)。cutover 不是数据迁移，只是 DNS 路由切换。

---

## 前置 Gate（全部 ✅ 才能进灰度）

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 1 | 功能等价覆盖矩阵 19/19 | ✅ | CUTOVER_AUDIT.md Gate 1 |
| 2 | 数据兼容矩阵 12/12 | ✅ | CUTOVER_AUDIT.md Gate 2 |
| 3 | vNext bun test 0 fail | ✅ | `bun test` → 237 pass / 30 files |
| 4 | Dashboard 静态资源 serve | ✅ | shared/edge/static-pages.ts，本地烟测 200 |
| 5 | SDK 集成测试双跑 | ⏳ 灰度阶段 | 见下 §灰度 |
| 6 | Fallback IR 回归 | ⏳ 灰度阶段 | 见下 §灰度 |

---

## 阶段 0 — Deploy（不切流）

```bash
# 1) 同 D1 资源、新 worker name
cd vnext
bun run typecheck                    # 必须 0 error
bun test                             # 必须 0 fail
wrangler deploy --name copilot-gateway-vnext
# → 部署到 copilot-gateway-vnext.workers.dev，与旧 worker 完全独立的 worker，共用同一个 D1
```

**验证**：
- `curl https://copilot-gateway-vnext.workers.dev/health` → `{"status":"ok"}`
- `curl https://copilot-gateway-vnext.workers.dev/debug/db/users-count` → 旧库真实 users 数（证明共库）
- 用 admin session 打开 `https://copilot-gateway-vnext.workers.dev/dashboard`，能看到全部旧数据（upstream、key、quota、token usage、observability share）

**Schema 演进保证**（这一阶段以后不再动）：
- 任何新 migration 一律先在旧项目 `migrations/` 落地 → `bun run deploy:full`（旧 worker 部署带 migration）→ 等旧 worker 稳定 → `cp` 到 `vnext/migrations/` → vNext 部署
- 反向（vNext 加 migration，旧 worker 没有）会立刻打死旧 worker，**禁止**

---

## 阶段 1 — 灰度（vNext.workers.dev 上 dogfood + SDK 双跑）

> 目的：用真流量验证 vNext，**完全不影响生产**——旧 worker 仍是 DNS 默认。

### 1.1 SDK 集成测试双跑

```bash
# 旧 worker
TEST_API_BASE_URL=https://copilot-api-gateway.<account>.workers.dev \
  bun test tests/sdk-anthropic.test.ts tests/sdk-openai.test.ts tests/sdk-gemini.test.ts \
  > /tmp/old-sdk.log

# vNext worker
TEST_API_BASE_URL=https://copilot-gateway-vnext.<account>.workers.dev \
  bun test tests/sdk-anthropic.test.ts tests/sdk-openai.test.ts tests/sdk-gemini.test.ts \
  > /tmp/vnext-sdk.log

# diff 两侧 SDK 高层断言（text / tool_calls / finish_reason / usage / status code）
diff /tmp/old-sdk.log /tmp/vnext-sdk.log
```

**通过门槛**：所有 SDK 高层断言两侧一致；SSE 中间事件序差异允许（plan §0 原则）。

### 1.2 Fallback IR 回归

5 个 fallback route（chat→msg / chat→resp / gemini→msg / gemini→resp / msg→resp）的真实 fixture：vNext 已通过 IR 主路径覆盖（CUTOVER_AUDIT.md Gate 1 #8-#12）。灰度阶段从生产日志捞 ≥10 条样本回放到 vNext，SDK 高层断言对齐即可。

### 1.3 本地 dogfood ≥ 3 天

把本机 Claude Code / Codex CLI 的 `ANTHROPIC_BASE_URL` 指到 `copilot-gateway-vnext.workers.dev`，正常工作 3 天无异常（重点关注：长上下文、tool_call 多轮、image_generation、web_search）。

### 1.4 Dashboard 双开

浏览器开两个标签页：`copilot-api-gateway.<account>.workers.dev/dashboard` 与 `copilot-gateway-vnext.<account>.workers.dev/dashboard`，所有面板（accounts / upstreams / token-usage / quota / observability shares）数据一致——证明共库 + 两边读写不打架。

---

## 阶段 2 — Cutover（DNS 切流）

> **预计窗口**：低峰期，30 分钟，主要时间是观察。
>
> **不动**的东西：D1、KV、IMAGES、R2、旧 worker（保留 1 周做回滚兜底）。

### 2.1 切流

通过 Cloudflare 控制台把生产域名（旧 worker 绑定的 custom domain / route）从 `copilot-api-gateway` 改绑到 `copilot-gateway-vnext`。

### 2.2 0-15 分钟监控

- `wrangler tail copilot-gateway-vnext` 看 error 率
- `/health`、`/v1/messages`（小 prompt smoke）、`/dashboard` 各打 1 次
- p99 latency、429 retry 命中率与旧 worker 切流前对齐

### 2.3 24h 监控

- 客户端报错率（dashboard token-usage 面板看 quota 异常、key 失败）
- 任意 P0 异常 → 立刻执行 §阶段 R 回滚

---

## 阶段 R — 回滚（24h 内任何 P0 都执行）

```
1. Cloudflare 控制台把 custom domain 改回 copilot-api-gateway
2. 完成 — 因为同 D1，回滚 0 数据丢失，立刻恢复
3. 在 vNext issue 里记录 P0 现象 + 复现 fixture，回到 §阶段 1 修复后重走 cutover
```

回滚是 one-click，所以 cutover 不需要"先停写"或"维护窗口"。

---

## 阶段 3 — 灰度后（cutover 24h 稳定后）

### 3.1 观测层补齐（plan 步骤 5 后置）

vNext data-plane 当前未写 `usage_records` / `latency_records` / `performance_telemetry`——dashboard token-usage 等面板会"切流后 24h 内开始空窗"。补齐顺序：

1. data-plane provider 出口加 `usage.upsert` + `latency.insert` 调用（旧 schema 100% 沿用，repo 接口已就位）
2. orchestrator loop 加 per-tool 调用计数
3. 长尾再补 SSE event trace

### 3.2 旧 worker 退役

cutover 后第 7 天：

```bash
wrangler delete copilot-api-gateway      # 旧 worker 下线
# 旧项目 src/ 提一个 PR：rm -rf src/ scripts/ tests/，把 vnext/* 提升到 repo 根
```

---

## 应急联系点

- D1 dashboard: https://dash.cloudflare.com/.../workers/d1/databases/9a81ab21-8c45-4fce-bf32-95796e574b16
- 旧 worker: `copilot-api-gateway`
- vNext worker: `copilot-gateway-vnext`
- 共用 D1 database_id: `9a81ab21-8c45-4fce-bf32-95796e574b16`
- KV / IMAGES / R2: 与旧 worker 同一 binding（见 `vnext/apps/gateway/wrangler.jsonc`）
