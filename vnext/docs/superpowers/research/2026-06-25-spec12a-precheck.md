# Spec 12a — Pre-check (双起 A1 gate)

**Date:** 2026-06-25
**Spec:** `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md` §2 / §6 A1 / §7

## Env isolation

| concern | root | vnext | verdict |
|---------|------|-------|---------|
| sqlite path | `.data/copilot.db` (200 KB, 6月  1 16:22) | `data-vnext/vnext.sqlite` → 容器 `/data/` (424 KB, 6月 25 15:55) | isolated ✅ |
| GH token 来源 | `.env` 无 `GITHUB_TOKEN` 字段 (root 走 sqlite 中已 oauth 的 copilot token) | `.env.vnext` 的 `VNEXT_DEV_GITHUB_TOKEN` (1 条命中) | **DIFFERENT** (两端独立 token 源) |
| port | 4141 (overridden from default 41414) | 41415 | distinct ✅ |

`.env` 与 `.env.vnext` 各只 2 行,字段无交集;sqlite 路径无交集;天然隔离。

## Health check

| server | start cmd | URL | status |
|--------|-----------|-----|--------|
| root | `PORT=4141 bun run local` (后台) | `http://127.0.0.1:4141/v1/models` | **HTTP 401** (无 Authorization) / **HTTP 401** (Bearer dummy) |
| vnext | `docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d` | `http://127.0.0.1:41415/v1/models` | **HTTP 200** (无 Authorization) / **HTTP 200** (Bearer dummy) |

两 server 都成功启动 — 无 connection refused / 502 / 504。**root 强制 auth,vnext 放行**。

## A1 verdict

**PASS-with-finding** — 两 server 都起来了,Part 3 可启动。但 `/v1/models` 的 status 不一致 (root 401 / vnext 200) 本身就是 spec §5 中 `behavior-gap` 候选,将在 Part 3 的 27 fixture 真跑时由 harness 捕获并记入 report (`models-v1` / `models-root` / `models-api` 3 条 fixture)。

不属于 blocker:harness 的 `diffStatus` 严格相等比较会正常产出 `behavior-gap` label,这正是 audit 想要的产出,不阻断 Part 3。

## Blockers (if any)

None.

## Concurrency decision

- Token 来源不同 (vnext 自带 dev token,root 走 sqlite oauth),严格说不会撞 quota
- 但保守起见,Part 3 harness **默认 sequential** (T7 已实现) — 27 fixture × 2 servers = 54 calls,串行 6-7 min 内完成,无并行收益

## Cleanup

- `docker compose -f docker-compose.vnext.yml down` → ✅ removed
- `pkill -f 'bun.*src/local'` → ✅ port 4141 freed
- Part 3 (T8) 会重起 servers 跑真 fixture
