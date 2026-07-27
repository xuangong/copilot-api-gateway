# Spec 13 — Responses ReAct Loop 移植(参考项目 → vNext)

**日期:** 2026-07-27
**前置:** Spec 8(vNext 精修阶段,本地 docker 测试,禁 CFW 部署)、Spec 12a data-plane parity audit 记账
**触发:** #172 fix 3a 在单轮架构下无处安放;`ServerToolHostedDispatch` 接口预留但无 callsite;image_generation 走独立单轮 `route-handler.ts`,web_search 缺失
**对象:** vNext `packages/gateway/src/data-plane/orchestrator/` + `chat-flow/responses/`,把参考项目 `copilot-gateway` 的 ReAct 多轮 + hosted 工具降级/回填搬过来

---

## 1. 目标 & 范围

**目标:** 让 vNext 的 `/v1/responses` 具备参考项目同款能力 ——
1. **多轮 ReAct**:一次请求内可连续多次调工具,直到模型自行结束
2. **Hosted tool 跨 provider**:`web_search` / `image_generation` 声明可运行在任何 upstream(不仅 GPT-Image / 原生支持通道),不支持时由 shim 降级为 function tool + 本地 dispatcher 兜底
3. **完整 #172 fix**:`tool_choice` 强制→auto 降级、原始 tool_choice 响应回填、hosted tool 声明 last-wins 且 dedupe-to-last
4. **`max_tool_calls` 语义生效**:递减、达 0 后禁调

**范围内:**
- 新增/改写 `orchestrator/loop.ts` → 真 ReAct 循环(参考 shim.ts:865-940)
- 移植 `server-tool-shim.ts`(1043 LOC)核心:`rewriteToolsForHostedShim` / `rewriteHostedToolChoice` / `restoreEchoedToolChoice` / `consumeTurnStreaming` / `runReactLoop` / `ActiveServerTool` 状态机
- 移植 `interceptors/server-tools/web-search.ts`(660 LOC)完整
- 移植 `interceptors/server-tools/image-generation.ts`(1553 LOC)完整,替代现有 `route-handler.ts` 单轮路径
- `ServerToolHostedDispatch` 接入 dispatch 表(`orchestrator/server-tools/registry.ts`)
- Responses attempt 层接入 `runInterceptors` 契约(如 vNext 已有等价物,直接挂;否则用最简同步链)
- 现有 588 测试与新 ReAct 逻辑对齐

**显式不在范围:**
- Chat Completions / Messages / Gemini 三个协议的 ReAct 化 —— 参考项目也只在 `/responses` 路径上跑 shim,其他协议靠 pairwise translation 落到 responses 或走 provider 原生工具
- Persistence(`StatefulResponsesStore` 私有 payload 存储)—— 若 vNext 尚未有对应 store,先落 in-memory stub,持久化另开 spec
- 灰度开关 / feature flag —— vNext 目前无生产流量,直接 cutover
- CFW 部署 —— Spec 8 禁令仍生效,仅本地 docker 验证
- #200 三个 interceptor backfill / #257 spilled_files —— 本 spec 完成后 resume

---

## 2. 参考项目锚点

| 文件 | LOC | 作用 |
|------|-----|------|
| `copilot-gateway/.../chat/responses/attempt.ts` | 230 | `responsesAttempt.invoke`,runInterceptors + dispatchResponses,ReAct 循环的外壳挂载点 |
| `copilot-gateway/.../interceptors/server-tool-shim.ts` | 1043 | 核心:降级、dispatch、`while(true)` 多轮、`materializeServerToolItems`、`synthesizeTerminalEnvelope` |
| `copilot-gateway/.../interceptors/server-tools/web-search.ts` | 660 | web_search plugin,含 `prepareToolsForShim`(last-hosted-wins filters) |
| `copilot-gateway/.../interceptors/server-tools/image-generation.ts` | 1553 | image_generation plugin,含 partial_image progressive events / images_edits 分派 |
| `.../interceptors/server-tools/*_test.ts` | 972 + 516 + 602 | 参考测试,可 1:1 移植 |

**关键调用序列(shim.ts 简化):**
```
prepareActiveServerTools()          // 每 plugin.register(inv, req) → ActiveServerTool[]
  → rewriteToolsForHostedShim()     // hosted → function tool 降级(last-wins)
  → rewriteHostedToolChoice()       // tool_choice: {type:web_search} → {type:function,name}
  → run()                            // upstream call 1
  → consumeTurnStreaming()          // 拦 function_call,匹配 dispatcher
  → materializeServerToolItems()    // 执行 slot.run(),吐 web_search_call / image_generation_call output item
  → 累加到 nextPayload.input, tool_choice='auto', max_tool_calls--
  → run() 2 … while(!sawClientToolCall && dispatched.length > 0)
  → synthesizeTerminalEnvelope()    // restoreEchoedToolChoice + echoedTools
```

---

## 3. vNext 落地切片(避免单 PR 巨爆炸)

按 review 粒度切成 5 个 phase,每 phase 独立可测、可回滚。

### Phase 13-A:orchestrator loop 骨架(纯管道)
- 把 `orchestrator/loop.ts` 从 stub 扩展为**多轮空循环**(iteration cap + turn accumulator + terminal envelope 合成),但**不接 hosted tool**
- 引入 `MergeState` / `TurnSummary` / `terminalStatus` 类型(照抄参考,只砍 persistence 依赖)
- 现有单轮调用点包 adapter:`runOrchestrator(input, { maxIterations: 1 })` = 旧行为
- **验收**:全部 588 测试通过,新增 ~15 个 loop 骨架 unit test(iteration 计数、terminal envelope 合成、终止条件)

### Phase 13-B:server-tool-shim 核心移植(不接 plugin)
- 移植 `rewriteToolsForHostedShim` / `rewriteHostedToolChoice` / `restoreEchoedToolChoice` / `prepareActiveServerTools`
- 移植 `consumeTurnStreaming`(function_call 拦截 + dispatcher 匹配 + slot 收集)
- Dispatcher 表挂到 `orchestrator/server-tools/registry.ts`,但**不注册任何 plugin**(注册表空)
- Feature flag 内部常量 `SERVER_TOOL_SHIM_ENABLED = false`(默认关),开启时走新路径
- **验收**:新增 ~30 个 shim unit test(降级、恢复、last-wins、tool_choice demote),对齐参考项目 shim.ts 测试

### Phase 13-C:web-search plugin
- 移植 `server-tools/web-search.ts` + 测试
- 注册到 registry
- `SERVER_TOOL_SHIM_ENABLED = true` 后,`/v1/responses` 声明 `{ type: 'web_search' }` 时走 ReAct
- **验收**:参考项目 web-search_test.ts 移植 ~15 个 case;`bun run local` docker + 手工 curl 一个 "search + summarize" 请求

### Phase 13-D:image-generation plugin(替代现有 route-handler)
- 移植 `server-tools/image-generation.ts` + 测试
- **删除** `orchestrator/server-tools/plugins/image-generation/route-handler.ts`(参考项目已无对应文件)
- 保留 `core.ts` 的 `generateImageViaBinding` / `collectImageSources` / `synthImageGenerationSSE` 作为 plugin 内部工具
- 之前打的 #172 fix 3b(`buildImageGenerationResponse` echo)**回退** —— 新 shim 的 `restoreEchoedToolChoice` 通吃
- **验收**:8 个 image-gen echo test 迁移到 shim 层;参考项目 image-generation_test.ts + integration_test.ts 移植;手工 curl 生图 + 编辑各一次

### Phase 13-E:cutover + 清理
- 移除 `SERVER_TOOL_SHIM_ENABLED` 常量,ReAct 成默认
- 更新 Spec 12a parity audit report:image_generation / web_search 从 gap → parity
- Backfill note:#172 从 "partial (fix 3b only)" → "full"
- **验收**:588 + 新增测试全绿;docker 端到端手工 pass;Spec 8 execution constraint 满足

---

## 4. 关键设计决策 & 风险

### 4.1 Persistence 简化
参考项目 `StatefulResponsesStore` 保存 hosted tool 的 `privatePayload`(image_generation 的原图 bytes、web_search 的私有查询状态),下一轮 replay 时 `transformItems` 读回。vNext 若无同款 store:
- **决策**:先落 in-memory Map(WeakMap<responseId, Map<itemId, unknown>>),TTL 5 min,进程重启即失效
- **风险**:同一 responses id 跨进程/跨机器请求会读不到 —— 但 vNext 当前 orchestrator 是 stateful per-request,不跨进程,可接受
- **后续**:另开 spec 接 D1 / SQLite persistence

### 4.2 Interceptor 链契约
参考项目用 `@floway-dev/interceptor` 的 `runInterceptors(inv, ctx, chain, terminal)`。vNext 若无:
- **调查**:phase 13-A 首步查 `chat-flow/responses/` 是否已有等价 middleware / hook 机制(spec12a audit 时应已列过)
- **备选**:最简同步链 —— shim 直接作为 `attempt.ts` 内的 wrapper 函数,不做通用 interceptor 抽象。等下一次跨协议需求出现再抽

### 4.3 Provider 差异
`callResponses` 目前在 vNext 通过 `LlmModelProvider.fetch` 走一层通用 HTTP 抽象,参考项目直接调 `candidate.provider.instance.callResponses(model, body, action, abortSignal, opts)`。
- **决策**:phase 13-A 时确认 vNext provider 层能否分辨 responses vs chat-completions upstream;不能则先加辨识,再动 loop
- **风险**:参考项目的 responses upstream event stream 与 chat-completions 完全不同格式,shim 只吃 responses 协议 event。若 vNext 的 responses upstream 走的是 chat-completions 翻译路径(见 `attempt.ts:161-181` `translateResponsesViaChatCompletions`),shim 必须挂在**翻译后**的 responses event 流上,而非翻译前

### 4.4 测试策略
- **单元**:每 phase 结束点全绿,不允许 skip
- **集成**:每 phase 结束用 `docker compose --env-file .env.vnext -f docker-compose.vnext.yml` 起容器,手工 curl 冒烟
- **参考项目移植**:参考测试保留原文件名 + 顶部注释 `// ported from copilot-gateway/.../XXX_test.ts @ ac3fd7909`
- **回归**:Spec 12a 已识别的 responses gap 项在 phase 13-E 结束时重跑 audit harness,确认从 gap 出列

---

## 5. 不做什么(明确 out-of-scope)

- Chat Completions / Messages / Gemini 的 ReAct 化
- `code_interpreter` hosted tool(参考项目也没有,预留接口即可)
- `file_search` hosted tool(同上)
- Persistence 层(D1 / SQLite 存 `privatePayload`)
- ReAct 循环的 concurrency(参考项目串行,vNext 也串行)
- 客户端强制协议升级(旧客户端仍看到 echo 后的 tool_choice = 客户端原始声明)
- CFW 部署验证(Spec 8 禁令)

---

## 6. 验收清单

- [ ] Phase 13-A:orchestrator loop 骨架 + 骨架测试 通过
- [ ] Phase 13-B:shim 核心移植 + shim unit test 通过
- [ ] Phase 13-C:web-search plugin 移植 + docker 手测通过
- [ ] Phase 13-D:image-generation plugin 移植,route-handler 删除,fix 3b 回退给 shim 接管
- [ ] Phase 13-E:cutover,588 + 新增测试全绿,Spec 12a report 更新
- [ ] #172 状态从 "partial" → "full",memory `common_pitfalls` 若有相关条目相应更新

---

## 7. 立项后立即产出(实施前先做)

1. **Phase 13-A 前置 audit**:vNext 现有 `chat-flow/responses/` 是否已有 interceptor 链?→ 决定 §4.2 走通用抽象还是最简 wrapper
2. **Provider 层辨识 audit**:vNext `LlmModelProvider` 是否已按 responses/chat-completions/messages 分流?→ 决定 §4.3 是否需前置 provider 改动
3. **StatefulResponsesStore 等价物 audit**:vNext 是否有 responses items store?→ 决定 §4.1 in-memory stub 层次

三个 audit 各占一节写到本 spec 后半段(§8/9/10),完成后再进 Phase 13-A。

---

## 8. Audit 1 — Interceptor 链契约(结论:直接复用,无需新抽象)

**位置:**
- `vnext/packages/service/src/index.ts:33` — `runInterceptors<Ctx, Req, R>(req, ctx, interceptors[], terminal)`
- `vnext/packages/protocols-llm/src/common/invocation.ts:36` — `ResponsesStreamInterceptor = Interceptor<RequestContext, Invocation, LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts` — 已注册 2 个 interceptor(`withOutputItemIdsSynchronized` / `withToolArgumentWhitespaceAborted`)
- `attempt.ts:254,317` — chain 已经通过 `runInterceptors(invocation, ctx, chain, terminal)` 包起来

**Interceptor 签名:**
```ts
type Interceptor<Ctx, Req, Result> = (req: Req, ctx: Ctx, next: () => Promise<Result>) => Promise<Result>
```

**关键限制:** `next` 是零参 `() => Promise<R>` —— interceptor 若要改 payload,**在 `next()` 前 mutate `invocation.payload`**(Spec 7 保留的零行为变更妥协,charter 里注明)。参考项目 shim 也是这么用的(`ctx.payload = nextPayload`),契约一致。

**结论:**
- **无需新抽象**。shim 就是**一个 `ResponsesInterceptor`**,放进 `responsesInterceptors[]` 数组
- 顺序:shim 放在**最内层**(数组末尾,最后包 terminal),这样外层 interceptor 看到的仍是"一次 responses 调用",与它们的假设一致(`withOutputItemIdsSynchronized` 等对 event 流做流式加工,不关心是否 ReAct 多轮)
- shim 内部的多轮 loop 就是**在 `next()` 前重置 `invocation.payload = nextPayload`,再调 `next()`**,吐出的 event stream 通过 async generator 拼接
- **Phase 13-A 落地:** 新增 `withResponsesReactLoop` interceptor 骨架文件,附单元测试证明"空 loop 直接透传 terminal 一次"和"iteration cap 生效"

## 9. Audit 2 — Provider 分流(结论:provider 层不需动)

**位置:**
- `vnext/packages/provider-llm/src/types.ts:56` — `LlmModelProvider.fetch(req: ProviderRequest)`
- `ProviderRequest.endpoint: EndpointKey`('responses' / 'chat_completions' / 'messages' / ...)
- `attempt.ts:264` — `providerReq.endpoint = 'responses'` 已显式声明,provider 会走 responses upstream 路径
- `attempt.ts:206-245` — 跨协议路径(`sel.targetEndpoint !== 'responses'`)由 `traverseTranslation` + `pickHubAttempt` 处理

**vNext 现状:**
- responses → responses(identity):`attempt.ts:247-322`,upstream 返回 SSE 由 `parseResponsesStream` 解析;非流式 JSON 由 `synthesizeResponsesFramesFromJson` 合成 frames
- responses → chat_completions / messages:走 `traverseTranslation`,payload 被翻译成 hub 协议,hub attempt 处理

**关键约束(参考项目对齐):**
- 参考项目 shim 挂在 `dispatchResponses` 之外(interceptor 链层),因此**它看到的 event 流永远是 responses 协议 frame**,无论 upstream 是原生 responses 还是翻译过来的
- vNext 同款:shim 挂在 `runInterceptors` 链上,terminal 内部翻译已完成,shim 看到的也是 responses frame

**结论:**
- **provider 层零改动**
- shim 生效范围:所有 `/v1/responses` 请求都跑,identity + 跨协议都覆盖
- **对跨协议尤为重要**:客户端在 Claude 上用 `{ type: 'web_search' }`,shim 把 hosted → function 降级,`traverseTranslation` 拿到的是**降级后的 function tool payload**,Claude upstream 就能接住;返回时 shim 拦函数调用,本地跑真实 web_search provider
- **注意:** 现有 attempt.ts:206-245 的 traverseTranslation 分支**在 interceptor 链之外**,shim 无法覆盖它。**Phase 13-A 首步要把 traverseTranslation 也搬进 terminal 内部**(或在 interceptor 链前 flip 到统一路径),否则 hosted 跨 provider 的核心卖点落空
  - 具体做法:改造 attempt.ts,让 terminal handler 内部按 `targetEndpoint` 分派(identity / traverseTranslation),外层 `runInterceptors` 统一包一层
  - 这是 Phase 13-A 的一个**结构性子任务**,需要独立 commit + 单元测试保证零行为变更

## 10. Audit 3 — Responses Store(结论:私有 payload 用 in-memory stub,不动 snapshot store)

**位置:**
- `vnext/packages/responses-store/src/types.ts` — `ResponsesSnapshotStore` 接口
- `vnext/packages/gateway/src/data-plane/dispatch/responses-store-bridge.ts` — `expandPreviousResponseId` / `savePostTurnSnapshot`

**vNext 现状:**
- 已有 `ResponsesSnapshot { responseId, apiKeyId, model, items: unknown[], createdAt, expiresAt }`
- 用途:previous_response_id 支持 —— 上一轮结束时保存 input+output items,下一轮展开进 payload.input
- 实现:`InMemoryResponsesSnapshotStore`(dev)+ `SqliteResponsesSnapshotStore`(prod)
- **缺失:** 无 `privatePayload` 概念 —— 参考项目 `ServerToolTerminal.privatePayload` 是 per-item server-only blob(例:image_generation 的原始 image_data,或 web_search 的私有查询状态)

**参考项目 privatePayload 的使用模式:**
- shim.ts:60-64:dispatcher 产出 `{ item, endEvents, privatePayload? }`
- `materializeServerToolItems` 把 `privatePayload` 注册到 `statefulResponsesContext.privatePayload.set(slot.id, blob)`
- 下一轮 `transformItems` 从 store 读回,把 wire item + private blob 重组成完整 IR
- 目的:**wire 上的 output item 只带 model 可见字段;敏感/大型内容(原图 bytes、上游 API 私有 state)藏在后端**

**决策:**
- **不动 `ResponsesSnapshotStore` schema**(避免同时改 D1 migration + snapshot 接口 + shim 三条战线)
- **Phase 13-D 起** 新增独立 in-memory 层:`PrivatePayloadStore`(`vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts`)
  - 接口:`get(responseId, itemId) → unknown | undefined`、`set(responseId, itemId, blob)`
  - 后端:`Map<responseId, Map<itemId, unknown>>`,TTL 5 min,进程重启失效
  - 生命周期:请求处理器持有一个 store 单例(平台工厂注入,类似 `snapshotStore`)
- **接受限制:** 单进程内正常工作;跨进程/跨机器请求(responses 通常是同一 SSE 连接内多次工具调用,天然在同一进程)读不到私有 blob → hosted tool 需要重跑上游(image_generation 需重传原图)
- **未来** 若产品需要跨机器,另开 spec 走 D1(或扩 `ResponsesSnapshotStore` 加 `privatePayloads` 字段)

**Phase 13-D 落地清单:**
1. 建 `PrivatePayloadStore` + in-memory 实现 + unit test
2. 平台工厂(bun / cloudflare)各注入一个 store 单例
3. `PrivatePayloadStore` 通过 `ctx` 或 shim 私有 args 传递给 dispatcher
4. image_generation plugin 的 `run()` 在 terminal 时 `set(responseId, itemId, imageBytes)`,下一轮 `transformItems` 从中读回

---

## 11. Audit 汇总 & 立即行动

| Audit | 结论 | Phase 13-A 是否受影响 |
|-------|------|---------------------|
| Interceptor 链 | 直接复用 `runInterceptors`,shim 就是一个 `ResponsesInterceptor` | 不受影响 |
| Provider 分流 | provider 层不动;但 **traverseTranslation 分支需搬进 terminal 内部**,shim 才能覆盖跨协议路径 | **Phase 13-A 需要一个结构性子任务:统一 identity + 跨协议进入同一个 terminal** |
| Store | 独立 `PrivatePayloadStore`,不动 snapshot store schema | Phase 13-D 才需要 |

**Phase 13-A 拆分:**
- **13-A-1** attempt.ts 结构统一:把 `traverseTranslation` 分支收进 terminal handler,保证 `runInterceptors` 包住所有分支 —— 零行为变更 commit
- **13-A-2** 新增 `withResponsesReactLoop` interceptor 骨架:空循环 + iteration cap + terminal envelope 合成
- **13-A-3** 骨架单元测试(~15 case)

进 Phase 13-A 时按 3 个 commit 分开提交,单独 review。
