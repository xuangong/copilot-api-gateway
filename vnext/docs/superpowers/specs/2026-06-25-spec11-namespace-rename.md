# Spec 11 — Namespace Rename (`@vnext-*` → `@vibe-*`)

**日期:** 2026-06-25
**前置:** vNext Roadmap §3 step 6 (Final epilogue)
**对象:** `vnext/` workspace 全部 19 个包

---

## 1. 目标 & 范围

纯 codemod。把临时命名 `@vnext-*` 整体迁到对外品牌 namespace `@vibe-*`，为业务层定基调。

**框架层** `@vnext-gateway/*` → `@vibe-core/*`
**业务层** `@vnext-llm/*` → `@vibe-llm/*`

**显式不在范围:**
- 任何源码逻辑、行为、test、interface 改动
- 任何包的物理目录名 / 文件名
- 根 `package.json` 的 `"name": "copilot-gateway-vnext"`（留给 §3 step 7 cutover）
- CFW 部署（按 `spec8_execution_constraints`,只做 local docker 测试）
- push / merge main

## 2. 完整映射表

### 2.1 框架层 (7 个) — `@vibe-core/*`

| 当前 | 新 |
|------|-----|
| `@vnext-gateway/platform` | `@vibe-core/platform` |
| `@vnext-gateway/http` | `@vibe-core/http` |
| `@vnext-gateway/cache` | `@vibe-core/cache` |
| `@vnext-gateway/result` | `@vibe-core/result` |
| `@vnext-gateway/upstream` | `@vibe-core/upstream` |
| `@vnext-gateway/service` | `@vibe-core/service` |
| `@vnext-gateway/chat-flow-kit` | `@vibe-core/chat-flow-kit` |

### 2.2 业务层 (12 个) — `@vibe-llm/*`

| 当前 | 新 |
|------|-----|
| `@vnext-llm/protocols` | `@vibe-llm/protocols` |
| `@vnext-llm/translate` | `@vibe-llm/translate` |
| `@vnext-llm/responses-store` | `@vibe-llm/responses-store` |
| `@vnext-llm/provider-llm` | `@vibe-llm/provider-llm` |
| `@vnext-llm/provider-copilot` | `@vibe-llm/provider-copilot` |
| `@vnext-llm/provider-azure` | `@vibe-llm/provider-azure` |
| `@vnext-llm/provider-custom` | `@vibe-llm/provider-custom` |
| `@vnext-llm/provider-sdf` | `@vibe-llm/provider-sdf` |
| `@vnext-llm/gateway` | `@vibe-llm/gateway` |
| `@vnext-llm/dashboard` | `@vibe-llm/dashboard` |
| `@vnext-llm/platform-bun` | `@vibe-llm/platform-bun` |
| `@vnext-llm/platform-cloudflare` | `@vibe-llm/platform-cloudflare` |

### 2.3 `chat-flow-kit` 归属判定

定为框架层 (`@vibe-core/chat-flow-kit`)。依据：
- `serve-template.ts` 零 LLM 字面量;`TPayload/TAttemptResult/TAuth/TTelemetryCtx` 全泛型;`endpointTag` opaque
- Spec 10 显式强调 "domain-neutral",purity gate 禁止 import `@vnext-llm/*`
- 满足 roadmap §1.1 "服务任何 vertical" 判别法

包名里的 "chat-flow" 听起来像 LLM 词,但指的是 chat-style 请求-响应流的抽象形态。如要进一步重命名 (`serve-kit` / `flow-kit`) 另开 spec,不在本次范围。

## 3. 改动位点

### 3.1 必改

- 19 个 `packages/*/package.json` + `apps/*/package.json` 的 `"name"` 字段
- 上述文件 `dependencies` / `devDependencies` 中 workspace 互引
- 所有 `.ts` / `.tsx` 文件的 `import ... from '@vnext-*/...'` (普通 + `import type`)
- `vnext/scripts/check-framework-purity.ts` (10 处字面量)
- `vnext/tsconfig.base.json` 的 `paths` 映射 (若有)
- `vnext/eslint.config.mjs` 等配置里字面量 (若有)
- `vnext/docs/` 下文档中明确引用包名的位置

### 3.2 不改

- `vnext/apps/platform-bun/Dockerfile` 的 `COPY packages/<dir>/package.json packages/<dir>/` —— 用的是物理目录名,不变
- 根 `vnext/package.json` 的 `"name"`
- 物理目录名 (e.g. `packages/chat-flow-kit/` 保留)
- 文件名、class 名、interface 名
- import 顺序 / 风格

### 3.3 现状量级 (实施前 baseline)

- `rg "@vnext-(gateway|llm)" --type ts --type json` 命中 306 个文件
- 19 个 workspace 包
- 1001 测试基线 (Spec 10 acceptance log)

## 4. 执行风格

**单一 PR / 单一连续操作**:一次性全量替换 + 重装 + 跑测。

理由:
- monorepo workspace 解析对部分迁移敏感,中间状态立刻坏,没价值停在中间
- 改完后 `bun test` + `bun typecheck` 是验证回归的唯一真相,分批反而要分批 install / 验证多次
- 改名机械,没有按包 review 的必要

## 5. 实施步骤 (高阶,plan 展开)

1. 创建 baseline checkpoint:确认当前 `bun test` 1001 pass,`rg "@vibe-(core|llm)"` 返回 0
2. 全仓库批量替换:
   - `rg -l "@vnext-gateway" | xargs sed -i '' 's|@vnext-gateway|@vibe-core|g'`
   - `rg -l "@vnext-llm" | xargs sed -i '' 's|@vnext-llm|@vibe-llm|g'`
   - 跳过 `node_modules` / `bun.lock` / `.git`
3. `rm -rf node_modules bun.lock && bun install`
4. `bun run test` (workspace-wide,期望 1001 pass)
5. `bun run typecheck` (kit + gateway,期望与 Spec 10 baseline 相同的 pre-existing translate 错误,无新增)
6. `bun run scripts/check-framework-purity.ts` (脚本本身已改完)
7. `docker build --no-cache -f apps/platform-bun/Dockerfile -t vnext-platform-bun:spec11 .`
8. `docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d`
9. 跑 Spec 10 acceptance log 同款四 endpoint smoke (chat-completions / messages / responses / gemini),全部 200
10. 单一 commit:`refactor(vnext/spec11): rename @vnext-* namespaces to @vibe-*`

## 6. 验收 (acceptance gates)

| ID | Gate | 期望 |
|----|------|------|
| A1 | `bun run test` workspace-wide | 1001 pass, 0 fail |
| A2 | `chat-flow-kit` + `gateway` typecheck | kit 干净;gateway 仅保留 Spec 10 已记录的 `@vibe-llm/translate` (原 `@vnext-llm/translate`) Gemini 错误,无新增 |
| A3 | `rg "@vnext-(gateway\|llm)" vnext/` | 返回空 (注释、文档全部清掉) |
| A4 | `rg "@vibe-(core\|llm)" vnext/` 计数 | ≈ 替换前 `@vnext-*` 总数 (允许差 ±5,因可能合并行/转义差异) |
| A5 | docker no-cache build | 通过,无 "workspace package not found" 警告 |
| A6 | local docker compose up + 四 endpoint smoke | `/v1/chat/completions` / `/v1/messages` / `/v1/responses` / `/v1beta/.../generateContent` 全 200 |
| A7 | CFW live smoke | ⏸ 推迟到下次部署窗口 (按约束) |

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `bun.lock` 重建后 transitive 版本漂移 | `bun install` 不带 `--frozen-lockfile`,但跑完测试后 commit 新 lock。`bun test` 通过即视为安全 |
| sed 替换误伤 (例如某处字符串里有 `@vnext-gateway` 是注释/log 文本) | 通过 A3 grep 确认无残留;通过 A4 计数大致守恒 |
| 文档中残留旧名误导 | A3 显式覆盖 `vnext/docs/`;CUTOVER_*.md 也扫 |
| Dockerfile 内 stage-2 如有 `bun install --filter @vnext-*` 字面量 | 步骤 2 sed 全仓库覆盖,Dockerfile 也跑 |

## 8. 回滚方案

单一 commit。失败时 `git reset --hard HEAD~1 && rm -rf node_modules bun.lock && bun install` 即恢复。

## 9. 后续

完成后 vNext Roadmap §3 step 1-6 全部完成。下一项 step 7 (vNext → main 上位) 触发条件为 "vnext 完全替代根 src/ prod 行为",需独立 parity audit + cutover spec,不在 step 6 范围。
