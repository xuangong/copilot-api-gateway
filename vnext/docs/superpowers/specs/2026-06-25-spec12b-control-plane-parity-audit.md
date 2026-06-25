# Spec 12b — Control-Plane Parity Audit (vNext ↔ root src/)

**日期:** 2026-06-25
**前置:** Spec 12a 已通过 (data-plane parity 27/0)
**Umbrella:** Spec 12 (vNext Parity Audit),12b = control-plane sub-spec
**对象:** root `src/routes/{api-keys,control-plane,upstream-accounts,observability-shares,dashboard}.ts` ↔ vNext `packages/gateway/src/control-plane/*`

---

## 1. 目标 & 范围

证明 vNext 在 **行为级** 上 ≥ root `src/` 的 control-plane endpoints,产出 gap report,然后 **同 12a 节奏 audit + 全部 fix 到 parity 0**。

**显式范围 — 全量 33 个 endpoint:**

| family | endpoint × method | 计数 |
|--------|-------------------|------|
| api-keys | `GET /api/keys`、`POST /api/keys`、`GET /api/keys/:id`、`PATCH /api/keys/:id`、`POST /api/keys/:id/rotate`、`DELETE /api/keys/:id`、`GET /api/keys/:id/web-search-usage`、`POST /api/keys/:id/assign`、`DELETE /api/keys/:id/assign/:userId`、`GET /api/keys/:id/assignments`、`POST /api/keys/:id/copy-web-search-from/:sourceId` | 11 |
| upstreams | `GET /api/upstreams`、`POST /api/upstreams`、`PATCH /api/upstreams/:id`、`DELETE /api/upstreams/:id`、`POST /api/upstreams/:id/test`、`GET /api/upstreams/:id/models`、`GET /api/upstream-flags`、`POST /api/upstream-probe` | 8 |
| upstream-accounts | `GET /api/upstream-accounts` | 1 |
| observability-shares | `POST /api/observability-shares`、`DELETE /api/observability-shares/:viewerId`、`GET /api/observability-shares/granted-by-me`、`GET /api/observability-shares/granted-to-me` | 4 |
| dashboard | `GET /api/copilot-quota`、`GET /api/admin/copilot-quota/:githubUserId`、`GET /api/token-usage`、`GET /api/latency`、`GET /api/performance`、`GET /api/relays`、`GET /api/export`、`POST /api/import`、`POST /api/heartbeat` | 9 |
| **合计** | | **33**(17 GET、10 POST、2 PATCH、4 DELETE)|

**Method 计数明细 (用于 §4 fixture 数 sanity check):**
- POST 创建/动作: `POST /api/keys`、`POST /api/keys/:id/rotate`、`POST /api/keys/:id/assign`、`POST /api/keys/:id/copy-web-search-from/:sourceId`、`POST /api/upstreams`、`POST /api/upstreams/:id/test`、`POST /api/upstream-probe`、`POST /api/observability-shares`、`POST /api/import`、`POST /api/heartbeat` = 10
- PATCH: `PATCH /api/keys/:id`、`PATCH /api/upstreams/:id` = 2
- DELETE: `DELETE /api/keys/:id`、`DELETE /api/keys/:id/assign/:userId`、`DELETE /api/upstreams/:id`、`DELETE /api/observability-shares/:viewerId` = 4
- GET: 余下 17 个

**Mount prefix 校验:** root `src/routes/api-keys.ts` 挂在 `/api/keys` 前缀;vnext `packages/gateway/src/control-plane/api-keys` 需挂同 prefix。harness 直接以 root path 发请求,vnext 缺挂载 → `route-missing`。

**显式不在范围:**
- data-plane LLM endpoints (Spec 12a 已完成)
- auth flow / OAuth / device flow (Spec 12d)
- dashboard SPA 渲染 (Spec 12c)
- websocket / SSE control-plane channel (若有,推 12 epilogue)
- perf / latency 对比
- prod 上跑
- merge main (允许 push vNext 远端)

## 2. 双起 fixture + auth

| 实例 | 启动 | URL | env |
|------|------|-----|-----|
| root src/ | `PORT=4141 bun run local` | `http://127.0.0.1:4141` | repo root `.env` |
| vnext | `docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d` | `http://127.0.0.1:41415` | `.env.vnext` |

**Auth 策略:** 双端各自取得 admin session cookie + 共享一把 admin API key

实际现状(已 grep 验证):
- root `src/local.ts:347` 在 local 模式自动 seed `test@local.dev` admin user (fixed UUID)
- root 公开的 session 创建路径是 `POST /auth/email/login` (`src/routes/auth.ts`),走 magic-link 流程;`/auth/login` 仅做 token 校验
- vnext 当前 `docker-compose.vnext.yml` 只设 `VNEXT_DEV_*` env,**未自动 seed admin user**(blocker,Task 1 必须先解决)
- `/api/heartbeat` 双端都要求 `apiKeyId`(`src/routes/dashboard.ts:454` + `vnext/packages/gateway/src/control-plane/presence/routes.ts:47`),session cookie 会直接 401

因此 fixture 必须支持 **两种 auth header**:

| auth 模式 | header | 适用 fixture |
|-----------|--------|--------------|
| `admin-session` | `Cookie: session_token=${ADMIN_TOKEN}` | 几乎所有 control-plane CRUD |
| `api-key` | `Authorization: Bearer ${PARITY_*_ADMIN_API_KEY}` | `POST /api/heartbeat`、其他需要 `apiKeyId` 的端点(body 至少含 `clientId` + `hostname`,见 `src/routes/dashboard.ts:469`) |

**Bootstrap 流程 (Task 1 — 任一步失败即记 blocker 不继续):**

1. **Seed admin user — 双端 fixed UUID 对齐**
   - root: 起 server 时自动 seed `test@local.dev` (已有,`src/local.ts:347`)
   - vnext: docker entrypoint **需新增 seed**(若缺,blocker,记入 `12b-blockers.md`);写同一 fixed UUID,否则 ownerId 撕裂(已加 ignore 但 nested 引用仍污染)

2. **取 session cookie — 直接 seed sqlite/D1**
   - 现状两侧都没有 `/auth/dev-login`,**不依赖 dev bypass**;harness 起跑前调用本地 `bun run scripts/parity/seed-admin-session.ts`(新增,Task 1 一部分),直接读 sqlite/D1 写入一行 `sessions` 并 echo token 值
   - **强制要求:写入的 token 必须以 `ses_` 前缀开头**(root `src/local.ts:416` 和 vnext `packages/gateway/src/shared/session-auth.ts:60` 都按此前缀路由到 sessions 表;不带前缀会被当成 API key,走 `validateApiKey` 返 401)
   - 输出 env: `PARITY_ROOT_ADMIN_TOKEN` + `PARITY_VNEXT_ADMIN_TOKEN`(都形如 `ses_xxx...`)
   - **只有当 seed script 自身失败(db 文件不存在 / schema 缺 `sessions` 表 / 写入异常)才记 blocker**

3. **创建 admin API key — 留作 `api-key` 模式 fixture 使用**
   - chain 的开头额外加一个独立 `bootstrap-heartbeat-key` fixture(**不参与 api-keys CRUD chain,避免被 rotate/delete 影响**),响应字段是 `key`(root `src/routes/api-keys.ts:60`、vnext `vnext/packages/gateway/src/control-plane/api-keys/routes.ts:76`,**不是 `secret`**)
   - `capture: { "adminApiKey": "$.key" }`,harness 把它写入 env `PARITY_*_ADMIN_API_KEY`
   - 后续 fixture 若 `auth: api-key` → 用 env 注入 `Authorization: Bearer ${env.ADMIN_API_KEY}`
   - 双端各自的 key (独立 db),fixture 模板只看 status/shape

4. **Seed 第二个普通 user — 给 assignment / share chain 用**
   - `POST /api/keys/:id/assign` 和 `POST /api/observability-shares` 都禁止 self-share/self-assign,要求目标 user 已存在(`src/routes/api-keys.ts:459`、`src/routes/observability-shares.ts:25`)
   - 同样在 `seed-admin-session.ts` 里一并 seed,fixed UUID + 固定 email (例如 `parity-target@local.dev`)
   - 输出 env: `PARITY_TARGET_USER_ID` + `PARITY_TARGET_USER_EMAIL`(双端同值,因为 UUID 对齐)

**header 注入语法:** fixture 用顶层 `auth` 字段切换模式,而不是手填 `headers`:

```jsonc
{ "name": "list-keys", "endpoint": "/api/keys", "method": "GET", "auth": "admin-session" }
{ "name": "heartbeat", "endpoint": "/api/heartbeat", "method": "POST", "auth": "api-key", "body": { "clientId": "parity-client", "hostname": "parity-host" } }
```

harness 根据 `auth` 字段从 env 拼对应 header。

**Env 互斥前置 audit (Task 1 一并验证):**
- sqlite/D1 隔离同 12a
- session 表互相独立,seed 时双侧各写一次
- 任一端缺 admin user / cookie session 路径不存在 → spec blocked,blocker 记入 `vnext/docs/superpowers/research/12b-blockers.md`

## 3. Harness 工具

**位置:** `vnext/scripts/parity/control-plane-audit.ts` (新增,bun-native);共享 diff lib 抽到 `vnext/scripts/parity/lib/diff.ts`,12a 改 import 复用。

**Refactor (Task 0):**
- 从 `data-plane-audit.ts` 抽出: `maskHeaderValue` / `diffHeaders` / `deepDiff` / `diffJsonBody` / report writer / DiffEntry 类型 → `lib/diff.ts`
- **API 参数化** (避免 closure 漏出 data-plane 专用集合):
  ```ts
  export interface DiffRules {
    ignoreKeys: ReadonlySet<string>
    headerAllowlist: ReadonlySet<string>
    strongEnumKeys?: ReadonlySet<string>  // 例如 control-plane 的 'kind'/'provider'/'role'
  }
  export function diffJsonBody(root: unknown, vnext: unknown, rules: DiffRules): DiffEntry[]
  export function diffHeaders(rootH: Headers, vnextH: Headers, rules: DiffRules): DiffEntry[]
  ```
- `data-plane-audit.ts` 改为只保留 fixture loader、HTTP 双发、data-plane 专用 `DATA_PLANE_RULES` 常量、SSE diff、report path
- `control-plane-audit.ts` 定义自己的 `CONTROL_PLANE_RULES` 常量传入同一 lib
- 重跑 12a harness 验证 parity 27 不变

**Fixture schema 扩展** (顶层 `auth` 字段决定 header 注入,**禁止** fixture 自己写 `cookie` / `authorization` header — 否则 §2 step 4 的 API-key 模式无法切换):

```jsonc
{
  "name": "create-key",
  "endpoint": "/api/keys",
  "method": "POST",
  "auth": "admin-session",
  "body": { "name": "parity-test-key", "ownerId": null },
  "expect_status": 200,
  "capture": { "keyId": "$.id", "key": "$.key" }
}
```

```jsonc
{
  "name": "get-key",
  "endpoint": "/api/keys/${capture.create-key.keyId}",
  "method": "GET",
  "auth": "admin-session",
  "dependsOn": ["create-key"]
}
```

```jsonc
{
  "name": "heartbeat",
  "endpoint": "/api/heartbeat",
  "method": "POST",
  "auth": "api-key",
  "dependsOn": ["create-key"],
  "body": { "clientId": "parity-client", "hostname": "parity-host" },
  "expect_status": 200
}
```

```jsonc
{
  "name": "delete-key",
  "endpoint": "/api/keys/${capture.create-key.keyId}",
  "method": "DELETE",
  "auth": "admin-session",
  "dependsOn": ["create-key"]
}
```

**Harness 行为:**

1. Topological-sort fixtures by `dependsOn` (cycle → fail)
2. 每 fixture:对 root + vnext 各发一次请求,**双端 capture 互相独立** (root 的 keyId 用于 root 后续 fixture,vnext 同理),最后 diff 时只看 status/header/body 形状,不看 capture 值
3. 双端任一返回 non-2xx 而 fixture `expect_status` 是 2xx → 写 `behavior-gap` 但仍记录 capture (用 `null`),后续依赖 fixture skip + 标 `dependency-skipped`
4. 写 report 同 12a 风格

**diff 规则 (control-plane 专用):**

| 层 | 规则 |
|----|------|
| status | 严格相等 |
| header | 沿用 12a allowlist (`content-type, x-request-id, transfer-encoding, cache-control`) + 同 masking |
| JSON body | 递归 deep-diff;**忽略字段** 列表见下;**强校验字段** 列表见下 |

**BODY_IGNORE_KEYS (control-plane):**
```
id, createdAt, updatedAt, rotatedAt, lastUsedAt, expiresAt,
secretHash, keyHash, secret, sessionToken, cookie,
ownerId, userId, viewerId, granterId, githubUserId, apiKeyId, accountId,
totalRequests, totalTokens, totalCost, totalLatencyMs,
requestCount, tokenCount, latencyMs, latencyP50, latencyP95, latencyP99,
avgLatency, avgTokens, count, sum, min, max,
version, etag, nonce, fingerprint
```

**强校验字段 (control-plane):**
- 对象 shape (key set 必须一致,忽略 ignore 列表)
- 数组长度 (除非整个数组里的字段都在 ignore — 此时长度也忽略)
- enum 值: `kind` / `provider` / `status` / `enabled` / `role` / `scope`
- boolean 字段值
- 字符串 enum (例如 model id、provider 名)

**SSE / multipart:** control-plane 无 SSE;`POST /import` / `GET /export` 是 JSON 上传/下载,按 JSON body diff 处理。

## 4. Fixtures (≈ 50 条,含 stateful chain)

每个 endpoint family 都得有 GET / POST / PATCH / DELETE 完整 chain。**stateful chain 通过 capture 串联**;**assign / share 用 §2 step 4 seed 的 target user**:

| family | chain | fixture 数 |
|--------|-------|-----------|
| api-keys | create-key → get-key → patch-key → rotate-key → list-keys → get-web-search-usage → assign-key (target=PARITY_TARGET_USER_ID) → list-assignments → unassign → copy-web-search-from → delete-key | 11 |
| upstreams | get-upstream-flags → create-upstream → list-upstreams → patch-upstream → test-upstream → list-upstream-models → upstream-probe → delete-upstream | 8 |
| upstream-accounts | list-upstream-accounts | 1 |
| observability-shares | create-share (viewerEmail=PARITY_TARGET_USER_EMAIL) → list-granted-by-me → list-granted-to-me → delete-share | 4 |
| dashboard | bootstrap-heartbeat-key (capture `key`→env) → get-copilot-quota → get-admin-copilot-quota → get-token-usage → get-latency → get-performance → get-relays → export-data → import-data → heartbeat (auth=api-key, dependsOn=bootstrap-heartbeat-key) | 10 |
| **chain 额外:** | 每 family 末尾加 `cleanup-*` 验证 idempotent (delete 已删的资源 → 404 双端同) | +4 |
| **error 额外:** | 每个 POST 和 PATCH 各加一个 invalid body fixture (10 POST + 2 PATCH;4xx 双端同) | +12 |
| **合计** | 34 base + 4 cleanup + 12 error | **= 50** |

**调用预算:** 50 × 2 = 100 calls,串行 ~10-15 min。

## 5. Gap 分类 & label (沿用 12a)

| label | 含义 |
|-------|------|
| `parity` | 三层全 match |
| `cosmetic-diff` | 仅 ignored 字段或 allowlist 外 header 不同 |
| `behavior-gap` | 强校验字段不同 / status 不同 |
| `route-missing` | vnext 不挂该 path 或 405 |
| `dependency-skipped` | 上游 fixture 失败导致本 fixture skip |

## 6. Acceptance gates

| ID | Gate | 期望 |
|----|------|------|
| A0 | shared diff lib 抽出后 12a harness re-run parity = 27/0 不变 | 通过 |
| A1 | 双起 health check + admin token seed 成功 | 通过 |
| A2 | 50 fixtures 全跑完,无 harness crash | 50/50 |
| A3 | report 生成 (同 12a 风格 markdown) | 文件存在 |
| A4 | report summary 四类计数表 | summary 存在 |
| A5 | spec / harness+fixtures / report / fix commits 入 repo `vnext/scripts/parity/` + `vnext/docs/` | commit hash 可查;push vNext 远端,不 merge |
| A6 | **fix 闭环:fix-backlog 全部 commit 完成后,最终 parity 应 `behavior-gap + route-missing = 0`** (允许 `cosmetic-diff`) | 等于 12a 终态 |

## 7. 风险 & blocker

| 风险 | 缓解 |
|------|------|
| vnext 缺 admin user seed | Task 1 前置验证;缺则 spec blocked,记入 `12b-blockers.md`;**`seed-admin-session.ts` 必须把 session token 写成 `ses_` 前缀**(root `src/local.ts:416` 和 vnext `packages/gateway/src/shared/session-auth.ts:60` 都按此前缀路由到 sessions 表,否则会被当 API key 处理 → 401) |
| `/api/heartbeat` 需 apiKeyId 而非 session cookie | fixture `auth: api-key`,header 注入 `Authorization: Bearer ${ADMIN_API_KEY}` (chain 第 1 步 create-key 的 capture.secret) |
| assign / share 禁止 self-target | Task 1 同时 seed target user (`parity-target@local.dev`),env `PARITY_TARGET_USER_ID` / `PARITY_TARGET_USER_EMAIL` 供 fixture 引用 |
| 两侧 admin / target UUID 不同导致 ownerId 引用撕裂 | seed 时强制对齐 fixed UUID;不行则把 ownerId/userId 列入 ignore (已列) |
| `POST /import` 副作用大 (写整库) | fixture 用最小 import payload (空 array);双端各自的 db 隔离,不会互污 |
| `/api/upstreams/:id/test` 真发上游请求 | 用 fixture 里的 mock upstream (azure type + 假 endpoint);双端都失败但失败 shape 应同 |
| `POST /heartbeat` 写 presence 表带时间戳 | timestamp 已在 ignore;响应 body 通常 `{ok: true}` |
| dashboard `/export` 返回完整 db dump,极大 | fixture 选 `?redact=1`,且 diff 设 size 上限 (>1MB body 只看 status + shape 顶层) |
| stateful chain 中途失败导致级联 skip | `dependency-skipped` 标签 + report 顶部高亮 dependency 链断点 |
| session token 过期 (~24h) | harness 起跑前重新跑一次 `seed-admin-session.ts` 写新 token |
| vnext control-plane 部分 endpoint 实现度未知 (例如 import/export 可能未做) | report 输出 `route-missing` 即可,fix 阶段判 priority |

## 8. 显式不做

- 不做 data-plane (12a 已完成)
- 不做 auth / dashboard SPA / perf
- 不在 prod 上跑
- 不 merge main

## 9. 输出物清单

| 文件 | 类型 | 提交 |
|------|------|------|
| `vnext/docs/superpowers/specs/2026-06-25-spec12b-control-plane-parity-audit.md` | 本 spec | commit 1 |
| `vnext/docs/superpowers/plans/2026-06-25-spec12b-control-plane-parity-audit.md` | plan | commit 2 |
| `vnext/scripts/parity/lib/diff.ts` | shared diff lib | commit 3 (含 12a 改 import) |
| `vnext/scripts/parity/control-plane-audit.ts` | harness | commit 4 |
| `vnext/scripts/parity/fixtures/control-plane/*.json` (~50 文件) | fixtures | commit 4 |
| `vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md` | audit 输出 | commit 5 |
| `vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md` | fix 计划 | commit 5 |
| 每个 fix cluster | impl + re-run | commit N (按 12a 节奏) |

## 10. 后续

12b 全 fix 完成后 →
- 启动 12c (dashboard SPA parity) 或 12d (auth flow parity)
- 12a/b/c/d 全清零 → Spec 13 cutover (删 root src/、vnext 提升根)
