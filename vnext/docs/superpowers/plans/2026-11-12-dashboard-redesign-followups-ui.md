# Dashboard 重设计收尾：界面遗留（交接 4.2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做掉交接文档 `docs/superpowers/handoffs/2026-11-12-dashboard-redesign-handoff.md` 第 4.2 节的界面遗留项。不改任何现有可见文案。

**Architecture:** 逐项小改，各项之间互不依赖（只有 Task 6 → Task 7 有先后关系）。所有改动都在 `apps/dashboard/src` 内，外加 `i18n.ts` 里 3 个新增的读屏专用 key，以及登录页的 4 个 class。纯逻辑都抽成函数并写单测；只能在 DOM 里验证的部分（标签点击、触屏拖拽、toast 停留、密码遮挡）放到 Task 13 的浏览器走查。

**Tech Stack:** React 19、Tailwind 4（`@theme`）、Radix Select 2.4.1、tailwind-merge 3.7、marked 18、bun:test（`renderToStaticMarkup`，没有 DOM）。

---

## 背景（实现者必读）

- **工作目录：** worktree `/Users/xian/projects/copilot-api-gateway/.worktrees/dashboard-ui-followups/vnext`，分支 `dashboard-ui-followups`，基于 vNext `7ef2458d`。
- **Bun：** 用 `/Users/xian/.cache/bun-1.3.0/bun`（与 CI 一致）。每条命令前先执行 `export PATH=/Users/xian/.cache/bun-1.3.0:$PATH`。依赖以 `bun install --frozen-lockfile --linker hoisted` 安装。1.3.0 对 workspace 默认用 isolated 布局，会导致类型检查找不到 `@cloudflare/workers-types` 和 `miniflare`。
- **测试一律在 `vnext/` 下运行。**
- **本机基线：** `bun test` 共 7069 个用例，7048 个通过，21 个失败，10 个错误。失败全部是环境问题：
  - `docs/superpowers/research/**` 下的 harness 写死了 isolated 布局的路径和原机器上的快照路径；
  - `packages/setup-local/tests/wrappers.test.ts` 需要 pwsh。

  失败清单存在 `/tmp/cag-handoff/baseline-fails.txt` 和 `baseline-error-files.txt`。由于 `bun test` 有失败，`ci:local` 会停在这一步，lint、`build:ui`、deploy:dry 需要单独补跑。基线结果：lint 0 error / 38 warning，dry-run 通过，`dashboard.js` 1,061,127 字节，`dashboard.css` 57,278 字节。
- **不提交、不 stash。** 交接约定是提交前先问用户。每个任务做完只记录改动了哪些文件，最后按任务分组提交，由用户批准后再执行。
- **硬约束（交接第 3 节）：**
  - 现有功能全部保留；
  - 不改可见文案，新增的读屏专用 aria 文案除外；
  - 只用 `src/ui` 组件和语义 token；
  - 全局的 `input[type=…]` 规则不在任何 layer 里，会盖过工具类。不要用 `!` 去硬顶，改为给 input 包一层。
- **代码风格：** 跟随所在文件。多数文件是双引号、无分号；`ProxyForm.tsx` 是单引号，注释用中文。

## 本次范围和决定

| 子项 | 做法 | 依据 |
|---|---|---|
| 小字 10/11px | 改为 12px | 设计规格："小字统一为 12px，不再混用 10px、11px" |
| `text-[13px]` 写死 44 处 | 加 `--text-body` token 后统一替换，并把 `body` 注册为 tailwind-merge 的字号刻度 | 实测：不注册的话，`cn("text-body","text-fg-muted")` 会丢掉 `text-body` |
| 死代码 | 删 `useLatency`，连带因此没人用的 `api/latency.ts`；删 `probeResults`/`setProbeResult`；删 `CodexImportPanel.proxyFallbackList` | 交接 4.2 |
| Markdown 标题 | 每条回复单独重排层级：从 h2 开始，不跳级。外观由 `md-h{原级别}` class 决定 | 模型页只有一个读屏 h1，固定降到 h3 会产生 h1→h3 跳级，Lighthouse heading-order 会判错 |
| `mock.module` | dompurify 改用 React context 注入 sanitizer；fullscreen 改为 `ChatPanel` 的 `defaultFullscreen` prop | AGENTS.md 禁止 `mock.module` |
| Meter | 新增 `faint` tone（`bg-fg-subtle/40`）。不改现有的 `muted`，它被 QuotaEditor 用着 | 交接 4.2 |
| Select 的 id | `id` 透传到 Radix Trigger；所有带可见标签的 Select 改用 `<label htmlFor>` | 交接 4.2 |
| 键盘排序播报 | aria-live 播报"已将 X 移到第 N 位，共 M 个"，键盘、按钮、拖拽三种方式都播 | 交接 4.2，新增读屏文案 |
| 触屏拖拽 | 用 pointer 事件自己实现，不引入新依赖；拖到边缘时自动滚动 | 用户选择"补上" |
| toast | 错误不自动消失、同一条不重复、最多 5 条，错误条带关闭图标。色板已在 `234b0a7b` 改成语义 token，不用再做 | 交接 4.2 |
| 代理页 | 密码和 PSK 遮挡并加显示开关（`aria-pressed`，`autoComplete="new-password"`）；端口改用 number；首次加载显示 `dash.loadingShort` | 用户选择"遮挡 + 开关"，URL 框不动 |
| Keys 窄屏 | 不做，保持横向滚动 | 用户选择 |
| 服务端页面输入框尺寸 | 不动，交接说明是有意保留 | 交接 4.2 |
| 登录页副标题 | 去掉 `font-light`，前后截图给用户看 | 交接 4.2"目测评估" |

**新增 i18n key（全部读屏专用，中英文都加）：**

| key | en | zh |
|---|---|---|
| `dash.reorderUpstreamAnnounce` | `Moved {name} to position {n} of {total}` | `已将 {name} 移到第 {n} 位，共 {total} 个` |
| `dash.proxyShowPassword` | `Show password` | `显示密码` |
| `dash.proxyShowPsk` | `Show PSK` | `显示 PSK` |

---

### Task 0：走查环境和改动前测量（主控执行）

**Files:** 只在 `/tmp/cag-walk/` 下建临时文件，不动仓库。

- [ ] **Step 1：启动网关**（从 worktree 启动，当前还是改动前的构建）

```bash
mkdir -p /tmp/cag-walk && cd /Users/xian/projects/copilot-api-gateway/.worktrees/dashboard-ui-followups/vnext
export PATH=/Users/xian/.cache/bun-1.3.0:$PATH
bun run build:ui
VNEXT_DB_PATH=/tmp/cag-walk/db.sqlite PORT=41499 NODE_ENV=production ACCOUNT_TYPE=individual \
  bun apps/platform-bun/src/server.ts > /tmp/cag-walk/server.log 2>&1 &
```

确认 `curl -s -o /dev/null -w '%{http_code}' http://localhost:41499/health` 返回 200，迁移会在启动时自动执行。

- [ ] **Step 2：插入管理员和普通用户的会话**（`/tmp/cag-walk/seed.ts`，用 `bun:sqlite`）
  - `users`：插入 `u_admin`（`test@local.dev`，在 `ADMIN_EMAILS` 里）和 `u_user`（`user@example.com`）；
  - `user_sessions`：各插入一行，`token` 为 `ses_walk_admin_<随机>` 和 `ses_walk_user_<随机>`，`expires_at` 设为 7 天后；
  - token 只写入 `/tmp/cag-walk/tokens.json`，不打印到输出。
- [ ] **Step 3：登录** 在 Chrome DevTools 中打开 `http://localhost:41499/`，执行 `document.cookie = "session_token=<token>; path=/"`，再打开 `/dashboard`。
- [ ] **Step 4：通过页面接口造数据**
  - 3 个 custom 上游，base URL 用不通的 `http://127.0.0.1:9/v1`，用来测排序和错误 toast；
  - 2 个 API key；
  - 2 个代理（trojan、ss2022）。
- [ ] **Step 5：量现有 `text-[13px]` 元素的实际行高** 在用量、模型、Keys、上游、代理、设置等页面执行：

```js
JSON.stringify(Object.entries([...document.querySelectorAll('[class*="text-[13px]"]')]
  .reduce((m, el) => { const lh = getComputedStyle(el).lineHeight; m[lh] = (m[lh] || 0) + 1; return m }, {})))
```

  结果记到 `/tmp/cag-walk/lh-before.json`。如果绝大多数是 `19.5px`，即根上继承的 1.5，Task 2 就用 `1.5`；否则按多数值取，并在报告里说明有哪些元素会变。
- [ ] **Step 6：截改动前的图** 1440 宽，浅色、英文：登录页（4 处副标题）、上游页、代理表单（trojan）、模型页。图存到 `/tmp/cag-walk/before-*.png`。

### Task 1：小字统一 12px

**Files:**
- Modify: `apps/dashboard/src/styles.css`（`.md-body .md-code-lang`、`.pg-avatar`、`.pg-img-param`、`.pg-img-mode`）
- Modify: `apps/dashboard/src/shell/SidebarNav.tsx:30`
- Create: `apps/dashboard/src/type-scale.test.ts`

- [ ] **Step 1：写守卫测试**（会失败）

```ts
import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = import.meta.dir

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === "__snapshots__" ? [] : sources(path)
    return /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })
}

function offenders(patterns: RegExp[]): string[] {
  return sources(SRC).flatMap((path) => {
    const text = readFileSync(path, "utf8")
    return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => `${relative(SRC, path)}: ${m[0]}`))
  })
}

// Spec ("字体"): small text is 12px; 10px and 11px are not mixed in.
test("no 10px or 11px text", () => {
  expect(offenders([/text-\[1[01](?:\.\d+)?px\]/g, /font-size:\s*1[01](?:\.\d+)?px/g])).toEqual([])
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/type-scale.test.ts`，应当 FAIL，列出 5 处。
- [ ] **Step 3：改代码**
  - `styles.css`：
    - `.md-body .md-code-lang` 的 `font-size: 10px` 改为 `12px`；
    - `.pg-avatar`、`.pg-img-param`、`.pg-img-mode` 的 `font-size: 11px` 改为 `12px`。
  - `SidebarNav.tsx:30`：`text-[11px]` 改为 `text-xs`。
  - 再 grep 一遍 `components/TimeSeriesChart.tsx` 里 Chart.js 的 `size: 1[01]`。如果有，在报告里列出来；本任务不改，因为 canvas 字号会影响图表布局。
- [ ] **Step 4：** 再运行同一个测试，应当 PASS。
- [ ] **Step 5：** 记录改动文件：`styles.css`、`SidebarNav.tsx`、`type-scale.test.ts`。

### Task 2：`--text-body` token

**Files:**
- Modify: `apps/dashboard/src/styles.css`（第一个 `@theme`）
- Modify: `apps/dashboard/src/ui/cn.ts`
- Modify: 含 `text-[13px]` 的 34 个 `.tsx` 文件，共 44 处
- Modify: `apps/dashboard/src/tabs/models/__snapshots__/render-snapshot.test.tsx.snap`（只更新快照）
- Test: `apps/dashboard/src/type-scale.test.ts`、`apps/dashboard/src/ui/ui-batch3.test.tsx`

- [ ] **Step 1：写失败的测试**
  - 在 `type-scale.test.ts` 末尾追加：

```ts
// Body copy goes through the text-body token, so its size and line height live in one place.
test("body size uses text-body, not a hard-coded 13px", () => {
  expect(offenders([/text-\[13px\]/g])).toEqual([])
})
```

  - 在 `ui-batch3.test.tsx` 中追加：

```ts
import { cn } from "./cn"

test("cn treats text-body as a font size, so a colour does not remove it", () => {
  expect(cn("text-body", "text-fg-muted")).toBe("text-body text-fg-muted")
  expect(cn("text-body", "text-xs")).toBe("text-xs")
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/type-scale.test.ts apps/dashboard/src/ui/ui-batch3.test.tsx`，两条都应当 FAIL。
- [ ] **Step 3：token** 在 `styles.css` 第一个 `@theme` 块末尾加上（行高取 Task 0 量出的值，默认 1.5）：

```css
  /* Body copy in controls, menus and tables (spec: body 13–14px). The line
     height is what these elements inherited from the root before the token
     existed, so moving them onto it shifts nothing. */
  --text-body: 13px;
  --text-body--line-height: 1.5;
```

- [ ] **Step 4：tailwind-merge** 把 `ui/cn.ts` 改成：

```ts
import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// `text-body` is a font size from our @theme. tailwind-merge only knows the
// default scale, so it would take `text-body` for a colour and let a later
// colour such as `text-fg-muted` drop it.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["body"] } } })

/** Join class names; on a Tailwind conflict the later class wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 5：替换**

```bash
cd apps/dashboard/src && grep -rl 'text-\[13px\]' --include='*.tsx' . | xargs sed -i '' 's/text-\[13px\]/text-body/g' && cd -
grep -rn 'text-\[13px\]' apps/dashboard/src --include='*.tsx' --include='*.ts' --include='*.css'   # 期望：无输出
grep -n 'text-\[13px\]' packages/gateway/src/shared/edge/ui-pages/dashboard-app/page.ts           # 期望：无输出（它是 @source）
```

- [ ] **Step 6：更新快照，并确认只有类名变化**

```bash
bun test apps/dashboard/src/tabs/models/render-snapshot.test.tsx --update-snapshots
git diff -U0 apps/dashboard/src/tabs/models/__snapshots__ | grep '^[-+][^-+]' | sed 's/text-\[13px\]/X/g; s/text-body/X/g' | sort | uniq -c | awk '$1 % 2'
```

  第二条命令应当没有输出：把两种写法都替换成 X 之后，每一对 `-`/`+` 行应完全相同。
- [ ] **Step 7：** 先 `bun run build:ui`，再 `grep -o '\.text-body{[^}]*}' packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/dashboard.css`，应能看到 `font-size:var(--text-body)` 和 `line-height:var(--tw-leading,var(--text-body--line-height))`。看一眼 `scripts/build-dashboard.ts` 里有没有检查工具类的断言，有的话同步更新。
- [ ] **Step 8：** 运行 `bun test apps/dashboard` 并通过。改动文件见上面的 Files。

### Task 3：死代码

**Files:**
- Modify: `apps/dashboard/src/state/latency.ts`
- Delete: `apps/dashboard/src/api/latency.ts`
- Modify: `apps/dashboard/src/state/upstreams.ts`
- Modify: `apps/dashboard/src/tabs/upstreams/CodexImportPanel.tsx`

- [ ] **Step 1：`state/latency.ts`** 删掉以下内容：
  - `useLatency` 函数；
  - `LatencySummary`、`LatencyByType`、`LatencyByColo` 三个接口；
  - 因此不再使用的 import：react hooks、`useToast`、`../api/latency`、`buildTimeBuckets`、`utcHourToBucketKey`、`useZoneMode`。

  保留 `LatencyRange`、`computeTimeRange`、`formatWeekLabel`，它们被 `state/performance.ts` 和 `LatencyTab` 使用。文件头的 import 只剩：

```ts
import { zoneOps, type TimeZoneMode } from "./timezone"
```

- [ ] **Step 2：** `git rm` 删除 `apps/dashboard/src/api/latency.ts`，删之前确认只有 `state/latency.ts` 引用它。服务端的 `/api/latency` 路由保留，它还有其他调用方。
- [ ] **Step 3：`state/upstreams.ts`**
  - 删除 `probeResults` 和 `setProbeResults` 这组 state；
  - 删除 `probe()` 里的两次 `setProbeResults(...)` 调用，toast 和 `loadModels()` 保持不变；
  - 删除返回值里的 `probeResults` 和 `setProbeResult`；
  - `api.ProbeResult` 类型仍由 `api.probeUpstream` 使用，保留。
- [ ] **Step 4：`CodexImportPanel.tsx`**
  - 删除 Props 里的 `proxyFallbackList?: ProxyFallbackEntry[]`；
  - 删除解构参数里的 `proxyFallbackList`；
  - 删除请求体里的 `proxyFallbackList`（它一直是 `undefined`，`JSON.stringify` 本来就会省略，请求内容不变）；
  - `ProxyFallbackEntry` 的 import 没用了就删掉；
  - `api.CodexImportRequest` 里的同名字段描述的是服务端接口，保留。
- [ ] **Step 5：** 运行 `bun run --filter '@vibe-llm/dashboard' typecheck`、`bunx eslint apps/dashboard/src` 和 `bun test apps/dashboard`，全部通过，lint 没有新的 warning。

### Task 4：Meter 的 `faint` tone

**Files:** `apps/dashboard/src/ui/meter.tsx`、`apps/dashboard/src/tabs/models/DecisionPanel.tsx`（`ProbabilityBar`）、`apps/dashboard/src/ui/ui-batch3.test.tsx`

- [ ] **Step 1：写测试**（会失败）

```ts
test("Meter's faint tone is the subtle colour at 40%, for an unchosen option beside a chosen one", () => {
  expect(renderToStaticMarkup(<Meter percent={50} tone="faint" />)).toContain("bg-fg-subtle/40")
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/ui/ui-batch3.test.tsx`。应当 FAIL：类型检查不过，或者渲染结果里没有这个 class。
- [ ] **Step 3：`meter.tsx`**

```ts
export type MeterTone = "brand" | "warn" | "danger" | "muted" | "faint"

const FILL: Record<MeterTone, string> = {
  brand: "bg-brand",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-fg-subtle",
  // Quieter than muted: the options the decision panel did not pick, next to the one it did.
  faint: "bg-fg-subtle/40",
}
```

- [ ] **Step 4：`DecisionPanel.tsx` 的 `ProbabilityBar`**

```tsx
      <Meter percent={probability * 100} tone={selected ? "brand" : "faint"} className="h-2" />
```

- [ ] **Step 5：** 运行 `bun test apps/dashboard/src/ui/ui-batch3.test.tsx` 并通过；`grep -n '\[&>div\]' apps/dashboard/src -r` 应当没有结果。

### Task 5：Select 支持 id，可见标签改用 `<label htmlFor>`

**Files:**
- Modify: `apps/dashboard/src/ui/select.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/form/Field.tsx`
- Modify: `tabs/upstreams/form/SdfFields.tsx`（3 处）、`tabs/upstreams/form/CustomFields.tsx`（auth style）、`tabs/proxies/ProxyForm.tsx`（`ChoiceField`）
- Modify: `tabs/usage/UsageFilters.tsx`（`FilterField` 和 5 处调用）、`tabs/models/ModelsTab.tsx`（Key 选择）、`tabs/models/ImageParamsBar.tsx`（`ParamField`）、`tabs/keys/ConfigurationPanel.tsx`（`modelPicker`）、`tabs/keys/SetupPanel.tsx`（platform、effort）
- Test: `apps/dashboard/src/ui/ui-batch2.test.tsx`；Create: `apps/dashboard/src/tabs/upstreams/form/field.test.tsx`

不在范围内：`WebSearchPanel` 的 Passthrough 是一个标签对应两个 Select，属于 4.1 的"读屏名称重复"；其余只有 `ariaLabel`、没有可见标签的 Select（ProxyChainEditor、ChatTopbar、UsageRefresh、ProxiesTab 的 anchor）也不动。

- [ ] **Step 1：写测试**（会失败）
  - `ui-batch2.test.tsx`：

```ts
test("Select puts its id on the trigger, so a <label htmlFor> can focus it", () => {
  const html = renderToStaticMarkup(<Select id="auth" labelledBy="lbl" value="" onChange={() => {}} options={[{ value: "", label: "Bearer" }]} />)
  expect(html).toMatch(/<button[^>]*id="auth"/)
})
```

  - `field.test.tsx`：

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Select } from "../../../ui/select"
import { Field } from "./Field"

test("Field's label points at the select it names", () => {
  const html = renderToStaticMarkup(
    <Field label="Auth style">
      {({ id, labelId }) => <Select id={id} labelledBy={labelId} value="" onChange={() => {}} options={[{ value: "", label: "Bearer" }]} />}
    </Field>,
  )
  const forId = html.match(/<label[^>]*for="([^"]+)"/)?.[1]
  expect(forId).toBeTruthy()
  expect(html).toContain(`<button type="button" role="combobox"`)
  expect(html.match(/<button[^>]*\sid="([^"]+)"/)?.[1]).toBe(forId)
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/ui/ui-batch2.test.tsx apps/dashboard/src/tabs/upstreams/form/field.test.tsx`，应当 FAIL。
- [ ] **Step 3：`select.tsx`**
  - Props 加上：

```ts
  /** Id of the trigger, for a `<label htmlFor>`: clicking the label then focuses the select. */
  id?: string
```

  - 解构时加入 `id`，`<RadixSelect.Trigger` 上加 `id={id}`。
- [ ] **Step 4：`Field.tsx`**
  - 删掉 `labelledBy` prop 和 span 分支，总是渲染 `<label id={labelId} htmlFor={id} className={labelCls}>{label}</label>`；
  - 注释改为："The label points at the control with htmlFor, so pass `id` to the control; ui/select also takes `labelledBy={labelId}`, which names it by label and current value."
- [ ] **Step 5：Field 的 5 个调用方**
  - 去掉 `labelledBy` 属性；
  - render 参数改为 `({ id, labelId })`，CustomFields 是 `({ id, labelId, describedBy })`；
  - Select 加上 `id={id}`，并保留 `labelledBy={labelId}`。
- [ ] **Step 6：`UsageFilters.tsx`**

```tsx
function FilterField({ label, children }: { label: string; children: (ids: { id: string; labelId: string }) => ReactNode }) {
  const id = useId()
  const labelId = `${id}-label`
  return (
    <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-none sm:min-w-[180px]">
      <label id={labelId} htmlFor={id} className="text-xs font-medium text-fg-muted shrink-0 w-24 sm:w-auto">
        {label}
      </label>
      <div className="flex-1 min-w-0">{children({ id, labelId })}</div>
    </div>
  )
}
```

  5 处调用改为 `{({ id, labelId }) => (<Select id={id} labelledBy={labelId} … />)}`。如果 `UsageFilters.test.tsx` 对 span 有断言，同步改成 label。
- [ ] **Step 7：其余 4 处**，都是"可见标签 + Select"：
  - **ModelsTab：** 在 `keyLabelId` 旁边加 `const keySelectId = useId()`；`<label id={keyLabelId} htmlFor={keySelectId} …>`；`<Select id={keySelectId} …>`。
  - **ImageParamsBar：** span 改为 `<label id={labelId} htmlFor={`${labelId}-select`} …>`，Select 加 `id={`${labelId}-select`}`。
  - **ConfigurationPanel 的 `modelPicker`：** span 改为 `<label id={id} htmlFor={`${id}-select`} …>`，Select 加 `id={`${id}-select`}`。
  - **SetupPanel：** platform 和 effort 的 span 改为 `<label htmlFor={`${id}-platform-select`}>` 和 `<label htmlFor={`${id}-effort-select`}>`，两个 Select 加上对应的 id。
- [ ] **Step 8：** 运行 `bun test apps/dashboard` 和 dashboard 类型检查，均通过。

浏览器里需要确认：点标签会聚焦触发按钮。这是 Radix 2.4.1 的行为：触发按钮从没被鼠标按下过时，点标签还会直接展开；按下过之后，点标签只聚焦。见 `node_modules/@radix-ui/react-select/dist/index.mjs` 的 `onClick`，这在预期之内。

### Task 6：去掉快照测试里的 `mock.module`

**Files:**
- Modify: `apps/dashboard/src/tabs/models/markdown.ts`
- Modify: `apps/dashboard/src/tabs/models/chat/ChatThread.tsx`（`MessageRow`）
- Modify: `apps/dashboard/src/tabs/models/ChatPanel.tsx`
- Modify: `apps/dashboard/src/tabs/models/render-snapshot.test.tsx`

- [ ] **Step 1：`markdown.ts` 注入 sanitizer**

```ts
import { createContext } from "react"
// …existing imports…

/** Turns rendered markdown into HTML that is safe to inject. */
export type Sanitize = (html: string) => string

export const sanitizeHtml: Sanitize = (html) => DOMPurify.sanitize(html, { ADD_ATTR: ["target"] })

/**
 * The sanitizer chat replies are rendered with. DOMPurify needs a DOM and has
 * no `sanitize` without one, so tests that render the chat provide their own.
 * A context keeps that substitute inside the test's render tree, where
 * replacing the dompurify module would change it for the whole test process.
 */
export const MarkdownSanitizer = createContext<Sanitize>(sanitizeHtml)

export function renderMarkdown(src: string, sanitize: Sanitize = sanitizeHtml): string {
  if (!src) return ""
  const html = marked.parse(src, { renderer, async: false }) as string
  return sanitize(html)
}
```

- [ ] **Step 2：`ChatThread.tsx` 的 `MessageRow`**
  - 在函数体开头加 `const sanitize = useContext(MarkdownSanitizer)`，import 改为 `import { renderMarkdown, MarkdownSanitizer } from "../markdown"` 和 `import { useContext, type CSSProperties } from "react"`；
  - 渲染处改为 `renderMarkdown(m.text, sanitize)`。
- [ ] **Step 3：`ChatPanel.tsx`**
  - Props 加上：

```ts
  /**
   * Open in or out of fullscreen instead of restoring the persisted choice.
   * For tests: the restore rule reads the page load's first URL, which a test
   * process cannot set up.
   */
  defaultFullscreen?: boolean
```

  - 解构时加入 `defaultFullscreen`，并改为 `const [fullscreen, setFullscreen] = useState(() => defaultFullscreen ?? initialFullscreen())`。
- [ ] **Step 4：`render-snapshot.test.tsx`**
  - 删除：`mock` 的 import、`import * as fullscreenModule`、两段 `mock.module`、`fullscreenOn` 变量，以及 `afterAll` 里对它的重置；
  - 加上 `import { MarkdownSanitizer } from "./markdown"`；
  - `renderChat` 增加 `fullscreen?: boolean` 参数，外层包一层：

```tsx
    <MarkdownSanitizer.Provider value={(html) => html}>
      <TooltipProvider>
        <ChatPanel … defaultFullscreen={opts.fullscreen} />
      </TooltipProvider>
    </MarkdownSanitizer.Provider>
```

  - 用 `// Pass the HTML through: these snapshots pin our markup, not DOMPurify's.` 代替原来那条关于 DOMPurify 的注释；
  - fullscreen 用例改为 `renderChat({ mode: "chat", fullscreen: true })`，去掉 try/finally。
- [ ] **Step 5：** 运行 `bun test apps/dashboard/src/tabs/models`，快照应当一个都不变，因为 Provider 不产生 DOM。`grep -rn "mock.module" apps/dashboard/src` 应当没有结果。再 grep 一遍其他测试有没有渲染 `ChatPanel`/`ChatThread`；如果有，也要包上 Provider。

### Task 7：Markdown 回复标题的层级

**Files:**
- Modify: `apps/dashboard/src/tabs/models/markdown.ts`
- Modify: `apps/dashboard/src/styles.css`（`.md-body h1…h4` 几条规则）
- Create: `apps/dashboard/src/tabs/models/markdown.test.ts`

- [ ] **Step 1：写测试**（会失败）

```ts
import { expect, test } from "bun:test"
import { outlineLevels, renderMarkdown } from "./markdown"

const passThrough = (html: string) => html

test("outlineLevels starts a reply at h2 and never skips a level", () => {
  expect(outlineLevels([])).toEqual([])
  expect(outlineLevels([1, 2, 2, 1])).toEqual([2, 3, 3, 2])
  expect(outlineLevels([2, 3])).toEqual([2, 3])
  expect(outlineLevels([1, 3])).toEqual([2, 3])
  expect(outlineLevels([3, 1])).toEqual([2, 2])
  expect(outlineLevels([1, 2, 3, 4, 5, 6])).toEqual([2, 3, 4, 5, 6, 6])
})

test("reply headings take their outline level and keep their markdown size", () => {
  const html = renderMarkdown("# Title\n\n### Detail\n\ntext", passThrough)
  expect(html).toContain('<h2 class="md-h1">Title</h2>')
  expect(html).toContain('<h3 class="md-h3">Detail</h3>')
  expect(html).not.toContain("<h1")
})

test("headings inside lists count too, and CJK bold still renders", () => {
  const html = renderMarkdown("## A\n\n- #### B\n\n**加粗。**后接文字", passThrough)
  expect(html).toContain('<h2 class="md-h2">A</h2>')
  expect(html).toContain('<h3 class="md-h4">B</h3>')
  expect(html).toContain("<strong>加粗。</strong>后接文字")
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/tabs/models/markdown.test.ts`，应当 FAIL。
- [ ] **Step 3：实现** 在 `markdown.ts` 里新增下面的代码，并改写 `renderMarkdown`。改用 lexer 加 parser，是为了在渲染前先拿到整条回复的所有标题；必须传入 `marked.defaults`，否则 cjkStrong 扩展会丢失。

```ts
import { marked, type Token, type Tokens } from "marked"

/**
 * Document levels for one reply's headings, in order. A reply sits under the
 * page's h1 with nothing in between, so its first heading is an h2 (`base`)
 * and none is more than one level below the heading before it: a skip such as
 * h1 → h3 breaks the outline that heading navigation and Lighthouse's
 * heading-order check rely on. Relative depth is kept where that allows.
 */
export function outlineLevels(depths: readonly number[], base = 2): number[] {
  if (depths.length === 0) return []
  const top = Math.min(...depths)
  let previous = base - 1
  return depths.map((depth) => {
    const level = Math.min(base + depth - top, previous + 1, 6)
    previous = level
    return level
  })
}

const isHeading = (token: Token): token is Tokens.Heading => token.type === "heading"
const headingLevels = new WeakMap<Tokens.Heading, number>()

// The tag carries the outline level; the class keeps the size the markdown
// asked for, so `# Title` still looks like a title.
renderer.heading = (token: Tokens.Heading) => {
  const level = headingLevels.get(token) ?? Math.min(token.depth + 1, 6)
  return `<h${level} class="md-h${token.depth}">${renderer.parser.parseInline(token.tokens)}</h${level}>\n`
}

export function renderMarkdown(src: string, sanitize: Sanitize = sanitizeHtml): string {
  if (!src) return ""
  const tokens = marked.lexer(src)
  const headings: Tokens.Heading[] = []
  marked.walkTokens(tokens, (token) => { if (isHeading(token)) headings.push(token) })
  outlineLevels(headings.map((h) => h.depth)).forEach((level, i) => {
    const heading = headings[i]
    if (heading) headingLevels.set(heading, level)
  })
  return sanitize(marked.parser(tokens, { ...marked.defaults, renderer }))
}
```

  `renderer.heading` 必须定义在 `renderer.code` 之后、`renderMarkdown` 之前。
- [ ] **Step 4：`styles.css`** 把 `.md-body h1, .md-body h2, .md-body h3, .md-body h4 {…}` 和 `.md-body h1/h2/h3 { font-size }` 换成按 class 写的规则，数值不变：

```css
.md-body :is(.md-h1, .md-h2, .md-h3, .md-h4) {
  font-weight: 600;
  margin: 1em 0 0.4em;
  line-height: 1.3;
}
.md-body .md-h1 { font-size: 1.3em; }
.md-body .md-h2 { font-size: 1.2em; }
.md-body .md-h3 { font-size: 1.1em; }
```

  `md-h5`/`md-h6` 和以前的 h5/h6 一样，沿用 preflight 的 inherit。
- [ ] **Step 5：** 运行 `bun test apps/dashboard/src/tabs/models` 并通过，快照不变，因为现有的种子数据里没有标题。

### Task 8：toast 错误常驻

**Files:** `apps/dashboard/src/state/toast.tsx`；Create: `apps/dashboard/src/state/toast.test.ts`

- [ ] **Step 1：写测试**（会失败）

```ts
import { expect, test } from "bun:test"
import { withToast, type Toast } from "./toast"

const error = (id: number, message = "boom"): Toast => ({ id, kind: "error", message })
const info = (id: number, message = "ok"): Toast => ({ id, kind: "info", message })

test("an error already on screen is not stacked again", () => {
  const list = [error(1)]
  expect(withToast(list, error(2))).toBe(list)
  expect(withToast(list, error(3, "other"))).toEqual([error(1), error(3, "other")])
})

test("other kinds can repeat; they leave on their own", () => {
  expect(withToast([info(1)], info(2))).toEqual([info(1), info(2)])
})

test("at most five toasts, the oldest leaves first", () => {
  let list: Toast[] = []
  for (let i = 1; i <= 6; i++) list = withToast(list, error(i, `e${i}`))
  expect(list.map((t) => t.id)).toEqual([2, 3, 4, 5, 6])
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/state/toast.test.ts`，应当 FAIL。
- [ ] **Step 3：实现**
  - 把 `interface Toast` 改为 `export`；
  - 新增 `withToast` 和两个常量：

```ts
/** Success and info toasts leave on their own after this long. */
const AUTO_DISMISS_MS = 4000
/** The most toasts on screen at once. */
const MAX_TOASTS = 5

/**
 * The list once `toast` arrives. Errors stay until dismissed, since four
 * seconds is too short to read, or hear, what went wrong; so an error already
 * on screen is not stacked again (a failing auto-refresh repeats the same one).
 */
export function withToast(list: Toast[], toast: Toast): Toast[] {
  if (toast.kind === "error" && list.some((t) => t.kind === "error" && t.message === toast.message)) return list
  return [...list, toast].slice(-MAX_TOASTS)
}
```

  - `push` 改为：

```ts
  const push = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const toast = { id: nextId++, kind, message }
      setToasts((cur) => withToast(cur, toast))
      if (kind !== "error") setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )
```

  - `ToastHost` 的按钮加上 `flex items-start gap-2`，内容改为：

```tsx
          <span className="min-w-0 flex-1">{t.message}</span>
          {t.kind === "error" ? <X className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden="true" /> : null}
```

    `import { X } from "lucide-react"`。注释补一句"Errors stay until clicked."
- [ ] **Step 4：** 运行 `bun test apps/dashboard` 并通过。

### Task 9：代理页（密码遮挡、端口、加载状态）

**Files:**
- Modify: `apps/dashboard/src/tabs/proxies/ProxyForm.tsx`
- Modify: `apps/dashboard/src/tabs/proxies/ProxiesTab.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（en、zh 各加 2 个 key）
- Create: `apps/dashboard/src/tabs/proxies/proxy-form.test.tsx`

- [ ] **Step 1：写测试**（会失败）。没有 window 时 `useT()` 原样返回 key，`useEffect` 也不会执行，所以按钮名渲染出来就是 key 本身。

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProxyForm } from "./ProxyForm"
import type { ProxyDraft } from "./proxy-form-config"

const trojan: ProxyDraft = {
  name: "n1",
  config: { kind: "trojan", name: "n1", host: "h", port: 443, password: "pw" },
  url: null,
  dialTimeoutSeconds: "",
}
const render = (draft: ProxyDraft) => renderToStaticMarkup(<ProxyForm draft={draft} onChange={() => {}} />)

test("a proxy password is masked, kept out of autofill, and has a show toggle", () => {
  const html = render(trojan)
  const password = html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? ""
  expect(password).toContain('autocomplete="new-password"')
  expect(html).toMatch(/<button[^>]*aria-label="dash\.proxyShowPassword"[^>]*aria-pressed="false"|<button[^>]*aria-pressed="false"[^>]*aria-label="dash\.proxyShowPassword"/)
})

test("the ss2022 PSK toggle is named for the PSK", () => {
  const html = render({ ...trojan, config: { kind: "ss2022", name: "n1", host: "h", port: 8388, method: "2022-blake3-aes-128-gcm", passwordBase64: "cGFzcw==" } })
  expect(html).toContain('aria-label="dash.proxyShowPsk"')
})

test("the port is a number field bounded like the port check", () => {
  const port = render(trojan).match(/<input[^>]*type="number"[^>]*>/)?.[0] ?? ""
  expect(port).toContain('min="1"')
  expect(port).toContain('max="65535"')
})
```

  ss2022 的字段名以 `packages/proxy/src/proxy-config.ts` 的 `Shadowsocks2022ProxyConfig` 为准，类型检查会核对这里的字面量。
- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/tabs/proxies/proxy-form.test.tsx`，应当 FAIL。
- [ ] **Step 3：i18n** 在 `"dash.proxyPskLabel"` 后面加上：en 加 `"dash.proxyShowPassword": "Show password",` 和 `"dash.proxyShowPsk": "Show PSK",`；zh 加 `"dash.proxyShowPassword": "显示密码",` 和 `"dash.proxyShowPsk": "显示 PSK",`。
- [ ] **Step 4：`ProxyForm.tsx`**
  - `TextField` 增加 `numeric?: { min: number; max: number }`。有这个参数时渲染 `type="number"`，并设置 `min`、`max`、`step={1}`；没有时保持 `type="text"`。端口那一栏传 `numeric={{ min: 1, max: 65535 }}`，与 `draftIssues` 的端口校验一致。
  - 新增 `SecretField`（单引号，中文注释）：

```tsx
/**
 * 密码类字段：默认遮住，旁边的眼睛按钮切换明文（aria-pressed 表示当前是否明文）。
 * autoComplete="new-password" 让浏览器别把本站的登录密码填进来 —— http/socks5
 * 的"用户名 + 密码"两栏在浏览器看来就是一张登录表单。
 */
function SecretField(props: {
  label: string
  /** 读屏用的按钮名，如"显示密码"。 */
  toggleLabel: string
  value: string
  error?: string
  onChange: (v: string) => void
}) {
  const t = useT()
  const [shown, setShown] = useState(false)
  return (
    <Field label={props.label} error={props.error ? t(props.error) : undefined}>
      {({ id, describedBy }) => (
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1 font-mono">
            <input
              id={id}
              type={shown ? 'text' : 'password'}
              value={props.value}
              aria-invalid={props.error ? true : undefined}
              aria-describedby={describedBy}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => props.onChange(e.target.value)}
            />
          </div>
          <Button variant="ghost" size="icon" aria-label={props.toggleLabel} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
            {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </div>
      )}
    </Field>
  )
}
```

    import：`useState`（react）、`Eye`/`EyeOff`（lucide-react）、`Button`（`../../ui/button`）。
  - `KindFields` 里的 4 个密码框改用 `SecretField`：http/socks5 的 password、ss 的 password、trojan 的 password 传 `toggleLabel={t('dash.proxyShowPassword')}`，ss2022 的 `passwordBase64` 传 `toggleLabel={t('dash.proxyShowPsk')}`。`value`、`error`、`onChange` 和原来一样。
- [ ] **Step 5：`ProxiesTab.tsx`**
  - 加上 `const [loaded, setLoaded] = useState(false)`，`reload` 的 `finally` 里调用 `setLoaded(true)`；
  - 原来的 `rows.length === 0 ? <EmptyState …/> : null` 改为：

```tsx
        {!loaded ? (
          <p className="text-sm text-fg-subtle">{t("dash.loadingShort")}</p>
        ) : rows.length === 0 ? (
          <EmptyState title={t("dash.proxiesEmpty")} />
        ) : null}
```

  - 与上游页的加载提示保持一致。
- [ ] **Step 6：** 运行 `bun test apps/dashboard/src/tabs/proxies packages/gateway/tests/i18n-keys.test.ts` 并通过。

### Task 10：上游排序的读屏播报

**Files:**
- Modify: `apps/dashboard/src/state/reorder-upstreams.ts`、`apps/dashboard/src/state/reorder-upstreams.test.ts`
- Modify: `apps/dashboard/src/state/upstreams.ts`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（en、zh 各加 1 个 key）

- [ ] **Step 1：写测试**（会失败）。在 `reorder-upstreams.test.ts` 中追加，用该文件已有的 `initial` fixture：a、b、c 是 mine 下已启用的行，`off` 是 mine 下已停用的行，`foreign` 属于别人。import 里加上 `partitionPosition`。

```ts
test("partitionPosition counts only rows with the same owner and enabled state", () => {
  expect(partitionPosition(initial, "b", "mine")).toEqual({ position: 2, total: 3 })
  expect(partitionPosition(initial, "off", "mine")).toEqual({ position: 1, total: 1 })
  expect(partitionPosition(initial, "foreign", "mine")).toBeNull()
  expect(partitionPosition(initial, "missing", "mine")).toBeNull()
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/state/reorder-upstreams.test.ts`，应当 FAIL。
- [ ] **Step 3：`reorder-upstreams.ts`**

```ts
/** Where `id` sits among the rows it can be reordered with (same owner and enabled state): 1-based, out of how many. */
export function partitionPosition(
  rows: readonly UpstreamRecord[], id: string, ownerId: string,
): { position: number; total: number } | null {
  const row = rows.find((r) => r.id === id)
  if (!row || !partition(row, ownerId, row.enabled)) return null
  const group = rows.filter((r) => partition(r, ownerId, row.enabled))
  return { position: group.findIndex((r) => r.id === id) + 1, total: group.length }
}
```

- [ ] **Step 4：`state/upstreams.ts`** 返回值里加上：

```ts
    /** Where a row now sits among its reorderable peers, counting moves still being saved. */
    positionOf: (id: string, ownerId: string) => partitionPosition(controller.snapshot(), id, ownerId),
```

- [ ] **Step 5：i18n** 在 `"dash.reorderUpstreamHandle"` 后面加上：en 加 `"dash.reorderUpstreamAnnounce": "Moved {name} to position {n} of {total}",`；zh 加 `"dash.reorderUpstreamAnnounce": "已将 {name} 移到第 {n} 位，共 {total} 个",`。
- [ ] **Step 6：`UpstreamsTab.tsx`**

```tsx
  const [announcement, setAnnouncement] = useState("")
  // A move gives a screen reader user no feedback of its own; say where the row landed.
  const announceMove = (row: UpstreamRecord, moved: boolean) => {
    if (!moved) return
    const at = store.positionOf(row.id, myOwnerId)
    if (at) setAnnouncement(t("dash.reorderUpstreamAnnounce", { name: row.name, n: at.position, total: at.total }))
  }
```

  - 在页面根元素里常驻一个 `<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>`；
  - `onReorder={(d) => announceMove(u, store.reorder(u.id, d, myOwnerId))}`；
  - `onDrop` 里改为先取 `const source = store.upstreams.find((row) => row.id === drag.sourceId)`，再 `const moved = store.reorderTo(drag.sourceId, u.id, myOwnerId)`，然后 `if (source) announceMove(source, moved)`。
- [ ] **Step 7：** 运行 `bun test apps/dashboard packages/gateway/tests/i18n-keys.test.ts` 并通过。

### Task 11：上游的触屏拖拽

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/touch-reorder.ts`、`apps/dashboard/src/tabs/upstreams/touch-reorder.test.ts`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx`（外层 div 加 `data-upstream-id`，新增 `onHandlePointerDown` prop）
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx`

- [ ] **Step 1：写测试**（会失败）

```ts
import { expect, test } from "bun:test"
import { edgeScrollDelta } from "./touch-reorder"

test("edgeScrollDelta scrolls up near the top, down near the bottom, faster nearer the edge", () => {
  expect(edgeScrollDelta(300, 0, 600)).toBe(0)
  expect(edgeScrollDelta(0, 0, 600)).toBe(-14)
  expect(edgeScrollDelta(24, 0, 600)).toBe(-7)
  expect(edgeScrollDelta(576, 0, 600)).toBe(7)
  expect(edgeScrollDelta(600, 0, 600)).toBe(14)
  expect(edgeScrollDelta(-50, 0, 600)).toBe(-14)
  expect(edgeScrollDelta(120, 100, 600)).toBe(-9)
})
```

- [ ] **Step 2：** 运行 `bun test apps/dashboard/src/tabs/upstreams/touch-reorder.test.ts`，应当 FAIL。
- [ ] **Step 3：实现 `touch-reorder.ts`**

```ts
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"

/** How far (px) a finger travels on the handle before it is a drag rather than a tap. */
const SLOP = 6
/** Distance (px) from the scroller's top or bottom edge where a drag scrolls it. */
const EDGE = 48
/** Fastest auto-scroll, px per frame. */
const MAX_SPEED = 14

/**
 * Pixels to scroll this frame for a finger at `y`: up (negative) within `edge`
 * of the top, down within `edge` of the bottom, faster the closer it gets.
 */
export function edgeScrollDelta(y: number, top: number, bottom: number, edge = EDGE, max = MAX_SPEED): number {
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge))
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge))
  return 0
}

/** The element that scrolls `node` vertically: the nearest scrolling ancestor, else the page. */
function scrollParent(node: HTMLElement): HTMLElement {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement
}

export interface TouchReorderHandlers {
  /** The finger moved far enough: a drag of `sourceId` begins. */
  start: (sourceId: string) => void
  /** The finger is over row `targetId`; return whether that row takes the drop. */
  over: (sourceId: string, targetId: string) => boolean
  /** The finger lifted; `targetId` is the last row that took the drop, or null. */
  drop: (sourceId: string, targetId: string | null) => void
  /** The gesture ended without a drop (pointercancel, unmount, a new gesture). */
  cancel: () => void
}

/**
 * Drag-to-reorder for touch and pen. The handle's native drag (draggable) only
 * works with a mouse, so for other pointers this follows the finger: the row
 * under it is found by `data-upstream-id`, and the scroller scrolls while the
 * finger is near its top or bottom edge. Listeners sit on window, not on the
 * handle: the handle's row moves in the DOM as the preview reorders, which can
 * drop pointer capture.
 */
export function useTouchReorder(handlers: TouchReorderHandlers) {
  const latest = useRef(handlers)
  latest.current = handlers
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  return useCallback((event: ReactPointerEvent<HTMLElement>, sourceId: string) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return
    stop.current?.()
    const { pointerId } = event
    const startX = event.clientX
    const startY = event.clientY
    const scroller = scrollParent(event.currentTarget)
    const page = scroller === document.scrollingElement || scroller === document.documentElement
    let x = startX
    let y = startY
    let dragging = false
    let target: string | null = null
    let frame = 0

    const hover = () => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-upstream-id]")
      const id = row?.dataset.upstreamId
      if (id && id !== sourceId && latest.current.over(sourceId, id)) target = id
    }
    const scroll = () => {
      const { top, bottom } = page ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect()
      const delta = edgeScrollDelta(y, top, bottom)
      if (delta !== 0) {
        scroller.scrollBy(0, delta)
        hover()
      }
      frame = requestAnimationFrame(scroll)
    }
    const detach = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      stop.current = null
    }
    function move(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      x = e.clientX
      y = e.clientY
      if (!dragging) {
        if (Math.hypot(x - startX, y - startY) < SLOP) return
        dragging = true
        latest.current.start(sourceId)
        frame = requestAnimationFrame(scroll)
      }
      hover()
    }
    function finish(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      const wasDragging = dragging
      detach()
      if (!wasDragging) return
      if (e.type === "pointerup") latest.current.drop(sourceId, target)
      else latest.current.cancel()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
    stop.current = () => {
      const wasDragging = dragging
      detach()
      if (wasDragging) latest.current.cancel()
    }
  }, [])
}
```

  松手时只要手指曾经停在过合法的行上，就提交到最后那一行，与预览一致。原生拖放在两行之间的空隙松手不会触发 `drop`，触屏这里有意比它宽容。
- [ ] **Step 4：`UpstreamRow.tsx`**
  - Props 加 `onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void`，`PointerEvent` 从 react 引入类型；
  - 外层 div 加 `data-upstream-id={u.id}`；
  - 拖拽手柄的 `<Button>` 加 `onPointerDown={onHandlePointerDown}`。
- [ ] **Step 5：`UpstreamsTab.tsx`**

```tsx
  const dragRef = useRef(drag)
  dragRef.current = drag
  const touchDrag = useTouchReorder({
    start: (sourceId) => setDrag({ sourceId, targetId: null }),
    over: (sourceId, targetId) => {
      const target = store.upstreams.find((row) => row.id === targetId)
      if (!target || !canDropOn(sourceId, target)) return false
      setDrag((d) => (d && d.sourceId === sourceId && d.targetId !== targetId ? { ...d, targetId } : d))
      return true
    },
    drop: (sourceId, targetId) => {
      // Esc (the effect above) may have called the drag off mid-gesture.
      if (dragRef.current?.sourceId !== sourceId) return
      setDrag(null)
      if (!targetId) return
      const source = store.upstreams.find((row) => row.id === sourceId)
      const moved = store.reorderTo(sourceId, targetId, myOwnerId)
      if (source) announceMove(source, moved)
    },
    cancel: () => setDrag(null),
  })
```

  - 每个 `UpstreamRow` 传入 `onHandlePointerDown={g.isMine ? (event) => touchDrag(event, u.id) : undefined}`；
  - import `useRef` 和 `useTouchReorder`；
  - `useTouchReorder` 必须在所有提前 return 之前调用，遵守 hooks 规则。
- [ ] **Step 6：** 运行 `bun test apps/dashboard` 和 dashboard 类型检查，均通过。拖拽行为在 Task 13 用触屏模拟验证。

### Task 12：登录页副标题

**Files:** `packages/gateway/src/shared/edge/ui-pages/login.ts`（4 处 `text-sm text-themed-dim mt-2 font-light`）

- [ ] **Step 1：** 4 处都去掉 `font-light`，颜色和字号不变。
- [ ] **Step 2：** 运行 `grep -n "font-light" packages/gateway/src/shared/edge/ui-pages/*.ts`。如果已经没有其他使用者，在报告里说明 `layout.ts` 字体 URL 中的 `300` 字重可以去掉，本任务先不动 URL。
- [ ] **Step 3：** Task 13 截改动后的图，和 Task 0 的图放在一起交给用户决定。用户不同意就还原这一项。
- [ ] **Step 4：** 运行 `bun test packages/gateway/tests/ui-pages-token-parity.test.ts` 并通过。

### Task 13：代码评审和浏览器走查（主控执行）

- [ ] **代码评审：** 派一个 `superpowers:code-reviewer`，传给它本计划和 `git diff vNext`，只看评审结果，按 superpowers:receiving-code-review 的方式逐条处理。
- [ ] **重新构建并重启网关：** `bun run build:ui`，然后重启 41499 端口上的进程。
- [ ] **按改动逐项看**（1440、900、390 三种宽度；浅色和深色；中文和英文；管理员和普通用户）：
  1. **12px 小字：** 侧栏分组标题、代码块语言标签、模型头像标签、图像参数栏。
  2. **`text-body`：** 再跑一次 Task 0 的行高统计，与 `lh-before.json` 对比；抽查按钮、下拉菜单项和表格行的高度不变。
  3. **死代码：** 上游"刷新模型"仍然能用。不通的地址会弹出错误 toast。
  4. **标签点击：** 上游表单的 auth style、SDF 三栏、代理表单的协议和加密方法、用量页的筛选、模型页的 Key、Keys 配置面板、Setup 面板。点标签后，焦点要落到对应的选择框上。
  5. **Markdown 标题：** 往 `localStorage["playground.messages"]` 写一条带 `#`、`###` 的 assistant 消息，刷新模型页。DOM 里应为 h2/h3，字号和以前一致；该页 Lighthouse 无障碍为 100，heading-order 通过。
  6. **toast：**
     - 错误 toast 一直停留，点击后关闭；
     - 同一个错误连续触发，不会叠成多条；
     - 成功 toast 4 秒后消失；
     - 读屏播报仍只播一次。
  7. **代理页：**
     - 密码和 PSK 默认遮挡，眼睛按钮能切换，`aria-pressed` 跟着变；
     - 浏览器不会自动填入登录密码；
     - 端口是 number 输入框；
     - 网络调成 Slow 3G 时，首屏显示"加载中…"，不再闪空状态。
  8. **键盘排序播报：** 在手柄上按 ↑↓，以及点上移/下移按钮，status 区域的文字更新，焦点仍在手柄上。
  9. **触屏拖拽：** DevTools 模拟触屏，390 宽：
     - 按住手柄拖动，预览跟着变；
     - 松手后顺序保存，刷新后仍是新顺序；
     - 拖到列表上下边缘会自动滚动；
     - 只点一下手柄不会触发拖拽；
     - 别人的分组拖不动；
     - 桌面鼠标拖拽不受影响。
  10. **登录页副标题：** 截改动后的图。
- [ ] **Lighthouse 无障碍：** 每个页面在浅色、深色下都要 100。
- [ ] **键盘：** 用 Tab 走一遍新增的眼睛按钮和 label，焦点框可见。
- [ ] **清理：** 结束后杀掉网关进程，删除 `/tmp/cag-walk`。

### Task 14：全量门禁和汇报（主控执行）

- [ ] 运行 `bun run ci:local`：
  - 失败清单必须与基线一致，即上文的 21 项环境问题；
  - 然后单独跑 `bun run lint`，要求 0 error，warning 不多于 38；
  - 再跑 `bun run build:ui` 和 `bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry`。
- [ ] 记录 dashboard 包体积的变化，对比基线：JS 1,061,127 字节，CSS 57,278 字节。
- [ ] 用中文汇报：每项改了什么、怎么验证的、截图（重点是登录页前后对比）、遗留问题。然后问用户是否提交和部署，建议的提交分组如下：
  1. 字号与 `text-body`（Task 1、2）
  2. 死代码（Task 3）
  3. Meter、Select 标签、Markdown 标题、测试注入（Task 4–7）
  4. toast 与代理页（Task 8、9）
  5. 上游排序播报与触屏拖拽（Task 10、11）
  6. 登录页副标题（Task 12）
  7. 本计划文档

---

## 执行记录（与计划的偏差）

- **Task 0：** chrome-devtools MCP 读不到主 Chrome 的 `DevToolsActivePort`（沙箱 EPERM），所以改用独立的 headless Chrome（`--remote-debugging-port=9333`，临时 profile）配合 puppeteer-core 和 Lighthouse CLI 走查，工具都装在 `/tmp/cag-walk/tools`。行高实测：`text-[13px]` 元素基本都是 19.5px，即从根继承的 1.5 倍，所以 `--text-body--line-height` 取 1.5。
- **Task 2：** `DisabledModelsSection` 的多选 `<select>` 去掉了 `text-[13px]`，没有替换成 `text-body`。它的字号和行高来自全局的 `select` 规则（13px/18px），而 18px 就是每个选项行的高度，换成 `text-body` 会让每行多出 1.5px。这个类本来就是多余的，去掉后外观不变。分段切换按钮的行高从继承的 16px 变成 19.5px，但按钮高度固定（`h-6`/`h-7`），实测文字位置不变。
- **Task 9：** React 渲染出的属性名是 `autoComplete`，测试改为不区分大小写匹配。
- **Task 11：** 触屏实测发现，页面已经滚动时一开始拖拽，`scrollTop` 会突然跳一整行（192px），被拖的行随之离开手指。原因是 Chrome 的滚动锚定：预览重排时它会滚动页面，让锚点那一行保持不动。临时给 `main` 加上 `overflow-anchor: none` 后问题消失，验证了这个判断。修复方式是只在拖拽期间给上游列表容器加 `[overflow-anchor:none]`；平时保留锚定，用来稳住异步加载时的布局。鼠标拖拽也受益于这个修复。
- **Task 12：** 设备授权页（`device.ts:71`）的副标题和登录页是同一种写法，一并去掉了 `font-light`，共 5 处。改完以后，服务端页面已经没有地方用 300 字重，但 `layout.ts:31` 的字体链接仍会加载它，可以另行删掉。
- **Task 13（代码评审后的修复）：**
  - 评审发现触屏拖拽有两个可复现的问题：
    - 轻扫时，抬起事件早于 React 渲染，`drop` 读到旧的 `dragRef` 就提前返回，列表停在拖拽状态，显示的新顺序也没有保存；
    - 笔输入时 Chrome 会同时启动原生拖拽，这个指针之后不再上报 up 或 cancel，监听器和自动滚动循环因此一直残留。
  - 修复：
    - 把手势抽成不依赖 DOM 的 `trackTouchReorder`，由它负责 `abort()`，并在原生 `dragstart` 时让位；
    - `UpstreamsTab` 删掉 `dragRef`，`drop` 总是清理状态，Esc 时调用 `abort()`；
    - 补了 9 条手势单测，覆盖轻点、轻扫、拒绝的目标、Esc、原生拖拽接管、pointercancel、其他指针、自动滚动。
  - 评审留下的复现脚本修复后全部通过。
  - 评审的 Minor 意见：
    - toast 超出上限时优先淘汰非错误类；
    - `ProxyForm` 加了 `key`，显示过的密码不会带到下一个代理；
    - 端口改为 `type="text"` 加 `inputMode="numeric"`，避开 number 框的滚轮误改和空值按上箭头变 1 的问题，范围仍由 `draftIssues` 校验。

---

## 追加：提交前修复（2026-11-12，用户在汇报后选定）

用户从汇报的“发现的原有问题”里选了 3 项，要求修完再提交。流程不变：实现 → 浏览器走查 → 代码评审 → 全量门禁 → 汇报 → 问是否提交。

### Task 15：Markdown 列表显示圆点和序号

**Files：** `apps/dashboard/src/styles.css`（`.md-body` 的列表规则）

- **原因：** Tailwind preflight 把 `ul`/`ol` 设成了 `list-style: none`，`.md-body` 只设置了缩进，没有恢复列表样式，所以聊天回复里的列表看起来像普通段落。
- **做法：** 加上以下规则，其余样式不动：
  - `.md-body ul { list-style: disc }`
  - `.md-body ol { list-style: decimal }`
  - 嵌套的 `ul ul` 用 `circle`，`ul ul ul` 用 `square`
  - GFM 任务列表项（`li:has(> input[type=checkbox])`）不显示圆点，因为已经有复选框了
- **验证：** 浏览器里读 computed `list-style-type`，并截图。

### Task 16：Keys 配置面板在后台刷新时不重建

**Files：** `apps/dashboard/src/state/models.ts`（`useModelCatalog`）、`apps/dashboard/src/tabs/keys/KeyDetailPanel.tsx`

- **原因：** `useModelCatalog` 每次刷新都把 `loading` 设为 true。刷新的时机有三个：窗口获得焦点、每 60 秒、目录为空时的重试。ConfigurationPanel 在 `catalogLoading` 期间用 “Loading models…” 替换整组模型选择框和 Setup 面板，于是：
  - 打开着的下拉会被关掉；
  - 切回窗口后的第一下点击会落空；
  - Setup 面板被重新挂载，已签发的 lease 和选择都被清空。
- **做法：**
  - `useModelCatalog` 记录目录是为哪个 key 加载的（`loadedFor`），并返回 `ready = loadedFor === keyId`。`KeysTab` 没有给 `KeyDetailPanel` 加 key，hook 实例会在切换 key 时复用，所以要按 key 判断。
  - `KeyDetailPanel` 给 ConfigurationPanel 传 `catalogLoading={!ready}`，即只有首次加载才显示占位。
  - ModelMappingsPanel 继续用 `loading`：刷新期间禁用保存，这个行为保持不变。
- **验证：** 浏览器里先打开一个模型下拉，再派发 window `focus` 事件触发刷新。要求下拉保持打开，触发按钮和 Setup 面板是同一个 DOM 节点（没有被重建）。

### Task 17：去掉 300 字重；VLESS UUID 遮挡

**Files：** `packages/gateway/src/shared/edge/ui-pages/layout.ts`（字体链接）、`apps/dashboard/src/tabs/proxies/ProxyForm.tsx`（3 处 UUID）、`i18n.ts`（新增 `dash.proxyShowUuid`）、`proxy-form.test.tsx`

- **字体：** `Geist:wght@300;400;500;600;700` 改成 `Geist:wght@400;500;600;700`。服务端页面和 i18n 文案里都已经没有 `font-light` 和 300 字重。
- **UUID：** vless-tcp、vless-ws、reality 的 UUID 改用 `SecretField`，`toggleLabel={t('dash.proxyShowUuid')}`。新增读屏文案：en "Show UUID"，zh "显示 UUID"。publicKey 是公钥，不遮。代理 URL 框按用户之前的决定保持明文。
- **测试：** 新增一条，vless-tcp 草稿的 UUID 渲染为 `type="password"`，并带 `dash.proxyShowUuid` 开关。

### 追加任务的执行记录

- **评审结论：** with fixes。
- **Important：** 切换 key 时，如果旧 key 的响应最后才到，会把当前 key 的 `ready` 改回 false。修法：
  - `useModelCatalog` 改为把目录和它所属的 key 一起存放（`LoadedCatalog`）；
  - 只有当前 key 的最新请求可以写入；
  - 切换后才完成的旧 key 保存刷新直接跳过，既不发请求，也不作废新 key 的加载；
  - 当前 key 的目录还没到时返回空目录和 `loading: true`，避免旁边的面板拿空目录做判断。
  - 用 jsdom 驱动 hook，在 6 个场景下验证：首次加载与后台刷新、A→B 时 A 晚到、A→B→A、首次失败后的重试、无 key、切换后才完成的保存。
  - 补了 `catalogFor` 的单测。
- **Minor：**
  - 松散任务列表的复选框在段落里，选择器补上 `> p:first-child > input`；
  - 嵌套标记改为按任意列表层级计算，和浏览器一致；
  - VLESS 测试覆盖 tcp、ws、reality 三种。
- **说明：** UUID 和密码一样，在下方的 URL 框里仍是明文，这是用户此前的决定。
- **未处理：** 回复里的 GFM 任务列表复选框没有标签，Lighthouse `label` 审计不通过，模型页得 96 分。这是 marked 原有的渲染方式，要修需要新增读屏文案，留给用户决定。
