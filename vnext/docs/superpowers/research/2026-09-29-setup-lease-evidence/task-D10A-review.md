### Spec Compliance

- ❌ Issues found：冻结 revision 2 的核心 D10A 功能符合约定，但 required CI 未通过；新增 migration 缺少 schema baseline 同步（Important I1）。trusted-origin 比较另有非阻断契约偏差（Minor M1）。
- ✅ 审查范围：完整阅读 `task-D10A-review.patch` 的全部 16 个路径（含新增文件）；SHA-256 逐一匹配 `task-D10A-frozen-sha256.json`。基线按交接记录为 `4e7b07e18374edbd76e98f78c184490119ac1fd9`，未重跑 Git 命令。
- ⚠️ 无法仅从 diff 证明：D10B 本地 artifact 验证、文件事务、helper 与 UI 未在本任务实现；不得据此宣称 one-command setup 完成。生产 ingress/Cloudflare D1 行为与真实反向代理 origin 配置也不由本地 SQLite/workerd 证据证明（`task-D10A-report.md:65-68`）。
- ⚠️ 无法仅从 diff 证明：全局 provider identity/cancellation/retention/unknown-zero 在其他路径上的总体回归状态；本 patch 未修改这些实现，也未触碰 collaboration-shim、PRODUCT.md 或用户数据。由 root 的全量 gates 继续覆盖。

### Strengths

- ✅ `vnext/packages/gateway/src/control-plane/setup/artifact.ts:8-36,81-102,104-148`：严格有界 schema、显式 nullable effort、opaque model、固定管理字段、canonical digest 与独立红线投影完整；没有引入保存偏好或任意 shell/path/header 字段。
- ✅ `vnext/packages/gateway/src/control-plane/setup/routes.ts:99-148,172-203`：真实 ses_ session、enabled user、当前 owner/admin、Owner enable 状态独立查库；mint 在插入前后重新派生 revision/digest，失败撤销；UUID 和 256-bit bearer 独立生成。
- ✅ `vnext/packages/gateway/src/repo/shared/setup-leases.ts:37-60`：单个 UPDATE 同时约束 lease 状态、时间、元数据、全局 revision、当前 raw key、null-safe owner、enabled minter/owner 和当前 admin 邮箱，仅 changes === 1 返回 artifact；没有依赖跨 D1 请求事务。
- ✅ `vnext/packages/gateway/src/control-plane/setup/routes.ts:227-263`、`vnext/packages/gateway/src/app.ts:31,79-85`、`vnext/packages/gateway/src/control-plane/auth/session-auth.ts:54-58`：专用 header/exchange 路径、一次消费、不重放、固定错误、日志路径脱敏与非 exchange 凭据拒绝相互衔接。
- ✅ `vnext/apps/platform-cloudflare/src/setup-leases.d1.test.ts:28-76,90-127`、`vnext/packages/gateway/tests/repo/setup-leases.test.ts:23-56,72-95`、`vnext/packages/gateway/tests/control-plane-setup.test.ts:164-183`：实际迁移/SQLite/D1 与消费前真实数据库变更验证，而非 fake executor；现有 transcript 确认为 77 pass、0 fail、317 assertions（`task-D10A-focused-tests.log:217-220`），本 reviewer 未重复运行。

### Issues

#### Critical (Must Fix)

- 无。

#### Important (Should Fix)

- **I1 — 新 schema 未同步迁移 baseline，required CI 失败。** `vnext/packages/gateway/migrations/0021_setup_leases.sql:1-19` 添加一表两索引，但冻结 patch 未包含 migration schema baseline 更新；`vnext/packages/gateway/tests/migrations.test.ts:121` 的 corpus replay 比较因此失败。已直接检查 root 提供的 `/tmp/vnext-d10a-ci.log:1852-1897`：差异恰为 `setup_leases`、`setup_leases_expiry`、`setup_leases_key` 三项。需要按现有 baseline 更新流程补齐这三项、确认没有其他 schema 漂移，并由 root 完成相应测试与 required CI gate。不能以 writer 的 focused pass 代替此验收。

#### Minor (Nice to Have)

- **M1 — 合法同源的等价 URL 表示被拒绝。** `vnext/packages/gateway/src/control-plane/setup/routes.ts:48-53` 将 `publicOrigin()` 的原始字符串直接与规范化的 `URL.origin` 比较，而契约要求解析后比较 origin。`vnext/packages/gateway/src/control-plane/auth/utils.ts:17-26` 确认该 helper 原样拼接 host/proto；例如 HTTPS 请求的 Host/forwarded-host 带显式 `:443`，或合法域名大小写变体，与请求 URL 同源却返回 400。建议解析 candidate，拒绝非 HTTP(S)/userinfo/额外 URL 成分，再比较规范化 origin；补这两个等价表示及异源拒绝的 focused 测试。
- **M2 — 验证输出仍有噪声。** `task-D10A-focused-tests.log:16-19,22-26` 包含测试请求日志；`task-D10A-report.md:59` 另记录 ESLint multiple-tsconfig 性能提示。不是秘密泄漏或失败，但按 reviewer 的 pristine-output 要求属于小项；普通成功用例可在 fixture 中捕获日志，专门的 no-secret logging 用例继续断言输出。ESLint 提示是已报告的既有环境项，未独立重跑确认。

### Focused unchanged-source checks

- ✅ 命名风险「派生 authority 误用缓存」：只检查 `vnext/packages/gateway/src/repo/index.ts:18-23,46-58`；setup 所用 getRepo 返回 authoritative repo，缓存入口是另一个 getDataPlaneRepo。
- ✅ 命名风险「revision 未覆盖撤权变化」：只检查 `vnext/packages/gateway/migrations/0010_configuration_revision.sql:4-26,54-65`；key/user/session 相关变化有 revision trigger。新增 migration 没有 lease revision trigger。
- ✅ 命名风险「installed ingress 被运行平台推断」：只检查 `vnext/packages/gateway/src/shared/ingress-capability.ts:7-17`；来源是请求作用域 AsyncLocalStorage，未知返回 null。
- ✅ 命名风险「admin allowlist 大小写错配」：只检查 `vnext/packages/gateway/src/shared/config/constants.ts:5`；当前 allowlist 为小写，路由和 SQL 对用户邮箱做 lower-case。
- ✅ 命名风险「通用 credential parser 与 lease 拒绝顺序」：patch 的 extractKey 上半函数上下文被截断，因此只补读 `vnext/packages/gateway/src/control-plane/auth/session-auth.ts:28-49`，确认 query/header/cookie 的入口顺序；其余已变更文件没有再次读取。
- ✅ 命名风险「新增 migration 破坏 checked-in schema gate」：收到 root 的具体失败后，只查看已有 `vnext/packages/gateway/tests/migrations.test.ts:103-121` 和指定 CI 日志；确认 I1，不运行测试。
- ✅ 未运行 runtime、测试、全量 suite、Git 或产品修改；唯一输出为本审查报告。Root 随后提供四组 frozen runtime PASS 信息，本 reviewer 未重新执行，也不把该消息当独立测量。

### Assessment

- **Task quality: Needs fixes.** I1 是已观察到的 required CI 失败，应先修复并刷新冻结证据；核心 server credential/atomic-consume 实现未发现其他 Critical 或 Important 问题。M1、M2 不阻断凭据边界，但应在 root 统一修复时明确处理或记录。
