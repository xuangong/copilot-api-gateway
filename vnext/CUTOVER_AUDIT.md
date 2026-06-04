# vNext Cutover Audit — 2026-06-03

## Gate 1: 功能等价覆盖矩阵 (19 旧 route)

| # | 旧 route | vNext 归属 | 状态 |
|---|---|---|---|
| 1 | messages/ | data-plane/routes.ts:73 (messagesIn) | ✅ |
| 2 | chat-completions.ts | data-plane/routes.ts:114 (chatIn) | ✅ |
| 3 | responses/ | data-plane/routes.ts:118 (responsesIn) | ✅ |
| 4 | gemini.ts | data-plane/routes.ts:150 (geminiIn) | ✅ |
| 5 | embeddings.ts | data-plane/embeddings/routes.ts:69 | ✅ |
| 6 | images.ts | data-plane/images/routes.ts:136 | ✅ |
| 7 | models.ts | data-plane/models/routes.ts:35 | ✅ |
| 8 | chat-completions-messages-fallback.ts | IR (chatIn → messages-out 主路径) | ✅ 可删 |
| 9 | chat-completions-responses-fallback.ts | IR (chatIn → responses-out) | ✅ 可删 |
| 10 | gemini-messages-fallback.ts | IR (geminiIn → messages-out) | ✅ 可删 |
| 11 | gemini-responses-fallback.ts | IR (geminiIn → responses-out) | ✅ 可删 |
| 12 | messages/responses-fallback.ts | IR (messagesIn → responses-out) | ✅ 可删 |
| 13 | control-plane.ts | control-plane/upstreams/routes.ts:314 | ✅ |
| 14 | api-keys.ts | control-plane/api-keys/routes.ts:120 (15 endpoints) | ✅ |
| 15 | upstream-accounts.ts | control-plane/routes.ts:43 (githubAccountsRouter) | ✅ |
| 16 | auth/ | control-plane/auth/routes.ts:35 + github/google/device 子路由 | ✅ |
| 17 | dashboard.ts | shared/edge/static-pages.ts:33 (GET /dashboard via DashboardPage) | ✅ |
| 18 | observability-shares.ts | control-plane/observability-shares/routes.ts:23 | ✅ |
| 19 | index.ts | apps/gateway/src/app.ts + shared/edge/static-pages.ts (/, /device/login, /guide, /favicon.ico, /cdn/:file) | ✅ |

**结论**：19/19 ✅。Fallback 5 个全可删（IR adapter 都齐）。Dashboard 静态资源缺口已关：旧 src/ui/* 整体移到 vnext/apps/gateway/src/shared/edge/ui-pages/，由 shared/edge/static-pages.ts 挂在 app.ts 最后。本地烟测：/、/dashboard、/device/login、/guide、/favicon.ico、/cdn/:file 全 200。

### Dashboard 静态资源 — 已关闭

按方案 A 实施：将旧 src/ui/* 1:1 移到 vnext/apps/gateway/src/shared/edge/ui-pages/（dashboard-app 只保留 page.ts + dist/，SPA 源码丢弃以免污染 gateway tsconfig），新增 shared/edge/static-pages.ts 用 Hono 复刻旧 src/index.ts 的 5 个 HTML/CDN route。与旧项目行为一致，cutover 零差异。

## Gate 2: 数据兼容矩阵 (12 类持久化资产)

| # | 资产 | vNext repo 覆盖 | 状态 |
|---|---|---|---|
| 1 | users + user_password + user_email + user_avatar | shared/repos.ts INIT_SQL | ✅ |
| 2 | api_keys + api_key_quota + api_key_web_search* | 16 列对齐 | ✅ |
| 3 | key_assignments | 4 列对齐 | ✅ |
| 4 | github_accounts | 11 列对齐 | ✅ |
| 5 | upstreams + upstream_disabled_models | 11 列对齐含 disabled_public_model_ids | ✅ |
| 6 | device_codes | 6 列对齐 | ✅ |
| 7 | client_presence | 7 列对齐 | ✅ |
| 8 | observability_shares | 4 列对齐 | ✅ |
| 9 | web_search_engine_usage | 10 列对齐 | ✅ |
| 10 | performance_telemetry + usage_perf_upstream_cost | 含 upstream 列 + UNIQUE identity 索引 | ✅ |
| 11 | responses_items | 7 列对齐 | ✅ |
| 12 | inviteCodes | 7 列对齐 | ✅ |

**结论**：12/12 ✅。SqliteRepo + D1Repo 都委托到 shared/repos.ts（共 972 LOC），与旧项目 src/repo/shared/repos.ts 字节一致。29 个 migration 全部存在于 vnext/migrations/。

## Cutover Blocker 清单（截至今日）

1. ✅ **Dashboard 静态资源 serve** — 已关闭（shared/edge/static-pages.ts）
2. ✅ **vNext 本地功能基线** — `bun test` 30 files / 237 tests / 0 fail（control-plane + data-plane e2e + interceptors + orchestrator + server-tools + repo + auth 全覆盖）
3. （pending，需远程部署）SDK 集成测试双跑——本地无 Copilot 凭据，挪到灰度阶段（vNext 部署到 -vnext.workers.dev 后用 `tests/sdk-{anthropic,openai,gemini}.test.ts` 对两边各跑一次）
4. （pending，可与 #3 合并）5 个 fallback route fixture 双跑

非 blocker：观测层（plan 步骤 5，可后置）、cutover playbook（步骤 6，文档可在 gate 全过后写）。
