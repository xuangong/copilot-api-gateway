# Dashboard 文案和 i18n 整理（交接 4.1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做掉交接文档 `docs/superpowers/handoffs/2026-11-12-dashboard-redesign-handoff.md` 第 4.1 节：写死的英文全部进 i18n，日期跟随界面语言，确认框换成页面内对话框，Agent Remote 统一名字，面包屑去重，读屏名称去重。

**Architecture:** 措辞已由所有者在 2026-11-12 逐条批准（"按推荐"），见下面的"已批准措辞"，实现时一字不改照抄。
- 新增 key 集中放在两个字典各一段里；改动的旧 key 原地改。
- 逻辑部分抽成纯函数并写单测：插值、日期 locale、周期标签、相对时间、确认问答、面包屑。
- 纯文本替换靠以下三层验证：
  - `i18n-keys` 测试保证 key 存在；
  - 测试用词典 helper 断言真实中英文；
  - 浏览器中英文走查。

**Tech Stack:** React 19、Radix Dialog、bun:test（`renderToStaticMarkup`，没有 DOM）、`packages/gateway/src/shared/edge/ui-pages/i18n.ts` 里的全局 `t()`。

---

## 背景（实现者必读）

- **工作目录：** worktree `/Users/xian/projects/copilot-api-gateway/.worktrees/i18n-copy-cleanup/vnext`，分支 `i18n-copy-cleanup`，基于 vNext `498a5546`。
- **Bun：** 每条命令前先 `export PATH=/Users/xian/.cache/bun-1.3.0:$PATH`。依赖已用 `bun install --frozen-lockfile --linker hoisted` 装好。测试一律在 `vnext/` 下运行。
- **基线**（2026-11-12，本 worktree 未改动时）：
  - `bun test` 共 7102 个用例，22 个失败，10 个错误。
  - 失败名单在 `/tmp/cag-i18n/baseline-fails.txt`，共 12 个去重后的名字，全部是 research harness 等环境问题。
  - 最后的门禁按名字对比，不按数量对比。
- **全局 `t()` 的行为：**
  - `apps/dashboard/src/state/i18n.ts` 的 `t()` 和 `useT()` 调用页面脚本注入的 `window.t`。
  - 测试里没有 `window`，`t()` 原样返回 key。
  - 想断言真实中英文，用 Task 2 的 `installDictionary(lang)`。
- **字典写法：**
  - 字典在一个模板字符串里，值里的英文双引号写成 `\\"`；
  - 中文引号用 `“”`；
  - 不能出现反引号和 `${`；
  - 新增 key 两个字典都要加，加完跑 `bun test packages/gateway/tests/i18n-keys.test.ts`。
  - 该测试只认 `t("字面量")` 形式，所以新代码里不要把三元表达式放进 `t(...)`。
- **不提交、不 stash。** 交接约定是提交前先问用户。

## 已批准措辞

| key | en | zh | 状态 |
|---|---|---|---|
| `dash.confirmDeleteKey` | `Delete API key \\"{name}\\"?` | `删除 API 密钥“{name}”？` | 改值（原 key 未被引用） |
| `dash.confirmIrreversible` | `This cannot be undone.` | `此操作无法撤销。` | 新 |
| `dash.confirmDeleteUpstream` | `Delete upstream \\"{name}\\"?` | `删除上游“{name}”？` | 新 |
| `dash.confirmDeleteUpstreamUsage` | `Existing usage records are kept.` | `已有的用量记录会保留。` | 新 |
| `dash.confirmDeleteUpstreamNoAccount` | `No GitHub account is attached.` | `未关联 GitHub 账号。` | 新 |
| `dash.confirmSignOutUpstream` | `Sign out \\"{name}\\"?` | `退出登录“{name}”？` | 新 |
| `dash.confirmSignOutUpstreamHint` | `This removes the GitHub token from the gateway.` | `网关中保存的 GitHub token 会被删除。` | 新 |
| `dash.confirmDeleteInvite` | `Delete this invite code?` | `删除这个邀请码？` | 改值（原 key 未被引用） |
| `dash.confirmDeleteUser` | `Delete user \\"{name}\\"?` | `删除用户“{name}”？` | 改值（原 key 未被引用） |
| `dash.confirmDeleteUserHint` | `This removes their keys, tokens, and assignments.` | `该用户的密钥、token 和分配记录会一并删除。` | 新 |
| `dash.remote.revokeConfirm` | `Revoke {label}'s access to this Host?` | `撤销 {label} 对此 Host 的访问权限？` | 改值（拆出后半句） |
| `dash.remote.revokeConfirmHint` | `Their used session count is kept if you grant access again.` | `重新授权时已用次数不会重置。` | 新 |
| `dash.importReplaceConfirmTitle` | `Import in replace mode?` | `以覆盖模式导入？` | 新 |
| `dash.importReplaceConfirm` | `Replace mode deletes all existing API keys, GitHub accounts and upstreams before importing.` | `覆盖模式会先删除所有现有的 API 密钥、GitHub 账号和上游，再导入。` | 改值（去掉 Continue?） |
| `dash.importReplaceAction` | `Replace and import` | `覆盖并导入` | 新 |
| `dash.probeModelsToast` | `{name}: {n} models` | `{name}：{n} 个模型` | 新 |
| `dash.probeFailedToast` | `{name}: {error}` | `{name}：{error}` | 新 |
| `dash.probeFailed` | `probe failed` | `探测失败` | 新 |
| `dash.deletedToast` | `Deleted {name}` | `已删除 {name}` | 新 |
| `dash.signedOutToast` | `Signed out {name}` | `{name} 已退出登录` | 新 |
| `dash.wsConfigCopiedToast` | `Web search config copied` | `已复制网页搜索配置` | 新 |
| `dash.sharedWithToast` | `Shared with {email}` | `已分享给 {email}` | 新 |
| `dash.unshareToast` | `Unshared` | `已取消分享` | 复用现有 key |
| `dash.periodToday` | `Today ({date})` | `今天（{date}）` | 新 |
| `dash.periodYesterday` | `Yesterday ({date})` | `昨天（{date}）` | 新 |
| `dash.periodThisWeek` | `This week ({range})` | `本周（{range}）` | 新 |
| `dash.periodLastWeek` | `Last week ({range})` | `上周（{range}）` | 新 |
| `dash.periodThisMonth` | `This month ({month})` | `本月（{month}）` | 新 |
| `dash.periodLastMonth` | `Last month ({month})` | `上月（{month}）` | 新 |
| `dash.previousDay` / `dash.nextDay` | `Previous day` / `Next day` | `前一天` / `后一天` | 新 |
| `dash.previousWeek` / `dash.nextWeek` | `Previous week` / `Next week` | `上一周` / `下一周` | 复用 |
| `dash.previousMonth` / `dash.nextMonth` | `Previous month` / `Next month` | `上个月` / `下个月` | 新 |
| `dash.minutesAgoShort` | `{n}m ago` | `{n} 分钟前` | 新 |
| `dash.hoursAgoShort` | `{n}h ago` | `{n} 小时前` | 新 |
| `dash.daysAgoShort` | `{n}d ago` | `{n} 天前` | 新 |
| `dash.chartCache` | `Cache` | `缓存` | 新 |
| `dash.unitRequests` | `req` | `次请求` | 新（代码里补前导空格） |
| `dash.unitTokens` | `tokens` | `tokens` | 新 |
| `dash.tokensCount` | `{n} tokens` | `{n} tokens` | 新 |
| `dash.rollingCellAria` | `{label}: {total} over 28 days, {day} that day, {tokens} tokens` | `{label}：28 天 {total}，当天 {day}，{tokens} tokens` | 新（读屏） |
| `dash.chartModelDimension` | `Chart model dimension` | `图表模型维度` | 新（读屏） |
| `dash.playground.webSearchDone` | `Searched` | `已搜索` | 新 |
| `dash.playground.webSearchRunning` | `Searching` | `正在搜索` | 新 |
| `dash.playground.webSearchPending` | `Preparing search` | `准备搜索` | 新 |
| `dash.unknownPage` | `Unknown page` | `未知页面` | 新 |
| `dash.wsPassthroughUpstreamAria` | `Codex search passthrough upstream` | `Codex 搜索转发上游` | 新（读屏） |
| `dash.wsPassthroughModelAria` | `Codex search passthrough model` | `Codex 搜索转发模型` | 新（读屏） |
| `dash.remote.title` | `Agent Remote` | `Agent Remote` | 改值 |
| `dash.wsLinkUnavailable` | `Borrowed key unavailable` | `借用的密钥不可用` | 改值（去掉 ↗） |

复用、不改值的 key：
- 按钮：`dash.delete`、`dash.signOut`、`dash.remote.revoke`、`dash.cancel`；
- 分布条：`dash.requests`、`dash.input`、`dash.output`；
- 其他：`dash.loadingShort`、`dash.refreshLabel`、`dash.unknown`、`dash.copy`、`dash.adminLabel`；
- 相对时间（长格式）：`dash.justNow`、`dash.oneMinuteAgo`、`dash.minutesAgo`、`dash.oneHourAgo`、`dash.hoursAgo`、`dash.oneDayAgo`、`dash.daysAgo`。

保持不变：TTFT、tok/s、n=、OpenAI Embeddings、System One、OpenAI Decisions。

不做：
- 任务列表勾选框的读屏文字，用户没有选；
- 没有显式 locale 的 `toLocaleString()`，它们跟随浏览器，不在交接清单里。

---

### Task 1: 插值安全

**Files:**
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`（`function t` 里的插值循环）
- Test: `packages/gateway/tests/i18n-interpolation.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "bun:test"
import { renderI18nScript } from "../src/shared/edge/ui-pages/i18n.ts"

type Translate = (key: string, vars?: Record<string, string | number>) => string

// Runs the page script against stand-ins for the browser globals it touches.
const loadT = (lang: "en" | "zh"): Translate => {
  const body = renderI18nScript().replace(/^<script>/, "").replace(/<\/script>$/, "")
  const run = new Function("window", "localStorage", "navigator", "document", `${body}\nreturn t`)
  return run({}, { getItem: () => lang }, { language: "en-US" }, { documentElement: { setAttribute() {} } }) as Translate
}

test("a value goes in exactly as written, $ patterns included", () => {
  expect(loadT("en")("dash.proxyDeleteConfirm", { name: "a$&b$'c$$d" })).toBe(`Delete proxy node "a$&b$'c$$d"?`)
})

test("every occurrence of a placeholder is filled", () => {
  expect(loadT("en")("{x} and {x}", { x: 1 })).toBe("1 and 1")
})

test("the chosen language wins, English fills the gaps", () => {
  expect(loadT("zh")("dash.delete")).toBe("删除")
  expect(loadT("en")("dash.delete")).toBe("Delete")
})
```

- [ ] **Step 2: 运行，确认前两个失败**

Run: `bun test packages/gateway/tests/i18n-interpolation.test.ts`
Expected: 前两个 FAIL。`$&` 被替换成 `{name}`，第二个 `{x}` 没有被填上。

- [ ] **Step 3: 改插值**

```js
  if (vars) {
    for (var k in vars) {
      if (vars.hasOwnProperty(k)) {
        // split/join, not replace(): "$&" in a name must come out as typed,
        // and a placeholder may appear more than once.
        s = s.split('{' + k + '}').join(String(vars[k]));
      }
    }
  }
```

- [ ] **Step 4: 运行，确认全部通过**

### Task 2: 测试用词典和日期 locale

**Files:**
- Create: `apps/dashboard/src/state/i18n-fixture.ts`
- Modify: `apps/dashboard/src/state/i18n.ts`（新增 `dateLocale()`）
- Test: `apps/dashboard/src/state/i18n.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "bun:test"
import { dateLocale, t } from "./i18n"
import { installDictionary } from "./i18n-fixture"

test("without a page script t() hands back the key and dates are en-US", () => {
  expect(t("dash.delete")).toBe("dash.delete")
  expect(dateLocale()).toBe("en-US")
})

test("dates follow the interface language", () => {
  const restore = installDictionary("zh")
  try {
    expect(t("dash.delete")).toBe("删除")
    expect(dateLocale()).toBe("zh-CN")
  } finally {
    restore()
  }
  expect(dateLocale()).toBe("en-US")
})
```

- [ ] **Step 2: 运行，确认失败**（`i18n-fixture` 和 `dateLocale` 不存在）

- [ ] **Step 3: 实现**

`state/i18n.ts` 末尾：

```ts
/** Dates follow the interface language, not the browser's: "Aug 12" or "8月12日". */
export function dateLocale(): "en-US" | "zh-CN" {
  return typeof window !== "undefined" && window.__lang === "zh" ? "zh-CN" : "en-US"
}
```

`state/i18n-fixture.ts`：

```ts
// Test-only. Loads the real window.t() and both dictionaries from the gateway's
// page script, so a test can check the words a user reads, in either language.
// Without it t() returns the bare key.
import { renderI18nScript } from "../../../../packages/gateway/src/shared/edge/ui-pages/i18n"

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Installs window.t and window.__lang for `lang`; call what it returns to undo. */
export function installDictionary(lang: "en" | "zh"): () => void {
  const body = renderI18nScript().replace(/^<script>/, "").replace(/<\/script>$/, "")
  const fakeWindow: { t?: Translate; __lang?: string } = {}
  const run = new Function("window", "localStorage", "navigator", "document", `${body}\nreturn t`)
  fakeWindow.t = run(fakeWindow, { getItem: () => lang }, { language: "en-US" }, { documentElement: { setAttribute() {} } }) as Translate
  const scope = globalThis as { window?: unknown }
  const had = "window" in scope
  const previous = scope.window
  scope.window = fakeWindow
  return () => {
    if (had) scope.window = previous
    else delete scope.window
  }
}
```

- [ ] **Step 4: 运行，确认通过**

### Task 3: 日期跟随界面语言，周期标签进 i18n

**Files:**
- Modify:
  - `apps/dashboard/src/state/usage.ts`（`formatDayLabel`、`formatWeekLabel`、`formatMonthLabel`）
  - `apps/dashboard/src/state/latency.ts`（`formatWeekLabel`）
  - `apps/dashboard/src/state/time-buckets.ts`（`dayLabel`、星期名）
  - `apps/dashboard/src/state/usage-strip.ts`（格子的 `label`）
  - `packages/gateway/src/shared/edge/ui-pages/i18n.ts`：`dash.period*`
- Test:
  - `apps/dashboard/src/state/usage-range.test.ts`
  - `apps/dashboard/src/state/usage-strip.test.ts`
  - `apps/dashboard/src/state/latency.test.ts`（没有就新建）

- [ ] **Step 1: 改测试。** `usage-range.test.ts` 里断言英文标签的 3 处（`formatDayLabel`、`existing labels still work`、UTC 那条）在 `beforeEach` 里 `installDictionary("en")`，在 `afterEach` 里恢复，原断言不动。再加一条中文用例：

```ts
describe("labels in Chinese", () => {
  let restore = () => {}
  beforeEach(() => { restore = installDictionary("zh") })
  afterEach(() => restore())

  test("day, week and month read in Chinese", () => {
    expect(formatDayLabel(0, NOW, "local")).toBe("今天（8月12日）")
    expect(formatDayLabel(-1, NOW, "local")).toBe("昨天（8月11日）")
    expect(formatDayLabel(-2, NOW, "local")).toBe("2026年8月10日")
    expect(formatWeekLabel(0, NOW, "local")).toBe("本周（8月10日 – 8月16日）")
    expect(formatWeekLabel(-1, NOW, "local")).toStartWith("上周（")
    expect(formatMonthLabel(0, NOW, "local")).toBe("本月（2026年8月）")
    expect(formatMonthLabel(-1, NOW, "local")).toBe("上月（2026年7月）")
  })

  test("week buckets name the weekday in Chinese", () => {
    const { labels } = buildTimeBuckets("week", 0, NOW, null, "local")
    expect(labels[0]).toBe("周一 8月10日")
    expect(labels[6]).toBe("周日 8月16日")
  })
})
```

`usage-strip.test.ts` 加一条：装 zh 词典后，同一格的 `label` 是 `"8月12日"`。`latency` 的 `formatWeekLabel` 加一条中英文用例（它内部用 `new Date()`，只断言前缀 `This week (` 和 `本周（`）。

- [ ] **Step 2: 运行，确认中文用例失败**
- [ ] **Step 3: 实现。** 四个文件都改成 `toLocaleDateString(dateLocale(), …)`。
  - 周期标签改成 `t("dash.periodToday", { date })` 等。
  - `usage.ts` 的 hook 里已经有 `const t = useT()`，所以模块级的那个导入写成 `t as tStatic`。
  - 星期名改成 `d.toLocaleDateString(locale, { weekday: "short", ...ops.fmt })`，删掉写死的 `weekdays` 数组。
  - `usage-strip.ts` 的函数里有个局部变量叫 `window`，所以 `dateLocale()` 要在循环外先取好。
- [ ] **Step 4: 运行这三个测试文件和 `time-buckets.test.ts`，确认通过**

### Task 4: 相对时间合并

**Files:**
- Create: `apps/dashboard/src/state/time-ago.ts`
- Modify:
  - `tabs/keys/helpers.ts`（删掉 `timeAgo`）、`tabs/keys/KeyRow.tsx`
  - `api/users.ts`（删掉 `timeAgo`）、`tabs/users/InviteCodesPanel.tsx`、`tabs/users/UserRow.tsx`
  - `tabs/clients/ClientsTab.tsx`（删掉本地 `timeAgo`）
  - i18n：`dash.*AgoShort`
- Test: `apps/dashboard/src/state/time-ago.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installDictionary } from "./i18n-fixture"
import { timeAgo } from "./time-ago"

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("in English", () => {
  let restore = () => {}
  beforeEach(() => { restore = installDictionary("en") })
  afterEach(() => restore())

  test("short style stays compact", () => {
    expect(timeAgo(ago(30_000), NOW)).toBe("just now")
    expect(timeAgo(ago(5 * MIN), NOW)).toBe("5m ago")
    expect(timeAgo(ago(3 * HOUR), NOW)).toBe("3h ago")
    expect(timeAgo(ago(30 * DAY), NOW)).toBe("30d ago")
  })

  test("long style spells it out, singular for one", () => {
    expect(timeAgo(ago(MIN), NOW, "long")).toBe("1 minute ago")
    expect(timeAgo(ago(5 * MIN), NOW, "long")).toBe("5 minutes ago")
    expect(timeAgo(ago(HOUR), NOW, "long")).toBe("1 hour ago")
    expect(timeAgo(ago(2 * DAY), NOW, "long")).toBe("2 days ago")
  })

  test("past 30 days it shows the date", () => {
    expect(timeAgo("2026-09-01T12:00:00Z", NOW)).toBe("Sep 1, 2026")
  })

  test("missing, unparseable and future times", () => {
    expect(timeAgo(null, NOW)).toBe("")
    expect(timeAgo("not a date", NOW)).toBe("")
    expect(timeAgo(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe("just now")
  })
})

test("in Chinese both styles read the same", () => {
  const restore = installDictionary("zh")
  try {
    expect(timeAgo(ago(30_000), NOW)).toBe("刚刚")
    expect(timeAgo(ago(5 * MIN), NOW)).toBe("5 分钟前")
    expect(timeAgo(ago(5 * MIN), NOW, "long")).toBe("5 分钟前")
    expect(timeAgo(ago(3 * HOUR), NOW)).toBe("3 小时前")
    expect(timeAgo(ago(2 * DAY), NOW, "long")).toBe("2 天前")
    expect(timeAgo("2026-09-01T12:00:00Z", NOW)).toBe("2026年9月1日")
  } finally {
    restore()
  }
})
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现**

```ts
import { dateLocale, t } from "./i18n"

export type TimeAgoStyle = "short" | "long"

/**
 * How long ago, in the interface language: "5m ago" (short, for dense rows) or
 * "5 minutes ago" (long); past 30 days, the date. Empty for a missing or
 * unparseable time; a time in the future counts as just now.
 */
export function timeAgo(value: string | null | undefined, nowMs: number = Date.now(), style: TimeAgoStyle = "short"): string {
  if (!value) return ""
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return ""
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (seconds < 60) return t("dash.justNow")
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    if (style === "short") return t("dash.minutesAgoShort", { n: minutes })
    return minutes === 1 ? t("dash.oneMinuteAgo") : t("dash.minutesAgo", { n: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    if (style === "short") return t("dash.hoursAgoShort", { n: hours })
    return hours === 1 ? t("dash.oneHourAgo") : t("dash.hoursAgo", { n: hours })
  }
  const days = Math.floor(hours / 24)
  if (days <= 30) {
    if (style === "short") return t("dash.daysAgoShort", { n: days })
    return days === 1 ? t("dash.oneDayAgo") : t("dash.daysAgo", { n: days })
  }
  return new Date(at).toLocaleDateString(dateLocale(), { month: "short", day: "numeric", year: "numeric" })
}
```

调用方：
- 密钥页（`KeyRow`）、邀请码、用户行用短格式；客户端页用 `timeAgo(c.lastSeenAt, now, "long")`。
- 原来的三个实现都删掉，`ClientsTab` 里没用了的 `tStatic` 导入也一起删。
- 行为变化（已获批准）：
  - 用户页 1 分钟内的 `12s ago` 改成 `just now`；
  - 超过 30 天的 `3mo ago` 和 `1y ago` 改成日期。

- [ ] **Step 4: 运行通过；`bun run --filter '@vibe-llm/dashboard' typecheck` 通过**

### Task 5: 页面内确认框

**Files:**
- Create: `apps/dashboard/src/ui/confirm-dialog.tsx`、`apps/dashboard/src/state/confirm.tsx`
- Modify: `apps/dashboard/src/App.tsx`（在 `ToastProvider` 里包一层 `ConfirmProvider`）
- Test: `apps/dashboard/src/state/confirm.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { ConfirmActions } from "../ui/confirm-dialog"
import { createAsker } from "./confirm"

const request = { title: "Delete?", confirmLabel: "Delete", danger: true }

test("the answer settles the question and closes the dialog", async () => {
  const shown: unknown[] = []
  const asker = createAsker((r) => shown.push(r))
  const yes = asker.ask(request)
  asker.answer(true)
  expect(await yes).toBe(true)
  const no = asker.ask(request)
  asker.answer(false)
  expect(await no).toBe(false)
  expect(shown).toEqual([request, null, request, null])
})

test("a second question answers the first one no", async () => {
  const asker = createAsker(() => {})
  const first = asker.ask(request)
  const second = asker.ask({ ...request, title: "Sign out?" })
  expect(await first).toBe(false)
  asker.answer(true)
  expect(await second).toBe(true)
})

test("an answer with nothing open only closes the dialog", () => {
  const shown: unknown[] = []
  createAsker((r) => shown.push(r)).answer(true)
  expect(shown).toEqual([null])
})

test("Cancel comes first; only destructive actions are red", () => {
  const danger = renderToStaticMarkup(<ConfirmActions cancelLabel="Cancel" confirmLabel="Delete" danger onAnswer={() => {}} />)
  expect(danger.indexOf("Cancel")).toBeLessThan(danger.indexOf("Delete"))
  expect(danger).toContain("bg-danger")
  expect(renderToStaticMarkup(<ConfirmActions cancelLabel="Cancel" confirmLabel="Import" onAnswer={() => {}} />)).not.toContain("bg-danger")
})

test("no confirmation is left on window.confirm()", () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        // useConfirm() is called with an object; the native one with a string.
        if (/\b(?:window\.)?confirm\((?!\s*\{)/.test(readFileSync(path, "utf8"))) offenders.push(path)
      }
    }
  }
  walk(join(import.meta.dir, ".."))
  expect(offenders).toEqual([])
})
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现**

`ui/confirm-dialog.tsx`（ui 层不碰 i18n，文字由调用方传入）：

```tsx
import { Button } from "./button"
import { Dialog } from "./dialog"

export interface ConfirmRequest {
  title: string
  /** What going ahead does, when the title alone doesn't say. */
  description?: string
  /** The action by name ("Delete", "Sign out"), never "OK". */
  confirmLabel: string
  /** Destructive actions get the red button. */
  danger?: boolean
}

interface ActionsProps {
  cancelLabel: string
  confirmLabel: string
  danger?: boolean
  onAnswer: (ok: boolean) => void
}

/** Cancel first, so it is where focus lands when the dialog opens. */
export function ConfirmActions({ cancelLabel, confirmLabel, danger = false, onAnswer }: ActionsProps) {
  return (
    <>
      <Button variant="secondary" onClick={() => onAnswer(false)}>{cancelLabel}</Button>
      <Button variant={danger ? "danger" : "primary"} onClick={() => onAnswer(true)}>{confirmLabel}</Button>
    </>
  )
}

/** In place of window.confirm(): Esc, a click outside and Cancel all answer no. */
export function ConfirmDialog({ request, cancelLabel, onAnswer }: { request: ConfirmRequest; cancelLabel: string; onAnswer: (ok: boolean) => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(false)
      }}
      title={request.title}
      description={request.description}
      className="max-w-md"
      footer={<ConfirmActions cancelLabel={cancelLabel} confirmLabel={request.confirmLabel} danger={request.danger} onAnswer={onAnswer} />}
    >
      {null}
    </Dialog>
  )
}
```

`state/confirm.tsx`：

```tsx
import { createContext, useContext, useState, type ReactNode } from "react"
import { ConfirmDialog, type ConfirmRequest } from "../ui/confirm-dialog"
import { useT } from "./i18n"

export type { ConfirmRequest }
export type Confirm = (request: ConfirmRequest) => Promise<boolean>

/**
 * One question at a time. A new question while one is open answers the open
 * one no, so no caller is left waiting on a dialog that has gone.
 */
export function createAsker(show: (request: ConfirmRequest | null) => void): { ask: Confirm; answer: (ok: boolean) => void } {
  let pending: ((ok: boolean) => void) | null = null
  return {
    ask: (request) => {
      pending?.(false)
      return new Promise<boolean>((resolve) => {
        pending = resolve
        show(request)
      })
    },
    answer: (ok) => {
      const resolve = pending
      pending = null
      show(null)
      resolve?.(ok)
    },
  }
}

const ConfirmCtx = createContext<Confirm | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const [asker] = useState(() => createAsker(setRequest))
  return (
    <ConfirmCtx.Provider value={asker.ask}>
      {children}
      {request ? <ConfirmDialog request={request} cancelLabel={t("dash.cancel")} onAnswer={asker.answer} /> : null}
    </ConfirmCtx.Provider>
  )
}

/** Asks in the page's own dialog; resolves true only when the named action is chosen. */
export function useConfirm(): Confirm {
  const ask = useContext(ConfirmCtx)
  if (!ask) throw new Error("useConfirm must be used inside <ConfirmProvider>")
  return ask
}
```

`App.tsx`：

```tsx
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
        <ToastHost />
      </ToastProvider>
```

- [ ] **Step 4: 前四个测试通过。最后一个（扫描原生 confirm）要到 Task 6 做完才会通过。**

### Task 6: 10 处确认和 toast 接入

**Files:**
- Modify:
  - `state/upstreams.ts`（`remove`、`probe`）
  - `state/users.ts`（`deleteInvite`、`deleteUser`）
  - `state/keys.ts`（`deleteKey`、`copyWebSearchFrom`、`assignKey`、`unassignKey`）
  - `tabs/proxies/ProxiesTab.tsx`（`remove`）
  - `tabs/settings/SettingsTab.tsx`（`onConfirmImport`）
  - `tabs/agent-remote/AgentRemoteTab.tsx`（`ShareRow`）
  - `tabs/agent-remote/remote-text.ts`
  - i18n：确认框和 toast 的 key
- Test: `tabs/agent-remote/AgentRemoteTab.test.tsx`（`ShareRow` 外面包 `ConfirmProvider`）

- [ ] **Step 1: 接入。** 每个 hook 或组件里加 `const confirm = useConfirm()`；`users.ts` 和 `keys.ts` 再加 `const t = useT()`；`useCallback` 的依赖数组补上 `confirm` 和 `t`。

各处的调用（`danger` 全部为 `true`）：

| 位置 | title | description | confirmLabel |
|---|---|---|---|
| 删除密钥 | `t("dash.confirmDeleteKey", { name })` | `t("dash.confirmIrreversible")` | `t("dash.delete")` |
| 删除无账号的 Copilot 上游 | `t("dash.confirmDeleteUpstream", { name: u.name })` | `t("dash.confirmDeleteUpstreamNoAccount")` | `t("dash.delete")` |
| Copilot 上游退出登录 | `t("dash.confirmSignOutUpstream", { name: u.name })` | `t("dash.confirmSignOutUpstreamHint")` | `t("dash.signOut")` |
| 删除其他上游 | `t("dash.confirmDeleteUpstream", { name: u.name })` | `t("dash.confirmDeleteUpstreamUsage")` | `t("dash.delete")` |
| 删除邀请码 | `t("dash.confirmDeleteInvite")` | — | `t("dash.delete")` |
| 删除用户 | `t("dash.confirmDeleteUser", { name: u.name })` | `t("dash.confirmDeleteUserHint")` | `t("dash.delete")` |
| 删除代理节点 | `t("dash.proxyDeleteConfirm", { name: p.name })` | — | `t("dash.delete")` |
| 撤销 Host 访问 | `t("dash.remote.revokeConfirm", { label: share.label })` | `t("dash.remote.revokeConfirmHint")` | `t("dash.remote.revoke")` |
| 覆盖模式导入 | `t("dash.importReplaceConfirmTitle")` | `t("dash.importReplaceConfirm")` | `t("dash.importReplaceAction")` |

写法统一为 `if (!(await confirm({ … }))) return …`；`ShareRow` 的按钮改成 `onClick={async () => { if (await confirm({ … })) void onRevoke(share.label) }}`。

toast：

| 位置 | 新写法 |
|---|---|
| 探测成功 | `toast(t("dash.probeModelsToast", { name, n: r.modelCount ?? 0 }), "success")` |
| 探测失败 | `toast(t("dash.probeFailedToast", { name, error: `${r.error ?? t("dash.probeFailed")}${r.hint ? ` — ${r.hint}` : ""}` }), "error")` |
| 探测抛错 | `toast(t("dash.probeFailedToast", { name, error: msg }), "error")` |
| 删除上游、用户、密钥 | `toast(t("dash.deletedToast", { name: … }), "success")` |
| 退出登录 | `toast(t("dash.signedOutToast", { name: u.name }), "success")` |
| 复制网页搜索配置 | `toast(t("dash.wsConfigCopiedToast"), "success")` |
| 分享 | `toast(t("dash.sharedWithToast", { email }), "success")` |
| 取消分享 | `toast(t("dash.unshareToast"), "success")` |

`remote-text.ts`：
- `dash.remote.title` 和 `dash.remote.revokeConfirm` 同步成新的英文；
- 新增 `"dash.remote.revokeConfirmHint": "Their used session count is kept if you grant access again."`。

- [ ] **Step 2: 字典。** 按"已批准措辞"表加新 key、改旧值。跑 `bun test packages/gateway/tests/i18n-keys.test.ts`。
- [ ] **Step 3: 运行 `confirm.test.tsx`（扫描用例应通过）、`AgentRemoteTab.test.tsx`，再跑 typecheck**

### Task 7: Agent Remote 名字

**Files:**
- Modify: `apps/dashboard/src/components/AgentRemoteEntry.tsx`、i18n `dash.remote.title`
- Test: `apps/dashboard/src/components/AgentRemoteEntry.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
test("the entry carries the page's name in either language", () => {
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      expect(renderToStaticMarkup(<AgentRemoteLink enabled authenticated />)).toContain(">Agent Remote</span>")
      expect(renderToStaticMarkup(<AgentRemoteLink enabled authenticated iconOnly />)).toContain('aria-label="Agent Remote"')
    } finally {
      restore()
    }
  }
})
```

（改字典之前，这条测试在 zh 下能通过，因为侧栏文字是写死的；要先改字典，再确认测试仍然通过。真正的失败证据是：改字典后、改组件前，页面标题和侧栏一致。这一点在走查里验证。）

- [ ] **Step 2: 实现。** `AgentRemoteLink` 在早退之前调用 `const t = useRemoteText()`，然后 `const name = t("dash.remote.title")`，三处写死的 "Agent Remote" 都换成 `name`。
- [ ] **Step 3: 运行通过**

### Task 8: 面包屑去重

**Files:**
- Modify: `apps/dashboard/src/shell/PageCrumb.tsx`
- Test: `apps/dashboard/src/shell/PageCrumb.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PageCrumb } from "./PageCrumb"

test("a page named like its group shows once", () => {
  const html = renderToStaticMarkup(<PageCrumb group="Models" page="Models" fallback="" />)
  expect(html.match(/Models/g)?.length).toBe(1)
  expect(html).not.toContain(">/</li>")
})

test("other pages keep their group", () => {
  const html = renderToStaticMarkup(<PageCrumb group="Observe" page="Usage" fallback="" />)
  expect(html).toContain("<li>Observe</li>")
  expect(html).toContain(">Usage</li>")
})
```

- [ ] **Step 2: 运行，确认第一条失败**
- [ ] **Step 3: 实现：** `const shownGroup = group !== null && group !== page ? group : null`，渲染时用 `shownGroup`。在 `const` 上方加注释："Models / Models" says the same thing twice: a page named like its group stands alone.
- [ ] **Step 4: 运行通过**

### Task 9: 用量页

**Files:**
- Modify:
  - `tabs/usage/UsageTab.tsx`（Cache 线、单位、翻页按钮、图表切换的 aria）
  - `tabs/usage/UsageDistributionTable.tsx`（三行标签）
  - `tabs/usage/RollingStrip.tsx`（tokens、读屏句）
  - i18n
- Test: 靠 `i18n-keys`、typecheck 和走查

- [ ] **Step 1: 实现**
  - Cache 线：`label: t("dash.chartCache")`，`useMemo` 依赖补 `t`。
  - 单位：`const unitLabel = usage.metric === "requests" ? ` ${t("dash.unitRequests")}` : ` ${t("dash.unitTokens")}``。
  - 翻页按钮：`periodNoun` 换成 `periodNav`。按 range 取 `{ prev, next }`：today 用 `dash.previousDay`/`dash.nextDay`，week 用 `dash.previousWeek`/`dash.nextWeek`，month 用 `dash.previousMonth`/`dash.nextMonth`。四处 title 和 aria-label 改用 `periodNav.prev` 和 `periodNav.next`。
  - 图表上方的切换：`ariaLabel={t("dash.chartModelDimension")}`。表格那个切换保留 `dash.modelDistributionToggle`。
  - 分布条：`label={t("dash.requests")}`、`t("dash.input")`、`t("dash.output")`。
  - 滚动总量：
    - 读屏句：`t("dash.rollingCellAria", { label: c.label, total: money(c.costUSD), day: money(c.dayCostUSD), tokens: c.tokens.toLocaleString() })`；
    - 可见数字：`t("dash.tokensCount", { n: … })`。
- [ ] **Step 2: i18n-keys 测试、typecheck、`tabs/usage` 下的测试都通过**

### Task 10: 模型页

**Files:**
- Modify: `tabs/models/chat/ChatThread.tsx`（搜索状态）、`tabs/models/ModelsTab.tsx:230,422`、`App.tsx:31`（`Loading…`）、i18n
- Test: `tabs/models/__snapshots__/render-snapshot.test.tsx.snap`（"ModelList loading" 快照里的 `Loading…` 变成 `dash.loadingShort`，用 `-u` 更新，然后检查 diff 只有这一处）

- [ ] **Step 1: 实现**
  - 搜索状态改成三个 `t("dash.playground.webSearch…")`，分别是 Done、Running、Pending。
  - 三处 `Loading…` 改成 `{t("dash.loadingShort")}`。
- [ ] **Step 2: 更新快照，核对 diff**

### Task 11: 其余写死的英文和读屏名称

**Files:**
- Modify:
  - `tabs/upstreams/UpstreamsTab.tsx:205`（`title={t("dash.refreshLabel")}`）
  - `tabs/upstreams/UpstreamFormModal.tsx:270`（`|| t("dash.unknown")`）
  - `tabs/upstreams/DeviceFlowModal.tsx:300`（`copyLabel={t("dash.copy")}`）
  - `App.tsx`（`TabBody` 加 `const t = useT()`，`title={t("dash.unknownPage")}`）
  - `tabs/usage/participants.ts:103`（`label: t("dash.adminLabel")`）
  - `components/UserMenu.tsx:50`（`t("dash.adminLabel")`）
  - `tabs/keys/WebSearchEngineRow.tsx:47`、`tabs/keys/WebSearchPanel.tsx:460`：借用失效的提示前面加 `<Link2Off aria-hidden="true" />`，尺寸与旁边的 `Link2` 一致
  - `tabs/keys/WebSearchPanel.tsx:313-333`：两个转发选择框各配一个 `sr-only` 的 span（id 分别是 `${panelId}-passthrough-upstream` 和 `${panelId}-passthrough-model`，内容是两个 aria key），`labelledBy` 指向它们
  - i18n：`dash.unknownPage`、`dash.wsLinkUnavailable`、passthrough aria
- Test: `tabs/usage/participants.test.ts:207,212`（用 `installDictionary("en")` 包住，断言保持 `"Admin"`；另加一条 zh 断言 `"管理员"`）

- [ ] **Step 1: 改测试，确认 zh 断言失败**
- [ ] **Step 2: 实现**
- [ ] **Step 3: 运行通过；i18n-keys 测试和 typecheck 通过**

### Task 12: 代码评审

- [ ] 派 `superpowers:code-reviewer`，范围是 `git diff 498a5546`，要求对照本计划和"已批准措辞"表逐条核对。修掉 Critical 和 Important 级别的问题。

### Task 13: 浏览器走查（中英文各一遍）

- [ ] 用本地服务和管理员账号，在 Chrome（MCP，开新标签页，不碰生产标签页）或 headless 里依次检查：
  - **确认框：**
    - 删除密钥会弹出对话框，焦点落在"取消"上，Esc 和点遮罩都算取消；
    - 删除上游、删除邀请码、导入覆盖模式的对话框文字正确；
    - 在编辑上游的对话框里点删除，会叠出第二层对话框，取消后回到第一层。
  - **toast：** 探测模型的中文 toast 正确；名字里带 `$&` 的密钥删除后，toast 原样显示。
  - **用量页：**
    - 日、周、月三种标签和翻页按钮的提示都是中文；
    - 周视图横轴显示"周一 …"；
    - 滚动总量格子的读屏句是中文；
    - 图表悬停提示的单位是"次请求"；
    - 分布条三行是中文。
  - **相对时间：** 密钥页、用户页、客户端页都显示中文。
  - **其他页面：**
    - 侧栏、页面标题和面包屑都是 Agent Remote；
    - 模型页面包屑只有一级；
    - 网页搜索两个转发选择框的读屏名称不同；
    - 借用失效的提示前有图标、没有 ↗。
  - **Lighthouse 无障碍：** Keys、Usage、Upstreams、Settings 四页仍为 100。

### Task 14: 完整门禁

- [ ] 跑一遍 `bun run ci:local`。它会停在 `bun test`，因为有基线失败，所以接着单独补跑 `bun run lint`、`bun run build:ui`、`bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry`。
- [ ] 失败名单和 `/tmp/cag-i18n/baseline-fails.txt` 按名字对比，只允许出现基线里的名字。偶发的 `process-resources` 除外，需要单独重跑确认。

---

## 执行记录

- **Task 1：** 先失败：名字 `a$&b$'c$$d` 被渲染成 `a{name}b"?c$d`，重复的 `{x}` 只替换了第一个。改成 split/join 后通过。没有快照锁住脚本原文。
- **Task 2：** 照计划实现。
- **Task 3：**
  - `usage.ts` 的 hook 里已有 `const t = useT()`，所以模块级的导入写成 `t as tStatic`；
  - 中英文周视图横轴各加了一条用例；
  - 英文断言在 `beforeEach` 里装 en 词典，原断言一字未改。
- **Task 4：** 三处旧实现删除，`ClientsTab` 不再需要 `tStatic`；`api/users.ts` 末尾多出的空行已去掉。
- **Task 5：** 扫描用例第一次把 `ui/confirm-dialog.tsx` 的注释（"In place of window.confirm()"）当成了原生调用，改了注释措辞。
- **Task 6：**
  - 按表接入；
  - `ShareRow` 的撤销逻辑从 JSX 里挪成组件内的 `revoke()`；
  - 三个原本未被引用的 `dash.confirmDelete*` key 改值复用。
- **Task 7：**
  - 加了一条测试：用桩 `window.t` 证明侧栏名字来自 `dash.remote.title`。临时换回旧组件确认它会失败，再恢复；
  - icon-only 那条断言需要外层的 `TooltipProvider`。
- **Task 8：** 多加一条"不属于任何分组的页面"用例。
- **Task 9：** 照计划实现；图表图例的选择按标签存在内存里，切换语言会刷新页面，不受影响。
- **Task 10：**
  - 快照 diff 共 10 行：9 处 ChatPanel 种子线程里的搜索状态，1 处 ModelList 的加载文字；
  - 测试环境没有 `window.t`，所以快照里记录的是 key 本身。
- **Task 11：** 两个读屏 span 放进各自选择框的外层 div，不放在提示和选择框之间。
- **检查：**
  - dashboard 测试 754 个、i18n 两个测试文件全部通过；
  - typecheck 通过；
  - 对改动文件跑 eslint，干净；
  - 全仓扫描：除注释和 `dateLocale()` 本身外，交接 4.1 清单里的英文已全部处理，也没有剩下 `"en-US"`。
  - 评审另外发现两处英文，不在 4.1 清单里，这次没动，措辞要另找用户确认：
    - `tabs/models/chat/ChatEmpty.tsx` 的三个示例问题；
    - `tabs/upstreams/model-text.ts` 的两条报错。
- **Task 12（评审）：** 没有 Critical。处理如下：
  - **Important 1：** 双击触发按钮时，第二下可能落在新弹出的对话框上。现在对话框打开后 400 ms 内，忽略"确认"和点击外部，见 `SETTLE_MS` 和 `ignoreEarlyYes`。测试先在去掉保护时失败，再验证通过。
  - **Important 2：** 新增的中文行被 Bun 转译 `String.raw` 时写成了 `\uXXXX`，已还原为原字。文件里原有的 6 处转义保持不变。
  - **Minor 3：** `i18n-keys` 测试同时识别 `tStatic(`。
  - **Minor 5：** 两个读屏标签改用 `hidden`。
  - **Minor 6：** 确认框改用 `role="alertdialog"`。`ui/dialog` 新增 `role` 和 `onInteractOutside` 两个可选属性。
  - **Minor 7：** 插值改为一次替换：名字里的 `{error}` 不会被再次填充，没有值的占位符原样保留。补了 2 条测试。
  - **Minor 4、8：** 见上面两条记录。
- **Task 13（走查）：** 在 Chrome MCP 的隔离上下文里进行，不影响用户自己的登录状态。会话 token 只放在被 git 忽略的文件里，通过 `sourcePath` 执行。
  - **中文：**
    - 7 种确认框的文字、按钮、红色样式都正确；焦点落在"取消"，Esc 和点遮罩都算取消，焦点能回到触发按钮。
    - toast 正确，包括名字带 `$&` 的密钥。
    - 日、周、月标签和翻页按钮正确，滚动总量的读屏句、图表悬停提示（"次请求"、"缓存"）、分布条三行都是中文。
    - 密钥页和用户页的相对时间是中文。
    - 面包屑只显示一级"模型"；Agent Remote 页的标题和面包屑一致。
    - 两个图表切换、两个转发选择框的读屏名称各不相同。
  - **英文：** 抽查无变化（"21m ago"、"Today (Nov 13)"、"Previous day"）。
  - **Lighthouse 无障碍：** Keys、Usage、Upstreams 三页都是 100。用户说不用再查，Settings 页没有测。
  - **评审修复后复查：** `alertdialog` 角色、400 ms 内点遮罩和点"删除"都无效、稳定后点遮罩会关闭、稳定后点"删除"能删除，全部符合预期。
  - **原计划里的"在编辑上游的对话框里点删除"无法执行：** 上游编辑表单是行内展开的，没有哪个确认是从对话框里触发的。
- **Task 14（门禁）：**
  - 全量 `bun test` 共 7128 个用例，21 个失败，10 个错误，失败全部在基线名单内。偶发的 process-resources 这次通过。
  - 第一次跑 `ci:local` 时，`bun test` 被系统以 SIGKILL 杀掉（exit 137，机器内存紧张），单独重跑后正常。
  - lint 0 error / 38 warning（与基线一致），`build:ui` 和 deploy:dry 通过。
