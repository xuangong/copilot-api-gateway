# vNext Cutover Audit — 2026-08-05

vNext 承担全部生产流量。旧 `src/` 已下线,本文件记录切流后的最终 gate 状态。

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
| 8 | chat-completions-messages-fallback.ts | IR (chatIn → messages-out 主路径) | ✅ 已删 |
| 9 | chat-completions-responses-fallback.ts | IR (chatIn → responses-out) | ✅ 已删 |
| 10 | gemini-messages-fallback.ts | IR (geminiIn → messages-out) | ✅ 已删 |
| 11 | gemini-responses-fallback.ts | IR (geminiIn → responses-out) | ✅ 已删 |
| 12 | messages/responses-fallback.ts | IR (messagesIn → responses-out) | ✅ 已删 |
| 13 | control-plane.ts | control-plane/upstreams/routes.ts | ✅ |
| 14 | api-keys.ts | control-plane/api-keys/routes.ts (15 endpoints) | ✅ |
| 15 | upstream-accounts.ts | control-plane/routes.ts (githubAccountsRouter) | ✅ |
| 16 | auth/ | control-plane/auth/routes.ts + github/google/device 子路由 | ✅ |
| 17 | dashboard.ts | shared/edge/static-pages.ts (GET /dashboard via DashboardPage) | ✅ |
| 18 | observability-shares.ts | control-plane/observability-shares/routes.ts | ✅ |
| 19 | index.ts | apps/platform-*/src/main.ts + shared/edge/static-pages.ts | ✅ |

**结论**:19/19 ✅。

## Gate 2: 数据兼容矩阵 (12 类持久化资产)

12/12 列对齐;SqliteRepo(Bun/Docker)与 D1Repo(CFW)委托到同一 `shared/repos.ts`,29 个 migration 全部存在于 `vnext/migrations/`。

## Gate 3: 本地功能基线

```
bun run ci:local
```

- ✅ framework-purity (`scripts/check-framework-purity.ts`) —— `@vibe-core/*` 无 `@vibe-llm/protocols` 反向依赖
- ✅ `bun run typecheck` —— 全 workspace 通过
- ✅ `bun test` —— **1391 tests / 0 fail / 221 files**
- ✅ `bun run lint` —— 0 errors(32 warnings,不阻断)
- ✅ `bun run build:ui` —— dashboard 产物落到 `gateway/shared/edge/ui-pages/dashboard-app/dist/`
- ✅ `wrangler deploy --dry-run` —— Worker 上传 2707.88 KiB / gzip 562.92 KiB,bindings(KV/D1/Images/env)全解析

## Gate 4: Provider 覆盖

6 个 provider 全部注册到 `data-plane/providers/registry.ts` 的 `PROVIDER_PLUGINS`:
`copilot` / `azure` / `custom` / `sdf` / `codex` / `claude-code`

- `codex`:Responses 原生 + compact 端点、access-token / OAuth refresh / terminal state / quota 全通;boundary chain 有 `withDefaultInstructions` + `withUnsupportedFieldsStripped`。alpha_search web-search 端点待单独 circle。
- `claude-code`:Messages 原生 + count_tokens;shaped-passthrough / mimicry-header / OAuth refresh + terminal state / quota 全通;`responses-compact-shim` 默认开启。
- 两家 provider 的 background write 均通过 `@vibe-core/platform` 的 `waitUntil` singleton 走,Node/Bun 是 no-op,CFW 映射到 `ExecutionContext.waitUntil`。

## Pending(未在本次审计通过)

1. **SDK 集成测试双跑** —— 需 `bun run local` + `tests/sdk-{anthropic,openai,gemini}.test.ts`,或走 `.github/workflows/vnext-remote-compat.yml` 手动 dispatch(需 `VNEXT_BASE_URL` / `ROOT_BASE_URL` / `TEST_API_KEY` secrets)。本仓库当前尚未运行 remote workflow,证据待补。
2. **CFW 生产部署** —— 用户要求在更多 local Docker 测试通过之前不动 CFW。

## Completed since 2026-08-05

- **Codex `/v1/alpha/search`** —— web-search 端点已移植(commit ea7f626),passthrough + local 双模式落 `data-plane/alpha-search/routes.ts`。
- **GitHub Actions 本地 gate** —— `.github/workflows/vnext-ci.yml` 已启用(push + PR to main/vNext,paths=vnext/**),镜像 `bun run ci:local`;`.github/workflows/vnext-remote-compat.yml` 走 workflow_dispatch,凭据缺失时输出显式 skipped summary。
