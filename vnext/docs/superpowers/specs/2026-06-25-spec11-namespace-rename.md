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
- `vnext/docs/` 下文档:统一按"历史快照不改"处理 (`specs/` + `research/` 全部保留旧名作为时间戳证据)。下一次 roadmap / charter 更新时由后续 commit 顺带改名,不在本 spec 范围。README 类 living doc 若引用包名则跟随必改

### 3.2 不改

- `vnext/apps/platform-bun/Dockerfile` 的 `COPY packages/<dir>/package.json packages/<dir>/` —— 用的是物理目录名,不变
- 根 `vnext/package.json` 的 `"name"`
- 物理目录名 (e.g. `packages/chat-flow-kit/` 保留)
- 文件名、class 名、interface 名
- import 顺序 / 风格

### 3.3 现状量级 (实施前 baseline)

代码层 baseline (与 A4 同范围,只数 `packages` + `apps`,排除 `scripts/check-framework-purity.ts` 的 legacy detection 字面量):

```bash
rg -l '@vnext-(gateway|llm)' vnext/packages vnext/apps
rg -o '@vnext-(gateway|llm)' vnext/packages vnext/apps | wc -l
```

- 19 个 workspace 包
- 1001 测试基线 (Spec 10 acceptance log)
- `vnext/scripts/` 单独有 ~13 处旧 scope 字面量,实施时 `check-framework-purity.ts` 按步骤 3 语义改 + 保留 legacy detection,不计入 A3/A4 守恒
- 文档/spec 层另算:Spec 10 acceptance log / spec / research 等历史快照保留旧名,不改

## 4. 执行风格

**单一 PR / 单一连续操作**:一次性全量替换 + 重装 + 跑测。

理由:
- monorepo workspace 解析对部分迁移敏感,中间状态立刻坏,没价值停在中间
- 改完后 `bun test` + `bun typecheck` 是验证回归的唯一真相,分批反而要分批 install / 验证多次
- 改名机械,没有按包 review 的必要

## 5. 实施步骤 (高阶,plan 展开)

1. 创建 baseline checkpoint:
   - 确认当前 `bun test` 1001 pass
   - 记录代码层 occurrence 数:`rg -o '@vnext-(gateway|llm)' vnext/packages vnext/apps | wc -l`
   - 锁定 typecheck baseline:`cd vnext && bun run typecheck 2>&1 | tee /tmp/spec11-typecheck-baseline.txt`
2. 全仓库批量替换 (代码 + 配置 + lock):
   ```bash
   rg -l '@vnext-gateway' vnext/packages vnext/apps vnext/scripts vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock 2>/dev/null \
     | xargs sed -i '' 's|@vnext-gateway|@vibe-core|g'
   rg -l '@vnext-llm' vnext/packages vnext/apps vnext/scripts vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock 2>/dev/null \
     | xargs sed -i '' 's|@vnext-llm|@vibe-llm|g'
   ```
   跳过 `node_modules` / `.git` / 历史 docs (Spec 10 log 保留 `@vnext-*` 作为时间戳证据)
3. **语义改 `vnext/scripts/check-framework-purity.ts`** (sed 无法完成):
   - 框架前缀:`@vnext-gateway/` → `@vibe-core/`
   - 业务前缀:`@vnext-llm/` → `@vibe-llm/`
   - bare 禁用规则:把 `UNSCOPED_VNEXT` 改成 `UNSCOPED_VIBE = /@vibe\/[a-z0-9-]+/i` (禁用 bare `@vibe/*`,强制带 `core` 或 `llm`)
   - 同时保留旧 `@vnext-(gateway|llm)/` / 旧 bare `@vnext/*` 的 detection,作为反 habit-revert 闸门
4. `bun install` (不动 `node_modules` / 不删 `bun.lock`;让 Bun 检测 workspace name 变化并刷新 lock 中相应 entry)
5. **lock-diff 守护:** `git diff vnext/bun.lock` 仅含 `@vnext-* → @vibe-*` workspace 改名,不能出现第三方版本变更;有则回滚步骤 4 排查
6. `bun run test` (workspace-wide,期望 1001 pass)
7. `bun run typecheck` 改完后再跑一次,与 `/tmp/spec11-typecheck-baseline.txt` diff;期望差异为空 (rename 不引入任何新错误,所有 pre-existing 错误的文件/行/类型与 baseline 完全一致;A2 的 baseline 已涵盖 translate Gemini 与 provider-azure/custom/sdf 的 BodyInit 错误)
8. `bun run scripts/check-framework-purity.ts` (脚本已按步骤 3 改完)
9. 从 repo root 执行 docker build (build context = `vnext/`):
   ```bash
   docker build --no-cache -f vnext/apps/platform-bun/Dockerfile -t vnext-platform-bun:spec11 vnext
   ```
10. 从 repo root 起 compose:
    ```bash
    docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d
    ```
11. 跑 Spec 10 acceptance log 同款四 endpoint smoke (chat-completions / messages / responses / gemini),全部 200
12. 单一 commit:`refactor(vnext/spec11): rename @vnext-* namespaces to @vibe-*`

## 6. 验收 (acceptance gates)

A3/A4 grep 的范围限定:`vnext/packages` + `vnext/apps` + `vnext/tsconfig.base.json` + `vnext/eslint.config.mjs` + `vnext/bun.lock`。

**A3 allowlist:** `vnext/scripts/check-framework-purity.ts` 显式排除 —— 该脚本按步骤 3 保留旧 `@vnext-*` legacy detection 字面量作为 anti-regression 闸门,grep 会命中但属于设计内残留。

`vnext/docs/` 历史文档 (`specs/`、`research/`、Spec 10 acceptance log、CUTOVER_*.md) 不入 zero-out 范围;living docs (roadmap / charter / README) 已在 §3.1 列入必改。

A3/A4/A4.1 完整命令 (raw-copy 可执行):

```bash
# A3 — 旧名零残留 (排除 purity 脚本)
rg '@vnext-(gateway|llm)' vnext/packages vnext/apps vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock
# 期望: 返回空

# A4 — 新名 occurrence 守恒
rg -o '@vibe-(core|llm)' vnext/packages vnext/apps | wc -l
# 期望: ≈ §3.3 baseline 数 (允许 ±5)

# A4.1 — lock-diff 限定:只看新增/删除行,且不允许任何非 workspace-rename 行
git diff -- vnext/bun.lock | rg '^[+-](?![+-])' | rg -v '@(vnext|vibe)-'
# 期望: 返回空 (所有 +/- 行都必须是 @vnext-* 或 @vibe-* 的 workspace 名重命名)
```

| ID | Gate | 期望 |
|----|------|------|
| A1 | `bun run test` workspace-wide | 1001 pass, 0 fail |
| A2 | `bun run typecheck` workspace-wide,与 step 1 锁定的 `/tmp/spec11-typecheck-baseline.txt` diff | 差异为空 (baseline 已涵盖:`@vibe-llm/translate` Gemini + `@vibe-llm/provider-azure/custom/sdf` BodyInit,与 Spec 8 A2 容忍范围一致) |
| A3 | 旧名零残留 | 见上方 A3 命令,返回空 |
| A4 | occurrence 守恒 | 见上方 A4 命令,≈ §3.3 baseline 数 (±5) |
| A4.1 | `bun.lock` diff 限定 | 见上方 A4.1 命令,仅 workspace 名重命名,无第三方版本变更 |
| A5 | docker no-cache build (从 repo root, build context = `vnext/`) | 通过,无 "workspace package not found" 警告 |
| A6 | local docker compose up + 四 endpoint smoke | `/v1/chat/completions` / `/v1/messages` / `/v1/responses` / `/v1beta/.../generateContent` 全 200 |
| A7 | CFW live smoke | ⏸ 推迟到下次部署窗口 (按约束) |

**A2 baseline note:** step 1 已 `tee /tmp/spec11-typecheck-baseline.txt`;改完后 `bun run typecheck 2>&1 | diff - /tmp/spec11-typecheck-baseline.txt` 为空即视为 A2 通过。pre-existing 错误清单 (translate Gemini + provider-azure/custom/sdf BodyInit) 自然继承,无需逐项再列。

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `bun install` 刷新 lock 时 transitive 版本漂移 | A4.1 lock-diff 守护:diff 仅允许 workspace 名重命名,任何第三方版本行变动即视为漂移,需排查 |
| sed 替换误伤 (例如某处字符串里有 `@vnext-gateway` 是注释/log 文本) | 通过 A3 grep 确认代码层无残留;通过 A4 occurrence 计数大致守恒 |
| `check-framework-purity.ts` 漏改导致 gate 假绿 | 步骤 3 显式语义改:framework=`@vibe-core/`,business=`@vibe-llm/`,禁 bare `@vibe/*`,保留旧 `@vnext-*` detection |
| 文档中残留旧名误导 | A3 限定在 code/config/lock 层;`vnext/docs/` 历史文档允许保留 |
| Dockerfile 内 stage-2 如有 `bun install --filter @vnext-*` 字面量 | 步骤 2 sed 覆盖 `vnext/apps` 即可 |
| docker build cwd 误用 | 步骤 9 明确从 repo root 跑,`-f vnext/apps/platform-bun/Dockerfile`,context=`vnext` |

## 8. 回滚方案

单一 commit。失败时 `git reset --hard HEAD~1 && bun install` 即恢复 (lock 跟着 commit 一起回滚,无需删 `node_modules`)。

## 9. 后续

完成后 vNext Roadmap §3 step 1-6 全部完成。下一项 step 7 (vNext → main 上位) 触发条件为 "vnext 完全替代根 src/ prod 行为",需独立 parity audit + cutover spec,不在 step 6 范围。
