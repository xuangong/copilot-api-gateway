# Spec 14 — Per-API-Key Request Dump 移植(参考项目 → vNext)

**日期:** 2026-07-29
**前置:** Spec 8(vNext 精修阶段,本地 docker 测试,禁 CFW 部署)、Spec 12a/12b parity audit、Spec 13 ReAct loop
**触发:** vNext 完全缺失参考项目的 per-API-key request+response dump 能力 —— 无 `dump/` 模块、无 `dump_records`/`spilled_files` 表、无 `api_keys.dump_retention_seconds` 列,dashboard 无法排障单请求
**对象:** vNext `packages/gateway/src/`(新增 `dump/` 子模块)+ 两个 platform-* apps 的 schema 迁移 + `chat-flow/*/http.ts` 边界接入

---

## 1. 目标 & 范围

**目标:** 让 vNext 具备参考项目同款的 per-API-key request dump ——
1. **按 key 独立开关**:`api_keys.dump_retention_seconds IS NULL` 时零成本,非 null 表示滚动保留窗口(秒)
2. **完整请求快照**:method / path / headers / gzip 压缩后的 body 一并落盘
3. **完整响应快照**:HTTP 字节 body(passthrough)或 ProtocolFrame 序列(chat-flow SSE)择一,tee 出去不影响客户端
4. **属性归因**:model / upstream / input/output tokens / error kind(upstream|gateway|failed),中途 hook 填槽
5. **Dashboard 控制面**:paginated list、单条 detail、SSE live feed
6. **GC 生命周期**:`spilled_files` staged→committed→collectable,与滚动窗口过期清理协作

**范围内:**
- 新增 `packages/gateway/src/dump/`:`types.ts` / `accumulator.ts` / `store-contract.ts` / `broker.ts` / `wire.ts` / `codec.ts` / `registry.ts`,从参考项目 1:1 移植(路径 rewrite `@floway-dev/*` → vNext 等价符号)
- 新增 `packages/gateway/src/shared/repo/dump-store.ts`(FileDumpStore),同样 1:1
- 新增 `packages/gateway/src/control-plane/dump/routes.ts`(list / detail / SSE)
- 新增 SQL 迁移(两侧 platform apps):
  - `api_keys.dump_retention_seconds INTEGER NULL`
  - `dump_records` 表(key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor,复合索引 `(key_id, created_at DESC, id DESC)`)
  - `spilled_files` 表(file_key PK, owner_kind, owner_key, state, collect_after)+ claim_token 索引
  - `dump_records` 触发器:`validate_spilled_files`(INSERT 时校验 staged 行存在)+ `adopt_spilled_files`(INSERT 时把 staged 改成 committed)
- 扩 `ApiKey` 类型 + `API_KEY_COLS` + 两侧 repo 的 hydrator
- vNext 边界接入(每个 chat-flow http.ts 入口打开 accumulator,serve 层填 hook,响应从 finalize 通过):
  - `chat-flow/chat-completions/http.ts`
  - `chat-flow/messages/http.ts`
  - `chat-flow/gemini/http.ts`
  - `chat-flow/responses/http.ts`
  - `chat-flow/count-tokens/http.ts`
  - `data-plane/images/*`(routes.ts)
  - `data-plane/embeddings/*`
  - `data-plane/models/*`(list/get 仅记 request/response 字节,无 model/token 归因)
- Frame hook 挂到 chat-flow 的 telemetry-channel / respond 阶段(Spec 3 已就绪的 ProtocolFrame 出口)

**显式不在范围:**
- WebSocket Responses(vNext 还没有 WS 通道,`WS /v1/responses` 特例保留在参考项目)
- CFW 部署(Spec 8 禁令)—— 只跑本地 docker,`d1-repo.ts` 侧写 schema 但先不 apply
- Dashboard 前端 UI —— 只交付 API 端点,前端另开工
- `spilled_files` sweep 后台任务(#257)—— 本 spec 只写入 staged/committed 行,GC worker 不做
- 过期滚动删除的 cron 调度 —— `deleteExpiredBatch` 提供 API,调度另开
- Redaction / sanitization —— 参考项目本身也不做(dump 只对 key 拥有者可见)

---

## 2. 参考项目锚点

| 文件 | LOC | 作用 |
|------|-----|------|
| `copilot-gateway/.../dump/types.ts` | 148 | 三态 shape:write/storage/wire,`DumpMetadata` / `DumpErrorMeta` / `DumpStreamEvent` / `PreparedDumpRequestBody` |
| `copilot-gateway/.../dump/accumulator.ts` | 324 | `class DumpAccumulator` + `openDumpAccumulator(c, method, apiKey, requestBody, bg)`,4 属性槽 + finalize tee |
| `copilot-gateway/.../dump/store-contract.ts` | 30 | `DumpStore` 接口:prepareRequestBody / put / list / get / deleteExpiredBatch / findOldestCreatedAt |
| `copilot-gateway/.../dump/wire.ts` | 56 | `dumpRecordToWire`:Uint8Array → `{encoding:'utf8'|'base64', data}` |
| `copilot-gateway/.../dump/broker.ts` | 6 | `type DumpBroker = ChannelBroker<DumpMetadata>` + disabled reason 常量 |
| `copilot-gateway/.../dump/codec.ts` | 20 | 内部 encoding 工具 |
| `copilot-gateway/.../dump/registry.ts` | 33 | `getDumpStore()` / `getDumpBroker()` DI |
| `copilot-gateway/.../repo/dump-store.ts` | 315 | `FileDumpStore`:文件先写 + 触发器 adopt,list 走 `(created_at, id)` 复合游标,retention 窗口在读时 enforce |
| `copilot-gateway/.../repo/spilled-files-policy.ts` | ~10 | `DUMP_FILE_PREFIX = 'dumps/v1/'`, `SPILLED_FILE_STAGE_GRACE_MS = 3600_000` |
| `copilot-gateway/.../control-plane/dump.ts` | 86 | 三个端点:list / detail / SSE,`ownedKey()` 加 404-on-null-retention gate |
| `copilot-gateway/migrations/0066_expiration_sweeps.sql` | — | `dump_records` + 两触发器 + `spilled_files` claim_token 索引 |
| `copilot-gateway/.../data-plane/chat/shared/gateway-ctx.ts` | — | 整合示范:`openDumpAccumulator` 打开 + `finalizeGatewayResponse` tee |
| `copilot-gateway/.../data-plane/chat/shared/request-body.ts` | — | `RequestBody { bytes, streamError }` + `readRequestBody(c)` + `takeRequestBody`(读一次给 handler + dump 共用) |

**关键调用序列:**
```
readRequestBody(c) → RequestBody { bytes, streamError }
  → openDumpAccumulator(c, method, apiKey, requestBody, bg) → DumpAccumulator | null
    → dump.requestedModel(model)            // 请求解析后
    → dump.frame(f) …                        // 每个 ProtocolFrame 出口
    → dump.recordSentPayloadBytes(n) …       // WS/SSE 字节发送
    → dump.success(identity, usage) OR
      dump.error(kind, upstream?) OR
      dump.failed(reason)
    → finalizeGatewayResponse(ctx, response) // tee 响应字节 + schedule write
      → bg.waitUntil(dump.write(...))
        → store.put(keyId, record)           // spilled_files staged → files → dump_records → 触发器 adopt
        → broker.publish(keyId, meta)        // SSE live 订阅推送
```

---

## 3. vNext 结构差异

| 维度 | 参考项目 | vNext | 影响 |
|------|---------|-------|------|
| Gateway ctx | `createGatewayCtxFromHono` 统一入口,`ctx.dump` 挂 accumulator | 无 monolithic ctx,每个协议自己的 `http.ts` 用 `readAuth(c)` + `readObsCtx(c, auth)` | dump 接入点分散到每个 `http.ts`,不能一次性挂 |
| Response 出口 | `finalizeGatewayResponse(ctx, response)` 一处 tee | 每个 protocol 的 `serve*.ts` 返回 Response,没有统一 finalize | 需要在每个 `http.ts` 或每个 `serve*.ts` 尾部包 `dump?.finalize(response) ?? response` |
| ProtocolFrame 出口 | 参考项目走 `respond` 层集中 fan-out | vNext 走 chat-flow interceptors + telemetry-channel(Spec 3) | frame hook 挂 telemetry-channel 一处即可,天然覆盖 chat-completions/messages/gemini/responses 四协议 |
| Request body | `readRequestBody(c)` + `takeRequestBody` 显式一次读 | 各 `http.ts` 直接 `await c.req.json()`,body 只读一次(JSON parse 后原字节丢失) | **需要新增** `readRequestBody(c)` 等价物,parse 前先 `arrayBuffer()` 拿 Uint8Array,再 `JSON.parse(new TextDecoder().decode(bytes))`。所有 5 个 chat-flow `http.ts` + images/embeddings 边界改造 |
| ApiKey 结构 | 含 `dumpRetentionSeconds: number \| null` | 只有 quota / web_search 字段 | 扩 `ApiKey` 类型 + `API_KEY_COLS` + 两侧 hydrator + 迁移列 |
| BackgroundScheduler | `@floway-dev/platform` 的 `BackgroundScheduler` 类型 + `ctx.backgroundScheduler` | vNext `@vibe-llm/platform` 有 `waitUntil(p)` 单函数 | 直接用 `import { waitUntil } from '@vibe-llm/platform'` 代替 scheduler 参数;`openDumpAccumulator` 签名调整 |
| FileProvider | `@floway-dev/platform` FileProvider(`put/get/delete/list?`) | vNext `@vibe-llm/platform` FileProvider(相同签名) | 直接沿用 |
| SqlDatabase | 相同抽象 | 相同抽象 | 直接沿用 |
| ChannelBroker | `runtime/channel-broker-contract.ts` | 需查 vNext 是否有等价物 | **不确定** —— 若无则需要新写 in-process broker(SSE 用,一个 keyId → many subscribers) |

---

## 4. vNext 落地切片

按 review 粒度切成 4 个 phase,每 phase 独立可测、可回滚。

### Phase 14-A:Schema + Repo(纯 DB / repo 层,不接 accumulator)

**变更:**
- 两侧 platform apps 新增迁移:
  - `apps/platform-bun/src/bun-sqlite-repo.ts`:`ALTER TABLE api_keys ADD COLUMN dump_retention_seconds INTEGER NULL`,新建 `dump_records` + `spilled_files` 表 + 触发器
  - `apps/platform-cloudflare/src/d1-repo.ts`:等价 D1 schema(先写代码,不 apply)
- `packages/gateway/src/shared/repo/types.ts`:`ApiKey.dumpRetentionSeconds: number | null`
- 两侧 repo 的 `API_KEY_COLS` + hydrator 增列
- `packages/gateway/src/shared/repo/dump-store.ts`:`FileDumpStore` 类(1:1 移植)
- `packages/gateway/src/shared/repo/spilled-files-policy.ts`:两常量

**验收:**
- vNext bun 启动后 `sqlite3 <db>` 能看到新表 + 新列
- `SqliteRepo.apiKeys.getById(id)` 返回的对象含 `dumpRetentionSeconds` 字段
- 新增 ~20 个单元测试:`FileDumpStore.put/get/list/deleteExpiredBatch/findOldestCreatedAt`(用 in-memory FileProvider stub + bun:sqlite),对齐参考 `dump-store_test.ts`

### Phase 14-B:dump/ 模块移植(不接 http 入口)

**变更:**
- `packages/gateway/src/dump/` 全套 7 文件从参考项目 1:1 拷贝,路径 rewrite:
  - `@floway-dev/platform` → `@vibe-llm/platform`
  - `@floway-dev/protocols/common` → `@vibe-llm/protocols/common`
  - `@floway-dev/provider` → 对应 vNext 符号(需查)
  - `../repo/index.ts` → `../shared/repo/index.ts`
- `registry.ts`:`getDumpStore()` 返回 `new FileDumpStore(getSqlDatabase(), getFileProvider())`,`getDumpBroker()` 返回 in-process broker 单例
- Broker:若 vNext 无 `ChannelBroker`,新写 ~50 LOC 的 in-memory 实现(`Map<keyId, Set<AbortController + AsyncQueue>>`),支持 subscribe(signal) → AsyncIterable + publish
- `accumulator.ts` 的 `BackgroundScheduler` 参数换成从 `@vibe-llm/platform` import `waitUntil` 直接用(签名 `openDumpAccumulator(c, method, apiKey, requestBody)`,去掉 bg 参数)

**验收:**
- 新增 ~40 个单元测试:
  - `DumpAccumulator` 4 属性槽独立填(model / upstream / input+output tokens / error meta 精度)
  - success/error/failed 三态互斥、error 有 upstream 时覆盖 upstreamId
  - frame log 优先 > captured bytes > 'none' 的 body precedence
  - finalize(Response) tee 客户端字节不变、后台读全 body
  - finalize(status, headers) 二参数形态(为将来 WS 保留,当前不 wire)
  - `openDumpAccumulator` 返回 null 当 `dumpRetentionSeconds === null`
- `wire.ts` roundtrip 测试(utf8/base64 分支、fatal decode fallback)

### Phase 14-C:http 边界接入(全 chat-flow + images/embeddings)

**变更:**
- 新增 `packages/gateway/src/data-plane/chat-flow/shared/request-body.ts`(移植参考版本)
- 每个 `http.ts` 改造(共 5 个 chat-flow + images/embeddings routes):
  ```ts
  const auth = readAuth(c)
  const requestBody = await readRequestBody(c)
  const apiKey = auth.apiKeyId ? await repo.apiKeys.getById(auth.apiKeyId) : null
  const dump = apiKey ? openDumpAccumulator(c, c.req.method, apiKey, requestBody) : null
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(requestBody.bytes)) } catch { dump?.failed('invalid JSON'); return invalidJsonResponse() }
  dump?.requestedModel(String((raw as {model?: unknown})?.model ?? ''))
  const response = await serve*({ raw, auth, obsCtx: readObsCtx(c, auth), signal, dump })
  return dump?.finalize(response) ?? response
  ```
- 每个 `serve*.ts` 签名加 `dump?: DumpAccumulator | null`,内部:
  - 成功路径:`dump?.success(identity, usage)` after upstream resolve
  - 错误路径:`dump?.error('upstream', upstreamId)` / `dump?.error('gateway')` / `dump?.failed(err)`
- Telemetry-channel 一处集中挂 `dump?.frame(f)`(Spec 3 的 fan-out 点)

**验收:**
- 588 现有测试全绿(dump 默认关不改行为)
- 新增 ~15 个 e2e 测试(bun test 起本地 server + 打开某 key 的 dump_retention_seconds):
  - chat-completions non-stream 落一行 dump,body descriptor 存在
  - chat-completions stream 落一行 dump,frame log 非空,`response.body.type === 'stream'`
  - messages / gemini / responses 各一条 happy path
  - upstream 5xx 落 `error.kind = 'upstream'` 且 upstream id 正确
  - 请求 JSON 非法落 `error.kind = 'failed'` 且 reason 有意义
  - `dumpRetentionSeconds = null` 时不落任何 dump 行

### Phase 14-D:控制面 + SSE

**变更:**
- `packages/gateway/src/control-plane/dump/routes.ts`(移植参考 `control-plane/dump.ts` + `ownedKeyOr404` shim 已存在)
- `packages/gateway/src/control-plane/routes.ts` mount `controlPlane.route('/api/keys', dumpRoutes)`(与 `apiKeysRouter` 路径复用,dump 子路径在 `/keys/:keyId/records*`)—— **需查冲突**,可能改挂 `/api/dump` 顶层
- `wire.ts` 走 detail 出口

**验收:**
- 新增 ~10 个 e2e 测试:
  - `GET /api/keys/:id/records?limit=50` newest-first,分页游标 `?before=` 正确
  - `GET /api/keys/:id/records/:recordId` 返回完整 wire 记录,utf8/base64 分支正确
  - `GET /api/keys/:id/stream` SSE 首帧 `snapshot`,后续 `appended` 事件在下一条 dump 落地后 <100ms 内推
  - `dumpRetentionSeconds = null` 三个端点均 404
  - 非 owner 访问返回 404

---

## 5. 迁移与兼容

- 现有 api_key 数据:`dump_retention_seconds` 默认 NULL,零请求受影响
- 现有 dashboard:不感知 dump 端点缺席,加了也不破
- 现有测试:`ApiKey` 构造点需要加字段(nullable,`null` 即可),波及测试 fixtures 数量待评估(grep `dumpRetention` 全 0,`ApiKey {` 构造 ~15 处)
- Bun docker 本地部署:`bun run local` 起来后手动 `UPDATE api_keys SET dump_retention_seconds = 604800 WHERE id = ?` 一条 key 即可试 dump
- CFW:schema 代码写进 `d1-repo.ts` 但 `deploy:full` 前禁 apply(Spec 8 约束)

---

## 6. 已决 & 剩余风险

**已决(grep 后 2026-07-29):**
1. **ChannelBroker**:vNext 零匹配 → Phase 14-B 新写 in-process broker(`Map<keyId, Set<subscriber>>`)~50 LOC + 单测
2. **TelemetryModelIdentity**:`packages/protocols-llm/src/common/result.ts:12` ✓ 直接 import
3. **UpstreamProviderKind → UpstreamKind**:vNext 用 `UpstreamKind = 'copilot'|'custom'|'azure'|'sdf'`,直接替换符号
4. **UpstreamColor**:vNext `upstreams` 表**无 color 列**、`UpstreamRecord` 无 color 字段 → 简化 `DumpUpstreamRef` 去 `color`,`hydrateUpstream` 只回填 `{id, name, kind}`。dashboard 颜色徽标另行 spec
5. **api_keys.deleted_at**:vNext 零匹配 → `FileDumpStore.list/get` SQL 移除 `AND k.deleted_at IS NULL` clause,`deleteExpiredBatch` inactive 分支直接删除对应代码路径
6. **initBackground**:`apps/platform-bun/src/bootstrap.ts:32` 已 init ✓,accumulator 直接 `import { waitUntil } from '@vibe-llm/platform'`

**剩余风险:**
1. **Frame hook 覆盖度** —— Spec 3 telemetry-channel 是否 100% 覆盖 ProtocolFrame 出口(chat-completions/messages/gemini/responses)需 Phase 14-C 单测护栏,一次遗漏 → dump.body 从 stream 掉回 bytes/none。
2. **Migration atomicity** —— bun-sqlite ALTER TABLE + CREATE TABLE + CREATE TRIGGER 需要在同一次 bootstrap 里跑通,顺序:先建 `spilled_files` 再建 `dump_records`(触发器引用前者)。
3. **测试性能** —— dump e2e 每条至少一次 gzip + 一次文件写,588 → 613 后 `bun test` 单文件仍要 <2s。若超,把 Phase 14-C 的 6 个 happy path 合并到一个 describe。

---

## 7. 交付顺序 & PR 粒度

| Phase | PR 大小估计 | 依赖 |
|-------|-----------|------|
| 14-A schema + repo | ~400 LOC + ~20 tests | 无 |
| 14-B dump/ 模块 | ~700 LOC(1:1 移植)+ ~40 tests | 14-A |
| 14-C http 接入 | ~250 LOC(5-7 处改)+ ~15 e2e tests | 14-B |
| 14-D control-plane | ~120 LOC + ~10 e2e tests | 14-C |

每个 PR 独立可 merge、可回滚。14-A 落地后即可持续 review,不阻塞其他 vNext 工作。

---

## 8. 与已有 spec 的关系

- **Spec 3 telemetry-channel**:frame hook 复用其 fan-out 点,不新增出口
- **Spec 8 部署约束**:仅本地 docker 验证,`deploy:full` 前不 apply CFW 迁移
- **Spec 12a/12b parity audit**:本 spec 是 parity gap #(补记) 的具体交付
- **Spec 13 responses ReAct**:accumulator hook 天然覆盖 ReAct 多轮 —— 每轮的 frame 都会流过 telemetry-channel,一次 dump 记录一次完整 `/v1/responses`(含所有轮)
- **未来 spec**:sweep worker(#257)、dashboard UI、cron 过期清理、WS Responses dump 各自另开
