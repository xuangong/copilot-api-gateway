# vNext Cutover Playbook

> **状态(2026-08-05)**:cutover 已完成,vNext 承担生产流量。本文件保留为部署 / SDK 双跑 / 回滚 / 退役操作手册。
>
> **核心保险**:两个 worker 仍共用同一个 D1(`database_id = 9a81ab21-8c45-4fce-bf32-95796e574b16`),旧 worker 保留作回滚兜底。

---

## 前置 Gate

见 `CUTOVER_AUDIT.md`。本地一键校验:

```bash
cd vnext && bun run ci:local
```

跑过 = purity + typecheck + test + lint + build:ui + wrangler dry-run 全绿。等价 GitHub Actions workflow:`.github/workflows/vnext-ci.yml`(push / PR 自动触发,paths=`vnext/**`)。

---

## 部署

### Docker(推荐主路径 —— 本地 Docker 充分测试后再动 CFW)

```bash
# 参考 apps/platform-bun/
cd vnext && bun install
# 构建 dashboard(嵌入到 gateway 静态资源)
bun run build:ui
# 用户自己的 docker-compose / Dockerfile 运行 apps/platform-bun
```

### Cloudflare Workers(灰度 / dry-run)

```bash
cd vnext
bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry
# 通过后再:
# bun run --filter '@vibe-llm/platform-cloudflare' deploy
```

Wrangler config:`apps/platform-cloudflare/wrangler.jsonc`。生产切流不在本 playbook 范围;上线由用户手动触发。

**Schema 演进保证**:任何新 migration 一律先在旧项目 `migrations/` 落地并让旧 worker 部署 → 稳定 → `cp` 到 `vnext/migrations/` → vNext 部署。反向禁止。

---

## SDK 集成测试(灰度 / 回归 双跑)

需要真实凭据 —— 默认不在 `ci:local` 内。可选两条路径:

**A. 手动 workflow**(推荐,证据自动归档为 artifact):

  在 GitHub Actions 上 dispatch `.github/workflows/vnext-remote-compat.yml`,配置 `VNEXT_BASE_URL` / `ROOT_BASE_URL` / `TEST_API_KEY`(可选 `VNEXT_API_KEY` / `ROOT_API_KEY` per side)。缺 secret 时 workflow 输出显式 skipped summary,不当作 pass。

**B. 本地手动**:

```bash
# 旧 worker
TEST_API_BASE_URL=https://copilot-api-gateway.<account>.workers.dev \
  bun test tests/sdk-anthropic.test.ts tests/sdk-openai.test.ts tests/sdk-gemini.test.ts \
  > /tmp/old-sdk.log

# vNext worker(或本地 bun run local)
TEST_API_BASE_URL=https://copilot-gateway-vnext.<account>.workers.dev \
  bun test tests/sdk-anthropic.test.ts tests/sdk-openai.test.ts tests/sdk-gemini.test.ts \
  > /tmp/vnext-sdk.log

diff /tmp/old-sdk.log /tmp/vnext-sdk.log
```

通过门槛:SDK 高层断言两侧一致(text / tool_calls / finish_reason / usage / status),SSE 事件序差异允许。

---

## 数据面回归

`bun test packages/gateway/tests/data-plane` —— 覆盖 attempt / responses-store / server-tools / fallback IR。

Fallback IR(chat→msg / chat→resp / gemini→msg / gemini→resp / msg→resp)已由 vNext IR 主路径覆盖,fixture 从 `packages/gateway/tests/data-plane/chat-flow/*/fixtures/` 加载。

---

## 回滚

```
1. Cloudflare 控制台把 custom domain 改回 copilot-api-gateway
2. 完成 —— 同 D1,0 数据丢失,立刻恢复
3. vNext issue 记录 P0 现象 + 复现 fixture,修复后重走部署
```

回滚 one-click,不需要"先停写"或"维护窗口"。

---

## 旧 worker 退役

cutover 稳定 ≥ 7 天后:

```bash
wrangler delete copilot-api-gateway
# 根仓 rm -rf src/ scripts/ tests/,提升 vnext/* 到 repo 根
```

---

## 应急联系点

- D1 dashboard: https://dash.cloudflare.com/.../workers/d1/databases/9a81ab21-8c45-4fce-bf32-95796e574b16
- 旧 worker: `copilot-api-gateway`
- vNext worker: `copilot-gateway-vnext`
- 共用 D1 database_id: `9a81ab21-8c45-4fce-bf32-95796e574b16`
- KV / IMAGES / R2 bindings: `vnext/apps/platform-cloudflare/wrangler.jsonc`
