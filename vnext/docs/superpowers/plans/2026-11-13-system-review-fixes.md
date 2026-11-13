# 系统 review 修复（2026-11-13）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 2026-11-13 系统 review 发现的问题，以及能修的风险项。用户原话："需要处理的问题要修，风险提示能修的也修。"

**Architecture:**
- 每项独立修改，各自配回归测试。
- Loki 相关的改动都限定在 Loki 上，不改变其他 provider 的目录行为。
- 协调器只有一处行为变化："连续失败 3 次以上、又没有快照的上游"改成后台重试。

**Tech Stack:** Bun 1.3.0、bun:test、SQLite（BunSqliteRepo）、React dashboard。

---

## 背景

- **工作目录：** worktree `.worktrees/system-review-fixes/vnext`，分支 `system-review-fixes`，基于 vNext `91b9da1f`。依赖已用 `bun install --frozen-lockfile --linker hoisted` 安装。
- **基线：** 先 `build:ui` 再 `bun test`，结果是 7244 个通过、1 个跳过、0 个失败；typecheck 通过，lint 0 个错误、38 个警告，dry-run 通过。
- **证据：**
  - relay `~/.llm-relay/config.db` 的 `traffic_log`；
  - 生产 D1 的 `model_catalogs` 和 `usage` 表，只做 SELECT，不读凭据列；
  - `wrangler tail` 抽样。

## 任务

### Task 1：`ci:local` 在测试前构建 UI
- 现象：全新 checkout 上 `bun run ci:local` 必然失败，65 个用例失败、61 个文件报错。原因是测试导入的 `dashboard-app/dist/*.txt` 在测试时还没生成。GitHub workflow 是先 `build:ui` 的。
- 改动：`package.json` 的 `ci:local` 改为在 `bun test` 之前运行 `bun run build:ui`，与 workflow 顺序一致。
- 验证：在一个新建 worktree 上从零跑 `ci:local`。

### Task 2：Loki 静态模型补全元数据
- 现象：11-13 09:00 UTC 起，Loki 用量的 `unit_price` 全部为 NULL，费用不再计入，按金额设的配额对 Loki 失效。静态条目同时丢了 `max_context_window_tokens`。
- 改动：在 `packages/provider-loki/src/models.ts` 中加入 `LOKI_KNOWN_MODELS`，这是 9 个已知 id 的 publisher、billing、limits 和端点，数据取自 2026-11-12 生产快照。静态目录中已知 id 用这些数据；未知 id 保持现状，按前缀推断端点、没有价格。
- 测试：在 provider 单测中，静态列表 `claude-opus-5.5`、`gpt-61-sol` 和一个未知 id 应得到：
  - 价格：input 4.4、output 22 美元每百万 token；
  - 上下文上限：100 万或 105 万；
  - 端点正确；
  - 未知 id 没有价格。

### Task 3：Loki 实时模式刷新不删模型
- 现象：Loki `/models` 在连接不稳定时返回残缺列表，例如 9 个里只有 4 个。实时模式会把它当作成功的刷新发布出去，模型因此掉出路由。
- 改动：
  - 在 `LlmModelProvider` 上加可选的 `reconcileCatalog(previous, next)`。
  - `registry.ts` 的 discover 在发布前调用它，`previous` 是同一身份下的当前快照。
  - Loki 实时模式返回并集，即保留之前有、这次缺的模型；静态模式原样返回。
  - 配置代数变化时 `previous` 为空，可以借此真正删除模型。
- 测试：provider 单测，以及经由协调器和 registry 的回归测试。

### Task 4：长期失败的上游不阻塞请求
- 现象：xanzh 上游已失败 9875 次。每次退避结束，都会有一个用户请求在路由阶段同步陪它拉取失败，最长 20 秒。
- 改动：`CatalogCoordinator.run()` 中，自动模式且非后台刷新时，如果没有快照，并且 `failureCount >= 3`，就立即抛出 `CatalogUnavailableError`；退避期已过的话，同时安排一次后台刷新。前两次失败仍按原来的方式在请求里重试。
- 测试：`catalog-coordinator.sqlite.test.ts` 新增用例：失败 3 次、退避已过时，读取立即失败、不等待 discover，并且安排一次后台刷新；后台刷新成功后，读取能拿到快照。

### Task 5：catalog-unavailable 报错写明模型和失败目录数
- 改动：
  - `EnumerateResult` 增加 `catalogFailures`；
  - `select-binding` 把它带进结果；
  - 四个 attempt 用 `modelCatalogUnavailableMessage(model, failures)` 生成报错，前缀仍是 "Model catalog is temporarily unavailable"；
  - 服务端用 `console.warn` 记下模型和失败的上游 id。
- 测试：select-binding 和 attempt 的现有测试同步更新，并新增一条报错文案的用例。

### Task 6：Codex 中断的两个边角情况
- 已选定 `response.incomplete` 时，中断应回 `accepted`，结束事件保持不变。
- 已进入出错路径时，中断应回 `failed`，不能先 `accepted` 再发 `error`。
- 测试：在 `turn-interrupt.test.ts` 中各加一条。

### Task 7：dashboard 的 Loki 实时预览
- Loki 面板保存设置、配对、解除配对后，清除该上游的实时预览，避免显示旧地址的模型。
- 改动：store 增加 `forgetLiveLokiModels(id)`，`UpstreamsTab` 的 `onChanged` 先调用它，再 `reload`。

### Task 8：CI 参照源码改用 git 拉取并校验
- 改动：
  - `scripts/ci-reference.ts` 用 `git fetch --depth 1 <url> <sha>` 加 `git checkout FETCH_HEAD` 拉取，用 `git rev-parse HEAD` 核对提交号，然后删除 `.git`；
  - 解压完成后写入 `.ci-reference.json`，内容为 revision；
  - 复用缓存前核对这个标记，不一致就重新拉取。
- 验证：用临时 HOME 跑 `bun scripts/ci-reference.ts`，再跑相关的 research 测试。

### Task 9：评审、门禁、汇报
- 代码评审（subagent）。
- 从零跑一次完整的 `ci:local`。
- 中文汇报，问用户是否提交和部署。

## 不改的项（汇报中说明）
- **静态模式的凭据检查：** 补上也没有效果。旧快照在凭据过期后照样继续路由（修改前也是这样），检查反而增加一个失败点。
- **`ci:local` 需要网络和 pwsh：** README 明确规定完整检查不跳过。
- **未知模型名按前缀推断端点：** 已知 id 已经由内置表给出端点。
- **非代码问题：** Cloudflare 到 Loki 的网络（可以配代理回退）、`/api/agent-remote/renew` 的频率、失效 key 的心跳 401。

## 执行记录

- **Task 1：** `ci:local` 改为 `ci:prepare → build:ui → purity → typecheck → test → lint → build:ui → dry-run`。`build:ui` 自带 `build:setup`，所以不需要单独跑。验证方法是删掉已被 git 忽略的 dashboard 构建产物，模拟全新 checkout，再从零跑 `ci:local`。
- **Task 2：**
  - 先写测试，确认失败（拿不到价格）。
  - 内置表 `LOKI_KNOWN_MODELS` 写成 Loki `/models` 原始格式，复用 `normalizeLokiModels`；查表用 `Map`，名为 `constructor` 的静态名不会命中原型。
  - 测试覆盖：价格（4.4 / 22 / 0.22 / 5.5）、上下文上限（100 万 / 105 万）、端点、未知名不定价。
- **Task 3：**
  - provider 单测和端到端回归测试（`loki-inference.sqlite.test.ts`）都先确认失败：残缺列表经"测试"按钮发布后，冷启动时 opus 消失。接线后通过。
  - 改配置后，确实会把删除发布出去。
- **Task 4：** 新增的协调器用例先失败（读取等满 1 秒预算后报 timeout），实现后通过。目录相关的 69 个测试全部通过。
- **Task 5：**
  - 新增 `modelCatalogUnavailableMessage`；`routing-materialization` 用例断言 `failedCatalogs: ["first"]`。
  - 消息测试里第一版前缀断言写错了（旧文案的句号），已改为直接断言前缀。
- **Task 6：** 两条用例先失败（`incomplete` 回了 false；出错后回了 true），修复后响应相关的 442 个测试全部通过。
- **Task 7：** 新增纯函数 `withoutLiveModels` 及其测试；`UpstreamsTab` 的 Loki 面板 `onChanged` 先清预览再 `reload`。
- **Task 8：** 用临时 HOME 验证：
  - 从零拉取得到固定提交，pnpm 安装成功，研究测试 13 个通过；
  - 复用缓存 1 秒完成；
  - 改动被跟踪的文件后会重新拉取并恢复。
  - README 的依赖从 `tar` 改为 `git`，说明同步更新。
- **typecheck、lint：** 全仓 typecheck 通过，lint 0 个错误、38 个警告（与基线相同）。
- **第一次完整门禁：** 先删掉 dashboard 构建产物，从全新 checkout 的状态跑 `ci:local`：7252 个通过、1 个跳过、0 个失败，lint 和 dry-run 也通过。
- **Task 8 与计划的差异：** 最终没有删 `.git` 改写标记文件，而是保留 `.git`，每次核对 `HEAD` 和被跟踪文件是否干净。这样连缓存里的文件被改动也能发现。
- **评审（subagent）：** 没有 Critical。处理如下：
  - **Important 1：** Loki 实时模式保留的名字原先永不过期。现改为在条目上记 `_loki_missing_since`，缺席满 24 小时就移除；重新出现的条目不带这个标记。已补测试。
  - **Important 2：** `response.incomplete` 送达之后再到的中断，会话原先回 `failed`。现在会话记录最近送达的 completed 或 incomplete 响应（`lastFinishedId`）。fixture 增加了 incomplete 终态，并补了会话级测试；`docs/responses-websocket.md` 同步更新。
  - **Minor：**
    - git 拉取加 120 秒超时；
    - 并发时 `rename` 失败，但缓存已完整，就照常使用；
    - 失败目录数至少按 1 计；
    - 内置表返回副本；
    - `ci:local` 去掉第二次 `build:ui`。
  - **未改：**
    - 显式刷新时 `previous` 可能落后一个版本。后果只是被漏保留的名字要等下一次刷新才回来，修复需要改协调器的加锁读取，不划算。
    - 两个价格比例看着不规律：核对过，是 2026-11-12 快照里 Loki 自己报的值。
